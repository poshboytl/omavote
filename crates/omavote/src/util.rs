//! Small helpers shared by the server modules.

use anyhow::{anyhow, Result};
use omavote_core::json::{self as cj, Object};
use omavote_core::util::{parse_hash, to_hex, Hash32};
use serde_json::{Map, Value};

/// Core protocol JSON → serde JSON (lossless: the core has no numbers).
pub fn to_serde(v: &cj::Value) -> Value {
    match v {
        cj::Value::Null => Value::Null,
        cj::Value::Bool(b) => Value::Bool(*b),
        cj::Value::String(s) => Value::String(s.clone()),
        cj::Value::Array(a) => Value::Array(a.iter().map(to_serde).collect()),
        cj::Value::Object(o) => {
            let mut m = Map::new();
            for (k, v) in o.iter() {
                m.insert(k.clone(), to_serde(v));
            }
            Value::Object(m)
        }
    }
}

/// serde JSON → core protocol JSON. Numbers are rejected, as in the strict parser.
pub fn from_serde(v: &Value) -> Result<cj::Value> {
    Ok(match v {
        Value::Null => cj::Value::Null,
        Value::Bool(b) => cj::Value::Bool(*b),
        Value::String(s) => cj::Value::String(s.clone()),
        Value::Number(_) => return Err(anyhow!("protocol JSON must not contain numbers")),
        Value::Array(a) => cj::Value::Array(a.iter().map(from_serde).collect::<Result<_>>()?),
        Value::Object(m) => {
            let mut o = Object::new();
            for (k, v) in m {
                o.insert(k.clone(), from_serde(v)?);
            }
            cj::Value::Object(o)
        }
    })
}

pub fn hex(h: &[u8]) -> String {
    to_hex(h)
}

pub fn hash_arg(s: &str) -> Result<Hash32> {
    parse_hash(s, "hash").map_err(|e| anyhow!("{e}"))
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn core_err(e: omavote_core::Error) -> anyhow::Error {
    anyhow!("{e}")
}

/// Shannons rendered as a decimal string (all amounts in API responses are strings).
pub fn dec(v: impl Into<u128>) -> String {
    v.into().to_string()
}
