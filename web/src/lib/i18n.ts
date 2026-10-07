// Minimal dictionary-based i18n: `{name}` placeholders, Chinese and English.

import { en, type MessageKey } from "../i18n/en";
import { zh } from "../i18n/zh";
import type { Lang } from "./format";

export type { MessageKey };
export type Params = Record<string, string | number | bigint | null | undefined>;

export const DICTS: Record<Lang, Record<MessageKey, string>> = { en, zh };
export const LANGS: Lang[] = ["zh", "en"];

export function isMessageKey(k: string): k is MessageKey {
  return Object.prototype.hasOwnProperty.call(en, k);
}

export function interpolate(template: string, params: Params = {}): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (m, name: string) => {
    const v = params[name];
    return v === undefined || v === null ? m : String(v);
  });
}

/**
 * Translate a key. Unknown keys (dynamic codes such as `pollStatus.SOMETHING_NEW`)
 * fall back to `fallback`, or to the key without its namespace (the raw code).
 */
export function translate(lang: Lang, key: string, params?: Params, fallback?: string): string {
  const dict = DICTS[lang];
  if (isMessageKey(key)) return interpolate(dict[key], params);
  if (fallback !== undefined) return fallback;
  const dot = key.indexOf(".");
  return interpolate(dot >= 0 ? key.slice(dot + 1) : key, params);
}

/** Placeholder names used by a template, sorted (for dictionary parity checks). */
export function placeholders(template: string): string[] {
  const out = new Set<string>();
  for (const m of template.matchAll(/\{([a-zA-Z0-9_]+)\}/g)) if (m[1]) out.add(m[1]);
  return [...out].sort();
}

export function detectLang(stored: string | null, navigatorLanguages: readonly string[] = []): Lang {
  if (stored === "zh" || stored === "en") return stored;
  for (const l of navigatorLanguages) {
    const s = l.toLowerCase();
    if (s.startsWith("zh")) return "zh";
    if (s.startsWith("en")) return "en";
  }
  return "en";
}
