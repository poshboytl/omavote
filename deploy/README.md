# Deployment and operations (draft)

This directory holds the files for a single-machine deployment. The full guide is the [operations manual](../docs/15-operations.md), and the endpoints are listed in [docs/16](../docs/16-api.md); both are in Chinese.

The implementation has only run on a local dev chain. Before any production launch, the work listed in [docs/14](../docs/14-implementation-status.md) is still required:

- tests on real devices;
- confirmation of the governance parameters;
- a manual audit.

[docs/17](../docs/17-external-acceptance.md) describes how to record that work.

A deployment starts in shadow mode (`governance_confirmed = false`). Until the governance process approves the switch ([docs/18](../docs/18-governance-switch-proposal.md)), results have no governance effect.

## Components

| Process | Files | Role |
|---|---|---|
| CKB full node | `ckb.service` | Your own node. RPC listens on localhost only, with the `Indexer` module enabled |
| `omavote serve` | `omavote.service`, `omavote.example.toml` | Sync and replay, the API, the static frontend, and intake of envelopes with signed receipts. Holds only the receipt key, no funds |
| `omavote relay` | `omavote-relay.service`, `relay.example.toml` | The relay publisher. It runs as its own system user and is the only process that can read the hot wallet key |
| Caddy | `Caddyfile` | HTTPS and request size limits |
| Dev chain | `devnet/setup.sh`, `devnet/run-demo.sh`, `devnet/run-e2e.sh` | Local dev chain, end-to-end demo and browser end-to-end tests |

## Installation

1. **Build.** Once `scripts/ci.sh` passes, run `scripts/package.sh`. It produces a release package with the binary, `web/dist`, the verifier and `SHA256SUMS`. Publish the SHA-256 of the archive. When deploying, run `sha256sum -c SHA256SUMS` first, then put `web/dist` at `web_root`.
2. **Generate the keys.**

   ```bash
   omavote keygen /etc/omavote/receipt.key
   omavote keygen /etc/omavote/relay.key --rpc http://127.0.0.1:8114
   ```

   The second command prints the hot wallet address. Both files are mode 0600, and each belongs to a different system user.
3. **Fund the hot wallet with limited working capital only.** Each carrier occupies 139 CKB, which later transactions recover; fees come on top. The balance is `relay.balance_shannon` in `GET /api/status`.
4. **Fill in `[protocol]` as decided by governance:**
   - the initial process roles (`initial_roles_hash` or a roles file);
   - the publication deadline for process records.

   Keep `governance_confirmed = false` until governance approves the switch. On mainnet, `[sync] start_height` speeds up the first start; check it first with `omavote verify --from-height H0 --compare`.

   Changing the roles, the deadline or the start height makes the server rebuild its chain cache. The relay queue and the receipts are kept.
5. **Start the services:** `systemctl enable --now ckb omavote omavote-relay caddy`.

## Backup

```bash
omavote backup --config /etc/omavote/omavote.toml --out /secure/backup/omavote-$(date +%F).sqlite
```

- **What it is:** an online, consistent copy; the new file is mode 0600.
- **What must be backed up:** the relay queue and the receipts exist only in the database. The block cache and the DAO history can be rebuilt from the node.
- **Not included:** the key files and the configuration. Back them up separately over a secure channel.
- **Rebuilding only the chain index** (keeps the queue and the receipts):
  1. stop `omavote` and `omavote-relay`;
  2. run `omavote rebuild-index --config ...`;
  3. start them again.

## Monitoring

`GET /api/status` returns these fields:

| Field | Meaning |
|---|---|
| `indexed` | Indexed height and hash |
| `node_tip`, `lag_blocks` | Node height and how many blocks the index is behind |
| `synced`, `last_error` | Sync state and the latest error |
| `reorgs` | Number of chain reorganizations and the depth of the latest one |
| `relay.queue` | Queue size per status |
| `relay.balance_shannon` | Hot wallet balance |
| `relay.oldest_in_flight_ms` | How long, in milliseconds, the oldest broadcast relay transaction has waited for inclusion |
| `shadow_mode` | `true` until governance has confirmed the deployment |

When `serve` and `relay` run as separate processes, `serve` cannot read the hot wallet key, so `relay.balance_shannon` is missing. Query the hot wallet address with the node's `get_cells_capacity` RPC instead.

Alert when any of these happens:

- the index falls more than about 20 blocks behind;
- `last_error` appears;
- the `RECEIVED` backlog stays high for a long time;
- a transaction has been in flight for more than about 10 minutes without inclusion;
- the balance drops below about 2,000 CKB.

## Independent verification

Anyone can recompute the results using only their own node:

```bash
omavote verify --rpc http://127.0.0.1:8114 --poll 0x<poll_id> --check-clock --out bundle.json
omavote verify-evidence --input omavote-<id>-bundle-history.json --rpc http://127.0.0.1:8114
```

The second command replays an evidence bundle downloaded from the web page, with its chain history, and checks every block against your node.

The TypeScript verifier in `verifier-ts/` is a separate implementation. Run `scripts/diff-verifiers.sh` to compare the two.
