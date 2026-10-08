// Browser storage for per-device conveniences only (API base, language, signed
// envelopes kept for retry/download). Nothing here is needed for validity: the
// chain is the record. Every access is guarded because storage can be unavailable.

export interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

function store(): KV | null {
  try {
    const s = (globalThis as unknown as { localStorage?: KV }).localStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

export function readString(key: string, fallback: string, kv: KV | null = store()): string {
  try {
    return kv?.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeString(key: string, value: string | null, kv: KV | null = store()): void {
  try {
    if (value === null) kv?.removeItem(key);
    else kv?.setItem(key, value);
  } catch {
    // storage full or blocked: ignore (conveniences only)
  }
}

export function readJson<T>(key: string, fallback: T, kv: KV | null = store()): T {
  const s = readString(key, "", kv);
  if (s === "") return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown, kv: KV | null = store()): void {
  writeString(key, JSON.stringify(value), kv);
}

export const KEYS = {
  apiBase: "omavote.apiBase",
  lang: "omavote.lang",
  pending: "omavote.pending.v1",
  anchors: "omavote.lastAnchors.v1",
  recordDraft: "omavote.recordDraft.v1",
  walletChecks: "omavote.walletChecks.v1",
  tipSource: "omavote.tipSource",
} as const;

/** A signed envelope kept on this device until it is seen on chain. */
export interface PendingItem {
  id: string;
  kind: "ballot" | "authorization_control" | "process_record" | "manifest";
  label: string;
  poll_id?: string | null;
  owner_id?: string | null;
  envelope: unknown;
  created_ms: number;
  submitted?: boolean;
}

const MAX_PENDING = 100;

export function listPending(kv: KV | null = store()): PendingItem[] {
  const v = readJson<unknown>(KEYS.pending, [], kv);
  return Array.isArray(v) ? (v as PendingItem[]) : [];
}

export function savePending(item: PendingItem, kv: KV | null = store()): void {
  const list = listPending(kv).filter((p) => p.id !== item.id);
  list.unshift(item);
  writeJson(KEYS.pending, list.slice(0, MAX_PENDING), kv);
}

export function getPending(id: string, kv: KV | null = store()): PendingItem | null {
  return listPending(kv).find((p) => p.id === id) ?? null;
}

export function removePending(id: string, kv: KV | null = store()): void {
  writeJson(
    KEYS.pending,
    listPending(kv).filter((p) => p.id !== id),
    kv,
  );
}

/**
 * Last anchor used per signing sequence (poll+owner+authority, or owner controls).
 * Two different signatures in one sequence must use different anchor blocks.
 */
export function lastAnchor(sequence: string, kv: KV | null = store()): { hash: string; number: string } | null {
  const m = readJson<Record<string, { hash: string; number: string }>>(KEYS.anchors, {}, kv);
  return m[sequence] ?? null;
}

export function rememberAnchor(sequence: string, anchor: { hash: string; number: string }, kv: KV | null = store()): void {
  const m = readJson<Record<string, { hash: string; number: string }>>(KEYS.anchors, {}, kv);
  m[sequence] = { hash: anchor.hash, number: anchor.number };
  const keys = Object.keys(m);
  if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete m[k];
  writeJson(KEYS.anchors, m, kv);
}
