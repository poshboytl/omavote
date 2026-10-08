import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Lang } from "../lib/format";
import { detectLang, translate, type MessageKey, type Params } from "../lib/i18n";
import { KEYS, readString, writeString } from "../lib/storage";

interface I18nValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  /** Known dictionary key (checked at compile time). */
  t: (key: MessageKey, params?: Params) => string;
  /** Dynamic key such as `pollStatus.<CODE>`; unknown keys fall back to the raw code. */
  tk: (key: string, params?: Params) => string;
  /** Dynamic help text; unknown keys give undefined (no tooltip). */
  th: (key: string, params?: Params) => string | undefined;
}

const Ctx = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => detectLang(readString(KEYS.lang, "")));
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    writeString(KEYS.lang, l);
  }, []);
  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  }, [lang]);
  const value = useMemo<I18nValue>(
    () => ({
      lang,
      setLang,
      t: (key, params) => translate(lang, key, params),
      tk: (key, params) => translate(lang, key, params),
      th: (key, params) => {
        const s = translate(lang, key, params, "");
        return s === "" ? undefined : s;
      },
    }),
    [lang, setLang],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18nValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useI18n outside I18nProvider");
  return v;
}
