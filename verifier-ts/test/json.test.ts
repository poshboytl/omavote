/** Strict JSON parsing and JCS (docs/03 §2, docs/13 §3 json module). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { jcs, parseStrictJson, parseStrictJsonBytes, JsonError } from "../src/json.js";

const rejects = (text: string, why: string) =>
  test(`rejects ${why}`, () => {
    assert.throws(() => parseStrictJson(text), JsonError);
  });

rejects('{"a":1}', "integer numbers");
rejects('{"a":-1}', "negative numbers");
rejects('{"a":1.5}', "fractions");
rejects('{"a":1e3}', "exponents");
rejects('["0"] 1', "trailing content");
rejects('{"a":"1","a":"2"}', "duplicate keys");
rejects('{"a":"1","\\u0061":"2"}', "duplicate keys after unescaping");
rejects('"\\ud800"', "an escaped lone high surrogate");
rejects('"\\udc00x"', "an escaped lone low surrogate");
rejects('"\\ud800\\u0041"', "a high surrogate followed by a non-surrogate escape");
rejects('"a\u0001"', "a raw control character");
rejects('"a\nb"', "a raw newline inside a string");
rejects('"a\tb"', "a raw tab inside a string");
rejects("\ufeff{}", "a byte order mark");
rejects('{"a":"\\x41"}', "an invalid escape");
rejects('{"a":"\\u12"}', "a short \\u escape");
rejects("{'a':'b'}", "single quotes");
rejects('{"a":"b",}', "a trailing comma in objects");
rejects('["a",]', "a trailing comma in arrays");
rejects("", "empty input");
rejects("nul", "truncated literals");
rejects('{"a":True}', "capitalised literals");
rejects("\u00a0{}", "non-JSON whitespace (NBSP)");
rejects('{"a"\u000b:"b"}', "vertical tab as whitespace");

test("accepts the four JSON whitespace characters", () => {
  assert.deepEqual(parseStrictJson(' \t\r\n{ "a" :\t[ null , true ,false ] }\n'), parseStrictJson('{"a":[null,true,false]}'));
});

test("accepts surrogate pairs and characters outside the BMP", () => {
  const v = parseStrictJson('["\\ud83d\\ude00","😀"]') as string[];
  assert.equal(v[0], "😀");
  assert.equal(v[1], "😀");
});

test("depth limit: 32 nested arrays accepted, 33 rejected", () => {
  assert.doesNotThrow(() => parseStrictJson(`${"[".repeat(32)}${"]".repeat(32)}`));
  assert.throws(() => parseStrictJson(`${"[".repeat(33)}${"]".repeat(33)}`), JsonError);
  assert.throws(() => parseStrictJson(`${"[".repeat(5000)}${"]".repeat(5000)}`), JsonError);
});

test("bytes: invalid UTF-8 and BOM rejected", () => {
  assert.throws(() => parseStrictJsonBytes(new Uint8Array([0x22, 0xff, 0x22])), JsonError);
  assert.throws(() => parseStrictJsonBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d])), JsonError);
  assert.throws(() => parseStrictJsonBytes(new Uint8Array([0x22, 0xed, 0xa0, 0x80, 0x22])), JsonError); // CESU surrogate
});

test("__proto__ is an ordinary key", () => {
  const v = parseStrictJson('{"__proto__":"x","b":"y"}');
  assert.equal(jcs(v), '{"__proto__":"x","b":"y"}');
});

test("JCS sorts keys by UTF-16 code units, not code points", () => {
  // U+FB01 (ﬁ) sorts after U+1F600 (😀, encoded as D83D DE00) in UTF-16 order.
  assert.equal(jcs(parseStrictJson('{"ﬁ":"x","😀":"y","a":"z"}')), '{"a":"z","😀":"y","ﬁ":"x"}');
  assert.equal(jcs(parseStrictJson('{"b":"1","B":"2","a":"3","10":"4","9":"5"}')), '{"10":"4","9":"5","B":"2","a":"3","b":"1"}');
});

test("JCS string escaping follows ECMAScript JSON.stringify", () => {
  assert.equal(jcs("\u0000\u001f\u007f/\"\\é\u2028"), '"\\u0000\\u001f\u007f/\\"\\\\é\u2028"');
  assert.equal(jcs(["\b\f\n\r\t"]), '["\\b\\f\\n\\r\\t"]');
});

test("JCS of nested structures", () => {
  assert.equal(jcs(parseStrictJson('{ "z" : { "b" : [ ], "a" : { } } , "a" : null }')), '{"a":null,"z":{"a":{},"b":[]}}');
});
