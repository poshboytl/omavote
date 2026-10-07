/**
 * CKB Blake2b-256 (personalization `ckb-default-hash`, provided by CCC) and
 * the domain-separated identifiers of docs/03 §2, §3.1, §7, §11 and
 * docs/11 §1: H(prefix || 0x00 || data).
 */
import { ccc } from "@ckb-ccc/core";
import { bytesToHex, concatBytes, hexToBytes } from "./bytes.js";
import { jcsBytes, utf8Encode, type JsonValue } from "./json.js";

export const DOMAIN = {
  RULES: "OMAVOTE/RULES/V2",
  POLL: "OMAVOTE/POLL/V2",
  BALLOT: "OMAVOTE/BALLOT/V2",
  KEY: "OMAVOTE/KEY/V2",
  AUTHORIZATION: "OMAVOTE/AUTHORIZATION/V2",
  AUTH_POLICY: "OMAVOTE/AUTH-POLICY/V2",
  AUTH_REGISTRY: "OMAVOTE/AUTH-REGISTRY/V2",
  ROLES: "OMAVOTE/ROLES/V2",
  PROCESS: "OMAVOTE/PROCESS/V2",
  PAYLOAD: "OMAVOTE/PAYLOAD/V2",
  RESULT: "OMAVOTE/RESULT/V2",
} as const;

export type Domain = (typeof DOMAIN)[keyof typeof DOMAIN];

/** Standard CKB hash of the concatenation of `parts`. */
export function ckbHash(...parts: Uint8Array[]): Uint8Array {
  const hasher = new ccc.HasherCkb();
  for (const p of parts) hasher.update(p);
  return hexToBytes(hasher.digest());
}

export function ckbHashHex(...parts: Uint8Array[]): string {
  return bytesToHex(ckbHash(...parts));
}

/** First 20 bytes of the CKB hash (secp256k1_blake160 lock args). */
export function blake160(data: Uint8Array): Uint8Array {
  return ckbHash(data).slice(0, 20);
}

const NUL = new Uint8Array([0]);

/** H(prefix || "\0" || data), lowercase 0x-hex. */
export function domainHash(prefix: string, data: Uint8Array): string {
  return ckbHashHex(utf8Encode(prefix), NUL, data);
}

/** H(prefix || "\0" || JCS(value)). */
export function objectHash(prefix: Domain, value: JsonValue): string {
  return domainHash(prefix, jcsBytes(value));
}

/** payload_hash = H("OMAVOTE/PAYLOAD/V2\0" || kind[u8] || payload_bytes) (docs/03 §7). */
export function payloadHash(kind: number, payload: Uint8Array): string {
  if (!Number.isInteger(kind) || kind < 0 || kind > 255) throw new Error("kind must be a u8");
  return domainHash(DOMAIN.PAYLOAD, concatBytes(new Uint8Array([kind]), payload));
}
