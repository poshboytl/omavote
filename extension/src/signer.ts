// The service worker's logic (docs/19 §3-§7), written against a small `Env` so the
// security checks can be exercised in unit tests without a browser.
//
// State that must survive the worker being recycled lives in storage: the keystore,
// sites and signing history in `local`; the unlocked key and pending requests in
// `session` (memory only, cleared when the browser or the extension restarts).

import type { Core } from "../../web/src/lib/core";
import type { KeyDescriptor, KeyInfo, NetworkParams } from "../../web/src/lib/types";
import { checkPassword, decryptSecret, encryptSecret, type Keystore } from "./keystore";
import { acceptableOrigin, isOfficial, isSingleHostPattern, matchesPattern, originPattern } from "./origins";
import {
  PAGE_METHODS,
  SignerError,
  type ErrorCode,
  type InternalReply,
  type InternalRequest,
  type PageKey,
  type PageReply,
  type PageRequest,
  type PendingView,
  type StateView,
  type ToContent,
} from "./protocol";
import { ADAPTER_CKB, checkSignRequest, type CheckedRequest } from "./requests";

export const IDLE_LOCK_MS = 15 * 60_000;
export const CONFIRM_TIMEOUT_MS = 5 * 60_000;
/** After a rejection, the same site waits this long before it can ask again. */
export const REJECT_COOLDOWN_MS = 5_000;
const CONNECT_INTENT_MS = 2 * 60_000;
const DELIVERY_TIMEOUT_MS = 2_000;

/** Operations that come from a user action in the extension's own pages. */
const USER_OPS = new Set(["touch", "create", "unlock", "approve", "reject", "changePassword", "expectConnect", "connectSite", "disconnectSite"]);

export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export interface Env {
  local: KeyValueStore;
  session: KeyValueStore;
  now(): number;
  randomHex(bytes: number): string;
  /** chrome-extension://<id> */
  extensionOrigin: string;
  /** Deliver to one document (chrome.tabs.sendMessage with documentId); false when it is gone. */
  sendToDocument(tabId: number, documentId: string, msg: ToContent): Promise<boolean>;
  /** Tell every open tab under these patterns that the connection or key changed. */
  notifyChanged(patterns: string[]): Promise<void>;
  openConfirmWindow(pendingId: string): Promise<number | undefined>;
  closeWindow(windowId: number): Promise<void>;
  setAlarm(name: string, when: number): Promise<void>;
  clearAlarm(name: string): Promise<void>;
  /** Content-script registration for a non-official host (ISOLATED relay + MAIN window.omavote). */
  registerSite(pattern: string): Promise<void>;
  unregisterSite(pattern: string): Promise<void>;
  injectIntoOpenTabs(pattern: string): Promise<void>;
  removeHostPermission(pattern: string): Promise<void>;
  hasHostPermission(pattern: string): Promise<boolean>;
}

export interface SignerConfig {
  flavor: "release" | "devnet";
  network: NetworkParams;
  officialPatterns: string[];
  /** How long to wait for a page to take a message (a stuck page must not stall the queue). */
  deliveryTimeoutMs?: number;
}

/** What the browser says about who sent a message (chrome.runtime.MessageSender). */
export interface Sender {
  origin?: string;
  url?: string;
  tab?: { id?: number };
  frameId?: number;
  documentId?: string;
  documentLifecycle?: string;
}

interface Site {
  connected: boolean;
  version: number;
}

interface Unlocked {
  secret: string;
  publicKey: string;
  deadline: number;
}

interface Pending {
  id: string;
  reqId: string;
  kind: "connect" | "sign";
  origin: string;
  tabId: number;
  documentId: string;
  keyId: string | null;
  siteVersion: number;
  deadline: number;
  windowId?: number;
  request?: CheckedRequest;
}

const K = {
  keystore: "keystore",
  sites: "sites",
  signed: "signed",
  unlocked: "unlocked",
  intent: "connectIntent",
  pending: (id: string) => `pending:${id}`,
  cooldown: (origin: string) => `cooldown:${origin}`,
};

function fail(code: ErrorCode, message?: string): never {
  throw new SignerError(code, message);
}

export class SignerService {
  private readonly env: Env;
  private readonly core: Core;
  private readonly config: SignerConfig;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(env: Env, core: Core, config: SignerConfig) {
    this.env = env;
    this.core = core;
    this.config = config;
  }

  /** One handler at a time: every handler reads and writes shared storage. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  // ---------------------------------------------------------------------------
  // Keys

  private descriptorFor(publicKey: string): KeyDescriptor {
    return { kind: "secp256k1", public_key: publicKey, adapter: ADAPTER_CKB };
  }

  private async keyInfo(): Promise<KeyInfo | null> {
    const ks = await this.env.local.get<Keystore>(K.keystore);
    return ks ? this.core.key(this.descriptorFor(ks.public_key), this.config.network) : null;
  }

  private publicKeyOf(secret: string): string {
    return this.core.call<{ public_key: string }>("secp256k1_public_key", { secret }).public_key;
  }

  private async unlocked(): Promise<Unlocked | null> {
    const u = await this.env.session.get<Unlocked>(K.unlocked);
    if (!u) return null;
    // The deadline decides, not the alarm: an alarm can fire late after sleep.
    if (this.env.now() > u.deadline) {
      await this.env.session.remove(K.unlocked);
      return null;
    }
    return u;
  }

  private async setUnlocked(secret: string, publicKey: string): Promise<void> {
    const deadline = this.env.now() + IDLE_LOCK_MS;
    await this.env.session.set(K.unlocked, { secret, publicKey, deadline } satisfies Unlocked);
    await this.env.setAlarm("lock", deadline);
  }

  /** Activity in the extension's own pages postpones the lock; page calls never do. */
  private async touch(): Promise<void> {
    const u = await this.unlocked();
    if (u) await this.setUnlocked(u.secret, u.publicKey);
  }

  private pageKey(k: KeyInfo): PageKey {
    return { descriptor: k.descriptor, key_id: k.key_id, display: k.key_display ?? "", genesis: this.config.network.genesis_hash };
  }

  // ---------------------------------------------------------------------------
  // Sites

  private async sites(): Promise<Record<string, Site>> {
    return (await this.env.local.get<Record<string, Site>>(K.sites)) ?? {};
  }

  private async site(origin: string): Promise<Site> {
    return (await this.sites())[origin] ?? { connected: false, version: 0 };
  }

  private async setConnected(origin: string, connected: boolean): Promise<void> {
    const all = await this.sites();
    const cur = all[origin] ?? { connected: false, version: 0 };
    if (cur.connected === connected && all[origin]) return;
    all[origin] = { connected, version: cur.version + 1 };
    await this.env.local.set(K.sites, all);
    if (!connected) await this.invalidateOrigin(origin, "NOT_CONNECTED", "the site was disconnected");
    await this.env.notifyChanged([originPattern(origin)]);
  }

  private official(origin: string): boolean {
    return isOfficial(origin, this.config.officialPatterns);
  }

  /** Official sites always; others only while Chrome grants the extension access to them. */
  private async reachable(origin: string): Promise<boolean> {
    return this.official(origin) || this.env.hasHostPermission(originPattern(origin));
  }

  /** Deliver to a document, giving up after a short wait (false: gone or stuck). */
  private send(tabId: number, documentId: string, msg: ToContent): Promise<boolean> {
    const ms = this.config.deliveryTimeoutMs ?? DELIVERY_TIMEOUT_MS;
    return Promise.race([
      this.env.sendToDocument(tabId, documentId, msg),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
    ]);
  }

  // ---------------------------------------------------------------------------
  // Pending requests

  private async allPending(): Promise<Pending[]> {
    const out: Pending[] = [];
    for (const k of await this.env.session.keys()) {
      if (!k.startsWith("pending:")) continue;
      const p = await this.env.session.get<Pending>(k);
      if (p) out.push(p);
    }
    return out;
  }

  private async deliver(p: Pending, msg: { ok: true; result: unknown } | { ok: false; code: ErrorCode; message: string }): Promise<boolean> {
    return this.send(p.tabId, p.documentId, { kind: "result", reqId: p.reqId, ...msg } as ToContent);
  }

  /** Remove a pending request; the page gets `code` and the confirm window closes. */
  private async finish(p: Pending, outcome: { ok: true; result: unknown } | { ok: false; code: ErrorCode; message: string }): Promise<void> {
    await this.env.session.remove(K.pending(p.id));
    await this.env.clearAlarm(`expire:${p.id}`);
    if (!outcome.ok && outcome.code === "USER_REJECTED") {
      await this.env.session.set(K.cooldown(p.origin), this.env.now() + REJECT_COOLDOWN_MS);
    }
    await this.deliver(p, outcome);
    if (p.windowId !== undefined) await this.env.closeWindow(p.windowId).catch(() => undefined);
  }

  private async invalidateOrigin(origin: string, code: ErrorCode, message: string): Promise<void> {
    for (const p of await this.allPending()) if (p.origin === origin) await this.finish(p, { ok: false, code, message });
  }

  private async invalidateAll(code: ErrorCode, message: string): Promise<void> {
    for (const p of await this.allPending()) await this.finish(p, { ok: false, code, message });
  }

  /** Expire overdue requests (called on every wake-up and every message). */
  private async sweep(): Promise<void> {
    const now = this.env.now();
    for (const p of await this.allPending()) {
      if (now > p.deadline) await this.finish(p, { ok: false, code: "EXPIRED", message: "the confirmation window timed out" });
    }
  }

  private async createPending(p: Omit<Pending, "id" | "deadline">): Promise<void> {
    const pending: Pending = { ...p, id: this.env.randomHex(16), deadline: this.env.now() + CONFIRM_TIMEOUT_MS };
    await this.env.session.set(K.pending(pending.id), pending);
    await this.env.setAlarm(`expire:${pending.id}`, pending.deadline);
    let windowId: number | undefined;
    try {
      windowId = await this.env.openConfirmWindow(pending.id);
    } catch {
      await this.env.session.remove(K.pending(pending.id));
      await this.env.clearAlarm(`expire:${pending.id}`);
      fail("INVALID_REQUEST", "the confirmation window could not be opened");
    }
    if (windowId !== undefined) {
      // The window may already have been closed (and the request rejected) meanwhile.
      const still = await this.env.session.get<Pending>(K.pending(pending.id));
      if (still) await this.env.session.set(K.pending(pending.id), { ...still, windowId });
    }
  }

  private async view(p: Pending): Promise<PendingView> {
    const key = await this.keyInfo();
    const v: PendingView = {
      id: p.id,
      kind: p.kind,
      origin: p.origin,
      official: this.official(p.origin),
      deadline: p.deadline,
      keyAddress: key?.key_display ?? null,
    };
    if (p.request) {
      const r = p.request;
      v.sign = {
        pollId: r.pollId,
        shortId: r.shortId,
        title: r.title,
        action: r.action,
        ballots: r.ballots.map((b) => ({ ownerAddress: b.ownerAddress, ownerId: b.ownerId, ballotId: b.ballotId, summary: b.summary, text: b.text })),
      };
    }
    return v;
  }

  // ---------------------------------------------------------------------------
  // Page requests (content script -> service worker)

  handlePage(msg: unknown, sender: Sender): Promise<PageReply> {
    return this.exclusive(async () => {
      try {
        return await this.page(msg, sender);
      } catch (e) {
        if (e instanceof SignerError) return { status: "error", code: e.code, message: e.message };
        return { status: "error", code: "INVALID_REQUEST", message: e instanceof Error ? e.message : String(e) };
      }
    });
  }

  private pageOrigin(sender: Sender): { origin: string; tabId: number; documentId: string } {
    // Origin and document come from the browser, never from the message (docs/19 §5.3).
    const origin = sender.origin ?? (sender.url ? new URL(sender.url).origin : "");
    if (origin === this.env.extensionOrigin || !acceptableOrigin(origin)) fail("FORBIDDEN", "requests are accepted from https sites only");
    if (sender.tab?.id === undefined || sender.documentId === undefined) fail("FORBIDDEN", "requests must come from a tab");
    if (sender.frameId !== 0) fail("FORBIDDEN", "requests from frames are refused");
    if (sender.documentLifecycle !== undefined && sender.documentLifecycle !== "active") fail("FORBIDDEN", "the page is not active");
    return { origin, tabId: sender.tab.id, documentId: sender.documentId };
  }

  private async page(msg: unknown, sender: Sender): Promise<PageReply> {
    const { origin, tabId, documentId } = this.pageOrigin(sender);
    const m = msg as Partial<PageRequest>;
    if (m?.kind !== "page" || typeof m.reqId !== "string" || m.reqId.length === 0 || m.reqId.length > 64) fail("INVALID_REQUEST", "malformed request");
    if (!PAGE_METHODS.includes(m.method as never)) fail("INVALID_REQUEST", `unknown method ${String(m.method)}`);
    await this.sweep();
    const site = await this.site(origin);
    const key = await this.keyInfo();
    const reachable = await this.reachable(origin);
    const busy = async () => {
      const until = await this.env.session.get<number>(K.cooldown(origin));
      return (until !== undefined && this.env.now() < until) || (await this.allPending()).some((p) => p.origin === origin);
    };

    switch (m.method) {
      case "getKey":
        return { status: "done", result: reachable && site.connected && key ? this.pageKey(key) : null };
      case "disconnect":
        await this.setConnected(origin, false);
        return { status: "done", result: null };
      case "connect": {
        if (!reachable) fail("NOT_CONNECTED", "connect this site from the extension's toolbar button first");
        if (site.connected && key) return { status: "done", result: this.pageKey(key) };
        if (await busy()) fail("BUSY", "a request from this site is already waiting for confirmation");
        await this.createPending({ reqId: m.reqId, kind: "connect", origin, tabId, documentId, keyId: key?.key_id ?? null, siteVersion: site.version });
        return { status: "pending" };
      }
      case "signBallots": {
        if (!reachable || !site.connected) fail("NOT_CONNECTED", "connect this site first");
        if (!key) fail("NO_KEY", "create a key in the extension first");
        if (await busy()) fail("BUSY", "a request from this site is already waiting for confirmation");
        const signed = (await this.env.local.get<Record<string, string>>(K.signed)) ?? {};
        const request = checkSignRequest(this.core, this.config.network, key, m.params, (slot) => signed[slot]);
        await this.createPending({ reqId: m.reqId, kind: "sign", origin, tabId, documentId, keyId: key.key_id, siteVersion: site.version, request });
        return { status: "pending" };
      }
    }
    return fail("INVALID_REQUEST", "unknown method");
  }

  // ---------------------------------------------------------------------------
  // Internal requests (popup and confirm window only)

  handleInternal(msg: unknown, sender: Sender): Promise<InternalReply> {
    return this.exclusive(async () => {
      try {
        // Content scripts share the extension id but not its origin (docs/19 §5.3).
        const ext = this.env.extensionOrigin;
        const own = sender.origin !== undefined ? sender.origin === ext : (sender.url?.startsWith(`${ext}/`) ?? false);
        if (!own) fail("FORBIDDEN", "internal operations are only accepted from the extension's own pages");
        await this.sweep();
        const value = await this.internal(msg as InternalRequest);
        return { ok: true, value };
      } catch (e) {
        if (e instanceof SignerError) return { ok: false, code: e.code, message: e.message };
        return { ok: false, code: "INVALID_REQUEST", message: e instanceof Error ? e.message : String(e) };
      }
    });
  }

  private async internal(m: InternalRequest): Promise<unknown> {
    if (m?.kind !== "internal") fail("INVALID_REQUEST", "malformed request");
    // Only user actions keep the key unlocked: the confirmation window's own requests
    // (`pending`, `state`) must not, or a site could keep it unlocked by asking often.
    if (USER_OPS.has(m.op)) await this.touch();
    switch (m.op) {
      case "state":
        return this.state();
      case "create":
        return this.create(m.password);
      case "unlock": {
        const ks = await this.env.local.get<Keystore>(K.keystore);
        if (!ks) fail("NO_KEY", "there is no key yet");
        const secret = await decryptSecret(ks, String(m.password ?? ""), (s) => this.publicKeyOf(s));
        await this.setUnlocked(secret, ks.public_key);
        return this.state();
      }
      case "lock":
        await this.env.session.remove(K.unlocked);
        await this.env.clearAlarm("lock");
        return this.state();
      case "reset":
        return this.reset();
      case "changePassword": {
        const ks = await this.env.local.get<Keystore>(K.keystore);
        if (!ks) fail("NO_KEY", "there is no key yet");
        const secret = await decryptSecret(ks, String(m.oldPassword ?? ""), (s) => this.publicKeyOf(s));
        await this.env.local.set(K.keystore, await encryptSecret(secret, ks.public_key, String(m.newPassword ?? "")));
        return this.state();
      }
      case "touch":
        return null;
      case "expectConnect":
        if (!acceptableOrigin(m.origin)) fail("INVALID_REQUEST", "only https sites and local development addresses can be connected");
        await this.env.session.set(K.intent, { origin: m.origin, until: this.env.now() + CONNECT_INTENT_MS });
        return null;
      case "connectSite":
        if (!acceptableOrigin(m.origin)) fail("INVALID_REQUEST", "only https sites and local development addresses can be connected");
        await this.setConnected(m.origin, true);
        return this.state();
      case "disconnectSite":
        await this.setConnected(m.origin, false);
        if (!this.official(m.origin)) {
          const pattern = originPattern(m.origin);
          await this.env.unregisterSite(pattern);
          await this.env.removeHostPermission(pattern);
        }
        return this.state();
      case "pending": {
        const p = await this.env.session.get<Pending>(K.pending(m.id));
        if (!p) fail("EXPIRED", "this request is no longer waiting");
        return this.view(p);
      }
      case "approve":
        return this.approve(m.id);
      case "reject": {
        const p = await this.env.session.get<Pending>(K.pending(m.id));
        if (p) await this.finish(p, { ok: false, code: "USER_REJECTED", message: "the user rejected the request" });
        return null;
      }
    }
    return fail("INVALID_REQUEST", "unknown operation");
  }

  private async state(): Promise<StateView> {
    const key = await this.keyInfo();
    const sites = await this.sites();
    return {
      flavor: this.config.flavor,
      network: this.config.network.name,
      hasKey: key !== null,
      locked: (await this.unlocked()) === null,
      key: key ? { address: key.key_display ?? "", short: key.key_short ?? "", key_id: key.key_id } : null,
      sites: Object.entries(sites)
        .filter(([, s]) => s.connected)
        .map(([origin]) => ({ origin, official: this.official(origin), connected: true })),
      officialPatterns: this.config.officialPatterns,
    };
  }

  private async create(password: string): Promise<StateView> {
    if (await this.env.local.get<Keystore>(K.keystore)) fail("FORBIDDEN", "a key already exists; reset it first");
    checkPassword(String(password ?? ""));
    // A random 32-byte string is a valid secret except with negligible probability.
    for (;;) {
      const secret = this.env.randomHex(32);
      let publicKey: string;
      try {
        publicKey = this.publicKeyOf(secret);
      } catch {
        continue;
      }
      await this.env.local.set(K.keystore, await encryptSecret(secret, publicKey, password));
      await this.setUnlocked(secret, publicKey);
      return this.state();
    }
  }

  /** Delete the key and its history; every site must connect again (docs/19 §3.7). */
  private async reset(): Promise<StateView> {
    await this.invalidateAll("NOT_CONNECTED", "the extension's key was reset");
    await this.env.local.remove(K.keystore);
    await this.env.local.remove(K.signed);
    await this.env.session.remove(K.unlocked);
    await this.env.clearAlarm("lock");
    const sites = await this.sites();
    const patterns: string[] = [];
    for (const [origin, s] of Object.entries(sites)) {
      if (s.connected) patterns.push(originPattern(origin));
      sites[origin] = { connected: false, version: s.version + 1 };
    }
    await this.env.local.set(K.sites, sites);
    await this.env.notifyChanged(patterns);
    return this.state();
  }

  private async approve(id: string): Promise<unknown> {
    const p = await this.env.session.get<Pending>(K.pending(id));
    if (!p) fail("EXPIRED", "this request is no longer waiting");
    const now = this.env.now();
    if (now > p.deadline) {
      await this.finish(p, { ok: false, code: "EXPIRED", message: "the confirmation window timed out" });
      fail("EXPIRED", "the confirmation window timed out");
    }
    const key = await this.keyInfo();
    if (!key) fail("NO_KEY", "create a key first");

    // Bound at creation: same site connection (version), same key, same live document.
    const site = await this.site(p.origin);
    if (p.kind === "sign") {
      if (!(await this.unlocked())) fail("LOCKED", "unlock the extension to sign");
      if (!site.connected || site.version !== p.siteVersion) {
        await this.finish(p, { ok: false, code: "NOT_CONNECTED", message: "the site was disconnected" });
        fail("NOT_CONNECTED", "the site was disconnected after the request was made");
      }
      if (key.key_id !== p.keyId) {
        await this.finish(p, { ok: false, code: "NOT_CONNECTED", message: "the extension's key changed" });
        fail("NOT_CONNECTED", "the key changed after the request was made");
      }
    } else if (site.version !== p.siteVersion) {
      await this.finish(p, { ok: false, code: "NOT_CONNECTED", message: "the connection changed" });
      fail("NOT_CONNECTED", "the connection changed after the request was made");
    }
    if (!(await this.reachable(p.origin))) {
      await this.finish(p, { ok: false, code: "NOT_CONNECTED", message: "the extension no longer has access to this site" });
      fail("NOT_CONNECTED", "the extension no longer has access to this site");
    }
    if (!(await this.send(p.tabId, p.documentId, { kind: "ping" }))) {
      await this.finish(p, { ok: false, code: "EXPIRED", message: "the page is gone" });
      fail("EXPIRED", "the page that made the request was closed or navigated away");
    }

    if (p.kind === "connect") {
      await this.setConnected(p.origin, true);
      await this.finish(p, { ok: true, result: this.pageKey(key) });
      return null;
    }

    const u = await this.unlocked();
    if (!u || u.publicKey !== (key.descriptor as { public_key: string }).public_key) fail("LOCKED", "unlock the extension to sign");
    const request = p.request!;
    const signed = (await this.env.local.get<Record<string, string>>(K.signed)) ?? {};
    for (const b of request.ballots) {
      const prior = signed[b.slot];
      if (prior !== undefined && prior !== b.ballotId) {
        await this.finish(p, { ok: false, code: "ANCHOR_REUSED", message: "a different ballot was signed on this anchor meanwhile" });
        fail("ANCHOR_REUSED", "a different ballot was signed on this anchor meanwhile");
      }
    }
    const signatures = request.ballots.map((b) => {
      const sig = this.core.call<{ signature: string }>("ckb_sign_message", { secret: u.secret, text: b.text }).signature;
      const check = this.core.verifyKey(key.descriptor, b.text, sig);
      if (!check.ok) fail("INVALID_REQUEST", `self-check failed: ${check.error ?? "unknown"}`);
      return sig;
    });
    for (const b of request.ballots) signed[b.slot] = b.ballotId;
    await this.env.local.set(K.signed, signed);
    await this.finish(p, { ok: true, result: { signatures } });
    return null;
  }

  // ---------------------------------------------------------------------------
  // Browser events

  onAlarm(name: string): Promise<void> {
    return this.exclusive(async () => {
      if (name === "lock") await this.unlocked();
      await this.sweep();
    });
  }

  onWindowRemoved(windowId: number): Promise<void> {
    return this.exclusive(async () => {
      for (const p of await this.allPending()) {
        if (p.windowId === windowId) {
          p.windowId = undefined;
          await this.finish(p, { ok: false, code: "USER_REJECTED", message: "the confirmation window was closed" });
        }
      }
    });
  }

  /** Host access granted (toolbar connect, or Chrome's own site-access menu). */
  onPermissionsAdded(patterns: string[]): Promise<void> {
    return this.exclusive(async () => {
      const intent = await this.env.session.get<{ origin: string; until: number }>(K.intent);
      for (const pattern of patterns) {
        if (this.config.officialPatterns.includes(pattern) || !isSingleHostPattern(pattern)) continue;
        // Chrome may batch several hosts into one event: one failure must not skip the rest.
        try {
          await this.env.registerSite(pattern);
          await this.env.injectIntoOpenTabs(pattern);
        } catch (e) {
          console.warn(`omavote signer: could not inject into ${pattern}`, e);
          continue;
        }
        // Only a connect the user started in the toolbar popup also counts as a connection.
        if (intent && intent.until >= this.env.now() && matchesPattern(intent.origin, pattern)) {
          await this.env.session.remove(K.intent);
          await this.setConnected(intent.origin, true);
        }
      }
    });
  }

  onPermissionsRemoved(patterns: string[]): Promise<void> {
    return this.exclusive(async () => {
      const sites = await this.sites();
      for (const pattern of patterns) {
        if (this.config.officialPatterns.includes(pattern)) continue;
        await this.env.unregisterSite(pattern);
        for (const origin of Object.keys(sites)) if (matchesPattern(origin, pattern)) await this.setConnected(origin, false);
        // Requests from sites that were never connected (a pending connect) go too.
        for (const p of await this.allPending()) {
          if (matchesPattern(p.origin, pattern)) await this.finish(p, { ok: false, code: "NOT_CONNECTED", message: "access to the site was revoked" });
        }
      }
    });
  }

  /** Wake-up housekeeping. */
  start(): Promise<void> {
    return this.exclusive(() => this.sweep());
  }
}
