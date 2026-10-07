# omavote-verifier-ts

An independent TypeScript implementation of the Omavote V2 vote-replay
verifier. It was written only from `docs/` (normative: `docs/03-protocol.md`,
`docs/11-authorization.md`, encoding details in `docs/13-technical-plan.md` §4)
and the JSON test vectors in `vectors/`. It shares no code with the Rust
implementation. Every place where the docs were silent, ambiguous or had to be
read together with a vector is listed in [SPEC-NOTES.md](SPEC-NOTES.md).

CKB primitives come from [`@ckb-ccc/core`](https://github.com/ckb-devrel/ccc):
Blake2b with the `ckb-default-hash` personalization, Molecule `Script`
serialization, script hashes and RFC 0021 bech32m full addresses.
Public-key recovery uses `@noble/curves` (secp256k1), and EIP-191 hashing uses
`@noble/hashes` (keccak-256).

## Build, test, run

Requires Node 22+ (developed on Node 26) and npm.

```sh
cd verifier-ts
npm ci                 # or: npm install
npm run build          # tsc -> dist/ (the CLI is dist/cli.js)
npm test               # builds, then runs node:test over every suite (vectors + scenarios)
```

`npm test` compiles `src/` and `test/` into `dist/test-build/` and runs
`node --test "dist/test-build/test/*.test.js"`. The vector suite loads every
`*.json` file in `../vectors/` and fails if a file has no checker. Every
`replay*.json` file, such as `replay-edge.json`, is replayed and compared with
its `expected` block. Set
`OMAVOTE_VECTORS=/path/to/vectors` to point it elsewhere.

### CLI

```sh
# Check every vector file; exits 1 on any mismatch or unknown file
node verifier-ts/dist/cli.js check-vectors vectors/ [--quiet]

# Replay a block dump (same shape as vectors/replay.json minus "expected")
node verifier-ts/dist/cli.js replay vectors/replay.json
node verifier-ts/dist/cli.js replay dump.json --poll 0x<poll_id>
cat dump.json | node verifier-ts/dist/cli.js replay - --canonical
```

| Option | Effect |
|---|---|
| `--poll <poll_id>` | Print only that poll. The object has the keys of `expected` in `vectors/replay.json` (`poll_id`, `result_core`, `result_hash`, `admission`, `attestation`, `diagnostics`) plus extra evidence fields. |
| `--verbose` | Add `position` (`tx_index`, `output_index`, `envelope_index`) and a human-readable `message` to each diagnostic. |
| `--canonical` | Print RFC 8785 JCS (one line) instead of indented JSON, which makes diffs byte-exact. |

Exit codes for `replay`: 0 on success (even with rejected messages, which are
diagnostics), 1 on unusable input (malformed dump, broken parent chain, history
not starting at genesis, unknown `--poll`), 2 on a usage error.

## Replay input

```json
{
  "network": {
    "name": "devnet",
    "genesis_hash": "0x…",
    "hrp": "ckt",
    "secp256k1": {"code_hash": "0x…", "hash_type": "type"},
    "dao":       {"code_hash": "0x…", "hash_type": "type"},
    "omnilock":  {"code_hash": "0x…", "hash_type": "type"},
    "pw_lock":   {"code_hash": "0x…", "hash_type": "type"}
  },
  "initial_roles_hash": "0x…",
  "process_publication_delay_ms": "259200000",
  "blocks": [
    {"number": "0", "hash": "0x…", "parent_hash": "0x00…", "clock_ms": "…",
     "transactions": [
       {"hash": "0x…",
        "inputs":  [{"tx_hash": "0x…", "index": "0"}],
        "outputs": [{"index": "0", "capacity": "…", "lock": {…}, "type": {…} | null, "data": "0x…"}],
        "witnesses": ["0x…"]}]}
  ]
}
```

* All integers are decimal strings. Hashes and hex may be any case in the dump
  (they are lower-cased), but scripts must use lowercase hex.
* Development chains are fully data-driven. The script registry (secp256k1,
  the DAO type, Omnilock, PW Lock) comes from `network`; `secp256k1` and `dao`
  are required, and `omnilock` and `pw_lock` may be omitted or `null`, which
  disables those owner types.
* Mainnet and testnet use fixed registries taken from CCC (docs/13 §4 item 16).
  Missing templates are filled in, and a declared template that differs is
  rejected as an override.
* `hrp` is optional: it is derived from the genesis hash (`ckb` for mainnet,
  `ckt` otherwise, per docs/13 §4.7) and rejected if it contradicts that.
* The history must start at the genesis block (`number` 0, `hash` equal to
  `network.genesis_hash`) and be parent-continuous (docs/03 §9).
* `clock_ms` is clock(b) of docs/03 §8, the parent's median time. You can supply
  the raw header `timestamp_ms` instead. The verifier then computes clock(b)
  itself as the median of the timestamps of parent(b) and its ancestors (37
  blocks, or `network.median_time_block_count`), sorted, at index `len/2`
  (docs/13 §4.9). When a block has both fields they must agree, or the input is
  rejected.
* Transactions may be "reduced" (only relevant outputs). Output `index` defaults
  to the array position and must be increasing. `witnesses` defaults to `[]`.
* `process_publication_delay_ms` defaults to 72 h. `initial_roles_hash` is the
  deployment parameter of docs/03 §3.1.

## Output (`replay`)

```json
{
  "verifier": "omavote-verifier-ts/0.1.0",
  "network": {...}, "tip": {"number", "hash"},
  "roles": {"initial_roles_hash", "current_roles_hash", "history": [...]},
  "polls": [{
    "poll_id", "status",                 // CLOSED | OPEN | NOT_STARTED | LATE_MANIFEST | DATA_INCOMPLETE
    "result_core", "result_hash",        // null unless closed and not LATE_MANIFEST
    "admission",                         // ADMITTED | REJECTED | RECORD_CONFLICT | LATE | MISSING | PENDING
    "attestation",                       // CONFIRMED | DISPUTED | NONE | UNVERIFIED
    "governance_status",                 // HOLD_EXECUTION | CLEARED | VOIDED | null
    "formal",                            // admission ADMITTED && not late && proposer eligible
    "proposer_check", "manifest_block", "start_boundary_block", "close_block", "confirmations",
    "owners_evidence",                   // authority, grant/ballot anchor heights, barrier exclusions
    "records": {"notices", "executions"},
    "diagnostics": [...]                 // this poll's diagnostics plus the global ones
  }],
  "diagnostics": [{"height", "kind", "id", "code"}]
}
```

`result_core` and `result_hash = H("OMAVOTE/RESULT/V2\0" || JCS(result_core))`
follow docs/03 §11. The field names come from `vectors/replay.json`. Diagnostics
list rejected or ineffective appearances in chain order. The codes are documented
in `src/diagnostics.ts` and SPEC-NOTES §6.

## Source layout

| File | Responsibility |
|---|---|
| `src/json.ts` | strict JSON parser (no numbers, duplicate keys, lone surrogates, raw control chars, BOM, depth > 32 per docs/13 §4 item 21) and RFC 8785 JCS |
| `src/hash.ts` | CKB Blake2b (CCC), `H(prefix \|\| 0x00 \|\| data)` identifiers, payload hash, blake160 |
| `src/molecule.ts` | script JSON, Molecule serialization, script hash, full addresses (CCC) |
| `src/network.ts` | network registry from the input |
| `src/schema.ts` | strict schemas: manifest, rules_profile, auth_registry, auth_policy, key descriptors, ballot, control, process roles/records |
| `src/text.ts` | the four signing texts and their first-line summaries; CKB amount and UTC rendering |
| `src/adapter.ts` | `ckb-secp256k1-message-v1` (Neuron) and `evm-personal-message-v1` (EIP-191) recovery; owner matching (secp256k1_blake160, Omnilock plain EVM mode, PW Lock); key matching; EIP-55 |
| `src/carrier.ts` | 78-byte header, payload hash and canonical-JCS check, batch framing and limits (32 KiB / 8 KiB / 1–128 envelopes, docs/13 §4 item 21) |
| `src/engine.ts` | replay state machine: DAO deposits, policies, control streams and barriers, manifests, ballots, roles and records |
| `src/tally.ts` | per-owner final selection, `result_core`, `result_hash`, admission, attestation and governance views |
| `src/replay.ts` | report assembly |
| `src/vectors.ts` | vector checkers (shared by the CLI and the tests) |
| `src/cli.ts` | CLI |
| `test/builder.ts` | synthetic chain builder that signs with deterministic test keys |
| `test/*.test.ts` | vectors (every `vectors/*.json`, with any `replay*.json` run as a full replay), JSON/JCS, texts, adapters, carrier, manifest, scenarios (docs/11 §8), process records, docs/13 §4 items 10–21, input, CLI |

## Scope and limits

* `webauthn-es256-v2` and `omavote-webauthn-v2` are not implemented, because
  they are an independent PoC per docs/03 §5.1. A ballot on that path is
  reported as `UNSUPPORTED_ADAPTER` and marks its poll `DATA_INCOMPLETE`.
* Transaction-authorization ballots (docs/03 §5.2) are not part of the first
  release and are not implemented.
* Reorgs are the dumper's job: the input must be one canonical chain view.
* Content availability (`CONTENT_UNAVAILABLE`) is off-chain and not checked.
* `npm audit` reports low-severity advisories for `elliptic`, which CCC pulls
  in through `@joyid/ckb`. The verifier never calls it: all secp256k1 recovery
  goes through `@noble/curves`.
* `check-vectors` treats an unknown vector file, or an unknown section of
  `external.json`, as a failure, so new vectors cannot pass unchecked.
