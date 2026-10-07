/** Byte and hex helpers. Protocol hex is strictly lowercase with a `0x` prefix (docs/03 §2). */

const HEX_LOWER = /^0x(?:[0-9a-f]{2})*$/;
const HEX_ANY_CASE = /^0x(?:[0-9a-fA-F]{2})*$/;

/** True when `s` is `0x`-prefixed lowercase hex; with `byteLength`, the length must match exactly. */
export function isLowerHex(s: unknown, byteLength?: number): s is string {
  if (typeof s !== "string" || !HEX_LOWER.test(s)) return false;
  return byteLength === undefined || s.length === 2 + 2 * byteLength;
}

export function isHash32(s: unknown): s is string {
  return isLowerHex(s, 32);
}

/** Strict conversion of protocol hex (lowercase only). */
export function hexToBytes(hex: string): Uint8Array {
  if (!HEX_LOWER.test(hex)) {
    throw new Error(`not lowercase 0x-hex: ${hex.slice(0, 20)}`);
  }
  return new Uint8Array(Buffer.from(hex.slice(2), "hex"));
}

/**
 * Lenient conversion for chain data supplied by the replay input (node RPC
 * dumps); accepts either case but still requires `0x` and an even length.
 */
export function inputHexToBytes(hex: string): Uint8Array {
  if (!HEX_ANY_CASE.test(hex)) {
    throw new Error(`not 0x-hex: ${hex.slice(0, 20)}`);
  }
  return new Uint8Array(Buffer.from(hex.slice(2), "hex"));
}

export function bytesToHex(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("hex")}`;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Lexicographic comparison of raw bytes. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

export function bigintToBytes32(v: bigint): Uint8Array {
  const hex = v.toString(16).padStart(64, "0");
  if (hex.length > 64) throw new Error("value does not fit 32 bytes");
  return new Uint8Array(Buffer.from(hex, "hex"));
}

export function bytesToBigint(b: Uint8Array): bigint {
  if (b.length === 0) return 0n;
  return BigInt(`0x${Buffer.from(b).toString("hex")}`);
}
