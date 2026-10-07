/** Loads EVERY file in vectors/ and requires all checks to pass. */
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkVectorsDir, checkerFor } from "../src/vectors.js";
import { vectorsDir } from "./paths.js";

const dir = vectorsDir();
const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();

test("every vector file has a checker", () => {
  const missing = files.filter((f) => !checkerFor(f));
  assert.deepEqual(missing, [], `vector files without a checker: ${missing.join(", ")}`);
  assert.ok(files.includes("replay.json") && files.includes("messages.json"));
  assert.ok(files.includes("replay-edge.json"), "edge-case replay vector present");
});

for (const f of files) {
  test(`vectors/${f}`, () => {
    const fn = checkerFor(f);
    assert.ok(fn, `no checker for ${f}`);
    const results = fn(join(dir, f));
    assert.ok(results.length > 0, "checker produced no checks");
    const failed = results.filter((r) => !r.ok);
    assert.deepEqual(failed, [], failed.map((r) => `${r.name}: ${r.detail}`).join("\n"));
  });
}

test("checkVectorsDir aggregates all files without failures", () => {
  const results = checkVectorsDir(dir);
  assert.equal(results.filter((r) => !r.ok).length, 0);
  assert.deepEqual([...new Set(results.map((r) => r.file))].sort(), files);
});
