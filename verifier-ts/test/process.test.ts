/** Process roles and records (docs/03 §3.1): admission, attestation, governance status, ROLES_UPDATE. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DOMAIN, objectHash } from "../src/hash.js";
import type { JsonObject } from "../src/json.js";
import { KIND } from "../src/carrier.js";
import { HOUR, Scenario, Wallet, diagFor } from "./builder.js";

const START = 8;
const CLOSE_TRIGGER = START + 168;

function base(salt: string) {
  const s = new Scenario(salt);
  const A = new Wallet("A");
  const B = new Wallet("B");
  s.chain.deposit(A.secpLock(), 200_000n);
  s.chain.deposit(B.secpLock(), 100_000n);
  s.chain.mine(); // 2
  const m = s.publishManifest({ startBlock: START, proposers: [A] });
  s.chain.mine(); // 3
  return { s, m, A, B };
}

const admission = (s: Scenario, pollId: string, decision: string, anchorHeight: number, nonce?: string) =>
  s.record({ role: "coordinator", recordType: "ADMISSION", pollId, detail: { decision }, anchorHeight, signers: [s.coordinator], ...(nonce ? { nonce } : {}) });

test("ADMISSION: highest anchor among records included >= opening_confirmations blocks before b_s", () => {
  const { s, m } = base("admission");
  s.publishRecords(m.pollId, [admission(s, m.pollId, "ADMITTED", 3).envelope]);
  s.chain.mineUntil(6); // admitted at block 4
  const lateReject = admission(s, m.pollId, "REJECTED", 6);
  s.publishRecords(m.pollId, [lateReject.envelope]);
  s.chain.mineUntil(12); // REJECTED included at block 7: 8 - 7 = 1 < 2, does not qualify
  const r = s.run().report(m.pollId);
  assert.equal(r["admission"], "ADMITTED");
  assert.equal(r["formal"], true);
  assert.deepEqual(diagFor(r, lateReject.id), [], "a late record is valid but does not qualify");
});

test("ADMISSION: missing, only late, and same-anchor conflict", () => {
  const { s, m } = base("admission-2");
  s.chain.mineUntil(9);
  assert.equal(s.run().report(m.pollId)["admission"], "MISSING");
  s.publishRecords(m.pollId, [admission(s, m.pollId, "ADMITTED", 8).envelope]);
  s.chain.mine();
  assert.equal(s.run().report(m.pollId)["admission"], "LATE");

  const t = base("admission-3");
  const a1 = admission(t.s, t.m.pollId, "ADMITTED", 3);
  const a2 = admission(t.s, t.m.pollId, "REJECTED", 3);
  t.s.publishRecords(t.m.pollId, [a1.envelope, a2.envelope]);
  t.s.chain.mineUntil(10);
  const r = t.s.run().report(t.m.pollId);
  assert.equal(r["admission"], "RECORD_CONFLICT");
  assert.deepEqual(diagFor(r, a2.id), ["RECORD_CONFLICT"]);
  assert.equal(r["formal"], false);
});

test("committee threshold: non-members and duplicate signers are ignored; short records are invalid", () => {
  const { s, m } = base("threshold");
  const outsider = new Wallet("outsider");
  const [c1, c2] = s.committee as [Wallet, Wallet, Wallet];
  const one = s.record({ role: "committee", recordType: "GOVERNANCE_STATUS", pollId: m.pollId, detail: { status: "HOLD_EXECUTION" }, anchorHeight: 3, signers: [c1, c1, outsider] });
  const two = s.record({ role: "committee", recordType: "GOVERNANCE_STATUS", pollId: m.pollId, detail: { status: "CLEARED" }, anchorHeight: 3, signers: [outsider, c1, c2] });
  s.publishRecords(m.pollId, [one.envelope, two.envelope]);
  s.chain.mineUntil(10);
  const r = s.run().report(m.pollId);
  assert.deepEqual(diagFor(r, one.id), ["INSUFFICIENT_SIGNATURES"]);
  assert.deepEqual(diagFor(r, two.id), []);
  assert.equal(r["governance_status"], "CLEARED");
});

test("GOVERNANCE_STATUS: highest anchor wins, conflict shows HOLD_EXECUTION, replay of an old record cannot override", () => {
  const { s, m } = base("governance");
  const [c1, c2] = s.committee as [Wallet, Wallet, Wallet];
  const hold = s.record({ role: "committee", recordType: "GOVERNANCE_STATUS", pollId: m.pollId, detail: { status: "HOLD_EXECUTION" }, anchorHeight: 3, signers: [c1, c2] });
  s.publishRecords(m.pollId, [hold.envelope]);
  s.chain.mineUntil(5);
  const cleared = s.record({ role: "committee", recordType: "GOVERNANCE_STATUS", pollId: m.pollId, detail: { status: "CLEARED" }, anchorHeight: 5, signers: [c1, c2] });
  s.publishRecords(m.pollId, [cleared.envelope]);
  s.chain.mine(); // 6
  s.publishRecords(m.pollId, [hold.envelope]); // re-published old record
  s.chain.mine(); // 7
  let r = s.run().report(m.pollId);
  assert.equal(r["governance_status"], "CLEARED");
  assert.deepEqual(diagFor(r, hold.id), ["DUPLICATE"]);
  const voided = s.record({ role: "committee", recordType: "GOVERNANCE_STATUS", pollId: m.pollId, detail: { status: "VOIDED" }, anchorHeight: 5, signers: [c1, c2] });
  s.publishRecords(m.pollId, [voided.envelope]);
  s.chain.mine();
  r = s.run().report(m.pollId);
  assert.equal(r["governance_status"], "HOLD_EXECUTION");
});

test("RESULT_ATTESTATION: CONFIRMED only when result_hash and outcome both match the recomputation", () => {
  const { s, m, A, B } = base("attestation");
  s.chain.mineUntil(9);
  s.publishBallots(m, [s.ballot({ manifest: m, owner: A, action: "YES", anchorHeight: 8 }).envelope, s.ballot({ manifest: m, owner: B, action: "NO", anchorHeight: 8 }).envelope]);
  s.chain.mineUntil(CLOSE_TRIGGER);
  const pre = s.run().report(m.pollId);
  assert.equal(pre["attestation"], "NONE");
  const resultHash = pre["result_hash"] as string;
  assert.equal((pre["result_core"] as JsonObject)["outcome"], "PASS");
  const [c1, c2, c3] = s.committee as [Wallet, Wallet, Wallet];
  const att = (outcome: string, anchorHeight: number, hash = resultHash, signers = [c1, c2]) =>
    s.record({ role: "committee", recordType: "RESULT_ATTESTATION", pollId: m.pollId, detail: { result_hash: hash, outcome }, anchorHeight, signers });
  s.publishRecords(m.pollId, [att("PASS", CLOSE_TRIGGER).envelope]);
  s.chain.mine();
  assert.equal(s.run().report(m.pollId)["attestation"], "CONFIRMED");
  // A higher-anchor attestation whose outcome contradicts the result: disputed.
  s.publishRecords(m.pollId, [att("FAIL", CLOSE_TRIGGER + 1, resultHash, [c2, c3]).envelope]);
  s.chain.mine();
  assert.equal(s.run().report(m.pollId)["attestation"], "DISPUTED");
  // An even newer one with a wrong hash: still disputed.
  s.publishRecords(m.pollId, [att("PASS", CLOSE_TRIGGER + 2, `0x${"99".repeat(32)}`).envelope]);
  s.chain.mine();
  assert.equal(s.run().report(m.pollId)["attestation"], "DISPUTED");
  // Correct again with the highest anchor: confirmed.
  s.publishRecords(m.pollId, [att("PASS", CLOSE_TRIGGER + 3).envelope]);
  s.chain.mine();
  assert.equal(s.run().report(m.pollId)["attestation"], "CONFIRMED");
});

test("record anchors and publication deadlines", () => {
  const { s, m } = base("record-deadline");
  s.chain.mineUntil(80);
  const expired = admission(s, m.pollId, "ADMITTED", 3); // deadline clock(3) + 72h = block 75
  const wrongDeadline = s.record({ role: "coordinator", recordType: "NOTICE", pollId: m.pollId, detail: { code: "FORUM_EDITED" }, anchorHeight: 79, signers: [s.coordinator], deadlineMs: s.chain.clockOf(79) + 24n * HOUR });
  const notice = s.record({ role: "coordinator", recordType: "NOTICE", pollId: m.pollId, detail: { code: "FORUM_EDITED" }, anchorHeight: 80, signers: [s.coordinator] });
  s.publishRecords(m.pollId, [expired.envelope, wrongDeadline.envelope, notice.envelope]);
  s.chain.mine(); // 81
  const r = s.run().report(m.pollId);
  assert.deepEqual(diagFor(r, expired.id), ["PUBLICATION_EXPIRED"]);
  assert.deepEqual(diagFor(r, wrongDeadline.id), ["DEADLINE_MISMATCH"]);
  assert.deepEqual(diagFor(r, notice.id), []);
  assert.equal(((r["records"] as JsonObject)["notices"] as JsonObject[]).length, 1);
});

test("ROLES_UPDATE: committee threshold of the current roles, previous hash chain, effective from inclusion", () => {
  const { s, m } = base("roles");
  const [c1, c2, c3] = s.committee as [Wallet, Wallet, Wallet];
  const c4 = new Wallet("committee-4");
  const newRoles = s.makeRoles(s.rolesHash, "02", [c1, c2, c4]);
  const newHash = objectHash(DOMAIN.ROLES, newRoles);
  const bogusRoles = s.makeRoles(`0x${"ee".repeat(32)}`, "03", [c1, c2, c4]);
  const bogusHash = objectHash(DOMAIN.ROLES, bogusRoles);
  // Update before the new object is published: unavailable.
  const early = s.record({ role: "committee", recordType: "ROLES_UPDATE", pollId: null, detail: { new_roles_hash: newHash }, anchorHeight: 3, signers: [c1, c2], nonce: `0x${"01".repeat(32)}` });
  s.publishRecords(newHash, [early.envelope]);
  s.chain.mine(); // 4
  s.chain.carrier(KIND.PROCESS_ROLES, newHash, newRoles);
  s.chain.carrier(KIND.PROCESS_ROLES, bogusHash, bogusRoles);
  s.chain.mine(); // 5
  const chainMismatch = s.record({ role: "committee", recordType: "ROLES_UPDATE", pollId: null, detail: { new_roles_hash: bogusHash }, anchorHeight: 5, signers: [c1, c2] });
  const update = s.record({ role: "committee", recordType: "ROLES_UPDATE", pollId: null, detail: { new_roles_hash: newHash }, anchorHeight: 5, signers: [c2, c3] });
  s.publishRecords(bogusHash, [chainMismatch.envelope]);
  s.publishRecords(newHash, [update.envelope]);
  // Same block, later transaction: the new configuration is already in effect.
  // Old roles_hash after the update: no longer effective.
  const stale = s.record({ role: "coordinator", recordType: "ADMISSION", pollId: m.pollId, detail: { decision: "ADMITTED" }, anchorHeight: 5, signers: [s.coordinator], nonce: `0x${"0e".repeat(32)}` });
  const fresh = s.record({ rolesHash: newHash, role: "coordinator", recordType: "ADMISSION", pollId: m.pollId, detail: { decision: "ADMITTED" }, anchorHeight: 5, signers: [s.coordinator] });
  const byRemoved = s.record({ rolesHash: newHash, role: "committee", recordType: "GOVERNANCE_STATUS", pollId: m.pollId, detail: { status: "HOLD_EXECUTION" }, anchorHeight: 5, signers: [c3, c1] });
  s.publishRecords(m.pollId, [stale.envelope, fresh.envelope, byRemoved.envelope]);
  s.chain.mine(); // 6
  s.chain.mineUntil(10);
  const run = s.run();
  const codes = (x: { id: string }) => run.engine.diagnostics.filter((d) => d.id === x.id).map((d) => d.code);
  assert.deepEqual(codes(early), ["ROLES_UNAVAILABLE"]);
  assert.deepEqual(codes(chainMismatch), ["ROLES_CHAIN_MISMATCH"]);
  assert.deepEqual(codes(update), []);
  assert.deepEqual(codes(stale), ["ROLES_NOT_EFFECTIVE"]);
  assert.deepEqual(codes(fresh), [], "included at block 6 with 8 - 6 = 2 >= 2");
  assert.deepEqual(codes(byRemoved), ["INSUFFICIENT_SIGNATURES"], "removed member c3 no longer counts");
  assert.equal(run.engine.currentRolesHash, newHash);
  const report = run.full;
  assert.equal(((report["roles"] as JsonObject)["history"] as JsonObject[]).length, 2);
  assert.equal(run.report(m.pollId)["admission"], "ADMITTED");
});

test("role/type table is enforced and records need a published roles object", () => {
  const { s, m } = base("roles-table");
  const [c1, c2] = s.committee as [Wallet, Wallet, Wallet];
  const wrongRole = s.record({ role: "committee", recordType: "ADMISSION", pollId: m.pollId, detail: { decision: "ADMITTED" }, anchorHeight: 3, signers: [c1, c2] });
  s.publishRecords(m.pollId, [wrongRole.envelope]);
  s.chain.mine();
  const run = s.run();
  // The schema rejects the body before an id is relevant; it is reported as MALFORMED.
  assert.deepEqual(run.engine.diagnostics.filter((d) => d.id === wrongRole.id).map((d) => d.code), ["MALFORMED"]);
});
