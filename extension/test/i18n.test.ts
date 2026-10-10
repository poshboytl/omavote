import { describe, expect, it } from "vitest";
import { dictionaries } from "../src/ui/i18n";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("extension strings", () => {
  it("English and Chinese have the same keys and placeholders", () => {
    const { en, zh } = dictionaries;
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    for (const k of Object.keys(en) as (keyof typeof en)[]) {
      expect(placeholders(zh[k]), k).toEqual(placeholders(en[k]));
      expect(zh[k].trim(), k).not.toBe("");
    }
  });
});
