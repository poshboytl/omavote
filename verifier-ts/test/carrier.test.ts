/** Carrier framing, payload integrity and batch limits (docs/03 §7). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { bytesToHex } from "../src/bytes.js";
import { CARRIER_VERSION, KIND, buildCarrier, decodeHeader, encodeHeader } from "../src/carrier.js";
import { payloadHash } from "../src/hash.js";
import { toJsonValue, utf8Encode, type JsonObject } from "../src/json.js";
import { Scenario, Wallet, diagFor, ownerRow, type TxJson } from "./builder.js";
import { scriptHash } from "../src/molecule.js";

const START = 8;
const CLOSE_TRIGGER = START + 168;

test("header encode/decode round trip", () => {
  const h = { kind: 5, version: CARRIER_VERSION, scopeId: `0x${"ab".repeat(32)}`, payloadHash: `0x${"cd".repeat(32)}`, witnessIndex: 0x01020304 };
  const bytes = encodeHeader(h);
  assert.equal(bytes.length, 78);
  assert.equal(bytesToHex(bytes.subarray(74)), "0x04030201", "witness_index is little endian");
  assert.deepEqual(decodeHeader(bytes), h);
});

function setup(salt: string) {
  const s = new Scenario(salt);
  const A = new Wallet("A");
  const B = new Wallet("B");
  s.chain.deposit(A.secpLock(), 200_000n);
  s.chain.deposit(B.secpLock(), 100_000n);
  s.chain.mine();
  const m = s.publishManifest({ startBlock: START, proposers: [A] });
  s.chain.mineUntil(9);
  return { s, m, A, B };
}

/** Adds a raw carrier with explicit header fields and witness bytes. */
function rawCarrier(s: Scenario, o: { kind: number; version?: number; scope: string; witness: Uint8Array; hashOverride?: string; witnessIndex?: number; dataOverride?: string }): TxJson {
  const tx = s.chain.add(s.chain.newTx());
  const wi = o.witnessIndex ?? 1;
  const header = encodeHeader({ kind: o.kind, version: o.version ?? 2, scopeId: o.scope, payloadHash: o.hashOverride ?? payloadHash(o.kind, o.witness), witnessIndex: wi });
  tx.outputs.push({ index: "0", capacity: "13900000000", lock: { code_hash: `0x${"9b".repeat(32)}`, hash_type: "type", args: "0x" }, type: null, data: o.dataOverride ?? bytesToHex(header) });
  tx.witnesses.push(bytesToHex(o.witness));
  return tx;
}

test("framing failures are diagnosed per carrier and have no effect", () => {
  const { s, m, A } = setup("framing");
  const yes = s.ballot({ manifest: m, owner: A, action: "YES", anchorHeight: 8 });
  const payload = toJsonValue({ protocol_version: "2", envelopes: [yes.envelope] });
  const canonical = buildCarrier(KIND.BALLOT_BATCH, m.pollId, payload, 1).witness;
  const pretty = utf8Encode(JSON.stringify(payload, null, 1));
  const txs = {
    hash: rawCarrier(s, { kind: KIND.BALLOT_BATCH, scope: m.pollId, witness: canonical, hashOverride: `0x${"00".repeat(32)}` }),
    pretty: rawCarrier(s, { kind: KIND.BALLOT_BATCH, scope: m.pollId, witness: pretty }),
    version: rawCarrier(s, { kind: KIND.BALLOT_BATCH, version: 3, scope: m.pollId, witness: canonical }),
    kind: rawCarrier(s, { kind: 9, scope: m.pollId, witness: canonical }),
    witness: rawCarrier(s, { kind: KIND.BALLOT_BATCH, scope: m.pollId, witness: canonical, witnessIndex: 7 }),
    malformed: rawCarrier(s, { kind: KIND.BALLOT_BATCH, scope: m.pollId, witness: canonical, dataOverride: `0x${bytesToHex(utf8Encode("OMAVOTE\0")).slice(2)}${"00".repeat(71)}` }),
    numbers: rawCarrier(s, { kind: KIND.BALLOT_BATCH, scope: m.pollId, witness: utf8Encode('{"envelopes":[],"protocol_version":2}') }),
    big: rawCarrier(s, { kind: KIND.BALLOT_BATCH, scope: m.pollId, witness: utf8Encode(`{"envelopes":[],"pad":"${"x".repeat(32 * 1024)}","protocol_version":"2"}`) }),
  };
  s.chain.mineUntil(CLOSE_TRIGGER);
  const r = s.run().report(m.pollId);
  const codeOfTx = (tx: TxJson) => (r["diagnostics"] as JsonObject[]).filter((d) => d["id"] === tx.hash).map((d) => d["code"]);
  assert.deepEqual(codeOfTx(txs.hash), ["PAYLOAD_HASH_MISMATCH"]);
  assert.deepEqual(codeOfTx(txs.pretty), ["PAYLOAD_NOT_CANONICAL"]);
  assert.deepEqual(codeOfTx(txs.version), ["UNSUPPORTED_VERSION"]);
  assert.deepEqual(codeOfTx(txs.kind), ["UNKNOWN_KIND"]);
  assert.deepEqual(codeOfTx(txs.witness), ["WITNESS_MISSING"]);
  assert.deepEqual(codeOfTx(txs.malformed), ["CARRIER_MALFORMED"]);
  assert.deepEqual(codeOfTx(txs.numbers), ["MALFORMED_PAYLOAD"]);
  assert.deepEqual(codeOfTx(txs.big), ["PAYLOAD_TOO_LARGE"]);
  assert.equal(((r["result_core"] as JsonObject)["owners"] as JsonObject[]).length, 0, "no framing failure let the ballot through");
});

test("batch limits: more than 128 envelopes rejects the batch; an oversized or malformed envelope only itself", () => {
  const { s, m, A, B } = setup("limits");
  const yes = s.ballot({ manifest: m, owner: A, action: "YES", anchorHeight: 8 });
  const tooMany = Array.from({ length: 129 }, () => toJsonValue({}) as JsonObject);
  const t1 = s.publishBallots(m, tooMany);
  const no = s.ballot({ manifest: m, owner: B, action: "NO", anchorHeight: 8 });
  const huge = toJsonValue({ body: { padding: "y".repeat(9000) }, proof: {} }) as JsonObject;
  const extraKey = toJsonValue({ body: yes.envelope["body"], proof: yes.envelope["proof"], note: "x" }) as JsonObject;
  s.publishBallots(m, [huge, extraKey, no.envelope, "not an envelope" as unknown as JsonObject]);
  s.chain.mineUntil(CLOSE_TRIGGER);
  const r = s.run().report(m.pollId);
  const diags = r["diagnostics"] as JsonObject[];
  assert.deepEqual(diags.filter((d) => d["id"] === t1.hash).map((d) => d["code"]), ["BATCH_TOO_LARGE"]);
  assert.ok(diags.some((d) => d["code"] === "ENVELOPE_TOO_LARGE"));
  assert.deepEqual(diagFor(r, yes.id), ["MALFORMED"], "the extra-key envelope");
  assert.equal((ownerRow(r, scriptHash(B.secpLock())) as JsonObject)["final_status"], "NO", "the valid envelope in the same batch counts");
  assert.equal(ownerRow(r, scriptHash(A.secpLock())), undefined);
});

test("ballot body poll_id must match the carrier scope", () => {
  const { s, m, A } = setup("scope");
  const other = `0x${"12".repeat(32)}`;
  const yes = s.ballot({ manifest: m, owner: A, action: "YES", anchorHeight: 8 });
  s.chain.carrier(KIND.BALLOT_BATCH, other, toJsonValue({ protocol_version: "2", envelopes: [yes.envelope] }));
  s.chain.mineUntil(CLOSE_TRIGGER);
  const run = s.run();
  assert.deepEqual(run.engine.diagnostics.filter((d) => d.id === yes.id).map((d) => d.code), ["SCOPE_MISMATCH"]);
});
