// Structured signing requests (docs/19 §4). The extension never signs page-supplied
// text: it rebuilds every ballot text with the protocol core and signs only that.

import type { Core } from "../../web/src/lib/core";
import type { Action, BallotBody, KeyInfo, Manifest, NetworkParams } from "../../web/src/lib/types";
import { SignerError } from "./protocol";

export const ADAPTER_CKB = "ckb-secp256k1-message-v1";
export const MAX_BALLOTS = 20;
/** carrier.rs: a manifest has its own witness (32 KiB); a ballot envelope is at most 8 KiB. */
export const MAX_MANIFEST_BYTES = 32 * 1024;
export const MAX_BODY_BYTES = 8 * 1024;
export const MAX_REQUEST_BYTES = MAX_MANIFEST_BYTES + MAX_BALLOTS * MAX_BODY_BYTES;

export interface CheckedBallot {
  body: BallotBody;
  text: string;
  summary: string;
  ballotId: string;
  ownerId: string;
  ownerAddress: string;
  /** Local history key: (poll, owner, anchor). */
  slot: string;
}

export interface CheckedRequest {
  pollId: string;
  shortId: string;
  title: string;
  action: Action;
  ballots: CheckedBallot[];
}

/** Ballot id this key already signed at `slot`, if any. */
export type SignedLookup = (slot: string) => string | undefined;

/**
 * The tally ranks all of an owner's delegate ballots in a poll together, by (grant
 * anchor, ballot anchor), so the authorization is deliberately not part of the key.
 */
export function anchorSlot(pollId: string, ownerId: string, anchor: string): string {
  return `${pollId}:${ownerId}:${anchor}`;
}

const utf8 = new TextEncoder();

export function jsonBytes(v: unknown): number {
  return utf8.encode(JSON.stringify(v) ?? "").length;
}

function invalid(message: string): never {
  throw new SignerError("INVALID_REQUEST", message);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Check a `signBallots` request against the built-in network and the extension's key.
 * Throws SignerError; returns the rebuilt ballots on success.
 */
export function checkSignRequest(core: Core, network: NetworkParams, key: KeyInfo, params: unknown, signed: SignedLookup): CheckedRequest {
  // Sizes first, before anything is parsed by the core.
  if (jsonBytes(params) > MAX_REQUEST_BYTES) invalid(`the request exceeds ${MAX_REQUEST_BYTES} bytes`);
  if (!isPlainObject(params)) invalid("the request must be an object {manifest, bodies}");
  const extra = Object.keys(params).filter((k) => k !== "manifest" && k !== "bodies");
  if (extra.length > 0) invalid(`unexpected request fields: ${extra.join(", ")}`);
  const manifest = params.manifest;
  const bodies = params.bodies;
  if (!isPlainObject(manifest)) invalid("manifest must be an object");
  if (!Array.isArray(bodies) || bodies.length === 0) invalid("bodies must be a non-empty array");
  if (bodies.length > MAX_BALLOTS) invalid(`at most ${MAX_BALLOTS} ballots per request`);
  if (jsonBytes(manifest) > MAX_MANIFEST_BYTES) invalid(`the manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
  for (const b of bodies) {
    if (!isPlainObject(b)) invalid("every ballot body must be an object");
    if (jsonBytes(b) > MAX_BODY_BYTES) invalid(`a ballot body exceeds ${MAX_BODY_BYTES} bytes`);
  }

  // 1. Network: only the built-in one, never a page-supplied network.
  if (manifest.network_genesis_hash !== network.genesis_hash) throw new SignerError("WRONG_NETWORK", "the proposal belongs to another network");
  for (const b of bodies as Record<string, unknown>[]) {
    if (b.network_genesis_hash !== network.genesis_hash) throw new SignerError("WRONG_NETWORK", "a ballot belongs to another network");
  }

  // 2 and 5. Rebuild every text with the core: it parses the manifest, checks that each
  // ballot's poll_id is this manifest's hash and that rules and genesis match.
  const m = manifest as unknown as Manifest;
  const rebuilt = (bodies as unknown as BallotBody[]).map((b) => {
    try {
      return core.ballot(network, m, b);
    } catch (e) {
      return invalid(e instanceof Error ? e.message : String(e));
    }
  });
  const info = core.manifestInfo(m, network);

  // 3. Fields: delegate ballots of this key under the CKB message adapter only.
  for (const r of rebuilt) {
    const b = r.body;
    if (!["YES", "NO", "CANCEL"].includes(b.action)) invalid(`unknown action ${b.action}`);
    if (b.authority !== "delegate") invalid("only delegate ballots can be signed here");
    if (!b.authorization_id) invalid("a delegate ballot needs an authorization_id");
    if (b.signer_key_id !== key.key_id) invalid("a ballot names another signer key");
    if (b.auth_adapter !== ADAPTER_CKB) invalid(`a ballot uses adapter ${b.auth_adapter}`);
  }
  if (!m.auth_registry.key_adapters.includes(ADAPTER_CKB)) invalid("this proposal does not accept CKB voting keys");

  // 4. One request: one proposal, one choice, distinct owners.
  const first = rebuilt[0]!.body;
  const owners = new Set<string>();
  for (const r of rebuilt) {
    if (r.body.poll_id !== first.poll_id) invalid("all ballots must belong to one proposal");
    if (r.body.action !== first.action) invalid("all ballots must carry the same choice");
    if (owners.has(r.owner_id)) invalid("an owner appears twice");
    owners.add(r.owner_id);
  }

  // 6. A second, different ballot on an anchor this key already used for the same
  // owner is a CONFLICT at tally time (docs/03 §6).
  const ballots = rebuilt.map((r) => {
    const slot = anchorSlot(r.body.poll_id, r.owner_id, r.body.anchor_block_hash);
    const prior = signed(slot);
    if (prior !== undefined && prior !== r.ballot_id) {
      throw new SignerError("ANCHOR_REUSED", "this key already signed a different ballot for this owner on the same anchor block");
    }
    return {
      body: r.body,
      text: r.text,
      summary: r.summary,
      ballotId: r.ballot_id,
      ownerId: r.owner_id,
      ownerAddress: core.address(network, r.body.owner_lock),
      slot,
    };
  });
  return { pollId: first.poll_id, shortId: info.short_id, title: m.signing_title, action: first.action, ballots };
}
