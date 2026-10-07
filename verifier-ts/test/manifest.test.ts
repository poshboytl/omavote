/** Manifest validation, proposer proofs and proposer eligibility (docs/03 §3, §3.1, docs/13 §4.1–§4.4). */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonObject, JsonValue } from "../src/json.js";
import { toJsonValue } from "../src/json.js";
import { DOMAIN, objectHash } from "../src/hash.js";
import { Scenario, Wallet } from "./builder.js";

function manifestCodes(s: Scenario, pollId: string): string[] {
  return s
    .run()
    .engine.diagnostics.filter((d) => d.kind === "manifest" && d.id === pollId)
    .map((d) => d.code);
}

function fresh(salt: string) {
  const s = new Scenario(salt);
  const A = new Wallet("A");
  s.chain.deposit(A.secpLock(), 200_000n);
  s.chain.mine();
  return { s, A };
}

function withRules(json: JsonObject, patch: Record<string, JsonValue>): JsonObject {
  const rules = toJsonValue({ ...(json["rules_profile"] as JsonObject), ...patch }) as JsonObject;
  return toJsonValue({ ...json, rules_profile: rules, rules_hash: objectHash(DOMAIN.RULES, rules) }) as JsonObject;
}

test("valid manifest registers once; republication is a DUPLICATE", () => {
  const { s, A } = fresh("m-dup");
  const m = s.publishManifest({ startBlock: 10, proposers: [A] });
  s.chain.mine();
  s.publishManifest({ startBlock: 10, proposers: [A] });
  s.chain.mine();
  const run = s.run();
  assert.ok(run.engine.polls.has(m.pollId));
  assert.deepEqual(manifestCodes(s, m.pollId), ["DUPLICATE"]);
});

test("schema violations are rejected with specific codes", () => {
  const { s, A } = fresh("m-schema");
  const good = s.manifestJson({ startBlock: 10, proposers: [A] });
  const cases: Array<[string, JsonObject, string]> = [
    ["unknown field", toJsonValue({ ...good, extra: "x" }) as JsonObject, "MALFORMED"],
    ["rules hash", toJsonValue({ ...good, rules_hash: `0x${"00".repeat(32)}` }) as JsonObject, "HASH_MISMATCH"],
    ["unsupported precision", withRules(good, { precision: "truncate-ckb" }), "UNSUPPORTED_RULES"],
    ["wrong genesis", toJsonValue({ ...good, network_genesis_hash: `0x${"01".repeat(32)}` }) as JsonObject, "WRONG_NETWORK"],
    ["wrong dao", toJsonValue({ ...good, dao_namespace: "other-dao" }) as JsonObject, "WRONG_NETWORK"],
    ["numeric string with leading zero", toJsonValue({ ...good, forum_topic_id: "01" }) as JsonObject, "MALFORMED"],
    ["voting period", toJsonValue({ ...good, end_ms: (BigInt(good["end_ms"] as string) + 1n).toString() }) as JsonObject, "MALFORMED"],
    ["meta rule with budget", toJsonValue({ ...good, proposal_type: "meta_rule" }) as JsonObject, "MALFORMED"],
    ["title control char", toJsonValue({ ...good, signing_title: "bad‮title" }) as JsonObject, "MALFORMED"],
  ];
  const registry = { owner_adapters: ["evm-personal-message-v1", "ckb-secp256k1-message-v1"], key_adapters: ["ckb-secp256k1-message-v1"] };
  cases.push(["unsorted registry", toJsonValue({ ...good, auth_registry: registry, auth_registry_hash: objectHash(DOMAIN.AUTH_REGISTRY, toJsonValue(registry)) }) as JsonObject, "MALFORMED"]);
  const unknownAdapter = { owner_adapters: ["ckb-secp256k1-message-v1", "joyid-v1"], key_adapters: [] };
  cases.push(["undefined adapter id", toJsonValue({ ...good, auth_registry: unknownAdapter, auth_registry_hash: objectHash(DOMAIN.AUTH_REGISTRY, toJsonValue(unknownAdapter)) }) as JsonObject, "UNKNOWN_ADAPTER"]);
  const ids: Array<[string, string, string]> = [];
  for (const [name, json, code] of cases) ids.push([name, s.publishManifestRaw(json, []), code]);
  s.chain.mine();
  const run = s.run();
  for (const [name, pollId, code] of ids) {
    assert.deepEqual(
      run.engine.diagnostics.filter((d) => d.id === pollId).map((d) => d.code),
      [code],
      name,
    );
    assert.ok(!run.engine.polls.has(pollId), name);
  }
});

test("proposer proofs: one per lock, signed by the lock owner with an accepted adapter", () => {
  const { s, A } = fresh("m-proofs");
  const B = new Wallet("B");
  const json = s.manifestJson({ startBlock: 10, proposers: [A] });
  const pollId = s.publishManifestRaw(json, []);
  s.chain.mine();
  s.publishManifestRaw(json, [s.proposerProof(json, A, "secp", B)]);
  s.chain.mine();
  s.publishManifestRaw(json, [s.proposerProof(json, A), s.proposerProof(json, A)]);
  s.chain.mine();
  s.publishManifestRaw(json, [s.proposerProof(json, A)], `0x${"34".repeat(32)}`);
  s.chain.mine();
  s.publishManifestRaw(json, [s.proposerProof(json, A)]);
  s.chain.mine();
  const run = s.run();
  assert.deepEqual(manifestCodes(s, pollId), ["MALFORMED", "WRONG_OWNER", "MALFORMED", "SCOPE_MISMATCH"]);
  const poll = run.engine.polls.get(pollId);
  assert.ok(poll, "the first valid publication registers the poll");
  assert.equal(poll?.manifestBlock.number, 7, "b_m is the first VALID inclusion (blocks 3-6 carried invalid publications)");
});

test("proposer eligibility is reported separately from the record-based admission view", () => {
  const s = new Scenario("m-eligibility");
  const P = new Wallet("P");
  s.chain.deposit(P.secpLock(), 99_999n);
  s.chain.mine();
  const m = s.publishManifest({ startBlock: 10, proposers: [P] });
  s.chain.mine();
  s.publishRecords(m.pollId, [s.record({ role: "coordinator", recordType: "ADMISSION", pollId: m.pollId, detail: { decision: "ADMITTED" }, anchorHeight: 3, signers: [s.coordinator] }).envelope]);
  s.chain.mineUntil(12);
  const r = s.run().report(m.pollId);
  assert.equal(r["admission"], "ADMITTED");
  const check = r["proposer_check"] as JsonObject;
  assert.equal(check["eligible"], false);
  assert.equal(check["observed_shannon"], (99_999n * 100_000_000n).toString());
  assert.equal(r["formal"], false);
});
