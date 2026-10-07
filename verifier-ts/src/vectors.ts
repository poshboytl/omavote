/**
 * Cross-implementation vector checks (vectors/*.json). Used by
 * `cli.js check-vectors` and by the test-suite. Every file in the vectors
 * directory must be recognised; unknown files are reported as failures so
 * that nothing passes silently.
 */
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import {
  ckbMessageDigest,
  eip55,
  evmAddressFromPoint,
  evmMessageDigest,
  parseSignatureProof,
  publicKeyFromSecret,
  recoverCkb,
  recoverEvm,
  signDigest,
  verifyKeySignature,
  verifyOwnerSignature,
} from "./adapter.js";
import { bytesToHex, hexToBytes, inputHexToBytes } from "./bytes.js";
import { decodeHeader, encodeHeader } from "./carrier.js";
import { blake160, ckbHashHex, DOMAIN, domainHash, objectHash, payloadHash } from "./hash.js";
import { isObject, jcs, parseStrictJson, utf8Encode, type JsonObject, type JsonValue } from "./json.js";
import { fullAddress, parseScript, scriptHash, scriptMolecule, witnessArgsMolecule } from "./molecule.js";
import { parseNetwork } from "./network.js";
import { buildReport, runReplay } from "./replay.js";
import { parseReplayInputValue } from "./replay-input.js";
import {
  parseAuthPolicy,
  parseBallotBody,
  parseControlBody,
  parseKeyDescriptor,
  parseManifest,
  parseProcessRecord,
  parseProcessRoles,
  type Manifest,
} from "./schema.js";
import { ballotText, controlText, keyDisplay, processText, proposalText } from "./text.js";

export interface CheckResult {
  file: string;
  name: string;
  ok: boolean;
  detail?: string;
}

class Checker {
  readonly results: CheckResult[] = [];
  constructor(private readonly file: string) {}

  eq(name: string, actual: unknown, expected: unknown): void {
    const ok = actual === expected;
    this.results.push(ok ? { file: this.file, name, ok } : { file: this.file, name, ok, detail: `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}` });
  }

  ok(name: string, cond: boolean, detail?: string): void {
    this.results.push(cond ? { file: this.file, name, ok: true } : { file: this.file, name, ok: false, detail: detail ?? "condition failed" });
  }

  run(name: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.results.push({ file: this.file, name, ok: false, detail: `exception: ${(e as Error).message}` });
    }
  }
}

function readJson(path: string): JsonValue {
  // Vector files are themselves strict protocol-style JSON (no numbers, no duplicate keys).
  return parseStrictJson(readFileSync(path, "utf8"), { maxDepth: 64 });
}

function obj(v: JsonValue | undefined, what: string): JsonObject {
  if (!isObject(v)) throw new Error(`${what} must be an object`);
  return v;
}

function str(v: JsonValue | undefined, what: string): string {
  if (typeof v !== "string") throw new Error(`${what} must be a string`);
  return v;
}

function list(v: JsonValue | undefined, what: string): JsonValue[] {
  if (!Array.isArray(v)) throw new Error(`${what} must be an array`);
  return v;
}

// ---------------------------------------------------------------------------

export function checkEncoding(path: string): CheckResult[] {
  const c = new Checker("encoding.json");
  const d = obj(readJson(path), "encoding.json");
  list(d["jcs"], "jcs").forEach((item, i) => {
    c.run(`jcs[${i}]`, () => {
      const o = obj(item, "jcs item");
      c.eq(`jcs[${i}] canonical`, jcs(parseStrictJson(str(o["input"], "input"))), str(o["canonical"], "canonical"));
    });
  });
  list(d["reject"], "reject").forEach((item, i) => {
    let rejected = false;
    try {
      parseStrictJson(str(item, "reject item"));
    } catch {
      rejected = true;
    }
    c.ok(`reject[${i}] ${JSON.stringify(item)}`, rejected, "strict parser accepted input that must be rejected");
  });
  list(d["ckb_hash"], "ckb_hash").forEach((item, i) => {
    c.run(`ckb_hash[${i}]`, () => {
      const o = obj(item, "ckb_hash item");
      c.eq(`ckb_hash[${i}]`, ckbHashHex(utf8Encode(str(o["utf8"], "utf8"))), str(o["hash"], "hash"));
    });
  });
  list(d["domain_hash"], "domain_hash").forEach((item, i) => {
    c.run(`domain_hash[${i}]`, () => {
      const o = obj(item, "domain_hash item");
      // The vector writes the prefix as "OMAVOTE/…/V2\0" with a literal backslash-zero meaning the NUL byte.
      const prefix = str(o["prefix"], "prefix");
      if (!prefix.endsWith("\\0")) throw new Error("prefix is expected to end with the two characters \\0");
      c.eq(`domain_hash[${i}]`, domainHash(prefix.slice(0, -2), utf8Encode(str(o["data_utf8"], "data_utf8"))), str(o["hash"], "hash"));
    });
  });
  return c.results;
}

export function checkScripts(path: string): CheckResult[] {
  const c = new Checker("scripts.json");
  list(readJson(path), "scripts.json").forEach((item, i) => {
    c.run(`script[${i}]`, () => {
      const o = obj(item, "script item");
      const s = parseScript(o["script"], "script");
      c.eq(`script[${i}] molecule`, bytesToHex(scriptMolecule(s)), str(o["molecule"], "molecule"));
      c.eq(`script[${i}] script_hash`, scriptHash(s), str(o["script_hash"], "script_hash"));
      c.eq(`script[${i}] mainnet_address`, fullAddress(s, "ckb"), str(o["mainnet_address"], "mainnet_address"));
      c.eq(`script[${i}] testnet_address`, fullAddress(s, "ckt"), str(o["testnet_address"], "testnet_address"));
    });
  });
  return c.results;
}

export function checkSignatures(path: string): CheckResult[] {
  const c = new Checker("signatures.json");
  list(readJson(path), "signatures.json").forEach((item, i) => {
    c.run(`signature[${i}]`, () => {
      const o = obj(item, "signature item");
      const text = str(o["message_utf8"], "message_utf8");
      const secret = hexToBytes(str(o["secret"], "secret"));
      c.eq(`[${i}] ckb_digest`, bytesToHex(ckbMessageDigest(text)), o["ckb_digest"]);
      const ckbSig = hexToBytes(str(o["ckb_signature"], "ckb_signature"));
      const rc = recoverCkb(text, ckbSig);
      c.ok(`[${i}] ckb recover`, rc.ok);
      if (rc.ok && rc.identity.kind === "secp256k1") {
        c.eq(`[${i}] ckb_public_key`, bytesToHex(rc.identity.publicKey), o["ckb_public_key"]);
        c.eq(`[${i}] ckb_lock_args`, bytesToHex(blake160(rc.identity.publicKey)), o["ckb_lock_args"]);
      }
      c.eq(`[${i}] secret -> ckb_public_key`, bytesToHex(publicKeyFromSecret(secret, true)), o["ckb_public_key"]);
      c.eq(`[${i}] deterministic ckb signature`, bytesToHex(signDigest(ckbMessageDigest(text), secret)), o["ckb_signature"]);
      c.eq(`[${i}] evm_digest`, bytesToHex(evmMessageDigest(text)), o["evm_digest"]);
      const re = recoverEvm(text, hexToBytes(str(o["evm_signature"], "evm_signature")));
      c.ok(`[${i}] evm recover`, re.ok);
      if (re.ok && re.identity.kind === "evm") c.eq(`[${i}] evm_address`, re.identity.address, o["evm_address"]);
      c.eq(`[${i}] secret -> evm_address`, evmAddressFromPoint(publicKeyFromSecret(secret, false)), o["evm_address"]);
    });
  });
  return c.results;
}

export function checkCarrier(path: string): CheckResult[] {
  const c = new Checker("carrier.json");
  c.run("carrier", () => {
    const o = obj(readJson(path), "carrier.json");
    const kind = Number(str(o["kind"], "kind"));
    const payload = utf8Encode(str(o["payload_utf8"], "payload_utf8"));
    const ph = payloadHash(kind, payload);
    c.eq("payload_hash", ph, o["payload_hash"]);
    const header = encodeHeader({ kind, version: 2, scopeId: str(o["scope_id"], "scope_id"), payloadHash: ph, witnessIndex: Number(str(o["witness_index"], "witness_index")) });
    c.eq("header", bytesToHex(header), o["header"]);
    const dec = decodeHeader(hexToBytes(str(o["header"], "header")));
    c.eq("decoded kind", String(dec.kind), o["kind"]);
    c.eq("decoded scope_id", dec.scopeId, o["scope_id"]);
    c.eq("decoded witness_index", String(dec.witnessIndex), o["witness_index"]);
    c.eq("decoded payload_hash", dec.payloadHash, o["payload_hash"]);
  });
  return c.results;
}

export function checkMessages(path: string): CheckResult[] {
  const c = new Checker("messages.json");
  const d = obj(readJson(path), "messages.json");
  const network = parseNetwork(d["network"]);
  const items = list(d["items"], "items").map((x) => obj(x, "item"));
  // Index objects other items depend on.
  let manifest: Manifest | null = null;
  const rolesByHash = new Map<string, ReturnType<typeof parseProcessRoles>>();
  const grants = new Map<string, ReturnType<typeof parseControlBody>>();
  for (const it of items) {
    try {
      const j = it["json"];
      if (isObject(j) && j["message_kind"] === "manifest") manifest = parseManifest(j, network);
      if (isObject(j) && j["message_kind"] === "process_roles") {
        const r = parseProcessRoles(j, network);
        rolesByHash.set(r.rolesHash, r);
      }
      const env = it["envelope"];
      if (isObject(env) && isObject(env["body"]) && env["body"]["message_kind"] === "authorization_control") {
        const g = parseControlBody(env["body"], network);
        grants.set(g.authorizationId, g);
      }
    } catch {
      /* reported by the per-item checks below */
    }
  }
  for (const it of items) {
    const name = str(it["name"], "name");
    c.run(name, () => {
      const j = it["json"];
      const env = it["envelope"];
      if (isObject(j) && j["message_kind"] === "authorization_policy") {
        c.eq(`${name} hash`, parseAuthPolicy(j, network).hash, it["hash"]);
      } else if (isObject(j) && j["message_kind"] === "process_roles") {
        c.eq(`${name} hash`, parseProcessRoles(j, network).rolesHash, it["hash"]);
      } else if (isObject(j) && j["message_kind"] === "manifest") {
        const m = parseManifest(j, network);
        c.eq(`${name} poll_id`, m.pollId, it["poll_id"]);
        c.eq(`${name} rules_hash`, objectHash(DOMAIN.RULES, j["rules_profile"] as JsonValue), it["rules_hash"]);
        c.eq(`${name} auth_registry_hash`, objectHash(DOMAIN.AUTH_REGISTRY, j["auth_registry"] as JsonValue), it["auth_registry_hash"]);
      } else if (isObject(j) && it["key_id"] !== undefined) {
        const k = parseKeyDescriptor(j);
        c.eq(`${name} key_id`, k.keyId, it["key_id"]);
        c.eq(`${name} key_display`, keyDisplay(k, network), it["key_display"]);
      } else if (isObject(env) && isObject(env["manifest"])) {
        const m = parseManifest(env["manifest"], network);
        c.eq(`${name} id`, m.pollId, it["id"]);
        const proofs = list(env["proposer_proofs"], "proposer_proofs");
        c.eq(`${name} one proof per proposer`, proofs.length, m.proposers.length);
        proofs.forEach((p, i) => {
          const po = obj(p, "proposer proof");
          const lock = parseScript(po["owner_lock"], "owner_lock");
          const text = proposalText(m, lock, network);
          if (i === 0) c.eq(`${name} signed_text`, text, it["signed_text"]);
          const r = verifyOwnerSignature(str(po["auth_adapter"], "auth_adapter"), text, parseSignatureProof(po["proof"], "proof"), lock, network);
          c.eq(`${name} proposer[${i}] signature`, r, "OK");
        });
      } else if (isObject(env) && isObject(env["body"])) {
        const body = env["body"];
        const kind = body["message_kind"];
        if (kind === "authorization_control") {
          const g = parseControlBody(body, network);
          c.eq(`${name} id`, g.authorizationId, it["id"]);
          const text = controlText(g, network);
          c.eq(`${name} signed_text`, text, it["signed_text"]);
          c.eq(`${name} owner signature`, verifyOwnerSignature(g.ownerAuthAdapter, text, parseSignatureProof(env["proof"], "proof"), g.ownerLock, network), "OK");
        } else if (kind === "ballot") {
          if (!manifest) throw new Error("ballot item needs the manifest item");
          const b = parseBallotBody(body, network);
          c.eq(`${name} id`, b.ballotId, it["id"]);
          const text = ballotText(manifest, b, network);
          c.eq(`${name} signed_text`, text, it["signed_text"]);
          const sig = parseSignatureProof(env["proof"], "proof");
          if (b.authority === "owner") {
            c.eq(`${name} owner signature`, verifyOwnerSignature(b.authAdapter, text, sig, b.ownerLock, network), "OK");
          } else {
            const g = grants.get(b.authorizationId as string);
            if (!g || !g.keyDescriptor) throw new Error("delegate ballot item needs its grant item");
            c.eq(`${name} signer_key_id`, g.keyDescriptor.keyId, b.signerKeyId);
            c.eq(`${name} key signature`, verifyKeySignature(g.keyDescriptor, text, sig), "OK");
          }
        } else if (kind === "process_record") {
          const r = parseProcessRecord(body, network);
          c.eq(`${name} id`, r.recordId, it["id"]);
          const text = processText(r);
          c.eq(`${name} signed_text`, text, it["signed_text"]);
          const roles = rolesByHash.get(r.rolesHash);
          if (!roles) throw new Error("process record item needs its roles item");
          const cfg = r.role === "committee" ? roles.committee : roles.coordinator;
          const proofs = list(env["proofs"], "proofs");
          let valid = 0;
          proofs.forEach((p, i) => {
            const po = obj(p, "proof entry");
            const member = cfg.members.find((k) => k.keyId === po["signer_key_id"]);
            c.ok(`${name} proofs[${i}] signer is a ${r.role} member`, !!member);
            if (member) {
              const res = verifyKeySignature(member, text, parseSignatureProof(po["proof"], "proof"));
              c.eq(`${name} proofs[${i}] signature`, res, "OK");
              if (res === "OK") valid++;
            }
          });
          c.ok(`${name} threshold`, valid >= cfg.threshold, `${valid} < ${cfg.threshold}`);
        } else {
          throw new Error(`unrecognised envelope message_kind ${String(kind)}`);
        }
      } else {
        throw new Error("unrecognised messages.json item shape");
      }
    });
  }
  return c.results;
}

export function checkReplay(path: string): CheckResult[] {
  const c = new Checker(basename(path));
  c.run("replay", () => {
    const root = obj(readJson(path), "replay.json");
    const expected = obj(root["expected"], "expected");
    const engine = runReplay(parseReplayInputValue(root));
    const pollId = str(expected["poll_id"], "expected.poll_id");
    const report = buildReport(engine, { pollId });
    if (!report) throw new Error(`poll ${pollId} was not registered by the replay`);
    c.eq("poll_id", report["poll_id"], pollId);
    for (const key of Object.keys(expected)) {
      if (key === "poll_id") continue;
      const exp = expected[key] as JsonValue;
      const act = report[key];
      c.eq(key, act === undefined ? "<missing>" : jcs(act), jcs(exp));
    }
  });
  return c.results;
}

export function checkExternal(path: string): CheckResult[] {
  const c = new Checker("external.json");
  const d = obj(readJson(path), "external.json");
  const known = new Set(["provenance", "ckb_hash", "neuron", "eip191", "witness_args"]);
  for (const key of Object.keys(d)) c.ok(`section ${key} recognised`, known.has(key), `unknown section ${key} (not checked)`);
  list(d["ckb_hash"] ?? [], "ckb_hash").forEach((item, i) => {
    c.run(`ckb_hash[${i}]`, () => {
      const o = obj(item, "ckb_hash item");
      c.eq(`ckb_hash[${i}]`, ckbHashHex(inputHexToBytes(str(o["data"], "data"))), o["hash"]);
    });
  });
  list(d["neuron"] ?? [], "neuron").forEach((item, i) => {
    c.run(`neuron[${i}]`, () => {
      const o = obj(item, "neuron item");
      const text = str(o["text"], "text");
      c.eq(`neuron[${i}] digest`, bytesToHex(ckbMessageDigest(text)), o["digest"]);
      const r = recoverCkb(text, hexToBytes(str(o["signature"], "signature")));
      c.ok(`neuron[${i}] recover`, r.ok);
      if (r.ok && r.identity.kind === "secp256k1") {
        c.eq(`neuron[${i}] pubkey`, bytesToHex(r.identity.publicKey), o["pubkey"]);
        c.eq(`neuron[${i}] lock_args`, bytesToHex(blake160(r.identity.publicKey)), o["lock_args"]);
      }
      const secret = hexToBytes(str(o["secret"], "secret"));
      c.eq(`neuron[${i}] secret -> pubkey`, bytesToHex(publicKeyFromSecret(secret, true)), o["pubkey"]);
    });
  });
  list(d["eip191"] ?? [], "eip191").forEach((item, i) => {
    c.run(`eip191[${i}]`, () => {
      const o = obj(item, "eip191 item");
      const text = str(o["text"], "text");
      c.eq(`eip191[${i}] digest`, bytesToHex(evmMessageDigest(text)), o["digest"]);
      const r = recoverEvm(text, hexToBytes(str(o["signature"], "signature")));
      c.ok(`eip191[${i}] recover`, r.ok);
      if (r.ok && r.identity.kind === "evm") c.eq(`eip191[${i}] address`, r.identity.address, o["address"]);
      const secret = hexToBytes(str(o["secret"], "secret"));
      c.eq(`eip191[${i}] secret -> address`, evmAddressFromPoint(publicKeyFromSecret(secret, false)), o["address"]);
      if (o["checksum_address"] !== undefined) c.eq(`eip191[${i}] checksum_address`, eip55(str(o["address"], "address")), o["checksum_address"]);
    });
  });
  list(d["witness_args"] ?? [], "witness_args").forEach((item, i) => {
    c.run(`witness_args[${i}]`, () => {
      const o = obj(item, "witness_args item");
      const lock = o["lock"] === null ? null : str(o["lock"], "lock");
      const inputType = o["input_type"] === undefined || o["input_type"] === null ? null : str(o["input_type"], "input_type");
      const outputType = o["output_type"] === undefined || o["output_type"] === null ? null : str(o["output_type"], "output_type");
      c.eq(`witness_args[${i}]`, witnessArgsMolecule(lock, inputType, outputType), o["serialized"]);
    });
  });
  return c.results;
}

export const VECTOR_CHECKERS: Readonly<Record<string, (path: string) => CheckResult[]>> = {
  "encoding.json": checkEncoding,
  "scripts.json": checkScripts,
  "signatures.json": checkSignatures,
  "carrier.json": checkCarrier,
  "messages.json": checkMessages,
  "replay.json": checkReplay,
  "external.json": checkExternal,
};

/** Checker for a vector file name; every `replay*.json` file uses the replay checker. */
export function checkerFor(file: string): ((path: string) => CheckResult[]) | undefined {
  return VECTOR_CHECKERS[file] ?? (/^replay[-_a-z0-9]*\.json$/.test(file) ? checkReplay : undefined);
}

/** Runs every checker; any *.json file without a checker is reported as a failure. */
export function checkVectorsDir(dir: string): CheckResult[] {
  const results: CheckResult[] = [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  for (const f of files) {
    const fn = checkerFor(f);
    if (!fn) {
      results.push({ file: f, name: "recognised", ok: false, detail: "no checker for this vector file (not verified)" });
      continue;
    }
    try {
      results.push(...fn(join(dir, f)));
    } catch (e) {
      results.push({ file: f, name: "load", ok: false, detail: `exception: ${(e as Error).message}` });
    }
  }
  return results;
}
