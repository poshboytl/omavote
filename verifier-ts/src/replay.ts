/** Runs the engine and assembles the JSON report printed by `cli.js replay`. */
import { publicDiagnostic, type Diagnostic } from "./diagnostics.js";
import { ReplayEngine, type BlockRef, type PollState } from "./engine.js";
import { toJsonValue, type JsonObject, type JsonValue } from "./json.js";
import type { ReplayInput } from "./replay-input.js";
import { admissionView, attestationView, computeResult, displayRecords, governanceView, type PollResult } from "./tally.js";

export const VERIFIER_ID = "omavote-verifier-ts/0.1.0";

export interface ReportOptions {
  pollId?: string;
  verbose?: boolean;
}

function blockJson(b: BlockRef | null): JsonValue {
  return b === null ? null : toJsonValue({ number: String(b.number), hash: b.hash });
}

export interface PollReport {
  pollId: string;
  status: string;
  result: PollResult | null;
  json: JsonObject;
}

export function pollStatus(poll: PollState): string {
  if (poll.late) return "LATE_MANIFEST";
  if (poll.startBlock === null) return "NOT_STARTED";
  if (poll.closeBlock === null) return "OPEN";
  if (poll.unsupportedSeen) return "DATA_INCOMPLETE";
  return "CLOSED";
}

function diagnosticsFor(all: Diagnostic[], pollId: string | undefined, verbose: boolean): JsonValue {
  const list = pollId === undefined ? all : all.filter((d) => d.pollId === undefined || d.pollId === pollId);
  return toJsonValue(list.map((d) => publicDiagnostic(d, verbose)));
}

export function buildPollReport(engine: ReplayEngine, poll: PollState, verbose: boolean): PollReport {
  const m = poll.manifest;
  const status = pollStatus(poll);
  const result = !poll.late && poll.startBlock !== null && poll.closeBlock !== null ? computeResult(engine, poll) : null;
  const allDiagnostics = [...engine.diagnostics, ...(result?.notes ?? [])];
  const admission = admissionView(engine, poll);
  const required = m.rules.proposerMinDepositShannon;
  const proposerEligible = poll.proposerDeposit >= required;
  const tip = engine.tip as BlockRef;
  const json = toJsonValue({
    poll_id: m.pollId,
    status,
    result_core: result ? result.core : null,
    result_hash: result ? result.hash : null,
    admission,
    attestation: attestationView(engine, poll, result),
    governance_status: governanceView(engine, poll),
    formal: admission === "ADMITTED" && !poll.late && proposerEligible,
    proposer_check: {
      required_shannon: required.toString(),
      observed_shannon: poll.proposerDeposit.toString(),
      eligible: proposerEligible,
      check_block: blockJson(poll.manifestBlock),
    },
    manifest_block: blockJson(poll.manifestBlock),
    start_boundary_block: blockJson(poll.startBlock),
    close_block: blockJson(poll.closeBlock),
    confirmations: poll.closeBlock ? String(tip.number - poll.closeBlock.number) : null,
    owners_evidence: result
      ? result.selections.map((s) => ({
          owner_id: s.ownerId,
          final_status: s.status,
          authority: s.authority,
          ballot_id: s.ballot?.body.ballotId ?? null,
          authorization_id: s.ballot?.grant?.body.authorizationId ?? null,
          grant_anchor_height: s.ballot?.grant ? String(s.ballot.grant.anchorHeight) : null,
          ballot_anchor_height: s.ballot ? String(s.ballot.anchorHeight) : null,
          ballot_height: s.ballot ? String(s.ballot.position.height) : null,
          delegate_ballots_excluded_by_barrier: String(s.barrierExcluded),
        }))
      : null,
    records: displayRecords(engine, poll),
    diagnostics: diagnosticsFor(allDiagnostics, m.pollId, verbose),
  }) as JsonObject;
  return { pollId: m.pollId, status, result, json };
}

export function runReplay(input: ReplayInput): ReplayEngine {
  return new ReplayEngine(input).run();
}

/** Full report, or the single-poll report when `opts.pollId` is set (null if unknown). */
export function buildReport(engine: ReplayEngine, opts: ReportOptions = {}): JsonObject | null {
  const verbose = opts.verbose ?? false;
  if (opts.pollId !== undefined) {
    const poll = engine.polls.get(opts.pollId);
    return poll ? buildPollReport(engine, poll, verbose).json : null;
  }
  const polls = engine.pollOrder.map((id) => buildPollReport(engine, engine.polls.get(id) as PollState, verbose));
  const notes = polls.flatMap((p) => p.result?.notes ?? []);
  const tip = engine.tip;
  return toJsonValue({
    verifier: VERIFIER_ID,
    network: { name: engine.network.name, genesis_hash: engine.network.genesis_hash, hrp: engine.network.hrp },
    tip: blockJson(tip),
    roles: {
      initial_roles_hash: engine.rolesHistory[0]?.rolesHash ?? null,
      current_roles_hash: engine.currentRolesHash,
      history: engine.rolesHistory.map((h) => ({ roles_hash: h.rolesHash, from_height: h.fromHeight, record_id: h.recordId })),
    },
    polls: polls.map((p) => p.json),
    diagnostics: diagnosticsFor([...engine.diagnostics, ...notes], undefined, verbose),
  }) as JsonObject;
}
