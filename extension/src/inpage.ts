// MAIN world: defines window.omavote (docs/19 §5.1-§5.2) and announces it with the
// `omavote:ready` event, since on non-official sites it may appear after page load.

import { TO_CONTENT, TO_PAGE, type ErrorCode, type PageKey, type SignBallotsParams } from "./protocol";

export interface OmavoteSigner {
  readonly isOmavoteSigner: true;
  readonly version: string;
  getKey(): Promise<PageKey | null>;
  connect(): Promise<PageKey>;
  signBallots(request: SignBallotsParams): Promise<{ signatures: string[] }>;
  disconnect(): Promise<null>;
}

export interface OmavoteSignerError extends Error {
  code: ErrorCode;
}

(() => {
  const w = window as unknown as { omavote?: OmavoteSigner };
  if (w.omavote?.isOmavoteSigner) {
    window.dispatchEvent(new Event("omavote:ready"));
    return;
  }
  const waiting = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  let seq = 0;

  window.addEventListener("message", (ev: MessageEvent) => {
    if (ev.source !== window || ev.origin !== location.origin) return;
    const d = ev.data as { target?: unknown; id?: string; event?: string; ok?: boolean; result?: unknown; code?: ErrorCode; message?: string } | null;
    if (!d || d.target !== TO_PAGE) return;
    if (d.event === "changed") {
      window.dispatchEvent(new Event("omavote:changed"));
      return;
    }
    const p = d.id === undefined ? undefined : waiting.get(d.id);
    if (!p || d.id === undefined) return;
    waiting.delete(d.id);
    if (d.ok) p.resolve(d.result);
    else p.reject(Object.assign(new Error(d.message ?? String(d.code)), { name: "OmavoteSignerError", code: d.code ?? "INVALID_REQUEST" }));
  });

  function request<T>(method: string, params?: unknown): Promise<T> {
    seq += 1;
    const id = `${Date.now().toString(36)}.${seq}.${Math.random().toString(36).slice(2, 10)}`;
    return new Promise<T>((resolve, reject) => {
      waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
      window.postMessage({ target: TO_CONTENT, id, method, params }, location.origin);
    });
  }

  const api: OmavoteSigner = Object.freeze({
    isOmavoteSigner: true as const,
    version: "1",
    getKey: () => request<PageKey | null>("getKey"),
    connect: () => request<PageKey>("connect"),
    signBallots: (r: SignBallotsParams) => request<{ signatures: string[] }>("signBallots", r),
    disconnect: () => request<null>("disconnect"),
  });
  Object.defineProperty(window, "omavote", { value: api, enumerable: true, configurable: false, writable: false });
  window.dispatchEvent(new Event("omavote:ready"));
})();
