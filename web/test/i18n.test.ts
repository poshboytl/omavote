import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { en } from "../src/i18n/en";
import { zh } from "../src/i18n/zh";
import { detectLang, interpolate, isMessageKey, placeholders, translate } from "../src/lib/i18n";

const srcDir = fileURLToPath(new URL("../src", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "pkg" ? [] : sourceFiles(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

describe("i18n dictionaries", () => {
  it("have exactly the same keys in English and Chinese", () => {
    const a = Object.keys(en).sort();
    const b = Object.keys(zh).sort();
    expect(b).toEqual(a);
    expect(a.length).toBeGreaterThan(300);
  });

  it("use the same placeholders in both languages", () => {
    const mismatches = Object.keys(en).filter((k) => {
      const key = k as keyof typeof en;
      return placeholders(en[key]).join(",") !== placeholders(zh[key]).join(",");
    });
    expect(mismatches).toEqual([]);
  });

  it("have no empty or untranslated entries", () => {
    for (const [k, v] of Object.entries(en)) expect(v.trim(), k).not.toBe("");
    for (const [k, v] of Object.entries(zh)) expect(v.trim(), k).not.toBe("");
    // Chinese strings should actually be Chinese (a few technical labels excepted).
    const latinOnly = Object.entries(zh).filter(([, v]) => !/[一-鿿]/.test(v)).map(([k]) => k);
    const allowed = /^(choice|controlOutcome|tally\.resultHash|proposal\.(exactShannon|ownerAdapters|keyAdapters|resultCoreJson)|create\.builtTitle|diag\.id|address\.(owner|outpoint|key)|banner\.apiBase|footer\.api|records\.anchor)/;
    expect(latinOnly.filter((k) => !allowed.test(k))).toEqual([]);
  });

  it("contain every static key used in the source", () => {
    const used = new Set<string>();
    for (const f of sourceFiles(srcDir)) {
      for (const m of readFileSync(f, "utf8").matchAll(/\bt\("([a-zA-Z0-9_.]+)"/g)) if (m[1]) used.add(m[1]);
    }
    expect(used.size).toBeGreaterThan(300);
    expect([...used].filter((k) => !isMessageKey(k))).toEqual([]);
  });

  it("cover the status codes shown from the server", () => {
    const families: Record<string, string[]> = {
      pollStatus: ["ANNOUNCED", "OPEN", "CLOSED_UNCONFIRMED", "AUDITABLE", "FINALIZED_BY_POLICY", "EXECUTED", "DISPUTED", "LATE_MANIFEST"],
      ballotStatus: ["SELECTED", "SUPERSEDED", "CONFLICT", "CANCELLED_BY_CONTROL", "OVERRIDDEN_BY_OWNER"],
      relayStatus: ["RECEIVED", "BROADCAST", "INCLUDED", "CONFIRMED", "EXPIRED", "FAILED", "ALREADY_ON_CHAIN"],
      controlOutcome: ["EFFECTIVE", "STALE_AUTHORIZATION", "DUPLICATE", "AUTH_CONFLICT"],
      admission: ["PENDING", "ADMITTED", "REJECTED", "MISSING", "RECORD_CONFLICT"],
      recordType: ["ADMISSION", "NOTICE", "GOVERNANCE_STATUS", "RESULT_ATTESTATION", "EXECUTION", "ROLES_UPDATE"],
      codeHelp: ["INVALID_SIGNATURE", "WRONG_OWNER", "OUT_OF_WINDOW", "ANCHOR_INVALID", "ADAPTER_NOT_ACCEPTED", "NO_DEPOSIT_AT_CAST", "DUPLICATE", "STALE_AUTHORIZATION"],
    };
    for (const [prefix, codes] of Object.entries(families)) for (const c of codes) expect(isMessageKey(`${prefix}.${c}`), `${prefix}.${c}`).toBe(true);
  });
});

describe("translate", () => {
  it("interpolates placeholders and leaves unknown ones visible", () => {
    expect(interpolate("a {x} b {y}", { x: 1, y: "z" })).toBe("a 1 b z");
    expect(interpolate("a {x}", {})).toBe("a {x}");
    expect(translate("en", "tally.owners", { n: 3 })).toBe("3 owners with ballots");
    expect(translate("zh", "tally.owners", { n: 3 })).toBe("3 个地址投过票");
  });

  it("falls back to the raw code for unknown dynamic keys", () => {
    expect(translate("en", "pollStatus.SOMETHING_NEW")).toBe("SOMETHING_NEW");
    expect(translate("zh", "codeHelp.NEW_CODE", undefined, "")).toBe("");
    expect(translate("zh", "pollStatus.OPEN")).toBe("投票中");
  });

  it("starts in English and keeps the visitor's choice", () => {
    expect(detectLang(null)).toBe("en");
    expect(detectLang("")).toBe("en");
    expect(detectLang("zh")).toBe("zh");
    expect(detectLang("en")).toBe("en");
    expect(detectLang("fr")).toBe("en");
  });
});
