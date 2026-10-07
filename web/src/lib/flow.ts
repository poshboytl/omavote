// Signing and submission flows as plain functions (no DOM), so that they can be
// tested in Node with the WASM core, a mock wallet and a mocked API.
//
// Every message body is built here with exactly the fields of the Rust drafts
// (BallotDraft, ControlDraft, RecordDraft, ManifestDraft); the core validates the
// body, computes its ID and renders the exact text that the wallet signs.

import type { Api } from "./api";
import { ApiError } from "./api";
import type { Core } from "./core";
import type { Eip1193Provider } from "./eip1193";
import { personalSign } from "./eip1193";
import { big } from "./format";
import { parseCompressedPubkey, parseEvmAddress, utf8Bytes, utf8ToHex } from "./hex";
import type {
  Action,
  AnchorInfo,
  At,
  AuthPolicy,
  AuthRegistry,
  Authority,
  BallotBody,
  BallotEnvelope,
  BallotView,
  ControlAction,
  ControlBody,
  ControlEnvelope,
  Diagnostic,
  GrantView,
  KeyDescriptor,
  LockInfo,
  Manifest,
  ManifestPayload,
  NetworkParams,
  OwnerPower,
  ProcessEnvelope,
  ProcessRecordBody,
  ProcessRoles,
  RecordDetail,
  RecordType,
  RelayItem,
  RevokeMode,
  Role,
  RulesProfile,
  Script,
  StatusView,
  StreamView,
  VerifyResult,
} from "./types";

export const PROTOCOL_VERSION = "2";
export const DAO_NAMESPACE = "ckb-community-fund-dao";
export const SIG_FORMAT_READABLE = "omavote-readable-v2";
export const SIG_FORMAT_AUTHORIZATION = "omavote-authorization-v2";
export const ADAPTER_CKB = "ckb-secp256k1-message-v1";
export const ADAPTER_EVM = "evm-personal-message-v1";
export const DAY_MS_BIG = 86_400_000n;
export const MAX_TERM_DAYS = 365;
export const TERM_PRESETS = [30, 90, 365] as const;
export const DEFAULT_TERM_DAYS = 365;
export const RELAY_DONE = ["INCLUDED", "CONFIRMED"];
export const RELAY_FAILED = ["EXPIRED", "FAILED"];

// ---------------------------------------------------------------------------
// Waiting helpers

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const sleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortError());
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new AbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export class AbortError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortError";
  }
}

export class TimeoutError extends Error {
  constructor(what: string) {
    super(`timed out waiting for ${what}`);
    this.name = "TimeoutError";
  }
}

export class FlowError extends Error {
  /** i18n key describing the problem. */
  readonly key: string;
  readonly params: Record<string, string>;
  constructor(key: string, params: Record<string, string> = {}, message?: string) {
    super(message ?? key);
    this.name = "FlowError";
    this.key = key;
    this.params = params;
  }
}

export interface WaitOpts {
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  sleep?: Sleep;
  now?: () => number;
}

function waitParams(o: WaitOpts) {
  return {
    interval: o.intervalMs ?? 2000,
    timeout: o.timeoutMs ?? 120_000,
    signal: o.signal,
    sleep: o.sleep ?? sleep,
    now: o.now ?? (() => Date.now()),
  };
}

// ---------------------------------------------------------------------------
// Server sync check before signing (docs/11 §5: anchors need an up-to-date node)

export type SyncIssue =
  | { key: "sync.notSynced" }
  | { key: "sync.lag"; blocks: string }
  | { key: "sync.stale"; seconds: string }
  | { key: "sync.lastError"; detail: string }
  | { key: "sync.noTip" }
  | { key: "sync.noIntake" };

export interface SyncAssessment {
  ok: boolean;
  issues: SyncIssue[];
  lagBlocks: number | null;
}

export function assessSync(
  status: StatusView,
  nowMs: number,
  opts: { maxLagBlocks?: number; maxStaleMs?: number; needIntake?: boolean } = {},
): SyncAssessment {
  const maxLag = opts.maxLagBlocks ?? 2;
  const maxStale = opts.maxStaleMs ?? 120_000;
  const issues: SyncIssue[] = [];
  if (!status.indexed) issues.push({ key: "sync.noTip" });
  if (!status.synced) issues.push({ key: "sync.notSynced" });
  const lag = status.lag_blocks !== null && status.lag_blocks !== undefined ? Number(status.lag_blocks) : null;
  if (lag !== null && lag > maxLag) issues.push({ key: "sync.lag", blocks: String(lag) });
  const last = Number(status.last_sync_ms);
  if (Number.isFinite(last) && last > 0 && nowMs - last > maxStale) {
    issues.push({ key: "sync.stale", seconds: String(Math.round((nowMs - last) / 1000)) });
  }
  if (status.last_error) issues.push({ key: "sync.lastError", detail: status.last_error });
  if (opts.needIntake && !status.relay?.intake) issues.push({ key: "sync.noIntake" });
  return { ok: issues.length === 0, issues, lagBlocks: lag };
}

// ---------------------------------------------------------------------------
// Anchors: the latest verified block, strictly newer than the previous signature
// in the same sequence (docs/03 §6, docs/11 §2 and §6).

/** `/api/anchor` is the newest indexed block; it is always used as-is, never an older one. */
export async function fetchAnchor(api: Api): Promise<AnchorInfo> {
  return (await api.anchor()).anchor;
}

/**
 * Wait until `/api/anchor` returns a block strictly higher than `aboveHeight` (when given).
 * `onWait` reports each "waiting for the next block" round so the page can say so.
 */
export async function anchorAbove(
  api: Api,
  aboveHeight: bigint | null,
  opts: WaitOpts & { onWait?: (current: AnchorInfo, floor: bigint) => void } = {},
): Promise<AnchorInfo> {
  const w = waitParams({ intervalMs: 2000, timeoutMs: 180_000, ...opts });
  const deadline = w.now() + w.timeout;
  for (;;) {
    const a = await fetchAnchor(api);
    if (aboveHeight === null || big(a.number) > aboveHeight) return a;
    opts.onWait?.(a, aboveHeight);
    if (w.now() > deadline) throw new TimeoutError("a newer anchor block");
    await w.sleep(w.interval, w.signal);
  }
}

function maxBig(values: bigint[]): bigint | null {
  return values.length === 0 ? null : values.reduce((a, b) => (a > b ? a : b));
}

/** Local record of anchors signed on this device: one sequence per owner and poll. */
export function ballotSequence(pollId: string, ownerId: string): string {
  return `ballot:${pollId}:${ownerId}`;
}

export function controlSequence(ownerId: string): string {
  return `control:${ownerId}`;
}

/**
 * Anchor heights of the owner's ballots and controls queued at this relay and not yet
 * confirmed (`/api/owners/{id}/queued`), e.g. signed on another device. Anchors are
 * block hashes; their heights come from `/api/owners/{id}/power?block_hash=` (a
 * non-canonical anchor is skipped: that message cannot take effect anyway). Servers
 * without the endpoint give an empty list.
 */
export async function queuedAnchorHeights(api: Api, ownerId: string): Promise<bigint[]> {
  let queued;
  try {
    queued = (await api.ownerQueued(ownerId)).queued;
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.code === "BAD_RESPONSE")) return [];
    throw e;
  }
  const hashes = new Set<string>();
  for (const it of queued) {
    const h = it.envelope?.body?.anchor_block_hash;
    if (typeof h === "string" && /^0x[0-9a-f]{64}$/.test(h)) hashes.add(h);
  }
  const out: bigint[] = [];
  for (const h of hashes) {
    try {
      const at = (await api.ownerPowerAt(ownerId, h)).at;
      if (at) out.push(big(at.number));
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) throw e;
    }
  }
  return out;
}

/**
 * A new ballot must anchor strictly higher than every earlier ballot of the owner
 * in this poll (two different ballots on one anchor are a CONFLICT): the anchors the
 * indexer shows (`/ballots?owner=`), those queued at the relay, those signed on this
 * device, and the anchor must not be older than the manifest registration.
 * Returns the exclusive floor.
 */
export async function ballotAnchorFloor(
  api: Api,
  pollId: string,
  ownerId: string,
  registeredHeight: string,
  localLast: { number: string } | null,
): Promise<bigint | null> {
  const v = await api.ballots(pollId, ownerId);
  const heights = v.ballots.filter((b) => b.owner_id === ownerId).map((b) => big(b.anchor_height));
  heights.push(...(await queuedAnchorHeights(api, ownerId)));
  if (localLast) heights.push(big(localLast.number));
  const reg = big(registeredHeight);
  if (reg > 0n) heights.push(reg - 1n);
  return maxBig(heights);
}

// ---------------------------------------------------------------------------
// Signing requests: the exact text, its first-line summary and its bytes

export interface SignRequest {
  text: string;
  summary: string;
  textHex: string;
  byteLength: number;
}

export function signRequest(text: string, summary?: string): SignRequest {
  return {
    text,
    summary: summary ?? text.split("\n")[0] ?? "",
    textHex: utf8ToHex(text),
    byteLength: utf8Bytes(text).length,
  };
}

// ---------------------------------------------------------------------------
// Ballots (BallotDraft::build)

export interface BallotInput {
  pollId: string;
  rulesHash: string;
  genesis: string;
  ownerLock: Script;
  action: Action;
  authority: Authority;
  authorizationId: string | null;
  signerKeyId: string | null;
  authAdapter: string;
  anchorHash: string;
  nonce: string;
}

export function scriptOf(s: Script): Script {
  return { code_hash: s.code_hash, hash_type: s.hash_type, args: s.args };
}

export function sameScript(a: Script | null | undefined, b: Script | null | undefined): boolean {
  return !!a && !!b && a.code_hash === b.code_hash && a.hash_type === b.hash_type && a.args === b.args;
}

export function ballotBody(i: BallotInput): BallotBody {
  return {
    message_kind: "ballot",
    protocol_version: PROTOCOL_VERSION,
    action: i.action,
    authority: i.authority,
    authorization_id: i.authority === "owner" ? null : i.authorizationId,
    signer_key_id: i.authority === "owner" ? null : i.signerKeyId,
    nonce: i.nonce,
    anchor_block_hash: i.anchorHash,
    auth_adapter: i.authAdapter,
    dao_namespace: DAO_NAMESPACE,
    network_genesis_hash: i.genesis,
    owner_lock: scriptOf(i.ownerLock),
    poll_id: i.pollId,
    rules_hash: i.rulesHash,
    signature_format: SIG_FORMAT_READABLE,
  };
}

export interface PreparedBallot extends SignRequest {
  kind: "ballot";
  body: BallotBody;
  ballotId: string;
  ownerId: string;
}

export function prepareBallot(core: Core, network: NetworkParams, manifest: Manifest, body: BallotBody): PreparedBallot {
  const out = core.ballot(network, manifest, body);
  return { kind: "ballot", body: out.body, ballotId: out.ballot_id, ownerId: out.owner_id, ...signRequest(out.text, out.summary) };
}

/** Owner (direct) or delegate (voting key) identity for a new ballot. */
export type VoterIdentity =
  | { authority: "owner"; ownerLock: Script; adapter: string }
  | { authority: "delegate"; ownerLock: Script; authorizationId: string; signerKeyId: string; adapter: string };

/**
 * Build a ballot for `manifest` with a fresh nonce and the given anchor.
 * The poll id and rules hash come from the core, never from the API view.
 */
export function newBallot(
  core: Core,
  network: NetworkParams,
  manifest: Manifest,
  voter: VoterIdentity,
  action: Action,
  anchor: AnchorInfo,
): PreparedBallot {
  const info = core.manifestInfo(manifest);
  const body = ballotBody({
    pollId: info.poll_id,
    rulesHash: info.rules_hash,
    genesis: manifest.network_genesis_hash,
    ownerLock: voter.ownerLock,
    action,
    authority: voter.authority,
    authorizationId: voter.authority === "delegate" ? voter.authorizationId : null,
    signerKeyId: voter.authority === "delegate" ? voter.signerKeyId : null,
    authAdapter: voter.adapter,
    anchorHash: anchor.hash,
    nonce: core.nonce(),
  });
  return prepareBallot(core, network, manifest, body);
}

export function ballotEnvelope(body: BallotBody, signature: string): BallotEnvelope {
  return { body, proof: { signature } };
}

/** Poll accepts the owner adapter for direct ballots / the key adapter for delegate ballots. */
export function adapterAccepted(manifest: Manifest, authority: Authority, adapter: string): boolean {
  const list = authority === "owner" ? manifest.auth_registry.owner_adapters : manifest.auth_registry.key_adapters;
  return list.includes(adapter);
}

// ---------------------------------------------------------------------------
// Owner discovery

export type LockKind = "secp256k1" | "omnilock" | "pw_lock" | "other";

export function lockKind(network: NetworkParams, s: Script): LockKind {
  const m = (id: { code_hash: string; hash_type: string } | null) => !!id && id.code_hash === s.code_hash && id.hash_type === s.hash_type;
  if (m(network.secp256k1)) return "secp256k1";
  if (m(network.omnilock)) return "omnilock";
  if (m(network.pw_lock)) return "pw_lock";
  return "other";
}

/** Short label of a lock for display: kind plus the Omnilock auth flag when relevant. */
export function lockLabel(network: NetworkParams, s: Script): string {
  const k = lockKind(network, s);
  if (k === "omnilock") {
    const flag = s.args.slice(2, 4);
    return flag === "01" ? "Omnilock (EVM 0x01)" : flag === "12" ? "Omnilock (EVM 0x12)" : `Omnilock (0x${flag})`;
  }
  if (k === "pw_lock") return "PW Lock";
  if (k === "secp256k1") return "secp256k1/blake160";
  return "other lock";
}

/** Owner adapter able to sign for a lock (null when no supported message adapter exists). */
export function ownerAdapterFor(network: NetworkParams, s: Script): string | null {
  const k = lockKind(network, s);
  if (k === "secp256k1") return ADAPTER_CKB;
  if (k === "omnilock" || k === "pw_lock") return ADAPTER_EVM;
  return null;
}

export interface OwnerCandidate {
  lock: LockInfo;
  kind: LockKind;
  power: OwnerPower | null;
  error: string | null;
}

/** Owner locks an EVM address controls (Omnilock EVM mode, PW Lock) with their current deposits. */
export async function evmOwnerCandidates(core: Core, api: Api, network: NetworkParams, evmAddress: string): Promise<OwnerCandidate[]> {
  const addr = parseEvmAddress(evmAddress);
  if (!addr) throw new FlowError("err.badEvmAddress");
  const locks = core.evmOwnerLocks(network, addr);
  return Promise.all(
    locks.map(async (lock) => {
      try {
        return { lock, kind: lockKind(network, lock.script), power: await api.ownerPower(lock.owner_id), error: null };
      } catch (e) {
        return { lock, kind: lockKind(network, lock.script), power: null, error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
}

/** The candidate with the largest current deposit, or null when none has a deposit. */
export function bestCandidate(cands: OwnerCandidate[]): OwnerCandidate | null {
  let best: OwnerCandidate | null = null;
  for (const c of cands) {
    if (!c.power || big(c.power.total_shannon) === 0n) continue;
    if (!best || big(c.power.total_shannon) > big(best.power?.total_shannon)) best = c;
  }
  return best;
}

/** Parse a CKB address into an owner for Neuron-style signing. */
export function ownerFromAddress(
  core: Core,
  network: NetworkParams,
  address: string,
): { lock: LockInfo; kind: LockKind; adapter: string | null } {
  let parsed: { hrp: string; script: Script; script_hash: string };
  try {
    parsed = core.parseAddress(address.trim());
  } catch (e) {
    throw new FlowError("err.badCkbAddress", { detail: e instanceof Error ? e.message : String(e) });
  }
  if (parsed.hrp !== network.hrp) throw new FlowError("err.wrongNetworkAddress", { hrp: parsed.hrp, expected: network.hrp });
  const kind = lockKind(network, parsed.script);
  return {
    lock: { script: parsed.script, owner_id: parsed.script_hash, address: core.address(network, parsed.script) },
    kind,
    adapter: ownerAdapterFor(network, parsed.script),
  };
}

// ---------------------------------------------------------------------------
// Delegate (voting key) discovery: grants for a key that are CURRENT

export type DelegateProblem =
  | "not_current"
  | "expired"
  | "policy_mismatch"
  | "owner_adapter_not_accepted"
  | "key_adapter_not_accepted"
  | "owner_lock_unknown"
  | "no_deposit";

export interface DelegateOption {
  grant: GrantView;
  ownerLock: Script | null;
  ownerAddress: string | null;
  power: OwnerPower | null;
  problems: DelegateProblem[];
}

/** Problems that block a YES/NO delegate ballot (CANCEL does not need a deposit). */
export function delegateBlocked(o: DelegateOption, action: Action): boolean {
  return o.problems.some((p) => p !== "no_deposit" || action !== "CANCEL");
}

export async function delegateOptions(
  core: Core,
  api: Api,
  network: NetworkParams,
  manifest: Manifest,
  keyId: string,
  chainClockMs: string,
): Promise<DelegateOption[]> {
  const view = await api.keyAuthorizations(keyId);
  const policy = core.manifestInfo(manifest).auth_policy_hash;
  const grants = view.grants.filter((g) => g.state === "CURRENT" || g.state === "EXPIRED");
  return Promise.all(
    grants.map(async (grant) => {
      const problems: DelegateProblem[] = [];
      if (grant.state !== "CURRENT") problems.push("not_current");
      if (big(grant.expires_at_ms) <= big(chainClockMs)) problems.push("expired");
      if (grant.policy_hash !== policy) problems.push("policy_mismatch");
      if (!manifest.auth_registry.owner_adapters.includes(grant.owner_adapter)) problems.push("owner_adapter_not_accepted");
      if (!manifest.auth_registry.key_adapters.includes(grant.key_descriptor.adapter)) problems.push("key_adapter_not_accepted");
      let ownerLock: Script | null = null;
      let power: OwnerPower | null = null;
      try {
        const stream = await api.ownerAuthorizations(grant.owner_id, grant.policy_hash);
        ownerLock = stream.owner_lock ?? null;
      } catch {
        ownerLock = null;
      }
      try {
        power = await api.ownerPower(grant.owner_id);
        ownerLock = ownerLock ?? power.owner_lock;
      } catch {
        power = null;
      }
      if (ownerLock && core.scriptHash(ownerLock) !== grant.owner_id) ownerLock = null;
      if (!ownerLock) problems.push("owner_lock_unknown");
      if (!power || big(power.total_shannon) === 0n) problems.push("no_deposit");
      return {
        grant,
        ownerLock,
        ownerAddress: ownerLock ? core.address(network, ownerLock) : null,
        power,
        problems,
      };
    }),
  );
}

// ---------------------------------------------------------------------------
// Signatures

export type Signer = (req: SignRequest) => Promise<string>;

/** Signer backed by an EIP-1193 wallet (`personal_sign` over hex(utf8(text))). */
export function walletSigner(provider: Eip1193Provider, address: string): Signer {
  return (req) => personalSign(provider, req.text, address);
}

export function verifyOwnerSig(
  core: Core,
  network: NetworkParams,
  adapter: string,
  ownerLock: Script,
  text: string,
  signature: string,
): VerifyResult {
  try {
    return core.verifyOwner(network, adapter, ownerLock, text, signature);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function verifyKeySig(core: Core, descriptor: KeyDescriptor, text: string, signature: string): VerifyResult {
  try {
    return core.verifyKey(descriptor, text, signature);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// Submission and relay receipts

export type SubmitOutcome =
  | { ok: true; item: RelayItem; envelopeJcs: string; duplicate: boolean; alreadyOnChain: boolean }
  | { ok: false; status: number; code: string; detail: string; envelopeJcs: string };

/** POST the envelope (in JCS form) to `/api/envelopes`. */
export async function submitEnvelope(core: Core, api: Api, envelope: object): Promise<SubmitOutcome> {
  const envelopeJcs = core.jcs(envelope);
  try {
    const item = await api.submit(envelopeJcs);
    return {
      ok: true,
      item,
      envelopeJcs,
      duplicate: item.duplicate === true,
      alreadyOnChain: item.status === "ALREADY_ON_CHAIN",
    };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, status: e.status, code: e.code, detail: e.detail, envelopeJcs };
    return { ok: false, status: 0, code: "NETWORK", detail: e instanceof Error ? e.message : String(e), envelopeJcs };
  }
}

export interface ReceiptCheck {
  present: boolean;
  signer: string | null;
  /** null when the server published no receipt key to compare with. */
  signerMatches: boolean | null;
  objectMatches: boolean;
  kindMatches: boolean;
  genesisMatches: boolean | null;
  /** null when the submitted envelope bytes are unknown (e.g. receipt page). */
  envelopeHashMatches: boolean | null;
  error: string | null;
}

/**
 * Check a relay receipt: recover its signer with the core and compare with the
 * server's published receipt key; check that it names our object and envelope bytes.
 * A valid receipt proves the relay accepted the envelope, not that it is on chain.
 */
export function checkReceipt(
  core: Core,
  item: RelayItem,
  expected: { receiptKey: string | null; objectId: string; itemKind: string; envelopeJcs?: string | null; genesis?: string | null },
): ReceiptCheck {
  const r = item.receipt;
  if (!r) {
    return {
      present: false,
      signer: null,
      signerMatches: null,
      objectMatches: item.object_id === expected.objectId,
      kindMatches: item.message_kind === expected.itemKind,
      genesisMatches: null,
      envelopeHashMatches: null,
      error: null,
    };
  }
  let signer: string | null = null;
  let error: string | null = null;
  try {
    signer = core.receiptSigner(r.body, r.signature);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const envelopeHashMatches =
    expected.envelopeJcs !== undefined && expected.envelopeJcs !== null
      ? core.ckbHash(utf8ToHex(expected.envelopeJcs)) === r.body.envelope_hash
      : null;
  return {
    present: true,
    signer,
    signerMatches: expected.receiptKey ? signer !== null && signer === expected.receiptKey && r.body.relay_receipt_key === signer : null,
    objectMatches: r.body.object_id === expected.objectId && item.object_id === expected.objectId,
    kindMatches: r.body.item_kind === expected.itemKind,
    genesisMatches: expected.genesis ? r.body.network_genesis_hash === expected.genesis : null,
    envelopeHashMatches,
    error,
  };
}

export class RelayFailure extends Error {
  readonly item: RelayItem;
  constructor(item: RelayItem) {
    super(`relay status ${item.status}${item.error ? `: ${item.error}` : ""}`);
    this.name = "RelayFailure";
    this.item = item;
  }
}

/** Generic poll loop: resolves with the first non-null value of `probe`. */
export async function pollUntil<T>(what: string, probe: () => Promise<T | null>, opts: WaitOpts = {}): Promise<T> {
  const w = waitParams({ intervalMs: 3000, timeoutMs: 180_000, ...opts });
  const deadline = w.now() + w.timeout;
  for (;;) {
    const v = await probe();
    if (v !== null) return v;
    if (w.now() > deadline) throw new TimeoutError(what);
    await w.sleep(w.interval, w.signal);
  }
}

/** The relay's item for an object, or null when this relay does not know it. */
export async function lookupRelay(api: Api, objectId: string): Promise<RelayItem | null> {
  try {
    const v = await api.receipts(objectId);
    return v.items[0] ?? null;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

/** Poll `/api/receipts/{id}` until the relay reports one of `until` (default INCLUDED/CONFIRMED). */
export async function waitForRelay(
  api: Api,
  objectId: string,
  opts: WaitOpts & { until?: string[]; onUpdate?: (item: RelayItem) => void } = {},
): Promise<RelayItem> {
  const until = opts.until ?? RELAY_DONE;
  return pollUntil(
    "relay inclusion",
    async () => {
      const item = await lookupRelay(api, objectId);
      if (!item) return null;
      opts.onUpdate?.(item);
      if (until.includes(item.status)) return item;
      if (RELAY_FAILED.includes(item.status)) throw new RelayFailure(item);
      return null;
    },
    { intervalMs: 3000, timeoutMs: 10 * 60_000, ...opts },
  );
}

export interface BallotLookup {
  ballot: BallotView | null;
  rejected: Diagnostic[];
  at: At | null;
}

/** The server's current view of one ballot of one owner in one poll. */
export async function lookupBallot(api: Api, pollId: string, ownerId: string, ballotId: string): Promise<BallotLookup> {
  const v = await api.ballots(pollId, ownerId);
  return {
    ballot: v.ballots.find((b) => b.ballot_id === ballotId) ?? null,
    rejected: v.rejected.filter((d) => d.id === ballotId),
    at: v.at,
  };
}

/** Wait until the indexer shows the ballot (or a rejection of it). */
export async function waitForBallot(
  api: Api,
  pollId: string,
  ownerId: string,
  ballotId: string,
  opts: WaitOpts = {},
): Promise<BallotLookup> {
  return pollUntil(
    "the ballot in the index",
    async () => {
      const r = await lookupBallot(api, pollId, ownerId, ballotId);
      return r.ballot || r.rejected.length > 0 ? r : null;
    },
    opts,
  );
}

/** Only an included ballot that is the owner's current selection counts. */
export function ballotCounts(relayStatus: string | null, lookup: BallotLookup | null): boolean {
  return !!relayStatus && RELAY_DONE.includes(relayStatus) && lookup?.ballot?.status === "SELECTED";
}

/**
 * The signed message cannot take effect any more and must be signed again (with a
 * new anchor): the relay gave up (EXPIRED/FAILED) or the indexer rejected it because
 * its anchor block left the canonical chain (ANCHOR_INVALID) or its publication
 * window passed.
 */
export function needsResign(relayStatus: string | null, rejectedCodes: string[]): boolean {
  if (relayStatus && RELAY_FAILED.includes(relayStatus)) return true;
  return rejectedCodes.some((c) => c === "ANCHOR_INVALID" || c === "PUBLICATION_EXPIRED" || c === "STALE_AUTHORIZATION");
}

export interface ControlLookup {
  outcome: string | null;
  /** The owner's current grant is this control (GRANT only). */
  isCurrent: boolean;
  rejected: Diagnostic[];
  stream: StreamView | null;
}

/** The indexer's view of one control (`/api/authorizations/{id}`), or null when unknown. */
export async function lookupControl(api: Api, ownerId: string, policyHash: string, authorizationId: string): Promise<ControlLookup | null> {
  let v: { streams?: StreamView[]; rejected?: Diagnostic[] };
  try {
    v = (await api.authorization(authorizationId)) as { streams?: StreamView[]; rejected?: Diagnostic[] };
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
  const streams = v.streams ?? [];
  const stream = streams.find((s) => s.owner_id === ownerId && s.policy_hash === policyHash) ?? streams[0] ?? null;
  return {
    outcome: controlOutcome(stream, authorizationId),
    isCurrent: stream?.current?.authorization_id === authorizationId,
    rejected: (v.rejected ?? []).filter((d) => d.id === authorizationId),
    stream,
  };
}

/** Wait until the owner's control stream shows the control (or its rejection). */
export async function waitForControl(
  api: Api,
  ownerId: string,
  policyHash: string,
  authorizationId: string,
  opts: WaitOpts = {},
): Promise<ControlLookup> {
  return pollUntil(
    "the authorization in the index",
    async () => {
      const r = await lookupControl(api, ownerId, policyHash, authorizationId);
      return r && (r.outcome !== null || r.rejected.length > 0) ? r : null;
    },
    opts,
  );
}

export interface RecordLookup {
  found: boolean;
  rejected: Diagnostic[];
}

/**
 * The indexer's view of a process record. ROLES_UPDATE records have no poll: they
 * are found once the new roles are in effect.
 */
export async function lookupRecord(
  api: Api,
  target: { pollId: string | null; recordId: string; newRolesHash?: string | null },
): Promise<RecordLookup> {
  if (target.pollId) {
    try {
      const v = await api.records(target.pollId);
      return {
        found: v.records.some((r) => r.record_id === target.recordId),
        rejected: v.rejected.filter((d) => d.id === target.recordId),
      };
    } catch (e) {
      // Not a poll: a ROLES_UPDATE record is scoped by its new roles hash.
      if (!(e instanceof ApiError && e.status === 404)) throw e;
    }
  }
  const diag = await api.diagnostics(200, "process_record");
  const net = await api.network();
  return {
    found: !!target.newRolesHash && net.current_roles?.roles_hash === target.newRolesHash,
    rejected: diag.diagnostics.filter((d) => d.id === target.recordId),
  };
}

export async function waitForRecord(
  api: Api,
  target: { pollId: string | null; recordId: string; newRolesHash?: string | null },
  opts: WaitOpts = {},
): Promise<RecordLookup> {
  return pollUntil(
    "the record in the index",
    async () => {
      const r = await lookupRecord(api, target);
      return r.found || r.rejected.length > 0 ? r : null;
    },
    opts,
  );
}

export interface PollLookup {
  registered: boolean;
  rejected: Diagnostic[];
}

export async function lookupPoll(api: Api, pollId: string): Promise<PollLookup> {
  try {
    await api.proposal(pollId);
    return { registered: true, rejected: [] };
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 404)) throw e;
  }
  const diag = await api.diagnostics(200, "manifest");
  return { registered: false, rejected: diag.diagnostics.filter((d) => d.id === pollId) };
}

/** Wait until a submitted manifest is registered as a poll (or rejected). */
export async function waitForPoll(api: Api, pollId: string, opts: WaitOpts = {}): Promise<PollLookup> {
  return pollUntil(
    "the proposal in the index",
    async () => {
      const r = await lookupPoll(api, pollId);
      return r.registered || r.rejected.length > 0 ? r : null;
    },
    opts,
  );
}

// ---------------------------------------------------------------------------
// One step: sign, verify locally, submit, check the receipt

export type Verifier = (text: string, signature: string) => VerifyResult;

export interface SignSubmitResult<E> {
  signature: string;
  verify: VerifyResult;
  envelope: E | null;
  submit: SubmitOutcome | null;
  receipt: ReceiptCheck | null;
}

export type StepName = "signing" | "verifying" | "submitting" | "checking";

export async function signVerifySubmit<E extends object>(args: {
  core: Core;
  api: Api;
  request: SignRequest;
  sign: Signer;
  verify: Verifier;
  envelope: (signature: string) => E;
  objectId: string;
  itemKind: string;
  receiptKey: string | null;
  genesis?: string | null;
  onStep?: (s: StepName) => void;
  /** Called with the signed, locally verified envelope before it is submitted. */
  onSigned?: (envelope: E) => void;
}): Promise<SignSubmitResult<E>> {
  args.onStep?.("signing");
  const signature = await args.sign(args.request);
  args.onStep?.("verifying");
  const verify = args.verify(args.request.text, signature);
  if (!verify.ok) return { signature, verify, envelope: null, submit: null, receipt: null };
  const envelope = args.envelope(signature);
  args.onSigned?.(envelope);
  args.onStep?.("submitting");
  const submit = await submitEnvelope(args.core, args.api, envelope);
  if (!submit.ok) return { signature, verify, envelope, submit, receipt: null };
  args.onStep?.("checking");
  const receipt = checkReceipt(args.core, submit.item, {
    receiptKey: args.receiptKey,
    objectId: args.objectId,
    itemKind: args.itemKind,
    envelopeJcs: submit.envelopeJcs,
    genesis: args.genesis ?? null,
  });
  return { signature, verify, envelope, submit, receipt };
}

// ---------------------------------------------------------------------------
// Authorization controls (ControlDraft::build, docs/11 §3)

export interface ControlInput {
  genesis: string;
  policyHash: string;
  ownerLock: Script;
  ownerAdapter: string;
  action: ControlAction;
  keyDescriptor: KeyDescriptor | null;
  expiresAtMs: string | null;
  revokeMode: RevokeMode | null;
  anchorHash: string;
  publicationDeadlineMs: string;
  nonce: string;
}

export function controlBody(i: ControlInput): ControlBody {
  return {
    protocol_version: PROTOCOL_VERSION,
    message_kind: "authorization_control",
    network_genesis_hash: i.genesis,
    dao_namespace: DAO_NAMESPACE,
    auth_policy_hash: i.policyHash,
    owner_lock: scriptOf(i.ownerLock),
    owner_auth_adapter: i.ownerAdapter,
    action: i.action,
    key_descriptor: i.action === "GRANT" ? i.keyDescriptor : null,
    expires_at_ms: i.action === "GRANT" ? i.expiresAtMs : null,
    revoke_mode: i.revokeMode,
    anchor_block_hash: i.anchorHash,
    publication_deadline_ms: i.publicationDeadlineMs,
    nonce: i.nonce,
    signature_format: SIG_FORMAT_AUTHORIZATION,
  };
}

/** `expires_at_ms = clock(anchor) + term` with a whole number of days in 1..365. */
export function grantExpiry(anchorClockMs: string, termDays: number): string {
  if (!Number.isInteger(termDays) || termDays < 1 || termDays > MAX_TERM_DAYS) throw new FlowError("err.term");
  return (big(anchorClockMs) + BigInt(termDays) * DAY_MS_BIG).toString();
}

export function evmKeyDescriptor(address: string): KeyDescriptor {
  const a = parseEvmAddress(address);
  if (!a) throw new FlowError("err.badEvmAddress");
  return { kind: "evm_eoa", address: a, adapter: ADAPTER_EVM };
}

export function secpKeyDescriptor(publicKey: string): KeyDescriptor {
  const k = parseCompressedPubkey(publicKey);
  if (!k) throw new FlowError("err.badPubkey");
  return { kind: "secp256k1", public_key: k, adapter: ADAPTER_CKB };
}

/** Delegate key input: an EVM address or a compressed secp256k1 public key. */
export function parseKeyInput(input: string): KeyDescriptor | null {
  if (parseEvmAddress(input)) return evmKeyDescriptor(input);
  if (parseCompressedPubkey(input)) return secpKeyDescriptor(input);
  return null;
}

export interface PreparedControl extends SignRequest {
  kind: "authorization_control";
  body: ControlBody;
  authorizationId: string;
  ownerId: string;
}

export function prepareControl(core: Core, network: NetworkParams, body: ControlBody): PreparedControl {
  const out = core.control(network, body);
  return {
    kind: "authorization_control",
    body: out.body,
    authorizationId: out.authorization_id,
    ownerId: out.owner_id,
    ...signRequest(out.text, out.summary),
  };
}

export function controlEnvelope(body: ControlBody, signature: string): ControlEnvelope {
  return { body, proof: { signature } };
}

/**
 * The control anchor must be strictly above every control of this owner known on
 * chain (`max_anchor_height`, every history entry) and above the last control
 * signed on this device (docs/11 §2, §5). Returns the exclusive floor.
 */
export function controlAnchorFloor(stream: StreamView | null, localLast: { number: string } | null): bigint | null {
  const heights: bigint[] = [];
  if (stream?.max_anchor_height) heights.push(big(stream.max_anchor_height));
  for (const h of stream?.history ?? []) heights.push(big(h.anchor_height));
  if (localLast) heights.push(big(localLast.number));
  return maxBig(heights);
}

/**
 * Fresh control stream of the owner and the exclusive anchor floor for a new control:
 * above the controls on chain, the ballots and controls queued at the relay and the
 * last control signed on this device.
 */
export async function fetchControlFloor(
  api: Api,
  ownerId: string,
  policyHash: string,
  localLast: { number: string } | null,
): Promise<{ stream: StreamView; floor: bigint | null }> {
  const stream = await api.ownerAuthorizations(ownerId, policyHash);
  const chainFloor = controlAnchorFloor(stream, localLast);
  const floor = maxBig([...(chainFloor === null ? [] : [chainFloor]), ...(await queuedAnchorHeights(api, ownerId))]);
  return { stream, floor };
}

/** Outcome of a control in the owner's stream once indexed (EFFECTIVE, STALE_AUTHORIZATION, ...). */
export function controlOutcome(stream: StreamView | null, authorizationId: string): string | null {
  return stream?.history.find((h) => h.authorization_id === authorizationId)?.outcome ?? null;
}

// ---------------------------------------------------------------------------
// Process records (RecordDraft::build, docs/03 §3.1)

export const RECORD_TYPES: RecordType[] = [
  "ADMISSION",
  "NOTICE",
  "GOVERNANCE_STATUS",
  "RESULT_ATTESTATION",
  "EXECUTION",
  "ROLES_UPDATE",
];

export const RECORD_ROLES: Record<RecordType, Role[]> = {
  ADMISSION: ["coordinator"],
  NOTICE: ["coordinator", "committee"],
  GOVERNANCE_STATUS: ["committee"],
  RESULT_ATTESTATION: ["committee"],
  EXECUTION: ["committee"],
  ROLES_UPDATE: ["committee"],
};

export interface RecordDetailInput {
  decision?: "ADMITTED" | "REJECTED";
  code?: string;
  status?: "HOLD_EXECUTION" | "CLEARED" | "VOIDED";
  resultHash?: string;
  outcome?: "PASS" | "FAIL";
  txHash?: string;
  newRolesHash?: string;
}

export function recordDetail(type: RecordType, d: RecordDetailInput): RecordDetail {
  switch (type) {
    case "ADMISSION":
      return { decision: d.decision ?? "ADMITTED" };
    case "NOTICE":
      return { code: (d.code ?? "").trim() };
    case "GOVERNANCE_STATUS":
      return { status: d.status ?? "HOLD_EXECUTION" };
    case "RESULT_ATTESTATION":
      return { result_hash: d.resultHash ?? "", outcome: d.outcome ?? "PASS" };
    case "EXECUTION":
      return { tx_hash: d.txHash ?? "" };
    case "ROLES_UPDATE":
      return { new_roles_hash: d.newRolesHash ?? "" };
  }
}

export interface RecordInput {
  genesis: string;
  rolesHash: string;
  role: Role;
  recordType: RecordType;
  pollId: string | null;
  detail: RecordDetail;
  evidenceHash: string | null;
  anchorHash: string;
  publicationDeadlineMs: string;
  nonce: string;
}

export function recordBody(i: RecordInput): ProcessRecordBody {
  return {
    message_kind: "process_record",
    protocol_version: PROTOCOL_VERSION,
    network_genesis_hash: i.genesis,
    dao_namespace: DAO_NAMESPACE,
    roles_hash: i.rolesHash,
    role: i.role,
    record_type: i.recordType,
    poll_id: i.recordType === "ROLES_UPDATE" ? null : i.pollId,
    detail: i.detail,
    evidence_hash: i.evidenceHash,
    anchor_block_hash: i.anchorHash,
    publication_deadline_ms: i.publicationDeadlineMs,
    nonce: i.nonce,
  };
}

export interface PreparedRecord extends SignRequest {
  kind: "process_record";
  body: ProcessRecordBody;
  recordId: string;
}

export function prepareRecord(core: Core, body: ProcessRecordBody): PreparedRecord {
  const out = core.record(body);
  return { kind: "process_record", body: out.body, recordId: out.record_id, ...signRequest(out.text) };
}

export interface RoleMember {
  descriptor: KeyDescriptor;
  keyId: string;
  display: string | null;
}

export function roleMembers(core: Core, roles: ProcessRoles, role: Role, network?: NetworkParams): RoleMember[] {
  return roles.roles[role].members.map((descriptor) => {
    const k = core.key(descriptor, network);
    return { descriptor, keyId: k.key_id, display: k.key_display ?? null };
  });
}

export interface MemberSignature {
  signer_key_id: string;
  signature: string;
}

/** Envelope with one proof per distinct member key (later duplicates are dropped). */
export function processEnvelope(body: ProcessRecordBody, sigs: MemberSignature[]): ProcessEnvelope {
  const seen = new Set<string>();
  const proofs: ProcessEnvelope["proofs"] = [];
  for (const s of sigs) {
    if (seen.has(s.signer_key_id)) continue;
    seen.add(s.signer_key_id);
    proofs.push({ signer_key_id: s.signer_key_id, proof: { signature: s.signature } });
  }
  return { body, proofs };
}

/** Count member signatures that verify against the exact record text. */
export function validMemberSignatures(core: Core, members: RoleMember[], text: string, sigs: MemberSignature[]): Set<string> {
  const ok = new Set<string>();
  for (const s of sigs) {
    const m = members.find((x) => x.keyId === s.signer_key_id);
    if (m && verifyKeySig(core, m.descriptor, text, s.signature).ok) ok.add(m.keyId);
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Proposals (ManifestDraft::build, docs/03 §3 and §3.1)

export interface DraftInput {
  genesis: string;
  nonce: string;
  proposalType: "grant" | "meta_rule";
  title: string;
  signingTitle: string;
  contentHash: string;
  contentLocations: string[];
  forumTopicId: string;
  forumRevision: string;
  discussionEvidenceHash: string | null;
  budgetShannon: string;
  quorumBaseShannon: string;
  paymentTermsHash: string | null;
  recipientLock: Script | null;
  proposerLocks: Script[];
  rules: RulesProfile;
  registry: AuthRegistry;
  policy: AuthPolicy;
  startMs: string;
  resultConfirmations: string;
  reviewWindowMs: string;
}

/** Exactly the fields `manifest_from_draft` expects. */
export function manifestDraft(i: DraftInput): Record<string, unknown> {
  const meta = i.proposalType === "meta_rule";
  return {
    genesis: i.genesis,
    nonce: i.nonce,
    proposal_type: i.proposalType,
    title: i.title,
    signing_title: i.signingTitle,
    content_hash: i.contentHash,
    content_locations: i.contentLocations,
    forum_topic_id: i.forumTopicId,
    forum_revision: i.forumRevision,
    discussion_evidence_hash: i.discussionEvidenceHash,
    budget_ckb_shannon: meta ? "0" : i.budgetShannon,
    quorum_base_shannon: meta ? "0" : i.quorumBaseShannon,
    payment_terms_hash: i.paymentTermsHash,
    recipient_lock_script: meta ? null : i.recipientLock ? scriptOf(i.recipientLock) : null,
    proposer_owner_locks: i.proposerLocks.map(scriptOf),
    rules_profile: i.rules,
    auth_registry: i.registry,
    authorization_policy: i.policy,
    start_ms: i.startMs,
    result_confirmations: i.resultConfirmations,
    review_window_ms: i.reviewWindowMs,
  };
}

/** Signing title rules (docs/03 §5 rule 2); returns an i18n error key or null. */
export function signingTitleProblem(t: string): string | null {
  const n = [...t].length;
  if (n < 1 || n > 80) return "err.signingTitleLength";
  if (/^\s|\s$/u.test(t)) return "err.signingTitleSpace";
  for (const ch of t) {
    const u = ch.codePointAt(0) ?? 0;
    const forbidden =
      u <= 0x1f ||
      (u >= 0x7f && u <= 0x9f) ||
      u === 0x2028 ||
      u === 0x2029 ||
      u === 0x061c ||
      u === 0x200e ||
      u === 0x200f ||
      (u >= 0x202a && u <= 0x202e) ||
      (u >= 0x2066 && u <= 0x2069);
    if (forbidden) return "err.signingTitleChar";
  }
  return null;
}

export interface ProposerSignature {
  owner_lock: Script;
  auth_adapter: string;
  signature: string;
}

/**
 * `{"protocol_version":"2","manifest":…,"proposer_proofs":[…]}` with exactly one proof
 * per proposer lock, in the manifest's `proposer_owner_locks` order (sorted by owner_id).
 */
export function manifestPayload(manifest: Manifest, sigs: ProposerSignature[]): ManifestPayload {
  const proofs = manifest.proposer_owner_locks.map((lock) => {
    const s = sigs.find((x) => sameScript(x.owner_lock, lock));
    if (!s) throw new FlowError("err.missingProposerSignature", { args: lock.args });
    return { owner_lock: scriptOf(lock), auth_adapter: s.auth_adapter, proof: { signature: s.signature } };
  });
  return { protocol_version: PROTOCOL_VERSION, manifest, proposer_proofs: proofs };
}

/** Average block interval between two indexed points (ms), or null when unknown. */
export function blockIntervalMs(a: { number: string; clock_ms: string } | null, b: { number: string; clock_ms: string } | null): number | null {
  if (!a || !b) return null;
  const dn = Number(big(b.number) - big(a.number));
  const dt = Number(big(b.clock_ms) - big(a.clock_ms));
  if (dn <= 0 || dt <= 0) return null;
  return dt / dn;
}

export interface OpeningCheck {
  requiredBlocks: number;
  requiredMs: number;
  availableMs: number;
  ok: boolean;
}

/**
 * The manifest and the admission record must be included at least
 * `opening_confirmations` blocks before the first block whose clock reaches start
 * (docs/03 §3). Estimate whether `start_ms` leaves enough room, with a safety margin
 * for the relay and the coordinator's admission record.
 */
export function openingCheck(args: {
  startMs: string;
  chainClockMs: string;
  openingConfirmations: string;
  blockIntervalMs: number;
  marginBlocks?: number;
}): OpeningCheck {
  const requiredBlocks = Number(big(args.openingConfirmations)) + (args.marginBlocks ?? 20);
  const requiredMs = Math.ceil(requiredBlocks * args.blockIntervalMs);
  const availableMs = Number(big(args.startMs) - big(args.chainClockMs));
  return { requiredBlocks, requiredMs, availableMs, ok: availableMs >= requiredMs };
}
