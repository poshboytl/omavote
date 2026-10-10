// Shared bits of the popup and the confirmation window. All text goes in through
// textContent: nothing from a page is ever parsed as HTML.

import type { InternalOp, InternalReply, StateView } from "../protocol";
import { t, toggleLang, type Key } from "./i18n";

export type Child = Node | string | null | undefined | false;

/** Drop the empty slots of a children list (for append / replaceChildren). */
export function nodes(...children: Child[]): (Node | string)[] {
  return children.filter((c): c is Node | string => c !== null && c !== undefined && c !== false);
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | ((e: Event) => void)> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === "function") e.addEventListener(k.replace(/^on/, ""), v);
    else if (typeof v === "boolean") {
      if (v) e.setAttribute(k, "");
    } else e.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

export class UiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export async function send<T = unknown>(req: InternalOp): Promise<T> {
  const r = (await chrome.runtime.sendMessage({ kind: "internal", ...req })) as InternalReply | undefined;
  if (!r) throw new UiError("INVALID_REQUEST", "no answer from the extension");
  if (!r.ok) throw new UiError(r.code, r.message);
  return r.value as T;
}

export function errorText(e: unknown): string {
  if (e instanceof UiError) {
    const key = `error.${e.code}` as Key;
    if (["error.WRONG_PASSWORD", "error.LOCKED", "error.EXPIRED", "error.NOT_CONNECTED", "error.ANCHOR_REUSED"].includes(key)) return t(key);
    return t("error.other", { message: e.message });
  }
  return t("error.other", { message: e instanceof Error ? e.message : String(e) });
}

export function notice(tone: "info" | "warn" | "bad" | "ok", ...children: Child[]): HTMLElement {
  return el("div", { class: `notice ${tone}` }, ...children);
}

export function header(state: StateView | null, onLang: () => void): HTMLElement {
  return el(
    "header",
    { class: "top" },
    el("strong", {}, t("app.name")),
    state?.flavor === "devnet" ? el("span", { class: "badge devnet" }, t("app.devnet")) : null,
    el("button", { type: "button", class: "link", onclick: () => void toggleLang().then(onLang) }, t("lang.switch")),
  );
}

/** Form with a submit button that shows the error inline and re-enables itself. */
export function form(fields: HTMLElement[], submit: string, action: () => Promise<void>, extra: Child[] = []): HTMLFormElement {
  const err = el("div", { class: "error", role: "alert" });
  const button = el("button", { type: "submit", class: "btn primary" }, submit);
  const f = el("form", {}, ...fields, ...extra, err, button);
  f.addEventListener("submit", (e) => {
    e.preventDefault();
    err.textContent = "";
    button.disabled = true;
    action()
      .catch((x: unknown) => {
        err.textContent = errorText(x);
      })
      .finally(() => {
        button.disabled = false;
      });
  });
  return f;
}

export function passwordField(label: string, autocomplete: string): { field: HTMLElement; input: HTMLInputElement } {
  const input = el("input", { type: "password", autocomplete, required: true, spellcheck: "false" });
  return { field: el("label", { class: "field" }, el("span", {}, label), input), input };
}

/** Create a key: two password fields and the warnings of docs/19 §3.1. */
export function createKeyForm(onDone: (s: StateView) => void): HTMLElement {
  const a = passwordField(t("create.password"), "new-password");
  const b = passwordField(t("create.confirm"), "new-password");
  return el(
    "section",
    {},
    el("h2", {}, t("create.title")),
    el("p", {}, t("create.intro")),
    notice("warn", t("create.noTransfer")),
    notice("info", t("create.noBackup")),
    form([a.field, b.field], t("create.submit"), async () => {
      if ([...a.input.value].length < 12) throw new UiError("INVALID_REQUEST", t("create.short"));
      if (a.input.value !== b.input.value) throw new UiError("INVALID_REQUEST", t("create.mismatch"));
      onDone(await send<StateView>({ op: "create", password: a.input.value }));
    }),
  );
}

export function unlockForm(onDone: (s: StateView) => void): HTMLElement {
  const p = passwordField(t("unlock.password"), "current-password");
  const f = form([p.field], t("unlock.submit"), async () => {
    onDone(await send<StateView>({ op: "unlock", password: p.input.value }));
  });
  queueMicrotask(() => p.input.focus());
  return f;
}

/** Activity in the extension's own pages keeps it unlocked (docs/19 §3.5). */
export function keepAliveOnActivity(): void {
  let last = 0;
  const ping = () => {
    const now = Date.now();
    if (now - last < 20_000) return;
    last = now;
    void send({ op: "touch" }).catch(() => undefined);
  };
  document.addEventListener("pointerdown", ping, { capture: true });
  document.addEventListener("keydown", ping, { capture: true });
}
