// Security boundaries of the service worker (docs/19 §12): the failure cases matter
// more than the happy path.

import { beforeAll, describe, expect, it } from "vitest";
import type { KeyDescriptor, Manifest, NetworkParams } from "../../web/src/lib/types";
import type { InternalReply, InternalRequest, PageReply, PendingView, StateView } from "../src/protocol";
import { CONFIRM_TIMEOUT_MS, IDLE_LOCK_MS, SignerService } from "../src/signer";
import { buildManifest, delegateBody, EXT, extensionSender, FakeBrowser, loadCore, ownerLock, pageSender } from "./helpers";

const OFFICIAL = "https://vote.example";
const MIRROR = "https://mirror.example";
const PASSWORD = "correct horse battery staple";

let network: NetworkParams;
let manifest: Manifest;

beforeAll(() => {
  network = loadCore().knownNetwork("testnet");
  manifest = buildManifest(network);
});

function service(b: FakeBrowser): SignerService {
  return new SignerService(b.env(), loadCore(), { flavor: "devnet", network, officialPatterns: [`${OFFICIAL}/*`] });
}

async function internal(svc: SignerService, req: Omit<InternalRequest, "kind">): Promise<InternalReply> {
  return svc.handleInternal({ kind: "internal", ...req }, extensionSender);
}

async function page(svc: SignerService, reqId: string, method: string, params?: unknown, origin = OFFICIAL): Promise<PageReply> {
  return svc.handlePage({ kind: "page", reqId, method, params }, pageSender(origin));
}

async function pendingIds(b: FakeBrowser): Promise<string[]> {
  return (await b.session.keys()).filter((k) => k.startsWith("pending:")).map((k) => k.slice("pending:".length));
}

async function onlyPending(b: FakeBrowser): Promise<string> {
  const ids = await pendingIds(b);
  expect(ids).toHaveLength(1);
  return ids[0]!;
}

/** A browser with a key, connected to the official site. */
async function ready(): Promise<{ b: FakeBrowser; svc: SignerService }> {
  const b = new FakeBrowser();
  const svc = service(b);
  expect((await internal(svc, { op: "create", password: PASSWORD } as InternalRequest)).ok).toBe(true);
  expect(await page(svc, "c1", "connect")).toEqual({ status: "pending" });
  expect((await internal(svc, { op: "approve", id: await onlyPending(b) } as InternalRequest)).ok).toBe(true);
  return { b, svc };
}

async function state(svc: SignerService): Promise<StateView> {
  const r = await internal(svc, { op: "state" } as InternalRequest);
  if (!r.ok) throw new Error(r.message);
  return r.value as StateView;
}

async function signRequest(svc: SignerService, owners: string[] = ["alice"], opts: { anchor?: string; action?: "YES" | "NO" } = {}) {
  const r = (await page(svc, "k", "getKey")) as { status: "done"; result: { descriptor: KeyDescriptor } };
  const key = loadCore().key(r.result.descriptor, network);
  const bodies = owners.map((o) => delegateBody(manifest, key, ownerLock(o, network), { anchor: opts.anchor, action: opts.action }));
  return { manifest, bodies };
}

describe("connection", () => {
  it("connects only after confirmation and hands out the key", async () => {
    const b = new FakeBrowser();
    const svc = service(b);
    await internal(svc, { op: "create", password: PASSWORD } as InternalRequest);
    expect(await page(svc, "g", "getKey")).toEqual({ status: "done", result: null });
    expect(await page(svc, "c", "connect")).toEqual({ status: "pending" });
    const id = await onlyPending(b);
    expect(await page(svc, "c2", "connect")).toMatchObject({ status: "error", code: "BUSY" });
    await internal(svc, { op: "approve", id } as InternalRequest);
    const r = b.results("c")[0];
    expect(r).toMatchObject({ ok: true });
    const key = (r as { result: { descriptor: { kind: string }; display: string; genesis: string } }).result;
    expect(key.descriptor.kind).toBe("secp256k1");
    expect(key.display).toMatch(/^ckt1/);
    expect(key.genesis).toBe(network.genesis_hash);
    expect(await page(svc, "g2", "getKey")).toMatchObject({ status: "done", result: { key_id: (key as unknown as { key_id: string }).key_id } });
  });

  it("refuses frames, inactive documents and plain http sites", async () => {
    const { svc } = await ready();
    const msg = { kind: "page", reqId: "x", method: "getKey" };
    expect(await svc.handlePage(msg, pageSender(OFFICIAL, { frameId: 3 }))).toMatchObject({ code: "FORBIDDEN" });
    expect(await svc.handlePage(msg, pageSender(OFFICIAL, { documentLifecycle: "prerender" }))).toMatchObject({ code: "FORBIDDEN" });
    expect(await svc.handlePage(msg, pageSender("http://vote.example"))).toMatchObject({ code: "FORBIDDEN" });
    expect(await svc.handlePage(msg, pageSender(EXT))).toMatchObject({ code: "FORBIDDEN" });
    expect(await svc.handlePage({ ...msg, method: "signText" }, pageSender())).toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("refuses internal operations sent from a page, even with the extension's id", async () => {
    const { b, svc } = await ready();
    await page(svc, "s", "signBallots", await signRequest(svc));
    const id = await onlyPending(b);
    for (const op of [
      { op: "approve", id },
      { op: "unlock", password: PASSWORD },
      { op: "reset" },
      { op: "connectSite", origin: MIRROR },
      { op: "state" },
    ]) {
      const r = await svc.handleInternal({ kind: "internal", ...op }, pageSender());
      expect(r).toMatchObject({ ok: false, code: "FORBIDDEN" });
    }
    expect(b.results("s")).toHaveLength(0);
  });

  it("toolbar connect: injection always, connection only when the popup asked for it", async () => {
    const b = new FakeBrowser();
    const svc = service(b);
    await internal(svc, { op: "create", password: PASSWORD } as InternalRequest);
    // Granted from Chrome's own site-access menu: injected, not connected.
    await svc.onPermissionsAdded([`${MIRROR}/*`]);
    expect(b.registered.has(`${MIRROR}/*`)).toBe(true);
    expect(b.injected).toContain(`${MIRROR}/*`);
    expect((await state(svc)).sites).toEqual([]);
    // The popup announced the connect, then the permission arrived (the popup may be gone).
    await internal(svc, { op: "expectConnect", origin: MIRROR } as InternalRequest);
    await svc.onPermissionsAdded([`${MIRROR}/*`]);
    expect((await state(svc)).sites).toEqual([{ origin: MIRROR, official: false, connected: true }]);
    // Disconnecting from the popup drops the host permission and the injection.
    await internal(svc, { op: "disconnectSite", origin: MIRROR } as InternalRequest);
    expect(b.removedPermissions).toContain(`${MIRROR}/*`);
    expect(b.registered.has(`${MIRROR}/*`)).toBe(false);
    expect((await state(svc)).sites).toEqual([]);
  });

  it("revoked host access disconnects the site", async () => {
    const b = new FakeBrowser();
    const svc = service(b);
    await internal(svc, { op: "create", password: PASSWORD } as InternalRequest);
    await internal(svc, { op: "connectSite", origin: MIRROR } as InternalRequest);
    await svc.onPermissionsRemoved([`${MIRROR}/*`]);
    expect((await state(svc)).sites).toEqual([]);
    expect(await page(svc, "g", "getKey", undefined, MIRROR)).toEqual({ status: "done", result: null });
  });
});

describe("signing", () => {
  it("signs exactly the rebuilt texts after one confirmation", async () => {
    const { b, svc } = await ready();
    const req = await signRequest(svc, ["alice", "bob"]);
    expect(await page(svc, "s", "signBallots", req)).toEqual({ status: "pending" });
    const id = await onlyPending(b);
    const view = (await internal(svc, { op: "pending", id } as InternalRequest)) as { ok: true; value: PendingView };
    expect(view.value.sign?.ballots.map((x) => x.ownerAddress)).toEqual(req.bodies.map((x) => loadCore().address(network, x.owner_lock)));
    expect((await internal(svc, { op: "approve", id } as InternalRequest)).ok).toBe(true);
    const r = b.results("s")[0] as { ok: true; result: { signatures: string[] } };
    expect(r.ok).toBe(true);
    const key = loadCore().key((await page(svc, "k", "getKey") as { result: { descriptor: never } }).result.descriptor, network);
    r.result.signatures.forEach((sig, i) => {
      const text = loadCore().ballot(network, manifest, req.bodies[i]!).text;
      expect(loadCore().verifyKey(key.descriptor, text, sig).ok).toBe(true);
    });
    expect(await pendingIds(b)).toEqual([]);
    expect(b.windows.size).toBe(0);
  });

  it("refuses a second, different ballot on the same anchor (a silent CONFLICT)", async () => {
    const { b, svc } = await ready();
    const anchor = loadCore().ckbHashText("anchor-x");
    const first = await signRequest(svc, ["alice"], { anchor });
    await page(svc, "s1", "signBallots", first);
    await internal(svc, { op: "approve", id: await onlyPending(b) } as InternalRequest);
    const sameAgain = await page(svc, "s2", "signBallots", first);
    expect(sameAgain).toEqual({ status: "pending" });
    await internal(svc, { op: "reject", id: await onlyPending(b) } as InternalRequest);
    const conflict = await signRequest(svc, ["alice"], { anchor, action: "NO" });
    expect(await page(svc, "s3", "signBallots", conflict)).toMatchObject({ status: "error", code: "ANCHOR_REUSED" });
  });

  it("does not sign for a site that was disconnected after the request", async () => {
    const { b, svc } = await ready();
    await page(svc, "s", "signBallots", await signRequest(svc));
    const id = await onlyPending(b);
    await page(svc, "d", "disconnect");
    expect(b.results("s")).toEqual([expect.objectContaining({ ok: false, code: "NOT_CONNECTED" })]);
    expect(await internal(svc, { op: "approve", id } as InternalRequest)).toMatchObject({ ok: false, code: "EXPIRED" });
    expect(b.results("s").some((r) => r.kind === "result" && r.ok)).toBe(false);
  });

  it("does not sign after the key was reset", async () => {
    const { b, svc } = await ready();
    await page(svc, "s", "signBallots", await signRequest(svc));
    const id = await onlyPending(b);
    await internal(svc, { op: "reset" } as InternalRequest);
    await internal(svc, { op: "create", password: PASSWORD } as InternalRequest);
    expect(await internal(svc, { op: "approve", id } as InternalRequest)).toMatchObject({ ok: false });
    expect(b.results("s").some((r) => r.kind === "result" && r.ok)).toBe(false);
    // Reset disconnects every site: the page must connect again.
    expect(await page(svc, "g", "getKey")).toEqual({ status: "done", result: null });
  });

  it("asks to unlock again once the unlock deadline passed, even if no alarm fired", async () => {
    const { b, svc } = await ready();
    await page(svc, "s", "signBallots", await signRequest(svc));
    const id = await onlyPending(b);
    // The unlock deadline lapses while the request is still open; the alarm never ran
    // (e.g. the computer slept).
    const u = (await b.session.get<{ deadline: number }>("unlocked"))!;
    await b.session.set("unlocked", { ...u, deadline: b.clock - 1 });
    expect(await internal(svc, { op: "approve", id } as InternalRequest)).toMatchObject({ ok: false, code: "LOCKED" });
    expect(await b.session.get("unlocked")).toBeUndefined();
    await internal(svc, { op: "unlock", password: PASSWORD } as InternalRequest);
    expect((await internal(svc, { op: "approve", id } as InternalRequest)).ok).toBe(true);
    expect(b.results("s")[0]).toMatchObject({ ok: true });
  });

  it("page calls do not postpone the lock; the extension's own pages do", async () => {
    const { b, svc } = await ready();
    const deadline = (await b.session.get<{ deadline: number }>("unlocked"))!.deadline;
    b.clock += 60_000;
    await page(svc, "g", "getKey");
    expect((await b.session.get<{ deadline: number }>("unlocked"))!.deadline).toBe(deadline);
    await internal(svc, { op: "touch" } as InternalRequest);
    expect((await b.session.get<{ deadline: number }>("unlocked"))!.deadline).toBe(b.clock + IDLE_LOCK_MS);
    // Locked: the key is still readable (it is not secret), signing is not.
    await internal(svc, { op: "lock" } as InternalRequest);
    expect(await page(svc, "g2", "getKey")).toMatchObject({ status: "done", result: { descriptor: { kind: "secp256k1" } } });
  });

  it("expires requests after the confirmation timeout", async () => {
    const { b, svc } = await ready();
    await page(svc, "s", "signBallots", await signRequest(svc));
    const id = await onlyPending(b);
    b.clock += CONFIRM_TIMEOUT_MS + 1;
    expect(await internal(svc, { op: "approve", id } as InternalRequest)).toMatchObject({ ok: false, code: "EXPIRED" });
    expect(b.results("s")).toEqual([expect.objectContaining({ ok: false, code: "EXPIRED" })]);
  });

  it("does not sign when the requesting page is gone", async () => {
    const { b, svc } = await ready();
    await page(svc, "s", "signBallots", await signRequest(svc));
    const id = await onlyPending(b);
    b.liveDocuments.delete("doc-1");
    expect(await internal(svc, { op: "approve", id } as InternalRequest)).toMatchObject({ ok: false, code: "EXPIRED" });
    expect(await pendingIds(b)).toEqual([]);
    expect(await b.local.get("signed")).toBeUndefined();
  });

  it("delivers the result after the service worker was recycled", async () => {
    const { b, svc } = await ready();
    await page(svc, "s", "signBallots", await signRequest(svc));
    const id = await onlyPending(b);
    // A new worker instance over the same storage, as after Chrome stops an idle worker.
    const fresh = service(b);
    await fresh.start();
    expect((await internal(fresh, { op: "approve", id } as InternalRequest)).ok).toBe(true);
    expect(b.results("s")[0]).toMatchObject({ ok: true });
  });

  it("closing the confirmation window rejects the request", async () => {
    const { b, svc } = await ready();
    await page(svc, "s", "signBallots", await signRequest(svc));
    const id = await onlyPending(b);
    const windowId = (await b.session.get<{ windowId: number }>(`pending:${id}`))!.windowId;
    await svc.onWindowRemoved(windowId);
    expect(b.results("s")).toEqual([expect.objectContaining({ ok: false, code: "USER_REJECTED" })]);
  });

  it("requires a connected site and a key", async () => {
    const b = new FakeBrowser();
    const svc = service(b);
    expect(await page(svc, "s", "signBallots", { manifest, bodies: [] })).toMatchObject({ code: "NOT_CONNECTED" });
  });
});
