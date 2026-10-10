// Confirmation window (docs/19 §3.4): the scope of the request is always visible:
// origin, key, proposal, choice and every owner address; full texts can be expanded.

import type { PendingView, StateView } from "../protocol";
import { createKeyForm, el, errorText, header, keepAliveOnActivity, nodes, notice, send, UiError, unlockForm } from "./common";
import { loadLang, t } from "./i18n";
import "./styles.css";

const root = document.getElementById("app")!;
const id = location.hash.slice(1);

/** The confirm button works only after the window has had focus for a moment. */
const ARM_MS = 1000;
let focusedSince: number | null = document.hasFocus() ? Date.now() : null;
window.addEventListener("focus", () => (focusedSince = Date.now()));
window.addEventListener("blur", () => (focusedSince = null));
// Keys pressed for the page (Tab, Space, Enter) can land here when the window pops up:
// every key press restarts the wait.
window.addEventListener("keydown", () => (focusedSince = document.hasFocus() ? Date.now() : null), { capture: true });
const armed = () => focusedSince !== null && Date.now() - focusedSince >= ARM_MS;

let timer: number | undefined;

function row(label: string, ...value: (Node | string | null)[]): HTMLElement {
  return el("div", { class: "row" }, el("div", { class: "label" }, label), el("div", { class: "value" }, ...value));
}

function finished(message: string): void {
  window.clearInterval(timer);
  root.replaceChildren(header(null, () => undefined), notice("info", message), el("button", { type: "button", class: "btn", onclick: () => window.close() }, "OK"));
}

function scope(v: PendingView): HTMLElement[] {
  const out: HTMLElement[] = [
    row(t("confirm.from"), el("span", { class: "mono origin" }, v.origin), v.official ? el("span", { class: "badge ok" }, t("site.official")) : el("span", { class: "badge bad" }, t("confirm.unofficial"))),
  ];
  if (v.keyAddress) out.push(row(t("confirm.key"), el("span", { class: "mono" }, v.keyAddress)));
  const s = v.sign;
  if (!s) return out;
  out.push(
    row(t("confirm.proposal"), el("strong", {}, `#${s.shortId}`), " ", s.title),
    row(t("confirm.choice"), el("strong", { class: `choice ${s.action.toLowerCase()}` }, t(`choice.${s.action}`))),
    el(
      "div",
      { class: "owners" },
      el("h3", {}, t("confirm.owners", { n: s.ballots.length })),
      el("p", { class: "muted small" }, t("confirm.ownersNote")),
      el("ol", {}, ...s.ballots.map((b) => el("li", { class: "mono" }, b.ownerAddress))),
    ),
    ...s.ballots.map((b) => el("details", { class: "fulltext" }, el("summary", {}, t("confirm.fullText", { owner: `${b.ownerAddress.slice(0, 10)}…${b.ownerAddress.slice(-8)}` })), el("pre", {}, b.text))),
    el("p", { class: "muted small" }, t("confirm.checkForum")),
  );
  return out;
}

async function render(): Promise<void> {
  let v: PendingView;
  let s: StateView;
  try {
    [v, s] = await Promise.all([send<PendingView>({ op: "pending", id }), send<StateView>({ op: "state" })]);
  } catch (e) {
    finished(e instanceof UiError && e.code === "EXPIRED" ? t("confirm.gone") : errorText(e));
    return;
  }
  const err = el("div", { class: "error", role: "alert" });
  const approve = el("button", { type: "button", class: "btn primary", disabled: true }, v.kind === "sign" ? t("confirm.approve", { n: v.sign?.ballots.length ?? 0 }) : t("confirm.approveConnect"));
  const reject = el("button", { type: "button", class: "btn" }, t("confirm.reject"));
  const countdown = el("span", { class: "muted small" });

  const needsKey = !s.hasKey;
  const needsUnlock = v.kind === "sign" && s.hasKey && s.locked;
  const blocked = needsKey || needsUnlock;

  approve.addEventListener("click", () => {
    if (!armed() || blocked) return;
    err.textContent = "";
    approve.disabled = true;
    send({ op: "approve", id }).then(
      () => {
        finished(t("confirm.done"));
        window.close();
      },
      (e: unknown) => {
        if (e instanceof UiError && (e.code === "LOCKED" || e.code === "NO_KEY")) {
          void render();
          return;
        }
        if (e instanceof UiError && (e.code === "EXPIRED" || e.code === "NOT_CONNECTED" || e.code === "ANCHOR_REUSED")) {
          finished(errorText(e));
          return;
        }
        err.textContent = errorText(e);
        approve.disabled = false;
      },
    );
  });
  reject.addEventListener("click", () => {
    void send({ op: "reject", id }).finally(() => window.close());
  });

  window.clearInterval(timer);
  const tick = () => {
    const left = Math.max(0, Math.ceil((v.deadline - Date.now()) / 1000));
    countdown.textContent = t("confirm.expires", { s: left });
    approve.disabled = blocked || !armed() || left === 0;
    if (left === 0) {
      window.clearInterval(timer);
      void render();
    }
  };
  timer = window.setInterval(tick, 200);
  tick();

  root.replaceChildren(
    ...nodes(
    header(s, () => void render()),
    s.flavor === "devnet" ? notice("warn", t("app.devnetNote")) : null,
    el("h1", {}, v.kind === "sign" ? t("confirm.signTitle") : t("confirm.connectTitle")),
    v.kind === "connect" ? el("p", {}, t("confirm.connectText")) : null,
    ...scope(v),
    needsKey ? el("div", {}, notice("warn", t("confirm.needKey")), createKeyForm(() => void render())) : null,
    needsUnlock ? el("div", {}, notice("info", t("confirm.unlockFirst")), unlockForm(() => void render())) : null,
    err,
    el("div", { class: "actions" }, reject, approve),
    countdown,
    ),
  );
}

void loadLang().then(render);
keepAliveOnActivity();
