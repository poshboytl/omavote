# Frontend notes and open points (M5)

Written while building `web/` on 2026-10-08. Nothing outside `web/` was changed.

## Spec and API changes followed during the work

- `tally.kind == "PROVISIONAL"` no longer carries `outcome` (server commit ce709aa).
  `TallyView` is a union: only `FinalTally` has `outcome` and `result_hash`, so the
  compiler rejects reading an outcome from a provisional count. The page shows
  provisional numbers as “current count — not a result”, without thresholds or pass/fail.
- Diagnostics carry the rejected signed `object` (25c90b0): typed as optional.
- `/api/anchor` returns the newest indexed block (dc90515). The page uses it as-is and
  waits for a newer block when the anchor is not strictly above the owner's earlier
  ballots/controls (indexed or signed in this browser).
- Omnilock EVM owners with auth flag `0x12` (dc90515): `evm_owner_locks` now returns
  Omnilock 0x01, PW Lock and Omnilock 0x12; the UI lists all and picks the one with a
  deposit (labels show the flag).
- Decimal limits (u64) and JSON depth (6ef6357): the create form rejects amounts that do
  not fit u64; the core enforces the rest.

## Not implemented / limitations

1. **Forum import** (docs/13 §8 “提案创建（论坛导入）”): impossible under
   `connect-src 'self'`. Needs a server endpoint (e.g. `GET /api/forum/{topic}/{revision}`
   returning the post text, revision and timestamps). The form takes manual input.
2. **Independent tip check** (docs/11 §5 step 1: compare the tip height and hash with at
   least one independent source before recovery messages): the page only knows its
   configured server. A second API base to compare with would close this; today the
   check is `synced` + `lag_blocks` + last-sync age from the same server.
3. **Relay queue awareness** (docs/11 §5 step 2): wired to the new
   `GET /api/owners/{id}/queued` (server commit 7aeb33f). Ballot and control anchors are
   kept strictly above the anchors of the owner's queued ballots *and* controls (the
   conservative reading: at most one extra block of waiting). Queued envelopes carry
   anchor hashes; their heights come from `GET /api/owners/{id}/power?block_hash=`
   (404 = not canonical, skipped because such a message cannot take effect). Servers
   without the endpoint (404 or the HTML fallback) are treated as having an empty queue.
   Only this relay's queue is visible; other relays' queues are not.
4. **Receipts from any device**: wired to `scope_id` / `owner_id` on relay items
   (7aeb33f). The receipt page follows any ballot or control receipt to the index check
   (SELECTED / EFFECTIVE) even without a locally kept envelope. Process-record receipts
   use `scope_id` as the poll id and fall back to the roles check for ROLES_UPDATE.
5. **Delegate voting with a secp256k1 key** (a voting key held in a CKB wallet): GRANT to
   a secp256k1 public key is supported, but the vote panel only offers MetaMask voting
   keys. A Neuron-held voting key would need a paste flow plus the key's public key.
6. **WebAuthn / passkey and the local-key candidate** (docs/11 §4.3): optional in V2, not
   implemented. EIP-712 is not implemented (it would be a separate adapter).
7. **WalletConnect / mobile wallets outside MetaMask's in-app browser**: not supported;
   WalletConnect needs a third-party relay, which conflicts with the CSP.
8. **Content check of mirrors**: the page cannot fetch the proposal text from
   `content_locations` (CSP), so it only displays the content hash. The create page
   computes the hash of pasted text.
9. **Large polls**: `/api/proposals/{id}/ballots` is not paginated; the page loads and
   filters all ballots client-side. Fine for the devnet, worth a cursor for mainnet.
10. **Server serving `web/dist`**: the server checks for `index.html` only at startup;
    the coordinator restarts the devnet server after this work so that it serves `dist/`.
11. **Opening estimate** on the create page uses the block interval observed while the
    page is open (fallback 10 s) plus a 20-block margin. It is a warning, not a rule.
12. **Defaults to confirm**: create-page defaults `result_confirmations = 100` and a
    24 h review window are the candidate values from docs/03 §10; on development chains
    an “advanced” section can shorten the voting period and opening confirmations through
    the core's `default_rules` (this changes `rules_hash`, as intended).
13. **Neuron wording**: the instructions say “Tools → Sign/Verify Message” (中文「工具 →
    签名/验证信息」). Confirm against the current Neuron release during M2.
14. **Pending-revoke guard**: a REVOKE signed in this browser blocks a plain GRANT for the
    same owner until the index shows an outcome for it or its publication deadline
    passes (docs/11 §5 step 6). GRANT+CANCEL is allowed because it sets its own barrier.
15. **Process records**: all members must sign the identical body, so the draft (body +
    collected proofs) is shared as JSON and kept in `localStorage` on each device.
    RESULT_ATTESTATION is prefilled from the server's computed result; the page tells
    members to attest only a hash they recomputed.

## Verification done here

- `npm test`: 48 tests (see README). `npm run build`: passes (tsc strict for app and
  tests, vite build).
- Headless Chromium against the live devnet server, through `vite preview` with the
  server's exact CSP header: all routes render with no console errors and no CSP
  violations; the WASM loads under `script-src 'self' 'wasm-unsafe-eval'`.
- The Neuron vote flow was driven up to the prepared ballot through a read-only proxy
  (GET forwarded, one closed poll presented as OPEN, every POST refused): sync check,
  anchor floor from `/ballots?owner=`, newest anchor, ballot text built by the core with
  summary `OMAVOTE VOTE YES #03263c55c785c88f 1000CKB`. English and Chinese.
- **No POST was sent to the live server.** The submit → receipt → inclusion → SELECTED
  path is covered by the mocked-server tests only.

## Needs real devices / people

- MetaMask desktop and mobile: `personal_sign` shows the full UTF-8 text (including line
  breaks and Chinese), the hex-looking sample is shown as text, account switching
  resets the flow, EIP-6963 selection with several wallets installed.
- Neuron (with and without Ledger): copy/paste keeps LF line breaks on Windows/macOS/
  Linux, signature format `0x` + 65 bytes with v = 00/01, Ledger first-line display.
- A full UI vote (MetaMask owner, delegate key, Neuron), GRANT/REVOKE and a proposal on a
  fresh devnet where submissions are allowed, watching the tracker through inclusion,
  supersession by a revote, and a reorg.

## Core / server suggestions (not made; outside web/)

- Done by the coordinator: `scope_id`/`owner_id` on relay items and
  `GET /api/owners/{id}/queued`.
- A server endpoint for forum import (see 1).
- Anchor heights in `/queued` items (today the page resolves each anchor hash with one
  extra request).
- Re-check `web_root` per request (or log clearly) so a later build is served without a
  restart.
