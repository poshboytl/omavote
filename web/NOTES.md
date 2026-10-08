# Frontend notes and open points (M5)

Written while building `web/` on 2026-10-08 and updated after the browser end-to-end
test. Outside `web/` only `deploy/devnet/run-e2e.sh` was added.

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

1. **Forum import**: done by the coordinator (b93f418): the server reads the current
   revision of a Nervos Talk topic (`GET /api/forum/import`) and the create page fills
   the form from it.
2. **Independent tip check** (docs/11 §5 step 1): done by the coordinator (ad8ea70,
   `src/lib/tipcheck.ts`): before signing, the anchor must equal the tip of an
   independent source (another server's `/api/status` or a CKB node RPC) set in
   Settings; optional on development chains, required on mainnet/testnet.
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
10. **Server serving `web/dist`**: resolved; the servers started by the end-to-end test
    serve `web/dist` from their first start.
11. **Opening estimate** on the create page uses the block interval observed while the
    page is open (fallback 10 s) plus a 20-block margin. It is a warning, not a rule.
12. **Defaults to confirm**: create-page defaults `result_confirmations = 100` and a
    24 h review window are the candidate values from docs/03 §10; on development chains
    an “advanced” section can shorten the voting period and opening confirmations through
    the core's `default_rules` (this changes `rules_hash`, as intended).
13. **Neuron wording**: the instructions say “Tools → Sign/Verify Message” (the Chinese
    UI calls it 「工具 → 签名/验证信息」). Confirm against the current Neuron release during M2.
14. **Pending-revoke guard**: a REVOKE signed in this browser blocks a plain GRANT for the
    same owner until the index shows an outcome for it or its publication deadline
    passes (docs/11 §5 step 6). GRANT+CANCEL is allowed because it sets its own barrier.
15. **Process records**: all members must sign the identical body, so the draft (body +
    collected proofs) is shared as JSON and kept in `localStorage` on each device.
    RESULT_ATTESTATION is prefilled from the server's computed result; the page tells
    members to attest only a hash they recomputed.

## Browser end-to-end test on the dev chain

`web/e2e/devnet-e2e.mjs` (wrapper `deploy/devnet/run-e2e.sh`, described in README.md)
drives the built UI with Playwright on the local dev chain, desktop (1440×1000) and
Pixel 7, against its own primary and backup servers: proposal, admission, GRANT,
delegate and direct votes, revote, GRANT+CANCEL key rotation, owner take-over, relay
failover, committee attestation, and the evidence bundle replayed by both verifiers.
It fails on page errors, CSP violations and horizontal overflow.

Bugs it found in `web/`, fixed:

- **Receipt page after "Submit again"**: the relay status above kept the 404 from before
  the resubmission and the new receipt was not checked. It now verifies the returned
  receipt (signer, object, envelope bytes) and refreshes the relay status every 5 s
  while the item is in flight.
- **Horizontal overflow on phones**: long addresses and hashes did not wrap on the
  receipt page ("Kept on this device", "Signed on this device"; up to 749 CSS px on a
  412 px screen, which also broke a click), the create page (computed content hash) and
  the address page (`key_id`). Long tokens in the main content now wrap
  (`overflow-wrap: anywhere`); tables keep their own scroll container.

Expected console errors during a run (recorded in report.json, not failures): 404s from
lookups of objects that are not indexed yet, and connection refusals while the primary
is stopped during the failover.

## Verification done here

- `npm test`: 53 tests. `npm run build`: passes (tsc strict for app and tests, vite
  build).
- Browser end-to-end test on the dev chain (`deploy/devnet/run-e2e.sh`, run
  `20261008T084856Z`): desktop passes in 892 s, Pixel 7 in 903 s. In both, the
  result_hash is the same on the server, on the page, in `omavote verify-evidence --rpc`
  and in `verifier-ts`; there are no page errors, CSP violations or overflow, and the
  owners and keys hold 0 ordinary CKB at all 35 balance checks. Output:
  `devnet/e2e-out/20261008T084856Z-{desktop,mobile}/`.
  The coordinator reran both modes (run `20261008T092115Z`, both PASS); that run's
  reports, verifier outputs and screenshots are committed in `evidence/devnet-2026-10-08/e2e/`.
- Earlier: headless Chromium against the live devnet server through a read-only proxy
  (all routes, the server's exact CSP, no POST).

## Needs real devices / people

- MetaMask desktop and mobile: `personal_sign` shows the full UTF-8 text (including line
  breaks and Chinese), the hex-looking sample is shown as text, account switching
  resets the flow, EIP-6963 selection with several wallets installed. The end-to-end
  test uses an injected EIP-1193 provider, not the extension.
- Neuron (with and without Ledger): copy/paste keeps LF line breaks on Windows/macOS/
  Linux, signature format `0x` + 65 bytes with v = 00/01, Ledger first-line display.

## Core / server suggestions (not made; outside web/)

- Done by the coordinator: `scope_id`/`owner_id` on relay items,
  `GET /api/owners/{id}/queued`, forum import, the independent tip check.
- Anchor heights in `/queued` items (today the page resolves each anchor hash with one
  extra request).
