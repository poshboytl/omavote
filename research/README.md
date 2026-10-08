# Executable research model

Run:

```bash
python -m unittest discover -s research -p 'test_*.py' -v
```

The model uses only the Python standard library. It does not go online, sign anything, read user wallets or broadcast transactions.

`model.py` checks the recommended model: **the end state, exact shannon amounts and voting power linear in principal**. Its input is a complete, verified history of the canonical chain plus authenticated ballots.

The tests cover:

- vote changes and repeated broadcasts;
- cross-scope messages, withdrawals and deadlines;
- recounting after a reorg;
- thresholds and randomized conservation checks.

Passing them does not mean a voting product has been implemented.

## Important simplifications

- **Ballots:** `VerifiedBallot` is an assumption made before the model runs, not real cryptographic signature verification. Never build such objects from untrusted HTTP requests for production counting.
- **Owners:** `owner` is an identity label normalized in advance. CKB address parsing and authentication of arbitrary locks are not implemented.
- **DAO type:** `exact_dao_type` assumes an exact script match has already happened upstream. The model only checks it together with the 8-byte data state.
- **Voting window:** `[start, end)` is a block interval fixed in advance. MTP, epoch fractions and the mapping to UTC are not implemented.
- **Transactions:** simulated transactions skip these checks and cannot be broadcast:
  - the 180-epoch maturity of DAO withdrawals;
  - CKB-VM;
  - the minimum capacity for storage;
  - fees.

  Transfer cases assume the real chain allowed the state change. They exist to check that counting never double counts.
- **Missing data:** `complete=False` checks that errors propagate. The model itself cannot notice chain data that a caller silently left out, so a production verifier must prove that the history is complete.
- **Reorgs:** reorg tests recount after replacing the canonical history. They do not implement node fork choice or incremental index rollback.
- **Decimals:** the old platform's decimal truncation is not implemented. That policy still has to be confirmed as the research documents describe.

The randomized tests generate 1,000 abstract histories from a fixed seed. Each history is checked for three properties:

- principal is conserved;
- repeated broadcasts are idempotent;
- reading order does not change the result.

Tests like these find some problems in an implementation or a specification. They cannot prove that the whole system is secure.

`sources.json` records the public material collected for this research and the pinned repository versions. The SHA-256 of each forum snapshot is the checksum of the file fetched here; a later API response is not guaranteed to return the same bytes. Full third-party posts and source code were not copied into this project.

## Relation to design v0.3

The [main protocol](../docs/03-protocol.md) and the [authorization specification](../docs/11-authorization.md) define the undeployed V2 draft, which adds:

- direct and delegated signatures;
- authorization controls ordered by anchor;
- cancellation barriers;
- process records;
- recovery.

This model still only takes abstract `VerifiedBallot` objects. **It implements none of these additions: no V2 encoding, no real signature verification and no wallet functions.**

The model was not changed or rerun for the v0.3 revision, so the history of its 39 tests cannot be used to claim that the new authorization formats or state machine pass. Those are tested by the Rust implementation instead: `crates/omavote-core/tests/scenarios.rs` covers the scenario table in docs/11 §8 (see [docs/14](../docs/14-implementation-status.md)).

These items still have to meet the [delivery gates](../docs/05-delivery.md):

- the full schema;
- cross-language vectors;
- state machine properties;
- key custody;
- acceptance on real devices and on chain.
