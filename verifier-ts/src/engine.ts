/**
 * Replay engine (docs/03 §6–§9, docs/11 §5–§6).
 *
 * Blocks are processed in canonical order. Inside a transaction: spent inputs
 * leave the DAO set, accepted DAO deposits join it, then carriers are handled
 * in (output_index, envelope_index) order against the post-transaction state.
 */
import {
  ADAPTER_WEBAUTHN,
  CONTROL_FORMAT_IDS,
  IMPLEMENTED_KEY_ADAPTER_IDS,
  parseSignatureProof,
  verifyKeySignature,
  verifyOwnerSignature,
} from "./adapter.js";
import { isHash32 } from "./bytes.js";
import {
  KIND,
  CARRIER_VERSION,
  classifyCellData,
  decodeBatch,
  decodeHeader,
  decodePayload,
  envelopeSize,
  LIMITS,
  type CarrierHeader,
} from "./carrier.js";
import type { Diagnostic, Position } from "./diagnostics.js";
import { InputError, SchemaError } from "./errors.js";
import { DOMAIN, objectHash } from "./hash.js";
import { isObject, jcs, type JsonValue } from "./json.js";
import { matchesTemplate, parseScript, scriptEquals, scriptHash, type ScriptJson } from "./molecule.js";
import type { Network } from "./network.js";
import type { InputBlock, InputOutput, InputTx, ReplayInput } from "./replay-input.js";
import {
  BALLOT_FORMAT_WEBAUTHN,
  parseAuthPolicy,
  parseBallotBody,
  parseControlBody,
  parseManifest,
  parseProcessRecord,
  parseProcessRoles,
  type AuthPolicy,
  type BallotBody,
  type ControlBody,
  type KeyDescriptor,
  type Manifest,
  type ProcessRecord,
  type ProcessRoles,
  type RecordType,
} from "./schema.js";
import { ballotText, controlText, processText, proposalText } from "./text.js";

export interface BlockRef {
  number: number;
  hash: string;
  clockMs: bigint;
}

export interface DaoCell {
  txHash: string;
  index: number;
  capacity: bigint;
  ownerId: string;
  lock: ScriptJson;
  created: Position;
}

/** A valid authorization control (first valid appearance). */
export interface ControlRecord {
  body: ControlBody;
  position: Position;
  anchorHeight: number;
  clockMs: bigint;
}

export type ControlState = { state: "GRANT"; grant: ControlRecord } | { state: "REVOKED"; record: ControlRecord } | { state: "CONFLICT" };

export interface Barrier {
  position: Position;
  clockMs: bigint;
  cause: string;
}

/** Control stream per (auth_policy_hash, owner_id) (docs/11 §1). */
export interface ControlStream {
  aMax: number | null;
  current: ControlState | null;
  barriers: Barrier[];
}

export interface BallotRecord {
  body: BallotBody;
  position: Position;
  anchorHeight: number;
  grant: ControlRecord | null;
}

export interface RecordEntry {
  record: ProcessRecord;
  position: Position;
  anchorHeight: number;
}

export interface OwnerSnapshot {
  total: bigint;
  cells: DaoCell[];
}

export interface PollState {
  manifest: Manifest;
  manifestBlock: BlockRef;
  manifestPosition: Position;
  startBlock: BlockRef | null;
  late: boolean;
  closeBlock: BlockRef | null;
  direct: Map<string, BallotRecord[]>;
  delegate: Map<string, BallotRecord[]>;
  validBallotIds: Set<string>;
  owners: Set<string>;
  snapshot: Map<string, OwnerSnapshot> | null;
  unsupportedSeen: boolean;
  proposerDeposit: bigint;
}

export interface RolesHistoryEntry {
  rolesHash: string;
  fromHeight: string;
  recordId: string | null;
}

export class ReplayEngine {
  readonly network: Network;
  readonly diagnostics: Diagnostic[] = [];
  readonly blocks: BlockRef[] = [];
  readonly heightByHash = new Map<string, number>();

  readonly daoCells = new Map<string, DaoCell>();
  readonly ownerCells = new Map<string, Map<string, DaoCell>>();
  readonly ownerTotals = new Map<string, bigint>();

  readonly policies = new Map<string, { policy: AuthPolicy; position: Position }>();
  readonly streams = new Map<string, ControlStream>();
  readonly validControls = new Map<string, ControlRecord>();

  readonly polls = new Map<string, PollState>();
  readonly pollOrder: string[] = [];
  readonly pollRecords = new Map<string, RecordEntry[]>();

  readonly rolesObjects = new Map<string, ProcessRoles>();
  currentRolesHash: string;
  readonly rolesHistory: RolesHistoryEntry[] = [];
  readonly consumedRoles = new Set<string>();
  readonly validRecordIds = new Set<string>();

  private readonly processDelayMs: bigint;

  constructor(private readonly input: ReplayInput) {
    this.network = input.network;
    this.currentRolesHash = input.initialRolesHash;
    this.processDelayMs = input.processPublicationDelayMs;
    this.rolesHistory.push({ rolesHash: input.initialRolesHash, fromHeight: "0", recordId: null });
  }

  run(): this {
    for (const block of this.input.blocks) {
      this.beginBlock(block);
      block.transactions.forEach((tx, ti) => this.processTx(block, tx, ti));
    }
    return this;
  }

  get tip(): BlockRef | null {
    return this.blocks[this.blocks.length - 1] ?? null;
  }

  // -------------------------------------------------------------------------
  // chain bookkeeping

  private beginBlock(block: InputBlock): void {
    const prev = this.tip;
    if (prev === null) {
      if (block.number !== 0 || block.hash !== this.network.genesis_hash) {
        throw new InputError("replay must start at the genesis block of network.genesis_hash (full history, docs/03 §9)");
      }
    } else if (block.number !== prev.number + 1 || block.parentHash !== prev.hash) {
      throw new InputError(`block ${block.number} does not extend block ${prev.number} (parent continuity, docs/03 §9)`);
    }
    if (this.heightByHash.has(block.hash)) throw new InputError(`duplicate block hash ${block.hash}`);
    const ref: BlockRef = { number: block.number, hash: block.hash, clockMs: block.clockMs };
    this.blocks.push(ref);
    this.heightByHash.set(block.hash, block.number);

    for (const pollId of this.pollOrder) {
      const poll = this.polls.get(pollId) as PollState;
      if (poll.startBlock === null && block.clockMs >= poll.manifest.startMs) {
        poll.startBlock = ref;
        this.evaluateLate(poll, block.number);
      }
      if (poll.closeBlock === null && block.clockMs >= poll.manifest.endMs) {
        this.closePoll(poll, prev as BlockRef);
      }
    }
  }

  private evaluateLate(poll: PollState, atHeight: number): void {
    const start = poll.startBlock as BlockRef;
    const gap = BigInt(start.number - poll.manifestBlock.number);
    poll.late = gap < poll.manifest.rules.openingConfirmations;
    if (poll.late) {
      this.diag({ height: atHeight, tx: 0, output: 0, envelope: 0 }, "manifest", poll.manifest.pollId, "LATE_MANIFEST", poll.manifest.pollId, `opening gap ${gap} < opening_confirmations`, false);
    }
  }

  /** Freezes the H_close end state (docs/03 §8): called before the first block with clock >= end_ms. */
  private closePoll(poll: PollState, closeBlock: BlockRef): void {
    poll.closeBlock = closeBlock;
    const snap = new Map<string, OwnerSnapshot>();
    for (const owner of poll.owners) {
      const cells = [...(this.ownerCells.get(owner)?.values() ?? [])];
      snap.set(owner, { total: this.ownerTotals.get(owner) ?? 0n, cells });
    }
    poll.snapshot = snap;
  }

  private anchorHeight(anchor: string, inclusionHeight: number): number | null {
    const h = this.heightByHash.get(anchor);
    return h !== undefined && h < inclusionHeight ? h : null;
  }

  private diag(pos: Position, kind: string, id: string | null, code: string, pollId: string | undefined, message: string | undefined, withPosition = true): void {
    const d: Diagnostic = { height: String(pos.height), kind, id, code };
    if (pollId !== undefined) d.pollId = pollId;
    if (message !== undefined) d.message = message;
    if (withPosition) d.position = pos;
    this.diagnostics.push(d);
  }

  // -------------------------------------------------------------------------
  // DAO deposits (docs/02 §5, docs/03 §9)

  private isDaoDeposit(o: InputOutput): boolean {
    const t = o.type;
    if (t === null || !matchesTemplate(t, this.network.dao) || t.args !== "0x") return false;
    return o.data.length === 8 && o.data.every((b) => b === 0);
  }

  private removeCell(key: string): void {
    const cell = this.daoCells.get(key);
    if (!cell) return;
    this.daoCells.delete(key);
    this.ownerCells.get(cell.ownerId)?.delete(key);
    this.ownerTotals.set(cell.ownerId, (this.ownerTotals.get(cell.ownerId) ?? 0n) - cell.capacity);
  }

  private addCell(cell: DaoCell): void {
    const key = `${cell.txHash}:${cell.index}`;
    if (this.daoCells.has(key)) throw new InputError(`outpoint ${key} created twice`);
    this.daoCells.set(key, cell);
    let m = this.ownerCells.get(cell.ownerId);
    if (!m) {
      m = new Map();
      this.ownerCells.set(cell.ownerId, m);
    }
    m.set(key, cell);
    this.ownerTotals.set(cell.ownerId, (this.ownerTotals.get(cell.ownerId) ?? 0n) + cell.capacity);
  }

  ownerDeposit(ownerId: string): bigint {
    return this.ownerTotals.get(ownerId) ?? 0n;
  }

  private processTx(block: InputBlock, tx: InputTx, ti: number): void {
    for (const input of tx.inputs) this.removeCell(`${input.txHash}:${input.index}`);
    for (const o of tx.outputs) {
      if (this.isDaoDeposit(o)) {
        this.addCell({
          txHash: tx.hash,
          index: o.index,
          capacity: o.capacity,
          ownerId: scriptHash(o.lock),
          lock: o.lock,
          created: { height: block.number, tx: ti, output: o.index, envelope: 0 },
        });
      }
    }
    for (const o of tx.outputs) {
      const cls = classifyCellData(o.data);
      if (cls === "none") continue;
      const pos: Position = { height: block.number, tx: ti, output: o.index, envelope: 0 };
      if (cls === "malformed") {
        this.diag(pos, "carrier", tx.hash, "CARRIER_MALFORMED", undefined, "cell data starts with the magic but is not 78 bytes");
        continue;
      }
      this.processCarrier(block, tx, pos, decodeHeader(o.data));
    }
  }

  // -------------------------------------------------------------------------
  // carriers (docs/03 §7)

  private processCarrier(block: InputBlock, tx: InputTx, pos: Position, header: CarrierHeader): void {
    const pollScoped = header.kind === KIND.MANIFEST || header.kind === KIND.BALLOT_BATCH || header.kind === KIND.RESULT_RECORD || header.kind === KIND.PROCESS_BATCH;
    const scopePoll = pollScoped ? header.scopeId : undefined;
    const fail = (code: string, message: string) => this.diag(pos, "carrier", tx.hash, code, scopePoll, message);
    if (header.version !== CARRIER_VERSION) return fail("UNSUPPORTED_VERSION", `carrier version ${header.version}`);
    if (header.kind < KIND.MANIFEST || header.kind > KIND.PROCESS_BATCH) return fail("UNKNOWN_KIND", `carrier kind ${header.kind}`);
    const witness = tx.witnesses[header.witnessIndex];
    if (witness === undefined) return fail("WITNESS_MISSING", `witness ${header.witnessIndex} does not exist`);
    let payload: JsonValue;
    try {
      payload = decodePayload(header, witness);
    } catch (e) {
      if (e instanceof SchemaError) return fail(e.code, e.message);
      throw e;
    }
    switch (header.kind) {
      case KIND.MANIFEST:
        return this.handleManifest(block, pos, header, payload);
      case KIND.BALLOT_BATCH:
        return this.handleBatch(tx, pos, header, payload, (env, p) => this.handleBallot(block, p, header, env));
      case KIND.RESULT_RECORD:
        return; // non-authoritative result records do not affect replay (docs/03 §7)
      case KIND.AUTHORIZATION_POLICY:
        return this.handlePolicy(pos, header, payload);
      case KIND.AUTHORIZATION_BATCH:
        return this.handleBatch(tx, pos, header, payload, (env, p) => this.handleControl(block, p, header, env));
      case KIND.PROCESS_ROLES:
        return this.handleRoles(pos, header, payload);
      case KIND.PROCESS_BATCH:
        return this.handleBatch(tx, pos, header, payload, (env, p) => this.handleRecord(block, p, header, env));
    }
  }

  private handleBatch(
    tx: InputTx,
    pos: Position,
    header: CarrierHeader,
    payload: JsonValue,
    each: (env: JsonValue, pos: Position) => void,
  ): void {
    let envelopes: JsonValue[];
    try {
      envelopes = decodeBatch(payload);
    } catch (e) {
      if (e instanceof SchemaError) {
        const scopePoll = header.kind === KIND.AUTHORIZATION_BATCH ? undefined : header.scopeId;
        this.diag(pos, "carrier", tx.hash, e.code, scopePoll, e.message);
        return;
      }
      throw e;
    }
    envelopes.forEach((env, j) => each(env, { ...pos, envelope: j }));
  }

  /** Common envelope framing: size limit and exact keys. Returns the body/proof part or null after a diagnostic. */
  private envelopeParts(env: JsonValue, proofKey: "proof" | "proofs", pos: Position, kind: string, domain: string, pollId: string | undefined): { body: JsonValue; proof: JsonValue; id: string } | null {
    const body = isObject(env) ? env["body"] : undefined;
    const id = body === undefined ? null : objectHash(domain as (typeof DOMAIN)[keyof typeof DOMAIN], body);
    if (envelopeSize(env) > LIMITS.maxEnvelopeBytes) {
      this.diag(pos, kind, id, "ENVELOPE_TOO_LARGE", pollId, "envelope exceeds 8 KiB");
      return null;
    }
    if (!isObject(env) || Object.keys(env).sort().join(",") !== ["body", proofKey].sort().join(",")) {
      this.diag(pos, kind, id, "MALFORMED", pollId, `envelope must have exactly body and ${proofKey}`);
      return null;
    }
    return { body: env["body"] as JsonValue, proof: env[proofKey] as JsonValue, id: id as string };
  }

  // -------------------------------------------------------------------------
  // manifests (docs/03 §3, §3.1)

  private handleManifest(block: InputBlock, pos: Position, header: CarrierHeader, payload: JsonValue): void {
    const raw = isObject(payload) ? payload["manifest"] : undefined;
    const pollId = isObject(raw) ? objectHash(DOMAIN.POLL, raw) : header.scopeId;
    const reject = (code: string, message: string) => this.diag(pos, "manifest", pollId, code, pollId, message);
    if (!isObject(payload) || Object.keys(payload).sort().join(",") !== "manifest,proposer_proofs,protocol_version" || payload["protocol_version"] !== "2") {
      return reject("MALFORMED", 'manifest payload must be {"protocol_version":"2","manifest":…,"proposer_proofs":[…]}');
    }
    if (pollId !== header.scopeId) return reject("SCOPE_MISMATCH", "carrier scope_id is not the poll_id");
    let m: Manifest;
    try {
      m = parseManifest(raw, this.network);
    } catch (e) {
      if (e instanceof SchemaError) return reject(e.code, e.message);
      throw e;
    }
    const proofs = payload["proposer_proofs"];
    if (!Array.isArray(proofs) || proofs.length !== m.proposers.length) {
      return reject("MALFORMED", "proposer_proofs must hold exactly one proof per proposer lock, in owner_id order");
    }
    for (let i = 0; i < proofs.length; i++) {
      const p = proofs[i];
      const lockExpected = m.proposers[i] as ScriptJson;
      let lock: ScriptJson;
      let sig: Uint8Array;
      let adapter: string;
      try {
        if (!isObject(p) || Object.keys(p).sort().join(",") !== "auth_adapter,owner_lock,proof") throw new SchemaError("proposer proof must have owner_lock, auth_adapter, proof");
        lock = parseScript(p["owner_lock"], `proposer_proofs[${i}].owner_lock`);
        if (typeof p["auth_adapter"] !== "string") throw new SchemaError("auth_adapter must be a string");
        adapter = p["auth_adapter"];
        sig = parseSignatureProof(p["proof"], `proposer_proofs[${i}].proof`);
      } catch (e) {
        if (e instanceof SchemaError) return reject("MALFORMED", e.message);
        throw e;
      }
      if (!scriptEquals(lock, lockExpected)) return reject("MALFORMED", `proposer_proofs[${i}] does not match proposer_owner_locks[${i}]`);
      if (!m.registry.owner_adapters.includes(adapter)) return reject("ADAPTER_NOT_ACCEPTED", `proposer adapter ${adapter} is not in auth_registry.owner_adapters`);
      const text = proposalText(m, lock, this.network);
      const r = verifyOwnerSignature(adapter, text, sig, lock, this.network);
      if (r !== "OK") return reject(r === "UNSUPPORTED_ADAPTER" ? "ADAPTER_NOT_ACCEPTED" : r, `proposer ${i}: ${r}`);
    }
    // docs/13 §4 item 11: the authorization_policy must be published at a strictly earlier position.
    if (!this.policies.has(m.policyHash)) return reject("POLICY_UNKNOWN", "auth policy not published by an earlier kind-4 carrier");
    if (this.polls.has(m.pollId)) return reject("DUPLICATE", "manifest already registered");

    const ref = this.blocks[block.number] as BlockRef;
    let proposerDeposit = 0n;
    for (const id of m.proposerIds) proposerDeposit += this.ownerDeposit(id);
    const poll: PollState = {
      manifest: m,
      manifestBlock: ref,
      manifestPosition: pos,
      startBlock: null,
      late: false,
      closeBlock: null,
      direct: new Map(),
      delegate: new Map(),
      validBallotIds: new Set(),
      owners: new Set(),
      snapshot: null,
      unsupportedSeen: false,
      proposerDeposit,
    };
    this.polls.set(m.pollId, poll);
    this.pollOrder.push(m.pollId);
    // Boundaries already reached by this or earlier blocks.
    const sIdx = this.blocks.findIndex((b) => b.clockMs >= m.startMs);
    if (sIdx >= 0) {
      poll.startBlock = this.blocks[sIdx] as BlockRef;
      this.evaluateLate(poll, block.number);
    }
    const eIdx = this.blocks.findIndex((b) => b.clockMs >= m.endMs);
    if (eIdx >= 0) {
      // The window is already over; no ballot can be valid. H_close precedes the first end block.
      poll.closeBlock = eIdx > 0 ? (this.blocks[eIdx - 1] as BlockRef) : (this.blocks[0] as BlockRef);
      poll.snapshot = new Map();
    }
  }

  // -------------------------------------------------------------------------
  // ballots (docs/03 §5–§6, docs/11 §6)

  private handleBallot(block: InputBlock, pos: Position, header: CarrierHeader, env: JsonValue): void {
    const scope = header.scopeId;
    const parts = this.envelopeParts(env, "proof", pos, "ballot", DOMAIN.BALLOT, scope);
    if (!parts) return;
    const { id } = parts;
    const reject = (code: string, message: string) => this.diag(pos, "ballot", id, code, scope, message);
    let b: BallotBody;
    try {
      b = parseBallotBody(parts.body, this.network);
    } catch (e) {
      if (e instanceof SchemaError) return reject(e.code, e.message);
      throw e;
    }
    if (b.pollId !== scope) return reject("SCOPE_MISMATCH", "ballot poll_id differs from the batch scope");
    const poll = this.polls.get(b.pollId);
    if (!poll) return reject("UNKNOWN_POLL", "no valid manifest for this poll_id at this position");
    const m = poll.manifest;
    if (poll.late) return reject("LATE_MANIFEST", "poll was declared LATE_MANIFEST");
    if (b.rulesHash !== m.rulesHash) return reject("RULES_MISMATCH", "ballot rules_hash differs from the manifest");
    if (!m.signatureFormats.includes(b.signatureFormat)) return reject("FORMAT_NOT_ACCEPTED", `signature_format ${b.signatureFormat} not accepted by the manifest`);
    const webauthnFormat = b.signatureFormat === BALLOT_FORMAT_WEBAUTHN;
    if (b.authority === "owner" && webauthnFormat) return reject("FORMAT_NOT_ACCEPTED", "direct ballots are signed by message adapters over omavote-readable-v2");
    let sig: Uint8Array | null = null;
    let text: string | null = null;
    if (!webauthnFormat) {
      try {
        sig = parseSignatureProof(parts.proof, "proof");
        text = ballotText(m, b, this.network);
      } catch (e) {
        if (e instanceof SchemaError) return reject("MALFORMED", e.message);
        throw e;
      }
    }

    let grant: ControlRecord | null = null;
    /** Set when every check passed except a signature this verifier cannot verify (webauthn PoC path). */
    let unverifiable = false;
    if (b.authority === "owner") {
      if (!m.registry.owner_adapters.includes(b.authAdapter)) return reject("ADAPTER_NOT_ACCEPTED", `owner adapter ${b.authAdapter} not in auth_registry`);
      const r = verifyOwnerSignature(b.authAdapter, text as string, sig as Uint8Array, b.ownerLock, this.network);
      if (r !== "OK") return reject(r === "UNSUPPORTED_ADAPTER" ? "ADAPTER_NOT_ACCEPTED" : r, `direct ballot: ${r}`);
    } else {
      grant = this.validControls.get(b.authorizationId as string) ?? null;
      if (!grant || grant.body.action !== "GRANT") return reject("NO_ACTIVE_GRANT", "authorization_id is not a valid GRANT");
      const g = grant.body;
      const key = g.keyDescriptor as KeyDescriptor;
      if (g.ownerId !== b.ownerId) return reject("WRONG_OWNER", "the grant belongs to a different owner");
      if (g.policyHash !== m.policyHash) return reject("NO_ACTIVE_GRANT", "the grant is under a different auth policy");
      if (key.keyId !== b.signerKeyId || key.adapter !== b.authAdapter) return reject("WRONG_KEY", "signer_key_id/auth_adapter do not match the grant descriptor");
      if (!m.registry.owner_adapters.includes(g.ownerAuthAdapter) || !m.registry.key_adapters.includes(key.adapter)) {
        return reject("ADAPTER_NOT_ACCEPTED", "grant owner adapter or key adapter not in auth_registry");
      }
      if ((key.adapter === ADAPTER_WEBAUTHN) !== webauthnFormat) return reject("FORMAT_NOT_ACCEPTED", "signature_format does not match the key adapter");
      if (!IMPLEMENTED_KEY_ADAPTER_IDS.includes(key.adapter)) {
        unverifiable = true;
      } else {
        const r = verifyKeySignature(key, text as string, sig as Uint8Array);
        if (r !== "OK") return reject("INVALID_SIGNATURE", `delegate ballot: ${r}`);
      }
    }

    const clock = block.clockMs;
    if (clock < m.startMs || clock >= m.endMs) return reject("OUT_OF_WINDOW", "inclusion clock outside [start_ms, end_ms)");
    if (b.authority === "delegate" && clock >= m.endMs - m.rules.delegateCutoffMs) return reject("OUT_OF_WINDOW", "delegate ballot after end_ms - delegate_cutoff_ms");
    const anchorHeight = this.anchorHeight(b.anchor, block.number);
    if (anchorHeight === null) return reject("ANCHOR_INVALID", "anchor is not a canonical ancestor of the inclusion block");
    // docs/13 §4 item 11: a ballot anchor must not be lower than the manifest's registration height.
    if (anchorHeight < poll.manifestBlock.number) return reject("ANCHOR_INVALID", "ballot anchor is below the manifest registration height");
    if (b.action !== "CANCEL" && this.ownerDeposit(b.ownerId) <= 0n) return reject("NO_DEPOSIT_AT_CAST", "owner has no active deposit after this transaction");
    if (grant) {
      const stream = this.streams.get(`${m.policyHash}|${b.ownerId}`);
      const cur = stream?.current;
      if (!cur || cur.state !== "GRANT" || cur.grant.body.authorizationId !== grant.body.authorizationId) {
        return reject("NO_ACTIVE_GRANT", "the referenced grant is not the owner's current control");
      }
      if (clock >= (grant.body.expiresAtMs as bigint)) return reject("GRANT_EXPIRED", "grant expired before inclusion");
    }
    if (poll.validBallotIds.has(b.ballotId)) return reject("DUPLICATE", "ballot_id already has an earlier valid appearance");
    if (unverifiable) {
      poll.unsupportedSeen = true;
      return reject("UNSUPPORTED_ADAPTER", "signature uses a key adapter this verifier does not implement; result marked DATA_INCOMPLETE");
    }

    poll.validBallotIds.add(b.ballotId);
    poll.owners.add(b.ownerId);
    const rec: BallotRecord = { body: b, position: pos, anchorHeight, grant };
    const map = b.authority === "owner" ? poll.direct : poll.delegate;
    const list = map.get(b.ownerId);
    if (list) list.push(rec);
    else map.set(b.ownerId, [rec]);
  }

  // -------------------------------------------------------------------------
  // authorization policy and controls (docs/11 §2–§5)

  private handlePolicy(pos: Position, header: CarrierHeader, payload: JsonValue): void {
    const id = objectHash(DOMAIN.AUTH_POLICY, payload);
    let policy: AuthPolicy;
    try {
      policy = parseAuthPolicy(payload, this.network);
    } catch (e) {
      if (e instanceof SchemaError) return this.diag(pos, "authorization_policy", id, e.code, undefined, e.message);
      throw e;
    }
    if (policy.hash !== header.scopeId) return this.diag(pos, "authorization_policy", id, "SCOPE_MISMATCH", undefined, "scope_id is not the policy hash");
    if (!this.policies.has(policy.hash)) this.policies.set(policy.hash, { policy, position: pos });
  }

  stream(policyHash: string, ownerId: string): ControlStream {
    const key = `${policyHash}|${ownerId}`;
    let s = this.streams.get(key);
    if (!s) {
      s = { aMax: null, current: null, barriers: [] };
      this.streams.set(key, s);
    }
    return s;
  }

  private handleControl(block: InputBlock, pos: Position, header: CarrierHeader, env: JsonValue): void {
    const parts = this.envelopeParts(env, "proof", pos, "authorization_control", DOMAIN.AUTHORIZATION, undefined);
    if (!parts) return;
    const { id } = parts;
    const reject = (code: string, message: string) => this.diag(pos, "authorization_control", id, code, undefined, message);
    let c: ControlBody;
    try {
      c = parseControlBody(parts.body, this.network);
    } catch (e) {
      if (e instanceof SchemaError) return reject(e.code, e.message);
      throw e;
    }
    if (c.policyHash !== header.scopeId) return reject("SCOPE_MISMATCH", "control auth_policy_hash differs from the batch scope");
    if (!CONTROL_FORMAT_IDS.includes(c.ownerAuthAdapter)) return reject("ADAPTER_NOT_ACCEPTED", `${c.ownerAuthAdapter} is not in the control-format set`);
    let sig: Uint8Array;
    let text: string;
    try {
      sig = parseSignatureProof(parts.proof, "proof");
      text = controlText(c, this.network);
    } catch (e) {
      if (e instanceof SchemaError) return reject("MALFORMED", e.message);
      throw e;
    }
    const r = verifyOwnerSignature(c.ownerAuthAdapter, text, sig, c.ownerLock, this.network);
    if (r !== "OK") return reject(r === "UNSUPPORTED_ADAPTER" ? "ADAPTER_NOT_ACCEPTED" : r, `control: ${r}`);
    const pol = this.policies.get(c.policyHash);
    if (!pol) return reject("POLICY_UNKNOWN", "auth policy not published by an earlier kind-4 carrier");
    const anchorHeight = this.anchorHeight(c.anchor, block.number);
    if (anchorHeight === null) return reject("ANCHOR_INVALID", "anchor is not a canonical ancestor of the inclusion block");
    const tAnchor = (this.blocks[anchorHeight] as BlockRef).clockMs;
    const clock = block.clockMs;
    if (c.deadlineMs !== tAnchor + pol.policy.maxControlPublicationDelayMs) return reject("DEADLINE_MISMATCH", "publication_deadline_ms != clock(anchor) + max_control_publication_delay_ms");
    if (clock < tAnchor || clock >= c.deadlineMs) return reject("PUBLICATION_EXPIRED", "inclusion clock outside [clock(anchor), publication_deadline_ms)");
    if (c.action === "GRANT") {
      const exp = c.expiresAtMs as bigint;
      if (exp <= tAnchor || exp - tAnchor > pol.policy.maxTermMs) return reject("EXPIRY_INVALID", "expires_at_ms - clock(anchor) must lie in (0, max_term_ms]");
      if (clock >= exp) return reject("GRANT_EXPIRED", "grant included at or after expires_at_ms");
    }
    if (this.validControls.has(c.authorizationId)) return reject("DUPLICATE", "authorization_id already has an earlier valid appearance");

    const record: ControlRecord = { body: c, position: pos, anchorHeight, clockMs: clock };
    this.validControls.set(c.authorizationId, record);
    const s = this.stream(c.policyHash, c.ownerId);
    const barrier = (cause: string) => s.barriers.push({ position: pos, clockMs: clock, cause });
    if (s.aMax === null || anchorHeight > s.aMax) {
      s.aMax = anchorHeight;
      if (c.action === "GRANT") s.current = { state: "GRANT", grant: record };
      else s.current = { state: "REVOKED", record };
      if (c.revokeMode === "STOP_AND_CANCEL_OPEN") barrier(c.action === "GRANT" ? "GRANT+CANCEL" : "REVOKE STOP_AND_CANCEL_OPEN");
    } else if (anchorHeight === s.aMax) {
      // A different body at the current anchor height (identical bodies are DUPLICATE above).
      s.current = { state: "CONFLICT" };
      barrier("AUTH_CONFLICT");
      this.diag(pos, "authorization_control", id, "AUTH_CONFLICT", undefined, "different control at the same anchor height");
    } else {
      this.diag(pos, "authorization_control", id, "STALE_AUTHORIZATION", undefined, "anchor lower than the current control");
    }
  }

  // -------------------------------------------------------------------------
  // process roles and records (docs/03 §3.1)

  private handleRoles(pos: Position, header: CarrierHeader, payload: JsonValue): void {
    const id = objectHash(DOMAIN.ROLES, payload);
    let roles: ProcessRoles;
    try {
      roles = parseProcessRoles(payload, this.network);
    } catch (e) {
      if (e instanceof SchemaError) return this.diag(pos, "process_roles", id, e.code, undefined, e.message);
      throw e;
    }
    if (roles.rolesHash !== header.scopeId) return this.diag(pos, "process_roles", id, "SCOPE_MISMATCH", undefined, "scope_id is not the roles hash");
    if (!this.rolesObjects.has(roles.rolesHash)) this.rolesObjects.set(roles.rolesHash, roles);
  }

  private handleRecord(block: InputBlock, pos: Position, header: CarrierHeader, env: JsonValue): void {
    const parts = this.envelopeParts(env, "proofs", pos, "process_record", DOMAIN.PROCESS, header.scopeId);
    if (!parts) return;
    const { id } = parts;
    let pollTag: string | undefined = header.scopeId;
    const reject = (code: string, message: string) => this.diag(pos, "process_record", id, code, pollTag, message);
    let rec: ProcessRecord;
    let proofs: Array<{ signer: string; sig: Uint8Array }>;
    try {
      rec = parseProcessRecord(parts.body, this.network);
      pollTag = rec.pollId ?? undefined;
      if (!Array.isArray(parts.proof)) throw new SchemaError("proofs must be an array");
      proofs = parts.proof.map((p, i) => {
        if (!isObject(p) || Object.keys(p).sort().join(",") !== "proof,signer_key_id") throw new SchemaError(`proofs[${i}] must have signer_key_id and proof`);
        if (!isHash32(p["signer_key_id"])) throw new SchemaError(`proofs[${i}].signer_key_id must be a hash`);
        return { signer: p["signer_key_id"], sig: parseSignatureProof(p["proof"], `proofs[${i}].proof`) };
      });
    } catch (e) {
      if (e instanceof SchemaError) return reject(e.code, e.message);
      throw e;
    }
    if (rec.scopeId !== header.scopeId) return reject("SCOPE_MISMATCH", "record scope differs from the batch scope");
    if (rec.rolesHash !== this.currentRolesHash) return reject("ROLES_NOT_EFFECTIVE", "roles_hash is not the configuration in effect at this position");
    const roles = this.rolesObjects.get(this.currentRolesHash);
    if (!roles) return reject("ROLES_UNAVAILABLE", "the effective roles object has not been published");
    const anchorHeight = this.anchorHeight(rec.anchor, block.number);
    if (anchorHeight === null) return reject("ANCHOR_INVALID", "anchor is not a canonical ancestor of the inclusion block");
    const tAnchor = (this.blocks[anchorHeight] as BlockRef).clockMs;
    if (rec.deadlineMs !== tAnchor + this.processDelayMs) return reject("DEADLINE_MISMATCH", "publication_deadline_ms != clock(anchor) + process publication delay");
    if (block.clockMs < tAnchor || block.clockMs >= rec.deadlineMs) return reject("PUBLICATION_EXPIRED", "inclusion clock outside [clock(anchor), publication_deadline_ms)");
    let text: string;
    try {
      text = processText(rec);
    } catch (e) {
      if (e instanceof SchemaError) return reject("MALFORMED", e.message);
      throw e;
    }
    const cfg = rec.role === "committee" ? roles.committee : roles.coordinator;
    const members = new Map(cfg.members.map((k) => [k.keyId, k] as const));
    const counted = new Set<string>();
    for (const p of proofs) {
      if (counted.has(p.signer)) continue;
      const member = members.get(p.signer);
      if (!member) continue;
      if (verifyKeySignature(member, text, p.sig) === "OK") counted.add(p.signer);
    }
    if (counted.size < cfg.threshold) return reject("INSUFFICIENT_SIGNATURES", `${counted.size} valid member signatures, threshold ${cfg.threshold}`);
    let newRoles: ProcessRoles | undefined;
    if (rec.recordType === "ROLES_UPDATE") {
      newRoles = this.rolesObjects.get(rec.scopeId);
      if (!newRoles) return reject("ROLES_UNAVAILABLE", "new roles object not published before the update");
      if (newRoles.previousRolesHash !== this.currentRolesHash) return reject("ROLES_CHAIN_MISMATCH", "new roles object does not point to the current roles_hash");
      if (this.consumedRoles.has(this.currentRolesHash)) return reject("ROLES_CHAIN_MISMATCH", "current roles already updated once");
    }
    if (this.validRecordIds.has(rec.recordId)) return reject("DUPLICATE", "record_id already has an earlier valid appearance");
    this.validRecordIds.add(rec.recordId);

    if (newRoles) {
      this.consumedRoles.add(this.currentRolesHash);
      this.currentRolesHash = newRoles.rolesHash;
      this.rolesHistory.push({ rolesHash: newRoles.rolesHash, fromHeight: String(block.number), recordId: rec.recordId });
      return;
    }
    const pollId = rec.pollId as string;
    let list = this.pollRecords.get(pollId);
    if (!list) {
      list = [];
      this.pollRecords.set(pollId, list);
    }
    if (rec.recordType === "ADMISSION" || rec.recordType === "GOVERNANCE_STATUS" || rec.recordType === "RESULT_ATTESTATION") {
      // docs/13 §4 item 12: a conflict is a different detail of the same type at the same anchor height.
      const detail = jcs(rec.detail);
      const clash = list.some((e) => e.record.recordType === rec.recordType && e.anchorHeight === anchorHeight && jcs(e.record.detail) !== detail);
      if (clash) this.diag(pos, "process_record", id, "RECORD_CONFLICT", pollId, "different detail of the same record type at the same anchor height");
    }
    list.push({ record: rec, position: pos, anchorHeight });
  }

  recordsOf(pollId: string, type: RecordType): RecordEntry[] {
    return (this.pollRecords.get(pollId) ?? []).filter((e) => e.record.recordType === type);
  }
}
