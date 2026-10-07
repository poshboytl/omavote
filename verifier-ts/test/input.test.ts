/** Replay input parsing, including clock(b) computed from header timestamps (docs/13 §4.9). */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { InputError } from "../src/errors.js";
import { parseStrictJson, toJsonValue, type JsonObject } from "../src/json.js";
import { parseReplayInputValue } from "../src/replay-input.js";
import { vectorsDir } from "./paths.js";

function chainWithTimestamps(n: number, ts: (i: number) => bigint, withClock?: (i: number) => bigint): JsonObject {
  const replay = parseStrictJson(readFileSync(join(vectorsDir(), "replay.json"), "utf8"), { maxDepth: 64 }) as JsonObject;
  const genesis = (replay["network"] as JsonObject)["genesis_hash"] as string;
  const blocks = [];
  let parent = `0x${"00".repeat(32)}`;
  for (let i = 0; i < n; i++) {
    const hash = i === 0 ? genesis : `0x${i.toString(16).padStart(64, "0")}`;
    const b: Record<string, unknown> = { number: String(i), hash, parent_hash: parent, timestamp_ms: ts(i).toString(), transactions: [] };
    if (withClock) b["clock_ms"] = withClock(i).toString();
    blocks.push(b);
    parent = hash;
  }
  return toJsonValue({ network: replay["network"], initial_roles_hash: replay["initial_roles_hash"], blocks }) as JsonObject;
}

test("clock(b) is the median of the 37 timestamps ending at parent(b)", () => {
  const input = parseReplayInputValue(chainWithTimestamps(60, (i) => BigInt(i) * 1000n));
  for (const b of input.blocks.slice(1)) {
    const i = b.number;
    const expected = i >= 37 ? BigInt(i - 37 + 18) * 1000n : BigInt(i >> 1) * 1000n;
    assert.equal(b.clockMs, expected, `block ${i}`);
  }
});

test("median is robust to out-of-order timestamps", () => {
  // Timestamps 0, 5000, 1000, 4000, 2000, 3000, ...: the median of the parent window, not the parent's timestamp.
  const ts = (i: number) => BigInt([0, 5, 1, 4, 2, 3, 9, 8][i] ?? i) * 1000n;
  const input = parseReplayInputValue(chainWithTimestamps(8, ts));
  // block 6: window = ts[0..5] = {0,5,1,4,2,3}s -> sorted 0,1,2,3,4,5 -> index 3 -> 3000
  assert.equal(input.blocks[6]?.clockMs, 3000n);
});

test("supplied clock_ms must agree with the computed median", () => {
  const ok = chainWithTimestamps(40, (i) => BigInt(i) * 1000n, (i) => (i >= 37 ? BigInt(i - 19) * 1000n : i === 0 ? 0n : BigInt(i >> 1) * 1000n));
  assert.doesNotThrow(() => parseReplayInputValue(ok));
  const bad = chainWithTimestamps(40, (i) => BigInt(i) * 1000n, (i) => BigInt(i) * 1000n);
  assert.throws(() => parseReplayInputValue(bad), InputError);
});

test("input integers must be decimal strings", () => {
  const replay = parseStrictJson(readFileSync(join(vectorsDir(), "replay.json"), "utf8"), { maxDepth: 64 }) as JsonObject;
  const blocks = replay["blocks"] as JsonObject[];
  (blocks[1] as JsonObject)["clock_ms"] = "0x10";
  assert.throws(() => parseReplayInputValue(replay), InputError);
});
