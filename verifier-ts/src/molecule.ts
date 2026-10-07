/**
 * CKB Script handling: strict JSON form, Molecule serialization, script hash
 * (owner_id, docs/03 §2) and RFC 0021 full bech32m addresses. Serialization,
 * hashing and bech32m encoding are delegated to CCC.
 */
import { ccc } from "@ckb-ccc/core";
import { bytesToHex, hexToBytes, isHash32, isLowerHex } from "./bytes.js";
import { isObject, type JsonValue } from "./json.js";
import { SchemaError } from "./errors.js";

export type HashType = "type" | "data" | "data1" | "data2";
export const HASH_TYPES: readonly HashType[] = ["type", "data", "data1", "data2"];

export interface ScriptJson {
  code_hash: string;
  hash_type: HashType;
  args: string;
}

/** The (code_hash, hash_type) pair identifying a script template on a network. */
export interface ScriptTemplate {
  code_hash: string;
  hash_type: HashType;
}

/** Parses the protocol script object `{"code_hash","hash_type","args"}` with no extra keys. */
export function parseScript(v: JsonValue | undefined, path: string): ScriptJson {
  if (!isObject(v)) throw new SchemaError(`${path} must be a script object`);
  const keys = Object.keys(v).sort();
  if (keys.join(",") !== "args,code_hash,hash_type") {
    throw new SchemaError(`${path} must have exactly code_hash, hash_type, args`);
  }
  const { code_hash, hash_type, args } = v;
  if (!isHash32(code_hash)) throw new SchemaError(`${path}.code_hash must be 32-byte lowercase hex`);
  if (typeof hash_type !== "string" || !HASH_TYPES.includes(hash_type as HashType)) {
    throw new SchemaError(`${path}.hash_type is not a known hash type`);
  }
  if (!isLowerHex(args)) throw new SchemaError(`${path}.args must be lowercase 0x-hex`);
  return { code_hash, hash_type: hash_type as HashType, args };
}

export function scriptToJson(s: ScriptJson): JsonValue {
  return { code_hash: s.code_hash, hash_type: s.hash_type, args: s.args };
}

function toCcc(s: ScriptJson): ccc.Script {
  return ccc.Script.from({ codeHash: s.code_hash, hashType: s.hash_type, args: s.args });
}

/** Molecule `Script` serialization. */
export function scriptMolecule(s: ScriptJson): Uint8Array {
  return hexToBytes(ccc.hexFrom(toCcc(s).toBytes()));
}

/** Standard CKB script hash = owner_id for a lock. */
export function scriptHash(s: ScriptJson): string {
  return toCcc(s).hash();
}

/** RFC 0021 full-format bech32m address. */
export function fullAddress(s: ScriptJson, hrp: string): string {
  return ccc.Address.from({ script: toCcc(s), prefix: hrp }).toString();
}

export function scriptEquals(a: ScriptJson, b: ScriptJson): boolean {
  return a.code_hash === b.code_hash && a.hash_type === b.hash_type && a.args === b.args;
}

export function matchesTemplate(s: ScriptJson, t: ScriptTemplate | null | undefined): boolean {
  return !!t && s.code_hash === t.code_hash && s.hash_type === t.hash_type;
}

export function argsBytes(s: ScriptJson): Uint8Array {
  return hexToBytes(s.args);
}

export function hexArgs(bytes: Uint8Array): string {
  return bytesToHex(bytes);
}

/**
 * Molecule `WitnessArgs` serialization (used only to check the external
 * vectors; the carrier payload witness itself is raw JCS bytes).
 */
export function witnessArgsMolecule(lock: string | null, inputType: string | null, outputType: string | null): string {
  const w = ccc.WitnessArgs.from({
    lock: lock ?? undefined,
    inputType: inputType ?? undefined,
    outputType: outputType ?? undefined,
  });
  return ccc.hexFrom(w.toBytes());
}
