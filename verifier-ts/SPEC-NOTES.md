# SPEC-NOTES: decisions made while implementing the TS verifier

This file is for the human audit. It lists every place where `docs/` was
silent, ambiguous or contradictory, where I had to consult a vector to decide,
and where a decision came from outside the docs. For each item it names the doc
section, the choice made and its source.

Normative sources: `docs/03-protocol.md` and `docs/11-authorization.md`, with
the encoding details of `docs/13-technical-plan.md` §4. §4 now has items 1–22;
items 9–22 were added during implementation and are to be merged into 03 when
V2 freezes. Context: `docs/04`, `docs/09` §9–11, `docs/12`, `docs/14`.

**Tags**
- **SPEC**: now fixed by the docs; the cited item is the authority.
- **SILENT**: the docs do not say.
- **AMBIG**: the docs can be read more than one way.
- **VECTOR**: decided by reading a vector.
- **COORD**: decided by the coordinating agent, not by the docs.
- **CHOICE**: my own decision.

**Independence statement.**

* I read only `docs/*.md` (including the new `docs/14`), `vectors/*.json`, the
  repository-root `.gitignore`, and the sources of my own npm dependencies in
  `verifier-ts/node_modules` (CCC, noble).
* I did not open `crates/`, `web/`, `research/`, `schemas/`, `target/`,
  `devnet/` or any `.rs` file, and I did not run cargo.
* Outside input came from the coordinator's messages, in three rounds:
  1. High-S handling, confirmation of the Neuron and EIP-191 digests, and the
     new `external.json`.
  2. The devnet differential result: all 6 polls agree. It also brought the
     Omnilock 0x12 rule, `replay-edge.json` and the ZERO_FINAL_WEIGHT ordering.
  3. The note that 13 §4 item 21 fixes the parse limits.

  The rules from rounds 2 and 3 are now written in the docs and are cited below
  as SPEC.

---

## 0. Status of the points flagged in the first round

| # | Topic | Status now |
|---|---|---|
| 1 | `result_core` schema | **SPEC** (13 §4 item 14). Confirmed further by `replay-edge.json`: `final_status` is spelled `CANCEL`, a direct CANCEL keeps its `ballot_id`, and CONFLICT and CANCELLED_BY_CONTROL rows have null IDs. Still unverified: whether a *delegate* CANCEL keeps `authorization_id` (§8.4). |
| 2 | Omnilock "plain EVM mode" | **SPEC** (03 §5.1, 13 §4 item 19). Auth flag `0x01` or `0x12`, flags byte `0x00`, exactly 22 bytes. |
| 3 | rules_profile tokens and `proposer_min_deposit_shannon` | The key is **SPEC** (13 §4 item 10) and now required. The string values are still taken from the vectors (§2.1). |
| 4 | Parse limits that change counts | **SPEC** (13 §4 item 21). Depth, u64, 32 KiB, 8 KiB and count are all fixed. I had to change one thing: empty batches are now invalid (§9.3). |
| 5 | Diagnostic codes and check order | Still mostly **CHOICE** (§6). Fixed by vectors or docs: `NO_ACTIVE_GRANT` (vector), and `ZERO_FINAL_WEIGHT` with its shape and order (13 §4 item 20 and `replay-edge.json`). |
| 6 | Proposer eligibility vs `admission` | Unchanged **CHOICE**: eligibility is reported separately and folded into `formal` (§2.3). 13 §4 item 10 now fixes when the check happens. |
| 7 | High-S signatures | **SPEC** (13 §4 item 15). |

Behaviour changed in this round to follow the updated docs:

| Change | Spec | Section |
|---|---|---|
| EVM owners on Omnilock auth flag `0x12` are now accepted | 03 §5.1, 13 §4 item 19 | §3.3 |
| `proposer_min_deposit_shannon` is now required | 13 §4 item 10 | §2.1 |
| A manifest now needs its policy published at a strictly earlier position (`POLICY_UNKNOWN`) | 13 §4 item 11 | §2.4 |
| A ballot anchor below the manifest's registration height is now rejected (`ANCHOR_INVALID`) | 13 §4 item 11 | §5.1 |
| RECORD_CONFLICT is now decided by a different `detail` at the same anchor, not by a different record_id | 13 §4 item 12 | §7.5, §7.6 |
| A kind-3 payload may be any canonical JSON value | 13 §4 item 13 | §9.5 |
| An empty batch is now invalid (`EMPTY_BATCH`) | 13 §4 item 21 | §9.3 |
| Mainnet and testnet use fixed script registries from CCC and reject overrides | 13 §4 item 16 | §10.3 |

No vector result disagrees with my reading of the docs (§11).

---

## 1. Encoding and identifiers

1.1 **Domain-separation prefix (VECTOR; 03 §2).** The formulas write
`H("OMAVOTE/POLL/V2\0" || …)`. It is unclear whether `\0` means a NUL byte or
the two characters `\` and `0`. `vectors/encoding.json` → `domain_hash` stores
the prefix as the JSON string `"OMAVOTE/BALLOT/V2\\0"`, a literal backslash-zero.
Its hash matches only if `\0` is a single `0x00` byte. I implemented
`H(utf8(prefix) || 0x00 || data)` for every ID. The vector checker strips the
literal `\0` and appends the NUL byte.

1.2 **JSON depth (SPEC; 13 §4 item 21).**
- The top-level container is depth 1; objects and arrays together may nest at most 32 levels; scalars add no depth.
- Anything deeper makes the whole witness payload invalid (`MALFORMED_PAYLOAD`).
- This was my original choice. The docs now fix it, and the Rust side was aligned to it.
- The replay *input file* (not protocol data) is parsed with a limit of 64.

1.3 **Integers (SPEC; 13 §4 item 21).** Every protocol decimal is canonical
(`0`, or no leading zero; no sign, exponent or fraction) and within u64.

1.4 **Lowercase hex everywhere (AMBIG; 03 §2).** The docs mandate lowercase for
hashes and script args. I apply it to every hex field, including nonces,
signatures, public keys and EVM addresses. A descriptor's EVM `address` must be
lowercase, even though it is displayed in EIP-55 form.

1.5 **Unknown keys (AMBIG; 03 §2 "未知关键字段…全部拒绝", "unknown key fields … all rejected").** Any unknown key in
any protocol object, envelope, proof or payload is rejected.
`proposer_min_deposit_shannon` is now a regular rules_profile key (13 §4 item
10), so no exception is left.

1.6 **Strings (03 §2).**
- Rejected: lone surrogates, whether escaped or raw.
- Accepted: any other code point, including noncharacters such as U+FFFE.
- Keys are compared for duplicates after unescaping, so `"a"` and `"a"` (an escaped `a`) are duplicates.

1.7 **JCS (03 §2).** Keys are sorted by UTF-16 code units, which the vector
confirms with `ﬁ` vs `😀`. Strings are escaped like ECMAScript `JSON.stringify`.
Numbers never occur.

## 2. Manifest, rules_profile, registry, policy

2.1 **rules_profile (13 §4 items 2 and 10; VECTOR for the tokens).** The key
set is 13 §4 item 2 plus `proposer_min_deposit_shannon` (item 10). That key is
**required**; until this round I accepted its absence. The docs still give the
string values only in prose, so the accepted tokens come from
`vectors/messages.json`:
- `profile=omavote-ckb-community-fund-v2`
- `asset=nervos-dao-deposit`
- `amount=raw-capacity-principal`
- `weight_time=final-accepted-block-state`
- `withdraw_phase1=excluded`
- `cast_eligibility=positive-deposit-at-valid-inclusion`
- `revote=direct-priority-latest-anchor`
- `authorization=term-limited-max-365-chain-days`
- `cancel=exclude-both-sides-and-quorum`
- `precision=exact-shannon`
- `choices=["YES","NO","CANCEL"]`
- `threshold_comparison ∈ {inclusive, strict}`

Any other value gives `UNSUPPORTED_RULES`.

2.2 **Numeric rule parameters (AMBIG; 03 §4, §8).** I accept any canonical
values and implement the generic formulas, with these checks:
- the approval fraction must satisfy `0 ≤ num ≤ den` with `den > 0`;
- `voting_period_ms > 0`;
- `delegate_cutoff_ms ≤ voting_period_ms`;
- `end_ms − start_ms = voting_period_ms`.

The auth_policy's `max_term_ms` and `max_control_publication_delay_ms` are
pinned to the 11 §2 constants (365 days and 24 h).

2.3 **Proposer eligibility and formal status (AMBIG; 03 §3, 13 §4 item 10).**
- The check is now SPEC: the sum of the proposers' active deposits after the manifest's transaction, compared with `proposer_min_deposit_shannon`.
- It is reported as `proposer_check` and folded into `formal`.
- It does **not** change `admission`, which stays the record-derived view that both replay vectors expect.
- The optional "re-check at opening" in 03 §3 is not implemented.

2.4 **Policy before manifest (SPEC; 13 §4 item 11, changed this round).** The
authorization_policy must be published by a kind-4 carrier at a strictly
earlier position than any manifest or control that references it. Otherwise:
- the manifest is rejected with `POLICY_UNKNOWN` (code is my choice), and a later publication after the policy registers it;
- the control is rejected with `POLICY_UNKNOWN`.

A manifest output placed before the policy output *in the same transaction* is
too early. Policy objects embedded in manifests never count as publication.
This replaces my earlier reading, which did not require a prior policy for
manifests.

2.5 **Nullable and optional manifest fields (SILENT, VECTOR; 03 §3, 13 §4 item 1).**
- `discussion_evidence_hash` and `payment_terms_hash` may be null.
- `content_hash` must be a hash.
- `title` must be non-empty.
- `content_locations` is an array of non-empty strings and may be empty.
- `forum_topic_id` and `forum_revision` are decimals.
- A `grant` proposal requires a non-null `recipient_lock_script` (03 §5 rule 3).
- A `meta_rule` proposal requires budget `"0"`, quorum base `"0"` and a null recipient.
- `quorum_base_shannon` is not forced to equal the budget (03 §3 allows a different authorised base).

2.6 **signature_formats (SILENT).** Non-empty, without duplicates, with values
from {`omavote-readable-v2`, `omavote-webauthn-v2`}. No ordering is required.

2.7 **auth_registry (13 §4 item 4, 03 §5.1).**
- "按字典序去重" ("deduplicated in lexicographic order") is enforced as strictly ascending input.
- `owner_adapters` ⊆ {`ckb-secp256k1-message-v1`, `evm-personal-message-v1`}.
- `key_adapters` additionally allows `webauthn-es256-v2`.
- An undefined ID gives `UNKNOWN_ADAPTER`.

2.8 **Proposer locks and proofs (03 §3, §3.1).**
- Locks: non-empty and strictly ascending by owner_id.
- Proofs: exactly one per lock, in the same order, signed with an `owner_adapters` adapter.
- Any failure rejects the publication. **b_m is the first valid inclusion**. A repeated valid publication gives `DUPLICATE`.

2.9 **signing_title whitespace (AMBIG; 03 §5 rule 2).** "无首尾空白" ("no leading or trailing whitespace") uses the
Unicode `White_Space` property. Length is counted in Unicode scalar values.

2.10 **LATE_MANIFEST (03 §3).** The test is `height(b_s) − height(b_m) <
opening_confirmations`. A late poll has no `result_core`. Its ballots are
rejected with `LATE_MANIFEST`, and one manifest-level `LATE_MANIFEST`
diagnostic is emitted where lateness is determined (CHOICE).

## 3. Signature adapters (03 §5.1, 11 §4.1, 13 §4 items 5, 15, 19, 22)

3.1 **High-S and digests (SPEC; 13 §4 item 15; originally COORD).**
- High-S is accepted for both adapters: recovery uses `(r, n−s, v⊕1)`.
- r and s must lie in [1, n−1].
- CKB `v` must be 0 or 1. EVM `v` may be 27, 28, 0 or 1 (item 5).
- Neuron digest: `blake2b_ckb(utf8("Nervos Message:" + text))`.
- EIP-191 digest: `keccak256(0x19 "Ethereum Signed Message:\n" len bytes)` over the UTF-8 bytes. Item 22, the MetaMask hex encoding, changes how the frontend calls the wallet, not the signed bytes.
- Recovery uses `@noble/curves`, because CCC's verify helper rejects high-S.

3.2 **CKB owner matching.** The script must be the network's `secp256k1`
template, with exactly that code_hash and hash_type, and
`args == blake160(compressed key)`, exactly 20 bytes.

3.3 **Omnilock plain EVM mode (SPEC; 03 §5.1, 13 §4 item 19, changed this round).**
- The script must be the network's `omnilock` template with args exactly 22 bytes: `auth_flag ‖ eth_address ‖ 0x00`.
- `auth_flag` must be `0x01` (Ethereum) or `0x12` (Ethereum-displaying).
- Rejected: any other auth flag, a non-zero flags byte (admin list, ACP, time-lock, supply), and any other length.
- `replay-edge.json` contains a `0x12` owner who is also the proposer.

3.4 **PW Lock.** The script must be the network's `pw_lock` template with
`args == addr20`.

3.5 **Code semantics (CHOICE).**
- `INVALID_SIGNATURE`: a malformed or unrecoverable signature, or a key-role signature that does not recover to the descriptor key.
- `WRONG_OWNER`: recovery worked but the identity does not control the owner lock, or a delegate ballot names another owner's grant.

3.6 **Key descriptors (11 §4.1).**
- A secp256k1 `public_key` must be a valid compressed point (SILENT: the docs say "33 字节压缩点", "33-byte compressed point").
- An EVM address must be lowercase.
- `webauthn_es256` is validated only structurally.

3.7 **webauthn path not implemented (03 §5.1 "独立 PoC", "separate PoC").** A delegate ballot
on that path that passes every other check is reported as `UNSUPPORTED_ADAPTER`,
and the poll is marked `DATA_INCOMPLETE`. Mismatched format/key combinations
give `FORMAT_NOT_ACCEPTED`.

## 4. Authorization controls (11 §2–§5, 13 §4 item 11)

4.1 **Check order (11 §5).**
1. schema and network
2. batch scope
3. `owner_auth_adapter` in the global control-format set (`ADAPTER_NOT_ACCEPTED`)
4. owner signature
5. policy published earlier (`POLICY_UNKNOWN`)
6. anchor is a canonical block with a strictly lower height (`ANCHOR_INVALID`)
7. deadline equals `clock(anchor) + 24 h` (`DEADLINE_MISMATCH`; SPEC, item 11), then `T_anchor ≤ clock < deadline` (`PUBLICATION_EXPIRED`)
8. GRANT only: `0 < expires − T_anchor ≤ max_term` (`EXPIRY_INVALID`), then `clock < expires` (`GRANT_EXPIRED`)
9. `DUPLICATE`
10. stream update

4.2 **"有效区间上界不含等号" ("the upper bound of the valid interval is exclusive"; AMBIG; 11 §2).** Read as the grant's usable
interval: a ballot with clock equal to `expires_at_ms` is `GRANT_EXPIRED`.

4.3 **Unknown control formats (11 §5).** An ID that was never defined is
invalid (`ADAPTER_NOT_ACCEPTED`). `webauthn-es256-v2` is not in the
control-format set.

4.4 **State machine (11 §5 table).**
- Lower anchor: `STALE_AUTHORIZATION`, emitted as a diagnostic, no effect.
- Same anchor, different body: `AUTH_CONFLICT`, emitted as a diagnostic. State becomes CONFLICT and a barrier is set.
- Same body: same id, so `DUPLICATE`.
- Higher anchor: replaces the current control. `STOP_AND_CANCEL_OPEN` sets a barrier.

4.5 **Barriers.** A barrier at position P with clock c applies to polls with
`start_ms ≤ c < end_ms`. It excludes that owner's delegate ballots positioned
before P. Direct ballots are untouched.

## 5. Ballots and final selection (03 §5–§6, 11 §6)

5.1 **Check order (CHOICE where silent).**
1. schema, network, scope
2. `UNKNOWN_POLL`
3. `LATE_MANIFEST`
4. `RULES_MISMATCH`
5. `FORMAT_NOT_ACCEPTED`
6. proof shape
7. adapter and signature: direct ballots (`ADAPTER_NOT_ACCEPTED`, `INVALID_SIGNATURE` / `WRONG_OWNER`); delegate ballots (`NO_ACTIVE_GRANT`, `WRONG_OWNER`, `WRONG_KEY`, `ADAPTER_NOT_ACCEPTED`, `INVALID_SIGNATURE`)
8. window, and delegate cutoff (`OUT_OF_WINDOW`)
9. anchor: a canonical block strictly below the inclusion block, **and not below the manifest's registration height b_m** (SPEC, 13 §4 item 11, new this round). Both failures give `ANCHOR_INVALID`; the code for the second is my choice.
10. `NO_DEPOSIT_AT_CAST`
11. delegate only: current grant (`NO_ACTIVE_GRANT`, VECTOR), then not expired (`GRANT_EXPIRED`)
12. `DUPLICATE`

5.2 **NO_ACTIVE_GRANT (VECTOR).** The vector uses it after a STOP_ONLY revoke.
I also use it when the grant is unknown, not a GRANT, under another policy,
superseded, or in conflict.

5.3 **Selection.**
- Direct layer: the highest anchor wins; different ballot_ids at that anchor give `CONFLICT`.
- Otherwise the delegate layer: barrier-excluded ballots are dropped, the rest are compared by `(grant anchor height, ballot anchor height)`, different ballot_ids at the maximum give `CONFLICT`, and an empty set gives `CANCELLED_BY_CONTROL`.
- `replay-edge.json` has a direct same-anchor CONFLICT and a barrier-only owner.

5.4 **Same-transaction ordering (03 §8).** Inputs, then outputs (DAO), then
carriers in `(output_index, envelope_index)` order. A ballot before its grant
gets `NO_ACTIVE_GRANT`. 13 §4 item 17 (relay layout) puts policies and grants
before the messages that depend on them.

## 6. Diagnostics

6.1 **Shape (VECTOR).** `{height, kind, id, code}`. `--verbose` adds
`position` and `message`.

6.2 **`kind` and `id` (CHOICE).**
- For protocol objects, `kind` is the message_kind and `id` is the object's ID, computed from the raw body even when invalid.
- For framing failures (including `EMPTY_BATCH` and `BATCH_TOO_LARGE`), `kind` is `carrier` and `id` is the transaction hash.
- For tally notes, `kind` is `owner` and `id` is the owner_id.

6.3 **ZERO_FINAL_WEIGHT (SPEC; 13 §4 item 20, matches `replay-edge.json`).**
For each owner whose selected YES or NO has zero principal at H_close:
`{height: close_block_number, kind: "owner", id: owner_id, code: "ZERO_FINAL_WEIGHT"}`.
These follow all engine diagnostics, in owner_id order, and are not part of
`result_core`. My output already had this shape and order, so no change was
needed.

6.4 **What is listed (VECTOR + CHOICE).** Per-appearance outcomes only, in
canonical position order:
- rejections;
- `DUPLICATE`;
- `STALE_AUTHORIZATION`;
- `AUTH_CONFLICT`;
- `RECORD_CONFLICT`;
- `LATE_MANIFEST`;
- then the tally notes.

Valid ballots that lose in the final selection are **not** diagnostics. Both
replay vectors confirm this (barrier-excluded and conflicting ballots are not
listed). The 03 §11 codes `SUPERSEDED` and `CANCELLED` are therefore not
emitted.

6.5 **Per-poll output (CHOICE).** `--poll X` lists diagnostics of poll X plus
untagged ones (controls, policies, roles, carriers without a poll scope).

6.6 **Codes not named in the docs.** `NO_ACTIVE_GRANT` (vector) and these of mine:
- `GRANT_EXPIRED`, `WRONG_KEY`, `UNKNOWN_POLL`, `RULES_MISMATCH`
- `FORMAT_NOT_ACCEPTED`, `UNSUPPORTED_FORMAT`, `UNSUPPORTED_ADAPTER`
- `POLICY_UNKNOWN`, `DEADLINE_MISMATCH`, `PUBLICATION_EXPIRED`, `EXPIRY_INVALID`
- `ROLES_NOT_EFFECTIVE`, `ROLES_UNAVAILABLE`, `ROLES_CHAIN_MISMATCH`, `INSUFFICIENT_SIGNATURES`
- `SCOPE_MISMATCH`, `WRONG_NETWORK`, `MALFORMED`, `HASH_MISMATCH`, `UNSUPPORTED_RULES`, `UNKNOWN_ADAPTER`
- carrier codes: `CARRIER_MALFORMED`, `UNSUPPORTED_VERSION`, `UNKNOWN_KIND`, `WITNESS_MISSING`, `PAYLOAD_TOO_LARGE`, `PAYLOAD_HASH_MISMATCH`, `MALFORMED_PAYLOAD`, `PAYLOAD_NOT_CANONICAL`, `BATCH_TOO_LARGE`, `EMPTY_BATCH`, `ENVELOPE_TOO_LARGE`

## 7. Process roles and records (03 §3.1, 13 §4 items 11–12)

7.1 **Roles object.**
- Exact keys; `committee` and `coordinator` are both required.
- Members are strictly ascending by key_id.
- `1 ≤ threshold ≤ members`.

7.2 **Record validity.**
- schema: role/type table per 13 §4 item 12 (ADMISSION by the coordinator, NOTICE by either role, the rest by the committee); `poll_id` required except for ROLES_UPDATE, where it is null
- network and scope
- `roles_hash == current` (`ROLES_NOT_EFFECTIVE`), and the roles object is published (`ROLES_UNAVAILABLE`)
- anchor strictly below inclusion; deadline equal to `clock(anchor) + process_publication_delay_ms` (SPEC, item 11); window `T_anchor ≤ clock < deadline`
- threshold of distinct valid member signatures (`INSUFFICIENT_SIGNATURES`)
- ROLES_UPDATE checks (`ROLES_UNAVAILABLE` / `ROLES_CHAIN_MISMATCH`)
- `DUPLICATE`

Proofs:
- A malformed proof entry makes the record `MALFORMED` (CHOICE).
- Non-members, invalid signatures and repeated signers are ignored.

7.3 **Initial roles (SPEC; 13 §4 item 12).** They take effect when the object
with `initial_roles_hash` is published. Before that, records are rejected with
`ROLES_UNAVAILABLE`.

7.4 **Records for unregistered polls (SILENT).** Accepted and stored by poll_id.

7.5 **Views (CHOICE in naming).**
- **Conflict rule (SPEC; 13 §4 item 12, changed this round).** At the highest anchor, a conflict means different `detail` values. Records that differ only in nonce or evidence hash are not in conflict.
- `admission`: the highest anchor among valid ADMISSION records with `height(b_s) − height(inclusion) ≥ opening_confirmations`. Values: `ADMITTED`, `REJECTED`, `RECORD_CONFLICT`, `LATE` (valid records exist but none qualifies), `MISSING`, or `PENDING` before b_s.
- `attestation`: `CONFIRMED` only if `result_hash` and `outcome` both match my recomputation. Otherwise `DISPUTED` (also on conflict), `NONE` without a record, `UNVERIFIED` without a recomputed result.
- `governance_status`: the highest anchor. A conflict shows `HOLD_EXECUTION`; no record gives `null`.

7.6 **RECORD_CONFLICT diagnostic (CHOICE in timing).** Emitted when a valid
record arrives with the same (poll, type) and anchor height as an earlier valid
record but a different `detail` (SPEC criterion). Before this round I compared
record_ids.

## 8. Tally and `result_core` (03 §11, 13 §4 items 14 and 20)

8.1 **Schema (SPEC; 13 §4 item 14).** The fields are as listed in item 14,
first taken from `vectors/replay.json` and now documented. 13 §4 item 14 also
cites `schemas/omavote-v2.schema.json`. I did not read that file: `schemas/` is
outside the directories I may read.

8.2 **Boundary blocks (VECTOR, consistent with 13 §4 item 14).**
- `start_boundary_block_hash` is b_s, the first block with `clock ≥ start_ms`.
- `close_block_hash` and `close_block_number` are H_close.

8.3 **`final_status` (VECTOR: `replay-edge.json`).** `YES`, `NO`, `CANCEL`,
`CONFLICT` and `CANCELLED_BY_CONTROL`. The `CANCEL` spelling, previously
unverified, is confirmed.

8.4 **IDs.**
- A selected CANCEL keeps its `ballot_id`; the vector confirms this for a direct CANCEL.
- For a **delegate** CANCEL I also keep `authorization_id`. No vector covers that case yet (AMBIG, "选中的 CANCEL 保留该票 ID", "a selected CANCEL keeps that ballot's ID").
- CONFLICT and CANCELLED_BY_CONTROL rows have null IDs (confirmed).

8.5 **Amounts.**
- `eligible_principal_shannon` is the H_close principal, for every row.
- `counted_weight_shannon` equals it for YES/NO and is 0 otherwise.
- `counted_cells` holds only YES/NO owners' outpoints, sorted by raw tx_hash and then index.
- Outcome: `Q > 0 ∧ Q ≥ quorum ∧ den·Y ≥ num·Q`, with only the last comparison becoming `>` under `strict`.
- `replay-edge.json` has a selected YES whose deposit was withdrawn before the close: the row keeps YES, its weight is 0, and a `ZERO_FINAL_WEIGHT` note is emitted.

8.6 **When a result exists (SILENT).** As soon as H_close is known, whatever
the confirmation depth. `confirmations` is reported next to it.

8.7 **Status values (CHOICE).** `CLOSED`, `OPEN`, `NOT_STARTED`,
`LATE_MANIFEST` and `DATA_INCOMPLETE`. These are verifier-level summaries. The
API states listed in 13 §7 (ANNOUNCED … FINALIZED_BY_POLICY, PROVISIONAL) also
need confirmation depth, review windows and execution data, which a replay does
not model.

## 9. Carrier (03 §7, 13 §4 items 13, 17, 21)

9.1 **Detection.** 78 bytes starting with `OMAVOTE\0`. Other data that starts
with the magic gives `CARRIER_MALFORMED` (CHOICE; 13 §5 only says such data is
not a carrier).

9.2 **Order of checks.**
1. version
2. kind
3. witness index exists
4. size ≤ 32768 raw bytes (SPEC, item 21; the whole carrier is invalid otherwise)
5. payload hash
6. strict UTF-8 and JSON (depth per item 21)
7. canonical JCS (SPEC, item 13; `PAYLOAD_NOT_CANONICAL`)

9.3 **Batch limits (SPEC; 13 §4 item 21).**
- An envelope larger than 8 KiB, measured on `JCS(envelope)`, is rejected alone (`ENVELOPE_TOO_LARGE`).
- More than 128 envelopes rejects the batch (`BATCH_TOO_LARGE`).
- **An empty batch is invalid** (`EMPTY_BATCH`). It is a diagnostic only, with no effect on results. This changed this round; I used to accept empty batches silently. The code name is my choice.

9.4 **process_batch framing (VECTOR).** `{"protocol_version":"2","envelopes":[…]}`.

9.5 **kind 3 result_record (SPEC; 13 §4 item 13, changed this round).** Any
JSON value is allowed, including arrays and strings, but it must be canonical
JCS. It is non-authoritative and is ignored after the framing checks. I used to
require an object.

9.6 **Scope rules.** A body whose poll_id or policy differs from the batch scope
gets `SCOPE_MISMATCH` for that envelope. Single-object kinds (1, 4, 6) whose
hash differs from scope_id are rejected.

## 10. Replay input, clock and network

10.1 **`clock_ms` is clock(b) (VECTOR; 13 §4 item 9).**
- Optionally, `timestamp_ms` lets the verifier compute the median itself: 37 blocks, index len/2, from the parent backwards. Any supplied `clock_ms` is then cross-checked.
- `clock(genesis)` is the genesis block's own timestamp (SPEC, item 9).

10.2 **Genesis.** Replays must start at genesis (03 §9 strict mode). The
accelerated `--from-height` mode that the Rust verifier added (13 §5) is not
implemented. The TS verifier always replays the full history.

10.3 **Network registry (13 §4 items 7 and 16; changed this round).**
- hrp: `ckb` for the mainnet genesis, `ckt` otherwise. A contradicting input `hrp` is rejected.
- **Mainnet and testnet** use fixed registries for secp256k1, DAO, Omnilock and PW Lock, taken from CCC's `MAINNET_SCRIPTS` / `TESTNET_SCRIPTS`. Missing templates are filled in; a declared template that differs is rejected as an override.
- **Development chains** declare their templates in the input. `secp256k1` and `dao` are required; Omnilock and PW Lock are optional.
- The two genesis constants that pick the fixed registries come from my own knowledge of CKB, not from docs/, vectors/ or CCC:
  - mainnet Lina `0x92b197aa…d0e5`
  - testnet Pudge `0x10639e08…9606`

  Their only effect is to select those registries and the hrp. If either were wrong, inputs for that network would be rejected loudly; nothing would pass silently.

10.4 **DAO deposits (03 §9).** The type equals the network's DAO template with
args `0x`, and the data is exactly 8 zero bytes. Phase-1 withdrawals carry
non-zero data, as `replay-edge.json` shows, and are excluded.

## 11. Vector review

All 8 vector files pass every check (`check-vectors`: 125 of 125). Both replays
reproduce `expected` byte for byte, including `result_hash`. Observations:

- `replay-edge.json` confirms these spellings and shapes:
  - `CANCEL`, direct CANCEL keeping its ballot_id, CONFLICT, CANCELLED_BY_CONTROL;
  - the 0x12 Omnilock proposer and voter;
  - ZERO_FINAL_WEIGHT after a phase-1 withdrawal.

  It lists no other diagnostics, which is consistent with §6.4.
- The other vector files were regenerated (new timestamps). They still pass
  with the same check counts.
- `docs/14` now exists. It records the devnet differential: the only
  difference was my ZERO_FINAL_WEIGHT note, which Rust now also emits (13 §4
  item 20).
- The stale ballot-ordering sentence in `docs/07` (line 127) is being fixed by
  the coordinator.
- I found nothing where I believe a vector contradicts the docs.

## 12. Not implemented

- `webauthn-es256-v2` and `omavote-webauthn-v2` verification.
- Transaction-authorization ballots (03 §5.2).
- Accelerated replay from a height (13 §5).
- Reorg handling inside a replay: the input is one canonical view.
- Content availability.
- Relay receipts (13 §4 item 18): not protocol data.
- Activation heights for future control formats.
