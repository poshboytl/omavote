import { useState } from "react";
import { useI18n } from "../app/i18n";
import { useApp } from "../app/state";
import { Field, KV, Notice, Section } from "../components/ui";
import { normalizeApiBase } from "../lib/api";
import { configuredTipSource, fetchAnchor } from "../lib/flow";
import { KEYS, writeString } from "../lib/storage";
import { compareTips, fetchIndependentTip, normalizeTipSource, sourceRequired, TipCheckError } from "../lib/tipcheck";

/** Independent tip source compared with the server's anchor before signing (docs/11 §5). */
function TipSourceSection() {
  const { t } = useI18n();
  const { api, status } = useApp();
  const [input, setInput] = useState(configuredTipSource());
  const [saved, setSaved] = useState(configuredTipSource());
  const [result, setResult] = useState<{ tone: "ok" | "warn" | "bad"; text: string } | null>(null);
  const normalized = normalizeTipSource(input);
  const test = async () => {
    setResult(null);
    if (!saved || !status) return;
    try {
      const anchor = await fetchAnchor(api);
      const tip = await fetchIndependentTip(saved, status.network.genesis_hash);
      const cmp = compareTips(anchor, tip);
      setResult(
        cmp === "match"
          ? { tone: "ok", text: t("settings.tipOk", { n: anchor.number }) }
          : { tone: "warn", text: t("settings.tipDiff", { ours: `${anchor.number} ${anchor.hash.slice(0, 12)}`, theirs: `${tip.height} ${tip.hash.slice(0, 12)}` }) },
      );
    } catch (e) {
      setResult({ tone: "bad", text: e instanceof TipCheckError ? `${e.code}: ${e.message}` : String(e) });
    }
  };
  return (
    <Section title={t("settings.tipTitle")}>
      <p>{t("settings.tipLead")}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (normalized === null) return;
          writeString(KEYS.tipSource, normalized === "" ? null : normalized);
          setSaved(normalized);
          setResult({ tone: "ok", text: t("settings.saved") });
        }}
      >
        <Field label={t("settings.tipSource")} hint={t("settings.tipHint")} error={normalized === null ? t("settings.tipInvalid") : undefined}>
          <input className="mono" value={input} onChange={(e) => setInput(e.target.value)} placeholder="https://other-relay.example/api/status" spellCheck={false} />
        </Field>
        <div className="row">
          <button type="submit" className="btn btn-primary" disabled={normalized === null}>
            {t("settings.save")}
          </button>
          <button type="button" className="btn" disabled={!saved} onClick={() => void test()}>
            {t("settings.tipTest")}
          </button>
        </div>
      </form>
      {result && <Notice tone={result.tone}>{result.text}</Notice>}
      {!saved && (
        <Notice tone={status && sourceRequired(status.network.name) ? "bad" : "warn"}>
          {status && sourceRequired(status.network.name) ? t("settings.tipNoneRequired") : t("settings.tipNone")}
        </Notice>
      )}
    </Section>
  );
}

export function SettingsPage() {
  const { t, lang, setLang } = useI18n();
  const { apiBase, setApiBase, status, statusError } = useApp();
  const [input, setInput] = useState(apiBase);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const normalized = normalizeApiBase(input);
  return (
    <div className="page">
      <h1>{t("settings.title")}</h1>
      <Section title={t("settings.apiTitle")}>
        <p>{t("settings.apiLead")}</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const ok = setApiBase(input);
            setMsg(ok ? { ok: true, text: t("settings.saved") } : { ok: false, text: t("settings.invalid") });
          }}
        >
          <Field label={t("settings.apiBase")} hint={t("settings.apiHint")} error={normalized === null ? t("settings.invalid") : undefined}>
            <input className="mono" value={input} onChange={(e) => setInput(e.target.value)} placeholder="https://vote.example.org" spellCheck={false} />
          </Field>
          <div className="row">
            <button type="submit" className="btn btn-primary" disabled={normalized === null}>
              {t("settings.save")}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setInput("");
                setApiBase("");
                writeString(KEYS.apiBase, null);
                setMsg({ ok: true, text: t("settings.reset") });
              }}
            >
              {t("settings.useSameOrigin")}
            </button>
          </div>
        </form>
        {msg && <Notice tone={msg.ok ? "ok" : "bad"}>{msg.text}</Notice>}
        <KV
          rows={[
            [t("settings.current"), apiBase || t("settings.sameOrigin")],
            [t("settings.reachable"), statusError ? statusError : status ? `${status.network.name} · ${status.version}` : "…"],
          ]}
        />
        <Notice tone="warn">{t("settings.mirrorNote")}</Notice>
      </Section>
      <TipSourceSection />
      <Section title={t("settings.langTitle")}>
        <div className="row">
          <label className="inline-field">
            <input type="radio" checked={lang === "zh"} onChange={() => setLang("zh")} /> 中文
          </label>
          <label className="inline-field">
            <input type="radio" checked={lang === "en"} onChange={() => setLang("en")} /> English
          </label>
        </div>
      </Section>
      <Section title={t("settings.storageTitle")}>
        <p>{t("settings.storageLead")}</p>
      </Section>
    </div>
  );
}
