# Omavote: lightweight voting for the CKB Community Fund DAO

Voters sign readable ballots in their own wallets, open relays publish the signed ballots to CKB for free, and anyone can recompute the result from their own node.

Research baseline: 2026-10-07. This revision: 2026-10-08. Status: **v0.3 design review baseline and research model, with a working implementation on a local CKB dev chain. Not yet a deployable product.** The design documents are written in Chinese.

## How it works

The design baseline is **readable ballots signed in the voter's wallet, open relays that batch the complete signed ballots onto the chain, deterministic off-chain counting, and independent recomputation by anyone**. Voting power stays linear in existing Nervos DAO deposits. Deposits never move, and the voting result is not wired to automatic treasury payments.

The latest requirements confirmed by the project owner:

- **Vote weight**: the calculation stays as it is.
- **Wallets**: which wallets to support is open to discussion.
- **Free voting**: voting stays free for users. Relays and operators pay the chain fees and the carrier capacity. Authorizing, renewing, voting, changing a vote, cancelling and recovering never require users to pay fees or hold ordinary CKB.
- **Backend**: a trusted backend is acceptable only if it is verifiable. Running without one must not make the experience noticeably worse.

The first release supports one authorization for many votes: one year (365 chain days) by default and at most 365 days. This replaces the earlier scope of "no authorization in the first release".

The main flow for Neuron users:

1. Use Neuron once to authorize a second, online wallet.
2. During the authorization period, sign each vote with that online wallet.
3. Relays publish the votes for free.

The deposits stay at their original address, and the online wallet needs no CKB. A local key generated in the browser remains an optional candidate and is not required for the first release.

## Implementation

Since 2026-10-08 the [technical plan and milestones](docs/13-technical-plan.md) have been implemented and run end to end on a local CKB dev chain:

- a Rust protocol core, also compiled to WASM;
- a server for sync and replay, relaying and the API;
- `omavote verify`;
- a web frontend;
- an independent TypeScript verifier.

The implementation has only run on a dev chain. **It has not been deployed to testnet or mainnet.**

| Document | Contents |
|---|---|
| [Implementation status](docs/14-implementation-status.md) | Progress, test evidence and the work that still needs people |
| [Operations](docs/15-operations.md) | Deployment and day-to-day operation |
| [HTTP API and CLI](docs/16-api.md) | Endpoints and command-line usage |
| [External acceptance template](docs/17-external-acceptance.md) | How to record tests with real devices, real users and independent audits |
| [Switch proposal](docs/18-governance-switch-proposal.md) | The official switch, which must go through the existing governance process |

Until the switch is approved, deployments run in shadow mode and their results have no governance effect. A file map is in [docs/14 §10](docs/14-implementation-status.md).

```bash
cargo test --workspace                # protocol core, server, WASM bindings
scripts/ci.sh                         # every check that needs no node: format, clippy, tests, RustSec, both verifiers, frontend
deploy/devnet/setup.sh                # local dev chain (downloads ckb v0.210.0)
deploy/devnet/run-demo.sh             # end-to-end demo: deposits, authorization, votes, reorg, replay
```

## Design documents

**Start here: [design guide](docs/00-design-index.md).** It covers the recommendation, how it meets each requirement, every file and the limits of what has been verified.

**For reviewers: [review guide and checklist](docs/12-review-guide.md).** Read in this order:

1. The [current decisions](docs/09-design-update.md) and the [complete user journey](docs/10-user-journey.md).
2. The [main protocol](docs/03-protocol.md) together with [term-limited authorization](docs/11-authorization.md).

The main protocol is an undeployed V2 draft. Four things are unchanged: complete ballots go on chain, relays pay for publishing, results are recomputed independently, and treasury payments stay manual. Two sets of changes are written into the specification ([decision log §9–11](docs/09-design-update.md)):

- the freeze blockers from Claude's second review;
- the fixes from two colleague reviews.

The implementation tests them against the scenarios in [docs/11 §8](docs/11-authorization.md). The wire format stays unfrozen until signatures from real wallets have been tested ([docs/14 §3](docs/14-implementation-status.md)).

Suggested reading order:

1. [Design and options](docs/02-design.md): what is recommended, why, the alternatives and the trade-offs.
2. [Rules and research findings](docs/01-research.md): how the rules evolved, past incidents, community views, source checks and compatibility limits.
3. [Protocol draft](docs/03-protocol.md): the exact semantics of voting power, signatures, evidence, vote changes, deadlines, reorgs and replay.
4. [Security analysis](docs/04-security.md): attack paths, defences, what cannot be solved, and acceptance requirements.
5. [Product and delivery plan](docs/05-delivery.md): wallet experience, system boundaries, costs, migration and release gates.
6. [Executable model](research/README.md): checks the core counting invariants. It **does not implement cryptography, CKB validation or wallet integration**.
7. [Deeper comparisons](docs/06-alternatives.md): off-chain logs, on-chain evidence, direct transactions, contracts and zkVM, challenge periods and other snapshot policies.

The [source list](research/sources.json) pins the versions of the 14 repositories studied and registers 28 forum topics. The 637 fetched posts were used for search and targeted reading; they were not audited one by one. Upstream source snapshots are not necessarily the versions deployed today.

The most important open items concern the rules, not the tech stack. The current rules leave these details undefined, and they need to be written down:

- a single point in time for counting;
- the voting power of phase-1 withdrawals;
- decimal handling;
- the 67% boundary;
- the deadline.

The documents keep facts, design recommendations and items that need governance confirmation apart, and never present a recommendation as a rule in force.

Run the research model:

```bash
python -m unittest discover -s research -p 'test_*.py' -v
```

Nothing in this repository has deployed a contract, changed DAO rules, or touched a real wallet or the treasury. All transactions so far ran on a local dev chain.

Item-by-item completion evidence for the initial design is in the [completion audit](docs/07-completion-audit.md). Technical inferences that are easy to misuse, and the ACP counterexample, are in the [security assumptions review](docs/08-design-review.md).

This design was chosen as the basis, and the applicable parts of the earlier Claude and Fable drafts were adopted into it. The Fable draft was deleted on 2026-10-08, and `docs/` is the single design baseline.

## License

MIT, see [LICENSE](LICENSE).
