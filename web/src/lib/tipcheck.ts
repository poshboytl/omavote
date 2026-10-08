// Independent tip check before signing (docs/11 §5 step 1, §6): the anchor must be the
// newest block, so the server's tip is compared with an independent source (another
// Omavote server's /api/status or a CKB node's JSON-RPC). Height and hash must both
// match; otherwise the page waits instead of signing an anchor that may be stale.

import type { FetchLike } from "./api";

export interface IndependentTip {
  height: bigint;
  hash: string;
  kind: "omavote" | "rpc";
}

export type TipComparison = "match" | "source_ahead" | "source_behind" | "fork";

export class TipCheckError extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "TipCheckError";
    this.code = code;
  }
}

/**
 * Accept an https URL, or http on this machine (a local node). Empty means "not set".
 * Returns null for anything else.
 */
export function normalizeTipSource(input: string): string | null {
  const s = input.trim();
  if (s === "") return "";
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const local = u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
  if (u.protocol !== "https:" && !local) return null;
  if (u.username || u.password || u.hash) return null;
  return u.toString();
}

/** A source whose path ends in `/status` is an Omavote server; anything else is a CKB RPC. */
export function sourceKind(source: string): "omavote" | "rpc" {
  return new URL(source).pathname.replace(/\/+$/, "").endsWith("/status") ? "omavote" : "rpc";
}

const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

export async function fetchIndependentTip(
  source: string,
  genesisHash: string,
  fetchImpl: FetchLike = defaultFetch,
  timeoutMs = 10_000,
): Promise<IndependentTip> {
  const signal = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(timeoutMs) : undefined;
  const genesis = genesisHash.toLowerCase();
  if (sourceKind(source) === "omavote") {
    let r: Response;
    try {
      r = await fetchImpl(source, { signal });
    } catch (e) {
      throw new TipCheckError("SOURCE_UNREACHABLE", String(e));
    }
    if (!r.ok) throw new TipCheckError("SOURCE_UNREACHABLE", `HTTP ${r.status}`);
    const v = await r.json();
    const g = v?.network?.genesis_hash;
    if (typeof g === "string" && g.toLowerCase() !== genesis) throw new TipCheckError("SOURCE_OTHER_NETWORK", g);
    // This implementation reports `indexed: {number, hash}`; tolerate `tip: {height, hash}`.
    const t = v?.indexed ?? v?.tip;
    const height = t?.number ?? t?.height;
    if (!t || height === undefined || typeof t.hash !== "string") throw new TipCheckError("SOURCE_NOT_READY", "no tip in status");
    return { height: BigInt(height), hash: t.hash.toLowerCase(), kind: "omavote" };
  }
  const call = async (method: string, params: unknown[]) => {
    let r: Response;
    try {
      r = await fetchImpl(source, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal,
      });
    } catch (e) {
      throw new TipCheckError("SOURCE_UNREACHABLE", String(e));
    }
    if (!r.ok) throw new TipCheckError("SOURCE_UNREACHABLE", `HTTP ${r.status}`);
    const v = await r.json();
    if (v?.error) throw new TipCheckError("SOURCE_UNREACHABLE", JSON.stringify(v.error));
    return v?.result;
  };
  const g = String(await call("get_block_hash", ["0x0"])).toLowerCase();
  if (g !== genesis) throw new TipCheckError("SOURCE_OTHER_NETWORK", g);
  const tip = await call("get_tip_header", []);
  if (!tip || typeof tip.hash !== "string") throw new TipCheckError("SOURCE_NOT_READY", "no tip header");
  return { height: BigInt(tip.number), hash: tip.hash.toLowerCase(), kind: "rpc" };
}

export function compareTips(anchor: { number: string; hash: string }, tip: IndependentTip): TipComparison {
  const h = BigInt(anchor.number);
  if (tip.height === h) return tip.hash === anchor.hash.toLowerCase() ? "match" : "fork";
  return tip.height > h ? "source_ahead" : "source_behind";
}

/** Only mainnet and testnet require a configured source; development chains may skip. */
export function sourceRequired(networkName: string): boolean {
  return networkName === "mainnet" || networkName === "testnet";
}
