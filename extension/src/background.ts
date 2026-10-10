// Service worker: wires the Chrome APIs into SignerService. Listeners are registered
// synchronously at the top level so that events wake the worker; the protocol core
// (WASM) loads on first use.

import { Core } from "../../web/src/lib/core";
import { bytesToHex } from "../../web/src/lib/hex";
import { FLAVOR, NETWORK, OFFICIAL_PATTERNS } from "./config";
import type { ToContent } from "./protocol";
import { SignerService, type Env, type KeyValueStore, type Sender } from "./signer";
import init, { call, version } from "./wasm/pkg/omavote_wasm.js";

function store(area: chrome.storage.StorageArea): KeyValueStore {
  return {
    async get<T>(key: string) {
      return (await area.get(key))[key] as T | undefined;
    },
    async set(key, value) {
      await area.set({ [key]: value });
    },
    async remove(key) {
      await area.remove(key);
    },
    async keys() {
      return Object.keys(await area.get(null));
    },
  };
}

function scriptIds(pattern: string): [string, string] {
  const id = `site-${bytesToHex(new TextEncoder().encode(pattern)).slice(2)}`;
  return [`${id}-content`, `${id}-inpage`];
}

async function tabsUnder(pattern: string | string[]): Promise<chrome.tabs.Tab[]> {
  try {
    return await chrome.tabs.query({ url: pattern });
  } catch {
    return [];
  }
}

const env: Env = {
  local: store(chrome.storage.local),
  session: store(chrome.storage.session),
  now: () => Date.now(),
  randomHex: (n) => bytesToHex(crypto.getRandomValues(new Uint8Array(n))),
  extensionOrigin: new URL(chrome.runtime.getURL("/")).origin,
  async sendToDocument(tabId, documentId, msg: ToContent) {
    try {
      await chrome.tabs.sendMessage(tabId, msg, { documentId });
      return true;
    } catch {
      return false;
    }
  },
  async notifyChanged(patterns) {
    if (patterns.length === 0) return;
    for (const t of await tabsUnder(patterns)) {
      if (t.id !== undefined) chrome.tabs.sendMessage(t.id, { kind: "changed" } satisfies ToContent, { frameId: 0 }).catch(() => undefined);
    }
  },
  async openConfirmWindow(id) {
    const w = await chrome.windows.create({ url: chrome.runtime.getURL(`confirm.html#${id}`), type: "popup", width: 460, height: 720, focused: true });
    return w?.id;
  },
  async closeWindow(windowId) {
    await chrome.windows.remove(windowId);
  },
  async setAlarm(name, when) {
    await chrome.alarms.create(name, { when });
  },
  async clearAlarm(name) {
    await chrome.alarms.clear(name);
  },
  async registerSite(pattern) {
    const [content, inpage] = scriptIds(pattern);
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [content, inpage] });
    if (existing.length === 2) return;
    if (existing.length > 0) await chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
    await chrome.scripting.registerContentScripts([
      { id: content, matches: [pattern], js: ["content.js"], runAt: "document_start", allFrames: false, persistAcrossSessions: true },
      { id: inpage, matches: [pattern], js: ["inpage.js"], runAt: "document_start", allFrames: false, persistAcrossSessions: true, world: "MAIN" },
    ]);
  },
  async unregisterSite(pattern) {
    await chrome.scripting.unregisterContentScripts({ ids: scriptIds(pattern) }).catch(() => undefined);
  },
  async injectIntoOpenTabs(pattern) {
    for (const t of await tabsUnder(pattern)) {
      if (t.id === undefined) continue;
      await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["content.js"] }).catch(() => undefined);
      await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["inpage.js"], world: "MAIN" }).catch(() => undefined);
    }
  },
  async removeHostPermission(pattern) {
    await chrome.permissions.remove({ origins: [pattern] }).catch(() => undefined);
  },
};

let service: Promise<SignerService> | null = null;

function ready(): Promise<SignerService> {
  if (!service) {
    service = init({ module_or_path: chrome.runtime.getURL("omavote_wasm_bg.wasm") }).then(async () => {
      const core = new Core(call, version());
      const s = new SignerService(env, core, { flavor: FLAVOR, network: NETWORK ?? core.knownNetwork("mainnet"), officialPatterns: OFFICIAL_PATTERNS });
      await s.start();
      return s;
    });
    service.catch(() => {
      service = null;
    });
  }
  return service;
}

function sender(s: chrome.runtime.MessageSender): Sender {
  return {
    origin: s.origin,
    url: s.url,
    tab: s.tab ? { id: s.tab.id } : undefined,
    frameId: s.frameId,
    documentId: s.documentId,
    documentLifecycle: s.documentLifecycle,
  };
}

chrome.runtime.onMessage.addListener((msg: { kind?: string } | undefined, s, sendResponse) => {
  const from = sender(s);
  ready()
    .then((svc): Promise<unknown> => (msg?.kind === "page" ? svc.handlePage(msg, from) : svc.handleInternal(msg, from)))
    .then(sendResponse, (e: unknown) => sendResponse({ status: "error", ok: false, code: "INVALID_REQUEST", message: String(e) }));
  return true;
});

chrome.alarms.onAlarm.addListener((a) => void ready().then((svc) => svc.onAlarm(a.name)));
chrome.windows.onRemoved.addListener((id) => void ready().then((svc) => svc.onWindowRemoved(id)));
chrome.permissions.onAdded.addListener((p) => void ready().then((svc) => svc.onPermissionsAdded(p.origins ?? [])));
chrome.permissions.onRemoved.addListener((p) => void ready().then((svc) => svc.onPermissionsRemoved(p.origins ?? [])));
chrome.runtime.onStartup.addListener(() => void ready());

// Re-register host-level injections after an update (registrations persist, but be safe).
chrome.runtime.onInstalled.addListener(() => {
  void chrome.permissions.getAll().then(async (p) => {
    for (const pattern of p.origins ?? []) {
      if (!OFFICIAL_PATTERNS.includes(pattern)) await env.registerSite(pattern).catch(() => undefined);
    }
  });
});
