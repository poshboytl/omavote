// Typed facade over the protocol core (`omavote-wasm`): signed texts, IDs and
// local signature checks come from the same Rust code as the server and verifier.
// The page never re-implements these rules.

import type {
  AuthPolicy,
  AuthRegistry,
  BallotBody,
  ControlBody,
  KeyDescriptor,
  KeyInfo,
  LockInfo,
  Manifest,
  ManifestInfo,
  NetworkParams,
  ProcessRecordBody,
  RulesProfile,
  Script,
  VerifyResult,
} from "./types";
import { utf8ToHex } from "./hex";

/** `call(method, paramsJson) -> resultJson`, throwing a string on errors (wasm-bindgen). */
export type RawCall = (method: string, paramsJson: string) => string;

export class CoreError extends Error {
  readonly method: string;
  constructor(method: string, message: string) {
    super(message);
    this.name = "CoreError";
    this.method = method;
  }
}

/** The core rejects JSON numbers: every integer must already be a decimal string. */
export function assertNoNumbers(v: unknown, path = "params"): void {
  if (typeof v === "number" || typeof v === "bigint") {
    throw new CoreError("params", `${path} is a number; protocol integers are decimal strings`);
  }
  if (Array.isArray(v)) v.forEach((x, i) => assertNoNumbers(x, `${path}[${i}]`));
  else if (v !== null && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) if (x !== undefined) assertNoNumbers(x, `${path}.${k}`);
  }
}

export interface BallotOut {
  body: BallotBody;
  ballot_id: string;
  owner_id: string;
  summary: string;
  text: string;
}

export interface ControlOut {
  body: ControlBody;
  authorization_id: string;
  owner_id: string;
  summary: string;
  text: string;
}

export interface RecordOut {
  body: ProcessRecordBody;
  record_id: string;
  text: string;
}

export class Core {
  readonly version: string;
  private readonly raw: RawCall;

  constructor(raw: RawCall, version = "unknown") {
    this.raw = raw;
    this.version = version;
  }

  call<T>(method: string, params: object): T {
    assertNoNumbers(params);
    let out: string;
    try {
      out = this.raw(method, JSON.stringify(params));
    } catch (e) {
      throw new CoreError(method, e instanceof Error ? e.message : String(e));
    }
    return JSON.parse(out) as T;
  }

  jcs(value: unknown): string {
    return this.call<{ jcs: string }>("jcs", { value }).jcs;
  }

  /** CKB Blake2b-256 of raw bytes given as hex. */
  ckbHash(dataHex: string): string {
    return this.call<{ hash: string }>("ckb_hash", { data: dataHex }).hash;
  }

  /** CKB Blake2b-256 of the UTF-8 bytes of a text (proposal bodies). */
  ckbHashText(text: string): string {
    return this.ckbHash(utf8ToHex(text));
  }

  utc(ms: string): string {
    return this.call<{ utc: string }>("utc", { ms }).utc;
  }

  renderCkb(shannon: string): string {
    return this.call<{ ckb: string }>("render_ckb", { shannon }).ckb;
  }

  knownNetwork(name: "mainnet" | "testnet"): NetworkParams {
    return this.call<NetworkParams>("known_network", { name });
  }

  address(network: NetworkParams, script: Script): string {
    return this.call<{ address: string }>("address", { network, script }).address;
  }

  parseAddress(address: string): { hrp: string; script: Script; script_hash: string } {
    return this.call("parse_address", { address });
  }

  scriptHash(script: Script): string {
    return this.call<{ hash: string }>("script_hash", { script }).hash;
  }

  secp256k1Lock(network: NetworkParams, publicKey: string): LockInfo {
    return this.call("secp256k1_lock", { network, public_key: publicKey });
  }

  evmOwnerLocks(network: NetworkParams, address: string): LockInfo[] {
    return this.call<{ locks: LockInfo[] }>("evm_owner_locks", { network, address }).locks;
  }

  defaultRules(opts: { opening_confirmations?: string; voting_period_ms?: string } = {}): {
    rules_profile: RulesProfile;
    rules_hash: string;
  } {
    return this.call("default_rules", opts);
  }

  authPolicy(genesis: string): { policy: AuthPolicy; hash: string } {
    return this.call("auth_policy", { genesis });
  }

  registry(registry: AuthRegistry): { registry: AuthRegistry; hash: string } {
    return this.call("registry", { registry });
  }

  manifestFromDraft(draft: object, network?: NetworkParams): { manifest: Manifest; info: ManifestInfo } {
    return this.call("manifest_from_draft", network ? { draft, network } : { draft });
  }

  manifestInfo(manifest: Manifest, network?: NetworkParams): ManifestInfo {
    return this.call("manifest_info", network ? { manifest, network } : { manifest });
  }

  proposalText(network: NetworkParams, manifest: Manifest, proposerLock: Script): string {
    return this.call<{ text: string }>("proposal_text", { network, manifest, proposer_lock: proposerLock }).text;
  }

  ballot(network: NetworkParams, manifest: Manifest, body: BallotBody): BallotOut {
    return this.call("ballot", { network, manifest, body });
  }

  control(network: NetworkParams, body: ControlBody): ControlOut {
    return this.call("control", { network, body });
  }

  record(body: ProcessRecordBody): RecordOut {
    return this.call("record", { body });
  }

  key(descriptor: KeyDescriptor, network?: NetworkParams): KeyInfo {
    return this.call("key", network ? { descriptor, network } : { descriptor });
  }

  evmKey(address: string, network?: NetworkParams): KeyInfo {
    return this.call("evm_key", network ? { address, network } : { address });
  }

  verifyOwner(network: NetworkParams, adapter: string, ownerLock: Script, text: string, signature: string): VerifyResult {
    return this.call("verify_owner", { network, adapter, owner_lock: ownerLock, text, signature });
  }

  verifyKey(descriptor: KeyDescriptor, text: string, signature: string): VerifyResult {
    return this.call("verify_key", { descriptor, text, signature });
  }

  recoverEvm(text: string, signature: string): { address: string; checksum_address: string } {
    return this.call("recover_evm", { text, signature });
  }

  recoverCkb(text: string, signature: string): { public_key: string; lock_args: string } {
    return this.call("recover_ckb", { text, signature });
  }

  /** Compressed public key that signed a relay receipt body. */
  receiptSigner(body: object, signature: string): string {
    return this.call<{ public_key: string }>("receipt_signer", { body, signature }).public_key;
  }

  /** 32 random bytes from the platform CSPRNG (crypto.getRandomValues). */
  nonce(): string {
    return this.call<{ nonce: string }>("nonce", {}).nonce;
  }
}
