//! Strict protocol JSON: a small parser that rejects duplicate keys, JSON numbers,
//! invalid Unicode and excessive nesting, plus RFC 8785 (JCS) serialization.
//!
//! Protocol objects never use JSON numbers: integers are canonical decimal strings.

use crate::error::{Error, Result};

const MAX_DEPTH: usize = 32;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Value {
    Null,
    Bool(bool),
    String(String),
    Array(Vec<Value>),
    Object(Object),
}

/// Object with unique keys, kept in insertion order (JCS output sorts them).
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Object(Vec<(String, Value)>);

impl Object {
    pub fn new() -> Self {
        Object(Vec::new())
    }
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }
    pub fn insert(&mut self, key: impl Into<String>, value: Value) {
        let key = key.into();
        if let Some(slot) = self.0.iter_mut().find(|(k, _)| *k == key) {
            slot.1 = value;
        } else {
            self.0.push((key, value));
        }
    }
    pub fn with(mut self, key: impl Into<String>, value: Value) -> Self {
        self.insert(key, value);
        self
    }
    pub fn iter(&self) -> impl Iterator<Item = (&String, &Value)> {
        self.0.iter().map(|(k, v)| (k, v))
    }
    pub fn len(&self) -> usize {
        self.0.len()
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl Value {
    pub fn str(s: impl Into<String>) -> Value {
        Value::String(s.into())
    }
    pub fn opt_str(s: Option<impl Into<String>>) -> Value {
        match s {
            Some(s) => Value::String(s.into()),
            None => Value::Null,
        }
    }
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::String(s) => Some(s),
            _ => None,
        }
    }
    pub fn as_object(&self) -> Option<&Object> {
        match self {
            Value::Object(o) => Some(o),
            _ => None,
        }
    }
    pub fn as_array(&self) -> Option<&Vec<Value>> {
        match self {
            Value::Array(a) => Some(a),
            _ => None,
        }
    }
    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }
}

// ---------------------------------------------------------------------------
// Parsing

pub fn parse(bytes: &[u8]) -> Result<Value> {
    let text = std::str::from_utf8(bytes).map_err(|_| Error::format("JSON is not valid UTF-8"))?;
    if text.starts_with('\u{feff}') {
        return Err(Error::format("JSON must not start with a BOM"));
    }
    let mut p = Parser { s: text.as_bytes(), text, i: 0 };
    p.ws();
    let v = p.value(0)?;
    p.ws();
    if p.i != p.s.len() {
        return Err(Error::format("trailing data after JSON value"));
    }
    Ok(v)
}

/// Parse and require that the input bytes are exactly the JCS form of the value.
pub fn parse_canonical(bytes: &[u8]) -> Result<Value> {
    let v = parse(bytes)?;
    if jcs_bytes(&v) != bytes {
        return Err(Error::format("payload is not in canonical JCS form"));
    }
    Ok(v)
}

struct Parser<'a> {
    s: &'a [u8],
    text: &'a str,
    i: usize,
}

impl<'a> Parser<'a> {
    fn ws(&mut self) {
        while self.i < self.s.len() && matches!(self.s[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }

    fn expect_lit(&mut self, lit: &str) -> Result<()> {
        if self.s[self.i..].starts_with(lit.as_bytes()) {
            self.i += lit.len();
            Ok(())
        } else {
            Err(Error::format("invalid JSON literal"))
        }
    }

    /// `depth` counts the enclosing containers. The top-level container is at depth 1
    /// and at most `MAX_DEPTH` nested objects/arrays are accepted; scalars add no depth.
    fn value(&mut self, depth: usize) -> Result<Value> {
        match self.peek() {
            Some(b'{') | Some(b'[') if depth + 1 > MAX_DEPTH => Err(Error::format("JSON nesting too deep")),
            Some(b'{') => self.object(depth + 1),
            Some(b'[') => self.array(depth + 1),
            Some(b'"') => Ok(Value::String(self.string()?)),
            Some(b'n') => self.expect_lit("null").map(|_| Value::Null),
            Some(b't') => self.expect_lit("true").map(|_| Value::Bool(true)),
            Some(b'f') => self.expect_lit("false").map(|_| Value::Bool(false)),
            Some(b'-') | Some(b'0'..=b'9') => Err(Error::format(
                "JSON numbers are not allowed; integers must be decimal strings",
            )),
            Some(_) => Err(Error::format("unexpected character in JSON")),
            None => Err(Error::format("unexpected end of JSON")),
        }
    }

    fn object(&mut self, depth: usize) -> Result<Value> {
        self.i += 1; // '{'
        let mut obj = Object::new();
        self.ws();
        if self.peek() == Some(b'}') {
            self.i += 1;
            return Ok(Value::Object(obj));
        }
        loop {
            self.ws();
            if self.peek() != Some(b'"') {
                return Err(Error::format("expected object key"));
            }
            let key = self.string()?;
            if obj.get(&key).is_some() {
                return Err(Error::format(format!("duplicate JSON key: {key}")));
            }
            self.ws();
            if self.peek() != Some(b':') {
                return Err(Error::format("expected ':' in object"));
            }
            self.i += 1;
            self.ws();
            let v = self.value(depth)?;
            obj.0.push((key, v));
            self.ws();
            match self.peek() {
                Some(b',') => self.i += 1,
                Some(b'}') => {
                    self.i += 1;
                    return Ok(Value::Object(obj));
                }
                _ => return Err(Error::format("expected ',' or '}' in object")),
            }
        }
    }

    fn array(&mut self, depth: usize) -> Result<Value> {
        self.i += 1; // '['
        let mut items = Vec::new();
        self.ws();
        if self.peek() == Some(b']') {
            self.i += 1;
            return Ok(Value::Array(items));
        }
        loop {
            self.ws();
            items.push(self.value(depth)?);
            self.ws();
            match self.peek() {
                Some(b',') => self.i += 1,
                Some(b']') => {
                    self.i += 1;
                    return Ok(Value::Array(items));
                }
                _ => return Err(Error::format("expected ',' or ']' in array")),
            }
        }
    }

    fn hex4(&mut self) -> Result<u32> {
        if self.i + 4 > self.s.len() {
            return Err(Error::format("truncated \\u escape"));
        }
        let h = &self.text[self.i..self.i + 4];
        if !h.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(Error::format("invalid \\u escape"));
        }
        self.i += 4;
        Ok(u32::from_str_radix(h, 16).unwrap())
    }

    fn string(&mut self) -> Result<String> {
        self.i += 1; // opening quote
        let mut out = String::new();
        loop {
            let start = self.i;
            while self.i < self.s.len() {
                let b = self.s[self.i];
                if b == b'"' || b == b'\\' || b < 0x20 {
                    break;
                }
                self.i += 1;
            }
            out.push_str(&self.text[start..self.i]);
            match self.peek() {
                None => return Err(Error::format("unterminated string")),
                Some(b'"') => {
                    self.i += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.i += 1;
                    let c = self.peek().ok_or_else(|| Error::format("truncated escape"))?;
                    self.i += 1;
                    match c {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{08}'),
                        b'f' => out.push('\u{0c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let hi = self.hex4()?;
                            let cp = if (0xD800..0xDC00).contains(&hi) {
                                if !(self.s[self.i..].starts_with(b"\\u")) {
                                    return Err(Error::format("lone high surrogate"));
                                }
                                self.i += 2;
                                let lo = self.hex4()?;
                                if !(0xDC00..0xE000).contains(&lo) {
                                    return Err(Error::format("invalid low surrogate"));
                                }
                                0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00)
                            } else if (0xDC00..0xE000).contains(&hi) {
                                return Err(Error::format("lone low surrogate"));
                            } else {
                                hi
                            };
                            out.push(char::from_u32(cp).ok_or_else(|| Error::format("invalid code point"))?);
                        }
                        _ => return Err(Error::format("invalid escape")),
                    }
                }
                Some(_) => return Err(Error::format("unescaped control character in string")),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// JCS serialization (RFC 8785). Without numbers, JCS reduces to sorted keys,
// no insignificant whitespace and ECMAScript string escaping.

pub fn to_jcs(v: &Value) -> String {
    let mut out = String::new();
    write_value(v, &mut out);
    out
}

pub fn jcs_bytes(v: &Value) -> Vec<u8> {
    to_jcs(v).into_bytes()
}

fn write_value(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::String(s) => write_string(s, out),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(item, out);
            }
            out.push(']');
        }
        Value::Object(obj) => {
            let mut entries: Vec<&(String, Value)> = obj.0.iter().collect();
            entries.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
            out.push('{');
            for (i, (k, val)) in entries.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(k, out);
                out.push(':');
                write_value(val, out);
            }
            out.push('}');
        }
    }
}

fn write_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

// ---------------------------------------------------------------------------
// Strict field access for typed decoding.

/// Reads fields of one object and, on `finish`, rejects any field that was not read.
pub struct Fields<'a> {
    obj: &'a Object,
    used: Vec<&'a str>,
    what: &'static str,
}

impl<'a> Fields<'a> {
    pub fn new(v: &'a Value, what: &'static str) -> Result<Self> {
        let obj = v
            .as_object()
            .ok_or_else(|| Error::format(format!("{what}: expected JSON object")))?;
        Ok(Fields { obj, used: Vec::new(), what })
    }

    fn mark(&mut self, key: &str) -> Option<&'a Value> {
        let found = self.obj.0.iter().find(|(k, _)| k == key);
        if let Some((k, v)) = found {
            self.used.push(k.as_str());
            Some(v)
        } else {
            None
        }
    }

    pub fn value(&mut self, key: &str) -> Result<&'a Value> {
        self.mark(key)
            .ok_or_else(|| Error::format(format!("{}: missing field {key}", self.what)))
    }

    pub fn str(&mut self, key: &str) -> Result<&'a str> {
        let what = self.what;
        self.value(key)?
            .as_str()
            .ok_or_else(|| Error::format(format!("{what}: field {key} must be a string")))
    }

    /// Field must be present; null maps to None.
    pub fn opt_str(&mut self, key: &str) -> Result<Option<&'a str>> {
        let what = self.what;
        match self.value(key)? {
            Value::Null => Ok(None),
            Value::String(s) => Ok(Some(s.as_str())),
            _ => Err(Error::format(format!("{what}: field {key} must be a string or null"))),
        }
    }

    pub fn array(&mut self, key: &str) -> Result<&'a Vec<Value>> {
        let what = self.what;
        self.value(key)?
            .as_array()
            .ok_or_else(|| Error::format(format!("{what}: field {key} must be an array")))
    }

    pub fn literal(&mut self, key: &str, expected: &str) -> Result<()> {
        let what = self.what;
        let got = self.str(key)?;
        if got != expected {
            return Err(Error::format(format!("{what}: field {key} must be {expected:?}, got {got:?}")));
        }
        Ok(())
    }

    pub fn finish(self) -> Result<()> {
        for (k, _) in self.obj.0.iter() {
            if !self.used.contains(&k.as_str()) {
                return Err(Error::format(format!("{}: unknown field {k}", self.what)));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nesting_limit_counts_containers_only() {
        let nest = |n: usize, inner: &str| format!("{}{}{}", "[".repeat(n), inner, "]".repeat(n));
        assert!(parse(nest(32, "\"x\"").as_bytes()).is_ok());
        assert!(parse(nest(32, "").as_bytes()).is_ok());
        assert!(parse(nest(33, "").as_bytes()).is_err());
        assert!(parse(format!("{{\"a\":{}}}", nest(31, "\"x\"")).as_bytes()).is_ok());
        assert!(parse(format!("{{\"a\":{}}}", nest(32, "")).as_bytes()).is_err());
    }

    #[test]
    fn rejects_numbers_duplicates_and_bad_unicode() {
        assert!(parse(br#"{"a":1}"#).is_err());
        assert!(parse(br#"{"a":"1","a":"2"}"#).is_err());
        assert!(parse(br#""\ud800""#).is_err());
        assert!(parse(br#""\udc00x""#).is_err());
        assert!(parse(b"\"a\x01\"").is_err());
        assert!(parse(br#"{"a":"1"} x"#).is_err());
        let deep = "[".repeat(40) + &"]".repeat(40);
        assert!(parse(deep.as_bytes()).is_err());
    }

    #[test]
    fn jcs_sorts_keys_by_utf16_and_escapes() {
        let v = parse("{\"b\":\"x\",\"a\":[null,true,\"\\u00e9\\n\"],\"\u{fb01}\":\"\",\"\u{1f600}\":\"\"}".as_bytes()).unwrap();
        // U+1F600 encodes as surrogate pair D83D DE00, which sorts before U+FB01 in UTF-16
        // although its code point is larger.
        assert_eq!(to_jcs(&v), "{\"a\":[null,true,\"\u{e9}\\n\"],\"b\":\"x\",\"\u{1f600}\":\"\",\"\u{fb01}\":\"\"}");
        let ctl = Value::str("\u{1f}\u{7f}\u{2028}/");
        assert_eq!(to_jcs(&ctl), "\"\\u001f\u{7f}\u{2028}/\"");
    }

    #[test]
    fn canonical_parse_rejects_whitespace() {
        assert!(parse_canonical(br#"{"a":"1"}"#).is_ok());
        assert!(parse_canonical(br#"{ "a":"1"}"#).is_err());
        assert!(parse_canonical(br#"{"b":"1","a":"2"}"#).is_err());
    }

    #[test]
    fn fields_reject_unknown() {
        let v = parse(br#"{"a":"1","b":null}"#).unwrap();
        let mut f = Fields::new(&v, "t").unwrap();
        assert_eq!(f.str("a").unwrap(), "1");
        assert!(f.finish().is_err());
        let mut f = Fields::new(&v, "t").unwrap();
        f.str("a").unwrap();
        assert_eq!(f.opt_str("b").unwrap(), None);
        assert!(f.finish().is_ok());
    }
}
