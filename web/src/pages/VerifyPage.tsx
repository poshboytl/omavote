import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useI18n } from "../app/i18n";
import { useApp, useLoad } from "../app/state";
import { AttestationBadge } from "../components/badges";
import { NeedCore } from "../components/gate";
import { Check, CopyButton, ErrorView, KV, Loading, Notice, Section } from "../components/ui";
import { readFileText } from "../lib/browser";
import type { Core } from "../lib/core";
import { verifyKeySig, verifyOwnerSig } from "../lib/flow";
import { pollTag } from "../lib/format";
import { isHash32, parseHash32 } from "../lib/hex";
import type { BallotEnvelope, ControlEnvelope, NetworkInfo, ProposalDetail, RecordsView } from "../lib/types";

export function VerifyPage() {
  const { id } = useParams();
  return <NeedCore>{(core, network) => <VerifyView core={core} network={network} id={id ? id.toLowerCase() : null} />}</NeedCore>;
}

function Cmd({ text }: { text: string }) {
  return (
    <div className="cmd">
      <pre>{text}</pre>
      <CopyButton text={text} />
    </div>
  );
}

/** The attested result hash: the highest-anchor RESULT_ATTESTATION record of the poll. */
function attestedHash(records: RecordsView | null): string | null {
  const att = (records?.records ?? []).filter((r) => r.record_type === "RESULT_ATTESTATION");
  if (att.length === 0) return null;
  const max = att.reduce((a, b) => (BigInt(a.anchor_height) >= BigInt(b.anchor_height) ? a : b));
  return max.detail.result_hash ?? null;
}

function VerifyView({ core, network, id }: { core: Core; network: NetworkInfo; id: string | null }) {
  const { t } = useI18n();
  const { api } = useApp();
  const navigate = useNavigate();
  const [input, setInput] = useState(id ?? "");
  const pollId = id && isHash32(id) ? id : null;
  const detail = useLoad(() => (pollId ? api.proposal(pollId) : Promise.resolve(null)), [api, pollId]);
  const records = useLoad(() => (pollId ? api.records(pollId) : Promise.resolve(null)), [api, pollId]);
  const [mine, setMine] = useState("");
  const [bundle, setBundle] = useState<{ name: string; pollId: string | null; resultHash: string | null } | null>(null);
  const [bundleError, setBundleError] = useState<unknown>(null);
  const serverHash = detail.data?.result_hash ?? null;
  const attested = attestedHash(records.data);
  const myHash = parseHash32(mine);
  const pid = pollId ?? "0x<poll_id>";
  const roles = network.initial_roles_hash ? ` --initial-roles-hash ${network.initial_roles_hash}` : "";
  return (
    <div className="page">
      <h1>{t("verifyPage.title")}</h1>
      <p className="lead">{t("verifyPage.lead")}</p>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          const h = parseHash32(input);
          if (h) navigate(`/verify/${h}`);
        }}
      >
        <label className="field grow">
          <span className="field-label">{t("verifyPage.pollId")}</span>
          <input className="mono" value={input} onChange={(e) => setInput(e.target.value)} placeholder="0x…" spellCheck={false} />
        </label>
        <button type="submit" className="btn btn-primary" disabled={!parseHash32(input)}>
          {t("verifyPage.select")}
        </button>
      </form>

      <Section title={t("verifyPage.rustTitle")}>
        <p>{t("verifyPage.rustBody")}</p>
        <Cmd text={`omavote verify --rpc http://127.0.0.1:8114 --poll ${pid}${roles} --check-clock --out bundle.json`} />
        <p className="muted small">{t("verifyPage.rustNote")}</p>
      </Section>

      <Section title={t("verifyPage.tsTitle")}>
        <p>{t("verifyPage.tsBody")}</p>
        <Cmd text={`omavote verify --rpc http://127.0.0.1:8114${roles} --dump-blocks blocks.json\ncd verifier-ts && npm ci && npm run build\nnode dist/cli.js replay ../blocks.json --poll ${pid}`} />
        <p className="muted small">{t("verifyPage.tsNote")}</p>
      </Section>

      {pollId && (
        <Section title={t("verifyPage.compareTitle", { tag: pollTag(pollId) })}>
          {detail.loading && !detail.data && <Loading />}
          {detail.error !== null && <ErrorView error={detail.error} />}
          {detail.data && <CompareTable detail={detail.data} serverHash={serverHash} attested={attested} myHash={myHash} bundleHash={bundle?.resultHash ?? null} />}
          <label className="field">
            <span className="field-label">{t("verifyPage.yourHash")}</span>
            <input className="mono" value={mine} onChange={(e) => setMine(e.target.value)} placeholder="0x…" spellCheck={false} />
          </label>
          <label className="field">
            <span className="field-label">{t("verifyPage.bundleFile")}</span>
            <input
              type="file"
              accept="application/json,.json"
              onChange={async (e) => {
                setBundle(null);
                setBundleError(null);
                const f = e.target.files?.[0];
                if (!f) return;
                try {
                  const v = JSON.parse(await readFileText(f)) as { result_hash?: string | null; poll?: { poll_id?: string } };
                  setBundle({ name: f.name, pollId: v.poll?.poll_id ?? null, resultHash: v.result_hash ?? null });
                } catch (err) {
                  setBundleError(err);
                }
              }}
            />
            <span className="field-hint">{t("verifyPage.bundleHint")}</span>
          </label>
          {bundleError !== null && <ErrorView error={bundleError} />}
          {bundle && bundle.pollId !== pollId && <Notice tone="bad">{t("verifyPage.bundleOtherPoll", { poll: bundle.pollId ?? "?" })}</Notice>}
          <p className="muted small">{t("verifyPage.compareNote")}</p>
        </Section>
      )}

      <EnvelopeCheck core={core} network={network} />
    </div>
  );
}

function CompareTable({
  detail,
  serverHash,
  attested,
  myHash,
  bundleHash,
}: {
  detail: ProposalDetail;
  serverHash: string | null;
  attested: string | null;
  myHash: string | null;
  bundleHash: string | null;
}) {
  const { t } = useI18n();
  const same = (a: string | null, b: string | null) => (a && b ? a === b : null);
  return (
    <div>
      <KV
        rows={[
          [t("verifyPage.status"), detail.status],
          [t("verifyPage.serverHash"), serverHash ? <code key="s">{serverHash}</code> : <span className="muted">{t("verifyPage.noResult")}</span>],
          [t("verifyPage.attestedHash"), attested ? <code key="a">{attested}</code> : <span className="muted">{t("verifyPage.noAttestation")}</span>],
          [t("verifyPage.attestation"), <AttestationBadge key="b" v={detail.attestation} />],
          [t("verifyPage.yourHash"), myHash ? <code key="m">{myHash}</code> : "—"],
          [t("verifyPage.bundleHash"), bundleHash ? <code key="f">{bundleHash}</code> : "—"],
        ]}
      />
      {myHash && <Check ok={same(myHash, serverHash)}>{t("verifyPage.mineVsServer")}</Check>}
      {myHash && <Check ok={same(myHash, attested)}>{t("verifyPage.mineVsAttested")}</Check>}
      {bundleHash && <Check ok={same(bundleHash, serverHash)}>{t("verifyPage.bundleVsServer")}</Check>}
      {serverHash && attested && <Check ok={same(serverHash, attested)}>{t("verifyPage.serverVsAttested")}</Check>}
      {!detail.result_hash && <Notice tone="info">{t("verifyPage.openPoll")}</Notice>}
      <p>
        <Link to={`/proposal/${detail.poll_id}`}>{t("receiptPage.openProposal")}</Link>
      </p>
    </div>
  );
}

/** Check a signed envelope locally: rebuild the exact text with the core and verify the signature. */
function EnvelopeCheck({ core, network }: { core: Core; network: NetworkInfo }) {
  const { t } = useI18n();
  const { api } = useApp();
  const [text, setText] = useState("");
  const [result, setResult] = useState<{ ok: boolean; detail: string; id: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const net = network.network;
  const parsed = useMemo(() => {
    try {
      return text.trim() ? (JSON.parse(text) as { body?: { message_kind?: string } }) : null;
    } catch {
      return null;
    }
  }, [text]);
  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const kind = parsed?.body?.message_kind;
      if (kind === "ballot") {
        const env = parsed as unknown as BallotEnvelope;
        const d = await api.proposal(env.body.poll_id);
        const out = core.ballot(net, d.manifest_payload.manifest, env.body);
        let v;
        if (env.body.authority === "owner") {
          v = verifyOwnerSig(core, net, env.body.auth_adapter, env.body.owner_lock, out.text, env.proof.signature);
        } else {
          const g = (await api.authorization(env.body.authorization_id ?? "")) as { grant?: { key_descriptor: Parameters<typeof verifyKeySig>[1] } | null };
          if (!g.grant) throw new Error(t("verifyPage.grantUnknown"));
          v = verifyKeySig(core, g.grant.key_descriptor, out.text, env.proof.signature);
        }
        setResult({ ok: v.ok, detail: v.error ?? out.summary, id: out.ballot_id });
      } else if (kind === "authorization_control") {
        const env = parsed as unknown as ControlEnvelope;
        const out = core.control(net, env.body);
        const v = verifyOwnerSig(core, net, env.body.owner_auth_adapter, env.body.owner_lock, out.text, env.proof.signature);
        setResult({ ok: v.ok, detail: v.error ?? out.summary, id: out.authorization_id });
      } else {
        throw new Error(t("verifyPage.envelopeKind"));
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title={t("verifyPage.envelopeTitle")}>
      <p className="muted">{t("verifyPage.envelopeLead")}</p>
      <textarea className="mono" rows={6} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} placeholder='{"body": {...}, "proof": {"signature": "0x..."}}' />
      <button type="button" className="btn" disabled={busy || !parsed} onClick={() => void run()}>
        {t("verifyPage.envelopeCheck")}
      </button>
      {error !== null && <ErrorView error={error} />}
      {result && (
        <div>
          <Check ok={result.ok}>{result.ok ? t("verifyPage.envelopeOk", { summary: result.detail }) : t("sig.verifyFailed", { detail: result.detail })}</Check>
          <div className="small">
            id <code>{result.id}</code> · <Link to={`/receipt/${result.id}`}>{t("track.receiptPage")}</Link>
          </div>
        </div>
      )}
      <p className="muted small">{t("verifyPage.envelopeNote")}</p>
    </Section>
  );
}
