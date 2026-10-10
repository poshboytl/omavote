// Toolbar popup: create, unlock and lock the key; connect the current site; list and
// disconnect sites; change the password or reset the key.

import { MIN_PASSWORD_LENGTH } from "../keystore";
import { acceptableOrigin, isOfficial, originPattern } from "../origins";
import type { StateView } from "../protocol";
import { createKeyForm, el, errorText, form, header, keepAliveOnActivity, nodes, notice, passwordField, send, UiError, unlockForm } from "./common";
import { loadLang, t } from "./i18n";
import "./styles.css";

const root = document.getElementById("app")!;

async function currentOrigin(): Promise<string | null> {
  // activeTab: opening the popup grants access to the active tab's URL.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    return tab?.url ? new URL(tab.url).origin : null;
  } catch {
    return null;
  }
}

function keySection(s: StateView): HTMLElement {
  const copy = el("button", { type: "button", class: "btn small" }, t("key.copy"));
  copy.addEventListener("click", () => {
    void navigator.clipboard.writeText(s.key?.address ?? "").then(() => {
      copy.textContent = t("key.copied");
    });
  });
  return el(
    "section",
    {},
    el("h2", {}, t("key.title")),
    el("div", { class: "muted small" }, t("key.address")),
    el("div", { class: "mono address" }, s.key?.address ?? ""),
    copy,
    s.locked
      ? el("div", {}, el("p", { class: "status bad" }, t("unlock.locked")), unlockForm(render))
      : el(
          "div",
          {},
          el("p", { class: "status ok" }, t("unlock.title")),
          el("p", { class: "muted small" }, t("unlock.note")),
          el("button", { type: "button", class: "btn", onclick: () => void send<StateView>({ op: "lock" }).then(render) }, t("unlock.lock")),
        ),
  );
}

function siteSection(s: StateView, origin: string | null): HTMLElement {
  const box = el("section", {}, el("h2", {}, t("site.current")));
  if (!origin || !acceptableOrigin(origin)) {
    box.append(el("p", { class: "muted" }, t("site.unsupported")));
    return box;
  }
  const official = isOfficial(origin, s.officialPatterns);
  const connected = s.sites.some((x) => x.origin === origin);
  const err = el("div", { class: "error", role: "alert" });
  box.append(
    ...nodes(
      el("div", { class: "mono" }, origin),
      official ? el("span", { class: "badge ok" }, t("site.official")) : null,
      el("p", { class: connected ? "status ok" : "status" }, connected ? t("site.connected") : t("site.notConnected")),
    ),
  );
  if (connected) {
    box.append(el("button", { type: "button", class: "btn", onclick: () => void send<StateView>({ op: "disconnectSite", origin }).then(render) }, t("site.disconnect")));
  } else {
    const button = el("button", { type: "button", class: "btn primary" }, t("site.connect"));
    button.addEventListener("click", () => {
      err.textContent = "";
      if (official) {
        void send<StateView>({ op: "connectSite", origin }).then(render, (e: unknown) => (err.textContent = errorText(e)));
        return;
      }
      // Tell the worker first: Chrome's permission prompt may close this popup, and the
      // worker then finishes the connection on permissions.onAdded (docs/19 §8).
      void send({ op: "expectConnect", origin }).catch(() => undefined);
      // Called synchronously inside the click so that Chrome sees the user gesture.
      chrome.permissions.request({ origins: [originPattern(origin)] }).then(
        (granted) => (granted ? send<StateView>({ op: "connectSite", origin }).then(render) : undefined),
        (e: unknown) => (err.textContent = errorText(e)),
      );
    });
    box.append(el("p", { class: "muted small" }, official ? t("site.officialConnectNote") : t("site.connectNote")), button, err);
  }
  return box;
}

function sitesSection(s: StateView): HTMLElement {
  return el(
    "section",
    {},
    el("h2", {}, t("sites.title")),
    s.sites.length === 0
      ? el("p", { class: "muted" }, t("sites.none"))
      : el(
          "ul",
          { class: "sites" },
          ...s.sites.map((x) =>
            el(
              "li",
              {},
              el("span", { class: "mono" }, x.origin),
              x.official ? el("span", { class: "badge ok" }, t("site.official")) : null,
              el("button", { type: "button", class: "btn small", onclick: () => void send<StateView>({ op: "disconnectSite", origin: x.origin }).then(render) }, t("site.disconnect")),
            ),
          ),
        ),
  );
}

function settingsSection(): HTMLElement {
  const oldP = passwordField(t("settings.oldPassword"), "current-password");
  const newP = passwordField(t("settings.newPassword"), "new-password");
  const saved = el("p", { class: "status ok" });
  const change = form([oldP.field, newP.field], t("settings.save"), async () => {
    if ([...newP.input.value].length < MIN_PASSWORD_LENGTH) throw new UiError("INVALID_REQUEST", t("create.short"));
    await send({ op: "changePassword", oldPassword: oldP.input.value, newPassword: newP.input.value });
    oldP.input.value = "";
    newP.input.value = "";
    saved.textContent = t("settings.saved");
  });
  const ack = el("input", { type: "checkbox" });
  const resetButton = el("button", { type: "button", class: "btn danger", disabled: true }, t("settings.resetConfirm"));
  ack.addEventListener("change", () => (resetButton.disabled = !ack.checked));
  resetButton.addEventListener("click", () => void send<StateView>({ op: "reset" }).then(render));
  return el(
    "section",
    {},
    el("h2", {}, t("settings.title")),
    el("details", {}, el("summary", {}, t("settings.changePassword")), change, saved),
    el(
      "details",
      {},
      el("summary", {}, t("settings.reset")),
      notice("bad", t("settings.resetWarn")),
      el("label", { class: "ack" }, ack, " ", t("settings.resetAck")),
      resetButton,
    ),
  );
}

async function render(state?: StateView): Promise<void> {
  const s = state ?? (await send<StateView>({ op: "state" }));
  const origin = await currentOrigin();
  root.replaceChildren(
    ...nodes(
      header(s, () => void render()),
      s.flavor === "devnet" ? notice("warn", t("app.devnetNote")) : null,
      ...(s.hasKey ? [keySection(s), siteSection(s, origin), sitesSection(s), settingsSection()] : [createKeyForm((x) => void render(x))]),
    ),
  );
}

void loadLang().then(() =>
  render().catch((e: unknown) => {
    root.replaceChildren(notice("bad", errorText(e)));
  }),
);
keepAliveOnActivity();
