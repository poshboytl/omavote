# Omavote web frontend (M5)

Static web app for the Omavote V2 voting protocol (`docs/03`, `docs/11`, plan in
`docs/13` §8): proposals and results, voting with MetaMask (EIP-1193) or Neuron
(copy & paste), voting authorizations, proposal creation, process records, receipts,
status, independent verification and a wallet acceptance page.

Every signed text, ID and local signature check comes from the Rust protocol core
compiled to WebAssembly (`crates/omavote-wasm`); the page never re-implements a rule.
Wallets keep their keys: the page only asks them to sign the exact text it shows.

- Vite + React 18 + TypeScript (strict), `HashRouter`, plain CSS with system fonts.
- Runtime dependencies: `react`, `react-dom`, `react-router`. No UI kit, no remote
  fonts or CDNs, no analytics, no inline scripts.
- Builds satisfy the server's CSP:
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'`.

## Requirements

- Node 20+ (developed with Node 26) and npm.
- To build the core: Rust with the `wasm32-unknown-unknown` target and `wasm-pack`
  (`cargo install wasm-pack`).

## Commands (run in `web/`)

```sh
npm ci            # install (package-lock.json is committed)
npm run wasm      # build the core: wasm-pack → src/wasm/pkg (git-ignored)
npm run dev       # dev server on :5173, proxies /api and /feed.atom
npm run build     # tsc (app + tests) and vite build → dist/
npm run preview   # serve dist/ with the server's exact CSP header (and the proxy)
npm test          # vitest (Node; loads the WASM from disk)
```

`npm run wasm` must run once before `dev`, `build` and `test` (they stop with a clear
message when `src/wasm/pkg` is missing) and again whenever the core changes.

The dev and preview proxies send `/api` and `/feed.atom` to `OMAVOTE_API`
(default `http://127.0.0.1:18080`, the devnet server):

```sh
OMAVOTE_API=http://127.0.0.1:8080 npm run dev
```

## Serving

- **With the Omavote server**: set `web_root = "web/dist"` in `[server]`
  (`omavote example-config`). The server serves `dist/` at `/` with the strict CSP and
  an `index.html` fallback. It looks for `index.html` when it starts, so restart it
  after the first build.
- **Any static host / mirror**: copy `dist/`. Asset URLs are relative and routing uses
  the URL fragment (`#/proposal/0x…`), so any path works. Point the page at an API in
  *Settings* (stored in `localStorage`); that server must allow the mirror's origin
  (`cors_origins`). The build carries a CSP `<meta>` (`connect-src 'self' https:` plus
  localhost) as defence in depth; when the Omavote server serves `dist/` its header
  (`connect-src 'self'`) is the effective, stricter policy.

## Pages

| Route | Page |
|---|---|
| `#/` | Proposals: status, admission/governance/attestation badges, counts. A `PROVISIONAL` tally is shown as “current count — not a result” and never with an outcome. |
| `#/proposal/{id}` | Facts (budget, recipient, proposers, quorum, threshold), schedule in UTC + chain time (MTP) with estimates and the drift note, official status, tally, vote panel, ballots with statuses, rejected items with codes, process records, evidence bundle download. The poll id is recomputed locally from the manifest. |
| vote panel | **MetaMask (owner)**: `eth_requestAccounts` → `evm_owner_locks` → the lock with deposits → ballot. **MetaMask (voting key)**: `evm_key` → `GET /api/keys/{key_id}/authorizations` → one delegate ballot per owner with a CURRENT grant. **Neuron**: CKB address → `parse_address` → text with copy button → pasted 65-byte signature (v = 00/01). |
| `#/address/{address}` | Deposits, ballots across polls, authorization stream (current grant, history with outcomes, conflict flag, barriers), feed link, and GRANT / GRANT+CANCEL / REVOKE (STOP_ONLY, STOP_AND_CANCEL_OPEN) signed by the owner (MetaMask for EVM owners, Neuron otherwise). MetaMask accounts can also list their EVM owner locks. |
| `#/receipt/{id}` | Relay status and signed receipt check, then the index check (SELECTED / EFFECTIVE) using the item's `scope_id`/`owner_id`; envelopes signed on this device (download / resubmit / forget). |
| `#/create` | Proposal form → `manifest_from_draft` (defaults from `/api/network`) → `proposal_text` signed by every proposer (MetaMask or Neuron) → payload submitted; warns when the start leaves too little room for `opening_confirmations` plus the admission record. |
| `#/records` | Process records: build the body with `record`, share the draft, collect member signatures (paste or MetaMask), submit `{"body","proofs"}` once the threshold is met. |
| `#/status` | Index tip, node tip, lag, last sync/error, reorgs, relay (intake, receipt key, wallet, queue), network parameters, diagnostics. |
| `#/verify/{id}` | How to run `omavote verify` and `verifier-ts/`, comparison of your `result_hash` with the server's, the committee-attested one and a bundle file; local check of a signed envelope. |
| `#/wallet-check` | M2 preparation: sign fixed samples (ballot with a Chinese title, GRANT, hex-looking text) with MetaMask or Neuron, verify locally, show the recovered address/key and download a JSON record `{wallet, version_notes, text, signature, recovered, …}`. |
| `#/settings` | API base URL, language. |

The interface starts in English; Chinese is one click away in the header or in Settings, and the choice is remembered (dictionaries in `src/i18n/`).

## Signing flow (all wallets)

1. Check `/api/status` (synced, small `lag_blocks`, intake on). Ballots and GRANT ask
   for an explicit acknowledgement when the server is behind; REVOKE and GRANT+CANCEL
   (recovery messages) are refused until it is in sync.
2. Anchor = `/api/anchor` (the newest indexed block), strictly higher than every
   earlier anchor of the same owner: for ballots, every ballot of the owner in the poll
   (`/ballots?owner=`) and anything signed in this browser; for controls,
   `max_anchor_height` and the stream history plus local signatures; in both cases also
   the owner's ballots and controls queued at the relay (`/api/owners/{id}/queued`,
   e.g. signed on another device). Otherwise the page
   shows “waiting for the next block…” and polls until one arrives. Never an older block.
3. The body is built with exactly the fields of the Rust drafts; the core validates it,
   computes its id and renders the text. The page shows the full text, the first-line
   summary (what a Ledger shows) and the exact UTF-8 bytes.
4. MetaMask: `personal_sign(["0x" + hex(utf8(text)), address])` (always hex, so a text
   that looks like hex is never signed as raw bytes). Neuron: the user pastes the
   signature.
5. Local verification with `verify_owner` / `verify_key`; nothing is submitted if it fails.
6. `POST /api/envelopes` with the envelope in JCS form; the signed envelope is kept in
   `localStorage` for retry/download.
7. Receipt check: `receipt_signer` must equal the server's `receipt_key`, the receipt
   must name the object and the exact envelope bytes. A receipt is **not** inclusion.
8. Follow `/api/receipts/{id}` until INCLUDED/CONFIRMED, then confirm with the index:
   ballot `SELECTED` (only then “your vote counts”), control `EFFECTIVE` and reflected in
   `current`, record listed, poll registered. The tracker keeps watching and asks the
   user to sign again when the relay gives up, the anchor block was orphaned
   (`ANCHOR_INVALID`), the publication window passed, or the item vanished after a reorg.

## Source layout

```
src/lib/       plain TS (no DOM): core facade, API client, EIP-1193, flows, tip check,
               formatting, i18n logic, storage, wallet-check samples
src/wasm/      browser loader; pkg/ is the wasm-pack output (git-ignored)
src/i18n/      en.ts / zh.ts dictionaries (same keys, checked by the compiler and tests)
src/app/       React contexts (app state, i18n, wallet) and layout
src/components/ shared UI: signing text, tracker, vote panel, authorization panel, badges
src/pages/     one file per route
test/          vitest suites and helpers (WASM loader, mock wallet, mock server)
e2e/           browser end-to-end test on the local dev chain (Playwright)
```

## Tests

`npm test` runs 53 tests in Node with the real WASM core:

- end-to-end vote flows against a mocked server (`test/helpers/mock-server.ts`, which
  checks envelopes like the relay and signs receipts): MetaMask owner (Omnilock),
  delegate (voting key), Neuron (pasted signature), rejected/duplicate submissions,
  wrong receipt signer, anchor waiting rules (including anchors queued at the relay),
  sync checks, the independent tip check;
- authorization controls (GRANT, GRANT+CANCEL, REVOKE modes), multi-member process
  records, proposal payloads with several proposers;
- a mock EIP-1193 provider built on `@noble/curves` + `@noble/hashes` (EIP-191), and a
  Neuron-style signer (`Nervos Message:` + CKB Blake2b), independent of the Rust code;
- i18n key and placeholder parity, formatting helpers (cross-checked with the core),
  hex/signature parsing, API client, storage, wallet-check samples.

## Browser end-to-end test on the dev chain

`deploy/devnet/run-e2e.sh` builds everything and runs `web/e2e/devnet-e2e.mjs`
(Playwright, Chromium) on a desktop viewport (1440×1000) and on a Pixel 7, one after the
other (`deploy/devnet/run-e2e.sh mobile` runs one mode; `DEVICE=mobile node
web/e2e/devnet-e2e.mjs` runs it without rebuilding). It needs the dev chain from
`deploy/devnet/setup.sh`. Each run starts its own servers with fresh databases and keys:
a primary on 127.0.0.1:18090 serving `web/dist`, and a backup on 127.0.0.1:18091 that
accepts submissions from the primary's origin. Both relays are funded from the dev
faucet; the owners get Nervos DAO deposits under run-specific test labels.

Every protocol action goes through the UI:

1. proposal created on the create page, signed by owner A with Neuron;
2. coordinator ADMISSION on the records page (EVM member, MetaMask);
3. A grants voting key K1 on the address page (Neuron); wait until the poll is OPEN;
4. K1 votes YES for A (delegate mode); owner B (Omnilock 0x12) votes NO, then YES;
5. A rotates to K2 with GRANT+CANCEL (K1's ballot is cancelled), K2 votes NO;
   A takes over with a direct CANCEL (Neuron);
6. failover: the primary is stopped between signing and submission, the submission fails
   and the envelope stays on the device, the API base is switched to the backup in
   Settings, the envelope is resubmitted from Receipts and becomes SELECTED; the
   restarted primary shows the same ballot as SELECTED; the page switches back;
7. owners and voting keys hold no ordinary CKB at any point (every action was free);
8. after the close (AUDITABLE) the committee attests the result, 2 of 3 members;
9. the evidence bundle with chain history is downloaded from the proposal page and
   replayed by `omavote verify-evidence --rpc` and by `verifier-ts`: both must equal
   the page's result_hash; the final per-owner statuses are checked through the API.

MetaMask is an injected EIP-1193/EIP-6963 provider whose `personal_sign` runs
`omavote sign --format evm` on the hex it receives; Neuron signatures are
`omavote sign --format ckb` over the exact bytes the page shows. The run fails on any
page error, CSP violation or horizontal overflow. Output in `devnet/e2e-out/<run>/`:
`report.json`, a screenshot per step, both servers' logs, the downloaded bundle and the
verifiers' output, and a Playwright trace on failure. A mode takes about 15 minutes,
mostly the 5-minute lead before the opening and the 8-minute voting period.

## What needs a real browser or device

Not automated here (see `NOTES.md`):

- MetaMask desktop and mobile (in-app browser): `personal_sign` display of the full text,
  account switching, EIP-6963 discovery with several wallets. The end-to-end test uses
  an injected provider, not the MetaMask extension.
- Neuron *Sign/Verify Message* (menu names, line breaks after copy/paste on each OS,
  signature format) with and without Ledger (first-line display). The end-to-end test
  signs the same bytes with `omavote sign`, which matches Neuron's output byte for byte.

Use `#/wallet-check` for the device tests and attach the downloaded records to the M2
report.
