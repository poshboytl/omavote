// A mocked Omavote server (fetch-level) for flow tests: it serves the read API with
// the same JSON shapes as crates/omavote/src/api.rs, checks submitted envelopes the
// way the relay does (exact fields, signature verified by the core), signs receipts,
// and walks relay items through RECEIVED → BROADCAST → INCLUDED → CONFIRMED.

import type { FetchLike } from "../../src/lib/api";
import type { Core } from "../../src/lib/core";
import { bytesToHex } from "../../src/lib/hex";
import type {
  At,
  AuthRegistry,
  BallotBody,
  BallotView,
  ControlBody,
  Diagnostic,
  GrantView,
  KeyDescriptor,
  Manifest,
  NetworkInfo,
  NetworkParams,
  ProcessRecordBody,
  ProcessRoles,
  RecordView,
  RelayItem,
  Script,
  StatusView,
  StreamView,
} from "../../src/lib/types";
import { ckbHash, compressedPubkey, receiptSign, testSecret } from "./keys";

const enc = new TextEncoder();

export const BALLOT_FIELDS = [
  "action",
  "anchor_block_hash",
  "auth_adapter",
  "authority",
  "authorization_id",
  "dao_namespace",
  "message_kind",
  "network_genesis_hash",
  "nonce",
  "owner_lock",
  "poll_id",
  "protocol_version",
  "rules_hash",
  "signature_format",
  "signer_key_id",
];

export const CONTROL_FIELDS = [
  "action",
  "anchor_block_hash",
  "auth_policy_hash",
  "dao_namespace",
  "expires_at_ms",
  "key_descriptor",
  "message_kind",
  "network_genesis_hash",
  "nonce",
  "owner_auth_adapter",
  "owner_lock",
  "protocol_version",
  "publication_deadline_ms",
  "revoke_mode",
  "signature_format",
];

export const RECORD_FIELDS = [
  "anchor_block_hash",
  "dao_namespace",
  "detail",
  "evidence_hash",
  "message_kind",
  "network_genesis_hash",
  "nonce",
  "poll_id",
  "protocol_version",
  "publication_deadline_ms",
  "record_type",
  "role",
  "roles_hash",
];

export function sortedKeys(o: unknown): string[] {
  return Object.keys(o as object).sort();
}

interface Block {
  number: bigint;
  hash: string;
  clock: bigint;
}

interface PollEntry {
  manifest: Manifest;
  pollId: string;
  registeredHeight: bigint;
  ballots: BallotView[];
  rejected: Diagnostic[];
  records: RecordView[];
}

interface RelayEntry {
  kind: string;
  objectId: string;
  envelope: Record<string, unknown>;
  item: RelayItem;
  steps: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail: string,
  ) {
    super(detail);
  }
}

export class MockServer {
  readonly core: Core;
  readonly network: NetworkParams;
  readonly receiptSecret = testSecret("receipt-key");
  readonly receiptKey: string;
  readonly chain: Block[] = [];
  readonly polls = new Map<string, PollEntry>();
  readonly power = new Map<string, { lock: Script; total: string }>();
  readonly streams = new Map<string, StreamView>();
  readonly grants: GrantView[] = [];
  readonly relay = new Map<string, RelayEntry>();
  readonly posts: { text: string; json: unknown }[] = [];
  readonly gets: string[] = [];
  roles: { roles_hash: string; object: ProcessRoles } | null = null;
  synced = true;
  lagBlocks = "0";
  /** Mine a new block every N GET /api/anchor calls (0 = never). */
  mineOnAnchorEvery = 0;
  private anchorCalls = 0;
  readonly policy: { policy: NetworkInfo["authorization_policy"]["object"]; hash: string };
  readonly registry: AuthRegistry;

  constructor(core: Core, network: NetworkParams) {
    this.core = core;
    this.network = network;
    this.receiptKey = compressedPubkey(this.receiptSecret);
    this.policy = core.authPolicy(network.genesis_hash);
    this.registry = { owner_adapters: ["ckb-secp256k1-message-v1", "evm-personal-message-v1"], key_adapters: ["ckb-secp256k1-message-v1", "evm-personal-message-v1"] };
    this.mine(10);
  }

  // ---------------------------------------------------------------- chain state

  tip(): Block {
    const b = this.chain[this.chain.length - 1];
    if (!b) throw new Error("empty chain");
    return b;
  }

  mine(n = 1): Block {
    for (let i = 0; i < n; i++) {
      const number = BigInt(this.chain.length);
      const hash = bytesToHex(ckbHash(enc.encode(`block-${number}`)));
      const clock = 1_800_000_000_000n + number * 10_000n;
      this.chain.push({ number, hash, clock });
    }
    return this.tip();
  }

  blockOf(hash: string): Block | null {
    return this.chain.find((b) => b.hash === hash) ?? null;
  }

  at(): At {
    const t = this.tip();
    return { number: t.number.toString(), hash: t.hash, clock_ms: t.clock.toString() };
  }

  addPoll(manifest: Manifest): string {
    const pollId = this.core.manifestInfo(manifest).poll_id;
    this.polls.set(pollId, { manifest, pollId, registeredHeight: this.tip().number, ballots: [], rejected: [], records: [] });
    this.mine(2);
    return pollId;
  }

  setPower(lock: Script, totalShannon: string): void {
    this.power.set(this.core.scriptHash(lock), { lock, total: totalShannon });
  }

  addGrant(ownerLock: Script, key: KeyDescriptor, expiresAtMs: string): GrantView {
    const ownerId = this.core.scriptHash(ownerLock);
    const keyId = this.core.key(key).key_id;
    const g: GrantView = {
      authorization_id: bytesToHex(ckbHash(enc.encode(`grant-${ownerId}-${keyId}`))),
      policy_hash: this.policy.hash,
      owner_id: ownerId,
      owner_adapter: "ckb-secp256k1-message-v1",
      key_descriptor: key,
      key_id: keyId,
      expires_at_ms: expiresAtMs,
      position: { height: this.tip().number.toString(), tx_index: "1", output_index: "0", envelope_index: "0" },
      anchor_height: (this.tip().number - 1n).toString(),
      cancels_open: false,
      state: "CURRENT",
    };
    this.grants.push(g);
    this.streams.set(ownerId, {
      policy_hash: this.policy.hash,
      owner_id: ownerId,
      owner_lock: ownerLock,
      max_anchor_height: g.anchor_height,
      conflict: false,
      current: g,
      barriers: [],
      history: [],
    });
    return g;
  }

  networkInfo(): NetworkInfo {
    return {
      at: this.at(),
      network: this.network,
      authorization_policy: {
        object: this.policy.policy,
        hash: this.policy.hash,
        published: { height: "1", tx_index: "1", output_index: "0", envelope_index: "0" },
      },
      default_registry: { object: this.registry, hash: this.core.registry(this.registry).hash },
      default_rules: (() => {
        const r = this.core.defaultRules();
        return { object: r.rules_profile, hash: r.rules_hash };
      })(),
      initial_roles_hash: this.roles?.roles_hash ?? null,
      current_roles: this.roles,
      process_publication_delay_ms: "259200000",
      max_control_publication_delay_ms: "86400000",
      receipt_key: this.receiptKey,
    };
  }

  status(): StatusView {
    return {
      version: "0.1.0-mock",
      network: { name: this.network.name, genesis_hash: this.network.genesis_hash },
      indexed: this.at(),
      node_tip: (this.tip().number + BigInt(this.lagBlocks)).toString(),
      synced: this.synced,
      last_sync_ms: String(Date.now()),
      last_error: null,
      reorgs: { count: "0", last: null },
      polls: String(this.polls.size),
      diagnostics: "0",
      lag_blocks: this.lagBlocks,
      relay: { intake: true, receipt_key: this.receiptKey, queue: {} },
    };
  }

  // ---------------------------------------------------------------- intake

  private verifyBallot(body: BallotBody, signature: string): void {
    const poll = this.polls.get(body.poll_id);
    if (!poll) throw new HttpError(422, "UNKNOWN_POLL", "poll is not registered on chain");
    const anchor = this.blockOf(body.anchor_block_hash);
    if (!anchor) throw new HttpError(422, "ANCHOR_INVALID", "anchor is not a known canonical block");
    const text = this.core.ballot(this.network, poll.manifest, body).text;
    const ok =
      body.authority === "owner"
        ? this.core.verifyOwner(this.network, body.auth_adapter, body.owner_lock, text, signature).ok
        : (() => {
            const g = this.grants.find((x) => x.authorization_id === body.authorization_id);
            if (!g || g.key_id !== body.signer_key_id) throw new HttpError(422, "NO_ACTIVE_GRANT", "authorization_id is not a known grant");
            return this.core.verifyKey(g.key_descriptor, text, signature).ok;
          })();
    if (!ok) throw new HttpError(422, "INVALID_SIGNATURE", "signature does not belong to the owner lock");
  }

  private intake(text: string): RelayItem {
    const json = JSON.parse(text) as Record<string, unknown>;
    const jcs = this.core.jcs(json);
    if (jcs !== text) throw new HttpError(400, "NOT_JCS", "test server expects the client to send JCS");
    let kind: string;
    let objectId: string;
    if ("manifest" in json) {
      if (sortedKeys(json).join() !== "manifest,proposer_proofs,protocol_version") throw new HttpError(422, "INVALID_FORMAT", "manifest payload fields");
      const m = json.manifest as Manifest;
      const proofs = json.proposer_proofs as { owner_lock: Script; auth_adapter: string; proof: { signature: string } }[];
      if (proofs.length !== m.proposer_owner_locks.length) throw new HttpError(422, "INVALID_SIGNATURE", "one proposer proof per proposer lock is required");
      m.proposer_owner_locks.forEach((lock, i) => {
        const p = proofs[i];
        if (!p || JSON.stringify(p.owner_lock) !== JSON.stringify(lock)) throw new HttpError(422, "INVALID_SIGNATURE", "proposer proofs must follow proposer_owner_locks order");
        const t = this.core.proposalText(this.network, m, lock);
        if (!this.core.verifyOwner(this.network, p.auth_adapter, lock, t, p.proof.signature).ok) throw new HttpError(422, "INVALID_SIGNATURE", "bad proposer signature");
      });
      kind = "manifest";
      objectId = this.core.manifestInfo(m).poll_id;
    } else if ("proofs" in json) {
      if (sortedKeys(json).join() !== "body,proofs") throw new HttpError(422, "INVALID_FORMAT", "process envelope fields");
      const body = json.body as ProcessRecordBody;
      if (sortedKeys(body).join() !== RECORD_FIELDS.join()) throw new HttpError(422, "INVALID_FORMAT", "record fields");
      const out = this.core.record(body);
      const roles = this.roles;
      if (!roles || roles.roles_hash !== body.roles_hash) throw new HttpError(422, "ROLES_MISMATCH", "roles");
      const members = roles.object.roles[body.role].members;
      const valid = new Set<string>();
      for (const p of json.proofs as { signer_key_id: string; proof: { signature: string } }[]) {
        const m = members.find((d) => this.core.key(d).key_id === p.signer_key_id);
        if (m && this.core.verifyKey(m, out.text, p.proof.signature).ok) valid.add(p.signer_key_id);
      }
      if (valid.size < Number(roles.object.roles[body.role].threshold)) throw new HttpError(422, "INVALID_SIGNATURE", `${valid.size} valid member signatures`);
      kind = "process_record";
      objectId = out.record_id;
    } else {
      if (sortedKeys(json).join() !== "body,proof") throw new HttpError(422, "INVALID_FORMAT", "envelope fields");
      const proof = json.proof as { signature: string };
      if (sortedKeys(proof).join() !== "signature") throw new HttpError(422, "INVALID_FORMAT", "proof fields");
      const body = json.body as { message_kind: string };
      if (body.message_kind === "ballot") {
        if (sortedKeys(body).join() !== BALLOT_FIELDS.join()) throw new HttpError(422, "INVALID_FORMAT", "ballot fields");
        this.verifyBallot(body as BallotBody, proof.signature);
        kind = "ballot";
        objectId = this.core.ballot(this.network, this.polls.get((body as BallotBody).poll_id)!.manifest, body as BallotBody).ballot_id;
      } else if (body.message_kind === "authorization_control") {
        const c = body as ControlBody;
        if (sortedKeys(c).join() !== CONTROL_FIELDS.join()) throw new HttpError(422, "INVALID_FORMAT", "control fields");
        const out = this.core.control(this.network, c);
        if (!this.core.verifyOwner(this.network, c.owner_auth_adapter, c.owner_lock, out.text, proof.signature).ok) throw new HttpError(422, "INVALID_SIGNATURE", "bad owner signature");
        kind = "authorization_control";
        objectId = out.authorization_id;
      } else {
        throw new HttpError(422, "INVALID_FORMAT", "unknown envelope message_kind");
      }
    }
    const existing = this.relay.get(objectId);
    if (existing) return { ...existing.item, duplicate: true };
    const receiptBody = {
      message_kind: "relay_receipt",
      protocol_version: "2",
      network_genesis_hash: this.network.genesis_hash,
      relay_receipt_key: this.receiptKey,
      item_kind: kind,
      object_id: objectId,
      envelope_hash: bytesToHex(ckbHash(enc.encode(jcs))),
      received_at_ms: String(Date.now()),
      publish_by_ms: null,
    };
    const body = (json.body ?? {}) as { poll_id?: string; owner_lock?: Script; auth_policy_hash?: string };
    const item: RelayItem = {
      status: "RECEIVED",
      duplicate: false,
      message_kind: kind,
      object_id: objectId,
      scope_id: kind === "ballot" ? body.poll_id ?? null : kind === "authorization_control" ? body.auth_policy_hash ?? null : kind === "manifest" ? objectId : (body.poll_id ?? null),
      owner_id: body.owner_lock && (kind === "ballot" || kind === "authorization_control") ? this.core.scriptHash(body.owner_lock) : null,
      tx_hash: null,
      block_number: null,
      block_hash: null,
      error: null,
      receipt: { body: receiptBody as never, signature: receiptSign(this.core.jcs(receiptBody), this.receiptSecret) },
    };
    this.relay.set(objectId, { kind, objectId, envelope: json, item, steps: 0 });
    return item;
  }

  /** Advance one relay step; at INCLUDED the object is indexed. */
  private advance(e: RelayEntry): void {
    const order = ["RECEIVED", "BROADCAST", "INCLUDED", "CONFIRMED"];
    const i = order.indexOf(e.item.status);
    if (i < 0 || i >= order.length - 1) return;
    const next = order[i + 1] ?? "CONFIRMED";
    if (next === "INCLUDED") {
      const b = this.mine(1);
      e.item = { ...e.item, status: next, tx_hash: bytesToHex(ckbHash(enc.encode(`tx-${e.objectId}`))), block_number: b.number.toString(), block_hash: b.hash };
      this.index(e, b);
    } else {
      e.item = { ...e.item, status: next };
    }
  }

  private index(e: RelayEntry, block: Block): void {
    if (e.kind === "ballot") {
      const body = (e.envelope.body ?? {}) as BallotBody;
      const poll = this.polls.get(body.poll_id);
      const anchor = this.blockOf(body.anchor_block_hash);
      if (!poll || !anchor) return;
      const ownerId = this.core.scriptHash(body.owner_lock);
      for (const b of poll.ballots) if (b.owner_id === ownerId && b.status === "SELECTED") b.status = "SUPERSEDED";
      poll.ballots.push({
        ballot_id: e.objectId,
        owner_id: ownerId,
        authority: body.authority,
        authorization_id: body.authorization_id,
        action: body.action,
        anchor_height: anchor.number.toString(),
        grant_anchor_height: "0",
        position: { height: block.number.toString(), tx_index: "1", output_index: "0", envelope_index: "0" },
        tx_hash: e.item.tx_hash ?? "",
        status: "SELECTED",
        envelope: e.envelope as never,
      });
    } else if (e.kind === "authorization_control") {
      const c = (e.envelope.body ?? {}) as ControlBody;
      const ownerId = this.core.scriptHash(c.owner_lock);
      const anchor = this.blockOf(c.anchor_block_hash);
      const s: StreamView = this.streams.get(ownerId) ?? { policy_hash: c.auth_policy_hash, owner_id: ownerId, owner_lock: c.owner_lock, max_anchor_height: null, conflict: false, current: null, barriers: [], history: [] };
      s.history.push({
        authorization_id: e.objectId,
        action: c.action,
        anchor_height: anchor?.number.toString() ?? "0",
        position: { height: block.number.toString(), tx_index: "1", output_index: "0", envelope_index: "0" },
        tx_hash: e.item.tx_hash ?? "",
        outcome: "EFFECTIVE",
        envelope: e.envelope as never,
      });
      s.max_anchor_height = anchor?.number.toString() ?? s.max_anchor_height ?? null;
      s.current = null;
      this.streams.set(ownerId, s);
    } else if (e.kind === "process_record") {
      const r = (e.envelope.body ?? {}) as ProcessRecordBody;
      const poll = r.poll_id ? this.polls.get(r.poll_id) : null;
      poll?.records.push({
        record_id: e.objectId,
        record_type: r.record_type,
        poll_id: r.poll_id,
        detail: r.detail as Record<string, string>,
        anchor_height: this.blockOf(r.anchor_block_hash)?.number.toString() ?? "0",
        position: { height: block.number.toString(), tx_index: "1", output_index: "0", envelope_index: "0" },
        tx_hash: e.item.tx_hash ?? "",
        signers: [],
        envelope: e.envelope as never,
      });
    }
  }

  // ---------------------------------------------------------------- routing

  private route(method: string, path: string, query: URLSearchParams, body: string): unknown {
    const at = this.at();
    let m: RegExpMatchArray | null;
    if (method === "POST" && path === "/api/envelopes") {
      this.posts.push({ text: body, json: JSON.parse(body) });
      return this.intake(body);
    }
    if (method !== "GET") throw new HttpError(405, "METHOD", "method not allowed");
    this.gets.push(path + (query.toString() ? `?${query}` : ""));
    if (path === "/api/status") return this.status();
    if (path === "/api/network") return this.networkInfo();
    if (path === "/api/anchor") {
      this.anchorCalls++;
      if (this.mineOnAnchorEvery > 0 && this.anchorCalls % this.mineOnAnchorEvery === 0) this.mine(1);
      const t = this.tip();
      return {
        anchor: {
          number: t.number.toString(),
          hash: t.hash,
          clock_ms: t.clock.toString(),
          control_publication_deadline_ms: (t.clock + 86_400_000n).toString(),
          process_publication_deadline_ms: (t.clock + 259_200_000n).toString(),
        },
        at: this.at(),
      };
    }
    if ((m = path.match(/^\/api\/proposals\/(0x[0-9a-f]{64})\/ballots$/))) {
      const p = this.polls.get(m[1] ?? "");
      if (!p) throw new HttpError(404, "NOT_FOUND", "proposal not found");
      const owner = query.get("owner");
      return {
        at,
        poll_id: p.pollId,
        order: "canonical position",
        ballots: p.ballots.filter((b) => !owner || b.owner_id === owner),
        rejected: p.rejected.filter((d) => !owner || d.owner_id === owner),
      };
    }
    if ((m = path.match(/^\/api\/proposals\/(0x[0-9a-f]{64})\/records$/))) {
      const p = this.polls.get(m[1] ?? "");
      if (!p) throw new HttpError(404, "NOT_FOUND", "proposal not found");
      return { at, poll_id: p.pollId, records: p.records, rejected: [], admission: { state: "PENDING" }, governance: { state: "NONE" }, attestation: { state: "NONE" } };
    }
    if ((m = path.match(/^\/api\/proposals\/(0x[0-9a-f]{64})$/))) {
      const p = this.polls.get(m[1] ?? "");
      if (!p) throw new HttpError(404, "NOT_FOUND", "proposal not found");
      return { at, poll_id: p.pollId, manifest_payload: { protocol_version: "2", manifest: p.manifest, proposer_proofs: [] }, registered: { position: { height: p.registeredHeight.toString(), tx_index: "1", output_index: "0", envelope_index: "0" }, tx_hash: "0x" } };
    }
    if ((m = path.match(/^\/api\/owners\/(0x[0-9a-f]{64})\/queued$/))) {
      const id = m[1] ?? "";
      const queued = [...this.relay.values()]
        .filter((e) => ["RECEIVED", "BROADCAST", "INCLUDED"].includes(e.item.status) && e.item.owner_id === id)
        .map((e) => ({ ...e.item, envelope: e.envelope }));
      return { owner_id: id, queued };
    }
    if ((m = path.match(/^\/api\/owners\/(0x[0-9a-f]{64})\/power$/)) && query.get("block_hash")) {
      const b = this.blockOf(query.get("block_hash") ?? "");
      if (!b) throw new HttpError(404, "NOT_FOUND", "canonical block not found");
      return { at: { number: b.number.toString(), hash: b.hash, clock_ms: b.clock.toString() }, owner_id: m[1], total_shannon: "0", deposits: [] };
    }
    if ((m = path.match(/^\/api\/owners\/(0x[0-9a-f]{64})\/power$/))) {
      const id = m[1] ?? "";
      const p = this.power.get(id);
      return { at, owner_id: id, owner_lock: p?.lock ?? null, address: p ? this.core.address(this.network, p.lock) : null, total_shannon: p?.total ?? "0", deposits: p ? [{ tx_hash: "0x" + "ab".repeat(32), index: "0", capacity_shannon: p.total, created: null }] : [] };
    }
    if ((m = path.match(/^\/api\/owners\/(0x[0-9a-f]{64})\/authorizations$/))) {
      const id = m[1] ?? "";
      return { at, ...(this.streams.get(id) ?? { policy_hash: this.policy.hash, owner_id: id, current: null, history: [] }) };
    }
    if ((m = path.match(/^\/api\/keys\/(0x[0-9a-f]{64})\/authorizations$/))) {
      return { at, key_id: m[1], grants: this.grants.filter((g) => g.key_id === m?.[1]) };
    }
    if ((m = path.match(/^\/api\/authorizations\/(0x[0-9a-f]{64})$/))) {
      const id = m[1] ?? "";
      const streams = [...this.streams.values()].filter((s) => s.history.some((h) => h.authorization_id === id));
      const grant = this.grants.find((g) => g.authorization_id === id) ?? null;
      if (!grant && streams.length === 0) throw new HttpError(404, "NOT_FOUND", "authorization not found");
      return { at, authorization_id: id, grant, streams, rejected: [] };
    }
    if ((m = path.match(/^\/api\/receipts\/(0x[0-9a-f]{64})$/))) {
      const e = this.relay.get(m[1] ?? "");
      if (!e) throw new HttpError(404, "NOT_FOUND", "receipt not found");
      const item = e.item;
      this.advance(e);
      return { items: [item] };
    }
    if (path === "/api/diagnostics") return { at, order: "newest first", diagnostics: [] };
    throw new HttpError(404, "NOT_FOUND", `no route ${path}`);
  }

  readonly fetch: FetchLike = async (input, init) => {
    const url = new URL(input, "http://mock.invalid");
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : "";
    try {
      const v = this.route(method, url.pathname, url.searchParams, body);
      return new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
    } catch (e) {
      if (e instanceof HttpError) {
        return new Response(JSON.stringify({ error: { code: e.code, detail: e.message } }), { status: e.status, headers: { "content-type": "application/json" } });
      }
      throw e;
    }
  };
}
