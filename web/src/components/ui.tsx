import { useState, type ReactNode } from "react";
import { useI18n } from "../app/i18n";
import { ApiError } from "../lib/api";
import { copyText, downloadJson } from "../lib/browser";
import { CoreError } from "../lib/core";
import { WalletError } from "../lib/eip1193";
import { FlowError, RelayFailure, TimeoutError } from "../lib/flow";
import { shortHex } from "../lib/format";

export type Tone = "ok" | "warn" | "bad" | "info" | "neutral";

export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function Notice({ tone = "info", title, children }: { tone?: Tone; title?: ReactNode; children?: ReactNode }) {
  return (
    <div className={`notice notice-${tone}`} role={tone === "bad" ? "alert" : "note"}>
      {title && <div className="notice-title">{title}</div>}
      {children && <div className="notice-body">{children}</div>}
    </div>
  );
}

export function Loading({ label }: { label?: string }) {
  const { t } = useI18n();
  return <div className="loading">{label ?? t("common.loading")}</div>;
}

/** Human message for errors from the API, the core, the wallet or a flow. */
export function useErrorText(): (e: unknown) => string {
  const { t, tk } = useI18n();
  return (e: unknown) => {
    if (e instanceof ApiError) {
      if (e.code === "NETWORK") return t("err.network", { detail: e.detail });
      if (e.status === 404) return t("err.notFound", { detail: e.detail });
      return t("err.api", { code: e.code, detail: e.detail });
    }
    if (e instanceof WalletError) {
      if (e.kind === "rejected") return t("wallet.rejected");
      if (e.kind === "pending") return t("wallet.pending");
      if (e.kind === "no_wallet") return t("wallet.none");
      return t("wallet.error", { detail: e.message });
    }
    if (e instanceof FlowError) return tk(e.key, e.params);
    if (e instanceof CoreError) return t("err.core", { detail: e.message });
    if (e instanceof RelayFailure) return t("err.relayFailed", { status: e.item.status, detail: e.item.error ?? "" });
    if (e instanceof TimeoutError) return t("err.timeout", { detail: e.message });
    if (e instanceof Error) return e.message;
    return String(e);
  };
}

export function ErrorView({ error, title }: { error: unknown; title?: ReactNode }) {
  const text = useErrorText();
  if (!error) return null;
  return (
    <Notice tone="bad" title={title}>
      {text(error)}
    </Notice>
  );
}

export function CopyButton({ text, label, small = true }: { text: string; label?: string; small?: boolean }) {
  const { t } = useI18n();
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  return (
    <button
      type="button"
      className={small ? "btn btn-small" : "btn"}
      onClick={async () => {
        const ok = await copyText(text);
        setState(ok ? "ok" : "fail");
        setTimeout(() => setState("idle"), 1500);
      }}
    >
      {state === "ok" ? t("common.copied") : state === "fail" ? t("common.copyFailed") : label ?? t("common.copy")}
    </button>
  );
}

/** Monospace hash, shortened, with the full value as a tooltip and a copy button. */
export function Hash({ value, full = false, copy = true }: { value: string | null | undefined; full?: boolean; copy?: boolean }) {
  if (!value) return <span className="muted">—</span>;
  return (
    <span className="hash">
      <code title={value}>{full ? value : shortHex(value, 8, 6)}</code>
      {copy && <CopyButton text={value} />}
    </span>
  );
}

/** Full-width wrapping value (addresses) with copy. */
export function Mono({ value, copy = true }: { value: string | null | undefined; copy?: boolean }) {
  if (!value) return <span className="muted">—</span>;
  return (
    <span className="mono-wrap">
      <code>{value}</code>
      {copy && <CopyButton text={value} />}
    </span>
  );
}

export function JsonBlock({ value, summary }: { value: unknown; summary?: ReactNode }) {
  const { t } = useI18n();
  return (
    <details className="json">
      <summary>{summary ?? t("common.showJson")}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

export function DownloadJsonButton({ filename, value, label }: { filename: string; value: unknown; label?: string }) {
  const { t } = useI18n();
  return (
    <button type="button" className="btn" onClick={() => downloadJson(filename, value)}>
      {label ?? t("common.download")}
    </button>
  );
}

export function KV({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="kv">
      {rows.map(([k, v], i) => (
        <div className="kv-row" key={i}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Section({ title, children, actions, id }: { title: ReactNode; children: ReactNode; actions?: ReactNode; id?: string }) {
  return (
    <section className="card" id={id}>
      <div className="card-head">
        <h2>{title}</h2>
        {actions && <div className="card-actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className={`field${error ? " field-error" : ""}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
      {error && <span className="field-err">{error}</span>}
    </label>
  );
}

export type StepState = "todo" | "active" | "done" | "failed" | "skipped";

export function Steps({ steps }: { steps: { label: ReactNode; state: StepState; detail?: ReactNode }[] }) {
  return (
    <ol className="steps">
      {steps.map((s, i) => (
        <li key={i} className={`step step-${s.state}`}>
          <span className="step-mark" aria-hidden="true">
            {s.state === "done" ? "✓" : s.state === "failed" ? "✕" : s.state === "active" ? "…" : s.state === "skipped" ? "–" : i + 1}
          </span>
          <span className="step-label">{s.label}</span>
          {s.detail && <div className="step-detail">{s.detail}</div>}
        </li>
      ))}
    </ol>
  );
}

export function Check({ ok, children }: { ok: boolean | null; children: ReactNode }) {
  return (
    <div className={`check ${ok === null ? "check-na" : ok ? "check-ok" : "check-bad"}`}>
      <span className="check-mark" aria-hidden="true">
        {ok === null ? "–" : ok ? "✓" : "✕"}
      </span>
      <span>{children}</span>
    </div>
  );
}
