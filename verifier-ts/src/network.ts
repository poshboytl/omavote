/**
 * Network registry (docs/13 §4.7): genesis hash, address prefix, and the
 * script templates of the standard secp256k1 lock, the Nervos DAO type,
 * Omnilock and PW Lock. For development chains it is read from the replay
 * input. Mainnet and testnet use fixed registries (taken from CCC) and reject
 * any override (docs/13 §4 item 16).
 */
import { cccA } from "@ckb-ccc/core/advanced";
import { isHash32 } from "./bytes.js";
import { InputError } from "./errors.js";
import { isObject, type JsonValue } from "./json.js";
import { HASH_TYPES, type HashType, type ScriptTemplate } from "./molecule.js";

export interface Network {
  name: string;
  genesis_hash: string;
  hrp: string;
  secp256k1: ScriptTemplate;
  dao: ScriptTemplate;
  omnilock: ScriptTemplate | null;
  pw_lock: ScriptTemplate | null;
}

/** CKB mainnet (Lina) genesis hash; docs/13 §4.7 maps it to prefix `ckb`, every other chain to `ckt`. */
export const MAINNET_GENESIS_HASH = "0x92b197aa1fba0f63633922c61c92375c9c074a93e85963554f5499fe1450d0e5";
/** CKB public testnet (Pudge / Aggron4) genesis hash. */
export const TESTNET_GENESIS_HASH = "0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606";

export function expectedHrp(genesisHash: string): string {
  return genesisHash === MAINNET_GENESIS_HASH ? "ckb" : "ckt";
}

type FixedRegistry = Pick<Network, "secp256k1" | "dao" | "omnilock" | "pw_lock">;

function cccTemplate(table: Record<string, { codeHash: unknown; hashType: unknown } | undefined>, key: string): ScriptTemplate {
  const info = table[key];
  if (!info) throw new Error(`CCC has no ${key} entry`);
  return { code_hash: String(info.codeHash), hash_type: String(info.hashType) as HashType };
}

/**
 * Fixed registries of docs/13 §4 item 16: mainnet and testnet do not accept
 * script identities from configuration. The code hashes come from CCC's
 * MAINNET_SCRIPTS / TESTNET_SCRIPTS.
 */
export function fixedRegistry(genesisHash: string): FixedRegistry | null {
  const table =
    genesisHash === MAINNET_GENESIS_HASH ? cccA.MAINNET_SCRIPTS : genesisHash === TESTNET_GENESIS_HASH ? cccA.TESTNET_SCRIPTS : null;
  if (!table) return null;
  const t = table as unknown as Record<string, { codeHash: unknown; hashType: unknown } | undefined>;
  return {
    secp256k1: cccTemplate(t, "Secp256k1Blake160"),
    dao: cccTemplate(t, "NervosDao"),
    omnilock: cccTemplate(t, "OmniLock"),
    pw_lock: cccTemplate(t, "PWLock"),
  };
}

function parseTemplate(v: JsonValue | undefined, path: string, optional: boolean): ScriptTemplate | null {
  if (v === undefined || v === null) {
    if (optional) return null;
    throw new InputError(`network.${path} is required`);
  }
  if (!isObject(v)) throw new InputError(`network.${path} must be an object`);
  const { code_hash, hash_type } = v;
  if (!isHash32(code_hash)) throw new InputError(`network.${path}.code_hash must be 32-byte lowercase hex`);
  if (typeof hash_type !== "string" || !HASH_TYPES.includes(hash_type as HashType)) {
    throw new InputError(`network.${path}.hash_type is invalid`);
  }
  return { code_hash, hash_type: hash_type as HashType };
}

export function parseNetwork(v: JsonValue | undefined): Network {
  if (!isObject(v)) throw new InputError("network must be an object");
  const genesis = v["genesis_hash"];
  if (!isHash32(genesis)) throw new InputError("network.genesis_hash must be 32-byte lowercase hex");
  const derived = expectedHrp(genesis);
  const hrp = v["hrp"];
  if (hrp !== undefined && hrp !== derived) {
    throw new InputError(`network.hrp ${JSON.stringify(hrp)} contradicts docs/13 §4.7 (expected ${derived} for this genesis)`);
  }
  const name = v["name"];
  const fixed = fixedRegistry(genesis);
  const templates = {} as FixedRegistry;
  for (const key of ["secp256k1", "dao", "omnilock", "pw_lock"] as const) {
    const declared = parseTemplate(v[key], key, fixed !== null || key === "omnilock" || key === "pw_lock");
    if (fixed) {
      const f = fixed[key] as ScriptTemplate;
      if (declared && (declared.code_hash !== f.code_hash || declared.hash_type !== f.hash_type)) {
        throw new InputError(`network.${key} overrides the fixed ${genesis === MAINNET_GENESIS_HASH ? "mainnet" : "testnet"} registry (docs/13 §4 item 16)`);
      }
      templates[key] = f;
    } else {
      templates[key] = declared as ScriptTemplate;
    }
  }
  return {
    name: typeof name === "string" ? name : "unnamed",
    genesis_hash: genesis,
    hrp: derived,
    secp256k1: templates.secp256k1,
    dao: templates.dao,
    omnilock: templates.omnilock,
    pw_lock: templates.pw_lock,
  };
}
