/**
 * Final selection per owner, result_core / result_hash and the process views
 * (docs/03 §3.1, §4, §11; docs/11 §6).
 */
import { compareBytes, hexToBytes } from "./bytes.js";
import { comparePositions, type Diagnostic } from "./diagnostics.js";
import { DOMAIN, objectHash } from "./hash.js";
import { jcs, toJsonValue, type JsonObject, type JsonValue } from "./json.js";
import type { BallotRecord, BlockRef, PollState, RecordEntry, ReplayEngine } from "./engine.js";

export type FinalStatus = "YES" | "NO" | "CANCEL" | "CONFLICT" | "CANCELLED_BY_CONTROL";

export interface OwnerSelection {
  ownerId: string;
  status: FinalStatus;
  ballot: BallotRecord | null;
  authority: "owner" | "delegate" | null;
  /** Number of delegate ballots excluded by safe-revocation barriers. */
  barrierExcluded: number;
  eligible: bigint;
  counted: bigint;
}

function maxBy<T>(items: T[], key: (t: T) => number[]): T[] {
  let best: T[] = [];
  let bestKey: number[] | null = null;
  for (const it of items) {
    const k = key(it);
    let cmp = 0;
    if (bestKey !== null) {
      for (let i = 0; i < k.length && cmp === 0; i++) cmp = (k[i] as number) - (bestKey[i] as number);
    }
    if (bestKey === null || cmp > 0) {
      best = [it];
      bestKey = k;
    } else if (cmp === 0) {
      best.push(it);
    }
  }
  return best;
}

function decide(candidates: BallotRecord[], key: (b: BallotRecord) => number[]): { status: FinalStatus; ballot: BallotRecord | null } {
  const top = maxBy(candidates, key);
  const ids = new Set(top.map((b) => b.body.ballotId));
  if (ids.size > 1) return { status: "CONFLICT", ballot: null };
  const chosen = top[0] as BallotRecord;
  return { status: chosen.body.action, ballot: chosen };
}

/** docs/11 §6 steps 1–5 for one owner. */
export function selectOwner(engine: ReplayEngine, poll: PollState, ownerId: string): OwnerSelection {
  const m = poll.manifest;
  const eligible = poll.snapshot?.get(ownerId)?.total ?? 0n;
  const directs = poll.direct.get(ownerId) ?? [];
  let status: FinalStatus;
  let ballot: BallotRecord | null;
  let authority: "owner" | "delegate" | null = null;
  let barrierExcluded = 0;
  if (directs.length > 0) {
    ({ status, ballot } = decide(directs, (b) => [b.anchorHeight]));
    authority = "owner";
  } else {
    const delegates = poll.delegate.get(ownerId) ?? [];
    const stream = engine.streams.get(`${m.policyHash}|${ownerId}`);
    const barriers = (stream?.barriers ?? []).filter((x) => x.clockMs >= m.startMs && x.clockMs < m.endMs);
    const remaining = delegates.filter((b) => !barriers.some((x) => comparePositions(b.position, x.position) < 0));
    barrierExcluded = delegates.length - remaining.length;
    if (remaining.length === 0) {
      status = "CANCELLED_BY_CONTROL";
      ballot = null;
    } else {
      ({ status, ballot } = decide(remaining, (b) => [(b.grant as NonNullable<BallotRecord["grant"]>).anchorHeight, b.anchorHeight]));
      authority = "delegate";
    }
  }
  const counted = status === "YES" || status === "NO" ? eligible : 0n;
  return { ownerId, status, ballot, authority, barrierExcluded, eligible, counted };
}

export interface PollResult {
  core: JsonObject;
  hash: string;
  outcome: "PASS" | "FAIL";
  selections: OwnerSelection[];
  notes: Diagnostic[];
}

/** Builds result_core (field set and names follow vectors/replay.json, see SPEC-NOTES). */
export function computeResult(engine: ReplayEngine, poll: PollState): PollResult {
  const m = poll.manifest;
  const start = poll.startBlock as BlockRef;
  const close = poll.closeBlock as BlockRef;
  const owners = [...poll.owners].sort();
  const selections = owners.map((o) => selectOwner(engine, poll, o));
  let yes = 0n;
  let no = 0n;
  const cells: Array<{ txHash: string; index: number; ownerId: string; capacity: bigint }> = [];
  const notes: Diagnostic[] = [];
  for (const s of selections) {
    if (s.status === "YES") yes += s.counted;
    if (s.status === "NO") no += s.counted;
    if (s.status === "YES" || s.status === "NO") {
      for (const c of poll.snapshot?.get(s.ownerId)?.cells ?? []) cells.push({ txHash: c.txHash, index: c.index, ownerId: s.ownerId, capacity: c.capacity });
      if (s.eligible === 0n) {
        notes.push({ height: String(close.number), kind: "owner", id: s.ownerId, code: "ZERO_FINAL_WEIGHT", pollId: m.pollId, message: "selected YES/NO with zero final principal" });
      }
    }
  }
  cells.sort((a, b) => compareBytes(hexToBytes(a.txHash), hexToBytes(b.txHash)) || a.index - b.index);
  const q = yes + no;
  const rules = m.rules;
  const quorum = m.proposalType === "grant" ? rules.quorumGrantMultiplier * m.quorumBaseShannon : rules.quorumMetaRuleShannon;
  const approval = m.proposalType === "grant" ? rules.approvalGrant : rules.approvalMetaRule;
  const lhs = approval.denominator * yes;
  const rhs = approval.numerator * q;
  const approved = rules.thresholdComparison === "inclusive" ? lhs >= rhs : lhs > rhs;
  const outcome: "PASS" | "FAIL" = q > 0n && q >= quorum && approved ? "PASS" : "FAIL";
  const core = toJsonValue({
    protocol_version: "2",
    network_genesis_hash: m.genesisHash,
    poll_id: m.pollId,
    rules_hash: m.rulesHash,
    auth_policy_hash: m.policyHash,
    auth_registry_hash: m.registryHash,
    start_boundary_block_hash: start.hash,
    close_block_hash: close.hash,
    close_block_number: String(close.number),
    owners: selections.map((s) => ({
      owner_id: s.ownerId,
      final_status: s.status,
      ballot_id: s.ballot ? s.ballot.body.ballotId : null,
      authorization_id: s.ballot && s.ballot.grant ? s.ballot.grant.body.authorizationId : null,
      eligible_principal_shannon: s.eligible.toString(),
      counted_weight_shannon: s.counted.toString(),
    })),
    counted_cells: cells.map((c) => ({ tx_hash: c.txHash, index: String(c.index), owner_id: c.ownerId, capacity_shannon: c.capacity.toString() })),
    yes_shannon: yes.toString(),
    no_shannon: no.toString(),
    participation_shannon: q.toString(),
    quorum_required_shannon: quorum.toString(),
    approval_numerator: approval.numerator.toString(),
    approval_denominator: approval.denominator.toString(),
    threshold_comparison: rules.thresholdComparison,
    outcome,
  }) as JsonObject;
  return { core, hash: objectHash(DOMAIN.RESULT, core), outcome, selections, notes };
}

// ---------------------------------------------------------------------------
// process views (docs/03 §3.1 table)

function highest(entries: RecordEntry[]): RecordEntry[] {
  return maxBy(entries, (e) => [e.anchorHeight]);
}

/** Number of distinct details among records (docs/13 §4 item 12: conflict = different detail at the top anchor). */
function distinctDetails(entries: RecordEntry[]): number {
  return new Set(entries.map((e) => jcs(e.record.detail))).size;
}

/**
 * ADMISSION view: among valid ADMISSION records included at least
 * opening_confirmations blocks before b_s, the highest anchor wins.
 * Values: ADMITTED | REJECTED | RECORD_CONFLICT | LATE | MISSING | PENDING.
 */
export function admissionView(engine: ReplayEngine, poll: PollState): string {
  const all = engine.recordsOf(poll.manifest.pollId, "ADMISSION");
  if (poll.startBlock === null) return "PENDING";
  const sNum = BigInt(poll.startBlock.number);
  const qualifying = all.filter((e) => sNum - BigInt(e.position.height) >= poll.manifest.rules.openingConfirmations);
  if (qualifying.length === 0) return all.length > 0 ? "LATE" : "MISSING";
  const top = highest(qualifying);
  if (distinctDetails(top) > 1) return "RECORD_CONFLICT";
  return (top[0] as RecordEntry).record.summaryValue as string;
}

/**
 * RESULT_ATTESTATION view: the highest-anchor valid record confirms the
 * result only if result_hash and outcome both equal the recomputation.
 * Values: CONFIRMED | DISPUTED | NONE | UNVERIFIED (no recomputed result yet).
 */
export function attestationView(engine: ReplayEngine, poll: PollState, result: PollResult | null): string {
  const all = engine.recordsOf(poll.manifest.pollId, "RESULT_ATTESTATION");
  if (all.length === 0) return "NONE";
  const top = highest(all);
  if (distinctDetails(top) > 1) return "DISPUTED";
  if (result === null) return "UNVERIFIED";
  const d = (top[0] as RecordEntry).record.detail;
  return d["result_hash"] === result.hash && d["outcome"] === result.outcome ? "CONFIRMED" : "DISPUTED";
}

/** GOVERNANCE_STATUS view: highest anchor wins; a conflict displays HOLD_EXECUTION; null when absent. */
export function governanceView(engine: ReplayEngine, poll: PollState): string | null {
  const all = engine.recordsOf(poll.manifest.pollId, "GOVERNANCE_STATUS");
  if (all.length === 0) return null;
  const top = highest(all);
  if (distinctDetails(top) > 1) return "HOLD_EXECUTION";
  return (top[0] as RecordEntry).record.summaryValue;
}

export function displayRecords(engine: ReplayEngine, poll: PollState): JsonValue {
  const pick = (type: "NOTICE" | "EXECUTION") =>
    engine.recordsOf(poll.manifest.pollId, type).map((e) => ({
      record_id: e.record.recordId,
      role: e.record.role,
      detail: e.record.detail,
      height: String(e.position.height),
    }));
  return toJsonValue({ notices: pick("NOTICE"), executions: pick("EXECUTION") });
}
