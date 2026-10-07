/**
 * Strict JSON parsing and RFC 8785 (JCS) serialization.
 *
 * Protocol JSON (docs/03 §2) must be UTF-8 without BOM, must not contain
 * numbers (integers are decimal strings), duplicate keys, lone surrogates,
 * raw control characters or excessive nesting. Booleans and null are
 * accepted by the parser; the schema layer decides where they may appear.
 */

export type JsonValue = null | boolean | string | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export class JsonError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(`${message} at offset ${offset}`);
    this.name = "JsonError";
  }
}

/** Default nesting limit for protocol payloads (see SPEC-NOTES: not fixed by the docs). */
export const DEFAULT_MAX_DEPTH = 32;

export interface ParseOptions {
  /** Maximum nesting depth of arrays/objects; the top-level container is depth 1. */
  maxDepth?: number;
}

const UTF8_FATAL = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const UTF8_ENCODER = new TextEncoder();

export function utf8Encode(text: string): Uint8Array {
  return UTF8_ENCODER.encode(text);
}

/** Strict UTF-8 decoding: invalid sequences throw, a BOM is kept (and later rejected). */
export function utf8DecodeStrict(bytes: Uint8Array): string {
  try {
    return UTF8_FATAL.decode(bytes);
  } catch {
    throw new JsonError("invalid UTF-8", 0);
  }
}

export function isObject(v: JsonValue | undefined): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

class Parser {
  private pos = 0;
  constructor(
    private readonly text: string,
    private readonly maxDepth: number,
  ) {}

  parseDocument(): JsonValue {
    if (this.text.charCodeAt(0) === 0xfeff) {
      throw new JsonError("byte order mark is not allowed", 0);
    }
    this.skipWs();
    const value = this.parseValue(0);
    this.skipWs();
    if (this.pos !== this.text.length) {
      throw new JsonError("trailing characters after JSON value", this.pos);
    }
    return value;
  }

  private skipWs(): void {
    const t = this.text;
    while (this.pos < t.length) {
      const c = t.charCodeAt(this.pos);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
        this.pos++;
      } else {
        break;
      }
    }
  }

  private parseValue(depth: number): JsonValue {
    const t = this.text;
    if (this.pos >= t.length) {
      throw new JsonError("unexpected end of input", this.pos);
    }
    const c = t[this.pos];
    switch (c) {
      case "{":
        return this.parseObject(depth + 1);
      case "[":
        return this.parseArray(depth + 1);
      case '"':
        return this.parseString();
      case "t":
        return this.parseLiteral("true", true);
      case "f":
        return this.parseLiteral("false", false);
      case "n":
        return this.parseLiteral("null", null);
      default:
        if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) {
          throw new JsonError("JSON numbers are not allowed (integers must be decimal strings)", this.pos);
        }
        throw new JsonError(`unexpected character ${JSON.stringify(c)}`, this.pos);
    }
  }

  private parseLiteral<T extends JsonValue>(word: string, value: T): T {
    if (this.text.startsWith(word, this.pos)) {
      this.pos += word.length;
      return value;
    }
    throw new JsonError("invalid literal", this.pos);
  }

  private checkDepth(depth: number): void {
    if (depth > this.maxDepth) {
      throw new JsonError(`nesting deeper than ${this.maxDepth}`, this.pos);
    }
  }

  private parseObject(depth: number): JsonObject {
    this.checkDepth(depth);
    const obj: JsonObject = Object.create(null) as JsonObject;
    this.pos++; // {
    this.skipWs();
    if (this.text[this.pos] === "}") {
      this.pos++;
      return obj;
    }
    for (;;) {
      this.skipWs();
      if (this.text[this.pos] !== '"') {
        throw new JsonError("expected object key string", this.pos);
      }
      const keyPos = this.pos;
      const key = this.parseString();
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        throw new JsonError(`duplicate key ${JSON.stringify(key)}`, keyPos);
      }
      this.skipWs();
      if (this.text[this.pos] !== ":") {
        throw new JsonError("expected ':'", this.pos);
      }
      this.pos++;
      this.skipWs();
      obj[key] = this.parseValue(depth);
      this.skipWs();
      const c = this.text[this.pos];
      if (c === ",") {
        this.pos++;
        continue;
      }
      if (c === "}") {
        this.pos++;
        return obj;
      }
      throw new JsonError("expected ',' or '}'", this.pos);
    }
  }

  private parseArray(depth: number): JsonValue[] {
    this.checkDepth(depth);
    const arr: JsonValue[] = [];
    this.pos++; // [
    this.skipWs();
    if (this.text[this.pos] === "]") {
      this.pos++;
      return arr;
    }
    for (;;) {
      this.skipWs();
      arr.push(this.parseValue(depth));
      this.skipWs();
      const c = this.text[this.pos];
      if (c === ",") {
        this.pos++;
        continue;
      }
      if (c === "]") {
        this.pos++;
        return arr;
      }
      throw new JsonError("expected ',' or ']'", this.pos);
    }
  }

  private parseString(): string {
    const t = this.text;
    const start = this.pos;
    this.pos++; // opening quote
    let out = "";
    let chunkStart = this.pos;
    for (;;) {
      if (this.pos >= t.length) {
        throw new JsonError("unterminated string", start);
      }
      const code = t.charCodeAt(this.pos);
      if (code === 0x22) {
        out += t.slice(chunkStart, this.pos);
        this.pos++;
        break;
      }
      if (code < 0x20) {
        throw new JsonError("raw control character in string", this.pos);
      }
      if (code === 0x5c) {
        out += t.slice(chunkStart, this.pos);
        this.pos++;
        const e = t[this.pos];
        switch (e) {
          case '"':
            out += '"';
            break;
          case "\\":
            out += "\\";
            break;
          case "/":
            out += "/";
            break;
          case "b":
            out += "\b";
            break;
          case "f":
            out += "\f";
            break;
          case "n":
            out += "\n";
            break;
          case "r":
            out += "\r";
            break;
          case "t":
            out += "\t";
            break;
          case "u": {
            const hex = t.slice(this.pos + 1, this.pos + 5);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              throw new JsonError("invalid \\u escape", this.pos);
            }
            out += String.fromCharCode(parseInt(hex, 16));
            this.pos += 4;
            break;
          }
          default:
            throw new JsonError("invalid escape sequence", this.pos);
        }
        this.pos++;
        chunkStart = this.pos;
        continue;
      }
      this.pos++;
    }
    if (!out.isWellFormed()) {
      throw new JsonError("string contains a lone surrogate", start);
    }
    return out;
  }
}

/** Parses protocol JSON text strictly (see module comment). */
export function parseStrictJson(text: string, opts: ParseOptions = {}): JsonValue {
  return new Parser(text, opts.maxDepth ?? DEFAULT_MAX_DEPTH).parseDocument();
}

/** Strict UTF-8 decode followed by strict JSON parsing. */
export function parseStrictJsonBytes(bytes: Uint8Array, opts: ParseOptions = {}): JsonValue {
  return parseStrictJson(utf8DecodeStrict(bytes), opts);
}

/**
 * RFC 8785 serialization. Object keys are sorted by UTF-16 code units (the
 * default JavaScript string ordering); strings use the ECMAScript
 * JSON.stringify escaping that RFC 8785 adopts. Numbers never occur.
 */
export function jcs(value: JsonValue): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") {
    if (!value.isWellFormed()) {
      throw new Error("cannot canonicalize a string with lone surrogates");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(jcs).join(",")}]`;
  }
  const keys = Object.keys(value).sort(compareUtf16);
  return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs(value[k] as JsonValue)}`).join(",")}}`;
}

export function jcsBytes(value: JsonValue): Uint8Array {
  return utf8Encode(jcs(value));
}

/** Comparison by UTF-16 code units, as required by RFC 8785 §3.2.3. */
export function compareUtf16(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Deep structural equality of two JSON values. */
export function jsonEqual(a: JsonValue, b: JsonValue): boolean {
  return jcs(a) === jcs(b);
}

/** Converts a plain JS value (from our own code) into a null-prototype JsonValue tree. */
export function toJsonValue(v: unknown): JsonValue {
  if (v === null || typeof v === "boolean" || typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(toJsonValue);
  if (typeof v === "object") {
    const out: JsonObject = Object.create(null) as JsonObject;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val === undefined) continue;
      out[k] = toJsonValue(val);
    }
    return out;
  }
  throw new Error(`value of type ${typeof v} is not representable in protocol JSON`);
}
