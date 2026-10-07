import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { useI18n } from "../app/i18n";
import { useApp, useLoad } from "../app/state";
import {
  ActionBadge,
  AdmissionBadge,
  AttestationBadge,
  BallotStatusBadge,
  CodeBadge,
  GovernanceBadge,
  PollStatusBadge,
} from "../components/badges";
import { NeedCore } from "../components/gate";
import { TallySummary } from "../components/tally";
import { Badge, Check, ErrorView, Hash, JsonBlock, KV, Loading, Mono, Notice, Section } from "../components/ui";
import { VotePanel } from "../components/vote";
import { downloadJson } from "../lib/browser";
import type { Core } from "../lib/core";
import { big, durationText, estimateWallMs, formatCkb, formatInt, pollTag, positionText, ratioPercent, relativeText, shortText, utcHuman } from "../lib/format";
import { isHash32 } from "../lib/hex";
import type { BallotsView, Diagnostic, ManifestInfo, NetworkInfo, ProposalDetail, RecordsView } from "../lib/types";

export function ProposalPage() {
  const { t } = useI18n();
  const { id = "" } = useParams();
  const pollId = id.toLowerCase();
  if (!isHash32(pollId)) return <Notice tone="bad">{t("proposal.badId")}</Notice>;
  return <NeedCore>{(core, network) => <ProposalLoader core={core} network={network} pollId={pollId} />}</NeedCore>;
}

function ProposalLoader({ core, network, pollId }: { core: Core; network: NetworkInfo; pollId: string }) {
  const { api } = useApp();
  const detail = useLoad(() => api.proposal(pollId), [api, pollId]);
  const ballots = useLoad(() => api.ballots(pollId), [api, pollId]);
  const records = useLoad(() => api.records(pollId), [api, pollId]);
  const [loadedAt, setLoadedAt] = useState(Date.now());
  useEffect(() => setLoadedAt(Date.now()), [detail.data]);
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      detail.reload();
      ballots.reload();
      records.reload();
    }, 20_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, pollId]);
  if (detail.loading && !detail.data) return <Loading />;
  if (!detail.data) return <ErrorView error={detail.error} />;
  return (
    <ProposalView
      core={core}
      network={network}
      detail={detail.data}
      loadedAt={loadedAt}
      ballots={ballots.data}
      ballotsError={ballots.error}
      records={records.data}
      recordsError={records.error}
    />
  );
}

function ChainTime({ ms, chainClock, loadedAt }: { ms: string; chainClock: string | null; loadedAt: number }) {
  const { t, lang } = useI18n();
  const est = chainClock ? estimateWallMs(ms, chainClock, loadedAt) : null;
  return (
    <span>
      <code>{utcHuman(ms)}</code> <span className="muted small">{t("schedule.chainTime")}</span>
      {est !== null && (
        <span className="muted small">
          {" · "}
          {t("schedule.estimate", { when: relativeText(est - Date.now(), lang), local: new Date(est).toLocaleString() })}
        </span>
      )}
    </span>
  );
}

function ProposalView({
  core,
  network,
  detail,
  loadedAt,
  ballots,
  ballotsError,
  records,
  recordsError,
}: {
  core: Core;
  network: NetworkInfo;
  detail: ProposalDetail;
  loadedAt: number;
  ballots: BallotsView | null;
  ballotsError: unknown;
  records: RecordsView | null;
  recordsError: unknown;
}) {
  const { t, lang } = useI18n();
  const { api } = useApp();
  const manifest = detail.manifest_payload.manifest;
  const net = network.network;
  const local = useMemo((): { info: ManifestInfo | null; error: unknown } => {
    try {
      return { info: core.manifestInfo(manifest, net), error: null };
    } catch (e) {
      return { info: null, error: e };
    }
  }, [core, manifest, net]);
  const info = local.info;
  const idMatches = info?.poll_id === detail.poll_id;
  const rules = manifest.rules_profile;
  const approval = manifest.proposal_type === "meta_rule" ? rules.approval_meta_rule : rules.approval_grant;
  const proposers = manifest.proposer_owner_locks.map((l) => ({ lock: l, address: core.address(net, l) }));
  const chainClock = detail.at?.clock_ms ?? null;
  const [bundleBusy, setBundleBusy] = useState(false);
  const [bundleError, setBundleError] = useState<unknown>(null);

  return (
    <div className="page">
      <div className="page-head">
        <h1>{detail.title}</h1>
        <div className="poll-id-big" title={detail.poll_id}>
          {pollTag(detail.poll_id)}
        </div>
        <p className="muted small">{t("proposal.tagHint")}</p>
        <div className="badges">
          <PollStatusBadge status={detail.status} />
          <AdmissionBadge v={detail.admission} />
          <GovernanceBadge v={detail.governance} />
          <AttestationBadge v={detail.attestation} />
        </div>
      </div>

      {local.error !== null ? (
        <ErrorView error={local.error} title={t("proposal.integrityFailed")} />
      ) : (
        <Check ok={idMatches}>{idMatches ? t("proposal.integrityOk") : t("proposal.integrityBad", { local: info?.poll_id ?? "?" })}</Check>
      )}

      <Section title={t("proposal.officialTitle")}>
        <KV
          rows={[
            [t("proposal.admission"), <span key="a"><AdmissionBadge v={detail.admission} /> <span className="small">{t(`admissionHelp.${detail.admission.state}`)}</span></span>],
            [
              t("proposal.governance"),
              detail.governance.state === "NONE" ? (
                <span className="muted">{t("governance.NONE")}</span>
              ) : (
                <span key="g"><GovernanceBadge v={detail.governance} /> <span className="small">{t(`governanceHelp.${detail.governance.state}`)}</span></span>
              ),
            ],
            [
              t("proposal.attestation"),
              detail.attestation.state === "NONE" ? (
                <span className="muted">{t("attestation.NONE")}</span>
              ) : (
                <span key="at">
                  <AttestationBadge v={detail.attestation} />{" "}
                  <span className="small">{detail.attestation.state === "DISPUTED" ? detail.attestation.detail : t(`attestationHelp.${detail.attestation.state}`)}</span>
                </span>
              ),
            ],
            [
              t("proposal.proposerCheck"),
              <span key="p">
                <Badge tone={detail.proposer_eligible ? "ok" : "bad"}>{detail.proposer_eligible ? t("proposal.proposerOk") : t("proposal.proposerIneligible")}</Badge>{" "}
                <span className="small">
                  {t("proposal.proposerDeposit", { amount: formatCkb(detail.proposer_deposit_shannon), min: formatCkb(rules.proposer_min_deposit_shannon) })}
                </span>
              </span>,
            ],
          ]}
        />
        <p className="muted small">{t("proposal.officialNote")}</p>
      </Section>

      <Section title={t("proposal.factsTitle")}>
        <KV
          rows={[
            [t("proposal.signingTitle"), <span key="st">{manifest.signing_title}</span>],
            [t("proposal.type"), manifest.proposal_type === "meta_rule" ? t("proposal.typeMeta") : t("proposal.typeGrant")],
            [
              t("proposal.budget"),
              manifest.proposal_type === "meta_rule" ? (
                t("proposal.noBudget")
              ) : (
                <span key="b">
                  <strong>{formatCkb(manifest.budget_ckb_shannon)}</strong>{" "}
                  <span className="muted small">({t("proposal.exactShannon", { n: formatInt(manifest.budget_ckb_shannon) })})</span>
                </span>
              ),
            ],
            [t("proposal.recipient"), info?.recipient_address ? <Mono key="r" value={info.recipient_address} /> : <span className="muted">{t("proposal.noRecipient")}</span>],
            [
              t("proposal.quorum"),
              <span key="q">
                {formatCkb(info?.quorum_required_shannon ?? "0")}{" "}
                <span className="muted small">
                  {manifest.proposal_type === "grant"
                    ? t("proposal.quorumGrant", { mult: rules.quorum_grant_multiplier, base: formatCkb(manifest.quorum_base_shannon) })
                    : t("proposal.quorumMeta")}
                </span>
              </span>,
            ],
            [
              t("proposal.approval"),
              t("proposal.approvalValue", {
                ratio: ratioPercent(approval.numerator, approval.denominator),
                cmp: rules.threshold_comparison === "inclusive" ? "≥" : ">",
              }),
            ],
            [
              t("proposal.proposers"),
              <ul key="pr" className="plain">
                {proposers.map((p) => (
                  <li key={p.address}>
                    <Mono value={p.address} />
                  </li>
                ))}
              </ul>,
            ],
            [t("proposal.contentHash"), <Hash key="ch" value={manifest.content_hash} />],
            [
              t("proposal.contentLocations"),
              manifest.content_locations.length === 0 ? (
                <span className="muted">—</span>
              ) : (
                <ul key="cl" className="plain">
                  {manifest.content_locations.map((u) => (
                    <li key={u}>
                      {/^https?:\/\//.test(u) ? (
                        <a href={u} target="_blank" rel="noopener noreferrer">
                          {u}
                        </a>
                      ) : (
                        <code>{u}</code>
                      )}
                    </li>
                  ))}
                </ul>
              ),
            ],
            [t("proposal.forum"), t("proposal.forumValue", { topic: manifest.forum_topic_id, rev: manifest.forum_revision })],
            [t("proposal.discussionEvidence"), <Hash key="de" value={manifest.discussion_evidence_hash} />],
            [t("proposal.paymentTerms"), <Hash key="pt" value={manifest.payment_terms_hash} />],
            [
              t("proposal.adapters"),
              <span key="ad" className="small">
                {t("proposal.ownerAdapters")}: {manifest.auth_registry.owner_adapters.join(", ") || "—"}
                <br />
                {t("proposal.keyAdapters")}: {manifest.auth_registry.key_adapters.join(", ") || "—"}
              </span>,
            ],
          ]}
        />
        <p className="muted small">{t("proposal.contentNote")}</p>
      </Section>

      <Section title={t("proposal.scheduleTitle")}>
        <KV
          rows={[
            [t("schedule.start"), <ChainTime key="s" ms={manifest.start_ms} chainClock={chainClock} loadedAt={loadedAt} />],
            [t("schedule.end"), <ChainTime key="e" ms={manifest.end_ms} chainClock={chainClock} loadedAt={loadedAt} />],
            ...(detail.delegate_end_ms !== manifest.end_ms
              ? [[t("schedule.delegateEnd"), <ChainTime key="d" ms={detail.delegate_end_ms} chainClock={chainClock} loadedAt={loadedAt} />] as [string, JSX.Element]]
              : []),
            [t("schedule.period"), durationText(Number(rules.voting_period_ms), lang)],
            [t("schedule.chainClockNow"), chainClock ? <code key="c">{utcHuman(chainClock)}</code> : "—"],
            [t("schedule.registered"), t("schedule.atPosition", { pos: positionText(detail.registered.position) })],
            [t("schedule.openingConfirmations"), t("schedule.blocks", { n: rules.opening_confirmations })],
            [t("schedule.startBoundary"), detail.start_boundary ? t("schedule.block", { n: detail.start_boundary.number }) : "—"],
            [t("schedule.close"), detail.close ? t("schedule.block", { n: detail.close.number }) : "—"],
            [
              t("schedule.confirmation"),
              t("schedule.confirmationValue", {
                n: manifest.confirmation_policy.result_confirmations,
                review: durationText(Number(manifest.confirmation_policy.review_window_ms), lang),
              }),
            ],
          ]}
        />
        <Notice tone="info">{t("schedule.mtpNote")}</Notice>
      </Section>

      <Section title={t("proposal.tallyTitle")}>
        <TallySummary tally={detail.tally} pollId={detail.poll_id} />
      </Section>

      <Section title={t("vote.title")} id="vote">
        {["OPEN", "ANNOUNCED"].includes(detail.status) ? (
          <VotePanel core={core} network={network} detail={detail} />
        ) : (
          <Notice tone="info">{t("vote.closed")}</Notice>
        )}
      </Section>

      <Section title={t("proposal.ballotsTitle", { n: ballots?.ballots.length ?? detail.ballot_count })}>
        {ballotsError !== null && <ErrorView error={ballotsError} />}
        {ballots ? <BallotsTable core={core} network={network} view={ballots} /> : <Loading />}
      </Section>

      <Section title={t("proposal.recordsTitle")}>
        {recordsError !== null && <ErrorView error={recordsError} />}
        {records ? <RecordsList view={records} /> : <Loading />}
      </Section>

      <Section title={t("proposal.evidenceTitle")}>
        <p>{t("proposal.evidenceBody")}</p>
        <div className="row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={bundleBusy}
            onClick={async () => {
              setBundleBusy(true);
              setBundleError(null);
              try {
                const b = await api.bundle(detail.poll_id);
                downloadJson(`omavote-${detail.short_id}-bundle.json`, b);
              } catch (e) {
                setBundleError(e);
              } finally {
                setBundleBusy(false);
              }
            }}
          >
            {bundleBusy ? t("common.loading") : t("proposal.downloadBundle")}
          </button>
          <Link to={`/verify/${detail.poll_id}`} className="btn">
            {t("proposal.verifyIndependently")}
          </Link>
        </div>
        {bundleError !== null && <ErrorView error={bundleError} />}
        <KV
          rows={[
            ["poll_id", <Hash key="1" value={detail.hashes.poll_id} />],
            ["rules_hash", <Hash key="2" value={detail.hashes.rules_hash} />],
            ["auth_policy_hash", <Hash key="3" value={detail.hashes.auth_policy_hash} />],
            ["auth_registry_hash", <Hash key="4" value={detail.hashes.auth_registry_hash} />],
            ["result_hash", <Hash key="5" value={detail.result_hash} />],
          ]}
        />
        <JsonBlock value={detail.manifest_payload} summary={t("proposal.manifestJson")} />
        {detail.result_core && <JsonBlock value={detail.result_core} summary={t("proposal.resultCoreJson")} />}
      </Section>
    </div>
  );
}

function BallotsTable({ core, network, view }: { core: Core; network: NetworkInfo; view: BallotsView }) {
  const { t } = useI18n();
  const [filter, setFilter] = useState("");
  const [onlySelected, setOnlySelected] = useState(false);
  const rows = view.ballots
    .map((b) => {
      let address = b.owner_id;
      try {
        address = core.address(network.network, b.envelope.body.owner_lock);
      } catch {
        // keep owner id
      }
      return { b, address };
    })
    .filter(({ b, address }) => {
      if (onlySelected && b.status !== "SELECTED") return false;
      const f = filter.trim().toLowerCase();
      return f === "" || address.toLowerCase().includes(f) || b.owner_id.includes(f) || b.ballot_id.includes(f);
    });
  const selectedWeightNote = view.ballots.filter((b) => b.status === "SELECTED").length;
  return (
    <div>
      <div className="row">
        <input className="grow" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t("ballots.filter")} spellCheck={false} />
        <label className="inline-field">
          <input type="checkbox" checked={onlySelected} onChange={(e) => setOnlySelected(e.target.checked)} /> {t("ballots.onlySelected")}
        </label>
      </div>
      <p className="muted small">
        {t("ballots.summary", { total: view.ballots.length, selected: selectedWeightNote })} {view.at && t("common.asOfBlock", { n: view.at.number })}
      </p>
      {rows.length === 0 ? (
        <p className="muted">{t("ballots.none")}</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t("ballots.owner")}</th>
                <th>{t("ballots.choice")}</th>
                <th>{t("ballots.authority")}</th>
                <th>{t("ballots.anchor")}</th>
                <th>{t("ballots.position")}</th>
                <th>{t("ballots.status")}</th>
                <th>{t("ballots.id")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ b, address }) => (
                <tr key={b.ballot_id + positionText(b.position)}>
                  <td>
                    <Link to={`/address/${address}`} title={address}>
                      <code>{shortText(address, 10, 6)}</code>
                    </Link>
                  </td>
                  <td>
                    <ActionBadge action={b.action} />
                  </td>
                  <td className="small">
                    {b.authority === "owner" ? t("vote.direct") : t("vote.delegated")}
                    {b.authorization_id && (
                      <div className="muted">
                        {t("ballots.grantAnchor", { n: b.grant_anchor_height })}
                      </div>
                    )}
                  </td>
                  <td>{b.anchor_height}</td>
                  <td className="small">
                    <span title={b.tx_hash}>{positionText(b.position)}</span>
                  </td>
                  <td>
                    <BallotStatusBadge status={b.status} />
                  </td>
                  <td>
                    <Link to={`/receipt/${b.ballot_id}`}>
                      <code>{b.ballot_id.slice(0, 10)}…</code>
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">{t("ballots.statusNote")}</p>
      <RejectedList items={view.rejected} title={t("ballots.rejectedTitle", { n: view.rejected.length })} />
    </div>
  );
}

export function RejectedList({ items, title }: { items: Diagnostic[]; title: string }) {
  const { t, th } = useI18n();
  if (items.length === 0) return null;
  return (
    <details className="rejected" open={items.length <= 5}>
      <summary>{title}</summary>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t("diag.code")}</th>
              <th>{t("diag.kind")}</th>
              <th>{t("diag.id")}</th>
              <th>{t("diag.position")}</th>
              <th>{t("diag.detail")}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((d, i) => (
              <tr key={i}>
                <td>
                  <CodeBadge code={d.code} />
                </td>
                <td className="small">{d.kind}</td>
                <td>
                  <Hash value={d.id} copy={false} />
                </td>
                <td className="small">{positionText(d.position)}</td>
                <td className="small">
                  {d.detail}
                  {th(`codeHelp.${d.code}`) && <div className="muted">{th(`codeHelp.${d.code}`)}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function RecordsList({ view }: { view: RecordsView }) {
  const { t, tk } = useI18n();
  return (
    <div>
      {view.records.length === 0 ? (
        <p className="muted">{t("records.none")}</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t("records.type")}</th>
                <th>{t("records.detail")}</th>
                <th>{t("records.anchor")}</th>
                <th>{t("records.position")}</th>
                <th>{t("records.signers")}</th>
                <th>{t("records.id")}</th>
              </tr>
            </thead>
            <tbody>
              {view.records.map((r) => (
                <tr key={r.record_id}>
                  <td>{tk(`recordType.${r.record_type}`)}</td>
                  <td className="small">
                    {Object.entries(r.detail).map(([k, v]) => (
                      <div key={k}>
                        <span className="muted">{k}:</span> <code>{v.length > 24 ? `${v.slice(0, 18)}…` : v}</code>
                      </div>
                    ))}
                  </td>
                  <td>{r.anchor_height}</td>
                  <td className="small">{positionText(r.position)}</td>
                  <td>{r.signers.length}</td>
                  <td>
                    <Hash value={r.record_id} copy={false} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">{t("records.orderNote")}</p>
      <RejectedList items={view.rejected} title={t("records.rejectedTitle", { n: view.rejected.length })} />
      {big(String(view.records.length)) > 0n && <JsonBlock value={view.records.map((r) => r.envelope)} summary={t("records.envelopes")} />}
    </div>
  );
}
