import { Link } from "react-router";
import { useI18n } from "../app/i18n";
import { big, formatCkb, percent } from "../lib/format";
import type { TallyView } from "../lib/types";
import { Badge, Hash, Notice } from "./ui";

function Bar({ part, whole, tone }: { part: string; whole: string; tone: "yes" | "no" | "quorum" }) {
  const w = big(whole);
  const p = big(part);
  const pct = w === 0n ? 0 : Number((p * 10000n) / w) / 100;
  return (
    <div className={`bar bar-${tone}`} aria-hidden="true">
      <div className="bar-fill" style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  );
}

/**
 * Tally view. A PROVISIONAL tally is the current count with today's deposits:
 * it has no outcome and the page never derives pass/fail from it.
 */
export function TallySummary({ tally, pollId, compact }: { tally: TallyView | null; pollId: string; compact?: boolean }) {
  const { t } = useI18n();
  if (!tally) return <div className="muted small">{t("tally.none")}</div>;
  const participation = tally.participation_shannon;
  const rows = (
    <div className="tally-rows">
      <div className="tally-row">
        <span className="tally-label">{t("choice.YES")}</span>
        <span className="tally-amount">{formatCkb(tally.yes_shannon)}</span>
        <span className="muted small">{percent(tally.yes_shannon, participation)}</span>
      </div>
      {!compact && <Bar part={tally.yes_shannon} whole={participation} tone="yes" />}
      <div className="tally-row">
        <span className="tally-label">{t("choice.NO")}</span>
        <span className="tally-amount">{formatCkb(tally.no_shannon)}</span>
        <span className="muted small">{percent(tally.no_shannon, participation)}</span>
      </div>
      {!compact && <Bar part={tally.no_shannon} whole={participation} tone="no" />}
      <div className="tally-row">
        <span className="tally-label">{t("tally.participation")}</span>
        <span className="tally-amount">{formatCkb(participation)}</span>
        <span className="muted small">
          {t("tally.ofQuorum", { pct: percent(participation, tally.quorum_required_shannon), quorum: formatCkb(tally.quorum_required_shannon) })}
        </span>
      </div>
      {!compact && <Bar part={participation} whole={tally.quorum_required_shannon} tone="quorum" />}
      <div className="muted small">{t("tally.owners", { n: tally.owners })}</div>
    </div>
  );
  if (tally.kind === "PROVISIONAL") {
    return (
      <div className="tally tally-provisional">
        <div className="tally-head">
          <Badge tone="warn">{t("tally.provisional")}</Badge>
          <span className="small">{t("tally.provisionalShort")}</span>
        </div>
        {rows}
        {!compact && <Notice tone="warn">{t("tally.provisionalBody")}</Notice>}
      </div>
    );
  }
  return (
    <div className="tally tally-final">
      <div className="tally-head">
        <Badge tone="info">{t("tally.final")}</Badge>
        <Badge tone={tally.outcome === "PASS" ? "ok" : "bad"}>{t(tally.outcome === "PASS" ? "tally.pass" : "tally.fail")}</Badge>
      </div>
      {rows}
      {!compact && (
        <>
          <div className="small">
            {t("tally.resultHash")} <Hash value={tally.result_hash} />
          </div>
          <p className="muted small">
            {t("tally.finalNote")} <Link to={`/verify/${pollId}`}>{t("tally.verifyLink")}</Link>
          </p>
        </>
      )}
    </div>
  );
}
