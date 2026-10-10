# Signer extension end-to-end run on the dev chain

Output of `DEVICE=extension node web/e2e/devnet-e2e.mjs`, run `20261010T161119Z`, on the local CKB dev chain (branch `signer-extension`). The devnet build of `extension/` was loaded unpacked into Chromium (Playwright, new headless mode). Local paths are made relative; the server databases, logs, browser profile and test keys stay in the git-ignored `devnet/e2e-out/`.

| Result | Duration | Steps | Test-identity signatures | Extension confirmations |
|---|---|---|---|---|
| PASS | 447 s | 12/12 | 5 (proposal, admission, three GRANTs) | 4 (2 connections, 2 signing requests) |

What the run did, all through the web page and the extension's own windows:

1. Created a proposal (Neuron proposer) and the coordinator's admission.
2. Created a voting key in the extension popup, then checked that the page sees a frozen `window.omavote` and has no other channel to the extension.
3. Connected the site from the page; the confirmation window showed the origin and the key address.
4. Owners A and C (Neuron) each signed a GRANT to the extension key, using "Use the Omavote extension's key". The GRANT summary line names the same address the extension shows.
5. After the poll opened: one confirmation signed delegate YES ballots for both owners. The window listed exactly those two addresses, the proposal number and the choice. Both ballots counted (`SELECTED`).
6. Reset the key in the popup. The open page saw the disconnection (`omavote:changed`). A new key was created and the site connected again.
7. Owner A signed GRANT+CANCEL to the new key ("New extension key: cancel the old key's ballots"); the new key voted NO for A. Final statuses:
   - the old key's YES for A: `CANCELLED_BY_CONTROL`;
   - the new key's NO for A: `SELECTED`;
   - C's YES (old key, still authorized): `SELECTED`.

Checks along the way:

- **Zero balances:** owners and both extension keys hold no ordinary CKB at any of the 26 balance checks (10 addresses).
- **Page health:** no page errors or CSP violations. Four console errors, all 404s from lookups before an object was indexed (`report.json`).

Screenshots:

| File | What it shows |
|---|---|
| `confirm-window.webp` | The extension's confirmation for two delegate ballots, before the confirm button arms |
| `new-key-vote.webp` | The proposal page after the new key's NO counted; the old key's ballot shows as cancelled |

Neuron signatures come from `omavote sign --format ckb` over the exact bytes the page shows; the coordinator's admission is signed by the injected MetaMask provider, as in the desktop run. The per-browser manual acceptance (Chrome, Brave, Edge, Arc) is still open; see `docs/17-external-acceptance.md`.
