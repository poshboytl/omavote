import { describe, expect, it } from "vitest";
import {
  big,
  ckbExact,
  ckbToShannon,
  durationText,
  estimateWallMs,
  formatCkb,
  formatInt,
  fromUtcInputValue,
  percent,
  pollTag,
  positionText,
  ratioPercent,
  relativeText,
  shortHex,
  shortText,
  toUtcInputValue,
  utcHuman,
  utcIso,
} from "../src/lib/format";
import { blockIntervalMs, openingCheck } from "../src/lib/flow";
import { loadCoreForNode } from "./helpers/wasm";

describe("CKB amounts", () => {
  it("render exactly like the signed texts (cross-checked with the core)", () => {
    const core = loadCoreForNode();
    const values = ["0", "1", "99999999", "100000000", "100000001", "150000000", "100000000000000", "18500000000000000", "18446744073709551615"];
    for (const v of values) expect(ckbExact(v)).toBe(core.renderCkb(v));
    expect(ckbExact("100000001")).toBe("1.00000001");
    expect(ckbExact(1n)).toBe("0.00000001");
  });

  it("format with thousands separators without losing precision", () => {
    expect(formatCkb("100000000000000")).toBe("1,000,000 CKB");
    expect(formatCkb("18500000000000000")).toBe("185,000,000 CKB");
    expect(formatCkb("123456789012345678")).toBe("1,234,567,890.12345678 CKB");
    expect(formatCkb("150000000", false)).toBe("1.5");
    expect(formatInt("1234567")).toBe("1,234,567");
  });

  it("parse user input to shannon", () => {
    expect(ckbToShannon("1")).toBe("100000000");
    expect(ckbToShannon(" 1,000,000 ")).toBe("100000000000000");
    expect(ckbToShannon("0.00000001")).toBe("1");
    expect(ckbToShannon("12.5")).toBe("1250000000");
    expect(ckbToShannon("1.123456789")).toBeNull();
    expect(ckbToShannon("-1")).toBeNull();
    expect(ckbToShannon("1e3")).toBeNull();
    expect(ckbToShannon("")).toBeNull();
    expect(big("12")).toBe(12n);
    expect(big("x")).toBe(0n);
    expect(big("012")).toBe(0n);
  });
});

describe("time", () => {
  it("renders UTC like the core's utc method", () => {
    const core = loadCoreForNode();
    for (const ms of ["0", "1791417600123", "951782400000", "253402300799999"]) expect(utcIso(ms)).toBe(core.utc(ms));
    expect(utcHuman("1791417600123")).toBe("2026-10-08 00:00:00 UTC");
    expect(utcIso("nope")).toBe("—");
  });

  it("round-trips UTC datetime inputs", () => {
    const ms = Date.UTC(2027, 0, 2, 3, 4);
    expect(toUtcInputValue(ms)).toBe("2027-01-02T03:04");
    expect(fromUtcInputValue("2027-01-02T03:04")).toBe(ms);
    expect(fromUtcInputValue("2027-01-02T03:04:05")).toBe(ms + 5000);
    expect(fromUtcInputValue("2027-01-02 03:04")).toBeNull();
  });

  it("describes durations and relative times in both languages", () => {
    expect(durationText(7 * 86_400_000 + 2 * 3_600_000, "en")).toBe("7 d 2 h");
    expect(durationText(7 * 86_400_000 + 2 * 3_600_000, "zh")).toBe("7 天 2 小时");
    expect(durationText(90_000, "en")).toBe("1 min 30 s");
    expect(durationText(0, "en")).toBe("0 s");
    expect(relativeText(3_600_000, "en")).toBe("in 1 h");
    expect(relativeText(-120_000, "zh")).toBe("2 分钟前");
    expect(relativeText(10, "en")).toBe("now");
  });

  it("estimates wall time from the chain clock", () => {
    expect(estimateWallMs("1000", "400", 5000)).toBe(5600);
  });

  it("estimates block intervals and the opening room", () => {
    expect(blockIntervalMs({ number: "100", clock_ms: "1000000" }, { number: "110", clock_ms: "1100000" })).toBe(10_000);
    expect(blockIntervalMs({ number: "100", clock_ms: "1000000" }, { number: "100", clock_ms: "1100000" })).toBeNull();
    const ok = openingCheck({ startMs: String(10_000_000), chainClockMs: "0", openingConfirmations: "100", blockIntervalMs: 10_000 });
    expect(ok).toEqual({ requiredBlocks: 120, requiredMs: 1_200_000, availableMs: 10_000_000, ok: true });
    expect(openingCheck({ startMs: "1000000", chainClockMs: "0", openingConfirmations: "100", blockIntervalMs: 10_000 }).ok).toBe(false);
  });
});

describe("identifiers and ratios", () => {
  it("shortens hashes and addresses", () => {
    const h = "0x" + "ab".repeat(32);
    expect(shortHex(h)).toBe("0xababab…abab");
    expect(shortHex(null)).toBe("—");
    expect(shortText("ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqv883vsujtan0uclm2c55kc20qurjnxw3gzt2gkj", 10, 6)).toBe("ckt1qzda0c…zt2gkj");
    expect(pollTag("0x19a1f9d1fb6106b73c8e4be80afb135d7fa9460ec0dc77ff7d508d8b47d39ec8")).toBe("#19a1f9d1fb6106b7");
    expect(positionText({ height: "1", tx_index: "2", output_index: "3", envelope_index: "4" })).toBe("1/2/3/4");
  });

  it("computes display percentages with BigInt (never rounding up)", () => {
    expect(percent("1", "3")).toBe("33.33%");
    expect(percent("2", "3")).toBe("66.66%");
    expect(percent("51", "100", 0)).toBe("51%");
    expect(percent("1", "0")).toBe("—");
    expect(percent("18500000000000000", "18500000000000000")).toBe("100.00%");
    expect(ratioPercent("51", "100")).toBe("51%");
    expect(ratioPercent("2", "3")).toBe("2/3");
  });
});
