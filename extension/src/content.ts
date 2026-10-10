// Content script (ISOLATED world, top frame only): relays between window.omavote in
// the page and the service worker. It adds no authority of its own: the service
// worker takes the origin and document from the browser, not from these messages.

import { TO_CONTENT, TO_PAGE, type PageReply, type ToContent } from "./protocol";

declare global {
  interface Window {
    __omavoteSignerContent?: boolean;
  }
}

function toPage(payload: Record<string, unknown>): void {
  window.postMessage({ target: TO_PAGE, ...payload }, location.origin);
}

function main(): void {
  window.addEventListener("message", (ev: MessageEvent) => {
    if (ev.source !== window || ev.origin !== location.origin) return;
    const d = ev.data as { target?: unknown; id?: unknown; method?: unknown; params?: unknown } | null;
    if (!d || d.target !== TO_CONTENT || typeof d.id !== "string") return;
    const id = d.id;
    chrome.runtime.sendMessage({ kind: "page", reqId: id, method: d.method, params: d.params }).then(
      (reply: PageReply | undefined) => {
        if (!reply) toPage({ id, ok: false, code: "INVALID_REQUEST", message: "no answer from the extension" });
        else if (reply.status === "done") toPage({ id, ok: true, result: reply.result });
        else if (reply.status === "error") toPage({ id, ok: false, code: reply.code, message: reply.message });
        // "pending": the result arrives later through chrome.tabs.sendMessage.
      },
      (e: unknown) => toPage({ id, ok: false, code: "INVALID_REQUEST", message: e instanceof Error ? e.message : String(e) }),
    );
  });

  chrome.runtime.onMessage.addListener((msg: ToContent, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return;
    if (msg.kind === "result") {
      toPage(msg.ok ? { id: msg.reqId, ok: true, result: msg.result } : { id: msg.reqId, ok: false, code: msg.code, message: msg.message });
    } else if (msg.kind === "changed") {
      toPage({ event: "changed" });
    }
    // "ping" just proves that this document is still alive.
    sendResponse(true);
  });
}

if (!window.__omavoteSignerContent) {
  window.__omavoteSignerContent = true;
  main();
}
