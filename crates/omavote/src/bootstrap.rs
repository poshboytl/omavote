//! Accelerated start (docs/03 §9, docs/13 §5): begin replay at height `H0` instead of
//! genesis. Requires that no protocol object exists at or below `H0` (the deployment
//! height). Everything comes from the operator's own node:
//!
//! - the Nervos DAO deposits live at the end of `H0`: the indexer's live deposits at a
//!   fixed tip `T`, keeping those created at or below `H0`, plus deposits created at
//!   or below `H0` and spent in `(H0, T]`, restored from the spending transactions;
//! - the timestamps of the blocks ending at `H0` (median-time window);
//! - hashes and clocks of the blocks just below `H0`, so that signed objects
//!   anchored there can still be checked.
//!
//! The result must equal the state of a full replay at `H0`; `omavote verify
//! --from-height H0 --compare` checks that.

use std::collections::{BTreeMap, HashMap};

use anyhow::{anyhow, bail, Context, Result};
use omavote_core::engine::{BootstrapCell, Position};
use omavote_core::molecule::OutPoint;
use omavote_core::network::NetworkParams;
use omavote_core::util::{to_hex, Hash32};
use serde_json::{json, Value};

use crate::chain::{h32, hex_bytes, hex_u64, out_point_from_rpc, script_from_rpc, script_to_rpc, MedianWindow, MEDIAN_WINDOW};
use crate::rpc::Rpc;

#[derive(Clone, Debug)]
pub struct Bootstrap {
    pub height: u64,
    pub hash: Hash32,
    pub clock_ms: u64,
    /// Up to 37 timestamps ending at `height` (median-time window for `height + 1`).
    pub timestamps: Vec<u64>,
    /// `(hash, number, clock)` of canonical blocks below `height` usable as anchors.
    pub anchors: Vec<(Hash32, u64, u64)>,
    pub cells: Vec<BootstrapCell>,
    /// Indexer tip the deposit set was derived from.
    pub derived_at: (u64, Hash32),
}

fn is_deposit(net: &NetworkParams, type_: &Value, data: &[u8]) -> Result<bool> {
    if type_.is_null() {
        return Ok(false);
    }
    Ok(net.is_dao_type(&script_from_rpc(type_)?) && data == [0u8; 8])
}

/// Headers `(number, hash, timestamp)` for `[from, to]`, fetched concurrently.
async fn headers(rpc: &Rpc, from: u64, to: u64) -> Result<Vec<(u64, Hash32, u64)>> {
    let mut out = Vec::new();
    let mut n = from;
    while n <= to {
        let end = to.min(n + 199);
        let batch = futures::future::try_join_all((n..=end).map(|i| rpc.header_by_number(i))).await?;
        for (i, h) in batch.into_iter().enumerate() {
            let h = h.ok_or_else(|| anyhow!("node has no header {}", n + i as u64))?;
            out.push((hex_u64(&h["number"])?, h32(&h["hash"])?, hex_u64(&h["timestamp"])?));
        }
        n = end + 1;
    }
    Ok(out)
}

/// Clock of every block in `[from, to]` (needs timestamps from `from - 37`).
fn clocks(timestamps: &BTreeMap<u64, u64>, from: u64, to: u64) -> BTreeMap<u64, u64> {
    let mut out = BTreeMap::new();
    for b in from..=to {
        let clock = if b == 0 {
            timestamps[&0]
        } else {
            let lo = b.saturating_sub(MEDIAN_WINDOW as u64);
            let w = MedianWindow::from_slice(&(lo..b).map(|i| timestamps[&i]).collect::<Vec<_>>());
            w.median().expect("non-empty window")
        };
        out.insert(b, clock);
    }
    out
}

async fn live_deposits(rpc: &Rpc, net: &NetworkParams, height: u64, cells: &mut BTreeMap<OutPoint, BootstrapCell>) -> Result<()> {
    let key = json!({"script": script_to_rpc(&net.dao_script()), "script_type": "type", "script_search_mode": "exact", "with_data": true});
    let mut cursor = None;
    loop {
        let (objects, next) = rpc.search("get_cells", &key, 1000, cursor).await?;
        for o in &objects {
            let created = hex_u64(&o["block_number"])?;
            let data = hex_bytes(&o["output_data"]).unwrap_or_default();
            if created > height || !is_deposit(net, &o["output"]["type"], &data)? {
                continue;
            }
            let op = out_point_from_rpc(&o["out_point"])?;
            cells.insert(
                op,
                BootstrapCell {
                    out_point: op,
                    lock: script_from_rpc(&o["output"]["lock"])?,
                    capacity: hex_u64(&o["output"]["capacity"])?,
                    created: Position { height: created, tx_index: hex_u64(&o["tx_index"])? as u32, output_index: op.index, envelope_index: 0 },
                },
            );
        }
        if objects.len() < 1000 || next.is_none() {
            return Ok(());
        }
        cursor = next;
    }
}

/// Deposits created at or below `height` and spent in `(height, to]`, restored from
/// the spending transactions' inputs.
async fn spent_deposits(rpc: &Rpc, net: &NetworkParams, height: u64, to: u64, cells: &mut BTreeMap<OutPoint, BootstrapCell>) -> Result<()> {
    let key = json!({
        "script": script_to_rpc(&net.dao_script()), "script_type": "type", "script_search_mode": "exact",
        "filter": {"block_range": [format!("0x{:x}", height + 1), format!("0x{:x}", to + 1)]}
    });
    let mut cursor = None;
    let mut txs: HashMap<String, Value> = HashMap::new();
    loop {
        let (objects, next) = rpc.search("get_transactions", &key, 1000, cursor).await?;
        for o in &objects {
            if o["io_type"] != "input" {
                continue;
            }
            let tx_hash = o["tx_hash"].as_str().unwrap_or_default().to_string();
            let io_index = hex_u64(&o["io_index"])? as usize;
            if !txs.contains_key(&tx_hash) {
                txs.insert(tx_hash.clone(), rpc.transaction(&tx_hash).await?);
            }
            let op = out_point_from_rpc(&txs[&tx_hash]["transaction"]["inputs"][io_index]["previous_output"])?;
            let prev_hash = to_hex(&op.tx_hash);
            if !txs.contains_key(&prev_hash) {
                txs.insert(prev_hash.clone(), rpc.transaction(&prev_hash).await?);
            }
            let prev = &txs[&prev_hash];
            let out = &prev["transaction"]["outputs"][op.index as usize];
            let data = hex_bytes(&prev["transaction"]["outputs_data"][op.index as usize]).unwrap_or_default();
            if !is_deposit(net, &out["type"], &data)? {
                continue; // e.g. a withdrawing cell being claimed
            }
            let block_hash = prev["tx_status"]["block_hash"].as_str().ok_or_else(|| anyhow!("{prev_hash} not committed"))?;
            let created = hex_u64(&rpc.call("get_header", json!([block_hash])).await?["number"])?;
            if created > height {
                continue;
            }
            // The creating tx_index is evidence only; the indexer does not return it here.
            cells.insert(
                op,
                BootstrapCell {
                    out_point: op,
                    lock: script_from_rpc(&out["lock"])?,
                    capacity: hex_u64(&out["capacity"])?,
                    created: Position { height: created, tx_index: 0, output_index: op.index, envelope_index: 0 },
                },
            );
        }
        if objects.len() < 1000 || next.is_none() {
            return Ok(());
        }
        cursor = next;
    }
}

/// Live deposits at `height`. Live cells are listed first; spends are then undone up
/// to the indexer tip reached after the listing, so cells spent while paging are
/// still restored. A reorg during the pass makes it start over.
async fn deposits_at(rpc: &Rpc, net: &NetworkParams, height: u64) -> Result<(Vec<BootstrapCell>, (u64, Hash32))> {
    for _ in 0..5 {
        let (tip, tip_hash) = rpc.indexer_tip().await?;
        if tip < height {
            bail!("the node's indexer is at {tip}, below the bootstrap height {height}");
        }
        let mut cells = BTreeMap::new();
        live_deposits(rpc, net, height, &mut cells).await?;
        let (tip2, tip2_hash) = rpc.indexer_tip().await?;
        spent_deposits(rpc, net, height, tip2, &mut cells).await?;
        let canonical = |n: u64, h: String| async move { Ok::<bool, anyhow::Error>(rpc.block_hash(n).await?.as_deref() == Some(h.as_str())) };
        if canonical(tip, tip_hash).await? && canonical(tip2, tip2_hash.clone()).await? {
            return Ok((cells.into_values().collect(), (tip2, crate::util::hash_arg(&tip2_hash)?)));
        }
        tracing::warn!("the chain reorganized while deriving the deposit set; retrying");
    }
    bail!("could not obtain a consistent indexer snapshot")
}

/// Build the bootstrap state for `height` keeping `anchor_blocks` earlier blocks as anchors.
pub async fn build(rpc: &Rpc, net: &NetworkParams, height: u64, anchor_blocks: u64) -> Result<Bootstrap> {
    let lowest = height.saturating_sub(anchor_blocks + MEDIAN_WINDOW as u64);
    let hs = headers(rpc, lowest, height).await.context("headers below the bootstrap height")?;
    let ts: BTreeMap<u64, u64> = hs.iter().map(|(n, _, t)| (*n, *t)).collect();
    let hashes: BTreeMap<u64, Hash32> = hs.iter().map(|(n, h, _)| (*n, *h)).collect();
    let clocks = clocks(&ts, height.saturating_sub(anchor_blocks), height);
    let (cells, derived_at) = deposits_at(rpc, net, height).await.context("Nervos DAO deposits at the bootstrap height")?;
    let window_from = (height + 1).saturating_sub(MEDIAN_WINDOW as u64);
    Ok(Bootstrap {
        height,
        hash: hashes[&height],
        clock_ms: clocks[&height],
        timestamps: (window_from..=height).map(|n| ts[&n]).collect(),
        anchors: clocks.iter().filter(|(n, _)| **n < height).map(|(n, c)| (hashes[n], *n, *c)).collect(),
        cells,
        derived_at,
    })
}

impl Bootstrap {
    pub fn to_json(&self) -> Value {
        json!({
            "height": self.height.to_string(),
            "hash": to_hex(&self.hash),
            "clock_ms": self.clock_ms.to_string(),
            "timestamps": self.timestamps.iter().map(|t| t.to_string()).collect::<Vec<_>>(),
            "anchors": self.anchors.iter().map(|(h, n, c)| json!([to_hex(h), n.to_string(), c.to_string()])).collect::<Vec<_>>(),
            "cells": self.cells.iter().map(|c| json!({
                "tx_hash": to_hex(&c.out_point.tx_hash),
                "index": c.out_point.index.to_string(),
                "lock": script_to_rpc(&c.lock),
                "capacity": c.capacity.to_string(),
                "created_height": c.created.height.to_string(),
                "created_tx_index": c.created.tx_index.to_string(),
            })).collect::<Vec<_>>(),
            "derived_at": [self.derived_at.0.to_string(), to_hex(&self.derived_at.1)],
        })
    }

    pub fn from_json(v: &Value) -> Result<Self> {
        let n = |x: &Value| -> Result<u64> { x.as_str().ok_or_else(|| anyhow!("number"))?.parse().map_err(|e| anyhow!("{e}")) };
        let h = |x: &Value| -> Result<Hash32> { crate::util::hash_arg(x.as_str().unwrap_or("")) };
        let arr = |k: &str| v[k].as_array().cloned().ok_or_else(|| anyhow!("bootstrap field {k}"));
        Ok(Bootstrap {
            height: n(&v["height"])?,
            hash: h(&v["hash"])?,
            clock_ms: n(&v["clock_ms"])?,
            timestamps: arr("timestamps")?.iter().map(n).collect::<Result<_>>()?,
            anchors: arr("anchors")?.iter().map(|a| Ok((h(&a[0])?, n(&a[1])?, n(&a[2])?))).collect::<Result<_>>()?,
            cells: arr("cells")?
                .iter()
                .map(|c| {
                    let op = OutPoint { tx_hash: h(&c["tx_hash"])?, index: n(&c["index"])? as u32 };
                    Ok(BootstrapCell {
                        out_point: op,
                        lock: script_from_rpc(&c["lock"])?,
                        capacity: n(&c["capacity"])?,
                        created: Position { height: n(&c["created_height"])?, tx_index: n(&c["created_tx_index"])? as u32, output_index: op.index, envelope_index: 0 },
                    })
                })
                .collect::<Result<_>>()?,
            derived_at: (n(&v["derived_at"][0])?, h(&v["derived_at"][1])?),
        })
    }
}
