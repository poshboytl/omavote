import { useEffect, useState } from "react";
import { useI18n } from "../app/i18n";
import { useApp, useLoad } from "../app/state";
import { Badge, ErrorView, Hash, KV, Loading, Mono, Notice, Section } from "../components/ui";
import { assessSync } from "../lib/flow";
import { formatCkb, positionText, relativeText, utcHuman } from "../lib/format";
import { RejectedList } from "./ProposalPage";

const KINDS = ["", "ballot", "authorization_control", "process_record", "manifest", "carrier", "authorization_policy", "process_roles"];

export function StatusPage() {
  const { t, tk, lang } = useI18n();
  const { api, status, statusError, statusFetchedAt, refreshStatus, network, networkError } = useApp();
  const [kind, setKind] = useState("");
  const diags = useLoad(() => api.diagnostics(100, kind || undefined), [api, kind]);
  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);
  const a = status ? assessSync(status, statusFetchedAt || Date.now()) : null;
  return (
    <div className="page">
      <h1>{t("statusPage.title")}</h1>
      <p className="lead">{t("statusPage.lead")}</p>
      <div className="row">
        <button type="button" className="btn" onClick={() => void refreshStatus()}>
          {t("common.refresh")}
        </button>
        <a className="btn" href={api.feedUrl()} target="_blank" rel="noopener noreferrer">
          {t("statusPage.feed")}
        </a>
      </div>
      {statusError && <Notice tone="bad" title={t("banner.unreachable")}>{statusError}</Notice>}
      {!status && !statusError && <Loading />}
      {status && (
        <>
          <Section title={t("statusPage.server")}>
            {a && (a.ok ? <Badge tone="ok">{t("statusPage.synced")}</Badge> : a.issues.map((i, n) => <Badge key={n} tone="warn">{tk(i.key, i as unknown as Record<string, string>)}</Badge>))}
            <KV
              rows={[
                [t("statusPage.version"), status.version],
                [t("statusPage.network"), `${status.network.name}`],
                ["genesis", <Hash key="g" value={status.network.genesis_hash} />],
                [
                  t("statusPage.indexed"),
                  status.indexed ? (
                    <span key="i">
                      {t("schedule.block", { n: status.indexed.number })} · <Hash value={status.indexed.hash} /> · {utcHuman(status.indexed.clock_ms)}
                    </span>
                  ) : (
                    "—"
                  ),
                ],
                [t("statusPage.nodeTip"), status.node_tip ?? "—"],
                [t("statusPage.lag"), status.lag_blocks ?? "—"],
                [t("statusPage.syncedFlag"), String(status.synced)],
                [t("statusPage.lastSync"), `${utcHuman(status.last_sync_ms)} (${relativeText(Number(status.last_sync_ms) - Date.now(), lang)})`],
                [t("statusPage.lastError"), status.last_error ?? "—"],
                [t("statusPage.polls"), status.polls],
                [t("statusPage.diagnostics"), status.diagnostics],
              ]}
            />
            <p className="muted small">{t("statusPage.clockNote")}</p>
          </Section>
          <Section title={t("statusPage.reorgs")}>
            <KV
              rows={[
                [t("statusPage.reorgCount"), status.reorgs.count],
                [
                  t("statusPage.reorgLast"),
                  status.reorgs.last
                    ? t("statusPage.reorgValue", {
                        time: utcHuman(status.reorgs.last.at_ms),
                        old: status.reorgs.last.old_tip,
                        fork: status.reorgs.last.fork_height,
                        depth: status.reorgs.last.depth,
                      })
                    : "—",
                ],
              ]}
            />
            <p className="muted small">{t("statusPage.reorgNote")}</p>
          </Section>
          <Section title={t("statusPage.relay")}>
            <KV
              rows={[
                [t("statusPage.intake"), status.relay.intake ? t("common.yes") : t("common.no")],
                [t("statusPage.receiptKey"), <Hash key="k" value={status.relay.receipt_key} />],
                [t("statusPage.relayAddress"), status.relay.address ? <Mono key="a" value={status.relay.address} /> : "—"],
                [t("statusPage.balance"), status.relay.balance_shannon ? formatCkb(status.relay.balance_shannon) : "—"],
                [
                  t("statusPage.queue"),
                  Object.keys(status.relay.queue).length === 0
                    ? "—"
                    : Object.entries(status.relay.queue)
                        .map(([k, v]) => `${tk(`relayStatus.${k}`)}: ${v}`)
                        .join(" · "),
                ],
              ]}
            />
            <p className="muted small">{t("statusPage.relayNote")}</p>
          </Section>
        </>
      )}
      {networkError && <Notice tone="bad">{networkError}</Notice>}
      {network && (
        <Section title={t("statusPage.params")}>
          <KV
            rows={[
              ["hrp", network.network.hrp],
              ["secp256k1", <Hash key="s" value={network.network.secp256k1.code_hash} />],
              ["dao", <Hash key="d" value={network.network.dao.code_hash} />],
              ["omnilock", <Hash key="o" value={network.network.omnilock?.code_hash ?? null} />],
              ["pw_lock", <Hash key="p" value={network.network.pw_lock?.code_hash ?? null} />],
              [
                "auth_policy_hash",
                <span key="ph">
                  <Hash value={network.authorization_policy.hash} />{" "}
                  {network.authorization_policy.published ? (
                    <Badge tone="ok">{t("statusPage.published", { pos: positionText(network.authorization_policy.published) })}</Badge>
                  ) : (
                    <Badge tone="warn">{t("statusPage.unpublished")}</Badge>
                  )}
                </span>,
              ],
              ["initial_roles_hash", <Hash key="ir" value={network.initial_roles_hash} />],
              ["current roles_hash", <Hash key="cr" value={network.current_roles?.roles_hash ?? null} />],
              [t("statusPage.processDelay"), network.process_publication_delay_ms],
            ]}
          />
        </Section>
      )}
      <Section
        title={t("statusPage.diagTitle")}
        actions={
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k || t("statusPage.allKinds")}
              </option>
            ))}
          </select>
        }
      >
        <p className="muted small">{t("statusPage.diagNote")}</p>
        {diags.error !== null && <ErrorView error={diags.error} />}
        {diags.data && diags.data.diagnostics.length === 0 && <p className="muted">{t("statusPage.noDiag")}</p>}
        {diags.data && diags.data.diagnostics.length > 0 && <RejectedList items={diags.data.diagnostics} title={t("statusPage.diagCount", { n: diags.data.diagnostics.length })} />}
      </Section>
    </div>
  );
}
