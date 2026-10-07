/**
 * State-machine scenarios after docs/11 §8 and docs/03 §6 (expected results
 * stated by the spec). All blocks are one hour apart; polls open at block 8
 * and, with the 7-day period, close at H_close = block 175.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ADAPTER_CKB } from "../src/adapter.js";
import { InputError } from "../src/errors.js";
import { runReplay } from "../src/replay.js";
import { parseReplayInputValue } from "../src/replay-input.js";
import { scriptHash } from "../src/molecule.js";
import type { JsonObject } from "../src/json.js";
import { CKB, DAY, HOUR, Scenario, TEMPLATES, Wallet, diagFor, ownerRow } from "./builder.js";
import { KIND } from "../src/carrier.js";
import { toJsonValue } from "../src/json.js";

const START = 8;
const CLOSE_TRIGGER = START + 168; // first block with clock >= end_ms

function setup(salt: string, deposits: Array<[Wallet, bigint]>, opts: { ownerKind?: Record<string, "secp" | "omni" | "pw"> } = {}) {
  const s = new Scenario(salt);
  for (const [w, ckb] of deposits) {
    const kind = opts.ownerKind?.[w.name] ?? "secp";
    s.chain.deposit(kind === "secp" ? w.secpLock() : kind === "omni" ? w.omniLock() : w.pwLock(), ckb);
  }
  s.chain.mine(); // block 2
  const proposer = deposits[0]?.[0] as Wallet;
  const m = s.publishManifest({ startBlock: START, proposers: [proposer] });
  s.chain.mine(); // block 3
  return { s, m };
}

const id = (w: Wallet, kind: "secp" | "omni" | "pw" = "secp") => scriptHash(kind === "secp" ? w.secpLock() : kind === "omni" ? w.omniLock() : w.pwLock());

test("direct votes, exact principal and PASS (51% inclusive, 3x quorum)", () => {
  const A = new Wallet("A");
  const B = new Wallet("B");
  const { s, m } = setup("basic", [
    [A, 200_000n],
    [B, 100_000n],
  ]);
  s.chain.mineUntil(8);
  s.publishBallots(m, [s.ballot({ manifest: m, owner: A, action: "YES", anchorHeight: 8 }).envelope, s.ballot({ manifest: m, owner: B, action: "NO", anchorHeight: 8 }).envelope]);
  s.chain.mineUntil(CLOSE_TRIGGER);
  const r = s.run().report(m.pollId);
  const core = r["result_core"] as JsonObject;
  assert.equal(r["status"], "CLOSED");
  assert.equal(core["yes_shannon"], (200_000n * CKB).toString());
  assert.equal(core["no_shannon"], (100_000n * CKB).toString());
  assert.equal(core["quorum_required_shannon"], (75_000n * CKB).toString());
  assert.equal(core["outcome"], "PASS");
  assert.equal(core["close_block_number"], "175");
  assert.equal((core["counted_cells"] as JsonObject[]).length, 2);
  assert.equal(r["admission"], "MISSING");
  assert.equal(r["formal"], false);
});

test("owner direct vote takes over the delegate layer, also against later delegate votes", () => {
  const A = new Wallet("A");
  const K = new Wallet("K");
  const { s, m } = setup("direct-priority", [[A, 200_000n]]);
  const g = s.control({ owner: A, action: "GRANT", key: K.evmDescriptor(), anchorHeight: 3 });
  s.publishControls([g.envelope]);
  s.chain.mineUntil(8);
  const d = { grantId: g.id, key: K, keyKind: "evm" as const };
  s.publishBallots(m, [s.ballot({ manifest: m, owner: A, action: "YES", anchorHeight: 8, delegate: d }).envelope]);
  s.chain.mine(); // 9
  const direct = s.ballot({ manifest: m, owner: A, action: "NO", anchorHeight: 9 });
  s.publishBallots(m, [direct.envelope]);
  s.chain.mine(); // 10
  s.publishBallots(m, [s.ballot({ manifest: m, owner: A, action: "YES", anchorHeight: 10, delegate: d }).envelope]);
  s.chain.mineUntil(CLOSE_TRIGGER);
  const r = s.run().report(m.pollId);
  const row = ownerRow(r, id(A)) as JsonObject;
  assert.equal(row["final_status"], "NO");
  assert.equal(row["ballot_id"], direct.id);
  assert.equal(row["authorization_id"], null);
});

test("direct CANCEL is final for the poll; CANCEL keeps the ballot id and counts zero", () => {
  const A = new Wallet("A");
  const K = new Wallet("K");
  const { s, m } = setup("direct-cancel", [[A, 200_000n]]);
  const g = s.control({ owner: A, action: "GRANT", key: K.secpDescriptor(), anchorHeight: 3 });
  s.publishControls([g.envelope]);
  s.chain.mineUntil(9);
  const c = s.ballot({ manifest: m, owner: A, action: "CANCEL", anchorHeight: 8 });
  s.publishBallots(m, [c.envelope]);
  s.chain.mine();
  s.publishBallots(m, [s.ballot({ manifest: m, owner: A, action: "YES", anchorHeight: 10, delegate: { grantId: g.id, key: K, keyKind: "secp" } }).envelope]);
  s.chain.mineUntil(CLOSE_TRIGGER);
  const r = s.run().report(m.pollId);
  const row = ownerRow(r, id(A)) as JsonObject;
  assert.equal(row["final_status"], "CANCEL");
  assert.equal(row["ballot_id"], c.id);
  assert.equal(row["counted_weight_shannon"], "0");
  assert.equal(row["eligible_principal_shannon"], (200_000n * CKB).toString());
  assert.equal(((r["result_core"] as JsonObject)["counted_cells"] as JsonObject[]).length, 0);
});

test("revotes are ordered by anchor only; a held-back older ballot cannot win; same-anchor different bodies conflict", () => {
  const A = new Wallet("A");
  const { s, m } = setup("anchors", [[A, 200_000n]]);
  s.chain.mineUntil(9);
  const held = s.ballot({ manifest: m, owner: A, action: "YES", anchorHeight: 8 }); // signed early, held back
  s.publishBallots(m, [s.ballot({ manifest: m, owner: A, action: "YES", anchorHeight: 9, nonce: `0x${"01".repeat(32)}` }).envelope]);
  s.chain.mine(); // 10
  const latest = s.ballot({ manifest: m, owner: A, action: "NO", anchorHeight: 10 });
  s.publishBallots(m, [latest.envelope]);
  s.chain.mine(); // 11
  s.publishBallots(m, [held.envelope]);
  s.chain.mine(); // 12
  // Same anchor (12), different bodies -> CONFLICT until a newer anchor resolves it.
  const c1 = s.ballot({ manifest: m, owner: A, action: "YES", anchorHeight: 12, nonce: `0x${"0a".repeat(32)}` });
  const c2 = s.ballot({ manifest: m, owner: A, action: "YES", anchorHeight: 12, nonce: `0x${"0b".repeat(32)}` });
  s.publishBallots(m, [c1.envelope, c2.envelope]);
  s.chain.mineUntil(CLOSE_TRIGGER);
  const out = s.run().report(m.pollId);
  const row = ownerRow(out, id(A)) as JsonObject;
  assert.equal(row["final_status"], "CONFLICT", "same choice but different body is still a conflict");
  assert.equal(row["ballot_id"], null);
  assert.equal(row["authorization_id"], null);
  assert.equal(row["counted_weight_shannon"], "0");
  assert.equal(row["eligible_principal_shannon"], (200_000n * CKB).toString());
  // The held-back ballot is valid (no diagnostic) but loses on anchor height.
  assert.deepEqual(diagFor(out, held.id), []);
});

test("a newer anchor resolves a conflict; the latest revote needs no intermediate publication", () => {
  const A = new Wallet("A");
  const { s, m } = setup("resolve", [[A, 200_000n]]);
  s.chain.mineUntil(9);
  s.publishBallots(m, [
    s.ballot({ manifest: m, owner: A, action: "YES", anchorHeight: 8, nonce: `0x${"0a".repeat(32)}` }).envelope,
    s.ballot({ manifest: m, owner: A, action: "NO", anchorHeight: 8, nonce: `0x${"0b".repeat(32)}` }).envelope,
  ]);
  s.chain.mineUntil(20);
  // Revote #2 (anchor 15) is never published; revote #3 (anchor 19) is published alone.
  const third = s.ballot({ manifest: m, owner: A, action: "CANCEL", anchorHeight: 19 });
  s.publishBallots(m, [third.envelope]);
  s.chain.mineUntil(CLOSE_TRIGGER);
  const row = ownerRow(s.run().report(m.pollId), id(A)) as JsonObject;
  assert.equal(row["final_status"], "CANCEL");
  assert.equal(row["ballot_id"], third.id);
});

test("11 §8: A expires day 10, B day 30; K votes YES on day 5 and NO on day 12", () => {
  const A = new Wallet("A");
  const B = new Wallet("B");
  const K = new Wallet("K");
  const { s, m } = setup("expiry", [
    [A, 200_000n],
    [B, 100_000n],
  ]);
  const gA = s.control({ owner: A, action: "GRANT", key: K.evmDescriptor(), anchorHeight: 3, expiresAtMs: s.chain.clockOf(40) });
  const gB = s.control({ owner: B, action: "GRANT", key: K.evmDescriptor(), anchorHeight: 3, expiresAtMs: s.chain.clockOf(120) });
  s.publishControls([gA.envelope, gB.envelope]);
  s.chain.mineUntil(20);
  const yesA = s.ballot({ manifest: m, owner: A, action: "YES", anchorHeight: 20, delegate: { grantId: gA.id, key: K, keyKind: "evm" } });
  const yesB = s.ballot({ manifest: m, owner: B, action: "YES", anchorHeight: 20, delegate: { grantId: gB.id, key: K, keyKind: "evm" } });
  s.publishBallots(m, [yesA.envelope, yesB.envelope]);
  s.chain.mineUntil(60);
  const noA = s.ballot({ manifest: m, owner: A, action: "NO", anchorHeight: 60, delegate: { grantId: gA.id, key: K, keyKind: "evm" } });
  const noB = s.ballot({ manifest: m, owner: B, action: "NO", anchorHeight: 60, delegate: { grantId: gB.id, key: K, keyKind: "evm" } });
  s.publishBallots(m, [noA.envelope, noB.envelope]);
  s.chain.mineUntil(CLOSE_TRIGGER);
  const r = s.run().report(m.pollId);
  assert.equal((ownerRow(r, id(A)) as JsonObject)["final_status"], "YES");
  assert.equal((ownerRow(r, id(B)) as JsonObject)["final_status"], "NO");
  assert.deepEqual(diagFor(r, noA.id), ["GRANT_EXPIRED"]);
  assert.deepEqual(diagFor(r, noB.id), []);
});

test("REVOKE STOP_ONLY keeps earlier delegate votes and stops new ones", () => {
  const A = new Wallet("A");
  const K = new Wallet("K");
  const { s, m } = setup("stop-only", [[A, 200_000n]]);
  const g = s.control({ owner: A, action: "GRANT", key: K.evmDescriptor(), anchorHeight: 3 });
  s.publishControls([g.envelope]);
  s.chain.mineUntil(9);
  const d = { grantId: g.id, key: K, keyKind: "evm" as const };
  const yes = s.ballot({ manifest: m, owner: A, action: "YES", anchorHeight: 8, delegate: d });
  s.publishBallots(m, [yes.envelope]);
  s.chain.mine(); // 10
  s.publishControls([s.control({ owner: A, action: "REVOKE", revokeMode: "STOP_ONLY", anchorHeight: 10 }).envelope]);
  s.chain.mine(); // 11
  const no = s.ballot({ manifest: m, owner: A, action: "NO", anchorHeight: 11, delegate: d });
  s.publishBallots(m, [no.envelope]);
  s.chain.mineUntil(CLOSE_TRIGGER);
  const r = s.run().report(m.pollId);
  const row = ownerRow(r, id(A)) as JsonObject;
  assert.equal(row["final_status"], "YES");
  assert.equal(row["ballot_id"], yes.id);
  assert.equal(row["authorization_id"], g.id);
  assert.deepEqual(diagFor(r, no.id), ["NO_ACTIVE_GRANT"]);
});

test("safe revocation (STOP_AND_CANCEL_OPEN) clears open polls only; renewal without a new vote stays excluded; a new grant + vote counts", () => {
  const A = new Wallet("A");
  const B = new Wallet("B");
  const K = new Wallet("K");
  const K2 = new Wallet("K2");
  const s = new Scenario("safe-revoke");
  s.chain.deposit(A.secpLock(), 200_000n);
  s.chain.deposit(B.secpLock(), 100_000n);
  s.chain.mine(); // 2
  const long = s.publishManifest({ startBlock: START, proposers: [A] });
  const short = s.publishManifest({ startBlock: START, proposers: [A], votingPeriodMs: 10n * HOUR, signingTitle: "Short poll" });
  const gA = s.control({ owner: A, action: "GRANT", key: K.evmDescriptor(), anchorHeight: 2 });
  const gB = s.control({ owner: B, action: "GRANT", key: K.evmDescriptor(), anchorHeight: 2 });
  s.publishControls([gA.envelope, gB.envelope]);
  s.chain.mineUntil(9);
  for (const m of [long, short]) {
    s.publishBallots(m, [
      s.ballot({ manifest: m, owner: A, action: "YES", anchorHeight: 8, delegate: { grantId: gA.id, key: K, keyKind: "evm" } }).envelope,
      s.ballot({ manifest: m, owner: B, action: "YES", anchorHeight: 8, delegate: { grantId: gB.id, key: K, keyKind: "evm" } }).envelope,
    ]);
  }
  s.chain.mineUntil(20); // the short poll closed at block 18 (H_close 17)
  s.publishControls([
    s.control({ owner: A, action: "REVOKE", revokeMode: "STOP_AND_CANCEL_OPEN", anchorHeight: 20 }).envelope,
    s.control({ owner: B, action: "REVOKE", revokeMode: "STOP_AND_CANCEL_OPEN", anchorHeight: 20 }).envelope,
  ]);
  s.chain.mine(); // 21
  // A renews with a new key but never votes again; B renews and votes NO.
  const gA2 = s.control({ owner: A, action: "GRANT", key: K2.evmDescriptor(), anchorHeight: 21 });
  const gB2 = s.control({ owner: B, action: "GRANT", key: K2.evmDescriptor(), anchorHeight: 21 });
  s.publishControls([gA2.envelope, gB2.envelope]);
  s.chain.mine(); // 22
  const bNo = s.ballot({ manifest: long, owner: B, action: "NO", anchorHeight: 22, delegate: { grantId: gB2.id, key: K2, keyKind: "evm" } });
  s.publishBallots(long, [bNo.envelope]);
  s.chain.mineUntil(CLOSE_TRIGGER);
  const run = s.run();
  const rLong = run.report(long.pollId);
  const rShort = run.report(short.pollId);
  const aLong = ownerRow(rLong, id(A)) as JsonObject;
  assert.equal(aLong["final_status"], "CANCELLED_BY_CONTROL");
  assert.equal(aLong["ballot_id"], null);
  assert.equal(aLong["authorization_id"], null);
  assert.equal(aLong["counted_weight_shannon"], "0");
  const bLong = ownerRow(rLong, id(B)) as JsonObject;
  assert.equal(bLong["final_status"], "NO");
  assert.equal(bLong["authorization_id"], gB2.id);
  assert.equal((ownerRow(rShort, id(A)) as JsonObject)["final_status"], "YES", "an already-closed poll is not changed");
  assert.equal((ownerRow(rShort, id(B)) as JsonObject)["final_status"], "YES");
  assert.equal((rShort["result_core"] as JsonObject)["close_block_number"], "17");
});

test("stale controls: a held-back GRANT with a lower anchor cannot override a newer one", () => {
  const A = new Wallet("A");
  const attacker = new Wallet("attacker");
  const K = new Wallet("K");
  const { s, m } = setup("stale", [[A, 200_000n]]);
  s.chain.mineUntil(4);
  const phish = s.control({ owner: A, action: "GRANT", key: attacker.evmDescriptor(), anchorHeight: 4 });
  s.chain.mineUntil(5);
  const good = s.control({ owner: A, action: "GRANT", key: K.evmDescriptor(), anchorHeight: 5 });
  s.publishControls([good.envelope]);
  s.chain.mine(); // 6
  s.publishControls([phish.envelope]);
  s.chain.mineUntil(9);
  const evil = s.ballot({ manifest: m, owner: A, action: "NO", anchorHeight: 8, delegate: { grantId: phish.id, key: attacker, keyKind: "evm" } });
  const mine = s.ballot({ manifest: m, owner: A, action: "YES", anchorHeight: 8, delegate: { grantId: good.id, key: K, keyKind: "evm" } });
  s.publishBallots(m, [evil.envelope, mine.envelope]);
  s.chain.mineUntil(CLOSE_TRIGGER);
  const run = s.run();
  const r = run.report(m.pollId);
  assert.deepEqual(
    run.engine.diagnostics.filter((d) => d.id === phish.id).map((d) => d.code),
    ["STALE_AUTHORIZATION"],
  );
  assert.deepEqual(diagFor(r, evil.id), ["NO_ACTIVE_GRANT"]);
  assert.equal((ownerRow(r, id(A)) as JsonObject)["final_status"], "YES");
});

test("REVOKE(anchor 10) then GRANT(anchor 12) published first: the revoke is stale, no barrier, old votes kept", () => {
  const A = new Wallet("A");
  const K1 = new Wallet("K1");
  const K2 = new Wallet("K2");
  const { s, m } = setup("revoke-order", [[A, 200_000n]]);
  const g1 = s.control({ owner: A, action: "GRANT", key: K1.evmDescriptor(), anchorHeight: 3 });
  s.publishControls([g1.envelope]);
  s.chain.mineUntil(9);
  const yes = s.ballot({ manifest: m, owner: A, action: "YES", anchorHeight: 8, delegate: { grantId: g1.id, key: K1, keyKind: "evm" } });
  s.publishBallots(m, [yes.envelope]);
  s.chain.mineUntil(12);
  const revoke = s.control({ owner: A, action: "REVOKE", revokeMode: "STOP_AND_CANCEL_OPEN", anchorHeight: 10 });
  const g2 = s.control({ owner: A, action: "GRANT", key: K2.evmDescriptor(), anchorHeight: 12 });
  s.publishControls([g2.envelope]);
  s.chain.mine(); // 13
  s.publishControls([revoke.envelope]);
  s.chain.mineUntil(CLOSE_TRIGGER);
  const run = s.run();
  assert.deepEqual(run.engine.diagnostics.filter((d) => d.id === revoke.id).map((d) => d.code), ["STALE_AUTHORIZATION"]);
  const row = ownerRow(run.report(m.pollId), id(A)) as JsonObject;
  assert.equal(row["final_status"], "YES");
  assert.equal(row["authorization_id"], g1.id);
});

test("AUTH_CONFLICT: same-anchor controls stop delegation and set a barrier; a higher-anchor grant + new vote recovers", () => {
  const A = new Wallet("A");
  const K1 = new Wallet("K1");
  const K2 = new Wallet("K2");
  const K3 = new Wallet("K3");
  const K4 = new Wallet("K4");
  const { s, m } = setup("auth-conflict", [[A, 200_000n]]);
  const g1 = s.control({ owner: A, action: "GRANT", key: K1.evmDescriptor(), anchorHeight: 3 });
  s.publishControls([g1.envelope]);
  s.chain.mineUntil(9);
  s.publishBallots(m, [s.ballot({ manifest: m, owner: A, action: "YES", anchorHeight: 8, delegate: { grantId: g1.id, key: K1, keyKind: "evm" } }).envelope]);
  s.chain.mineUntil(11);
  const g2 = s.control({ owner: A, action: "GRANT", key: K2.evmDescriptor(), anchorHeight: 10 });
  const g3 = s.control({ owner: A, action: "GRANT", key: K3.evmDescriptor(), anchorHeight: 10 });
  s.publishControls([g2.envelope]);
  s.chain.mine(); // 12
  s.publishControls([g3.envelope]);
  s.chain.mine(); // 13
  const blocked = s.ballot({ manifest: m, owner: A, action: "NO", anchorHeight: 12, delegate: { grantId: g2.id, key: K2, keyKind: "evm" } });
  s.publishBallots(m, [blocked.envelope]);
  s.chain.mine(); // 14
  // Before recovery the poll would show CANCELLED_BY_CONTROL; recover with a higher anchor.
  const g4 = s.control({ owner: A, action: "GRANT", key: K4.evmDescriptor(), anchorHeight: 14 });
  s.publishControls([g4.envelope]);
  s.chain.mine(); // 15
  const recovered = s.ballot({ manifest: m, owner: A, action: "NO", anchorHeight: 15, delegate: { grantId: g4.id, key: K4, keyKind: "evm" } });
  s.publishBallots(m, [recovered.envelope]);
  s.chain.mineUntil(CLOSE_TRIGGER);
  const run = s.run();
  const r = run.report(m.pollId);
  assert.deepEqual(run.engine.diagnostics.filter((d) => d.id === g3.id).map((d) => d.code), ["AUTH_CONFLICT"]);
  assert.deepEqual(diagFor(r, blocked.id), ["NO_ACTIVE_GRANT"]);
  const row = ownerRow(r, id(A)) as JsonObject;
  assert.equal(row["final_status"], "NO");
  assert.equal(row["ballot_id"], recovered.id);
  assert.equal(row["authorization_id"], g4.id);
});

test("AUTH_CONFLICT barrier without recovery yields CANCELLED_BY_CONTROL", () => {
  const A = new Wallet("A");
  const K1 = new Wallet("K1");
  const K2 = new Wallet("K2");
  const { s, m } = setup("auth-conflict-2", [[A, 200_000n]]);
  const g1 = s.control({ owner: A, action: "GRANT", key: K1.evmDescriptor(), anchorHeight: 3 });
  s.publishControls([g1.envelope]);
  s.chain.mineUntil(9);
  s.publishBallots(m, [s.ballot({ manifest: m, owner: A, action: "YES", anchorHeight: 8, delegate: { grantId: g1.id, key: K1, keyKind: "evm" } }).envelope]);
  s.chain.mine(); // 10
  // A different body at the current anchor height (3) of the effective grant.
  s.publishControls([s.control({ owner: A, action: "GRANT", key: K2.evmDescriptor(), anchorHeight: 3 }).envelope]);
  s.chain.mineUntil(CLOSE_TRIGGER);
  assert.equal((ownerRow(s.run().report(m.pollId), id(A)) as JsonObject)["final_status"], "CANCELLED_BY_CONTROL");
});

test("GRANT+CANCEL switches key and withdraws the old key's votes in one step", () => {
  const A = new Wallet("A");
  const K1 = new Wallet("K1");
  const K2 = new Wallet("K2");
  const { s, m } = setup("grant-cancel", [[A, 200_000n]]);
  const g1 = s.control({ owner: A, action: "GRANT", key: K1.evmDescriptor(), anchorHeight: 3 });
  s.publishControls([g1.envelope]);
  s.chain.mineUntil(9);
  s.publishBallots(m, [s.ballot({ manifest: m, owner: A, action: "YES", anchorHeight: 8, delegate: { grantId: g1.id, key: K1, keyKind: "evm" } }).envelope]);
  s.chain.mine(); // 10
  const g2 = s.control({ owner: A, action: "GRANT", key: K2.secpDescriptor(), anchorHeight: 9, revokeMode: "STOP_AND_CANCEL_OPEN" });
  s.publishControls([g2.envelope]);
  s.chain.mine(); // 11
  const no = s.ballot({ manifest: m, owner: A, action: "NO", anchorHeight: 11, delegate: { grantId: g2.id, key: K2, keyKind: "secp" } });
  s.publishBallots(m, [no.envelope]);
  s.chain.mineUntil(CLOSE_TRIGGER);
  const row = ownerRow(s.run().report(m.pollId), id(A)) as JsonObject;
  assert.equal(row["final_status"], "NO");
  assert.equal(row["authorization_id"], g2.id);
});

test("grant and ballot in one transaction: the grant must come first by output index", () => {
  const A = new Wallet("A");
  const B = new Wallet("B");
  const K = new Wallet("K");
  const { s, m } = setup("same-tx", [
    [A, 200_000n],
    [B, 100_000n],
  ]);
  s.chain.mineUntil(8);
  const gA = s.control({ owner: A, action: "GRANT", key: K.evmDescriptor(), anchorHeight: 8 });
  const gB = s.control({ owner: B, action: "GRANT", key: K.evmDescriptor(), anchorHeight: 8 });
  const bA = s.ballot({ manifest: m, owner: A, action: "YES", anchorHeight: 8, delegate: { grantId: gA.id, key: K, keyKind: "evm" } });
  const bB = s.ballot({ manifest: m, owner: B, action: "YES", anchorHeight: 8, delegate: { grantId: gB.id, key: K, keyKind: "evm" } });
  const tx1 = s.publishControls([gA.envelope]); // output 0: grant, output 1: ballot
  s.publishBallots(m, [bA.envelope], tx1);
  const tx2 = s.publishBallots(m, [bB.envelope]); // output 0: ballot, output 1: grant
  s.publishControls([gB.envelope], tx2);
  s.chain.mineUntil(CLOSE_TRIGGER);
  const r = s.run().report(m.pollId);
  assert.equal((ownerRow(r, id(A)) as JsonObject)["final_status"], "YES");
  assert.equal(ownerRow(r, id(B)), undefined, "B has no valid appearance");
  assert.deepEqual(diagFor(r, bB.id), ["NO_ACTIVE_GRANT"]);
});

test("time window [start_ms, end_ms) and delegate_cutoff_ms", () => {
  const A = new Wallet("A");
  const B = new Wallet("B");
  const K = new Wallet("K");
  const s = new Scenario("window");
  s.chain.deposit(A.secpLock(), 200_000n);
  s.chain.deposit(B.secpLock(), 100_000n);
  s.chain.mine();
  const m = s.publishManifest({ startBlock: START, proposers: [A], rules: { delegate_cutoff_ms: (2n * HOUR).toString() } });
  const g = s.control({ owner: B, action: "GRANT", key: K.evmDescriptor(), anchorHeight: 2 });
  s.publishControls([g.envelope]);
  s.chain.mineUntil(6);
  const early = s.ballot({ manifest: m, owner: A, action: "YES", anchorHeight: 6 });
  s.publishBallots(m, [early.envelope]); // block 7: clock < start
  s.chain.mineUntil(173);
  const lateDelegate = s.ballot({ manifest: m, owner: B, action: "YES", anchorHeight: 173, delegate: { grantId: g.id, key: K, keyKind: "evm" } });
  s.publishBallots(m, [lateDelegate.envelope]); // block 174 = end - 2h: inside the delegate cutoff
  s.chain.mine();
  const lastDirect = s.ballot({ manifest: m, owner: A, action: "NO", anchorHeight: 174 });
  s.publishBallots(m, [lastDirect.envelope]); // block 175: last eligible block
  s.chain.mine();
  const tooLate = s.ballot({ manifest: m, owner: B, action: "NO", anchorHeight: 175 });
  s.publishBallots(m, [tooLate.envelope]); // block 176: clock == end_ms
  s.chain.mine();
  const r = s.run().report(m.pollId);
  assert.deepEqual(diagFor(r, early.id), ["OUT_OF_WINDOW"]);
  assert.deepEqual(diagFor(r, lateDelegate.id), ["OUT_OF_WINDOW"]);
  assert.deepEqual(diagFor(r, tooLate.id), ["OUT_OF_WINDOW"]);
  assert.equal((ownerRow(r, id(A)) as JsonObject)["final_status"], "NO");
  assert.equal(ownerRow(r, id(B)), undefined);
});

test("deposit eligibility at inclusion; CANCEL without deposit; final principal at H_close", () => {
  const A = new Wallet("A");
  const B = new Wallet("B");
  const C = new Wallet("C");
  const D = new Wallet("D");
  const s = new Scenario("deposits");
  const aCell = s.chain.deposit(A.secpLock(), 200_000n);
  s.chain.deposit(D.secpLock(), 50_000n);
  s.chain.mine(); // 2
  const m = s.publishManifest({ startBlock: START, proposers: [A] });
  s.chain.mineUntil(9);
  const bYes = s.ballot({ manifest: m, owner: B, action: "YES", anchorHeight: 8 });
  const cCancel = s.ballot({ manifest: m, owner: C, action: "CANCEL", anchorHeight: 8 });
  s.publishBallots(m, [bYes.envelope, cCancel.envelope]);
  s.chain.mine(); // 10
  // B deposits and re-sends the same YES in the same transaction (deposit processed before carriers).
  const tx = s.chain.newTx();
  tx.outputs.push({ index: "0", capacity: (30_000n * CKB).toString(), lock: toJsonValue(B.secpLock()), type: { ...TEMPLATES.dao, args: "0x" }, data: "0x0000000000000000" });
  s.chain.add(tx);
  s.publishBallots(m, [bYes.envelope], tx);
  // A votes YES then starts withdrawing (deposit spent) before the close; D votes and adds more.
  s.publishBallots(m, [s.ballot({ manifest: m, owner: A, action: "YES", anchorHeight: 9 }).envelope, s.ballot({ manifest: m, owner: D, action: "NO", anchorHeight: 9 }).envelope]);
  s.chain.mine(); // 11
  s.chain.spend(aCell);
  s.chain.deposit(D.secpLock(), 25_000n);
  s.chain.mineUntil(CLOSE_TRIGGER);
  const r = s.run().report(m.pollId);
  const codes = (r["diagnostics"] as JsonObject[]).map((d) => `${d["id"]}:${d["code"]}`);
  assert.ok(codes.includes(`${bYes.id}:NO_DEPOSIT_AT_CAST`), "first appearance rejected");
  const bRow = ownerRow(r, id(B)) as JsonObject;
  assert.equal(bRow["final_status"], "YES", "the later valid appearance of the same ballot counts");
  assert.equal(bRow["counted_weight_shannon"], (30_000n * CKB).toString());
  const cRow = ownerRow(r, id(C)) as JsonObject;
  assert.equal(cRow["final_status"], "CANCEL");
  assert.equal(cRow["eligible_principal_shannon"], "0");
  const aRow = ownerRow(r, id(A)) as JsonObject;
  assert.equal(aRow["final_status"], "YES", "the choice is kept even with zero final principal");
  assert.equal(aRow["counted_weight_shannon"], "0");
  assert.ok(codes.includes(`${id(A)}:ZERO_FINAL_WEIGHT`));
  assert.equal((ownerRow(r, id(D)) as JsonObject)["counted_weight_shannon"], (75_000n * CKB).toString());
  const cells = (r["result_core"] as JsonObject)["counted_cells"] as JsonObject[];
  assert.equal(cells.length, 3, "B's cell and D's two cells");
  const sorted = [...cells].sort((x, y) => ((x["tx_hash"] as string) < (y["tx_hash"] as string) ? -1 : 1));
  assert.deepEqual(cells, sorted);
});

test("LATE_MANIFEST: no result and ballots rejected", () => {
  const A = new Wallet("A");
  const s = new Scenario("late");
  s.chain.deposit(A.secpLock(), 200_000n);
  s.chain.mineUntil(6);
  const m = s.publishManifest({ startBlock: START, proposers: [A] }); // included at block 7, b_s = 8: gap 1 < 2
  s.chain.mineUntil(9);
  const b = s.ballot({ manifest: m, owner: A, action: "YES", anchorHeight: 8 });
  s.publishBallots(m, [b.envelope]);
  s.chain.mineUntil(CLOSE_TRIGGER);
  const r = s.run().report(m.pollId);
  assert.equal(r["status"], "LATE_MANIFEST");
  assert.equal(r["result_core"], null);
  assert.equal(r["result_hash"], null);
  assert.deepEqual(diagFor(r, b.id), ["LATE_MANIFEST"]);
  assert.equal(r["formal"], false);
});

test("anchor validity, duplicates and unknown polls", () => {
  const A = new Wallet("A");
  const B = new Wallet("B");
  const { s, m } = setup("anchor-dup", [
    [A, 200_000n],
    [B, 100_000n],
  ]);
  s.chain.mineUntil(9);
  const unknownAnchor = s.ballot({ manifest: m, owner: A, action: "YES", anchorHeight: 9, anchorHash: `0x${"77".repeat(32)}` });
  const selfAnchor = s.ballot({ manifest: m, owner: A, action: "NO", anchorHeight: 9, anchorHash: s.chain.futureHash(10) });
  const good = s.ballot({ manifest: m, owner: B, action: "NO", anchorHeight: 9 });
  s.publishBallots(m, [unknownAnchor.envelope, selfAnchor.envelope, good.envelope]);
  s.chain.mine(); // 10
  s.publishBallots(m, [good.envelope]);
  s.chain.mineUntil(CLOSE_TRIGGER);
  const r = s.run().report(m.pollId);
  assert.deepEqual(diagFor(r, unknownAnchor.id), ["ANCHOR_INVALID"]);
  assert.deepEqual(diagFor(r, selfAnchor.id), ["ANCHOR_INVALID"]);
  assert.deepEqual(diagFor(r, good.id), ["DUPLICATE"]);
  assert.equal((r["result_core"] as JsonObject)["no_shannon"], (100_000n * CKB).toString());
  assert.equal(ownerRow(r, id(A)), undefined);
});

test("adapter acceptance, wrong owner, wrong key and invalid signatures", () => {
  const A = new Wallet("A");
  const E = new Wallet("E"); // EVM-controlled Omnilock owner
  const K = new Wallet("K");
  const X = new Wallet("X");
  const s = new Scenario("adapters");
  s.chain.deposit(A.secpLock(), 200_000n);
  s.chain.deposit(E.omniLock(), 100_000n);
  s.chain.mine();
  const m = s.publishManifest({ startBlock: START, proposers: [A], ownerAdapters: [ADAPTER_CKB], keyAdapters: [ADAPTER_CKB] });
  const gEvmKey = s.control({ owner: A, action: "GRANT", key: K.evmDescriptor(), anchorHeight: 2 });
  s.publishControls([gEvmKey.envelope]);
  s.chain.mineUntil(9);
  const omni = s.ballot({ manifest: m, owner: E, ownerKind: "omni", action: "YES", anchorHeight: 8 });
  const evmKey = s.ballot({ manifest: m, owner: A, action: "YES", anchorHeight: 8, delegate: { grantId: gEvmKey.id, key: K, keyKind: "evm" } });
  const forged = s.ballot({ manifest: m, owner: A, action: "NO", anchorHeight: 8, signer: X });
  s.publishBallots(m, [omni.envelope, evmKey.envelope, forged.envelope]);
  s.chain.mineUntil(CLOSE_TRIGGER);
  const r = s.run().report(m.pollId);
  assert.deepEqual(diagFor(r, omni.id), ["ADAPTER_NOT_ACCEPTED"]);
  assert.deepEqual(diagFor(r, evmKey.id), ["ADAPTER_NOT_ACCEPTED"]);
  assert.deepEqual(diagFor(r, forged.id), ["WRONG_OWNER"]);
  assert.equal(((r["result_core"] as JsonObject)["owners"] as JsonObject[]).length, 0);

  // Same keys under a permissive registry: delegate checks for owner and key binding.
  const s2 = new Scenario("adapters-2");
  s2.chain.deposit(A.secpLock(), 200_000n);
  s2.chain.deposit(E.omniLock(), 100_000n);
  s2.chain.mine();
  const m2 = s2.publishManifest({ startBlock: START, proposers: [A] });
  const g = s2.control({ owner: A, action: "GRANT", key: K.secpDescriptor(), anchorHeight: 2 });
  s2.publishControls([g.envelope]);
  s2.chain.mineUntil(9);
  const omniOk = s2.ballot({ manifest: m2, owner: E, ownerKind: "omni", action: "YES", anchorHeight: 8 });
  const otherOwner = s2.ballot({ manifest: m2, owner: E, ownerKind: "omni", action: "NO", anchorHeight: 8, delegate: { grantId: g.id, key: K, keyKind: "secp" } });
  const wrongKey = s2.ballot({ manifest: m2, owner: A, action: "NO", anchorHeight: 8, delegate: { grantId: g.id, key: X, keyKind: "secp" } });
  const badSig = s2.ballot({ manifest: m2, owner: A, action: "NO", anchorHeight: 8, nonce: `0x${"0c".repeat(32)}`, delegate: { grantId: g.id, key: K, keyKind: "secp" }, signer: X });
  s2.publishBallots(m2, [omniOk.envelope, otherOwner.envelope, wrongKey.envelope, badSig.envelope]);
  s2.chain.mineUntil(CLOSE_TRIGGER);
  const r2 = s2.run().report(m2.pollId);
  assert.deepEqual(diagFor(r2, omniOk.id), []);
  assert.deepEqual(diagFor(r2, otherOwner.id), ["WRONG_OWNER"]);
  assert.deepEqual(diagFor(r2, wrongKey.id), ["WRONG_KEY"]);
  assert.deepEqual(diagFor(r2, badSig.id), ["INVALID_SIGNATURE"]);
  assert.equal((ownerRow(r2, id(E, "omni")) as JsonObject)["final_status"], "YES");
});

test("narrowing a later poll's registry never revives a revoked authorization", () => {
  const A = new Wallet("A");
  const E = new Wallet("E");
  const K = new Wallet("K");
  const s = new Scenario("narrow");
  s.chain.deposit(A.secpLock(), 200_000n);
  s.chain.deposit(E.omniLock(), 200_000n);
  s.chain.mine();
  const g = s.control({ owner: A, action: "GRANT", key: K.evmDescriptor(), anchorHeight: 1 });
  s.publishControls([g.envelope]);
  s.chain.mine(); // 3
  s.publishControls([s.control({ owner: A, action: "REVOKE", revokeMode: "STOP_ONLY", anchorHeight: 3 }).envelope]);
  s.chain.mine(); // 4
  const full = s.publishManifest({ startBlock: START, proposers: [A] });
  const narrow = s.publishManifest({ startBlock: START, proposers: [E], proposerKind: "omni", ownerAdapters: ["evm-personal-message-v1"], signingTitle: "Narrow poll" });
  s.chain.mineUntil(9);
  const d = { grantId: g.id, key: K, keyKind: "evm" as const };
  const b1 = s.ballot({ manifest: full, owner: A, action: "YES", anchorHeight: 8, delegate: d });
  const b2 = s.ballot({ manifest: narrow, owner: A, action: "YES", anchorHeight: 8, delegate: d });
  s.publishBallots(full, [b1.envelope]);
  s.publishBallots(narrow, [b2.envelope]);
  s.chain.mineUntil(CLOSE_TRIGGER);
  const run = s.run();
  assert.deepEqual(diagFor(run.report(full.pollId), b1.id), ["NO_ACTIVE_GRANT"]);
  assert.deepEqual(diagFor(run.report(narrow.pollId), b2.id), ["ADAPTER_NOT_ACCEPTED"]);
  assert.equal(ownerRow(run.report(narrow.pollId), id(A)), undefined);
});

test("control validity: publication deadline, term limit, unknown policy, wrong owner key", () => {
  const A = new Wallet("A");
  const K = new Wallet("K");
  const X = new Wallet("X");
  const s = new Scenario("control-validity");
  s.chain.deposit(A.secpLock(), 200_000n);
  s.chain.mineUntil(30);
  const late = s.control({ owner: A, action: "GRANT", key: K.evmDescriptor(), anchorHeight: 2, nonce: `0x${"01".repeat(32)}` }); // deadline = clock(2)+24h = block 26
  const tooLong = s.control({ owner: A, action: "GRANT", key: K.evmDescriptor(), anchorHeight: 29, termMs: 366n * DAY });
  const wrongDeadline = s.control({ owner: A, action: "GRANT", key: K.evmDescriptor(), anchorHeight: 29, deadlineMs: s.chain.clockOf(29) + 2n * DAY });
  const forged = s.control({ owner: A, action: "GRANT", key: K.evmDescriptor(), anchorHeight: 29, signer: X, nonce: `0x${"02".repeat(32)}` });
  s.publishControls([late.envelope, tooLong.envelope, wrongDeadline.envelope, forged.envelope]);
  const unknownPolicy = `0x${"5a".repeat(32)}`;
  const orphan = s.control({ owner: A, action: "GRANT", key: K.evmDescriptor(), anchorHeight: 29, policyHash: unknownPolicy });
  s.chain.carrier(KIND.AUTHORIZATION_BATCH, unknownPolicy, toJsonValue({ protocol_version: "2", envelopes: [orphan.envelope] }));
  const ok = s.control({ owner: A, action: "GRANT", key: K.evmDescriptor(), anchorHeight: 29, termMs: 365n * DAY });
  s.publishControls([ok.envelope]);
  s.chain.mine(); // 31
  const run = s.run();
  const codeOf = (x: { id: string }) => run.engine.diagnostics.filter((d) => d.id === x.id).map((d) => d.code);
  assert.deepEqual(codeOf(late), ["PUBLICATION_EXPIRED"]);
  assert.deepEqual(codeOf(tooLong), ["EXPIRY_INVALID"]);
  assert.deepEqual(codeOf(wrongDeadline), ["DEADLINE_MISMATCH"]);
  assert.deepEqual(codeOf(forged), ["WRONG_OWNER"]);
  assert.deepEqual(codeOf(orphan), ["POLICY_UNKNOWN"]);
  assert.deepEqual(codeOf(ok), []);
  assert.ok(run.engine.validControls.has(ok.id));
});

test("threshold boundaries: inclusive vs strict at exactly 51%, quorum equality, meta-rule 67%", () => {
  const Y = new Wallet("Y");
  const N = new Wallet("N");
  for (const [cmp, expected] of [
    ["inclusive", "PASS"],
    ["strict", "FAIL"],
  ] as const) {
    const s = new Scenario(`threshold-${cmp}`);
    s.chain.deposit(Y.secpLock(), 51n);
    s.chain.deposit(N.secpLock(), 49n);
    s.chain.mine();
    // quorum = 3 * base = exactly 100 CKB = Y + N
    const m = s.publishManifest({ startBlock: START, proposers: [Y], budgetCkb: 1_000n, quorumBaseCkb: 0n, rules: { threshold_comparison: cmp, proposer_min_deposit_shannon: "0" } });
    s.chain.mineUntil(9);
    s.publishBallots(m, [s.ballot({ manifest: m, owner: Y, action: "YES", anchorHeight: 8 }).envelope, s.ballot({ manifest: m, owner: N, action: "NO", anchorHeight: 8 }).envelope]);
    s.chain.mineUntil(CLOSE_TRIGGER);
    const core = s.run().report(m.pollId)["result_core"] as JsonObject;
    assert.equal(core["outcome"], expected, cmp);
    assert.equal(core["threshold_comparison"], cmp);
  }
  // Quorum equality with 3 x base.
  const s = new Scenario("quorum-edge");
  s.chain.deposit(Y.secpLock(), 300n);
  s.chain.mine();
  const m = s.publishManifest({ startBlock: START, proposers: [Y], budgetCkb: 100n, rules: { proposer_min_deposit_shannon: "0" } });
  s.chain.mineUntil(9);
  s.publishBallots(m, [s.ballot({ manifest: m, owner: Y, action: "YES", anchorHeight: 8 }).envelope]);
  s.chain.mineUntil(CLOSE_TRIGGER);
  const core = s.run().report(m.pollId)["result_core"] as JsonObject;
  assert.equal(core["quorum_required_shannon"], (300n * CKB).toString());
  assert.equal(core["outcome"], "PASS");
  // Meta-rule: fixed 185,000,000 CKB quorum and 67/100.
  const s3 = new Scenario("meta");
  s3.chain.deposit(Y.secpLock(), 200_000_000n);
  s3.chain.deposit(N.secpLock(), 100_000_000n);
  s3.chain.mine();
  const mm = s3.publishManifest({ startBlock: START, proposers: [Y], proposalType: "meta_rule" });
  s3.chain.mineUntil(9);
  s3.publishBallots(mm, [s3.ballot({ manifest: mm, owner: Y, action: "YES", anchorHeight: 8 }).envelope, s3.ballot({ manifest: mm, owner: N, action: "NO", anchorHeight: 8 }).envelope]);
  s3.chain.mineUntil(CLOSE_TRIGGER);
  const c3 = s3.run().report(mm.pollId)["result_core"] as JsonObject;
  assert.equal(c3["quorum_required_shannon"], "18500000000000000");
  assert.equal(c3["approval_numerator"], "67");
  assert.equal(c3["outcome"], "FAIL", "66.67% < 67%");
});

test("open polls report no result; replay must start at genesis and be continuous", () => {
  const A = new Wallet("A");
  const { s, m } = setup("open", [[A, 200_000n]]);
  s.chain.mineUntil(20);
  const r = s.run().report(m.pollId);
  assert.equal(r["status"], "OPEN");
  assert.equal(r["result_core"], null);
  const broken = s.inputJson();
  ((broken["blocks"] as JsonObject[])[5] as JsonObject)["parent_hash"] = `0x${"00".repeat(32)}`;
  assert.throws(() => runReplay(parseReplayInputValue(broken)), InputError);
  const headless = s.inputJson();
  (headless["blocks"] as JsonObject[]).shift();
  assert.throws(() => runReplay(parseReplayInputValue(headless)), InputError);
});

// ---------------------------------------------------------------------------
// Remaining docs/11 §8 rows

test("11 §8: YES published, NO signed but withheld, CANCEL published; the withheld NO later loses", () => {
  const A = new Wallet("A");
  const { s, m } = setup("withheld", [[A, 200_000n]]);
  s.chain.mineUntil(9);
  s.publishBallots(m, [s.ballot({ manifest: m, owner: A, action: "YES", anchorHeight: 8 }).envelope]);
  s.chain.mineUntil(15);
  const withheld = s.ballot({ manifest: m, owner: A, action: "NO", anchorHeight: 15 });
  s.chain.mineUntil(19);
  const cancel = s.ballot({ manifest: m, owner: A, action: "CANCEL", anchorHeight: 19 });
  s.publishBallots(m, [cancel.envelope]);
  s.chain.mineUntil(30);
  s.publishBallots(m, [withheld.envelope]);
  s.chain.mineUntil(CLOSE_TRIGGER);
  const r = s.run().report(m.pollId);
  const row = ownerRow(r, id(A)) as JsonObject;
  assert.equal(row["final_status"], "CANCEL");
  assert.equal(row["ballot_id"], cancel.id);
  assert.deepEqual(diagFor(r, withheld.id), [], "valid appearance, but older anchor");
  assert.equal((r["result_core"] as JsonObject)["participation_shannon"], "0");
});

test("11 §8: K1 voted YES; owner switches to K2 (plain GRANT): YES kept until K2 votes NO", () => {
  const A = new Wallet("A");
  const K1 = new Wallet("K1");
  const K2 = new Wallet("K2");
  const { s, m } = setup("switch", [[A, 200_000n]]);
  const g1 = s.control({ owner: A, action: "GRANT", key: K1.evmDescriptor(), anchorHeight: 3 });
  s.publishControls([g1.envelope]);
  s.chain.mineUntil(9);
  const yes = s.ballot({ manifest: m, owner: A, action: "YES", anchorHeight: 8, delegate: { grantId: g1.id, key: K1, keyKind: "evm" } });
  s.publishBallots(m, [yes.envelope]);
  s.chain.mineUntil(20);
  const g2 = s.control({ owner: A, action: "GRANT", key: K2.evmDescriptor(), anchorHeight: 20 });
  s.publishControls([g2.envelope]);
  s.chain.mineUntil(30);
  // Old key can no longer vote; its earlier YES stays.
  const k1Again = s.ballot({ manifest: m, owner: A, action: "NO", anchorHeight: 30, delegate: { grantId: g1.id, key: K1, keyKind: "evm" } });
  s.publishBallots(m, [k1Again.envelope]);
  s.chain.mineUntil(CLOSE_TRIGGER);
  let r = s.run().report(m.pollId);
  assert.deepEqual(diagFor(r, k1Again.id), ["NO_ACTIVE_GRANT"]);
  assert.equal((ownerRow(r, id(A)) as JsonObject)["final_status"], "YES");

  const t = setup("switch-2", [[A, 200_000n]]);
  const h1 = t.s.control({ owner: A, action: "GRANT", key: K1.evmDescriptor(), anchorHeight: 3 });
  t.s.publishControls([h1.envelope]);
  t.s.chain.mineUntil(9);
  // K1's ballot carries a HIGHER ballot anchor than K2's later ballot: the grant anchor decides first.
  t.s.chain.mineUntil(40);
  t.s.publishBallots(t.m, [t.s.ballot({ manifest: t.m, owner: A, action: "YES", anchorHeight: 40, delegate: { grantId: h1.id, key: K1, keyKind: "evm" } }).envelope]);
  t.s.chain.mine(); // 41
  // Anchored at block 20 (> h1's anchor 3) and still within its 24 h publication deadline (block 44).
  const h2 = t.s.control({ owner: A, action: "GRANT", key: K2.evmDescriptor(), anchorHeight: 20 });
  t.s.publishControls([h2.envelope]);
  t.s.chain.mine(); // 42
  const k2No = t.s.ballot({ manifest: t.m, owner: A, action: "NO", anchorHeight: 25, delegate: { grantId: h2.id, key: K2, keyKind: "evm" } });
  t.s.publishBallots(t.m, [k2No.envelope]);
  t.s.chain.mineUntil(CLOSE_TRIGGER);
  r = t.s.run().report(t.m.pollId);
  const row = ownerRow(r, id(A)) as JsonObject;
  assert.equal(row["final_status"], "NO", "(grant anchor 20, ballot anchor 25) > (grant anchor 3, ballot anchor 40)");
  assert.equal(row["authorization_id"], h2.id);
});

test("11 §8: an older GRANT published after a newer REVOKE does not restore authorization", () => {
  const A = new Wallet("A");
  const K = new Wallet("K");
  const { s, m } = setup("grant-after-revoke", [[A, 200_000n]]);
  s.chain.mineUntil(9);
  const held = s.control({ owner: A, action: "GRANT", key: K.evmDescriptor(), anchorHeight: 9 });
  s.chain.mine(); // 10
  s.publishControls([s.control({ owner: A, action: "REVOKE", revokeMode: "STOP_ONLY", anchorHeight: 10 }).envelope]);
  s.chain.mine(); // 11
  s.publishControls([held.envelope]);
  s.chain.mine(); // 12
  const b = s.ballot({ manifest: m, owner: A, action: "YES", anchorHeight: 12, delegate: { grantId: held.id, key: K, keyKind: "evm" } });
  s.publishBallots(m, [b.envelope]);
  s.chain.mineUntil(CLOSE_TRIGGER);
  const run = s.run();
  assert.deepEqual(run.engine.diagnostics.filter((d) => d.id === held.id).map((d) => d.code), ["STALE_AUTHORIZATION"]);
  assert.deepEqual(diagFor(run.report(m.pollId), b.id), ["NO_ACTIVE_GRANT"]);
});

test("11 §8: safe revocation never removes the owner's direct vote", () => {
  const A = new Wallet("A");
  const K = new Wallet("K");
  const { s, m } = setup("revoke-direct", [[A, 200_000n]]);
  const g = s.control({ owner: A, action: "GRANT", key: K.evmDescriptor(), anchorHeight: 3 });
  s.publishControls([g.envelope]);
  s.chain.mineUntil(9);
  const direct = s.ballot({ manifest: m, owner: A, action: "NO", anchorHeight: 8 });
  s.publishBallots(m, [direct.envelope, s.ballot({ manifest: m, owner: A, action: "YES", anchorHeight: 8, delegate: { grantId: g.id, key: K, keyKind: "evm" } }).envelope]);
  s.chain.mine(); // 10
  s.publishControls([s.control({ owner: A, action: "REVOKE", revokeMode: "STOP_AND_CANCEL_OPEN", anchorHeight: 10 }).envelope]);
  s.chain.mineUntil(CLOSE_TRIGGER);
  const row = ownerRow(s.run().report(m.pollId), id(A)) as JsonObject;
  assert.equal(row["final_status"], "NO");
  assert.equal(row["ballot_id"], direct.id);
});

test("11 §8: same grant, same anchor, different bodies conflict only in that poll; a newer ballot recovers", () => {
  const A = new Wallet("A");
  const K = new Wallet("K");
  const s = new Scenario("delegate-conflict");
  s.chain.deposit(A.secpLock(), 200_000n);
  s.chain.mine();
  const p1 = s.publishManifest({ startBlock: START, proposers: [A] });
  const p2 = s.publishManifest({ startBlock: START, proposers: [A], signingTitle: "Second poll" });
  const g = s.control({ owner: A, action: "GRANT", key: K.evmDescriptor(), anchorHeight: 2 });
  s.publishControls([g.envelope]);
  s.chain.mineUntil(9);
  const d = { grantId: g.id, key: K, keyKind: "evm" as const };
  s.publishBallots(p1, [
    s.ballot({ manifest: p1, owner: A, action: "YES", anchorHeight: 8, delegate: d, nonce: `0x${"0a".repeat(32)}` }).envelope,
    s.ballot({ manifest: p1, owner: A, action: "NO", anchorHeight: 8, delegate: d, nonce: `0x${"0b".repeat(32)}` }).envelope,
  ]);
  s.publishBallots(p2, [s.ballot({ manifest: p2, owner: A, action: "YES", anchorHeight: 8, delegate: d }).envelope]);
  s.chain.mineUntil(CLOSE_TRIGGER);
  const run = s.run();
  assert.equal((ownerRow(run.report(p1.pollId), id(A)) as JsonObject)["final_status"], "CONFLICT");
  assert.equal((ownerRow(run.report(p2.pollId), id(A)) as JsonObject)["final_status"], "YES");
});

test("11 §8: a delegate CANCEL as the newest ballot excludes the owner and does not fall back to an older YES", () => {
  const A = new Wallet("A");
  const B = new Wallet("B");
  const K = new Wallet("K");
  const { s, m } = setup("delegate-cancel", [
    [A, 200_000n],
    [B, 100_000n],
  ]);
  const g = s.control({ owner: A, action: "GRANT", key: K.evmDescriptor(), anchorHeight: 3 });
  s.publishControls([g.envelope]);
  s.chain.mineUntil(9);
  const d = { grantId: g.id, key: K, keyKind: "evm" as const };
  s.publishBallots(m, [s.ballot({ manifest: m, owner: A, action: "YES", anchorHeight: 8, delegate: d }).envelope, s.ballot({ manifest: m, owner: B, action: "NO", anchorHeight: 8 }).envelope]);
  s.chain.mine(); // 10
  const cancel = s.ballot({ manifest: m, owner: A, action: "CANCEL", anchorHeight: 9, delegate: d });
  s.publishBallots(m, [cancel.envelope]);
  s.chain.mineUntil(CLOSE_TRIGGER);
  const r = s.run().report(m.pollId);
  const row = ownerRow(r, id(A)) as JsonObject;
  assert.equal(row["final_status"], "CANCEL");
  assert.equal(row["ballot_id"], cancel.id);
  assert.equal(row["authorization_id"], g.id);
  const core = r["result_core"] as JsonObject;
  assert.equal(core["yes_shannon"], "0");
  assert.equal(core["participation_shannon"], (100_000n * CKB).toString());
});

test("11 §8: a held-back delegate ballot published before the deadline cannot beat a later revote", () => {
  const A = new Wallet("A");
  const K = new Wallet("K");
  const { s, m } = setup("held-delegate", [[A, 200_000n]]);
  const g = s.control({ owner: A, action: "GRANT", key: K.evmDescriptor(), anchorHeight: 3 });
  s.publishControls([g.envelope]);
  s.chain.mineUntil(20);
  const d = { grantId: g.id, key: K, keyKind: "evm" as const };
  const phished = s.ballot({ manifest: m, owner: A, action: "YES", anchorHeight: 20, delegate: d });
  s.chain.mineUntil(40);
  const own = s.ballot({ manifest: m, owner: A, action: "NO", anchorHeight: 40, delegate: d });
  s.publishBallots(m, [own.envelope]);
  s.chain.mineUntil(170);
  s.publishBallots(m, [phished.envelope]);
  s.chain.mineUntil(CLOSE_TRIGGER);
  const row = ownerRow(s.run().report(m.pollId), id(A)) as JsonObject;
  assert.equal(row["final_status"], "NO");
  assert.equal(row["ballot_id"], own.id);
});
