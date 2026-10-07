// Test keys and signers built only on @noble (independent of the Rust core), so
// the tests check that the core verifies signatures produced the way real wallets do.

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes } from "../../src/lib/hex";
import type { Eip1193Provider } from "../../src/lib/eip1193";

const enc = new TextEncoder();

/** Deterministic test secret from a label (never use for real funds). */
export function testSecret(label: string): Uint8Array {
  const s = blake2b(enc.encode(`omavote-web-test:${label}`), { dkLen: 32 });
  s[0] = (s[0] ?? 0) & 0x7f; // keep it far below the curve order
  return s;
}

export function evmAddressOf(secret: Uint8Array): string {
  const pub = secp256k1.getPublicKey(secret, false);
  return bytesToHex(keccak_256(pub.slice(1)).slice(12));
}

export function compressedPubkey(secret: Uint8Array): string {
  return bytesToHex(secp256k1.getPublicKey(secret, true));
}

/** EIP-191 digest of raw message bytes. */
export function eip191Digest(message: Uint8Array): Uint8Array {
  return keccak_256(concatBytes(enc.encode(`\x19Ethereum Signed Message:\n${message.length}`), message));
}

/** Recoverable signature as `r || s || v` with v = recovery id + vOffset. */
function signDigest(digest: Uint8Array, secret: Uint8Array, vOffset: number): string {
  const rec = secp256k1.sign(digest, secret, { prehash: false, format: "recovered" });
  const out = new Uint8Array(65);
  out.set(rec.slice(1), 0);
  out[64] = (rec[0] ?? 0) + vOffset;
  return bytesToHex(out);
}

export function ckbHash(data: Uint8Array): Uint8Array {
  return blake2b(data, { dkLen: 32, personalization: enc.encode("ckb-default-hash") });
}

/** What Neuron's "Sign Message" produces: CKB hash of "Nervos Message:" ‖ text, v = 0/1. */
export function neuronSign(text: string, secret: Uint8Array): string {
  return signDigest(ckbHash(concatBytes(enc.encode("Nervos Message:"), enc.encode(text))), secret, 0);
}

/** Relay receipt signature: H("OMAVOTE/RELAY-RECEIPT/V2\0" ‖ JCS(body)), v = 0/1. */
export function receiptSign(jcsBody: string, secret: Uint8Array): string {
  return signDigest(ckbHash(concatBytes(enc.encode("OMAVOTE/RELAY-RECEIPT/V2\0"), enc.encode(jcsBody))), secret, 0);
}

export interface MockCall {
  method: string;
  params: unknown;
}

/**
 * Minimal EIP-1193 wallet: `eth_requestAccounts` and EIP-191 `personal_sign` with a
 * test private key. Like MetaMask, a `0x`-hex first parameter is signed as bytes.
 */
export class MockEip1193 implements Eip1193Provider {
  readonly calls: MockCall[] = [];
  readonly address: string;
  readonly isMetaMask = true;
  private readonly secret: Uint8Array;
  rejectNext = false;
  vZeroOne = false;

  constructor(secret: Uint8Array) {
    this.secret = secret;
    this.address = evmAddressOf(secret);
  }

  async request(args: { method: string; params?: readonly unknown[] | Record<string, unknown> }): Promise<unknown> {
    this.calls.push({ method: args.method, params: args.params });
    if (this.rejectNext) {
      this.rejectNext = false;
      throw { code: 4001, message: "User rejected the request." };
    }
    switch (args.method) {
      case "eth_requestAccounts":
      case "eth_accounts":
        return [this.address];
      case "personal_sign": {
        const [data, addr] = (args.params ?? []) as [string, string];
        if (typeof addr !== "string" || addr.toLowerCase() !== this.address) throw { code: 4100, message: "unknown account" };
        const bytes = /^0x([0-9a-fA-F]{2})*$/.test(data) ? hexToBytes(data) : enc.encode(data);
        return signDigest(eip191Digest(bytes), this.secret, this.vZeroOne ? 0 : 27);
      }
      default:
        throw { code: 4200, message: `unsupported method ${args.method}` };
    }
  }
}
