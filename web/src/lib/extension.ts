// The Omavote signer extension (docs/19 §5): `window.omavote`, injected by the
// extension. It holds one secp256k1 voting key and signs structured delegate
// ballots, rebuilding each text itself; the page never hands it text to sign.

import type { BallotBody, KeyDescriptor, Manifest } from "./types";

export interface ExtensionKey {
  descriptor: KeyDescriptor;
  key_id: string;
  display: string;
  genesis: string;
}

export interface OmavoteSigner {
  readonly isOmavoteSigner: true;
  readonly version: string;
  getKey(): Promise<ExtensionKey | null>;
  connect(): Promise<ExtensionKey>;
  signBallots(request: { manifest: Manifest; bodies: BallotBody[] }): Promise<{ signatures: string[] }>;
  disconnect(): Promise<null>;
}

/** The extension signs at most this many ballots per confirmation (docs/19 §13). */
export const EXTENSION_BATCH = 20;

export type ExtensionErrorCode =
  | "USER_REJECTED"
  | "NOT_CONNECTED"
  | "WRONG_NETWORK"
  | "INVALID_REQUEST"
  | "ANCHOR_REUSED"
  | "BUSY"
  | "EXPIRED"
  | "NO_KEY"
  | "OTHER";

const CODES: ExtensionErrorCode[] = ["USER_REJECTED", "NOT_CONNECTED", "WRONG_NETWORK", "INVALID_REQUEST", "ANCHOR_REUSED", "BUSY", "EXPIRED", "NO_KEY"];

export class ExtensionError extends Error {
  readonly code: ExtensionErrorCode;
  constructor(code: ExtensionErrorCode, message: string) {
    super(message);
    this.name = "ExtensionError";
    this.code = code;
  }
}

export function extensionError(e: unknown): ExtensionError {
  if (e instanceof ExtensionError) return e;
  const o = (e ?? {}) as { code?: unknown; message?: unknown };
  const code = CODES.includes(o.code as ExtensionErrorCode) ? (o.code as ExtensionErrorCode) : "OTHER";
  return new ExtensionError(code, typeof o.message === "string" ? o.message : String(e));
}

export function findExtension(): OmavoteSigner | null {
  const o = (globalThis as { omavote?: Partial<OmavoteSigner> }).omavote;
  return o?.isOmavoteSigner === true ? (o as OmavoteSigner) : null;
}

/** Sign one batch (at most EXTENSION_BATCH ballots of one proposal and one choice). */
export async function signBatch(ext: OmavoteSigner, manifest: Manifest, bodies: BallotBody[]): Promise<string[]> {
  if (bodies.length === 0 || bodies.length > EXTENSION_BATCH) throw new ExtensionError("INVALID_REQUEST", `1-${EXTENSION_BATCH} ballots per batch`);
  let r: { signatures?: unknown };
  try {
    r = await ext.signBallots({ manifest, bodies });
  } catch (e) {
    throw extensionError(e);
  }
  const sigs = r?.signatures;
  if (!Array.isArray(sigs) || sigs.length !== bodies.length || !sigs.every((s) => typeof s === "string" && /^0x[0-9a-f]{130}$/.test(s))) {
    throw new ExtensionError("OTHER", "the extension returned malformed signatures");
  }
  return sigs as string[];
}

export function batches<T>(items: T[], size = EXTENSION_BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
