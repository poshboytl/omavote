/**
 * Rules added in docs/13 §4 items 10–21 and the docs/03 §5.1 Omnilock update:
 * 0x12 Omnilock owners, policy-before-manifest, ballot anchor >= manifest
 * height, detail-based RECORD_CONFLICT, kind-3 payloads, parse limits (empty
 * batches), required proposer_min_deposit_shannon, fixed mainnet/testnet registries.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { cccA } from "@ckb-ccc/core/advanced";
import { ADAPTER_EVM } from "../src/adapter.js";
import { bytesToHex } from "../src/bytes.js";
import { CARRIER_VERSION, KIND, encodeHeader } from "../src/carrier.js";
import { InputError } from "../src/errors.js";
import { DOMAIN, objectHash, payloadHash } from "../src/hash.js";
import { toJsonValue, utf8Encode, type JsonObject } from "../src/json.js";
import { scriptHash, type ScriptJson } from "../src/molecule.js";
import { MAINNET_GENESIS_HASH, TESTNET_GENESIS_HASH, parseNetwork } from "../src/network.js";
import { parseBallotBody, parseControlBody, parseManifest, type Manifest } from "../src/schema.js";
import { ballotText, controlText, proposalText } from "../src/text.js";
import { DAY, Scenario, TEMPLATES, Wallet, diagFor, ownerRow, type TxJson } from "./builder.js";

const START = 8;
const CLOSE_TRIGGER = START + 168;

/** Messages signed for an Omnilock owner with auth flag 0x12 (the builder's helpers use 0x01). */
function omni12(s: Scenario, owner: Wallet) {
  const lock: ScriptJson = owner.omniLock("00", "12");
  return {
    lock,
    manifest(): { json: JsonObject; parsed: Manifest; proof: JsonObject } {
      const json = toJsonValue({ ...s.manifestJson({ startBlock: START, proposers: [] }), proposer_owner_locks: [lock] }) as JsonObject;
      const parsed = parseManifest(json, s.network);
      const proof = toJsonValue({ owner_lock: lock, auth_adapter: ADAPTER_EVM, proof: { signature: owner.signEvm(proposalText(parsed, lock, s.network)) } }) as JsonObject;
      return { json, parsed, proof };
    },
    grant(key: Wallet, anchorHeight: number): { envelope: JsonObject; id: string } {
      const body = toJsonValue({
        protocol_version: "2",
        message_kind: "authorization_control",
        network_genesis_hash: s.chain.genesisHash,
        dao_namespace: "ckb-community-fund-dao",
        auth_policy_hash: s.policyHash,
        owner_lock: lock,
        owner_auth_adapter: ADAPTER_EVM,
        action: "GRANT",
        key_descriptor: key.evmDescriptor(),
        expires_at_ms: (s.chain.clockOf(anchorHeight) + 30n * DAY).toString(),
        revoke_mode: null,
        anchor_block_hash: s.chain.hashOf(anchorHeight),
        publication_deadline_ms: s.controlDeadline(anchorHeight).toString(),
        nonce: `0x${"12".repeat(32)}`,
        signature_format: "omavote-authorization-v2",
      }) as JsonObject;
      const c = parseControlBody(body, s.network);
      return { envelope: toJsonValue({ body, proof: { signature: owner.signEvm(controlText(c, s.network)) } }) as JsonObject, id: c.authorizationId };
    },
    ballot(m: Manifest, anchorHeight: number): { envelope: JsonObject; id: string } {
      const body = toJsonValue({
        message_kind: "ballot",
        protocol_version: "2",
        action: "YES",
        authority: "owner",
        authorization_id: null,
        signer_key_id: null,
        nonce: `0x${"21".repeat(32)}`,
        anchor_block_hash: s.chain.hashOf(anchorHeight),
        auth_adapter: ADAPTER_EVM,
        dao_namespace: "ckb-community-fund-dao",
        network_genesis_hash: s.chain.genesisHash,
        owner_lock: lock,
        poll_id: m.pollId,
        rules_hash: m.rulesHash,
        signature_format: "omavote-readable-v2",
      }) as JsonObject;
      const b = parseBallotBody(body, s.network);
      return { envelope: toJsonValue({ body, proof: { signature: owner.signEvm(ballotText(m, b, s.network)) } }) as JsonObject, id: b.ballotId };
    },
  };
}

test("0x12 Omnilock owner: proposer, grantor and direct voter (docs/03 §5.1, 13 §4 item 19)", () => {
  const E = new Wallet("E12");
  const K = new Wallet("K");
  const s = new Scenario("omni-12");
  const e = omni12(s, E);
  s.chain.deposit(e.lock, 150_000n);
  s.chain.mine(); // 2
  const { json, parsed, proof } = e.manifest();
  s.publishManifestRaw(json, [proof]);
  s.chain.mine(); // 3
  const g = e.grant(K, 3);
  s.publishControls([g.envelope]);
  s.chain.mineUntil(9);
  s.publishBallots(parsed, [e.ballot(parsed, 8).envelope]);
  s.chain.mineUntil(CLOSE_TRIGGER);
  const run = s.run();
  assert.ok(run.engine.polls.has(parsed.pollId), "a manifest with a 0x12 proposer registers");
  assert.ok(run.engine.validControls.has(g.id), "a GRANT signed by the 0x12 owner is valid");
  const r = run.report(parsed.pollId);
  const row = ownerRow(r, scriptHash(e.lock)) as JsonObject;
  assert.equal(row["final_status"], "YES");
  assert.equal(row["counted_weight_shannon"], "15000000000000");
  assert.equal((r["proposer_check"] as JsonObject)["eligible"], true);
});

test("the authorization policy must be published strictly before the manifest (13 §4 item 11)", () => {
  const A = new Wallet("A");
  const s = new Scenario("policy-order", { publishPolicy: false });
  s.chain.deposit(A.secpLock(), 200_000n);
  s.chain.mine(); // 2
  const early = s.publishManifest({ startBlock: START, proposers: [A] });
  s.chain.mine(); // 3: no policy yet
  // Same transaction: a manifest output before the policy output is still too early.
  const tx: TxJson = s.chain.add(s.chain.newTx());
  s.publishManifest({ startBlock: START, proposers: [A] }, tx);
  s.publishPolicy(tx);
  s.chain.mine(); // 4
  s.publishManifest({ startBlock: START, proposers: [A] });
  s.chain.mine(); // 5
  const run = s.run();
  const codes = run.engine.diagnostics.filter((d) => d.kind === "manifest" && d.id === early.pollId).map((d) => `${d.height}:${d.code}`);
  assert.deepEqual(codes, ["3:POLICY_UNKNOWN", "4:POLICY_UNKNOWN"]);
  assert.equal(run.engine.polls.get(early.pollId)?.manifestBlock.number, 5);
});

test("a ballot anchor below the manifest registration height is ANCHOR_INVALID; equal is fine (13 §4 item 11)", () => {
  const A = new Wallet("A");
  const B = new Wallet("B");
  const s = new Scenario("anchor-floor");
  s.chain.deposit(A.secpLock(), 200_000n);
  s.chain.deposit(B.secpLock(), 100_000n);
  s.chain.mineUntil(4);
  const m = s.publishManifest({ startBlock: START, proposers: [A] });
  s.chain.mine(); // 5 = b_m
  s.chain.mineUntil(9);
  const tooOld = s.ballot({ manifest: m, owner: A, action: "YES", anchorHeight: 4 });
  const atRegistration = s.ballot({ manifest: m, owner: B, action: "NO", anchorHeight: 5 });
  s.publishBallots(m, [tooOld.envelope, atRegistration.envelope]);
  s.chain.mineUntil(CLOSE_TRIGGER);
  const r = s.run().report(m.pollId);
  assert.deepEqual(diagFor(r, tooOld.id), ["ANCHOR_INVALID"]);
  assert.deepEqual(diagFor(r, atRegistration.id), []);
});

test("empty batches are invalid but have no effect (13 §4 item 21)", () => {
  const A = new Wallet("A");
  const s = new Scenario("empty-batch");
  s.chain.deposit(A.secpLock(), 200_000n);
  s.chain.mine();
  const m = s.publishManifest({ startBlock: START, proposers: [A] });
  s.chain.mineUntil(9);
  const t1 = s.publishBallots(m, []);
  const t2 = s.publishControls([]);
  const t3 = s.publishRecords(m.pollId, []);
  s.publishBallots(m, [s.ballot({ manifest: m, owner: A, action: "YES", anchorHeight: 8 }).envelope]);
  s.chain.mineUntil(CLOSE_TRIGGER);
  const run = s.run();
  for (const tx of [t1, t2, t3]) {
    assert.deepEqual(
      run.engine.diagnostics.filter((d) => d.id === tx.hash).map((d) => d.code),
      ["EMPTY_BATCH"],
    );
  }
  assert.equal((ownerRow(run.report(m.pollId), scriptHash(A.secpLock())) as JsonObject)["final_status"], "YES");
});

test("kind 3 result records may be any canonical JSON value (13 §4 item 13)", () => {
  const s = new Scenario("kind3");
  const scope = `0x${"33".repeat(32)}`;
  const okArray = s.chain.carrier(KIND.RESULT_RECORD, scope, toJsonValue(["any", { b: "1", a: null }]));
  const okString = s.chain.carrier(KIND.RESULT_RECORD, scope, "just a string");
  const pretty = utf8Encode('[ "not canonical" ]');
  const tx = s.chain.add(s.chain.newTx());
  const header = encodeHeader({ kind: KIND.RESULT_RECORD, version: CARRIER_VERSION, scopeId: scope, payloadHash: payloadHash(KIND.RESULT_RECORD, pretty), witnessIndex: 1 });
  tx.outputs.push({ index: "0", capacity: "13900000000", lock: { ...TEMPLATES.secp256k1, args: "0x" }, type: null, data: bytesToHex(header) });
  tx.witnesses.push(bytesToHex(pretty));
  s.chain.mine();
  const run = s.run();
  assert.deepEqual(run.engine.diagnostics.filter((d) => d.id === okArray.hash || d.id === okString.hash), []);
  assert.deepEqual(run.engine.diagnostics.filter((d) => d.id === tx.hash).map((d) => d.code), ["PAYLOAD_NOT_CANONICAL"]);
});

test("RECORD_CONFLICT means a different detail at the same anchor (13 §4 item 12)", () => {
  const A = new Wallet("A");
  const s = new Scenario("detail-conflict");
  s.chain.deposit(A.secpLock(), 200_000n);
  s.chain.mine();
  const m = s.publishManifest({ startBlock: START, proposers: [A] });
  s.chain.mine(); // 3
  const a1 = s.record({ role: "coordinator", recordType: "ADMISSION", pollId: m.pollId, detail: { decision: "ADMITTED" }, anchorHeight: 3, signers: [s.coordinator], nonce: `0x${"0a".repeat(32)}` });
  const a2 = s.record({ role: "coordinator", recordType: "ADMISSION", pollId: m.pollId, detail: { decision: "ADMITTED" }, anchorHeight: 3, signers: [s.coordinator], nonce: `0x${"0b".repeat(32)}` });
  s.publishRecords(m.pollId, [a1.envelope, a2.envelope]);
  s.chain.mineUntil(10);
  const r = s.run().report(m.pollId);
  assert.notEqual(a1.id, a2.id, "different record ids");
  assert.equal(r["admission"], "ADMITTED", "same detail at the same anchor is not a conflict");
  assert.deepEqual(diagFor(r, a2.id), []);
});

test("proposer_min_deposit_shannon is a required rules_profile key (13 §4 item 10)", () => {
  const A = new Wallet("A");
  const s = new Scenario("min-deposit");
  s.chain.deposit(A.secpLock(), 200_000n);
  s.chain.mine();
  const good = s.manifestJson({ startBlock: START, proposers: [A] });
  const rules = toJsonValue({ ...(good["rules_profile"] as JsonObject) }) as JsonObject;
  delete rules["proposer_min_deposit_shannon"];
  const bad = toJsonValue({ ...good, rules_profile: rules, rules_hash: objectHash(DOMAIN.RULES, rules) }) as JsonObject;
  const pollId = s.publishManifestRaw(bad, []);
  s.chain.mine();
  const run = s.run();
  assert.deepEqual(
    run.engine.diagnostics.filter((d) => d.id === pollId).map((d) => d.code),
    ["MALFORMED"],
  );
});

test("mainnet and testnet use fixed registries from CCC and reject overrides (13 §4 item 16)", () => {
  const main = parseNetwork(toJsonValue({ genesis_hash: MAINNET_GENESIS_HASH }));
  assert.equal(main.hrp, "ckb");
  assert.equal(main.omnilock?.code_hash, cccA.MAINNET_SCRIPTS.OmniLock?.codeHash);
  assert.equal(main.pw_lock?.code_hash, cccA.MAINNET_SCRIPTS.PWLock?.codeHash);
  assert.equal(main.dao.code_hash, TEMPLATES.dao.code_hash);
  assert.equal(main.secp256k1.code_hash, TEMPLATES.secp256k1.code_hash);
  const testnet = parseNetwork(toJsonValue({ genesis_hash: TESTNET_GENESIS_HASH, hrp: "ckt", omnilock: { code_hash: cccA.TESTNET_SCRIPTS.OmniLock.codeHash, hash_type: "type" } }));
  assert.equal(testnet.omnilock?.code_hash, "0xf329effd1c475a2978453c8600e1eaf0bc2087ee093c3ee64cc96ec6847752cb");
  assert.throws(() => parseNetwork(toJsonValue({ genesis_hash: MAINNET_GENESIS_HASH, omnilock: TEMPLATES.omnilock })), InputError);
  assert.throws(() => parseNetwork(toJsonValue({ genesis_hash: TESTNET_GENESIS_HASH, pw_lock: TEMPLATES.pw_lock })), InputError);
  // Development chains declare their own templates; secp256k1 and dao are required there.
  assert.throws(() => parseNetwork(toJsonValue({ genesis_hash: `0x${"ab".repeat(32)}`, secp256k1: TEMPLATES.secp256k1 })), InputError);
  const dev = parseNetwork(toJsonValue({ genesis_hash: `0x${"ab".repeat(32)}`, secp256k1: TEMPLATES.secp256k1, dao: TEMPLATES.dao }));
  assert.equal(dev.omnilock, null);
  assert.equal(dev.hrp, "ckt");
});
