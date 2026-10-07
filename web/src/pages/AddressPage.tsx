import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useI18n } from "../app/i18n";
import { useApp, useLoad } from "../app/state";
import { useWallet } from "../app/wallet";
import { ActionBadge, BallotStatusBadge, GrantStateBadge, OutcomeBadge } from "../components/badges";
import { ControlPanel } from "../components/controls";
import { NeedCore } from "../components/gate";
import { WalletBar } from "../components/sign";
import { Badge, ErrorView, Hash, KV, Loading, Mono, Notice } from "../components/ui";
import type { Core } from "../lib/core";
import { lockKind, lockLabel, ownerAdapterFor, ownerFromAddress } from "../lib/flow";
import { formatCkb, pollTag, positionText, relativeText, shortText, utcHuman } from "../lib/format";
import type { ControlEnvelope, LockInfo, NetworkInfo } from "../lib/types";

export function AddressPage() {
  const { address } = useParams();
  return <NeedCore>{(core, network) => <AddressView core={core} network={network} address={address ?? null} />}</NeedCore>;
}

function AddressView({ core, network, address }: { core: Core; network: NetworkInfo; address: string | null }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const w = useWallet();
  const [input, setInput] = useState(address ?? "");
  const [useEvm, setUseEvm] = useState(false);
  const net = network.network;
  const parsed = useMemo(() => {
    if (!address) return null;
    try {
      return { owner: ownerFromAddress(core, net, address), error: null };
    } catch (e) {
      return { owner: null, error: e };
    }
  }, [address, core, net]);
  const evmLocks: LockInfo[] = useMemo(() => {
    if (!useEvm || !w.address) return [];
    try {
      return core.evmOwnerLocks(net, w.address);
    } catch {
      return [];
    }
  }, [useEvm, w.address, core, net]);
  return (
    <div className="page">
      <h1>{t("address.title")}</h1>
      <p className="lead">{t("address.lead")}</p>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          const a = input.trim();
          if (a) navigate(`/address/${a}`);
        }}
      >
        <label className="field grow">
          <span className="field-label">{t("vote.ckbAddress")}</span>
          <input className="mono" value={input} onChange={(e) => setInput(e.target.value)} placeholder={`${net.hrp}1q…`} spellCheck={false} />
        </label>
        <button type="submit" className="btn btn-primary">
          {t("address.show")}
        </button>
      </form>
      <details className="evm-owner" open={useEvm}>
        <summary onClick={() => setUseEvm(true)}>{t("address.useMetaMask")}</summary>
        <WalletBar purpose={t("address.metamaskPurpose")} />
        {useEvm && w.address && evmLocks.length === 0 && <Notice tone="warn">{t("vote.noEvmLocks")}</Notice>}
      </details>
      {parsed?.error !== null && parsed?.error !== undefined && <ErrorView error={parsed.error} />}
      {parsed?.owner && <OwnerCard core={core} network={network} lock={parsed.owner.lock} />}
      {evmLocks.map((l) => (
        <OwnerCard key={l.owner_id} core={core} network={network} lock={l} />
      ))}
    </div>
  );
}

function OwnerCard({ core, network, lock }: { core: Core; network: NetworkInfo; lock: LockInfo }) {
  const { t, lang } = useI18n();
  const { api } = useApp();
  const net = network.network;
  const policyHash = network.authorization_policy.hash;
  const power = useLoad(() => api.ownerPower(lock.owner_id), [api, lock.owner_id]);
  const ballots = useLoad(() => api.ownerBallots(lock.owner_id), [api, lock.owner_id]);
  const stream = useLoad(() => api.ownerAuthorizations(lock.owner_id, policyHash), [api, lock.owner_id, policyHash]);
  const adapter = ownerAdapterFor(net, lock.script);
  const clock = stream.data?.at?.clock_ms ?? power.data?.at?.clock_ms ?? null;
  const keyLabel = (d: ControlEnvelope["body"]["key_descriptor"]) => {
    if (!d) return "—";
    try {
      return core.key(d, net).key_display ?? d.kind;
    } catch {
      return d.kind;
    }
  };
  return (
    <section className="card owner-card">
      <div className="card-head">
        <h2>{t("address.owner")}</h2>
        <Badge tone="neutral">{lockLabel(net, lock.script)}</Badge>
      </div>
      <KV
        rows={[
          [t("address.address"), <Mono key="a" value={lock.address} />],
          ["owner_id", <Hash key="o" value={lock.owner_id} />],
          [t("address.adapter"), adapter ?? <span className="bad-text">{t("address.noAdapter", { kind: lockKind(net, lock.script) })}</span>],
          [
            t("address.feed"),
            <a key="f" href={api.ownerFeedUrl(lock.owner_id)} target="_blank" rel="noopener noreferrer">
              feed.atom
            </a>,
          ],
        ]}
      />

      <h3>{t("address.power")}</h3>
      {power.loading && !power.data && <Loading />}
      {power.error !== null && <ErrorView error={power.error} />}
      {power.data && (
        <div>
          <div className="big-amount">{formatCkb(power.data.total_shannon)}</div>
          <p className="muted small">
            {t("address.powerNote")} {power.data.at && t("common.asOfBlock", { n: power.data.at.number })}
          </p>
          {power.data.deposits.length > 0 && (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t("address.outpoint")}</th>
                    <th>{t("address.capacity")}</th>
                    <th>{t("address.created")}</th>
                  </tr>
                </thead>
                <tbody>
                  {power.data.deposits.map((d) => (
                    <tr key={`${d.tx_hash}:${d.index}`}>
                      <td>
                        <code title={d.tx_hash}>{d.tx_hash.slice(0, 12)}…</code>:{d.index}
                      </td>
                      <td>{formatCkb(d.capacity_shannon)}</td>
                      <td className="small">{d.created ? positionText(d.created) : d.created_height ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <h3>{t("address.ballots")}</h3>
      {ballots.error !== null && <ErrorView error={ballots.error} />}
      {ballots.data && ballots.data.polls.length === 0 && <p className="muted">{t("address.noBallots")}</p>}
      {ballots.data?.polls.map((p) => (
        <div key={p.poll_id} className="owner-poll">
          <Link to={`/proposal/${p.poll_id}`}>
            {p.title} <code>{pollTag(p.poll_id)}</code>
          </Link>
          <ul className="plain">
            {p.ballots.map((b) => (
              <li key={b.ballot_id + positionText(b.position)}>
                <ActionBadge action={b.action} /> <BallotStatusBadge status={b.status} />{" "}
                <span className="small">
                  {b.authority === "owner" ? t("vote.direct") : t("vote.delegated")} · {t("ballots.anchor")} {b.anchor_height} ·{" "}
                  {positionText(b.position)}
                </span>{" "}
                <Link to={`/receipt/${b.ballot_id}`} className="small">
                  {b.ballot_id.slice(0, 10)}…
                </Link>
              </li>
            ))}
          </ul>
          {p.ballots.some((b) => b.authority === "delegate") && <p className="muted small">{t("address.delegateNotice")}</p>}
        </div>
      ))}

      <h3>{t("address.authorizations")}</h3>
      {stream.error !== null && <ErrorView error={stream.error} />}
      {stream.data && (
        <div>
          {stream.data.current ? (
            <Notice tone="ok" title={t("address.currentGrant")}>
              <div>
                {t("address.key")} <Mono value={keyLabel(stream.data.current.key_descriptor)} />
              </div>
              <div>
                {t("address.expires")} <code>{utcHuman(stream.data.current.expires_at_ms)}</code>{" "}
                {clock && <span className="muted small">({relativeText(Number(stream.data.current.expires_at_ms) - Number(clock), lang)})</span>}{" "}
                <GrantStateBadge state={stream.data.current.state} />
              </div>
              <div className="small muted">
                {t("address.grantAnchor", { n: stream.data.current.anchor_height, pos: positionText(stream.data.current.position) })}
              </div>
            </Notice>
          ) : (
            <p className="muted">{t("address.noCurrentGrant")}</p>
          )}
          {stream.data.conflict && <Notice tone="bad">{t("address.conflict")}</Notice>}
          {(stream.data.barriers ?? []).length > 0 && (
            <div>
              <strong>{t("address.barriers")}</strong>
              <ul className="plain small">
                {(stream.data.barriers ?? []).map((b, i) => (
                  <li key={i}>
                    {t("address.barrierAt", { pos: positionText(b.position), time: utcHuman(b.clock_ms) })}
                  </li>
                ))}
              </ul>
              <p className="muted small">{t("address.barrierNote")}</p>
            </div>
          )}
          {stream.data.history.length > 0 && (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t("address.histAction")}</th>
                    <th>{t("address.key")}</th>
                    <th>{t("address.expires")}</th>
                    <th>{t("ballots.anchor")}</th>
                    <th>{t("ballots.position")}</th>
                    <th>{t("address.outcome")}</th>
                  </tr>
                </thead>
                <tbody>
                  {stream.data.history.map((h) => {
                    const b = h.envelope.body;
                    return (
                      <tr key={h.authorization_id}>
                        <td>
                          {h.action}
                          {b.revoke_mode && <div className="muted small">{b.revoke_mode}</div>}
                        </td>
                        <td className="small">
                          <code title={keyLabel(b.key_descriptor)}>{shortText(keyLabel(b.key_descriptor), 12, 8)}</code>
                        </td>
                        <td className="small">{b.expires_at_ms ? utcHuman(b.expires_at_ms) : "—"}</td>
                        <td>{h.anchor_height}</td>
                        <td className="small">{positionText(h.position)}</td>
                        <td>
                          <OutcomeBadge outcome={h.outcome} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted small">
            {t("address.maxAnchor", { n: stream.data.max_anchor_height ?? "—" })} · {t("address.historyNote")}
          </p>
        </div>
      )}

      <h3>{t("address.actions")}</h3>
      {adapter ? (
        <ControlPanel
          core={core}
          network={network}
          lock={lock}
          adapter={adapter}
          stream={stream.data}
          onDone={() => {
            stream.reload();
          }}
        />
      ) : (
        <Notice tone="warn">{t("address.noActions")}</Notice>
      )}
    </section>
  );
}
