// Client for the Omavote server API (`/api/...`). Every response is a cached view
// computed at the block reported in `at`, never a protocol fact.

import type {
  AddressView,
  AnchorView,
  BallotsView,
  DiagnosticsView,
  KeyAuthorizationsView,
  NetworkInfo,
  OwnerBallotsView,
  OwnerPower,
  ProposalDetail,
  QueuedView,
  ProposalsView,
  ReceiptsView,
  RecordsView,
  RelayItem,
  StatusView,
  StreamView,
} from "./types";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  constructor(status: number, code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Normalise an API base URL: empty means same origin. Only http(s) URLs are accepted;
 * a trailing slash and a trailing `/api` are dropped.
 */
export function normalizeApiBase(input: string): string | null {
  const s = input.trim();
  if (s === "") return "";
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password || u.search || u.hash) return null;
  let path = u.pathname.replace(/\/+$/, "");
  if (path.endsWith("/api")) path = path.slice(0, -4);
  return `${u.origin}${path}`;
}

const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

function hexId(id: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(id)) throw new ApiError(0, "BAD_ID", "expected a 0x-prefixed 32-byte hex id");
  return id.toLowerCase();
}

export class Api {
  readonly base: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(base = "", fetchImpl: FetchLike = defaultFetch, timeoutMs = 20_000) {
    this.base = base;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  url(path: string): string {
    return `${this.base}${path}`;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), this.timeoutMs) : null;
    let res: Response;
    try {
      const f = this.fetchImpl;
      res = await f(this.url(path), {
        ...init,
        ...(ctrl ? { signal: ctrl.signal } : {}),
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
    } catch (e) {
      throw new ApiError(0, "NETWORK", e instanceof Error ? e.message : String(e));
    } finally {
      if (timer) clearTimeout(timer);
    }
    const text = await res.text();
    let body: unknown = null;
    if (text !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        throw new ApiError(res.status, "BAD_RESPONSE", `non-JSON response (${res.status})`);
      }
    }
    if (!res.ok) {
      const err = (body as { error?: { code?: string; detail?: string } } | null)?.error;
      throw new ApiError(res.status, err?.code ?? `HTTP_${res.status}`, err?.detail ?? res.statusText ?? "request failed");
    }
    return body as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: "GET" });
  }

  status(): Promise<StatusView> {
    return this.get("/api/status");
  }

  network(): Promise<NetworkInfo> {
    return this.get("/api/network");
  }

  anchor(): Promise<AnchorView> {
    return this.get("/api/anchor");
  }

  proposals(): Promise<ProposalsView> {
    return this.get("/api/proposals");
  }

  proposal(id: string): Promise<ProposalDetail> {
    return this.get(`/api/proposals/${hexId(id)}`);
  }

  ballots(pollId: string, ownerId?: string): Promise<BallotsView> {
    const q = ownerId ? `?owner=${hexId(ownerId)}` : "";
    return this.get(`/api/proposals/${hexId(pollId)}/ballots${q}`);
  }

  records(pollId: string): Promise<RecordsView> {
    return this.get(`/api/proposals/${hexId(pollId)}/records`);
  }

  bundleUrl(pollId: string): string {
    return this.url(`/api/results/${hexId(pollId)}/bundle`);
  }

  bundle(pollId: string): Promise<Record<string, unknown>> {
    return this.get(`/api/results/${hexId(pollId)}/bundle`);
  }

  ownerPower(ownerId: string): Promise<OwnerPower> {
    return this.get(`/api/owners/${hexId(ownerId)}/power`);
  }

  /** Power at a canonical block; `at` tells the block's height (404 when not canonical). */
  ownerPowerAt(ownerId: string, blockHash: string): Promise<OwnerPower> {
    return this.get(`/api/owners/${hexId(ownerId)}/power?block_hash=${hexId(blockHash)}`);
  }

  /** Ballots and controls of the owner queued at this relay (not yet CONFIRMED). */
  ownerQueued(ownerId: string): Promise<QueuedView> {
    return this.get(`/api/owners/${hexId(ownerId)}/queued`);
  }

  ownerAuthorizations(ownerId: string, policyHash?: string): Promise<StreamView> {
    const q = policyHash ? `?policy_hash=${hexId(policyHash)}` : "";
    return this.get(`/api/owners/${hexId(ownerId)}/authorizations${q}`);
  }

  ownerBallots(ownerId: string): Promise<OwnerBallotsView> {
    return this.get(`/api/owners/${hexId(ownerId)}/ballots`);
  }

  ownerFeedUrl(ownerId: string): string {
    return this.url(`/api/owners/${hexId(ownerId)}/feed.atom`);
  }

  feedUrl(): string {
    return this.url("/feed.atom");
  }

  address(address: string): Promise<AddressView> {
    return this.get(`/api/address/${encodeURIComponent(address.trim())}`);
  }

  authorization(id: string): Promise<Record<string, unknown>> {
    return this.get(`/api/authorizations/${hexId(id)}`);
  }

  keyAuthorizations(keyId: string): Promise<KeyAuthorizationsView> {
    return this.get(`/api/keys/${hexId(keyId)}/authorizations`);
  }

  receipts(id: string): Promise<ReceiptsView> {
    return this.get(`/api/receipts/${hexId(id)}`);
  }

  diagnostics(limit = 50, kind?: string): Promise<DiagnosticsView> {
    const q = new URLSearchParams({ limit: String(limit) });
    if (kind) q.set("kind", kind);
    return this.get(`/api/diagnostics?${q.toString()}`);
  }

  /** `POST /api/envelopes` with the raw JSON text (sent in JCS form by callers). */
  submit(jsonText: string): Promise<RelayItem> {
    return this.request<RelayItem>("/api/envelopes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: jsonText,
    });
  }
}
