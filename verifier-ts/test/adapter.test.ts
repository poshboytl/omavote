/** Signature adapters and owner matching (docs/03 §5.1, docs/13 §4.5). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  ADAPTER_CKB,
  ADAPTER_EVM,
  eip55,
  recoverCkb,
  recoverEvm,
  verifyKeySignature,
  verifyOwnerSignature,
} from "../src/adapter.js";
import { bigintToBytes32, bytesToBigint, bytesToHex, hexToBytes } from "../src/bytes.js";
import { parseKeyDescriptor } from "../src/schema.js";
import { Scenario, Wallet } from "./builder.js";

const N = secp256k1.Point.CURVE().n;
const TEXT = "OMAVOTE VOTE YES #0011223344556677 1000CKB\nexample";

function toHighS(sigHex: string, evm: boolean): string {
  const sig = hexToBytes(sigHex);
  const s = bytesToBigint(sig.subarray(32, 64));
  const out = new Uint8Array(sig);
  out.set(bigintToBytes32(N - s), 32);
  const v = sig[64] as number;
  out[64] = evm ? (v === 27 ? 28 : v === 28 ? 27 : v ^ 1) : v ^ 1;
  return bytesToHex(out);
}

test("CKB adapter: owner matching uses the full secp256k1_blake160 script", () => {
  const s = new Scenario("adapter");
  const w = new Wallet("alice");
  const sig = hexToBytes(w.signCkb(TEXT));
  assert.equal(verifyOwnerSignature(ADAPTER_CKB, TEXT, sig, w.secpLock(), s.network), "OK");
  assert.equal(verifyOwnerSignature(ADAPTER_CKB, TEXT, sig, new Wallet("bob").secpLock(), s.network), "WRONG_OWNER");
  // Same args under a different code hash or hash type is a different owner.
  assert.equal(verifyOwnerSignature(ADAPTER_CKB, TEXT, sig, { ...w.secpLock(), hash_type: "data1" }, s.network), "WRONG_OWNER");
  assert.equal(verifyOwnerSignature(ADAPTER_CKB, TEXT, sig, { ...w.secpLock(), code_hash: `0x${"11".repeat(32)}` }, s.network), "WRONG_OWNER");
  // Text changed by one byte recovers another key.
  assert.equal(verifyOwnerSignature(ADAPTER_CKB, `${TEXT} `, sig, w.secpLock(), s.network), "WRONG_OWNER");
  // The CKB adapter cannot own an Omnilock.
  assert.equal(verifyOwnerSignature(ADAPTER_CKB, TEXT, sig, w.omniLock(), s.network), "WRONG_OWNER");
});

test("CKB adapter: recovery id must be 0/1; high-S is normalised and accepted", () => {
  const w = new Wallet("alice");
  const good = w.signCkb(TEXT);
  const bad = hexToBytes(good);
  bad[64] = 27;
  assert.equal(recoverCkb(TEXT, bad).ok, false);
  bad[64] = 2;
  assert.equal(recoverCkb(TEXT, bad).ok, false);
  const high = recoverCkb(TEXT, hexToBytes(toHighS(good, false)));
  assert.ok(high.ok && high.identity.kind === "secp256k1" && bytesToHex(high.identity.publicKey) === bytesToHex(w.publicKey));
  const zero = new Uint8Array(65);
  assert.equal(recoverCkb(TEXT, zero).ok, false, "r = s = 0");
  const rN = hexToBytes(good);
  rN.set(bigintToBytes32(N), 0);
  assert.equal(recoverCkb(TEXT, rN).ok, false, "r = n");
  assert.equal(recoverCkb(TEXT, hexToBytes(good).subarray(0, 64)).ok, false, "64-byte signature");
});

test("EVM adapter: v in {27,28,0,1}; Omnilock plain mode and PW Lock owners", () => {
  const s = new Scenario("adapter-evm");
  const w = new Wallet("eve");
  const sig27 = hexToBytes(w.signEvm(TEXT, 27));
  const sig0 = hexToBytes(w.signEvm(TEXT, 0));
  for (const sig of [sig27, sig0, hexToBytes(toHighS(bytesToHex(sig27), true)), hexToBytes(toHighS(bytesToHex(sig0), true))]) {
    const r = recoverEvm(TEXT, sig);
    assert.ok(r.ok && r.identity.kind === "evm" && r.identity.address === w.address);
  }
  const bad = new Uint8Array(sig27);
  bad[64] = 29;
  assert.equal(recoverEvm(TEXT, bad).ok, false);
  assert.equal(verifyOwnerSignature(ADAPTER_EVM, TEXT, sig27, w.omniLock(), s.network), "OK");
  assert.equal(verifyOwnerSignature(ADAPTER_EVM, TEXT, sig27, w.pwLock(), s.network), "OK");
  // Plain EVM mode: auth flag 0x01 (Ethereum) or 0x12 (Ethereum-displaying), flags byte 0x00, exactly 22 bytes (docs/03 §5.1).
  assert.equal(verifyOwnerSignature(ADAPTER_EVM, TEXT, sig27, w.omniLock("00", "12"), s.network), "OK");
  // Omnilock with special flags, other auth flags or another length is not the plain EVM mode.
  assert.equal(verifyOwnerSignature(ADAPTER_EVM, TEXT, sig27, w.omniLock("01"), s.network), "WRONG_OWNER");
  assert.equal(verifyOwnerSignature(ADAPTER_EVM, TEXT, sig27, w.omniLock("01", "12"), s.network), "WRONG_OWNER");
  for (const flag of ["00", "02", "11", "13", "fc"]) {
    assert.equal(verifyOwnerSignature(ADAPTER_EVM, TEXT, sig27, w.omniLock("00", flag), s.network), "WRONG_OWNER", `auth flag ${flag}`);
  }
  assert.equal(verifyOwnerSignature(ADAPTER_EVM, TEXT, sig27, { ...w.omniLock(), args: `0x01${w.address.slice(2)}` }, s.network), "WRONG_OWNER");
  assert.equal(verifyOwnerSignature(ADAPTER_EVM, TEXT, sig27, { ...w.omniLock(), args: `0x12${w.address.slice(2)}0000` }, s.network), "WRONG_OWNER");
  // PW Lock args must be exactly the address.
  assert.equal(verifyOwnerSignature(ADAPTER_EVM, TEXT, sig27, { ...w.pwLock(), args: `${w.address}00` }, s.network), "WRONG_OWNER");
  // The EVM adapter cannot own a secp256k1 lock.
  assert.equal(verifyOwnerSignature(ADAPTER_EVM, TEXT, sig27, w.secpLock(), s.network), "WRONG_OWNER");
  // Unknown adapters are not owner adapters.
  assert.equal(verifyOwnerSignature("webauthn-es256-v2", TEXT, sig27, w.omniLock(), s.network), "UNSUPPORTED_ADAPTER");
});

test("key role: descriptor must equal the recovered key", () => {
  const w = new Wallet("key");
  const other = new Wallet("other");
  const k1 = parseKeyDescriptor(w.secpDescriptor());
  const k2 = parseKeyDescriptor(w.evmDescriptor());
  assert.equal(verifyKeySignature(k1, TEXT, hexToBytes(w.signCkb(TEXT))), "OK");
  assert.equal(verifyKeySignature(k1, TEXT, hexToBytes(other.signCkb(TEXT))), "INVALID_SIGNATURE");
  assert.equal(verifyKeySignature(k1, TEXT, hexToBytes(w.signEvm(TEXT))), "INVALID_SIGNATURE", "EVM digest is not the CKB digest");
  assert.equal(verifyKeySignature(k2, TEXT, hexToBytes(w.signEvm(TEXT))), "OK");
  assert.equal(verifyKeySignature(k2, TEXT, hexToBytes(other.signEvm(TEXT))), "INVALID_SIGNATURE");
});

test("key descriptors: invalid points and wrong adapters rejected", () => {
  const w = new Wallet("k");
  assert.throws(() => parseKeyDescriptor({ kind: "secp256k1", public_key: `0x02${"00".repeat(32)}`, adapter: ADAPTER_CKB }));
  assert.throws(() => parseKeyDescriptor({ kind: "secp256k1", public_key: bytesToHex(w.publicKey), adapter: ADAPTER_EVM }));
  assert.throws(() => parseKeyDescriptor({ kind: "evm_eoa", address: eip55(w.address), adapter: ADAPTER_EVM }), "mixed case address");
  assert.throws(() => parseKeyDescriptor({ kind: "evm_eoa", address: w.address, adapter: ADAPTER_EVM, extra: "x" }));
});

test("EIP-55 checksum (EIP-55 reference addresses)", () => {
  for (const a of [
    "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
    "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
    "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
  ]) {
    assert.equal(eip55(a.toLowerCase()), a);
  }
});
