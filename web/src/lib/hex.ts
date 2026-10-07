// Byte, hex and signature helpers. The protocol uses lowercase `0x` hex everywhere.

const encoder = new TextEncoder();

export function bytesToHex(bytes: Uint8Array): string {
  let s = "0x";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** Strict decoder: `0x` prefix, even length, hex digits (either case). */
export function hexToBytes(hex: string): Uint8Array {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(hex)) throw new Error(`not a 0x-prefixed hex string: ${hex.slice(0, 20)}`);
  const out = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 + 2 * i, 4 + 2 * i), 16);
  return out;
}

export function utf8Bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

/**
 * Hex of the exact UTF-8 bytes of a text. Wallet requests always carry this
 * form: `personal_sign` treats a plain string made only of hex digits as raw
 * bytes, so sending text directly could sign different bytes than displayed.
 */
export function utf8ToHex(text: string): string {
  return bytesToHex(encoder.encode(text));
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Canonical lowercase hex of exactly `bytes` bytes (or any length when omitted). */
export function isHex(s: string, bytes?: number): boolean {
  if (!/^0x([0-9a-f]{2})*$/.test(s)) return false;
  return bytes === undefined || s.length === 2 + 2 * bytes;
}

export function isHash32(s: string): boolean {
  return isHex(s, 32);
}

/** Trim, drop inner whitespace, add `0x`, lowercase. Does not validate. */
export function cleanHexInput(input: string): string {
  let s = input.replace(/\s+/g, "");
  if (s.startsWith("0X")) s = "0x" + s.slice(2);
  if (!s.startsWith("0x")) s = "0x" + s;
  return s.toLowerCase();
}

/** Parse a user-entered 32-byte hash; returns null when invalid. */
export function parseHash32(input: string): string | null {
  const s = cleanHexInput(input);
  return isHash32(s) ? s : null;
}

/** Parse an EVM address in any letter case; returns lowercase hex or null. */
export function parseEvmAddress(input: string): string | null {
  const s = input.trim();
  if (!/^0[xX][0-9a-fA-F]{40}$/.test(s)) return null;
  return "0x" + s.slice(2).toLowerCase();
}

/** Parse a compressed secp256k1 public key (33 bytes, 02/03 prefix). */
export function parseCompressedPubkey(input: string): string | null {
  const s = cleanHexInput(input);
  return isHex(s, 33) && (s.startsWith("0x02") || s.startsWith("0x03")) ? s : null;
}

export type SignatureKind = "ckb" | "evm";

export type SignatureParse =
  | { ok: true; signature: string; v: number }
  | { ok: false; error: "empty" | "not_hex" | "length" | "recovery"; bytes?: number; v?: number };

/**
 * Normalise a 65-byte `r || s || v` signature. CKB message signatures (Neuron)
 * must use v = 00/01; EVM signatures may use 27/28 or 0/1 (the core normalises).
 */
export function parseSignature(input: string, kind: SignatureKind): SignatureParse {
  if (input.trim() === "") return { ok: false, error: "empty" };
  const s = cleanHexInput(input);
  if (!/^0x[0-9a-f]*$/.test(s) || s.length % 2 !== 0) return { ok: false, error: "not_hex" };
  const bytes = (s.length - 2) / 2;
  if (bytes !== 65) return { ok: false, error: "length", bytes };
  const v = parseInt(s.slice(-2), 16);
  const allowed = kind === "ckb" ? [0, 1] : [0, 1, 27, 28];
  if (!allowed.includes(v)) return { ok: false, error: "recovery", v };
  return { ok: true, signature: s, v };
}
