import { useEffect } from "react";
import { Link } from "react-router";
import { useI18n } from "../app/i18n";
import { useApp, useLoad } from "../app/state";
import { AdmissionBadge, AttestationBadge, GovernanceBadge, PollStatusBadge } from "../components/badges";
import { TallySummary } from "../components/tally";
import { Badge, ErrorView, Loading, Notice } from "../components/ui";
import { formatCkb, pollTag, relativeText, utcHuman } from "../lib/format";
import type { ProposalSummary } from "../lib/types";

function Schedule({ p, chainClock }: { p: ProposalSummary; chainClock: string | null }) {
  const { t, lang } = useI18n();
  const now = chainClock ? Number(chainClock) : null;
  const rel = (ms: string) => (now !== null ? ` (${relativeText(Number(ms) - now, lang)})` : "");
  return (
    <div className="small">
      <div>
        {t("schedule.start")}: {utcHuman(p.start_ms)}
        <span className="muted">{rel(p.start_ms)}</span>
      </div>
      <div>
        {t("schedule.end")}: {utcHuman(p.end_ms)}
        <span className="muted">{rel(p.end_ms)}</span>
      </div>
    </div>
  );
}

function ProposalCard({ p, chainClock }: { p: ProposalSummary; chainClock: string | null }) {
  const { t } = useI18n();
  return (
    <li className="card proposal-card">
      <div className="proposal-card-head">
        <Link to={`/proposal/${p.poll_id}`} className="proposal-title">
          {p.title}
        </Link>
        <code className="poll-tag">{pollTag(p.poll_id)}</code>
      </div>
      <div className="badges">
        <PollStatusBadge status={p.status} />
        <AdmissionBadge v={p.admission} />
        <GovernanceBadge v={p.governance} />
        <AttestationBadge v={p.attestation} />
        {!p.proposer_eligible && <Badge tone="bad">{t("proposal.proposerIneligible")}</Badge>}
      </div>
      <div className="proposal-card-grid">
        <div>
          <div className="muted small">{p.proposal_type === "meta_rule" ? t("proposal.typeMeta") : t("proposal.typeGrant")}</div>
          <div className="big-amount">{p.proposal_type === "meta_rule" ? t("proposal.noBudget") : formatCkb(p.budget_ckb_shannon)}</div>
          <Schedule p={p} chainClock={chainClock} />
          <div className="muted small">{t("proposal.ballotCount", { n: p.ballot_count })}</div>
        </div>
        <div>
          <TallySummary tally={p.tally} pollId={p.poll_id} compact />
        </div>
      </div>
    </li>
  );
}

export function ProposalsPage() {
  const { t } = useI18n();
  const { api } = useApp();
  const { data, error, loading, reload } = useLoad(() => api.proposals(), [api]);
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState !== "hidden") reload();
    }, 20_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);
  return (
    <div className="page">
      <h1>{t("proposals.title")}</h1>
      <p className="lead">{t("proposals.lead")}</p>
      <Notice tone="info">{t("proposals.officialNote")}</Notice>
      {data?.at && <p className="muted small">{t("common.asOf", { n: data.at.number, time: utcHuman(data.at.clock_ms) })}</p>}
      {loading && !data && <Loading />}
      {error !== null && <ErrorView error={error} />}
      {data && data.proposals.length === 0 && <Notice tone="info">{t("proposals.none")}</Notice>}
      {data && (
        <ul className="proposal-list">
          {data.proposals.map((p) => (
            <ProposalCard key={p.poll_id} p={p} chainClock={data.at?.clock_ms ?? null} />
          ))}
        </ul>
      )}
    </div>
  );
}
