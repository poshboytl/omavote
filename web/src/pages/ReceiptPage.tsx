import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useI18n } from "../app/i18n";
import { useApp, useLoad } from "../app/state";
import { CodeBadge, RelayStatusBadge } from "../components/badges";
import { NeedCore } from "../components/gate";
import { ReceiptNote } from "../components/sign";
import { ReceiptChecks, SubmissionTracker, type TrackTarget } from "../components/tracker";
import { DownloadJsonButton, ErrorView, Hash, JsonBlock, KV, Loading, Notice, Section } from "../components/ui";
import type { Core } from "../lib/core";
import { checkReceipt, submitEnvelope, type SubmitOutcome } from "../lib/flow";
import { utcHuman } from "../lib/format";
import { isHash32, parseHash32 } from "../lib/hex";
import { getPending, listPending, removePending, type PendingItem } from "../lib/storage";
import type { BallotEnvelope, ControlEnvelope, NetworkInfo, ProcessEnvelope, RelayItem } from "../lib/types";

export function ReceiptPage() {
  const { id } = useParams();
  return <NeedCore>{(core, network) => <ReceiptView core={core} network={network} id={id ? id.toLowerCase() : null} />}</NeedCore>;
}

/** Tracking target derived from a locally kept envelope (poll and owner ids). */
function targetFor(core: Core, p: PendingItem): TrackTarget {
  switch (p.kind) {
    case "ballot": {
      const b = (p.envelope as BallotEnvelope).body;
      return { kind: "ballot", objectId: p.id, pollId: b.poll_id, ownerId: core.scriptHash(b.owner_lock) };
    }
    case "authorization_control": {
      const b = (p.envelope as ControlEnvelope).body;
      return {
        kind: "authorization_control",
        objectId: p.id,
        ownerId: core.scriptHash(b.owner_lock),
        policyHash: b.auth_policy_hash,
        controlAction: b.action,
      };
    }
    case "process_record": {
      const b = (p.envelope as ProcessEnvelope).body;
      const detail = b.detail as { new_roles_hash?: string };
      return { kind: "process_record", objectId: p.id, pollId: b.poll_id, newRolesHash: detail.new_roles_hash ?? null };
    }
    case "manifest":
      return { kind: "manifest", objectId: p.id };
  }
}

/** Tracking target from the relay item alone (scope_id / owner_id), for receipts not kept here. */
function targetFromItem(item: RelayItem): TrackTarget | null {
  const scope = item.scope_id ?? null;
  const owner = item.owner_id ?? null;
  switch (item.message_kind) {
    case "ballot":
      return scope && owner ? { kind: "ballot", objectId: item.object_id, pollId: scope, ownerId: owner } : null;
    case "authorization_control":
      return scope && owner ? { kind: "authorization_control", objectId: item.object_id, ownerId: owner, policyHash: scope } : null;
    case "process_record":
      // Poll records are scoped by poll id; ROLES_UPDATE by the new roles hash.
      return { kind: "process_record", objectId: item.object_id, pollId: scope, newRolesHash: scope };
    case "manifest":
      return { kind: "manifest", objectId: item.object_id };
    default:
      return null;
  }
}

function ReceiptView({ core, network, id }: { core: Core; network: NetworkInfo; id: string | null }) {
  const { t } = useI18n();
  const { api, status } = useApp();
  const navigate = useNavigate();
  const [input, setInput] = useState(id ?? "");
  const [pendingTick, setPendingTick] = useState(0);
  const pending = useMemo(() => listPending(), [pendingTick]);
  const valid = id !== null && isHash32(id);
  const receipts = useLoad(() => (valid && id ? api.receipts(id) : Promise.resolve(null)), [api, id]);
  const local = useMemo(() => (valid && id ? getPending(id) : null), [id, valid, pendingTick]);
  // Keep the relay status current while the item is in flight (or kept here and unknown).
  const relayStatus = receipts.data?.items[0]?.status ?? null;
  const inFlight = relayStatus === null ? local !== null : !["CONFIRMED", "EXPIRED", "FAILED", "ALREADY_ON_CHAIN"].includes(relayStatus);
  useEffect(() => {
    if (!valid || !inFlight) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") receipts.reload();
    }, 5000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valid, inFlight, api, id]);
  const [resubmit, setResubmit] = useState<SubmitOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const receiptKey = status?.relay.receipt_key ?? network.receipt_key;
  const localJcs = useMemo(() => (local ? core.jcs(local.envelope) : null), [core, local]);
  const item = receipts.data?.items[0] ?? null;
  const check = item
    ? checkReceipt(core, item, {
        receiptKey,
        objectId: item.object_id,
        itemKind: item.message_kind,
        envelopeJcs: localJcs,
        genesis: network.network.genesis_hash,
      })
    : null;
  return (
    <div className="page">
      <h1>{t("receiptPage.title")}</h1>
      <p className="lead">{t("receiptPage.lead")}</p>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          const h = parseHash32(input);
          if (h) navigate(`/receipt/${h}`);
        }}
      >
        <label className="field grow">
          <span className="field-label">{t("receiptPage.id")}</span>
          <input className="mono" value={input} onChange={(e) => setInput(e.target.value)} placeholder="0x…" spellCheck={false} />
        </label>
        <button type="submit" className="btn btn-primary" disabled={!parseHash32(input)}>
          {t("receiptPage.lookup")}
        </button>
      </form>
      {id !== null && !valid && <Notice tone="bad">{t("receiptPage.badId")}</Notice>}
      {valid && id && (
        <Section title={t("receiptPage.relayTitle")}>
          {receipts.loading && !receipts.data && <Loading />}
          {receipts.error !== null && <ErrorView error={receipts.error} />}
          {receipts.data?.items.map((it, i) => (
            <div key={i}>
              <KV
                rows={[
                  [t("receiptPage.status"), <RelayStatusBadge key="s" status={it.status} />],
                  [t("receiptPage.kind"), it.message_kind],
                  ["object_id", <Hash key="o" value={it.object_id} />],
                  [t("track.tx"), <Hash key="t" value={it.tx_hash ?? null} />],
                  [t("receiptPage.block"), it.block_number ? `${it.block_number}` : "—"],
                  [t("receiptPage.error"), it.error ?? "—"],
                  [t("receiptPage.received"), it.receipt ? utcHuman(it.receipt.body.received_at_ms) : "—"],
                  [t("receiptPage.publishBy"), it.receipt?.body.publish_by_ms ? utcHuman(it.receipt.body.publish_by_ms) : "—"],
                ]}
              />
              {it.receipt && <JsonBlock value={it.receipt} summary={t("receiptPage.receiptJson")} />}
            </div>
          ))}
          {check && item && <ReceiptChecks check={check} item={item} />}
          {!local && item && targetFromItem(item) && <SubmissionTracker target={targetFromItem(item) as TrackTarget} initial={item} />}
          <ReceiptNote />
        </Section>
      )}
      {valid && local && (
        <Section title={t("receiptPage.localTitle")}>
          <p className="muted small">{t("receiptPage.localNote", { time: new Date(local.created_ms).toLocaleString() })}</p>
          <p>
            <code className="small">{local.label}</code>
          </p>
          {local.poll_id && (
            <p>
              <Link to={`/proposal/${local.poll_id}`}>{t("receiptPage.openProposal")}</Link>
            </p>
          )}
          <SubmissionTracker target={targetFor(core, local)} />
          <div className="row">
            <DownloadJsonButton filename={`omavote-${local.kind}-${local.id.slice(2, 18)}.json`} value={local.envelope} label={t("vote.downloadEnvelope")} />
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  setResubmit(await submitEnvelope(core, api, local.envelope as object));
                  // The relay now knows the item: refresh its status and receipt above.
                  receipts.reload();
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t("receiptPage.resubmit")}
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => {
                removePending(local.id);
                setPendingTick((x) => x + 1);
              }}
            >
              {t("receiptPage.forget")}
            </button>
          </div>
          <p className="muted small">{t("receiptPage.resubmitNote")}</p>
          {resubmit && !resubmit.ok && (
            <Notice tone="bad">
              <CodeBadge code={resubmit.code} /> {resubmit.detail}
            </Notice>
          )}
          {resubmit?.ok && <Notice tone="ok">{t("receiptPage.resubmitted", { status: resubmit.item.status })}</Notice>}
          {resubmit?.ok && (
            <ReceiptChecks
              check={checkReceipt(core, resubmit.item, {
                receiptKey,
                objectId: local.id,
                itemKind: resubmit.item.message_kind,
                envelopeJcs: resubmit.envelopeJcs,
                genesis: network.network.genesis_hash,
              })}
              item={resubmit.item}
            />
          )}
          <JsonBlock value={local.envelope} summary={t("receiptPage.envelopeJson")} />
        </Section>
      )}
      <Section title={t("receiptPage.pendingTitle", { n: pending.length })}>
        {pending.length === 0 ? (
          <p className="muted">{t("receiptPage.noPending")}</p>
        ) : (
          <ul className="plain pending-list">
            {pending.map((p) => (
              <li key={p.id}>
                <Link to={`/receipt/${p.id}`}>
                  <code>{p.id.slice(0, 12)}…</code>
                </Link>{" "}
                <span className="small">{p.label}</span> <span className="muted small">{new Date(p.created_ms).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="muted small">{t("receiptPage.pendingNote")}</p>
      </Section>
    </div>
  );
}

