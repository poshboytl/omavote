/**
 * Replay input: the shape of vectors/replay.json without `expected`.
 *
 * {
 *   "network": {...}, "initial_roles_hash": "0x…", "process_publication_delay_ms": "259200000",
 *   "blocks": [{"number","hash","parent_hash","clock_ms","transactions":[
 *       {"hash","inputs":[{"tx_hash","index"}],"outputs":[{"index","capacity","lock","type","data"}],"witnesses":["0x…"]}]}]
 * }
 *
 * `clock_ms` is clock(b) of docs/03 §8 (parent median time). A dump may
 * instead (or additionally) carry each block's own header `timestamp_ms`; the
 * verifier then computes clock(b) itself as in docs/13 §4.9: the median of the
 * timestamps of parent(b) and its ancestors, at most `median_time_block_count`
 * (default 37) blocks, sorted, index len/2. When both are present they must agree.
 */
import { inputHexToBytes, isHash32 } from "./bytes.js";
import { InputError } from "./errors.js";
import { isObject, parseStrictJson, type JsonValue } from "./json.js";
import { parseScript, type ScriptJson } from "./molecule.js";
import { parseNetwork, type Network } from "./network.js";

export interface InputOutput {
  index: number;
  capacity: bigint;
  lock: ScriptJson;
  type: ScriptJson | null;
  data: Uint8Array;
}

export interface InputTx {
  hash: string;
  inputs: Array<{ txHash: string; index: number }>;
  outputs: InputOutput[];
  witnesses: Uint8Array[];
}

export interface InputBlock {
  number: number;
  hash: string;
  parentHash: string;
  clockMs: bigint;
  timestampMs: bigint | null;
  transactions: InputTx[];
}

/** docs/03 §8 research snapshot / docs/13 §4.9. */
export const DEFAULT_MEDIAN_TIME_BLOCK_COUNT = 37;

export interface ReplayInput {
  network: Network;
  initialRolesHash: string;
  processPublicationDelayMs: bigint;
  blocks: InputBlock[];
}

/** docs/03 §3.1: candidate 72 hours, used when the input does not specify it. */
export const DEFAULT_PROCESS_PUBLICATION_DELAY_MS = 72n * 60n * 60n * 1000n;

const DECIMAL = /^(0|[1-9][0-9]*)$/;

function dec(v: JsonValue | undefined, path: string): bigint {
  if (typeof v !== "string" || !DECIMAL.test(v) || v.length > 20) throw new InputError(`${path} must be a decimal string`);
  const n = BigInt(v);
  if (n >= 1n << 64n) throw new InputError(`${path} exceeds u64`);
  return n;
}

function smallInt(v: JsonValue | undefined, path: string): number {
  const n = dec(v, path);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new InputError(`${path} is too large`);
  return Number(n);
}

function hash(v: JsonValue | undefined, path: string): string {
  if (typeof v !== "string") throw new InputError(`${path} must be a hash string`);
  const lower = v.toLowerCase();
  if (!isHash32(lower)) throw new InputError(`${path} must be a 32-byte 0x-hex hash`);
  return lower;
}

function hexBytes(v: JsonValue | undefined, path: string): Uint8Array {
  if (typeof v !== "string") throw new InputError(`${path} must be a hex string`);
  try {
    return inputHexToBytes(v);
  } catch (e) {
    throw new InputError(`${path}: ${(e as Error).message}`);
  }
}

function arr(v: JsonValue | undefined, path: string): JsonValue[] {
  if (!Array.isArray(v)) throw new InputError(`${path} must be an array`);
  return v;
}

function script(v: JsonValue | undefined, path: string): ScriptJson {
  try {
    return parseScript(v, path);
  } catch (e) {
    throw new InputError((e as Error).message);
  }
}

function parseTx(v: JsonValue, path: string): InputTx {
  if (!isObject(v)) throw new InputError(`${path} must be an object`);
  const inputs = arr(v["inputs"], `${path}.inputs`).map((x, i) => {
    if (!isObject(x)) throw new InputError(`${path}.inputs[${i}] must be an object`);
    return { txHash: hash(x["tx_hash"], `${path}.inputs[${i}].tx_hash`), index: smallInt(x["index"], `${path}.inputs[${i}].index`) };
  });
  let last = -1;
  const outputs = arr(v["outputs"], `${path}.outputs`).map((x, i): InputOutput => {
    const p = `${path}.outputs[${i}]`;
    if (!isObject(x)) throw new InputError(`${p} must be an object`);
    const index = x["index"] === undefined ? i : smallInt(x["index"], `${p}.index`);
    if (index <= last) throw new InputError(`${p}.index must be strictly increasing`);
    last = index;
    const type = x["type"];
    return {
      index,
      capacity: dec(x["capacity"], `${p}.capacity`),
      lock: script(x["lock"], `${p}.lock`),
      type: type === null || type === undefined ? null : script(type, `${p}.type`),
      data: hexBytes(x["data"] ?? "0x", `${p}.data`),
    };
  });
  const witnesses = arr(v["witnesses"] ?? [], `${path}.witnesses`).map((w, i) => hexBytes(w, `${path}.witnesses[${i}]`));
  return { hash: hash(v["hash"], `${path}.hash`), inputs, outputs, witnesses };
}

export function parseReplayInputValue(root: JsonValue): ReplayInput {
  if (!isObject(root)) throw new InputError("replay input must be a JSON object");
  const network = parseNetwork(root["network"]);
  const initialRolesHash = hash(root["initial_roles_hash"], "initial_roles_hash");
  const delay = root["process_publication_delay_ms"];
  const processPublicationDelayMs = delay === undefined ? DEFAULT_PROCESS_PUBLICATION_DELAY_MS : dec(delay, "process_publication_delay_ms");
  const netObj = root["network"];
  const windowRaw = isObject(netObj) ? netObj["median_time_block_count"] : undefined;
  const medianWindow = windowRaw === undefined ? DEFAULT_MEDIAN_TIME_BLOCK_COUNT : smallInt(windowRaw, "network.median_time_block_count");
  if (medianWindow < 1) throw new InputError("network.median_time_block_count must be positive");
  const timestamps: bigint[] = [];
  const blocks = arr(root["blocks"], "blocks").map((b, i): InputBlock => {
    const p = `blocks[${i}]`;
    if (!isObject(b)) throw new InputError(`${p} must be an object`);
    const timestampMs = b["timestamp_ms"] === undefined ? null : dec(b["timestamp_ms"], `${p}.timestamp_ms`);
    let clockMs: bigint;
    if (timestampMs !== null && timestamps.length === i) {
      // clock(b) from the parent and its ancestors (genesis: its own timestamp; nothing happens there).
      const window = i === 0 ? [timestampMs] : timestamps.slice(Math.max(0, i - medianWindow), i);
      const sorted = [...window].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
      const computed = sorted[sorted.length >> 1] as bigint;
      if (b["clock_ms"] !== undefined) {
        const given = dec(b["clock_ms"], `${p}.clock_ms`);
        if (given !== computed) throw new InputError(`${p}.clock_ms ${given} differs from the median time ${computed} computed from timestamp_ms`);
      }
      clockMs = computed;
      timestamps.push(timestampMs);
    } else {
      clockMs = dec(b["clock_ms"], `${p}.clock_ms`);
    }
    return {
      number: smallInt(b["number"], `${p}.number`),
      hash: hash(b["hash"], `${p}.hash`),
      parentHash: hash(b["parent_hash"], `${p}.parent_hash`),
      clockMs,
      timestampMs,
      transactions: arr(b["transactions"], `${p}.transactions`).map((t, j) => parseTx(t, `${p}.transactions[${j}]`)),
    };
  });
  return { network, initialRolesHash, processPublicationDelayMs, blocks };
}

/** Parses the replay input file text (strict JSON, larger nesting allowance than payloads). */
export function parseReplayInput(text: string): ReplayInput {
  let root: JsonValue;
  try {
    root = parseStrictJson(text, { maxDepth: 64 });
  } catch (e) {
    throw new InputError(`replay input is not strict JSON: ${(e as Error).message}`);
  }
  return parseReplayInputValue(root);
}
