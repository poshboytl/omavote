/**
 * Signature adapters (docs/03 §5.1, docs/11 §4.1, docs/13 §4.5).
 *
 *  - ckb-secp256k1-message-v1: Neuron "Nervos Message:" scheme,
 *    digest = CKB-Blake2b(UTF-8("Nervos Message:" || text)), signature r||s||v, v in {0,1}.
 *    Owner role: standard secp256k1_blake160 lock (full script), args = blake160(compressed pubkey).
 *    Key role: descriptor public_key equals the recovered compressed key.
 *  - evm-personal-message-v1: EIP-191 personal_sign,
 *    digest = keccak256(0x19 || "Ethereum Signed Message:\n" || len || text), v in {27,28,0,1}.
 *    Owner role: Omnilock plain EVM mode, args exactly 22 bytes
 *    auth_flag || eth_address || 0x00 with auth_flag 0x01 (Ethereum) or 0x12
 *    (Ethereum-displaying), or PW Lock (args = address). Key role: descriptor address.
 *
 * High-S signatures are accepted for both adapters by normalising
 * (r, s, v) -> (r, n - s, v ^ 1) before recovery (docs/13 §4 item 15).
 * r and s must lie in [1, n-1].
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesEqual, bytesToBigint, bytesToHex, concatBytes, hexToBytes, isLowerHex } from "./bytes.js";
import { SchemaError } from "./errors.js";
import { blake160, ckbHash } from "./hash.js";
import { isObject, utf8Encode, type JsonValue } from "./json.js";
import { matchesTemplate, type ScriptJson } from "./molecule.js";
import type { Network } from "./network.js";

export const ADAPTER_CKB = "ckb-secp256k1-message-v1";
export const ADAPTER_EVM = "evm-personal-message-v1";
export const ADAPTER_WEBAUTHN = "webauthn-es256-v2";

/** Adapter IDs usable in the owner role (direct ballots, proposals, controls). */
export const OWNER_ADAPTER_IDS: readonly string[] = [ADAPTER_CKB, ADAPTER_EVM];
/** Adapter IDs usable in the key role (delegate ballots, process keys). */
export const KEY_ADAPTER_IDS: readonly string[] = [ADAPTER_CKB, ADAPTER_EVM, ADAPTER_WEBAUTHN];
/** Global control-format set (docs/03 §5.1): owner adapters that may sign GRANT/REVOKE. */
export const CONTROL_FORMAT_IDS: readonly string[] = [ADAPTER_CKB, ADAPTER_EVM];
/** Key adapters this verifier can actually verify. */
export const IMPLEMENTED_KEY_ADAPTER_IDS: readonly string[] = [ADAPTER_CKB, ADAPTER_EVM];

/** Omnilock auth flags of the plain EVM mode (docs/03 §5.1): Ethereum and Ethereum-displaying. */
export const OMNILOCK_EVM_AUTH_FLAGS: readonly string[] = ["01", "12"];

const CURVE_N: bigint = secp256k1.Point.CURVE().n;
const HALF_N = CURVE_N >> 1n;
const NERVOS_MESSAGE_PREFIX = utf8Encode("Nervos Message:");

export type Identity =
  | { kind: "secp256k1"; publicKey: Uint8Array /* 33-byte compressed */ }
  | { kind: "evm"; address: string /* lowercase 0x + 40 hex */ };

export type RecoverOutcome = { ok: true; identity: Identity } | { ok: false; reason: string };

/** Parses a message-adapter proof `{"signature": "0x<65 bytes>"}` (docs/13 §4.5). */
export function parseSignatureProof(v: JsonValue | undefined, path: string): Uint8Array {
  if (!isObject(v)) throw new SchemaError(`${path} must be an object`);
  const keys = Object.keys(v);
  if (keys.length !== 1 || keys[0] !== "signature") {
    throw new SchemaError(`${path} must have exactly one key "signature"`);
  }
  const sig = v["signature"];
  if (!isLowerHex(sig, 65)) throw new SchemaError(`${path}.signature must be 65-byte lowercase hex`);
  return hexToBytes(sig);
}

export function ckbMessageDigest(text: string): Uint8Array {
  return ckbHash(NERVOS_MESSAGE_PREFIX, utf8Encode(text));
}

export function evmMessageDigest(text: string): Uint8Array {
  const body = utf8Encode(text);
  const prefix = utf8Encode(`\x19Ethereum Signed Message:\n${body.length}`);
  return keccak_256(concatBytes(prefix, body));
}

function recoverPoint(digest: Uint8Array, sig: Uint8Array, recovery: number): ReturnType<InstanceType<typeof secp256k1.Signature>["recoverPublicKey"]> | null {
  const r = bytesToBigint(sig.subarray(0, 32));
  let s = bytesToBigint(sig.subarray(32, 64));
  if (r < 1n || r >= CURVE_N || s < 1n || s >= CURVE_N) return null;
  let v = recovery;
  if (s > HALF_N) {
    s = CURVE_N - s;
    v ^= 1;
  }
  try {
    return new secp256k1.Signature(r, s, v).recoverPublicKey(digest);
  } catch {
    return null;
  }
}

/** Recovers the signer of a Neuron-style message signature. */
export function recoverCkb(text: string, sig: Uint8Array): RecoverOutcome {
  if (sig.length !== 65) return { ok: false, reason: "signature must be 65 bytes" };
  const v = sig[64] as number;
  if (v !== 0 && v !== 1) return { ok: false, reason: "recovery id must be 0 or 1" };
  const point = recoverPoint(ckbMessageDigest(text), sig, v);
  if (!point) return { ok: false, reason: "public key recovery failed" };
  return { ok: true, identity: { kind: "secp256k1", publicKey: point.toBytes(true) } };
}

export function evmAddressFromPoint(uncompressed: Uint8Array): string {
  return bytesToHex(keccak_256(uncompressed.subarray(1)).subarray(12));
}

/** Recovers the EOA of an EIP-191 personal_sign signature. */
export function recoverEvm(text: string, sig: Uint8Array): RecoverOutcome {
  if (sig.length !== 65) return { ok: false, reason: "signature must be 65 bytes" };
  let v = sig[64] as number;
  if (v === 27 || v === 28) v -= 27;
  if (v !== 0 && v !== 1) return { ok: false, reason: "v must be 27, 28, 0 or 1" };
  const point = recoverPoint(evmMessageDigest(text), sig, v);
  if (!point) return { ok: false, reason: "public key recovery failed" };
  return { ok: true, identity: { kind: "evm", address: evmAddressFromPoint(point.toBytes(false)) } };
}

export function recoverWith(adapterId: string, text: string, sig: Uint8Array): RecoverOutcome {
  if (adapterId === ADAPTER_CKB) return recoverCkb(text, sig);
  if (adapterId === ADAPTER_EVM) return recoverEvm(text, sig);
  return { ok: false, reason: `adapter ${adapterId} is not implemented` };
}

/**
 * Owner-role matching of the full lock script (docs/03 §5.1). Returns true
 * when the recovered identity controls `lock` under the adapter's rule.
 */
export function identityControlsLock(adapterId: string, identity: Identity, lock: ScriptJson, network: Network): boolean {
  if (adapterId === ADAPTER_CKB) {
    if (identity.kind !== "secp256k1") return false;
    if (!matchesTemplate(lock, network.secp256k1)) return false;
    return lock.args === bytesToHex(blake160(identity.publicKey));
  }
  if (adapterId === ADAPTER_EVM) {
    if (identity.kind !== "evm") return false;
    const addr = identity.address.slice(2);
    if (matchesTemplate(lock, network.omnilock) && OMNILOCK_EVM_AUTH_FLAGS.some((flag) => lock.args === `0x${flag}${addr}00`)) return true;
    if (matchesTemplate(lock, network.pw_lock) && lock.args === `0x${addr}`) return true;
    return false;
  }
  return false;
}

export type VerifyResult = "OK" | "INVALID_SIGNATURE" | "WRONG_OWNER" | "UNSUPPORTED_ADAPTER";

/** Verifies an owner-role signature over `text` for `lock`. */
export function verifyOwnerSignature(adapterId: string, text: string, sig: Uint8Array, lock: ScriptJson, network: Network): VerifyResult {
  if (!OWNER_ADAPTER_IDS.includes(adapterId)) return "UNSUPPORTED_ADAPTER";
  const rec = recoverWith(adapterId, text, sig);
  if (!rec.ok) return "INVALID_SIGNATURE";
  return identityControlsLock(adapterId, rec.identity, lock, network) ? "OK" : "WRONG_OWNER";
}

/** Minimal key-descriptor view needed for key-role verification. */
export interface KeyRef {
  kind: string;
  adapter: string;
  publicKey?: Uint8Array;
  address?: string;
}

/** Verifies a key-role signature against a key descriptor. */
export function verifyKeySignature(key: KeyRef, text: string, sig: Uint8Array): VerifyResult {
  if (!IMPLEMENTED_KEY_ADAPTER_IDS.includes(key.adapter)) return "UNSUPPORTED_ADAPTER";
  const rec = recoverWith(key.adapter, text, sig);
  if (!rec.ok) return "INVALID_SIGNATURE";
  if (key.kind === "secp256k1" && rec.identity.kind === "secp256k1" && key.publicKey) {
    return bytesEqual(key.publicKey, rec.identity.publicKey) ? "OK" : "INVALID_SIGNATURE";
  }
  if (key.kind === "evm_eoa" && rec.identity.kind === "evm" && key.address) {
    return key.address === rec.identity.address ? "OK" : "INVALID_SIGNATURE";
  }
  return "INVALID_SIGNATURE";
}

/** True when `pk` (33 bytes) is a valid compressed secp256k1 point. */
export function isValidCompressedPoint(pk: Uint8Array): boolean {
  if (pk.length !== 33 || (pk[0] !== 2 && pk[0] !== 3)) return false;
  try {
    secp256k1.Point.fromBytes(pk).assertValidity();
    return true;
  } catch {
    return false;
  }
}

/** EIP-55 mixed-case checksum encoding of a lowercase 0x address. */
export function eip55(address: string): string {
  if (!isLowerHex(address, 20)) throw new Error("address must be 20-byte lowercase hex");
  const hex = address.slice(2);
  const hash = keccak_256(utf8Encode(hex));
  let out = "0x";
  for (let i = 0; i < hex.length; i++) {
    const ch = hex[i] as string;
    const nibble = ((hash[i >> 1] as number) >> (i % 2 === 0 ? 4 : 0)) & 0x0f;
    out += /[a-f]/.test(ch) && nibble >= 8 ? ch.toUpperCase() : ch;
  }
  return out;
}

/** Compressed public key -> uncompressed 65-byte form (for EVM address derivation in tests). */
export function publicKeyFromSecret(secret: Uint8Array, compressed: boolean): Uint8Array {
  return secp256k1.getPublicKey(secret, compressed);
}

/** Signs `digest` (prehashed) returning r||s||recovery (65 bytes); used by tests and vector checks. */
export function signDigest(digest: Uint8Array, secret: Uint8Array): Uint8Array {
  const rec = secp256k1.sign(digest, secret, { prehash: false, format: "recovered" });
  // noble's "recovered" format is recovery || r || s
  return concatBytes(rec.subarray(1, 65), rec.subarray(0, 1));
}
