import { useMemo, useState } from "react";
import { useI18n } from "../app/i18n";
import { useApp } from "../app/state";
import { useWallet } from "../app/wallet";
import { NeedCore } from "../components/gate";
import { SignTextView, WalletBar } from "../components/sign";
import { Check, CopyButton, DownloadJsonButton, Field, KV, Mono, Notice, Section, useErrorText } from "../components/ui";
import type { Core } from "../lib/core";
import { personalSign } from "../lib/eip1193";
import { parseSignature } from "../lib/hex";
import { buildSample, type Sample, type SampleKind } from "../lib/samples";

export function WalletCheckPage() {
  return <NeedCore>{(core) => <WalletCheck core={core} />}</NeedCore>;
}

interface Recovered {
  kind: "evm" | "ckb";
  address?: string;
  checksum_address?: string;
  public_key?: string;
  lock_args?: string;
  testnet_address?: string;
  mainnet_address?: string;
}

const SAMPLES: SampleKind[] = ["ballot", "grant", "hexlike"];
const OBSERVATIONS = ["fullText", "firstLine", "lineBreaks", "nonAscii", "origin"] as const;

function WalletCheck({ core }: { core: Core }) {
  const { t, tk } = useI18n();
  const { status } = useApp();
  const w = useWallet();
  const errorText = useErrorText();
  const [kind, setKind] = useState<SampleKind>("ballot");
  const [walletName, setWalletName] = useState<"MetaMask" | "Neuron">("MetaMask");
  const [notes, setNotes] = useState("");
  const [obs, setObs] = useState<Record<string, "yes" | "no" | "na">>({});
  const [sigInput, setSigInput] = useState("");
  const [signature, setSignature] = useState<string | null>(null);
  const [recovered, setRecovered] = useState<Recovered | null>(null);
  const [expected, setExpected] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const sample: Sample | null = useMemo(() => {
    try {
      return buildSample(core, kind);
    } catch {
      return null;
    }
  }, [core, kind]);

  const reset = () => {
    setSignature(null);
    setRecovered(null);
    setError(null);
  };

  const recoverCkb = (sig: string): Recovered => {
    if (!sample) throw new Error("no sample");
    const r = core.recoverCkb(sample.text, sig);
    const test = core.secp256k1Lock(core.knownNetwork("testnet"), r.public_key);
    const main = core.secp256k1Lock(core.knownNetwork("mainnet"), r.public_key);
    return { kind: "ckb", public_key: r.public_key, lock_args: r.lock_args, testnet_address: test.address, mainnet_address: main.address };
  };

  const signMetaMask = async () => {
    if (!sample || !w.provider || !w.address) return;
    setBusy(true);
    reset();
    try {
      const sig = await personalSign(w.provider, sample.text, w.address);
      setSignature(sig);
      const r = core.recoverEvm(sample.text, sig);
      setRecovered({ kind: "evm", address: r.address, checksum_address: r.checksum_address });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const checkNeuron = () => {
    reset();
    const p = parseSignature(sigInput, "ckb");
    if (!p.ok) {
      setError(new Error(t("sig.invalidFormat", { error: p.error })));
      return;
    }
    try {
      setSignature(p.signature);
      setRecovered(recoverCkb(p.signature));
    } catch (e) {
      setError(e);
    }
  };

  const matchesExpected = (() => {
    if (!recovered) return null;
    if (walletName === "MetaMask") return w.address ? recovered.address === w.address.toLowerCase() : null;
    const e = expected.trim().toLowerCase();
    if (!e) return null;
    return e === recovered.testnet_address || e === recovered.mainnet_address;
  })();

  const record = sample && signature && recovered
    ? {
        tool: "omavote-web wallet-check",
        core_version: core.version,
        server_version: status?.version ?? null,
        created_at: new Date().toISOString(),
        wallet: walletName,
        version_notes: notes,
        observations: obs,
        user_agent: typeof navigator !== "undefined" ? navigator.userAgent : null,
        sample: kind,
        summary: sample.summary,
        text: sample.text,
        text_hex: sample.textHex,
        request: walletName === "MetaMask" ? { method: "personal_sign", params: [sample.textHex, w.address] } : { method: "Neuron Sign Message", address: expected || null },
        signature,
        recovered,
        verified_against: walletName === "MetaMask" ? w.address : expected || null,
        matches: matchesExpected,
      }
    : null;

  return (
    <div className="page">
      <h1>{t("walletCheck.title")}</h1>
      <p className="lead">{t("walletCheck.lead")}</p>
      <Notice tone="info">{t("walletCheck.notReal")}</Notice>

      <Section title={t("walletCheck.sampleTitle")}>
        <div className="tabs" role="tablist">
          {SAMPLES.map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={kind === k}
              className={`tab${kind === k ? " active" : ""}`}
              onClick={() => {
                setKind(k);
                reset();
              }}
            >
              {tk(`walletCheck.sample.${k}`)}
            </button>
          ))}
        </div>
        <p className="muted small">{tk(`walletCheck.sampleHelp.${kind}`)}</p>
        {sample ? <SignTextView req={sample} /> : <Notice tone="bad">{t("walletCheck.sampleFailed")}</Notice>}
      </Section>

      <Section title={t("walletCheck.walletTitle")}>
        <div className="tabs" role="tablist">
          {(["MetaMask", "Neuron"] as const).map((n) => (
            <button
              key={n}
              type="button"
              role="tab"
              aria-selected={walletName === n}
              className={`tab${walletName === n ? " active" : ""}`}
              onClick={() => {
                setWalletName(n);
                reset();
              }}
            >
              {n}
            </button>
          ))}
        </div>
        {walletName === "MetaMask" ? (
          <div>
            <WalletBar />
            <button type="button" className="btn btn-primary" disabled={!w.address || busy || !sample} onClick={() => void signMetaMask()}>
              {t("walletCheck.signMetaMask")}
            </button>
            <p className="muted small">{t("walletCheck.metamaskHint")}</p>
          </div>
        ) : (
          <div>
            <ol className="neuron-steps">
              <li>
                {t("neuron.step1")} {sample && <CopyButton text={sample.text} label={t("sign.copyText")} small={false} />}
              </li>
              <li>{t("walletCheck.neuronStep2")}</li>
              <li>{t("neuron.step3")}</li>
              <li>{t("neuron.step4")}</li>
            </ol>
            <Field label={t("walletCheck.expectedAddress")} hint={t("walletCheck.expectedHint")}>
              <input className="mono" value={expected} onChange={(e) => setExpected(e.target.value)} spellCheck={false} />
            </Field>
            <Field label={t("neuron.signature")}>
              <textarea className="mono" rows={3} value={sigInput} onChange={(e) => setSigInput(e.target.value)} spellCheck={false} />
            </Field>
            <button type="button" className="btn btn-primary" disabled={sigInput.trim() === "" || !sample} onClick={checkNeuron}>
              {t("walletCheck.recover")}
            </button>
          </div>
        )}
        {error !== null && error !== undefined && <Notice tone="bad">{errorText(error)}</Notice>}
      </Section>

      {recovered && signature && (
        <Section title={t("walletCheck.resultTitle")}>
          <KV
            rows={[
              ["signature", <code key="s" className="break">{signature}</code>],
              ...(recovered.kind === "evm"
                ? ([[t("walletCheck.recoveredAddress"), <Mono key="a" value={recovered.checksum_address ?? ""} />]] as [string, JSX.Element][])
                : ([
                    [t("walletCheck.recoveredPubkey"), <Mono key="p" value={recovered.public_key ?? ""} />],
                    ["lock args", <code key="l">{recovered.lock_args}</code>],
                    [t("walletCheck.testnetAddress"), <Mono key="t" value={recovered.testnet_address ?? ""} />],
                    [t("walletCheck.mainnetAddress"), <Mono key="m" value={recovered.mainnet_address ?? ""} />],
                  ] as [string, JSX.Element][])),
            ]}
          />
          <Check ok={matchesExpected}>
            {matchesExpected === null ? t("walletCheck.noExpected") : matchesExpected ? t("walletCheck.matches") : t("walletCheck.mismatch")}
          </Check>
        </Section>
      )}

      <Section title={t("walletCheck.recordTitle")}>
        <p className="muted">{t("walletCheck.recordLead")}</p>
        <div className="observations">
          {OBSERVATIONS.map((o) => (
            <div key={o} className="row small">
              <span className="grow">{tk(`walletCheck.obs.${o}`)}</span>
              {(["yes", "no", "na"] as const).map((v) => (
                <label key={v} className="inline-field">
                  <input type="radio" name={`obs-${o}`} checked={obs[o] === v} onChange={() => setObs({ ...obs, [o]: v })} />
                  {tk(`walletCheck.answer.${v}`)}
                </label>
              ))}
            </div>
          ))}
        </div>
        <Field label={t("walletCheck.notes")} hint={t("walletCheck.notesHint")}>
          <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        {record ? (
          <DownloadJsonButton filename={`omavote-wallet-check-${walletName.toLowerCase()}-${kind}-${Date.now()}.json`} value={record} label={t("walletCheck.download")} />
        ) : (
          <p className="muted small">{t("walletCheck.signFirst")}</p>
        )}
      </Section>
    </div>
  );
}
