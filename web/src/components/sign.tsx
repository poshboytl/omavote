import { useState, type ReactNode } from "react";
import { useI18n } from "../app/i18n";
import { useApp } from "../app/state";
import { useWallet } from "../app/wallet";
import { assessSync, type SignRequest, type SyncAssessment } from "../lib/flow";
import { parseSignature, type SignatureKind } from "../lib/hex";
import type { VerifyResult } from "../lib/types";
import { Check, CopyButton, ErrorView, Mono, Notice, useErrorText } from "./ui";

/** The exact text the wallet will sign, with its first-line summary highlighted. */
export function SignTextView({ req, caption }: { req: SignRequest; caption?: ReactNode }) {
  const { t } = useI18n();
  const lines = req.text.split("\n");
  return (
    <div className="signtext">
      {caption && <div className="signtext-caption">{caption}</div>}
      <div className="signtext-summary">
        <div className="signtext-summary-label">{t("sign.summary")}</div>
        <code className="signtext-summary-text">{req.summary}</code>
        <div className="muted small">{t("sign.summaryHint")}</div>
      </div>
      <div className="signtext-head">
        <strong>{t("sign.fullText")}</strong>
        <span className="muted small">{t("sign.byteCount", { bytes: req.byteLength, lines: lines.length })}</span>
        <CopyButton text={req.text} label={t("sign.copyText")} />
      </div>
      <ol className="signtext-lines" aria-label={t("sign.fullText")}>
        {lines.map((l, i) => (
          <li key={i} className={i === 0 ? "first" : undefined}>
            <code>{l === "" ? " " : l}</code>
          </li>
        ))}
      </ol>
      <details className="signtext-hex">
        <summary>{t("sign.showBytes")}</summary>
        <pre>{req.textHex}</pre>
        <div className="muted small">{t("sign.bytesHint")}</div>
      </details>
    </div>
  );
}

/** Check the server's sync state right before signing (docs/11 §5). */
export function useSyncCheck(): {
  assessment: SyncAssessment | null;
  checking: boolean;
  check: () => Promise<SyncAssessment | null>;
} {
  const { refreshStatus } = useApp();
  const [assessment, setAssessment] = useState<SyncAssessment | null>(null);
  const [checking, setChecking] = useState(false);
  return {
    assessment,
    checking,
    check: async () => {
      setChecking(true);
      try {
        const s = await refreshStatus();
        const a = s
          ? assessSync(s, Date.now(), { needIntake: true })
          : { ok: false, issues: [{ key: "sync.notSynced" as const }], lagBlocks: null };
        setAssessment(a);
        return a;
      } finally {
        setChecking(false);
      }
    },
  };
}

export function SyncIssues({ assessment, strict }: { assessment: SyncAssessment | null; strict?: boolean }) {
  const { t, tk } = useI18n();
  if (!assessment || assessment.ok) return null;
  return (
    <Notice tone={strict ? "bad" : "warn"} title={strict ? t("sync.blockedTitle") : t("sync.warnTitle")}>
      <ul>
        {assessment.issues.map((i, n) => (
          <li key={n}>{tk(i.key, i as unknown as Record<string, string>)}</li>
        ))}
      </ul>
      <p>{strict ? t("sync.blockedBody") : t("sync.warnBody")}</p>
    </Notice>
  );
}

/** Connect / show the EIP-1193 wallet (MetaMask). */
export function WalletBar({ purpose }: { purpose?: ReactNode }) {
  const { t } = useI18n();
  const w = useWallet();
  const errorText = useErrorText();
  const many = (w.providers?.length ?? 0) > 1;
  return (
    <div className="walletbar">
      {purpose && <p className="muted">{purpose}</p>}
      {w.providers !== null && w.providers.length === 0 && <Notice tone="warn">{t("wallet.none")}</Notice>}
      {many && (
        <label className="inline-field">
          <span>{t("wallet.choose")}</span>
          <select value={w.selected?.info.uuid ?? ""} onChange={(e) => w.select(e.target.value)}>
            {w.providers?.map((p) => (
              <option key={p.info.uuid} value={p.info.uuid}>
                {p.info.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {w.address ? (
        <div className="walletbar-connected">
          <span className="muted">{t("wallet.connectedAs", { name: w.selected?.info.name ?? "wallet" })}</span>
          <Mono value={w.address} />
          <button type="button" className="btn btn-small" onClick={() => void w.connect()}>
            {t("wallet.refresh")}
          </button>
        </div>
      ) : (
        <button type="button" className="btn btn-primary" disabled={w.busy || w.providers?.length === 0} onClick={() => void w.connect()}>
          {w.busy ? t("wallet.connecting") : t("wallet.connect", { name: w.selected?.info.name ?? "MetaMask" })}
        </button>
      )}
      {w.error !== null && w.error !== undefined && <Notice tone="bad">{errorText(w.error)}</Notice>}
      <p className="muted small">{t("wallet.noKeys")}</p>
    </div>
  );
}

/**
 * Neuron copy-paste signing: the user copies the exact text, signs it with
 * Neuron's Sign/Verify Message for `address`, and pastes the 65-byte signature.
 */
export function NeuronSignBox({
  req,
  address,
  verify,
  onVerified,
  kind = "ckb",
  disabled,
  submits = false,
}: {
  req: SignRequest;
  address: string | null;
  verify: (signature: string) => VerifyResult;
  onVerified: (signature: string) => void;
  kind?: SignatureKind;
  disabled?: boolean;
  /** The verified signature is submitted right away (label the button accordingly). */
  submits?: boolean;
}) {
  const { t } = useI18n();
  const [input, setInput] = useState("");
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const run = () => {
    setResult(null);
    const p = parseSignature(input, kind);
    if (!p.ok) {
      setParseError(
        p.error === "length"
          ? t("sig.length", { bytes: p.bytes ?? 0 })
          : p.error === "recovery"
            ? t("sig.recovery", { v: p.v ?? 0 })
            : p.error === "empty"
              ? t("sig.empty")
              : t("sig.notHex"),
      );
      return;
    }
    setParseError(null);
    const r = verify(p.signature);
    setResult(r);
    if (r.ok) onVerified(p.signature);
  };
  return (
    <div className="neuron">
      <ol className="neuron-steps">
        <li>
          {t("neuron.step1")} <CopyButton text={req.text} label={t("sign.copyText")} small={false} />
        </li>
        <li>
          {t("neuron.step2")}
          {address && (
            <div className="neuron-address">
              <span className="muted">{t("neuron.chooseAddress")}</span> <Mono value={address} />
            </div>
          )}
        </li>
        <li>{t("neuron.step3")}</li>
        <li>{t("neuron.step4")}</li>
      </ol>
      <Notice tone="warn">{t("neuron.noEdit")}</Notice>
      <label className="field">
        <span className="field-label">{t("neuron.signature")}</span>
        <textarea
          className="mono"
          rows={3}
          spellCheck={false}
          autoComplete="off"
          placeholder="0x…"
          value={input}
          disabled={disabled}
          onChange={(e) => {
            setInput(e.target.value);
            setResult(null);
            setParseError(null);
          }}
        />
        <span className="field-hint">{t("neuron.signatureHint")}</span>
      </label>
      <button type="button" className="btn btn-primary" disabled={disabled || input.trim() === ""} onClick={run}>
        {submits ? t("neuron.verifySubmit") : t("neuron.verify")}
      </button>
      {parseError && <Notice tone="bad">{parseError}</Notice>}
      {result && (
        <Check ok={result.ok}>{result.ok ? t("sig.verifiedLocally") : t("sig.verifyFailed", { detail: result.error ?? "" })}</Check>
      )}
    </div>
  );
}

export function ReceiptNote() {
  const { t } = useI18n();
  return <Notice tone="info">{t("receipt.notInclusion")}</Notice>;
}

export function MaybeError({ error }: { error: unknown }) {
  return error ? <ErrorView error={error} /> : null;
}
