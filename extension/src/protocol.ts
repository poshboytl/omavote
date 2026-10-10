// Messages between the page (window.omavote), the content script, the service worker
// and the extension's own pages (docs/19 §5). Everything that arrives from a page is
// untrusted input; the service worker re-checks every field.

import type { BallotBody, KeyDescriptor, Manifest } from "../../web/src/lib/types";

export type ErrorCode =
  | "USER_REJECTED"
  | "NOT_CONNECTED"
  | "WRONG_NETWORK"
  | "INVALID_REQUEST"
  | "ANCHOR_REUSED"
  | "BUSY"
  | "EXPIRED"
  | "NO_KEY"
  | "LOCKED"
  | "WRONG_PASSWORD"
  | "FORBIDDEN";

export class SignerError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string = code) {
    super(message);
    this.name = "SignerError";
    this.code = code;
  }
}

/** The four methods a page may call (docs/19 §5.2). */
export type PageMethod = "getKey" | "connect" | "signBallots" | "disconnect";
export const PAGE_METHODS: readonly PageMethod[] = ["getKey", "connect", "signBallots", "disconnect"];

export interface PageKey {
  descriptor: KeyDescriptor;
  key_id: string;
  display: string;
  genesis: string;
}

export interface SignBallotsParams {
  manifest: Manifest;
  bodies: BallotBody[];
}

/** Content script -> service worker. `reqId` is chosen by the content script. */
export interface PageRequest {
  kind: "page";
  reqId: string;
  method: PageMethod;
  params?: unknown;
}

/** Service worker's immediate answer to a PageRequest. */
export type PageReply =
  | { status: "done"; result: unknown }
  | { status: "error"; code: ErrorCode; message: string }
  | { status: "pending" };

/** Service worker -> content script (chrome.tabs.sendMessage with the request's documentId). */
export type ToContent =
  | { kind: "result"; reqId: string; ok: true; result: unknown }
  | { kind: "result"; reqId: string; ok: false; code: ErrorCode; message: string }
  | { kind: "ping" }
  | { kind: "changed" };

/** Page <-> content script over window.postMessage. */
export const TO_CONTENT = "omavote-signer:to-content";
export const TO_PAGE = "omavote-signer:to-page";

export interface SiteView {
  origin: string;
  official: boolean;
  connected: boolean;
}

/** What the extension's own pages see (popup, confirm window). */
export interface StateView {
  flavor: "release" | "devnet";
  network: string;
  hasKey: boolean;
  locked: boolean;
  key: { address: string; short: string; key_id: string } | null;
  sites: SiteView[];
  officialPatterns: string[];
}

export interface BallotView {
  ownerAddress: string;
  ownerId: string;
  ballotId: string;
  summary: string;
  text: string;
}

export interface PendingView {
  id: string;
  kind: "connect" | "sign";
  origin: string;
  official: boolean;
  deadline: number;
  keyAddress: string | null;
  sign?: {
    pollId: string;
    shortId: string;
    title: string;
    action: "YES" | "NO" | "CANCEL";
    ballots: BallotView[];
  };
}

/** Extension page -> service worker. Accepted only from the extension's own origin. */
export type InternalRequest =
  | { kind: "internal"; op: "state" }
  | { kind: "internal"; op: "create"; password: string }
  | { kind: "internal"; op: "unlock"; password: string }
  | { kind: "internal"; op: "lock" }
  | { kind: "internal"; op: "reset" }
  | { kind: "internal"; op: "changePassword"; oldPassword: string; newPassword: string }
  | { kind: "internal"; op: "touch" }
  | { kind: "internal"; op: "expectConnect"; origin: string }
  | { kind: "internal"; op: "connectSite"; origin: string }
  | { kind: "internal"; op: "disconnectSite"; origin: string }
  | { kind: "internal"; op: "pending"; id: string }
  | { kind: "internal"; op: "approve"; id: string }
  | { kind: "internal"; op: "reject"; id: string };

export type InternalReply = { ok: true; value?: unknown } | { ok: false; code: ErrorCode; message: string };
