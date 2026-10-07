//! Minimal CKB JSON-RPC client.

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};

#[derive(Clone)]
pub struct Rpc {
    client: reqwest::Client,
    url: String,
}

pub fn hex_u64(v: &Value) -> Result<u64> {
    let s = v.as_str().ok_or_else(|| anyhow!("expected hex string, got {v}"))?;
    u64::from_str_radix(s.trim_start_matches("0x"), 16).with_context(|| format!("bad hex number {s}"))
}

pub fn to_hex_u64(n: u64) -> String {
    format!("0x{n:x}")
}

impl Rpc {
    pub fn new(url: &str) -> Self {
        Rpc {
            client: reqwest::Client::builder().timeout(std::time::Duration::from_secs(60)).build().expect("http client"),
            url: url.to_string(),
        }
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Value> {
        let body = json!({"id": 1, "jsonrpc": "2.0", "method": method, "params": params});
        let resp: Value = self
            .client
            .post(&self.url)
            .json(&body)
            .send()
            .await
            .with_context(|| format!("rpc {method}"))?
            .json()
            .await
            .with_context(|| format!("rpc {method} response"))?;
        if let Some(err) = resp.get("error") {
            bail!("rpc {method} failed: {err}");
        }
        Ok(resp.get("result").cloned().unwrap_or(Value::Null))
    }

    pub async fn tip_number(&self) -> Result<u64> {
        hex_u64(&self.call("get_tip_block_number", json!([])).await?)
    }

    pub async fn block_by_number(&self, n: u64) -> Result<Option<Value>> {
        let v = self.call("get_block_by_number", json!([to_hex_u64(n)])).await?;
        Ok(if v.is_null() { None } else { Some(v) })
    }

    pub async fn block_hash(&self, n: u64) -> Result<Option<String>> {
        let v = self.call("get_block_hash", json!([to_hex_u64(n)])).await?;
        Ok(v.as_str().map(str::to_string))
    }

    pub async fn median_time(&self, block_hash: &str) -> Result<u64> {
        hex_u64(&self.call("get_block_median_time", json!([block_hash])).await?)
    }

    pub async fn send_transaction(&self, tx: Value) -> Result<String> {
        let v = self.call("send_transaction", json!([tx, "passthrough"])).await?;
        v.as_str().map(str::to_string).ok_or_else(|| anyhow!("send_transaction returned {v}"))
    }

    /// Returns the tx status string ("pending", "proposed", "committed", "unknown", "rejected")
    /// and the block hash when committed.
    pub async fn tx_status(&self, tx_hash: &str) -> Result<(String, Option<String>)> {
        let v = self.call("get_transaction", json!([tx_hash])).await?;
        let st = &v["tx_status"];
        Ok((
            st["status"].as_str().unwrap_or("unknown").to_string(),
            st["block_hash"].as_str().map(str::to_string),
        ))
    }

    /// Indexer cell search by lock script (plain cells only when `plain` is set).
    pub async fn cells_by_lock(&self, lock: &Value, limit: u32, after: Option<String>) -> Result<(Vec<Value>, Option<String>)> {
        let search = json!({"script": lock, "script_type": "lock", "script_search_mode": "exact"});
        let mut params = vec![search, json!("asc"), json!(to_hex_u64(limit as u64))];
        if let Some(a) = after {
            params.push(json!(a));
        }
        let v = self.call("get_cells", Value::Array(params)).await?;
        let objects = v["objects"].as_array().cloned().unwrap_or_default();
        let cursor = v["last_cursor"].as_str().map(str::to_string);
        Ok((objects, cursor))
    }

}
