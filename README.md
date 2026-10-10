# Omavote

Free, verifiable voting for the [CKB Community Fund DAO](https://talk.nervos.org/c/daos-funding/ckb-community-fund-dao/65).

Depositors vote by signing a short, readable ballot in the wallet they already use. Relays publish the signed ballots to CKB at no cost to the voter. Anyone can recount the result from their own node, so nobody has to trust the voting site.

> **Status: early, not deployed.** Omavote runs end to end on a local CKB dev chain. The protocol is a draft and its wire format is not frozen. A deployment starts in shadow mode, which means its results carry no governance weight. Four things must happen before real use:
>
> - testing with real wallets and devices;
> - a review and a second verifier written by someone else;
> - a run at mainnet scale;
> - approval through the Community Fund DAO's own governance process.

## Why

Community Fund DAO votes are weighted by Nervos DAO deposits, but voting has run on a hosted platform where an account is bound to a deposit address. A [committee investigation](https://talk.nervos.org/t/dis-community-fund-dao-v1-1-web5-community-fund-dao-v1-1-web5-optimization-proposal/8973/70) found that rebinding the same address to a second account let one deposit count twice. The tally also could not be checked end to end from public data.

Omavote changes three things:

- each vote is tied to the deposit's own lock script, so there are no accounts to rebind;
- every signed ballot goes on chain;
- counting is deterministic, so anyone can redo it.

## How it works

```
Wallet (MetaMask, Neuron)
  │ 1. sign a readable ballot: no fee, the deposit never moves
  ▼
Web page (React + the protocol core compiled to WebAssembly)
  │ 2. submit the signed ballot, get a signed receipt back
  ▼
Relay (omavote serve + omavote relay)
  │ 3. publish the ballot to CKB, paying the fee
  ▼
CKB: Nervos DAO deposits are the voting power; ballots are public
  │ 4. anyone replays the chain with fixed rules
  ▼
Result hash: the same from the server, the page and two independent verifiers
```

- **Free for voters.** Relays pay the transaction fees and the cell capacity. Voting, changing a vote, delegating and revoking never require holding ordinary CKB.
- **Deposits stay put.** Voters only sign messages. Voting power is the deposit principal at the close of voting.
- **Readable signatures.** The wallet shows what is being signed. The first line is a summary that fits on a hardware wallet screen, for example `OMAVOTE VOTE YES #… 1000CKB`.
- **Relays are replaceable.** Any relay, or anyone at all, can publish the same signed ballot unchanged. If one relay goes down or refuses a ballot, the voter submits it to another one without signing again.
- **Optional delegation.** A depositor can authorize a separate voting key for up to a year, for example so that a Neuron user can vote from a browser wallet. The authorization can be revoked at any time, and voting directly always overrides the delegate.
- **Change your mind.** Signing a newer ballot replaces the earlier one. Only the latest valid ballot counts.
- **Payments stay manual.** A result never triggers a payment. The committee still reviews and pays from the treasury.

## Try it locally

You need:

- Linux x86_64 or macOS on Apple silicon (for the dev chain);
- Rust stable with the `wasm32-unknown-unknown` target and `wasm-pack`;
- Node.js 22 or later;
- Python 3;
- `curl`.

```bash
deploy/devnet/setup.sh          # start a local CKB dev chain (downloads ckb v0.210.0), RPC on 127.0.0.1:18114
(cd web && npm ci && npm run wasm && npm run build)
deploy/devnet/run-demo.sh       # real transactions: deposits, a proposal, votes, a reorg, an independent recount
target/release/omavote serve --config devnet/omavote.toml   # then open http://127.0.0.1:18080
```

More checks:

```bash
scripts/ci.sh                   # everything that needs no chain: format, lint, tests, advisories, both verifiers, the web app
deploy/devnet/run-e2e.sh        # the full voting flow in a browser on desktop, mobile and with the signer extension (Playwright)
```

## Verify a result yourself

You only need your own CKB node:

```bash
omavote verify --rpc http://127.0.0.1:8114 --poll 0x<poll_id> --check-clock --out bundle.json
```

You can also check an evidence bundle downloaded from a proposal page, with its chain history. `--rpc` compares every block with your node, which proves that nothing was left out:

```bash
omavote verify-evidence --input omavote-<id>-bundle-history.json --rpc http://127.0.0.1:8114
(cd verifier-ts && npm ci && npm run build)
node verifier-ts/dist/cli.js replay omavote-<id>-bundle-history.json --poll 0x<poll_id>
```

The second implementation, in TypeScript, was written from the specification and test vectors alone. Both must produce the same `result_hash`.

## Repository

| Path | What it is |
|---|---|
| `crates/omavote-core` | The protocol core in Rust, with no I/O: ballots, signatures, replay, tally. The same code is used by the server, the CLI and the browser |
| `crates/omavote-wasm` | WebAssembly bindings for the browser |
| `crates/omavote` | The server and CLI: `serve`, `relay`, `verify`, `verify-evidence`, `backup`, `rebuild-index` and dev chain helpers |
| `web/` | The web app (React, TypeScript, Vite), in English and Chinese |
| `verifier-ts/` | An independent verifier in TypeScript (CCC) |
| `extension/` | An optional browser extension (Chrome, Manifest V3) that holds one dedicated voting key and signs only delegate ballots |
| `schemas/`, `vectors/` | JSON Schema and cross-language test vectors |
| `deploy/` | systemd units, Caddy, example configuration and dev chain scripts |
| `evidence/` | Results of the dev chain runs |
| `docs/` | Design and specification (in Chinese) |
| `research/` | Research model and sources behind the design |

## Documentation

The design documents are written in Chinese.

| Document | Contents |
|---|---|
| [Design guide](docs/00-design-index.md) | Where to start |
| [Protocol](docs/03-protocol.md) and [authorization](docs/11-authorization.md) | The V2 specification |
| [Security analysis](docs/04-security.md) | Threats and defences |
| [Technical plan](docs/13-technical-plan.md) | How the code is built |
| [Implementation status](docs/14-implementation-status.md) | Tests, evidence and what is left |
| [Operations](docs/15-operations.md) | Running a deployment |
| [HTTP API and CLI](docs/16-api.md) | Every endpoint and command |
| [Acceptance template](docs/17-external-acceptance.md) | How to record tests with real wallets and an independent review |
| [Switch proposal (draft)](docs/18-governance-switch-proposal.md) | The proposal for moving the official vote to Omavote |
| [Signer extension](docs/19-signer-extension.md) | An optional browser extension that holds a dedicated voting key (first version built, not yet published) |

Some rules are left undefined by the current process and need a decision through governance before launch:

- the exact moment voting power is measured;
- deposits that are being withdrawn;
- rounding;
- the 67% boundary.

The [design decisions](docs/09-design-update.md) list them.

## Contributing

Issues and reviews are welcome. The most useful help right now:

- testing with real wallets: Neuron with and without a Ledger, MetaMask on desktop and on mobile;
- an independent verifier written from the specification;
- a review of the protocol.

## License

[MIT](LICENSE)
