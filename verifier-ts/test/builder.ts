/**
 * Synthetic chain builder for scenario tests. It signs every message with
 * deterministic test keys through the verifier's own text renderers, so the
 * scenarios exercise the state machine (docs/11 §5–§8), not cross-language
 * rendering (that is covered by vectors/).
 */
import {
  ADAPTER_CKB,
  ADAPTER_EVM,
  ckbMessageDigest,
  evmAddressFromPoint,
  evmMessageDigest,
  publicKeyFromSecret,
  signDigest,
} from "../src/adapter.js";
import { bytesToHex, hexToBytes } from "../src/bytes.js";
import { buildCarrier, KIND } from "../src/carrier.js";
import { blake160, ckbHash, ckbHashHex, DOMAIN, objectHash } from "../src/hash.js";
import { toJsonValue, utf8Encode, type JsonObject, type JsonValue } from "../src/json.js";
import { scriptHash, type ScriptJson } from "../src/molecule.js";
import { parseNetwork, type Network } from "../src/network.js";
import { buildReport, runReplay } from "../src/replay.js";
import { parseReplayInputValue } from "../src/replay-input.js";
import {
  parseBallotBody,
  parseControlBody,
  parseManifest,
  parseProcessRecord,
  type Manifest,
} from "../src/schema.js";
import { ballotText, controlText, processText, proposalText } from "../src/text.js";
import type { ReplayEngine } from "../src/engine.js";

export const CKB = 100_000_000n;
export const HOUR = 3_600_000n;
export const DAY = 24n * HOUR;
export const BASE_CLOCK = 1_800_000_000_000n;
export const DAO_NAMESPACE = "ckb-community-fund-dao";

export const TEMPLATES = {
  secp256k1: { code_hash: "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8", hash_type: "type" },
  dao: { code_hash: "0x82d76d1b75fe2fd9a27dfbaa65a039221a380d76c926f378d3f81cf3e7e13f2e", hash_type: "type" },
  omnilock: { code_hash: "0xc44a1b51e2b135fc6c09e07140c9f5349accff07e0ab78fe1457ba61d59982dd", hash_type: "type" },
  pw_lock: { code_hash: "0x34e60685446c398779fb4f887c301725b8377d464ce158b3b75270b609ce51d8", hash_type: "type" },
} as const;

function h(label: string): string {
  return ckbHashHex(utf8Encode(label));
}

export class Wallet {
  readonly secret: Uint8Array;
  readonly publicKey: Uint8Array;
  readonly address: string;
  constructor(readonly name: string) {
    this.secret = ckbHash(utf8Encode(`omavote-test-wallet:${name}`));
    this.publicKey = publicKeyFromSecret(this.secret, true);
    this.address = evmAddressFromPoint(publicKeyFromSecret(this.secret, false));
  }
  secpLock(): ScriptJson {
    return { ...TEMPLATES.secp256k1, args: bytesToHex(blake160(this.publicKey)) } as ScriptJson;
  }
  /** Omnilock owner: auth flag 0x01 (Ethereum) or 0x12 (Ethereum-displaying), then the Omnilock flags byte. */
  omniLock(flags = "00", authFlag = "01"): ScriptJson {
    return { ...TEMPLATES.omnilock, args: `0x${authFlag}${this.address.slice(2)}${flags}` } as ScriptJson;
  }
  pwLock(): ScriptJson {
    return { ...TEMPLATES.pw_lock, args: this.address } as ScriptJson;
  }
  secpDescriptor(): JsonObject {
    return toJsonValue({ kind: "secp256k1", public_key: bytesToHex(this.publicKey), adapter: ADAPTER_CKB }) as JsonObject;
  }
  evmDescriptor(): JsonObject {
    return toJsonValue({ kind: "evm_eoa", address: this.address, adapter: ADAPTER_EVM }) as JsonObject;
  }
  keyId(kind: "secp" | "evm"): string {
    return objectHash(DOMAIN.KEY, kind === "secp" ? this.secpDescriptor() : this.evmDescriptor());
  }
  signCkb(text: string): string {
    return bytesToHex(signDigest(ckbMessageDigest(text), this.secret));
  }
  signEvm(text: string, vOffset = 27): string {
    const sig = signDigest(evmMessageDigest(text), this.secret);
    sig[64] = (sig[64] as number) + vOffset;
    return bytesToHex(sig);
  }
  sign(adapter: string, text: string): string {
    return adapter === ADAPTER_CKB ? this.signCkb(text) : this.signEvm(text);
  }
}

export interface TxJson {
  hash: string;
  inputs: Array<{ tx_hash: string; index: string }>;
  outputs: Array<{ index: string; capacity: string; lock: JsonValue; type: JsonValue; data: string }>;
  witnesses: string[];
}

export interface Outpoint {
  txHash: string;
  index: number;
}

const CARRIER_LOCK = { ...TEMPLATES.secp256k1, args: `0x${"aa".repeat(20)}` };

let txCounter = 0;

export class Chain {
  readonly blocks: Array<{ number: string; hash: string; parent_hash: string; clock_ms: string; transactions: TxJson[] }> = [];
  pending: TxJson[] = [];
  readonly salt: string;

  constructor(salt = "chain") {
    this.salt = salt;
    this.blocks.push({ number: "0", hash: h(`${salt}:block:0`), parent_hash: `0x${"00".repeat(32)}`, clock_ms: BASE_CLOCK.toString(), transactions: [] });
  }

  get genesisHash(): string {
    return (this.blocks[0] as { hash: string }).hash;
  }
  get height(): number {
    return this.blocks.length - 1;
  }
  /** Height the next mined block will have. */
  get next(): number {
    return this.blocks.length;
  }
  hashOf(n: number): string {
    const b = this.blocks[n];
    if (!b) throw new Error(`no block ${n}`);
    return b.hash;
  }
  /** Hash a not-yet-mined block will get (hashes are deterministic). */
  futureHash(n: number): string {
    return h(`${this.salt}:block:${n}`);
  }
  clockOf(n: number): bigint {
    return BASE_CLOCK + BigInt(n) * HOUR;
  }

  newTx(): TxJson {
    txCounter++;
    return { hash: h(`${this.salt}:tx:${txCounter}`), inputs: [{ tx_hash: h(`${this.salt}:funding:${txCounter}`), index: "0" }], outputs: [], witnesses: ["0x"] };
  }

  add(tx: TxJson): TxJson {
    this.pending.push(tx);
    return tx;
  }

  deposit(lock: ScriptJson, ckb: bigint): Outpoint {
    const tx = this.newTx();
    tx.outputs.push({ index: "0", capacity: (ckb * CKB).toString(), lock: lock as unknown as JsonValue, type: { ...TEMPLATES.dao, args: "0x" }, data: "0x0000000000000000" });
    this.add(tx);
    return { txHash: tx.hash, index: 0 };
  }

  spend(op: Outpoint): void {
    const tx = this.newTx();
    tx.inputs = [{ tx_hash: op.txHash, index: String(op.index) }];
    tx.outputs.push({ index: "0", capacity: "100000000000", lock: CARRIER_LOCK, type: null, data: "0x" });
    this.add(tx);
  }

  /** Appends a carrier output (and its witness) to `tx`, or to a new transaction. */
  carrier(kind: number, scope: string, payload: JsonValue, tx?: TxJson): TxJson {
    const t = tx ?? this.add(this.newTx());
    const witnessIndex = t.witnesses.length;
    const { data, witness } = buildCarrier(kind, scope, payload, witnessIndex);
    t.outputs.push({ index: String(t.outputs.length), capacity: "13900000000", lock: CARRIER_LOCK, type: null, data: bytesToHex(data) });
    t.witnesses.push(bytesToHex(witness));
    return t;
  }

  mine(): number {
    const n = this.next;
    const parent = this.hashOf(n - 1);
    this.blocks.push({ number: String(n), hash: h(`${this.salt}:block:${n}`), parent_hash: parent, clock_ms: this.clockOf(n).toString(), transactions: this.pending });
    this.pending = [];
    return n;
  }

  mineUntil(height: number): void {
    while (this.height < height) this.mine();
  }
}

export interface ManifestOptions {
  startBlock: number;
  proposers: Wallet[];
  proposalType?: "grant" | "meta_rule";
  budgetCkb?: bigint;
  quorumBaseCkb?: bigint;
  ownerAdapters?: string[];
  keyAdapters?: string[];
  rules?: Partial<Record<string, JsonValue>>;
  votingPeriodMs?: bigint;
  nonce?: string;
  signingTitle?: string;
  signatureFormats?: string[];
  proposerKind?: "secp" | "omni" | "pw";
}

export function lockOf(w: Wallet, kind: "secp" | "omni" | "pw" = "secp"): ScriptJson {
  return kind === "secp" ? w.secpLock() : kind === "omni" ? w.omniLock() : w.pwLock();
}

/** A chain pre-loaded with the auth policy and the initial process roles (block 1). */
export class Scenario {
  readonly chain: Chain;
  readonly net: JsonObject;
  readonly network: Network;
  readonly policy: JsonObject;
  readonly policyHash: string;
  readonly coordinator = new Wallet("coordinator");
  readonly committee = [new Wallet("committee-1"), new Wallet("committee-2"), new Wallet("committee-3")];
  rolesJson: JsonObject;
  rolesHash: string;
  processDelayMs = 72n * HOUR;

  constructor(salt = "scenario", opts: { publishPolicy?: boolean } = {}) {
    this.chain = new Chain(salt);
    this.net = toJsonValue({ name: "scenario", genesis_hash: this.chain.genesisHash, hrp: "ckt", ...TEMPLATES }) as JsonObject;
    this.network = parseNetwork(this.net);
    this.policy = toJsonValue({
      message_kind: "authorization_policy",
      protocol_version: "2",
      network_genesis_hash: this.chain.genesisHash,
      dao_namespace: DAO_NAMESPACE,
      clock: "ckb-parent-mtp-v1",
      max_term_ms: "31536000000",
      max_control_publication_delay_ms: "86400000",
      semantics: "omavote-authorization-semantics-v2",
    }) as JsonObject;
    this.policyHash = objectHash(DOMAIN.AUTH_POLICY, this.policy);
    this.rolesJson = this.makeRoles(null, "01");
    this.rolesHash = objectHash(DOMAIN.ROLES, this.rolesJson);
    if (opts.publishPolicy ?? true) this.publishPolicy();
    this.chain.carrier(KIND.PROCESS_ROLES, this.rolesHash, this.rolesJson);
    this.chain.mine();
  }

  /** Publishes the authorization policy (kind 4) in the pending block, or into `tx`. */
  publishPolicy(tx?: TxJson): TxJson {
    return this.chain.carrier(KIND.AUTHORIZATION_POLICY, this.policyHash, this.policy, tx);
  }

  makeRoles(previous: string | null, nonceByte: string, committee = this.committee, threshold = "2"): JsonObject {
    const members = [...committee].sort((a, b) => (a.keyId("evm") < b.keyId("evm") ? -1 : 1)).map((w) => w.evmDescriptor());
    return toJsonValue({
      message_kind: "process_roles",
      protocol_version: "2",
      network_genesis_hash: this.chain.genesisHash,
      dao_namespace: DAO_NAMESPACE,
      previous_roles_hash: previous,
      roles: {
        committee: { threshold, members },
        coordinator: { threshold: "1", members: [this.coordinator.secpDescriptor()] },
      },
      nonce: `0x${nonceByte.repeat(32)}`,
    }) as JsonObject;
  }

  rules(overrides: Partial<Record<string, JsonValue>> = {}, votingPeriodMs = 7n * DAY): JsonObject {
    return toJsonValue({
      profile: "omavote-ckb-community-fund-v2",
      asset: "nervos-dao-deposit",
      amount: "raw-capacity-principal",
      weight_time: "final-accepted-block-state",
      withdraw_phase1: "excluded",
      cast_eligibility: "positive-deposit-at-valid-inclusion",
      revote: "direct-priority-latest-anchor",
      authorization: "term-limited-max-365-chain-days",
      cancel: "exclude-both-sides-and-quorum",
      precision: "exact-shannon",
      choices: ["YES", "NO", "CANCEL"],
      quorum_grant_multiplier: "3",
      quorum_meta_rule_shannon: "18500000000000000",
      approval_grant: { numerator: "51", denominator: "100" },
      approval_meta_rule: { numerator: "67", denominator: "100" },
      threshold_comparison: "inclusive",
      opening_confirmations: "2",
      delegate_cutoff_ms: "0",
      voting_period_ms: votingPeriodMs.toString(),
      proposer_min_deposit_shannon: (100_000n * CKB).toString(),
      ...overrides,
    }) as JsonObject;
  }

  manifestJson(o: ManifestOptions): JsonObject {
    const type = o.proposalType ?? "grant";
    const rules = this.rules(o.rules ?? {}, o.votingPeriodMs ?? 7n * DAY);
    const registry = toJsonValue({
      owner_adapters: o.ownerAdapters ?? [ADAPTER_CKB, ADAPTER_EVM],
      key_adapters: o.keyAdapters ?? [ADAPTER_CKB, ADAPTER_EVM],
    }) as JsonObject;
    const start = this.chain.clockOf(o.startBlock);
    const period = BigInt(rules["voting_period_ms"] as string);
    const sortedLocks = sortLocks(o.proposers.map((w) => lockOf(w, o.proposerKind)));
    return toJsonValue({
      message_kind: "manifest",
      protocol_version: "2",
      network_genesis_hash: this.chain.genesisHash,
      dao_namespace: DAO_NAMESPACE,
      nonce: o.nonce ?? h(`nonce:${o.startBlock}:${o.signingTitle ?? ""}`),
      proposal_type: type,
      title: "A scenario proposal",
      signing_title: o.signingTitle ?? "Scenario proposal",
      content_hash: h("content"),
      content_locations: ["https://talk.nervos.org/t/example/1"],
      forum_topic_id: "1",
      forum_revision: "1",
      discussion_evidence_hash: null,
      budget_ckb_shannon: type === "grant" ? ((o.budgetCkb ?? 25_000n) * CKB).toString() : "0",
      quorum_base_shannon: type === "grant" ? ((o.quorumBaseCkb ?? o.budgetCkb ?? 25_000n) * CKB).toString() : "0",
      payment_terms_hash: null,
      recipient_lock_script: type === "grant" ? { ...TEMPLATES.secp256k1, args: `0x${"42".repeat(20)}` } : null,
      proposer_owner_locks: sortedLocks,
      rules_profile: rules,
      rules_hash: objectHash(DOMAIN.RULES, rules),
      auth_registry: registry,
      auth_registry_hash: objectHash(DOMAIN.AUTH_REGISTRY, registry),
      authorization_policy: this.policy,
      auth_policy_hash: this.policyHash,
      signature_formats: o.signatureFormats ?? ["omavote-readable-v2"],
      clock: "ckb-parent-mtp-v1",
      start_ms: start.toString(),
      end_ms: (start + period).toString(),
      confirmation_policy: { result_confirmations: "100", review_window_ms: "86400000" },
      publication_policy: "full-onchain-v2",
    }) as JsonObject;
  }

  /** Publishes a manifest with proposer proofs in the pending block; returns the parsed manifest. */
  publishManifest(o: ManifestOptions, tx?: TxJson): Manifest {
    const json = this.manifestJson(o);
    const m = parseManifest(json, this.network);
    const adapter = (o.proposerKind ?? "secp") === "secp" ? ADAPTER_CKB : ADAPTER_EVM;
    const proofs = m.proposers.map((lock) => {
      const w = o.proposers.find((x) => lockOf(x, o.proposerKind).args === lock.args) as Wallet;
      return { owner_lock: lock, auth_adapter: adapter, proof: { signature: w.sign(adapter, proposalText(m, lock, this.network)) } };
    });
    this.chain.carrier(KIND.MANIFEST, m.pollId, toJsonValue({ protocol_version: "2", manifest: json, proposer_proofs: proofs }), tx);
    return m;
  }

  /** Publishes an arbitrary (possibly invalid) manifest payload under `scope` (default: its poll_id). */
  publishManifestRaw(manifest: JsonObject, proofs: JsonValue[], scope?: string, tx?: TxJson): string {
    const pollId = objectHash(DOMAIN.POLL, manifest);
    this.chain.carrier(KIND.MANIFEST, scope ?? pollId, toJsonValue({ protocol_version: "2", manifest, proposer_proofs: proofs }), tx);
    return pollId;
  }

  /** Signed proposer proof for `manifest` (must parse). */
  proposerProof(manifest: JsonObject, w: Wallet, kind: "secp" | "omni" | "pw" = "secp", signer?: Wallet): JsonObject {
    const m = parseManifest(manifest, this.network);
    const lock = lockOf(w, kind);
    const adapter = kind === "secp" ? ADAPTER_CKB : ADAPTER_EVM;
    return toJsonValue({ owner_lock: lock, auth_adapter: adapter, proof: { signature: (signer ?? w).sign(adapter, proposalText(m, lock, this.network)) } }) as JsonObject;
  }

  controlDeadline(anchorHeight: number): bigint {
    return this.chain.clockOf(anchorHeight) + DAY;
  }

  /** Builds a signed control envelope (GRANT or REVOKE). */
  control(o: {
    owner: Wallet;
    ownerKind?: "secp" | "omni" | "pw";
    action: "GRANT" | "REVOKE";
    key?: JsonObject;
    anchorHeight: number;
    termMs?: bigint;
    expiresAtMs?: bigint;
    revokeMode?: "STOP_ONLY" | "STOP_AND_CANCEL_OPEN" | null;
    nonce?: string;
    deadlineMs?: bigint;
    policyHash?: string;
    signer?: Wallet;
  }): { envelope: JsonObject; id: string } {
    const kind = o.ownerKind ?? "secp";
    const lock = kind === "secp" ? o.owner.secpLock() : kind === "omni" ? o.owner.omniLock() : o.owner.pwLock();
    const adapter = kind === "secp" ? ADAPTER_CKB : ADAPTER_EVM;
    const tAnchor = this.chain.clockOf(o.anchorHeight);
    const body = toJsonValue({
      protocol_version: "2",
      message_kind: "authorization_control",
      network_genesis_hash: this.chain.genesisHash,
      dao_namespace: DAO_NAMESPACE,
      auth_policy_hash: o.policyHash ?? this.policyHash,
      owner_lock: lock,
      owner_auth_adapter: adapter,
      action: o.action,
      key_descriptor: o.action === "GRANT" ? (o.key as JsonObject) : null,
      expires_at_ms: o.action === "GRANT" ? (o.expiresAtMs ?? tAnchor + (o.termMs ?? 365n * DAY)).toString() : null,
      revoke_mode: o.revokeMode === undefined ? (o.action === "GRANT" ? null : "STOP_ONLY") : o.revokeMode,
      anchor_block_hash: this.chain.hashOf(o.anchorHeight),
      publication_deadline_ms: (o.deadlineMs ?? this.controlDeadline(o.anchorHeight)).toString(),
      nonce: o.nonce ?? h(`control:${o.owner.name}:${o.action}:${o.anchorHeight}:${String(o.revokeMode)}:${JSON.stringify(o.key ?? null)}`),
      signature_format: "omavote-authorization-v2",
    }) as JsonObject;
    const c = parseControlBody(body, this.network);
    const text = controlText(c, this.network);
    const signer = o.signer ?? o.owner;
    const signature = signer.sign(adapter, text);
    return { envelope: toJsonValue({ body, proof: { signature } }) as JsonObject, id: c.authorizationId };
  }

  publishControls(envelopes: JsonObject[], tx?: TxJson): TxJson {
    return this.chain.carrier(KIND.AUTHORIZATION_BATCH, this.policyHash, toJsonValue({ protocol_version: "2", envelopes }), tx);
  }

  /** Builds a signed ballot envelope. */
  ballot(o: {
    manifest: Manifest;
    owner: Wallet;
    ownerKind?: "secp" | "omni" | "pw";
    action: "YES" | "NO" | "CANCEL";
    anchorHeight: number;
    delegate?: { grantId: string; key: Wallet; keyKind: "secp" | "evm" };
    nonce?: string;
    signer?: Wallet;
    anchorHash?: string;
  }): { envelope: JsonObject; id: string } {
    const kind = o.ownerKind ?? "secp";
    const lock = kind === "secp" ? o.owner.secpLock() : kind === "omni" ? o.owner.omniLock() : o.owner.pwLock();
    const ownerAdapter = kind === "secp" ? ADAPTER_CKB : ADAPTER_EVM;
    const d = o.delegate;
    const adapter = d ? (d.keyKind === "secp" ? ADAPTER_CKB : ADAPTER_EVM) : ownerAdapter;
    const body = toJsonValue({
      message_kind: "ballot",
      protocol_version: "2",
      action: o.action,
      authority: d ? "delegate" : "owner",
      authorization_id: d ? d.grantId : null,
      signer_key_id: d ? d.key.keyId(d.keyKind) : null,
      nonce: o.nonce ?? h(`ballot:${o.owner.name}:${o.action}:${o.anchorHeight}:${d ? d.grantId : "direct"}`),
      anchor_block_hash: o.anchorHash ?? this.chain.hashOf(o.anchorHeight),
      auth_adapter: adapter,
      dao_namespace: DAO_NAMESPACE,
      network_genesis_hash: this.chain.genesisHash,
      owner_lock: lock,
      poll_id: o.manifest.pollId,
      rules_hash: o.manifest.rulesHash,
      signature_format: "omavote-readable-v2",
    }) as JsonObject;
    const b = parseBallotBody(body, this.network);
    const text = ballotText(o.manifest, b, this.network);
    const signer = o.signer ?? (d ? d.key : o.owner);
    const signature = signer.sign(adapter, text);
    return { envelope: toJsonValue({ body, proof: { signature } }) as JsonObject, id: b.ballotId };
  }

  publishBallots(manifest: Manifest, envelopes: JsonObject[], tx?: TxJson): TxJson {
    return this.chain.carrier(KIND.BALLOT_BATCH, manifest.pollId, toJsonValue({ protocol_version: "2", envelopes }), tx);
  }

  /** Builds a process record envelope signed by `signers` (members of the role). */
  record(o: {
    rolesHash?: string;
    role: "coordinator" | "committee";
    recordType: string;
    pollId: string | null;
    detail: JsonValue;
    anchorHeight: number;
    signers: Wallet[];
    signerKind?: "secp" | "evm";
    nonce?: string;
    deadlineMs?: bigint;
  }): { envelope: JsonObject; id: string; scope: string } {
    const body = toJsonValue({
      message_kind: "process_record",
      protocol_version: "2",
      network_genesis_hash: this.chain.genesisHash,
      dao_namespace: DAO_NAMESPACE,
      roles_hash: o.rolesHash ?? this.rolesHash,
      role: o.role,
      record_type: o.recordType,
      poll_id: o.pollId,
      detail: o.detail,
      evidence_hash: null,
      anchor_block_hash: this.chain.hashOf(o.anchorHeight),
      publication_deadline_ms: (o.deadlineMs ?? this.chain.clockOf(o.anchorHeight) + this.processDelayMs).toString(),
      nonce: o.nonce ?? h(`record:${o.recordType}:${o.anchorHeight}:${JSON.stringify(o.detail)}`),
    }) as JsonObject;
    const kind = o.signerKind ?? (o.role === "coordinator" ? "secp" : "evm");
    let r: ReturnType<typeof parseProcessRecord> | null = null;
    try {
      r = parseProcessRecord(body, this.network);
    } catch {
      r = null; // deliberately invalid record: sign a placeholder text
    }
    const text = r ? processText(r) : "invalid record";
    const proofs = o.signers.map((w) => ({ signer_key_id: w.keyId(kind), proof: { signature: kind === "secp" ? w.signCkb(text) : w.signEvm(text) } }));
    const recordId = r ? r.recordId : objectHash(DOMAIN.PROCESS, body);
    const scope = r ? r.scopeId : (o.pollId ?? `0x${"00".repeat(32)}`);
    return { envelope: toJsonValue({ body, proofs }) as JsonObject, id: recordId, scope };
  }

  publishRecords(scope: string, envelopes: JsonObject[], tx?: TxJson): TxJson {
    return this.chain.carrier(KIND.PROCESS_BATCH, scope, toJsonValue({ protocol_version: "2", envelopes }), tx);
  }

  inputJson(): JsonObject {
    return toJsonValue({
      network: this.net,
      initial_roles_hash: this.rolesHash,
      process_publication_delay_ms: this.processDelayMs.toString(),
      blocks: this.chain.blocks,
    }) as JsonObject;
  }

  run(): { engine: ReplayEngine; report: (pollId: string) => JsonObject; full: JsonObject } {
    const engine = runReplay(parseReplayInputValue(this.inputJson()));
    return {
      engine,
      report: (pollId: string) => {
        const r = buildReport(engine, { pollId });
        if (!r) throw new Error(`poll ${pollId} not registered`);
        return r;
      },
      full: buildReport(engine) as JsonObject,
    };
  }
}

/** Sorts proposer locks by owner_id (script hash). */
export function sortLocks(locks: ScriptJson[]): ScriptJson[] {
  return [...locks].sort((a, b) => (scriptHash(a) < scriptHash(b) ? -1 : 1));
}

/** Owner row helper. */
export function ownerRow(report: JsonObject, ownerId: string): JsonObject | undefined {
  const core = report["result_core"] as JsonObject | null;
  if (!core) return undefined;
  return (core["owners"] as JsonObject[]).find((o) => o["owner_id"] === ownerId);
}

export function diagCodes(report: JsonObject): string[] {
  return (report["diagnostics"] as JsonObject[]).map((d) => d["code"] as string);
}

export function diagFor(report: JsonObject, id: string): string[] {
  return (report["diagnostics"] as JsonObject[]).filter((d) => d["id"] === id).map((d) => d["code"] as string);
}

export { hexToBytes };
