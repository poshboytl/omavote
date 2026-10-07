/** Rendering rules of docs/03 §5 and docs/11 §3–§4.1. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { SchemaError } from "../src/errors.js";
import { validateSigningTitle } from "../src/schema.js";
import { ballotText, budgetSummary, renderCkbExact, renderUtc, renderUtcDate } from "../src/text.js";
import { parseBallotBody, parseManifest } from "../src/schema.js";
import { Scenario, Wallet } from "./builder.js";

test("exact CKB rendering (docs/03 §5 rule 3)", () => {
  assert.equal(renderCkbExact(100000000000000n), "1000000");
  assert.equal(renderCkbExact(100000001n), "1.00000001");
  assert.equal(renderCkbExact(0n), "0");
  assert.equal(renderCkbExact(50_000_000n), "0.5");
  assert.equal(renderCkbExact(1n), "0.00000001");
  assert.equal(renderCkbExact(123_456_789_000n), "1234.56789");
  assert.equal(renderCkbExact(18446744073709551615n), "184467440737.09551615");
});

test("UTC rendering with millisecond precision and 4-digit years", () => {
  assert.equal(renderUtc(0n), "1970-01-01T00:00:00.000Z");
  assert.equal(renderUtc(1800633600000n), "2027-01-22T16:00:00.000Z");
  assert.equal(renderUtc(253402300799999n), "9999-12-31T23:59:59.999Z");
  assert.throws(() => renderUtc(253402300800000n), SchemaError);
  assert.equal(renderUtcDate(1831539600000n), "2028-01-15");
});

test("signing_title rules (docs/03 §5 rule 2)", () => {
  assert.doesNotThrow(() => validateSigningTitle("Fund block explorer"));
  assert.doesNotThrow(() => validateSigningTitle("区块浏览器资助"));
  assert.doesNotThrow(() => validateSigningTitle("x".repeat(80)));
  assert.doesNotThrow(() => validateSigningTitle("😀".repeat(80)));
  assert.throws(() => validateSigningTitle("x".repeat(81)), SchemaError);
  assert.throws(() => validateSigningTitle(""), SchemaError);
  assert.throws(() => validateSigningTitle(" leading"), SchemaError);
  assert.throws(() => validateSigningTitle("trailing　"), SchemaError);
  assert.throws(() => validateSigningTitle("tab\there"), SchemaError);
  assert.throws(() => validateSigningTitle("del\u007f"), SchemaError);
  assert.throws(() => validateSigningTitle("c1\u0085x"), SchemaError);
  for (const cp of [0x061c, 0x200e, 0x200f, 0x202a, 0x202e, 0x2066, 0x2069, 0x2028, 0x2029]) {
    assert.throws(() => validateSigningTitle(`a${String.fromCodePoint(cp)}b`), SchemaError, `U+${cp.toString(16)}`);
  }
  assert.doesNotThrow(() => validateSigningTitle("a b"), "inner NBSP is allowed");
});

test("ballot text layout: summary, title, one blank line, LF only, no trailing newline", () => {
  const s = new Scenario("text");
  const proposer = new Wallet("proposer");
  const m = parseManifest(s.manifestJson({ startBlock: 10, proposers: [proposer], budgetCkb: 1_000_000n }), s.network);
  const { envelope } = s.ballot({ manifest: m, owner: proposer, action: "CANCEL", anchorHeight: 1 });
  const b = parseBallotBody(envelope["body"], s.network);
  const text = ballotText(m, b, s.network);
  const lines = text.split("\n");
  assert.equal(lines[0], `OMAVOTE VOTE CANCEL #${m.pollId.slice(2, 18)} 1000000CKB`);
  assert.equal(lines[1], "OMAVOTE V2 - VOTE ONLY, NO ASSET TRANSFER");
  assert.equal(lines[2], "");
  assert.equal(lines.filter((l) => l === "").length, 1);
  assert.ok(!text.endsWith("\n") && !text.includes("\r"));
  assert.equal(lines.length, 3 + 17);
  assert.ok(lines.includes("Choice: CANCEL (Withdraw vote)"));
  assert.ok(lines.includes("Authorization: none"));
  assert.ok(lines.includes("Authority: OWNER (Direct)"));
  assert.ok(Buffer.byteLength(lines[0] as string) <= 60);
});

test("budget summaries: integer CKB, 0CKB below one CKB, META-RULE", () => {
  const s = new Scenario("budget");
  const p = new Wallet("proposer");
  const small = parseManifest(s.manifestJson({ startBlock: 10, proposers: [p], budgetCkb: 0n, quorumBaseCkb: 1n }), s.network);
  assert.equal(budgetSummary(small), "0CKB");
  const meta = parseManifest(s.manifestJson({ startBlock: 10, proposers: [p], proposalType: "meta_rule" }), s.network);
  assert.equal(budgetSummary(meta), "META-RULE");
  const { envelope } = s.ballot({ manifest: meta, owner: p, action: "YES", anchorHeight: 1 });
  const text = ballotText(meta, parseBallotBody(envelope["body"], s.network), s.network);
  assert.ok(text.includes("\nBudget-CKB: none\n") && text.includes("\nRecipient: none\n"));
  assert.ok(text.startsWith(`OMAVOTE VOTE YES #${meta.pollId.slice(2, 18)} META-RULE\n`));
});
