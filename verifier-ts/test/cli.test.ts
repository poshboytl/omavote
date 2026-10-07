/** End-to-end CLI checks (requires `npm run build`). */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cliPath, vectorsDir } from "./paths.js";

const cli = cliPath();
const vectors = vectorsDir();

function run(args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}

test("check-vectors passes on the repository vectors", () => {
  const r = run(["check-vectors", vectors, "--quiet"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /all \d+ vector checks passed/);
});

test("check-vectors exits non-zero on a mismatch and on unknown files", () => {
  const dir = mkdtempSync(join(tmpdir(), "omavote-vectors-"));
  for (const f of readdirSync(vectors)) copyFileSync(join(vectors, f), join(dir, f));
  const replay = JSON.parse(readFileSync(join(dir, "replay.json"), "utf8"));
  replay.expected.result_hash = `0x${"00".repeat(32)}`;
  writeFileSync(join(dir, "replay.json"), JSON.stringify(replay));
  const r = run(["check-vectors", dir, "--quiet"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL replay\.json :: result_hash/);

  const dir2 = mkdtempSync(join(tmpdir(), "omavote-vectors-"));
  copyFileSync(join(vectors, "encoding.json"), join(dir2, "encoding.json"));
  writeFileSync(join(dir2, "mystery.json"), "{}");
  const r2 = run(["check-vectors", dir2, "--quiet"]);
  assert.equal(r2.status, 1);
  assert.match(r2.stdout, /mystery\.json/);
});

for (const file of readdirSync(vectors).filter((f) => /^replay[-_a-z0-9]*\.json$/.test(f))) {
  test(`replay --poll prints the expected object of vectors/${file}`, () => {
    const expected = JSON.parse(readFileSync(join(vectors, file), "utf8")).expected;
    const r = run(["replay", join(vectors, file), "--poll", expected.poll_id]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    for (const k of Object.keys(expected)) {
      assert.deepEqual(out[k], expected[k], k);
    }
  });
}

test("replay without --poll lists polls and global diagnostics", () => {
  const r = run(["replay", join(vectors, "replay.json")]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.polls.length, 1);
  assert.ok(Array.isArray(out.diagnostics));
  assert.equal(out.tip.number, "177");
});

test("replay rejects bad input and bad usage", () => {
  const dir = mkdtempSync(join(tmpdir(), "omavote-input-"));
  const bad = join(dir, "bad.json");
  writeFileSync(bad, '{"network":{"genesis_hash":1}}');
  assert.equal(run(["replay", bad]).status, 1);
  assert.equal(run(["replay"]).status, 2);
  assert.equal(run(["replay", join(vectors, "replay.json"), "--poll", "0x1234"]).status, 2);
  assert.equal(run(["replay", join(vectors, "replay.json"), "--poll", `0x${"00".repeat(32)}`]).status, 1);
  assert.equal(run(["nonsense"]).status, 2);
});
