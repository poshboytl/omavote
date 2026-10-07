// Display formatting. Amounts are exact (BigInt); nothing here decides a result.

export type Lang = "en" | "zh";

export const SHANNON_PER_CKB = 100_000_000n;
export const DAY_MS = 86_400_000;

const DEC_RE = /^(0|[1-9][0-9]*)$/;

export function isDec(s: unknown): s is string {
  return typeof s === "string" && DEC_RE.test(s);
}

export function big(s: string | null | undefined): bigint {
  return s && DEC_RE.test(s) ? BigInt(s) : 0n;
}

function group(int: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Exact decimal CKB, the same rendering as the signed texts (docs/03 §5 rule 3):
 * integer part, then up to eight fractional digits without trailing zeros.
 */
export function ckbExact(shannon: string | bigint): string {
  const v = typeof shannon === "bigint" ? shannon : big(shannon);
  const int = v / SHANNON_PER_CKB;
  const frac = v % SHANNON_PER_CKB;
  if (frac === 0n) return int.toString();
  return `${int}.${frac.toString().padStart(8, "0").replace(/0+$/, "")}`;
}

/** Exact CKB with thousands separators for reading, e.g. `1,000,000.5 CKB`. */
export function formatCkb(shannon: string | bigint, unit = true): string {
  const exact = ckbExact(shannon);
  const [int, frac] = exact.split(".");
  const s = group(int ?? "0") + (frac ? `.${frac}` : "");
  return unit ? `${s} CKB` : s;
}

/** Parse a user-entered CKB amount (at most 8 decimals, `,` and `_` separators allowed). */
export function ckbToShannon(input: string): string | null {
  const s = input.trim().replace(/[,_\s]/g, "");
  const m = /^([0-9]+)(?:\.([0-9]{1,8}))?$/.exec(s);
  if (!m) return null;
  const int = BigInt(m[1] ?? "0");
  const frac = BigInt((m[2] ?? "").padEnd(8, "0") || "0");
  return (int * SHANNON_PER_CKB + frac).toString();
}

/** `YYYY-MM-DDTHH:mm:ss.SSSZ`, the protocol's UTC rendering of chain-clock thresholds. */
export function utcIso(ms: string | number | bigint): string {
  const n = Number(ms);
  if (!Number.isFinite(n)) return "—";
  return new Date(n).toISOString();
}

/** `YYYY-MM-DD HH:mm:ss UTC` for reading. */
export function utcHuman(ms: string | number | bigint): string {
  const iso = utcIso(ms);
  if (iso === "—") return iso;
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

/** `0x1234ab…cdef` */
export function shortHex(h: string | null | undefined, head = 6, tail = 4): string {
  if (!h) return "—";
  if (h.length <= 2 + head + tail + 1) return h;
  return `${h.slice(0, 2 + head)}…${h.slice(-tail)}`;
}

/** Long strings (addresses) shortened in the middle for tables; full value belongs in a title/tooltip. */
export function shortText(s: string | null | undefined, head = 12, tail = 8): string {
  if (!s) return "—";
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

/** `#` + the first 16 hex digits of a poll id, as in the signed summary line. */
export function pollTag(pollId: string): string {
  return `#${pollId.replace(/^0x/, "").slice(0, 16)}`;
}

/** Percentage of `part` in `whole` with fixed decimals (display only; truncated, never rounded up). */
export function percent(part: string | bigint, whole: string | bigint, decimals = 2): string {
  const p = typeof part === "bigint" ? part : big(part);
  const w = typeof whole === "bigint" ? whole : big(whole);
  if (w === 0n) return "—";
  const scale = 10n ** BigInt(decimals);
  const v = (p * 100n * scale) / w;
  const int = v / scale;
  const frac = (v % scale).toString().padStart(decimals, "0");
  return decimals > 0 ? `${int}.${frac}%` : `${int}%`;
}

/** `51%` from a ratio object; exact when the denominator divides 100. */
export function ratioPercent(numerator: string, denominator: string): string {
  const n = big(numerator);
  const d = big(denominator);
  if (d === 0n) return "—";
  if ((n * 100n) % d === 0n) return `${(n * 100n) / d}%`;
  return `${numerator}/${denominator}`;
}

export function formatInt(s: string | number | bigint): string {
  return group(String(s));
}

/** Human duration such as `7 d 2 h` / `7 天 2 小时`. */
export function durationText(ms: number, lang: Lang): string {
  const neg = ms < 0;
  let s = Math.floor(Math.abs(ms) / 1000);
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const units: [number, string, string][] = [
    [d, "d", "天"],
    [h, "h", "小时"],
    [m, "min", "分钟"],
    [s, "s", "秒"],
  ];
  const parts = units.filter(([v]) => v > 0).slice(0, 2);
  const text =
    parts.length === 0
      ? lang === "zh"
        ? "0 秒"
        : "0 s"
      : parts.map(([v, en, zh]) => (lang === "zh" ? `${v} ${zh}` : `${v} ${en}`)).join(" ");
  return neg ? `-${text}` : text;
}

/** `in 2 h` / `2 小时后`, `3 min ago` / `3 分钟前`. */
export function relativeText(deltaMs: number, lang: Lang): string {
  const d = durationText(Math.abs(deltaMs), lang);
  if (Math.abs(deltaMs) < 1000) return lang === "zh" ? "现在" : "now";
  if (deltaMs > 0) return lang === "zh" ? `${d}后` : `in ${d}`;
  return lang === "zh" ? `${d}前` : `${d} ago`;
}

/**
 * Estimated wall-clock time at which the chain clock (parent MTP) reaches `targetChainMs`,
 * assuming the chain clock keeps the pace observed now. MTP lags real time and can
 * drift (for example when block production stalls); this is only an estimate.
 */
export function estimateWallMs(targetChainMs: string, chainClockMs: string, observedAtWallMs: number): number {
  return observedAtWallMs + (Number(targetChainMs) - Number(chainClockMs));
}

/** Local datetime-input value (`YYYY-MM-DDTHH:mm`) in UTC for a millisecond timestamp. */
export function toUtcInputValue(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16);
}

/** Parse `YYYY-MM-DDTHH:mm[:ss]` as UTC; returns ms or null. */
export function fromUtcInputValue(v: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(v)) return null;
  const ms = Date.parse(v + (v.length === 16 ? ":00" : "") + "Z");
  return Number.isFinite(ms) ? ms : null;
}

export function positionText(p: { height: string; tx_index: string; output_index: string; envelope_index: string } | null | undefined): string {
  if (!p) return "—";
  return `${p.height}/${p.tx_index}/${p.output_index}/${p.envelope_index}`;
}
