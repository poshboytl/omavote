/**
 * Strict schemas for the V2 protocol objects (docs/03 §3–§5, docs/11 §2–§4,
 * docs/13 §4). Every object must have exactly the listed keys; integers are
 * canonical decimal strings within u64; hashes are 32-byte lowercase hex.
 *
 * Parsers throw SchemaError with a diagnostic code:
 *   MALFORMED, WRONG_NETWORK, HASH_MISMATCH, UNSUPPORTED_RULES, UNKNOWN_ADAPTER.
 */
import {
  ADAPTER_CKB,
  ADAPTER_EVM,
  ADAPTER_WEBAUTHN,
  KEY_ADAPTER_IDS,
  OWNER_ADAPTER_IDS,
  isValidCompressedPoint,
} from "./adapter.js";
import { hexToBytes, isHash32, isLowerHex } from "./bytes.js";
import { SchemaError } from "./errors.js";
import { DOMAIN, objectHash } from "./hash.js";
import { compareUtf16, isObject, type JsonObject, type JsonValue } from "./json.js";
import { parseScript, scriptHash, type ScriptJson } from "./molecule.js";
import type { Network } from "./network.js";

export const PROTOCOL_VERSION = "2";
export const DAO_NAMESPACE = "ckb-community-fund-dao";
export const CLOCK_ID = "ckb-parent-mtp-v1";
export const BALLOT_FORMAT_READABLE = "omavote-readable-v2";
export const BALLOT_FORMAT_WEBAUTHN = "omavote-webauthn-v2";
export const KNOWN_BALLOT_FORMATS: readonly string[] = [BALLOT_FORMAT_READABLE, BALLOT_FORMAT_WEBAUTHN];
export const AUTHORIZATION_FORMAT = "omavote-authorization-v2";
export const AUTH_SEMANTICS = "omavote-authorization-semantics-v2";
export const PUBLICATION_POLICY = "full-onchain-v2";

/** docs/11 §2 protocol constants (also fields of auth_policy). */
export const MAX_TERM_MS = 365n * 24n * 60n * 60n * 1000n;
export const MAX_CONTROL_PUBLICATION_DELAY_MS = 24n * 60n * 60n * 1000n;

/** Largest millisecond value renderable as a 4-digit-year UTC timestamp (9999-12-31T23:59:59.999Z). */
export const MAX_RENDERABLE_MS = 253402300799999n;

const U64_MAX = (1n << 64n) - 1n;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

// ---------------------------------------------------------------------------
// primitive helpers

export function expectObject(v: JsonValue | undefined, path: string, keys: readonly string[], optional: readonly string[] = []): JsonObject {
  if (!isObject(v)) throw new SchemaError(`${path} must be an object`);
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(v, k)) throw new SchemaError(`${path}.${k} is missing`);
  }
  for (const k of Object.keys(v)) {
    if (!keys.includes(k) && !optional.includes(k)) throw new SchemaError(`${path} has unknown field ${JSON.stringify(k)}`);
  }
  return v;
}

export function expectString(v: JsonValue | undefined, path: string): string {
  if (typeof v !== "string") throw new SchemaError(`${path} must be a string`);
  return v;
}

export function expectFixed(v: JsonValue | undefined, value: string, path: string, code = "MALFORMED"): void {
  if (v !== value) throw new SchemaError(`${path} must be ${JSON.stringify(value)}`, code);
}

export function expectEnum<T extends string>(v: JsonValue | undefined, values: readonly T[], path: string, code = "MALFORMED"): T {
  if (typeof v !== "string" || !values.includes(v as T)) {
    throw new SchemaError(`${path} must be one of ${values.join("|")}`, code);
  }
  return v as T;
}

export function expectHash(v: JsonValue | undefined, path: string): string {
  if (!isHash32(v)) throw new SchemaError(`${path} must be 32-byte lowercase hex`);
  return v;
}

export function expectNullableHash(v: JsonValue | undefined, path: string): string | null {
  if (v === null) return null;
  return expectHash(v, path);
}

/** Canonical decimal integer string within u64 (docs/03 §2). */
export function parseDecimal(v: JsonValue | undefined, path: string): bigint {
  if (typeof v !== "string" || v.length > 20 || !DECIMAL.test(v)) {
    throw new SchemaError(`${path} must be a canonical decimal integer string`);
  }
  const n = BigInt(v);
  if (n > U64_MAX) throw new SchemaError(`${path} exceeds u64`);
  return n;
}

function expectArray(v: JsonValue | undefined, path: string): JsonValue[] {
  if (!Array.isArray(v)) throw new SchemaError(`${path} must be an array`);
  return v;
}

function expectStrictlySorted(values: string[], path: string): void {
  for (let i = 1; i < values.length; i++) {
    if (compareUtf16(values[i - 1] as string, values[i] as string) >= 0) {
      throw new SchemaError(`${path} must be sorted and free of duplicates`);
    }
  }
}

function checkNetwork(obj: JsonObject, network: Network, path: string): void {
  if (obj["network_genesis_hash"] !== network.genesis_hash) {
    throw new SchemaError(`${path}.network_genesis_hash does not match this network`, "WRONG_NETWORK");
  }
  if (obj["dao_namespace"] !== DAO_NAMESPACE) {
    throw new SchemaError(`${path}.dao_namespace must be ${DAO_NAMESPACE}`, "WRONG_NETWORK");
  }
}

// ---------------------------------------------------------------------------
// signing title (docs/03 §5 rule 2)

const WHITE_SPACE = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
  0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

function forbiddenTitleChar(cp: number): boolean {
  return (
    cp <= 0x1f ||
    (cp >= 0x7f && cp <= 0x9f) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    cp === 0x061c ||
    cp === 0x200e ||
    cp === 0x200f ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069)
  );
}

export function validateSigningTitle(title: string, path = "signing_title"): void {
  const cps = Array.from(title, (ch) => ch.codePointAt(0) as number);
  if (cps.length < 1 || cps.length > 80) throw new SchemaError(`${path} must have 1–80 Unicode scalar values`);
  for (const cp of cps) {
    if (forbiddenTitleChar(cp)) throw new SchemaError(`${path} contains forbidden character U+${cp.toString(16).toUpperCase().padStart(4, "0")}`);
  }
  if (WHITE_SPACE.has(cps[0] as number) || WHITE_SPACE.has(cps[cps.length - 1] as number)) {
    throw new SchemaError(`${path} must not have leading or trailing whitespace`);
  }
}

// ---------------------------------------------------------------------------
// rules_profile (docs/03 §4, docs/13 §4.2)

export interface Fraction {
  numerator: bigint;
  denominator: bigint;
}

export interface RulesProfile {
  quorumGrantMultiplier: bigint;
  quorumMetaRuleShannon: bigint;
  approvalGrant: Fraction;
  approvalMetaRule: Fraction;
  thresholdComparison: "inclusive" | "strict";
  openingConfirmations: bigint;
  delegateCutoffMs: bigint;
  votingPeriodMs: bigint;
  proposerMinDepositShannon: bigint;
}

/**
 * Enumerated first-release values. The docs (03 §4, 13 §4.2) describe them in
 * prose only; the exact tokens were taken from vectors/messages.json.
 */
export const RULES_FIXED_TOKENS: Readonly<Record<string, string>> = {
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
};

const RULES_KEYS = [
  ...Object.keys(RULES_FIXED_TOKENS),
  "choices",
  "quorum_grant_multiplier",
  "quorum_meta_rule_shannon",
  "approval_grant",
  "approval_meta_rule",
  "threshold_comparison",
  "opening_confirmations",
  "delegate_cutoff_ms",
  "voting_period_ms",
  "proposer_min_deposit_shannon",
];

function parseFraction(v: JsonValue | undefined, path: string): Fraction {
  const o = expectObject(v, path, ["numerator", "denominator"]);
  const numerator = parseDecimal(o["numerator"], `${path}.numerator`);
  const denominator = parseDecimal(o["denominator"], `${path}.denominator`);
  if (denominator === 0n || numerator > denominator) {
    throw new SchemaError(`${path} must satisfy 0 <= numerator <= denominator, denominator > 0`, "UNSUPPORTED_RULES");
  }
  return { numerator, denominator };
}

export function parseRulesProfile(v: JsonValue | undefined, path = "rules_profile"): RulesProfile {
  // proposer_min_deposit_shannon: docs/13 §4 item 10 (supplementary key).
  const o = expectObject(v, path, RULES_KEYS);
  for (const [k, token] of Object.entries(RULES_FIXED_TOKENS)) {
    expectFixed(o[k], token, `${path}.${k}`, "UNSUPPORTED_RULES");
  }
  const choices = expectArray(o["choices"], `${path}.choices`);
  if (choices.length !== 3 || choices[0] !== "YES" || choices[1] !== "NO" || choices[2] !== "CANCEL") {
    throw new SchemaError(`${path}.choices must be ["YES","NO","CANCEL"]`, "UNSUPPORTED_RULES");
  }
  const votingPeriodMs = parseDecimal(o["voting_period_ms"], `${path}.voting_period_ms`);
  if (votingPeriodMs === 0n) throw new SchemaError(`${path}.voting_period_ms must be positive`, "UNSUPPORTED_RULES");
  const delegateCutoffMs = parseDecimal(o["delegate_cutoff_ms"], `${path}.delegate_cutoff_ms`);
  if (delegateCutoffMs > votingPeriodMs) {
    throw new SchemaError(`${path}.delegate_cutoff_ms exceeds the voting period`, "UNSUPPORTED_RULES");
  }
  return {
    quorumGrantMultiplier: parseDecimal(o["quorum_grant_multiplier"], `${path}.quorum_grant_multiplier`),
    quorumMetaRuleShannon: parseDecimal(o["quorum_meta_rule_shannon"], `${path}.quorum_meta_rule_shannon`),
    approvalGrant: parseFraction(o["approval_grant"], `${path}.approval_grant`),
    approvalMetaRule: parseFraction(o["approval_meta_rule"], `${path}.approval_meta_rule`),
    thresholdComparison: expectEnum(o["threshold_comparison"], ["inclusive", "strict"] as const, `${path}.threshold_comparison`, "UNSUPPORTED_RULES"),
    openingConfirmations: parseDecimal(o["opening_confirmations"], `${path}.opening_confirmations`),
    delegateCutoffMs,
    votingPeriodMs,
    proposerMinDepositShannon: parseDecimal(o["proposer_min_deposit_shannon"], `${path}.proposer_min_deposit_shannon`),
  };
}

// ---------------------------------------------------------------------------
// auth_registry (docs/03 §3, §5.1, docs/13 §4.4)

export interface AuthRegistry {
  owner_adapters: string[];
  key_adapters: string[];
}

export function parseAuthRegistry(v: JsonValue | undefined, path = "auth_registry"): AuthRegistry {
  const o = expectObject(v, path, ["owner_adapters", "key_adapters"]);
  const lists: Record<string, string[]> = {};
  for (const [field, allowed] of [
    ["owner_adapters", OWNER_ADAPTER_IDS],
    ["key_adapters", KEY_ADAPTER_IDS],
  ] as const) {
    const arr = expectArray(o[field], `${path}.${field}`).map((x, i) => expectString(x, `${path}.${field}[${i}]`));
    expectStrictlySorted(arr, `${path}.${field}`);
    for (const id of arr) {
      if (!allowed.includes(id)) throw new SchemaError(`${path}.${field} lists undefined adapter ${JSON.stringify(id)}`, "UNKNOWN_ADAPTER");
    }
    lists[field] = arr;
  }
  return { owner_adapters: lists["owner_adapters"] as string[], key_adapters: lists["key_adapters"] as string[] };
}

// ---------------------------------------------------------------------------
// auth_policy (docs/11 §2, docs/13 §4.3)

export interface AuthPolicy {
  raw: JsonObject;
  hash: string;
  maxTermMs: bigint;
  maxControlPublicationDelayMs: bigint;
}

const POLICY_KEYS = [
  "message_kind",
  "protocol_version",
  "network_genesis_hash",
  "dao_namespace",
  "clock",
  "max_term_ms",
  "max_control_publication_delay_ms",
  "semantics",
];

export function parseAuthPolicy(v: JsonValue | undefined, network: Network, path = "authorization_policy"): AuthPolicy {
  const o = expectObject(v, path, POLICY_KEYS);
  expectFixed(o["message_kind"], "authorization_policy", `${path}.message_kind`);
  expectFixed(o["protocol_version"], PROTOCOL_VERSION, `${path}.protocol_version`);
  expectHash(o["network_genesis_hash"], `${path}.network_genesis_hash`);
  expectString(o["dao_namespace"], `${path}.dao_namespace`);
  expectFixed(o["clock"], CLOCK_ID, `${path}.clock`);
  const maxTermMs = parseDecimal(o["max_term_ms"], `${path}.max_term_ms`);
  const maxDelay = parseDecimal(o["max_control_publication_delay_ms"], `${path}.max_control_publication_delay_ms`);
  expectFixed(o["semantics"], AUTH_SEMANTICS, `${path}.semantics`);
  if (maxTermMs !== MAX_TERM_MS) throw new SchemaError(`${path}.max_term_ms must be ${MAX_TERM_MS}`, "UNSUPPORTED_RULES");
  if (maxDelay !== MAX_CONTROL_PUBLICATION_DELAY_MS) {
    throw new SchemaError(`${path}.max_control_publication_delay_ms must be ${MAX_CONTROL_PUBLICATION_DELAY_MS}`, "UNSUPPORTED_RULES");
  }
  checkNetwork(o, network, path);
  return { raw: o, hash: objectHash(DOMAIN.AUTH_POLICY, o), maxTermMs, maxControlPublicationDelayMs: maxDelay };
}

// ---------------------------------------------------------------------------
// key descriptors (docs/11 §4.1)

export interface KeyDescriptor {
  raw: JsonObject;
  keyId: string;
  kind: "secp256k1" | "evm_eoa" | "webauthn_es256";
  adapter: string;
  publicKey?: Uint8Array;
  address?: string;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function parseKeyDescriptor(v: JsonValue | undefined, path = "key_descriptor"): KeyDescriptor {
  if (!isObject(v)) throw new SchemaError(`${path} must be an object`);
  const kind = expectEnum(v["kind"], ["secp256k1", "evm_eoa", "webauthn_es256"] as const, `${path}.kind`);
  if (kind === "secp256k1") {
    const o = expectObject(v, path, ["kind", "public_key", "adapter"]);
    expectFixed(o["adapter"], ADAPTER_CKB, `${path}.adapter`);
    const pk = o["public_key"];
    if (!isLowerHex(pk, 33)) throw new SchemaError(`${path}.public_key must be a 33-byte lowercase hex compressed point`);
    const publicKey = hexToBytes(pk);
    if (!isValidCompressedPoint(publicKey)) throw new SchemaError(`${path}.public_key is not a valid compressed secp256k1 point`);
    return { raw: o, keyId: objectHash(DOMAIN.KEY, o), kind, adapter: ADAPTER_CKB, publicKey };
  }
  if (kind === "evm_eoa") {
    const o = expectObject(v, path, ["kind", "address", "adapter"]);
    expectFixed(o["adapter"], ADAPTER_EVM, `${path}.adapter`);
    const address = o["address"];
    if (!isLowerHex(address, 20)) throw new SchemaError(`${path}.address must be 20-byte lowercase hex`);
    return { raw: o, keyId: objectHash(DOMAIN.KEY, o), kind, adapter: ADAPTER_EVM, address };
  }
  // webauthn_es256: structural validation only; COSE/CBOR decoding is not implemented (independent PoC).
  const o = expectObject(v, path, ["kind", "cose_key", "credential_id", "rp_id", "allowed_origins", "adapter"]);
  expectFixed(o["adapter"], ADAPTER_WEBAUTHN, `${path}.adapter`);
  for (const f of ["cose_key", "credential_id"]) {
    const s = expectString(o[f], `${path}.${f}`);
    if (!BASE64URL.test(s)) throw new SchemaError(`${path}.${f} must be unpadded base64url`);
  }
  if (expectString(o["rp_id"], `${path}.rp_id`).length === 0) throw new SchemaError(`${path}.rp_id must not be empty`);
  const origins = expectArray(o["allowed_origins"], `${path}.allowed_origins`).map((x, i) => expectString(x, `${path}.allowed_origins[${i}]`));
  if (origins.length === 0 || origins.some((s) => !s.startsWith("https://"))) {
    throw new SchemaError(`${path}.allowed_origins must be a non-empty list of https origins`);
  }
  expectStrictlySorted(origins, `${path}.allowed_origins`);
  return { raw: o, keyId: objectHash(DOMAIN.KEY, o), kind, adapter: ADAPTER_WEBAUTHN };
}

// ---------------------------------------------------------------------------
// manifest (docs/03 §3, §3.1, docs/13 §4.1)

export interface Manifest {
  raw: JsonObject;
  pollId: string;
  proposalType: "grant" | "meta_rule";
  signingTitle: string;
  budgetShannon: bigint;
  quorumBaseShannon: bigint;
  recipient: ScriptJson | null;
  proposers: ScriptJson[];
  proposerIds: string[];
  rules: RulesProfile;
  rulesHash: string;
  registry: AuthRegistry;
  registryHash: string;
  policy: AuthPolicy;
  policyHash: string;
  signatureFormats: string[];
  startMs: bigint;
  endMs: bigint;
  daoNamespace: string;
  genesisHash: string;
}

const MANIFEST_KEYS = [
  "message_kind",
  "protocol_version",
  "network_genesis_hash",
  "dao_namespace",
  "nonce",
  "proposal_type",
  "title",
  "signing_title",
  "content_hash",
  "content_locations",
  "forum_topic_id",
  "forum_revision",
  "discussion_evidence_hash",
  "budget_ckb_shannon",
  "quorum_base_shannon",
  "payment_terms_hash",
  "recipient_lock_script",
  "proposer_owner_locks",
  "rules_profile",
  "rules_hash",
  "auth_registry",
  "auth_registry_hash",
  "authorization_policy",
  "auth_policy_hash",
  "signature_formats",
  "clock",
  "start_ms",
  "end_ms",
  "confirmation_policy",
  "publication_policy",
];

export function parseManifest(v: JsonValue | undefined, network: Network, path = "manifest"): Manifest {
  const o = expectObject(v, path, MANIFEST_KEYS);
  expectFixed(o["message_kind"], "manifest", `${path}.message_kind`);
  expectFixed(o["protocol_version"], PROTOCOL_VERSION, `${path}.protocol_version`);
  expectHash(o["network_genesis_hash"], `${path}.network_genesis_hash`);
  expectString(o["dao_namespace"], `${path}.dao_namespace`);
  expectHash(o["nonce"], `${path}.nonce`);
  const proposalType = expectEnum(o["proposal_type"], ["grant", "meta_rule"] as const, `${path}.proposal_type`);
  if (expectString(o["title"], `${path}.title`).length === 0) throw new SchemaError(`${path}.title must not be empty`);
  const signingTitle = expectString(o["signing_title"], `${path}.signing_title`);
  validateSigningTitle(signingTitle, `${path}.signing_title`);
  expectHash(o["content_hash"], `${path}.content_hash`);
  expectArray(o["content_locations"], `${path}.content_locations`).forEach((x, i) => {
    if (expectString(x, `${path}.content_locations[${i}]`).length === 0) {
      throw new SchemaError(`${path}.content_locations[${i}] must not be empty`);
    }
  });
  parseDecimal(o["forum_topic_id"], `${path}.forum_topic_id`);
  parseDecimal(o["forum_revision"], `${path}.forum_revision`);
  expectNullableHash(o["discussion_evidence_hash"], `${path}.discussion_evidence_hash`);
  const budgetShannon = parseDecimal(o["budget_ckb_shannon"], `${path}.budget_ckb_shannon`);
  const quorumBaseShannon = parseDecimal(o["quorum_base_shannon"], `${path}.quorum_base_shannon`);
  expectNullableHash(o["payment_terms_hash"], `${path}.payment_terms_hash`);
  const recipient = o["recipient_lock_script"] === null ? null : parseScript(o["recipient_lock_script"], `${path}.recipient_lock_script`);
  const proposers = expectArray(o["proposer_owner_locks"], `${path}.proposer_owner_locks`).map((x, i) =>
    parseScript(x, `${path}.proposer_owner_locks[${i}]`),
  );
  if (proposers.length === 0) throw new SchemaError(`${path}.proposer_owner_locks must not be empty`);
  const proposerIds = proposers.map(scriptHash);
  expectStrictlySorted(proposerIds, `${path}.proposer_owner_locks (by owner_id)`);

  const rules = parseRulesProfile(o["rules_profile"], `${path}.rules_profile`);
  const rulesHash = expectHash(o["rules_hash"], `${path}.rules_hash`);
  if (objectHash(DOMAIN.RULES, o["rules_profile"] as JsonValue) !== rulesHash) {
    throw new SchemaError(`${path}.rules_hash does not match rules_profile`, "HASH_MISMATCH");
  }
  const registry = parseAuthRegistry(o["auth_registry"], `${path}.auth_registry`);
  const registryHash = expectHash(o["auth_registry_hash"], `${path}.auth_registry_hash`);
  if (objectHash(DOMAIN.AUTH_REGISTRY, o["auth_registry"] as JsonValue) !== registryHash) {
    throw new SchemaError(`${path}.auth_registry_hash does not match auth_registry`, "HASH_MISMATCH");
  }
  const policy = parseAuthPolicy(o["authorization_policy"], network, `${path}.authorization_policy`);
  const policyHash = expectHash(o["auth_policy_hash"], `${path}.auth_policy_hash`);
  if (policy.hash !== policyHash) throw new SchemaError(`${path}.auth_policy_hash does not match authorization_policy`, "HASH_MISMATCH");

  const formats = expectArray(o["signature_formats"], `${path}.signature_formats`).map((x, i) => expectString(x, `${path}.signature_formats[${i}]`));
  if (formats.length === 0 || new Set(formats).size !== formats.length) {
    throw new SchemaError(`${path}.signature_formats must be a non-empty list without duplicates`);
  }
  for (const f of formats) {
    if (!KNOWN_BALLOT_FORMATS.includes(f)) throw new SchemaError(`${path}.signature_formats lists unknown format ${JSON.stringify(f)}`);
  }
  expectFixed(o["clock"], CLOCK_ID, `${path}.clock`);
  const startMs = parseDecimal(o["start_ms"], `${path}.start_ms`);
  const endMs = parseDecimal(o["end_ms"], `${path}.end_ms`);
  if (startMs >= endMs) throw new SchemaError(`${path}: start_ms must be < end_ms`);
  if (endMs - startMs !== rules.votingPeriodMs) throw new SchemaError(`${path}: end_ms - start_ms must equal rules_profile.voting_period_ms`);
  if (endMs > MAX_RENDERABLE_MS) throw new SchemaError(`${path}.end_ms is not renderable as a 4-digit-year UTC time`);
  const cp = expectObject(o["confirmation_policy"], `${path}.confirmation_policy`, ["result_confirmations", "review_window_ms"]);
  parseDecimal(cp["result_confirmations"], `${path}.confirmation_policy.result_confirmations`);
  parseDecimal(cp["review_window_ms"], `${path}.confirmation_policy.review_window_ms`);
  expectFixed(o["publication_policy"], PUBLICATION_POLICY, `${path}.publication_policy`);

  if (proposalType === "meta_rule") {
    if (budgetShannon !== 0n || quorumBaseShannon !== 0n || recipient !== null) {
      throw new SchemaError(`${path}: meta_rule proposals require budget "0", quorum base "0" and a null recipient`);
    }
  } else if (recipient === null) {
    throw new SchemaError(`${path}: grant proposals require recipient_lock_script`);
  }
  checkNetwork(o, network, path);
  return {
    raw: o,
    pollId: objectHash(DOMAIN.POLL, o),
    proposalType,
    signingTitle,
    budgetShannon,
    quorumBaseShannon,
    recipient,
    proposers,
    proposerIds,
    rules,
    rulesHash,
    registry,
    registryHash,
    policy,
    policyHash,
    signatureFormats: formats,
    startMs,
    endMs,
    daoNamespace: o["dao_namespace"] as string,
    genesisHash: o["network_genesis_hash"] as string,
  };
}

// ---------------------------------------------------------------------------
// ballot body (docs/03 §5, docs/11 §6)

export type BallotAction = "YES" | "NO" | "CANCEL";

export interface BallotBody {
  raw: JsonObject;
  ballotId: string;
  action: BallotAction;
  authority: "owner" | "delegate";
  authorizationId: string | null;
  signerKeyId: string | null;
  anchor: string;
  authAdapter: string;
  ownerLock: ScriptJson;
  ownerId: string;
  pollId: string;
  rulesHash: string;
  signatureFormat: string;
}

const BALLOT_KEYS = [
  "message_kind",
  "protocol_version",
  "action",
  "authority",
  "authorization_id",
  "signer_key_id",
  "nonce",
  "anchor_block_hash",
  "auth_adapter",
  "dao_namespace",
  "network_genesis_hash",
  "owner_lock",
  "poll_id",
  "rules_hash",
  "signature_format",
];

export function parseBallotBody(v: JsonValue | undefined, network: Network, path = "ballot"): BallotBody {
  const o = expectObject(v, path, BALLOT_KEYS);
  expectFixed(o["message_kind"], "ballot", `${path}.message_kind`);
  expectFixed(o["protocol_version"], PROTOCOL_VERSION, `${path}.protocol_version`);
  const action = expectEnum(o["action"], ["YES", "NO", "CANCEL"] as const, `${path}.action`);
  const authority = expectEnum(o["authority"], ["owner", "delegate"] as const, `${path}.authority`);
  let authorizationId: string | null;
  let signerKeyId: string | null;
  if (authority === "owner") {
    if (o["authorization_id"] !== null || o["signer_key_id"] !== null) {
      throw new SchemaError(`${path}: direct ballots require authorization_id and signer_key_id to be null`);
    }
    authorizationId = null;
    signerKeyId = null;
  } else {
    authorizationId = expectHash(o["authorization_id"], `${path}.authorization_id`);
    signerKeyId = expectHash(o["signer_key_id"], `${path}.signer_key_id`);
  }
  expectHash(o["nonce"], `${path}.nonce`);
  const anchor = expectHash(o["anchor_block_hash"], `${path}.anchor_block_hash`);
  const authAdapter = expectString(o["auth_adapter"], `${path}.auth_adapter`);
  expectString(o["dao_namespace"], `${path}.dao_namespace`);
  expectHash(o["network_genesis_hash"], `${path}.network_genesis_hash`);
  const ownerLock = parseScript(o["owner_lock"], `${path}.owner_lock`);
  const pollId = expectHash(o["poll_id"], `${path}.poll_id`);
  const rulesHash = expectHash(o["rules_hash"], `${path}.rules_hash`);
  const signatureFormat = expectString(o["signature_format"], `${path}.signature_format`);
  checkNetwork(o, network, path);
  return {
    raw: o,
    ballotId: objectHash(DOMAIN.BALLOT, o),
    action,
    authority,
    authorizationId,
    signerKeyId,
    anchor,
    authAdapter,
    ownerLock,
    ownerId: scriptHash(ownerLock),
    pollId,
    rulesHash,
    signatureFormat,
  };
}

// ---------------------------------------------------------------------------
// authorization control body (docs/11 §3)

export type RevokeMode = "STOP_ONLY" | "STOP_AND_CANCEL_OPEN";

export interface ControlBody {
  raw: JsonObject;
  authorizationId: string;
  policyHash: string;
  ownerLock: ScriptJson;
  ownerId: string;
  ownerAuthAdapter: string;
  action: "GRANT" | "REVOKE";
  keyDescriptor: KeyDescriptor | null;
  expiresAtMs: bigint | null;
  revokeMode: RevokeMode | null;
  anchor: string;
  deadlineMs: bigint;
}

const CONTROL_KEYS = [
  "protocol_version",
  "message_kind",
  "network_genesis_hash",
  "dao_namespace",
  "auth_policy_hash",
  "owner_lock",
  "owner_auth_adapter",
  "action",
  "key_descriptor",
  "expires_at_ms",
  "revoke_mode",
  "anchor_block_hash",
  "publication_deadline_ms",
  "nonce",
  "signature_format",
];

export function parseControlBody(v: JsonValue | undefined, network: Network, path = "authorization_control"): ControlBody {
  const o = expectObject(v, path, CONTROL_KEYS);
  expectFixed(o["protocol_version"], PROTOCOL_VERSION, `${path}.protocol_version`);
  expectFixed(o["message_kind"], "authorization_control", `${path}.message_kind`);
  expectHash(o["network_genesis_hash"], `${path}.network_genesis_hash`);
  expectString(o["dao_namespace"], `${path}.dao_namespace`);
  const policyHash = expectHash(o["auth_policy_hash"], `${path}.auth_policy_hash`);
  const ownerLock = parseScript(o["owner_lock"], `${path}.owner_lock`);
  const ownerAuthAdapter = expectString(o["owner_auth_adapter"], `${path}.owner_auth_adapter`);
  const action = expectEnum(o["action"], ["GRANT", "REVOKE"] as const, `${path}.action`);
  let keyDescriptor: KeyDescriptor | null = null;
  let expiresAtMs: bigint | null = null;
  let revokeMode: RevokeMode | null;
  if (action === "GRANT") {
    keyDescriptor = parseKeyDescriptor(o["key_descriptor"], `${path}.key_descriptor`);
    expiresAtMs = parseDecimal(o["expires_at_ms"], `${path}.expires_at_ms`);
    if (expiresAtMs > MAX_RENDERABLE_MS) throw new SchemaError(`${path}.expires_at_ms is not renderable`);
    if (o["revoke_mode"] === null) revokeMode = null;
    else revokeMode = expectEnum(o["revoke_mode"], ["STOP_AND_CANCEL_OPEN"] as const, `${path}.revoke_mode`);
  } else {
    if (o["key_descriptor"] !== null || o["expires_at_ms"] !== null) {
      throw new SchemaError(`${path}: REVOKE requires key_descriptor and expires_at_ms to be null`);
    }
    revokeMode = expectEnum(o["revoke_mode"], ["STOP_ONLY", "STOP_AND_CANCEL_OPEN"] as const, `${path}.revoke_mode`);
  }
  const anchor = expectHash(o["anchor_block_hash"], `${path}.anchor_block_hash`);
  const deadlineMs = parseDecimal(o["publication_deadline_ms"], `${path}.publication_deadline_ms`);
  if (deadlineMs > MAX_RENDERABLE_MS) throw new SchemaError(`${path}.publication_deadline_ms is not renderable`);
  expectHash(o["nonce"], `${path}.nonce`);
  expectFixed(o["signature_format"], AUTHORIZATION_FORMAT, `${path}.signature_format`);
  checkNetwork(o, network, path);
  return {
    raw: o,
    authorizationId: objectHash(DOMAIN.AUTHORIZATION, o),
    policyHash,
    ownerLock,
    ownerId: scriptHash(ownerLock),
    ownerAuthAdapter,
    action,
    keyDescriptor,
    expiresAtMs,
    revokeMode,
    anchor,
    deadlineMs,
  };
}

// ---------------------------------------------------------------------------
// process roles (docs/03 §3.1)

export interface RoleConfig {
  threshold: number;
  members: KeyDescriptor[];
}

export interface ProcessRoles {
  raw: JsonObject;
  rolesHash: string;
  previousRolesHash: string | null;
  committee: RoleConfig;
  coordinator: RoleConfig;
}

function parseRoleConfig(v: JsonValue | undefined, path: string): RoleConfig {
  const o = expectObject(v, path, ["threshold", "members"]);
  const members = expectArray(o["members"], `${path}.members`).map((m, i) => parseKeyDescriptor(m, `${path}.members[${i}]`));
  if (members.length === 0) throw new SchemaError(`${path}.members must not be empty`);
  expectStrictlySorted(
    members.map((m) => m.keyId),
    `${path}.members (by key_id)`,
  );
  const threshold = parseDecimal(o["threshold"], `${path}.threshold`);
  if (threshold < 1n || threshold > BigInt(members.length)) {
    throw new SchemaError(`${path}.threshold must satisfy 1 <= threshold <= member count`);
  }
  return { threshold: Number(threshold), members };
}

export function parseProcessRoles(v: JsonValue | undefined, network: Network, path = "process_roles"): ProcessRoles {
  const o = expectObject(v, path, ["message_kind", "protocol_version", "network_genesis_hash", "dao_namespace", "previous_roles_hash", "roles", "nonce"]);
  expectFixed(o["message_kind"], "process_roles", `${path}.message_kind`);
  expectFixed(o["protocol_version"], PROTOCOL_VERSION, `${path}.protocol_version`);
  expectHash(o["network_genesis_hash"], `${path}.network_genesis_hash`);
  expectString(o["dao_namespace"], `${path}.dao_namespace`);
  const previousRolesHash = expectNullableHash(o["previous_roles_hash"], `${path}.previous_roles_hash`);
  const roles = expectObject(o["roles"], `${path}.roles`, ["committee", "coordinator"]);
  const committee = parseRoleConfig(roles["committee"], `${path}.roles.committee`);
  const coordinator = parseRoleConfig(roles["coordinator"], `${path}.roles.coordinator`);
  expectHash(o["nonce"], `${path}.nonce`);
  checkNetwork(o, network, path);
  return { raw: o, rolesHash: objectHash(DOMAIN.ROLES, o), previousRolesHash, committee, coordinator };
}

// ---------------------------------------------------------------------------
// process records (docs/03 §3.1)

export type RecordType = "ADMISSION" | "NOTICE" | "GOVERNANCE_STATUS" | "RESULT_ATTESTATION" | "EXECUTION" | "ROLES_UPDATE";
export const RECORD_TYPES: readonly RecordType[] = ["ADMISSION", "NOTICE", "GOVERNANCE_STATUS", "RESULT_ATTESTATION", "EXECUTION", "ROLES_UPDATE"];

/** Which role may sign each record type (docs/03 §3.1 table). */
export const RECORD_ROLES: Readonly<Record<RecordType, readonly string[]>> = {
  ADMISSION: ["coordinator"],
  NOTICE: ["coordinator", "committee"],
  GOVERNANCE_STATUS: ["committee"],
  RESULT_ATTESTATION: ["committee"],
  EXECUTION: ["committee"],
  ROLES_UPDATE: ["committee"],
};

export interface ProcessRecord {
  raw: JsonObject;
  recordId: string;
  rolesHash: string;
  role: "coordinator" | "committee";
  recordType: RecordType;
  pollId: string | null;
  detail: JsonObject;
  /** decision / code / status / outcome, used in the first line summary. */
  summaryValue: string | null;
  evidenceHash: string | null;
  anchor: string;
  deadlineMs: bigint;
  /** poll_id, or new_roles_hash for ROLES_UPDATE (carrier scope and first-line #id). */
  scopeId: string;
}

function parseDetail(type: RecordType, v: JsonValue | undefined, path: string): { detail: JsonObject; summary: string | null; scope?: string } {
  switch (type) {
    case "ADMISSION": {
      const o = expectObject(v, path, ["decision"]);
      return { detail: o, summary: expectEnum(o["decision"], ["ADMITTED", "REJECTED"] as const, `${path}.decision`) };
    }
    case "NOTICE": {
      const o = expectObject(v, path, ["code"]);
      const code = expectString(o["code"], `${path}.code`);
      if (!/^[A-Z0-9_]{1,16}$/.test(code)) throw new SchemaError(`${path}.code must be 1–16 of A-Z, 0-9, _`);
      return { detail: o, summary: code };
    }
    case "GOVERNANCE_STATUS": {
      const o = expectObject(v, path, ["status"]);
      return { detail: o, summary: expectEnum(o["status"], ["HOLD_EXECUTION", "CLEARED", "VOIDED"] as const, `${path}.status`) };
    }
    case "RESULT_ATTESTATION": {
      const o = expectObject(v, path, ["result_hash", "outcome"]);
      expectHash(o["result_hash"], `${path}.result_hash`);
      return { detail: o, summary: expectEnum(o["outcome"], ["PASS", "FAIL"] as const, `${path}.outcome`) };
    }
    case "EXECUTION": {
      const o = expectObject(v, path, ["tx_hash"]);
      expectHash(o["tx_hash"], `${path}.tx_hash`);
      return { detail: o, summary: null };
    }
    case "ROLES_UPDATE": {
      const o = expectObject(v, path, ["new_roles_hash"]);
      return { detail: o, summary: null, scope: expectHash(o["new_roles_hash"], `${path}.new_roles_hash`) };
    }
  }
}

const RECORD_KEYS = [
  "message_kind",
  "protocol_version",
  "network_genesis_hash",
  "dao_namespace",
  "roles_hash",
  "role",
  "record_type",
  "poll_id",
  "detail",
  "evidence_hash",
  "anchor_block_hash",
  "publication_deadline_ms",
  "nonce",
];

export function parseProcessRecord(v: JsonValue | undefined, network: Network, path = "process_record"): ProcessRecord {
  const o = expectObject(v, path, RECORD_KEYS);
  expectFixed(o["message_kind"], "process_record", `${path}.message_kind`);
  expectFixed(o["protocol_version"], PROTOCOL_VERSION, `${path}.protocol_version`);
  expectHash(o["network_genesis_hash"], `${path}.network_genesis_hash`);
  expectString(o["dao_namespace"], `${path}.dao_namespace`);
  const rolesHash = expectHash(o["roles_hash"], `${path}.roles_hash`);
  const role = expectEnum(o["role"], ["coordinator", "committee"] as const, `${path}.role`);
  const recordType = expectEnum(o["record_type"], RECORD_TYPES, `${path}.record_type`);
  if (!RECORD_ROLES[recordType].includes(role)) throw new SchemaError(`${path}: role ${role} may not sign ${recordType}`);
  let pollId: string | null;
  if (recordType === "ROLES_UPDATE") {
    if (o["poll_id"] !== null) throw new SchemaError(`${path}.poll_id must be null for ROLES_UPDATE`);
    pollId = null;
  } else {
    pollId = expectHash(o["poll_id"], `${path}.poll_id`);
  }
  const { detail, summary, scope } = parseDetail(recordType, o["detail"], `${path}.detail`);
  const evidenceHash = expectNullableHash(o["evidence_hash"], `${path}.evidence_hash`);
  const anchor = expectHash(o["anchor_block_hash"], `${path}.anchor_block_hash`);
  const deadlineMs = parseDecimal(o["publication_deadline_ms"], `${path}.publication_deadline_ms`);
  if (deadlineMs > MAX_RENDERABLE_MS) throw new SchemaError(`${path}.publication_deadline_ms is not renderable`);
  expectHash(o["nonce"], `${path}.nonce`);
  checkNetwork(o, network, path);
  return {
    raw: o,
    recordId: objectHash(DOMAIN.PROCESS, o),
    rolesHash,
    role,
    recordType,
    pollId,
    detail,
    summaryValue: summary,
    evidenceHash,
    anchor,
    deadlineMs,
    scopeId: scope ?? (pollId as string),
  };
}
