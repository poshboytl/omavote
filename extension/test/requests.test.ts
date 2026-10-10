import { beforeAll, describe, expect, it } from "vitest";
import type { KeyInfo, Manifest, NetworkParams } from "../../web/src/lib/types";
import { SignerError } from "../src/protocol";
import { anchorSlot, checkSignRequest, MAX_BALLOTS, MAX_REQUEST_BYTES } from "../src/requests";
import { buildManifest, delegateBody, keyOf, loadCore, ownerLock, secretFor } from "./helpers";

let network: NetworkParams;
let manifest: Manifest;
let key: KeyInfo;
const none = () => undefined;

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return "ok";
  } catch (e) {
    return e instanceof SignerError ? e.code : `other: ${String(e)}`;
  }
}

beforeAll(() => {
  network = loadCore().knownNetwork("testnet");
  manifest = buildManifest(network);
  key = keyOf(secretFor("voting key"), network);
});

describe("checkSignRequest", () => {
  it("rebuilds the texts with the core and keeps the scope", () => {
    const owners = ["alice", "bob"].map((n) => ownerLock(n, network));
    const bodies = owners.map((o) => delegateBody(manifest, key, o));
    const r = checkSignRequest(loadCore(), network, key, { manifest, bodies }, none);
    expect(r.action).toBe("YES");
    expect(r.title).toBe(manifest.signing_title);
    expect(r.ballots).toHaveLength(2);
    for (const [i, b] of r.ballots.entries()) {
      expect(b.text).toBe(loadCore().ballot(network, manifest, bodies[i]!).text);
      expect(b.text).toContain(`Owner: ${b.ownerAddress}`);
      expect(b.summary).toMatch(/^OMAVOTE VOTE YES #/);
    }
  });

  it("only accepts the built-in network", () => {
    const mainnet = loadCore().knownNetwork("mainnet");
    const body = delegateBody(manifest, key, ownerLock("alice", network));
    expect(codeOf(() => checkSignRequest(loadCore(), mainnet, key, { manifest, bodies: [body] }, none))).toBe("WRONG_NETWORK");
  });

  it("refuses owner ballots, other keys, other adapters and empty authorizations", () => {
    const owner = ownerLock("alice", network);
    const ok = delegateBody(manifest, key, owner);
    const direct = { ...ok, authority: "owner" as const, authorization_id: null, signer_key_id: null };
    const other = delegateBody(manifest, keyOf(secretFor("another key"), network), owner);
    const evm = { ...ok, auth_adapter: "evm-personal-message-v1" };
    const noGrant = { ...ok, authorization_id: null };
    for (const b of [direct, other, evm, noGrant]) {
      expect(codeOf(() => checkSignRequest(loadCore(), network, key, { manifest, bodies: [b] }, none))).toBe("INVALID_REQUEST");
    }
  });

  it("refuses unknown actions and a manifest that does not match the poll", () => {
    const owner = ownerLock("alice", network);
    const bad = { ...delegateBody(manifest, key, owner), action: "MAYBE" };
    expect(codeOf(() => checkSignRequest(loadCore(), network, key, { manifest, bodies: [bad] }, none))).toBe("INVALID_REQUEST");
    // A real poll id with a made-up title: the core sees that the hash differs.
    const fake = { ...manifest, signing_title: "Something else entirely" };
    const body = delegateBody(manifest, key, owner);
    expect(codeOf(() => checkSignRequest(loadCore(), network, key, { manifest: fake, bodies: [body] }, none))).toBe("INVALID_REQUEST");
  });

  it("requires one proposal, one choice and distinct owners", () => {
    const [a, b] = [ownerLock("alice", network), ownerLock("bob", network)];
    const other = buildManifest(network, { title: "Another proposal" });
    const mixedPoll = [delegateBody(manifest, key, a), delegateBody(other, key, b)];
    const mixedChoice = [delegateBody(manifest, key, a), delegateBody(manifest, key, b, { action: "NO" })];
    const twice = [delegateBody(manifest, key, a), delegateBody(manifest, key, a)];
    for (const bodies of [mixedPoll, mixedChoice, twice]) {
      expect(codeOf(() => checkSignRequest(loadCore(), network, key, { manifest, bodies }, none))).toBe("INVALID_REQUEST");
    }
  });

  it("caps the number of ballots and the request size before parsing", () => {
    const many = Array.from({ length: MAX_BALLOTS + 1 }, (_, i) => delegateBody(manifest, key, ownerLock(`owner ${i}`, network)));
    expect(codeOf(() => checkSignRequest(loadCore(), network, key, { manifest, bodies: many }, none))).toBe("INVALID_REQUEST");
    const huge = { manifest, bodies: [delegateBody(manifest, key, ownerLock("alice", network))], pad: "x".repeat(MAX_REQUEST_BYTES) };
    expect(() => checkSignRequest(loadCore(), network, key, huge, none)).toThrow(/exceeds/);
    const fatBody = { ...delegateBody(manifest, key, ownerLock("alice", network)), owner_lock: { code_hash: "0x", hash_type: "type", args: `0x${"00".repeat(5000)}` } };
    expect(() => checkSignRequest(loadCore(), network, key, { manifest, bodies: [fatBody] }, none)).toThrow(/ballot body exceeds/);
  });

  it("refuses extra fields and non-objects", () => {
    const body = delegateBody(manifest, key, ownerLock("alice", network));
    for (const req of [null, "text", [manifest], { manifest, bodies: [body], text: "sign me" }, { manifest, bodies: [] }]) {
      expect(codeOf(() => checkSignRequest(loadCore(), network, key, req, none))).toBe("INVALID_REQUEST");
    }
  });

  it("refuses proposals that do not accept CKB voting keys", () => {
    const evmOnly = buildManifest(network, { keyAdapters: ["evm-personal-message-v1"] });
    const body = delegateBody(evmOnly, key, ownerLock("alice", network));
    expect(() => checkSignRequest(loadCore(), network, key, { manifest: evmOnly, bodies: [body] }, none)).toThrow(/does not accept/);
  });

  it("refuses a different ballot on an anchor already signed, but not the same ballot", () => {
    const owner = ownerLock("alice", network);
    const first = delegateBody(manifest, key, owner);
    const checked = checkSignRequest(loadCore(), network, key, { manifest, bodies: [first] }, none).ballots[0]!;
    const history = new Map([[checked.slot, checked.ballotId]]);
    const lookup = (s: string) => history.get(s);
    // Same choice, new nonce, same anchor: a CONFLICT at tally time.
    const again = delegateBody(manifest, key, owner, { anchor: first.anchor_block_hash, authorizationId: first.authorization_id! });
    expect(codeOf(() => checkSignRequest(loadCore(), network, key, { manifest, bodies: [again] }, lookup))).toBe("ANCHOR_REUSED");
    expect(codeOf(() => checkSignRequest(loadCore(), network, key, { manifest, bodies: [first] }, lookup))).toBe("ok");
    // A renewed grant does not make the same anchor safe: the tally ranks all of an
    // owner's delegate ballots together, by (grant anchor, ballot anchor).
    const regranted = delegateBody(manifest, key, owner, { anchor: first.anchor_block_hash, authorizationId: loadCore().ckbHashText("renewed grant") });
    expect(codeOf(() => checkSignRequest(loadCore(), network, key, { manifest, bodies: [regranted] }, lookup))).toBe("ANCHOR_REUSED");
    const newer = delegateBody(manifest, key, owner, { anchor: loadCore().ckbHashText("anchor-2"), authorizationId: first.authorization_id! });
    expect(codeOf(() => checkSignRequest(loadCore(), network, key, { manifest, bodies: [newer] }, lookup))).toBe("ok");
    expect(checked.slot).toBe(anchorSlot(checked.body.poll_id, checked.ownerId, first.anchor_block_hash));
  });
});
