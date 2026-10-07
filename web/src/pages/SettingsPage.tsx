import { useState } from "react";
import { useI18n } from "../app/i18n";
import { useApp } from "../app/state";
import { Field, KV, Notice, Section } from "../components/ui";
import { normalizeApiBase } from "../lib/api";
import { KEYS, writeString } from "../lib/storage";

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
