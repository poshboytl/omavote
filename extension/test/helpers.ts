// Test helpers: the protocol core in Node, a manifest and delegate ballots built with
// it, and an in-memory stand-in for the Chrome APIs behind `Env`.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Core } from "../../web/src/lib/core";
import type { Action, BallotBody, KeyDescriptor, KeyInfo, Manifest, NetworkParams, Script } from "../../web/src/lib/types";
import type { ToContent } from "../src/protocol";
import { ADAPTER_CKB } from "../src/requests";
import type { Env, KeyValueStore, Sender } from "../src/signer";
import { call, initSync, version } from "../src/wasm/pkg/omavote_wasm.js";

let core: Core | null = null;

export function loadCore(): Core {
  if (!core) {
    initSync({ module: readFileSync(fileURLToPath(new URL("../src/wasm/pkg/omavote_wasm_bg.wasm", import.meta.url))) });
    core = new Core(call, version());
  }
  return core;
}

export function secretFor(label: string): string {
  return loadCore().ckbHashText(`omavote-extension-test:${label}`);
}

export function publicKeyOf(secret: string): string {
  return loadCore().call<{ public_key: string }>("secp256k1_public_key", { secret }).public_key;
}

export function keyOf(secret: string, network: NetworkParams): KeyInfo {
  const descriptor: KeyDescriptor = { kind: "secp256k1", public_key: publicKeyOf(secret), adapter: ADAPTER_CKB };
  return loadCore().key(descriptor, network);
}

export function ownerLock(label: string, network: NetworkParams): Script {
  return loadCore().secp256k1Lock(network, publicKeyOf(secretFor(label))).script;
}

export function buildManifest(network: NetworkParams, opts: { keyAdapters?: string[]; title?: string } = {}): Manifest {
  const c = loadCore();
  const proposer = ownerLock("proposer", network);
  const draft = {
    genesis: network.genesis_hash,
    nonce: c.nonce(),
    proposal_type: "grant",
    title: opts.title ?? "Fund the independent explorer",
    signing_title: opts.title ?? "Explorer grant",
    content_hash: c.ckbHashText("proposal body"),
    content_locations: ["https://example.invalid/p/1"],
    forum_topic_id: "42",
    forum_revision: "3",
    discussion_evidence_hash: null,
    budget_ckb_shannon: "100000000000000",
    quorum_base_shannon: "100000000000000",
    payment_terms_hash: null,
    recipient_lock_script: proposer,
    proposer_owner_locks: [proposer],
    rules_profile: c.defaultRules().rules_profile,
    auth_registry: { owner_adapters: [ADAPTER_CKB], key_adapters: opts.keyAdapters ?? [ADAPTER_CKB] },
    authorization_policy: c.authPolicy(network.genesis_hash).policy,
    start_ms: "1800000000000",
    result_confirmations: "100",
    review_window_ms: "86400000",
  };
  return c.manifestFromDraft(draft, network).manifest;
}

export function delegateBody(
  manifest: Manifest,
  key: KeyInfo,
  owner: Script,
  opts: { action?: Action; anchor?: string; authorizationId?: string; nonce?: string } = {},
): BallotBody {
  const c = loadCore();
  const info = c.manifestInfo(manifest);
  return {
    message_kind: "ballot",
    protocol_version: manifest.protocol_version,
    action: opts.action ?? "YES",
    authority: "delegate",
    authorization_id: opts.authorizationId ?? c.ckbHashText(`grant:${owner.args}`),
    signer_key_id: key.key_id,
    nonce: opts.nonce ?? c.nonce(),
    anchor_block_hash: opts.anchor ?? c.ckbHashText("anchor-1"),
    auth_adapter: ADAPTER_CKB,
    dao_namespace: manifest.dao_namespace,
    network_genesis_hash: manifest.network_genesis_hash,
    owner_lock: owner,
    poll_id: info.poll_id,
    rules_hash: info.rules_hash,
    signature_format: "omavote-readable-v2",
  };
}

// ---------------------------------------------------------------------------
// Fake browser

class MemoryStore implements KeyValueStore {
  readonly data = new Map<string, unknown>();
  async get<T>(key: string) {
    const v = this.data.get(key);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }
  async set(key: string, value: unknown) {
    this.data.set(key, structuredClone(value));
  }
  async remove(key: string) {
    this.data.delete(key);
  }
  async keys() {
    return [...this.data.keys()];
  }
}

export const EXT = "chrome-extension://testextensionid";

export class FakeBrowser {
  readonly local = new MemoryStore();
  /** Survives a "worker restart" (a new SignerService over the same env), like storage.session. */
  readonly session = new MemoryStore();
  clock = 1_800_000_000_000;
  readonly delivered: { tabId: number; documentId: string; msg: ToContent }[] = [];
  readonly changed: string[][] = [];
  readonly windows = new Set<number>();
  readonly closedWindows: number[] = [];
  readonly alarms = new Map<string, number>();
  readonly registered = new Set<string>();
  readonly injected: string[] = [];
  readonly removedPermissions: string[] = [];
  /** Documents that still exist; deliveries to others fail. */
  readonly liveDocuments = new Set<string>(["doc-1"]);
  /** Documents whose main thread is stuck: deliveries never settle. */
  readonly hungDocuments = new Set<string>();
  /** Host permissions granted at runtime (non-official sites). */
  readonly hostPermissions = new Set<string>();
  failWindows = false;
  private nextWindow = 100;
  private counter = 0;

  env(): Env {
    return {
      local: this.local,
      session: this.session,
      now: () => this.clock,
      randomHex: (n) => {
        this.counter += 1;
        return loadCore().ckbHashText(`random:${this.counter}`).slice(0, 2 + 2 * n);
      },
      extensionOrigin: EXT,
      sendToDocument: async (tabId, documentId, msg) => {
        if (this.hungDocuments.has(documentId)) return new Promise<boolean>(() => undefined);
        if (!this.liveDocuments.has(documentId)) return false;
        this.delivered.push({ tabId, documentId, msg });
        return true;
      },
      notifyChanged: async (patterns) => {
        this.changed.push(patterns);
      },
      openConfirmWindow: async () => {
        if (this.failWindows) throw new Error("no window");
        const id = this.nextWindow++;
        this.windows.add(id);
        return id;
      },
      closeWindow: async (id) => {
        this.windows.delete(id);
        this.closedWindows.push(id);
      },
      setAlarm: async (name, when) => {
        this.alarms.set(name, when);
      },
      clearAlarm: async (name) => {
        this.alarms.delete(name);
      },
      registerSite: async (p) => {
        this.registered.add(p);
      },
      unregisterSite: async (p) => {
        this.registered.delete(p);
      },
      injectIntoOpenTabs: async (p) => {
        this.injected.push(p);
      },
      removeHostPermission: async (p) => {
        this.removedPermissions.push(p);
        this.hostPermissions.delete(p);
      },
      hasHostPermission: async (p) => this.hostPermissions.has(p),
    };
  }

  /** Results delivered to the page for one request id. */
  results(reqId: string) {
    return this.delivered.filter((d) => d.msg.kind === "result" && d.msg.reqId === reqId).map((d) => d.msg);
  }
}

export function pageSender(origin = "https://vote.example", over: Partial<Sender> = {}): Sender {
  return { origin, url: `${origin}/#/p/1`, tab: { id: 7 }, frameId: 0, documentId: "doc-1", documentLifecycle: "active", ...over };
}

export const extensionSender: Sender = { origin: EXT, url: `${EXT}/popup.html` };
