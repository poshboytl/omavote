# Browser end-to-end runs on the dev chain

Output of `deploy/devnet/run-e2e.sh`, run `20261008T092115Z` (commit `75ac72d` plus the then-uncommitted test files), on the local CKB dev chain. Local paths are made relative; the downloaded bundles (14 MB each), server databases, logs and test keys stay in the git-ignored `devnet/e2e-out/`.

| Mode | Result | Duration | Steps | Signatures | result_hash | Blocks checked against the node |
|---|---|---|---|---|---|---|
| desktop 1440×1000 | PASS | 873 s | 16/16 | 12 | `0x459ab9d211…` | 42,497 |
| mobile (Pixel 7) | PASS | 906 s | 16/16 | 12 | `0x795f50aa3e…` | 43,397 |

In each mode:

- **Where the result hash was checked:** it is the same in four places:
  - the server API;
  - the page;
  - `omavote verify-evidence --rpc` (`verify-evidence.json`);
  - the TypeScript verifier (`verifier-ts.json`).
- **Outcome:** FAIL, with YES 0 and NO 80,000 CKB.
- **Zero balances:** the four test identities (owners A and B, voting keys K1 and K2) hold no ordinary CKB at any of the 35 balance checks. They use 7 addresses in total.
- **Page health:** no page errors, CSP violations or horizontal overflow.
- **Expected console errors:** six in each mode, all recorded in `report.json`:
  - five 404s from lookups before an object was indexed;
  - one refused connection while the primary server was stopped for the failover.

The steps and the per-ballot statuses are in `report.json`; `run.log` is the timeline.

Screenshots:

| File | What it shows |
|---|---|
| `desktop-revote.webp` | Owner B votes NO, then YES (MetaMask, Omnilock 0x12) |
| `desktop-failover-backup.webp` | The primary server was stopped. The kept envelope was resubmitted to the backup relay and counts there |
| `desktop-final.webp` | The final per-owner statuses after the committee attestation |
| `mobile-revote.webp` | The same revote on a Pixel 7 |

MetaMask here is an injected EIP-1193 provider that signs with `omavote sign --format evm`. Neuron signatures come from `omavote sign --format ckb` over the exact bytes the page shows. Tests with real wallets and devices are still open; see `docs/17-external-acceptance.md`.
