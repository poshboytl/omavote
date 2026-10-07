import { describe, expect, it } from "vitest";
import { requestAccounts } from "../src/lib/eip1193";
import {
  ADAPTER_CKB,
  ADAPTER_EVM,
  anchorAbove,
  assessSync,
  ballotAnchorFloor,
  ballotCounts,
  ballotEnvelope,
  bestCandidate,
  checkReceipt,
  delegateBlocked,
  delegateOptions,
  evmOwnerCandidates,
  fetchControlFloor,
  lockLabel,
  newBallot,
  ownerFromAddress,
  signVerifySubmit,
  submitEnvelope,
  verifyKeySig,
  verifyOwnerSig,
  waitForBallot,
  waitForRelay,
  walletSigner,
} from "../src/lib/flow";
import { parseSignature, utf8ToHex } from "../src/lib/hex";
import { MockEip1193, neuronSign, testSecret } from "./helpers/keys";
import { BALLOT_FIELDS, sortedKeys } from "./helpers/mock-server";
import { makeFixture, noSleep, secpLock } from "./helpers/fixture";

const fast = { intervalMs: 0, sleep: noSleep, timeoutMs: 5_000 };

describe("vote with MetaMask as owner (EIP-1193, Omnilock EVM owner)", () => {
  it("builds the body, signs the exact text, verifies, submits and confirms SELECTED", async () => {
    const f = makeFixture();
    const wallet = new MockEip1193(testSecret("carol-evm"));
    const [account] = await requestAccounts(wallet);
    expect(account).toBe(wallet.address);

    // Owner locks controlled by the address; the one with deposits is chosen.
    const omni = f.core.evmOwnerLocks(f.network, wallet.address).find((l) => l.script.args === `0x01${wallet.address.slice(2)}00`);
    expect(omni).toBeDefined();
    f.server.setPower(omni!.script, "8000000000000");
    const cands = await evmOwnerCandidates(f.core, f.api, f.network, account!);
    expect(cands.length).toBeGreaterThanOrEqual(2);
    const best = bestCandidate(cands);
    expect(best?.lock.owner_id).toBe(omni!.owner_id);
    expect(lockLabel(f.network, best!.lock.script)).toBe("Omnilock (EVM 0x01)");

    // Before signing: server in sync.
    expect(assessSync(await f.api.status(), Date.now()).ok).toBe(true);

    // Anchor: newest block, strictly above earlier ballots of this owner (none yet) and the registration.
    const floor = await ballotAnchorFloor(f.api, f.pollId, omni!.owner_id, String(f.server.polls.get(f.pollId)!.registeredHeight), null);
    const anchor = await anchorAbove(f.api, floor, fast);
    expect(anchor.hash).toBe(f.server.tip().hash);

    const prepared = newBallot(f.core, f.network, f.manifest, { authority: "owner", ownerLock: omni!.script, adapter: ADAPTER_EVM }, "YES", anchor);
    // Body has exactly the BallotDraft::build fields.
    expect(sortedKeys(prepared.body)).toEqual(BALLOT_FIELDS);
    expect(prepared.body).toMatchObject({
      message_kind: "ballot",
      protocol_version: "2",
      action: "YES",
      authority: "owner",
      authorization_id: null,
      signer_key_id: null,
      anchor_block_hash: anchor.hash,
      auth_adapter: ADAPTER_EVM,
      dao_namespace: "ckb-community-fund-dao",
      network_genesis_hash: f.network.genesis_hash,
      poll_id: f.pollId,
      signature_format: "omavote-readable-v2",
    });
    expect(prepared.body.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    // The text: summary first, fixed header, all lines.
    const lines = prepared.text.split("\n");
    expect(lines[0]).toBe(prepared.summary);
    expect(prepared.summary).toMatch(/^OMAVOTE VOTE YES #[0-9a-f]{16} 1000000CKB$/);
    expect(prepared.summary).toBe(`OMAVOTE VOTE YES #${f.pollId.slice(2, 18)} 1000000CKB`);
    expect(lines[1]).toBe("OMAVOTE V2 - VOTE ONLY, NO ASSET TRANSFER");
    expect(lines[2]).toBe("");
    expect(prepared.text).toContain(`Owner: ${omni!.address}`);
    expect(prepared.text).toContain(`Ballot-Hash: ${prepared.ballotId}`);
    expect(prepared.text.endsWith("\n")).toBe(false);
    expect(prepared.textHex).toBe(utf8ToHex(prepared.text));

    const res = await signVerifySubmit({
      core: f.core,
      api: f.api,
      request: prepared,
      sign: walletSigner(wallet, account!),
      verify: (text, sig) => verifyOwnerSig(f.core, f.network, ADAPTER_EVM, omni!.script, text, sig),
      envelope: (sig) => ballotEnvelope(prepared.body, sig),
      objectId: prepared.ballotId,
      itemKind: "ballot",
      receiptKey: f.server.receiptKey,
      genesis: f.network.genesis_hash,
    });

    // personal_sign got ["0x" + hex(utf8(text)), address].
    const sign = wallet.calls.find((c) => c.method === "personal_sign");
    expect(sign?.params).toEqual([utf8ToHex(prepared.text), account]);
    expect(res.verify).toEqual({ ok: true, error: null });
    // Envelope JSON shape.
    expect(sortedKeys(res.envelope)).toEqual(["body", "proof"]);
    expect(sortedKeys(res.envelope!.proof)).toEqual(["signature"]);
    expect(res.envelope!.proof.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(res.envelope!.body).toEqual(prepared.body);
    // Submitted once, in JCS form.
    expect(f.server.posts).toHaveLength(1);
    expect(f.server.posts[0]!.text).toBe(f.core.jcs(res.envelope));
    // Receipt: signer, object and envelope bytes check out.
    expect(res.submit?.ok).toBe(true);
    expect(res.receipt).toMatchObject({ present: true, signerMatches: true, objectMatches: true, kindMatches: true, envelopeHashMatches: true, genesisMatches: true });

    // Relay inclusion, then the indexer shows the ballot SELECTED.
    const updates: string[] = [];
    const item = await waitForRelay(f.api, prepared.ballotId, { ...fast, onUpdate: (i) => updates.push(i.status) });
    expect(item.status).toBe("INCLUDED");
    expect(updates).toEqual(["RECEIVED", "BROADCAST", "INCLUDED"]);
    const lookup = await waitForBallot(f.api, f.pollId, omni!.owner_id, prepared.ballotId, fast);
    expect(lookup.ballot?.status).toBe("SELECTED");
    expect(ballotCounts(item.status, lookup)).toBe(true);
    expect(ballotCounts("RECEIVED", lookup)).toBe(false);
  });

  it("does not submit when the signature does not verify (other account or edited text)", async () => {
    const f = makeFixture();
    const owner = new MockEip1193(testSecret("owner"));
    const other = new MockEip1193(testSecret("intruder"));
    const omni = f.core.evmOwnerLocks(f.network, owner.address)[0]!;
    const anchor = await anchorAbove(f.api, null, fast);
    const prepared = newBallot(f.core, f.network, f.manifest, { authority: "owner", ownerLock: omni.script, adapter: ADAPTER_EVM }, "NO", anchor);
    const res = await signVerifySubmit({
      core: f.core,
      api: f.api,
      request: prepared,
      sign: walletSigner(other, other.address),
      verify: (text, sig) => verifyOwnerSig(f.core, f.network, ADAPTER_EVM, omni.script, text, sig),
      envelope: (sig) => ballotEnvelope(prepared.body, sig),
      objectId: prepared.ballotId,
      itemKind: "ballot",
      receiptKey: f.server.receiptKey,
    });
    expect(res.verify.ok).toBe(false);
    expect(res.submit).toBeNull();
    expect(f.server.posts).toHaveLength(0);

    const sig = await walletSigner(owner, owner.address)(prepared);
    expect(verifyOwnerSig(f.core, f.network, ADAPTER_EVM, omni.script, prepared.text, sig).ok).toBe(true);
    expect(verifyOwnerSig(f.core, f.network, ADAPTER_EVM, omni.script, prepared.text.replace("NO (Reject)", "YES (Approve)"), sig).ok).toBe(false);
    expect(verifyOwnerSig(f.core, f.network, ADAPTER_EVM, omni.script, prepared.text + "\n", sig).ok).toBe(false);
  });

  it("surfaces relay rejections with their code and keeps the envelope for a retry", async () => {
    const f = makeFixture();
    const wallet = new MockEip1193(testSecret("dave"));
    const omni = f.core.evmOwnerLocks(f.network, wallet.address)[0]!;
    const anchor = await anchorAbove(f.api, null, fast);
    const prepared = newBallot(f.core, f.network, f.manifest, { authority: "owner", ownerLock: omni.script, adapter: ADAPTER_EVM }, "YES", anchor);
    const sig = await walletSigner(wallet, wallet.address)(prepared);
    // Tamper with the proof: the relay rejects with INVALID_SIGNATURE.
    const bad = ballotEnvelope(prepared.body, sig.slice(0, -4) + (sig.endsWith("1b") ? "001c" : "001b"));
    const out = await submitEnvelope(f.core, f.api, bad);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(422);
      expect(out.code).toBe("INVALID_SIGNATURE");
    }
    // The same valid envelope submitted twice is idempotent.
    const env = ballotEnvelope(prepared.body, sig);
    const first = await submitEnvelope(f.core, f.api, env);
    const second = await submitEnvelope(f.core, f.api, env);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.duplicate).toBe(true);
      expect(second.item.object_id).toBe(first.item.object_id);
    }
  });

  it("detects a receipt that was not signed by the server's receipt key", async () => {
    const f = makeFixture();
    const wallet = new MockEip1193(testSecret("erin"));
    const omni = f.core.evmOwnerLocks(f.network, wallet.address)[0]!;
    const anchor = await anchorAbove(f.api, null, fast);
    const prepared = newBallot(f.core, f.network, f.manifest, { authority: "owner", ownerLock: omni.script, adapter: ADAPTER_EVM }, "CANCEL", anchor);
    expect(prepared.summary).toMatch(/^OMAVOTE VOTE CANCEL #/);
    const env = ballotEnvelope(prepared.body, await walletSigner(wallet, wallet.address)(prepared));
    const out = await submitEnvelope(f.core, f.api, env);
    if (!out.ok) throw new Error("submit failed");
    const otherKey = "0x02" + "11".repeat(32);
    const check = checkReceipt(f.core, out.item, { receiptKey: otherKey, objectId: prepared.ballotId, itemKind: "ballot", envelopeJcs: out.envelopeJcs });
    expect(check.signerMatches).toBe(false);
    const wrongEnvelope = checkReceipt(f.core, out.item, { receiptKey: f.server.receiptKey, objectId: prepared.ballotId, itemKind: "ballot", envelopeJcs: out.envelopeJcs + " " });
    expect(wrongEnvelope.signerMatches).toBe(true);
    expect(wrongEnvelope.envelopeHashMatches).toBe(false);
  });
});

describe("anchor rules (docs/03 §6, docs/11 §2, §6)", () => {
  it("waits for a block strictly above the owner's previous ballot instead of failing", async () => {
    const f = makeFixture();
    const wallet = new MockEip1193(testSecret("revoter"));
    const omni = f.core.evmOwnerLocks(f.network, wallet.address)[0]!;
    const run = async (action: "YES" | "NO") => {
      const floor = await ballotAnchorFloor(f.api, f.pollId, omni.owner_id, String(f.server.polls.get(f.pollId)!.registeredHeight), null);
      const waits: string[] = [];
      const anchor = await anchorAbove(f.api, floor, { ...fast, onWait: (cur) => waits.push(cur.number) });
      const p = newBallot(f.core, f.network, f.manifest, { authority: "owner", ownerLock: omni.script, adapter: ADAPTER_EVM }, action, anchor);
      const env = ballotEnvelope(p.body, await walletSigner(wallet, wallet.address)(p));
      expect((await submitEnvelope(f.core, f.api, env)).ok).toBe(true);
      await waitForRelay(f.api, p.ballotId, fast);
      return { anchor, waits, p };
    };
    const first = await run("YES");
    // The first ballot is indexed with anchor_height = first.anchor.number. Make the tip equal to it
    // again: a revision must wait for a newer block.
    while (f.server.chain.length - 1 > Number(first.anchor.number)) f.server.chain.pop();
    f.server.mineOnAnchorEvery = 3;
    const second = await run("NO");
    expect(second.waits.length).toBeGreaterThan(0);
    expect(BigInt(second.anchor.number)).toBeGreaterThan(BigInt(first.anchor.number));
    // The local floor alone (this browser's last signature) also forces a newer block.
    const floorLocal = await ballotAnchorFloor(f.api, f.pollId, omni.owner_id, "0", { number: second.anchor.number });
    expect(floorLocal).toBe(BigInt(second.anchor.number));
  });

  it("anchors above ballots and controls of the owner queued at the relay (signed on another device)", async () => {
    const f = makeFixture();
    const wallet = new MockEip1193(testSecret("two-devices"));
    const omni = f.core.evmOwnerLocks(f.network, wallet.address)[0]!;
    // Device A signs and submits on the newest block; the relay holds it (not indexed yet).
    const a1 = await anchorAbove(f.api, null, fast);
    const p1 = newBallot(f.core, f.network, f.manifest, { authority: "owner", ownerLock: omni.script, adapter: ADAPTER_EVM }, "YES", a1);
    const out = await submitEnvelope(f.core, f.api, ballotEnvelope(p1.body, await walletSigner(wallet, wallet.address)(p1)));
    expect(out.ok && out.item.scope_id).toBe(f.pollId);
    expect(out.ok && out.item.owner_id).toBe(omni.owner_id);
    const queued = await f.api.ownerQueued(omni.owner_id);
    expect(queued.queued.map((q) => q.object_id)).toEqual([p1.ballotId]);
    // Device B knows nothing locally and the index has no ballot yet, but the floor
    // still includes the queued anchor, so B waits for the next block.
    const floor = await ballotAnchorFloor(f.api, f.pollId, omni.owner_id, "0", null);
    expect(floor).toBe(BigInt(a1.number));
    const fl = await fetchControlFloor(f.api, omni.owner_id, f.server.policy.hash, null);
    expect(fl.floor).toBe(BigInt(a1.number));
    // Without a new block the client keeps waiting (here it times out) instead of reusing a1.
    let t = 0;
    const waits: string[] = [];
    await expect(
      anchorAbove(f.api, floor, { intervalMs: 1, timeoutMs: 10, sleep: async () => void (t += 5), now: () => t, onWait: (c) => waits.push(c.number) }),
    ).rejects.toThrow(/newer anchor/);
    expect(waits.length).toBeGreaterThan(0);
    expect(waits.every((n) => n === a1.number)).toBe(true);
    f.server.mineOnAnchorEvery = 1;
    const a2 = await anchorAbove(f.api, floor, fast);
    expect(BigInt(a2.number)).toBeGreaterThan(BigInt(a1.number));
  });

  it("times out (instead of signing on an old block) when no new block arrives", async () => {
    const f = makeFixture();
    let t = 0;
    await expect(anchorAbove(f.api, f.server.tip().number, { intervalMs: 1, timeoutMs: 10, sleep: async () => void (t += 5), now: () => t })).rejects.toThrow(/newer anchor/);
  });
});

describe("delegate vote with a MetaMask voting key", () => {
  it("finds CURRENT grants for the key and signs a delegate ballot per owner", async () => {
    const f = makeFixture();
    const keyWallet = new MockEip1193(testSecret("voting-key"));
    const key = f.core.evmKey(keyWallet.address, f.network);
    // Two owners (Neuron addresses) granted this key; one has no deposit.
    const a = secpLock(f.core, f.network, testSecret("owner-a"));
    const b = secpLock(f.core, f.network, testSecret("owner-b"));
    f.server.setPower(a.script, "30000000000000");
    const expires = (f.server.tip().clock + 30n * 86_400_000n).toString();
    const ga = f.server.addGrant(a.script, key.descriptor, expires);
    f.server.addGrant(b.script, key.descriptor, expires);

    const opts = await delegateOptions(f.core, f.api, f.network, f.manifest, key.key_id, f.server.tip().clock.toString());
    expect(opts).toHaveLength(2);
    const oa = opts.find((o) => o.grant.owner_id === a.owner_id)!;
    const ob = opts.find((o) => o.grant.owner_id === b.owner_id)!;
    expect(oa.problems).toEqual([]);
    expect(oa.ownerAddress).toBe(a.address);
    expect(ob.problems).toEqual(["no_deposit"]);
    expect(delegateBlocked(ob, "YES")).toBe(true);
    expect(delegateBlocked(ob, "CANCEL")).toBe(false);

    const anchor = await anchorAbove(f.api, null, fast);
    const p = newBallot(
      f.core,
      f.network,
      f.manifest,
      { authority: "delegate", ownerLock: oa.ownerLock!, authorizationId: ga.authorization_id, signerKeyId: key.key_id, adapter: key.adapter },
      "NO",
      anchor,
    );
    expect(p.body).toMatchObject({ authority: "delegate", authorization_id: ga.authorization_id, signer_key_id: key.key_id, auth_adapter: ADAPTER_EVM, owner_lock: a.script });
    expect(p.text).toContain("Authority: DELEGATE (Voting key)");
    expect(p.text).toContain(`Authorization: ${ga.authorization_id}`);
    expect(p.text).toContain(`Signer-Key: ${key.key_id}`);
    const res = await signVerifySubmit({
      core: f.core,
      api: f.api,
      request: p,
      sign: walletSigner(keyWallet, keyWallet.address),
      verify: (text, sig) => verifyKeySig(f.core, key.descriptor, text, sig),
      envelope: (sig) => ballotEnvelope(p.body, sig),
      objectId: p.ballotId,
      itemKind: "ballot",
      receiptKey: f.server.receiptKey,
    });
    expect(res.verify.ok).toBe(true);
    expect(res.receipt?.signerMatches).toBe(true);
    // An expired or foreign-policy grant is reported, not used.
    const later = await delegateOptions(f.core, f.api, f.network, f.manifest, key.key_id, (BigInt(expires) + 1n).toString());
    expect(later.every((o) => o.problems.includes("expired"))).toBe(true);
  });
});

describe("vote with Neuron (copy-paste)", () => {
  it("parses the address, verifies a pasted 65-byte signature (v = 00/01) and submits", async () => {
    const f = makeFixture();
    const secret = testSecret("neuron-user");
    const lock = secpLock(f.core, f.network, secret);
    f.server.setPower(lock.script, "6000000000000");
    const owner = ownerFromAddress(f.core, f.network, `  ${lock.address}  `);
    expect(owner.adapter).toBe(ADAPTER_CKB);
    expect(owner.kind).toBe("secp256k1");
    expect(owner.lock.owner_id).toBe(lock.owner_id);
    expect(() => ownerFromAddress(f.core, f.network, lock.address.replace(/^ckt/, "ckb"))).toThrow();

    const anchor = await anchorAbove(f.api, null, fast);
    const p = newBallot(f.core, f.network, f.manifest, { authority: "owner", ownerLock: owner.lock.script, adapter: ADAPTER_CKB }, "YES", anchor);
    const sig = neuronSign(p.text, secret);
    expect(sig.slice(-2)).toMatch(/^0[01]$/);
    // A pasted signature with spaces, upper case and no 0x is normalised.
    const pasted = `  ${sig.slice(2).toUpperCase().replace(/(.{20})/g, "$1 ")} `;
    const parsed = parseSignature(pasted, "ckb");
    expect(parsed.ok && parsed.signature).toBe(sig);
    expect(verifyOwnerSig(f.core, f.network, ADAPTER_CKB, owner.lock.script, p.text, sig).ok).toBe(true);
    // v = 27/28 is not a Neuron signature.
    expect(parseSignature(sig.slice(0, -2) + "1b", "ckb")).toMatchObject({ ok: false, error: "recovery" });
    // A signature over the text without the Nervos prefix (e.g. a different wallet scheme) fails.
    expect(verifyOwnerSig(f.core, f.network, ADAPTER_CKB, owner.lock.script, p.text.replace("YES (Approve)", "NO (Reject)"), sig).ok).toBe(false);

    const out = await submitEnvelope(f.core, f.api, ballotEnvelope(p.body, sig));
    expect(out.ok).toBe(true);
    await waitForRelay(f.api, p.ballotId, fast);
    expect((await waitForBallot(f.api, f.pollId, owner.lock.owner_id, p.ballotId, fast)).ballot?.status).toBe("SELECTED");
  });
});

describe("sync check before signing", () => {
  it("flags an unsynced or lagging server", async () => {
    const f = makeFixture();
    expect(assessSync(f.server.status(), Date.now()).ok).toBe(true);
    f.server.synced = false;
    f.server.lagBlocks = "7";
    const a = assessSync(f.server.status(), Date.now());
    expect(a.ok).toBe(false);
    expect(a.lagBlocks).toBe(7);
    expect(a.issues.map((i) => i.key)).toEqual(["sync.notSynced", "sync.lag"]);
    const stale = assessSync({ ...f.server.status(), synced: true, lag_blocks: "0", last_sync_ms: String(Date.now() - 600_000) }, Date.now());
    expect(stale.issues.map((i) => i.key)).toEqual(["sync.stale"]);
    const noIntake = assessSync({ ...f.server.status(), synced: true, lag_blocks: "0", relay: { intake: false, receipt_key: null, queue: {} } }, Date.now(), { needIntake: true });
    expect(noIntake.issues.map((i) => i.key)).toEqual(["sync.noIntake"]);
  });
});
