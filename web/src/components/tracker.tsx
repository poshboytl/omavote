import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useI18n } from "../app/i18n";
import { useApp } from "../app/state";
import {
  AbortError,
  ballotCounts,
  lookupBallot,
  lookupControl,
  lookupPoll,
  lookupRecord,
  lookupRelay,
  needsResign,
  RELAY_DONE,
  RELAY_FAILED,
  sleep,
  type BallotLookup,
  type ControlLookup,
  type PollLookup,
  type ReceiptCheck,
  type RecordLookup,
} from "../lib/flow";
import { positionText, utcHuman } from "../lib/format";
import type { Diagnostic, RelayItem } from "../lib/types";
import { BallotStatusBadge, CodeBadge, OutcomeBadge, RelayStatusBadge } from "./badges";
import { Check, Hash, Notice, Steps, useErrorText, type StepState } from "./ui";

export interface TrackTarget {
  kind: "ballot" | "authorization_control" | "process_record" | "manifest";
  objectId: string;
  pollId?: string | null;
  ownerId?: string | null;
  policyHash?: string | null;
  newRolesHash?: string | null;
  /** Controls: only say "revoked" / "in effect" once the index shows it. */
  controlAction?: "GRANT" | "REVOKE";
}

export function ReceiptChecks({ check, item }: { check: ReceiptCheck; item: RelayItem }) {
  const { t } = useI18n();
  const r = item.receipt;
  return (
    <div className="receipt-checks">
      <Check ok={check.present}>{check.present ? t("receipt.present") : t("receipt.absent")}</Check>
      {check.present && (
        <>
          <Check ok={check.signerMatches}>
            {check.signerMatches === null
              ? t("receipt.signerUnknown", { signer: check.signer ?? "?" })
              : check.signerMatches
                ? t("receipt.signerOk")
                : t("receipt.signerBad", { signer: check.signer ?? check.error ?? "?" })}
          </Check>
          <Check ok={check.objectMatches && check.kindMatches}>{t("receipt.objectOk")}</Check>
          {check.genesisMatches !== null && <Check ok={check.genesisMatches}>{t("receipt.genesisOk")}</Check>}
          <Check ok={check.envelopeHashMatches}>
            {check.envelopeHashMatches === null
              ? t("receipt.envelopeUnknown")
              : check.envelopeHashMatches
                ? t("receipt.envelopeOk")
                : t("receipt.envelopeBad")}
          </Check>
          {r && (
            <div className="muted small">
              {t("receipt.times", {
                received: utcHuman(r.body.received_at_ms),
                publishBy: r.body.publish_by_ms ? utcHuman(r.body.publish_by_ms) : "—",
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

const RELAY_ORDER = ["RECEIVED", "BROADCAST", "INCLUDED", "CONFIRMED"] as const;

export function RelaySteps({ status }: { status: string | null }) {
  const { t } = useI18n();
  const idx = status === "ALREADY_ON_CHAIN" ? 3 : status ? RELAY_ORDER.indexOf(status as (typeof RELAY_ORDER)[number]) : -1;
  const failed = status !== null && RELAY_FAILED.includes(status);
  const steps = RELAY_ORDER.map((s, i) => {
    let state: StepState = "todo";
    if (failed) state = i === 0 ? "done" : "failed";
    else if (i <= idx) state = "done";
    else if (i === idx + 1) state = "active";
    return { label: t(`relayStatus.${s}`), state };
  });
  return <Steps steps={steps} />;
}

const MAX_WATCH_MS = 2 * 60 * 60_000;

/**
 * Follows a submitted object: relay status (RECEIVED → BROADCAST → INCLUDED →
 * CONFIRMED) and then the indexer's view (ballot selection, control outcome,
 * record, registered poll). It keeps watching after the first confirmation so that
 * a reorg that drops the object, or an orphaned anchor, is reported. GET only.
 */
export function SubmissionTracker({
  target,
  initial,
  receipt,
}: {
  target: TrackTarget;
  initial?: RelayItem | null;
  receipt?: ReceiptCheck | null;
}) {
  const { t } = useI18n();
  const errorText = useErrorText();
  const { api } = useApp();
  const [item, setItem] = useState<RelayItem | null>(initial ?? null);
  const [ballot, setBallot] = useState<BallotLookup | null>(null);
  const [control, setControl] = useState<ControlLookup | null>(null);
  const [record, setRecord] = useState<RecordLookup | null>(null);
  const [poll, setPoll] = useState<PollLookup | null>(null);
  const [vanished, setVanished] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    const started = Date.now();
    let seen = false;
    let relayStatus: string | null = initial?.status ?? null;
    let rounds = 0;
    const round = async (): Promise<boolean> => {
      rounds++;
      if (relayStatus !== "ALREADY_ON_CHAIN") {
        const it = await lookupRelay(api, target.objectId);
        if (it) {
          setItem(it);
          relayStatus = it.status;
        }
      }
      const included = relayStatus === "ALREADY_ON_CHAIN" || (relayStatus !== null && RELAY_DONE.includes(relayStatus));
      let present = false;
      let settled = relayStatus !== null && RELAY_FAILED.includes(relayStatus);
      // Before inclusion the index rarely changes: look at it every third round only.
      if (!included && !seen && rounds % 3 !== 1) return settled;
      if (target.kind === "ballot" && target.pollId && target.ownerId) {
        const r = await lookupBallot(api, target.pollId, target.ownerId, target.objectId);
        setBallot(r);
        present = !!r.ballot;
        settled ||= included && (present || r.rejected.length > 0);
      } else if (target.kind === "authorization_control" && target.ownerId && target.policyHash) {
        const r = await lookupControl(api, target.ownerId, target.policyHash, target.objectId);
        setControl(r);
        present = !!r && r.outcome !== null;
        settled ||= included && !!r && (present || r.rejected.length > 0);
      } else if (target.kind === "process_record") {
        const r = await lookupRecord(api, { pollId: target.pollId ?? null, recordId: target.objectId, newRolesHash: target.newRolesHash ?? null });
        setRecord(r);
        present = r.found;
        settled ||= included && (present || r.rejected.length > 0);
      } else if (target.kind === "manifest") {
        const r = await lookupPoll(api, target.objectId);
        setPoll(r);
        present = r.registered;
        settled ||= included && (present || r.rejected.length > 0);
      }
      if (present) seen = true;
      setVanished(seen && !present);
      return settled;
    };
    (async () => {
      while (!ctrl.signal.aborted && Date.now() - started < MAX_WATCH_MS) {
        let settled = false;
        try {
          settled = await round();
          setError(null);
        } catch (e) {
          if (e instanceof AbortError) return;
          setError(e);
        }
        await sleep(settled ? 15_000 : 3000, ctrl.signal);
      }
    })().catch((e: unknown) => {
      if (!(e instanceof AbortError)) setError(e);
    });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, target.objectId, tick]);

  const status = item?.status ?? null;
  const included = status === "ALREADY_ON_CHAIN" || (status !== null && RELAY_DONE.includes(status));
  const rejected: Diagnostic[] =
    target.kind === "ballot"
      ? ballot?.rejected ?? []
      : target.kind === "authorization_control"
        ? control?.rejected ?? []
        : target.kind === "process_record"
          ? record?.rejected ?? []
          : poll?.rejected ?? [];
  const resign = needsResign(status, rejected.map((d) => d.code)) || (vanished && !included);
  return (
    <div className="tracker">
      {receipt && item && <ReceiptChecks check={receipt} item={item} />}
      <div className="tracker-relay">
        <div className="tracker-row">
          <strong>{t("track.relay")}</strong>
          {status && <RelayStatusBadge status={status} />}
          <Link to={`/receipt/${target.objectId}`} className="small">
            {t("track.receiptPage")}
          </Link>
        </div>
        <RelaySteps status={status} />
        {item?.tx_hash && (
          <div className="small">
            {t("track.tx")} <Hash value={item.tx_hash} /> {item.block_number && t("track.block", { n: item.block_number })}
          </div>
        )}
        {item?.error && <Notice tone="warn">{item.error}</Notice>}
      </div>
      {target.kind === "ballot" && <BallotOutcome lookup={ballot} relayStatus={status} relayKnown={item !== null} />}
      {target.kind === "authorization_control" && <ControlResult lookup={control} included={included} action={target.controlAction} />}
      {target.kind === "process_record" && record?.found && <Notice tone="ok">{t("track.recordFound")}</Notice>}
      {target.kind === "manifest" && poll?.registered && (
        <Notice tone="ok" title={t("track.pollRegistered")}>
          <Link to={`/proposal/${target.objectId}`}>{t("track.openProposal")}</Link>
        </Notice>
      )}
      {rejected.map((d, i) => (
        <Notice key={i} tone="bad" title={t("track.rejected")}>
          <CodeBadge code={d.code} /> {d.detail}
        </Notice>
      ))}
      {vanished && <Notice tone="warn">{t("track.vanished")}</Notice>}
      {resign && (
        <Notice tone="bad" title={t("track.resignTitle")}>
          {t("track.resignBody")}
        </Notice>
      )}
      {error !== null && error !== undefined && <Notice tone="warn">{t("track.watchError", { detail: errorText(error) })}</Notice>}
      <div className="tracker-actions">
        <button type="button" className="btn btn-small" onClick={() => setTick((x) => x + 1)}>
          {t("track.recheck")}
        </button>
      </div>
    </div>
  );
}

function BallotOutcome({ lookup, relayStatus, relayKnown }: { lookup: BallotLookup | null; relayStatus: string | null; relayKnown: boolean }) {
  const { t, th } = useI18n();
  const relayDone = relayStatus === "ALREADY_ON_CHAIN" || (relayStatus !== null && RELAY_DONE.includes(relayStatus));
  if (!lookup || (!lookup.ballot && lookup.rejected.length === 0)) {
    return <Notice tone="info">{relayDone ? t("track.waitIndex") : t("track.waitInclusion")}</Notice>;
  }
  if (!lookup.ballot) return null;
  // The index lists only ballots on chain; when this relay knows the item it must also
  // report it INCLUDED/CONFIRMED (an envelope sent through another relay is unknown here).
  const counts = ballotCounts(relayDone || !relayKnown ? "INCLUDED" : relayStatus, lookup);
  return (
    <div className="tracker-result">
      <div className="tracker-row">
        <strong>{t("track.ballotStatus")}</strong> <BallotStatusBadge status={lookup.ballot.status} />
        <span className="muted small">
          {t("track.position", { pos: positionText(lookup.ballot.position) })}
          {lookup.at && ` · ${t("track.asOf", { n: lookup.at.number })}`}
        </span>
      </div>
      {counts ? (
        <Notice tone="ok" title={t("track.countsTitle")}>
          {t("track.countsBody")}
        </Notice>
      ) : lookup.ballot.status === "SELECTED" ? (
        <Notice tone="info">{t("track.waitInclusion")}</Notice>
      ) : (
        <Notice tone="warn" title={t("track.notSelectedTitle")}>
          {th(`ballotHelp.${lookup.ballot.status}`) ?? lookup.ballot.status}
        </Notice>
      )}
    </div>
  );
}

function ControlResult({ lookup, included, action }: { lookup: ControlLookup | null; included: boolean; action?: "GRANT" | "REVOKE" }) {
  const { t, th } = useI18n();
  if (!lookup || lookup.outcome === null) {
    if (lookup?.rejected.length) return null;
    return <Notice tone="info">{included ? t("track.waitIndex") : t("track.waitInclusion")}</Notice>;
  }
  const effective = lookup.outcome === "EFFECTIVE";
  const reflected =
    action === "GRANT" ? effective && lookup.isCurrent : action === "REVOKE" ? effective && !lookup.stream?.current : effective;
  return (
    <div className="tracker-result">
      <div className="tracker-row">
        <strong>{t("track.controlOutcome")}</strong> <OutcomeBadge outcome={lookup.outcome} />
      </div>
      {reflected ? (
        <Notice tone="ok">{action === "REVOKE" ? t("track.revokeEffective") : t("track.grantEffective")}</Notice>
      ) : effective ? (
        <Notice tone="warn">{t("track.controlSuperseded")}</Notice>
      ) : (
        <Notice tone="bad" title={t("track.controlNotEffective")}>
          {th(`controlHelp.${lookup.outcome}`) ?? lookup.outcome}
        </Notice>
      )}
    </div>
  );
}
