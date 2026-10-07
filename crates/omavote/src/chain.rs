//! Canonical block data from the node: RPC conversion, reduction to the protocol
//! view, the median-time clock and network discovery from the genesis block.

use std::collections::{HashSet, VecDeque};

use anyhow::{anyhow, bail, Context, Result};
use omavote_core::engine::{BlockInput, OutputInput, TxInput};
use omavote_core::molecule::{CellDep, DepType, HashType, OutPoint, Script};
use omavote_core::network::{NetworkParams, ScriptId};
use omavote_core::util::{parse_hash, parse_hex, to_hex, Hash32};
use serde_json::{json, Value};

/// CKB consensus median-time window (blocks, including the block itself).
pub const MEDIAN_WINDOW: usize = 37;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RawOutput {
    pub capacity: u64,
    pub lock: Script,
    pub type_: Option<Script>,
    pub data: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RawTx {
    pub hash: Hash32,
    pub inputs: Vec<OutPoint>,
    pub outputs: Vec<RawOutput>,
    pub witnesses: Vec<Vec<u8>>,
}

/// A full canonical block as returned by the node (only the fields the protocol reads).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RawBlock {
    pub number: u64,
    pub hash: Hash32,
    pub parent_hash: Hash32,
    pub timestamp: u64,
    pub txs: Vec<RawTx>,
}

fn field<'a>(v: &'a Value, key: &str) -> Result<&'a Value> {
    v.get(key).ok_or_else(|| anyhow!("missing field {key}"))
}

pub fn hex_u64(v: &Value) -> Result<u64> {
    let s = v.as_str().ok_or_else(|| anyhow!("expected hex number, got {v}"))?;
    let digits = s.strip_prefix("0x").ok_or_else(|| anyhow!("hex number without 0x: {s}"))?;
    u64::from_str_radix(digits, 16).with_context(|| format!("bad hex number {s}"))
}

pub fn h32(v: &Value) -> Result<Hash32> {
    parse_hash(v.as_str().ok_or_else(|| anyhow!("expected hash string, got {v}"))?, "hash").map_err(|e| anyhow!("{e}"))
}

pub fn hex_bytes(v: &Value) -> Result<Vec<u8>> {
    parse_hex(v.as_str().ok_or_else(|| anyhow!("expected hex bytes, got {v}"))?, "bytes").map_err(|e| anyhow!("{e}"))
}

pub fn script_from_rpc(v: &Value) -> Result<Script> {
    let code_hash = h32(field(v, "code_hash")?)?;
    let hash_type = HashType::parse(field(v, "hash_type")?.as_str().unwrap_or("")).map_err(|e| anyhow!("{e}"))?;
    let args = hex_bytes(field(v, "args")?)?;
    Ok(Script::new(code_hash, hash_type, args))
}

pub fn script_to_rpc(s: &Script) -> Value {
    json!({"code_hash": to_hex(&s.code_hash), "hash_type": s.hash_type.as_str(), "args": to_hex(&s.args)})
}

pub fn out_point_from_rpc(v: &Value) -> Result<OutPoint> {
    Ok(OutPoint { tx_hash: h32(field(v, "tx_hash")?)?, index: hex_u64(field(v, "index")?)? as u32 })
}

pub fn out_point_to_rpc(op: &OutPoint) -> Value {
    json!({"tx_hash": to_hex(&op.tx_hash), "index": format!("0x{:x}", op.index)})
}

impl RawTx {
    pub fn from_rpc(t: &Value) -> Result<Self> {
        let hash = h32(field(t, "hash")?)?;
        let inputs = field(t, "inputs")?
            .as_array()
            .ok_or_else(|| anyhow!("inputs"))?
            .iter()
            .map(|i| out_point_from_rpc(field(i, "previous_output")?))
            .collect::<Result<Vec<_>>>()?;
        let outs = field(t, "outputs")?.as_array().ok_or_else(|| anyhow!("outputs"))?;
        let data = field(t, "outputs_data")?.as_array().ok_or_else(|| anyhow!("outputs_data"))?;
        if outs.len() != data.len() {
            bail!("outputs and outputs_data lengths differ in {}", to_hex(&hash));
        }
        let outputs = outs
            .iter()
            .zip(data)
            .map(|(o, d)| {
                Ok(RawOutput {
                    capacity: hex_u64(field(o, "capacity")?)?,
                    lock: script_from_rpc(field(o, "lock")?)?,
                    type_: match o.get("type") {
                        None | Some(Value::Null) => None,
                        Some(s) => Some(script_from_rpc(s)?),
                    },
                    data: hex_bytes(d)?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let witnesses = field(t, "witnesses")?
            .as_array()
            .ok_or_else(|| anyhow!("witnesses"))?
            .iter()
            .map(hex_bytes)
            .collect::<Result<Vec<_>>>()?;
        Ok(RawTx { hash, inputs, outputs, witnesses })
    }
}

impl RawBlock {
    /// Parse `get_block_by_number` / `get_block` output.
    pub fn from_rpc(v: &Value) -> Result<Self> {
        let h = field(v, "header")?;
        let number = hex_u64(field(h, "number")?)?;
        let txs = field(v, "transactions")?
            .as_array()
            .ok_or_else(|| anyhow!("transactions"))?
            .iter()
            .map(RawTx::from_rpc)
            .collect::<Result<Vec<_>>>()
            .with_context(|| format!("block {number}"))?;
        Ok(RawBlock {
            number,
            hash: h32(field(h, "hash")?)?,
            parent_hash: h32(field(h, "parent_hash")?)?,
            timestamp: hex_u64(field(h, "timestamp")?)?,
            txs,
        })
    }

    /// Reduce to the protocol view (docs/13 §5). Inputs are kept when they spend a
    /// tracked DAO deposit or a deposit created earlier in this block; outputs are kept
    /// when they are DAO deposits or carrier headers; witnesses only for transactions
    /// with carriers. Irrelevant transactions before a relevant one stay as empty
    /// placeholders so that `tx_index` keeps its canonical value.
    pub fn reduce(&self, clock_ms: u64, net: &NetworkParams, tracked: &dyn Fn(&OutPoint) -> bool) -> BlockInput {
        let mut created: HashSet<OutPoint> = HashSet::new();
        let mut txs: Vec<TxInput> = Vec::new();
        let mut last_relevant = 0usize;
        for tx in &self.txs {
            let inputs: Vec<OutPoint> = tx.inputs.iter().filter(|op| tracked(op) || created.contains(op)).copied().collect();
            let mut outputs = Vec::new();
            let mut has_carrier = false;
            for (i, o) in tx.outputs.iter().enumerate() {
                let out = OutputInput {
                    index: i as u32,
                    capacity: o.capacity,
                    lock: o.lock.clone(),
                    type_: o.type_.clone(),
                    data: o.data.clone(),
                };
                if out.is_relevant(net) {
                    if out.type_.as_ref().map(|t| net.is_dao_type(t)).unwrap_or(false) && out.data == [0u8; 8] {
                        created.insert(OutPoint { tx_hash: tx.hash, index: i as u32 });
                    } else {
                        has_carrier = true;
                    }
                    outputs.push(out);
                }
            }
            let relevant = !inputs.is_empty() || !outputs.is_empty();
            let witnesses = if has_carrier { tx.witnesses.clone() } else { Vec::new() };
            txs.push(TxInput { hash: tx.hash, inputs, outputs, witnesses });
            if relevant {
                last_relevant = txs.len();
            }
        }
        txs.truncate(last_relevant);
        BlockInput { number: self.number, hash: self.hash, parent_hash: self.parent_hash, clock_ms, transactions: txs }
    }
}

/// Timestamps of the most recent blocks, ending at the current tip.
#[derive(Clone, Debug, Default)]
pub struct MedianWindow {
    ts: VecDeque<u64>,
}

impl MedianWindow {
    pub fn new() -> Self {
        MedianWindow { ts: VecDeque::with_capacity(MEDIAN_WINDOW + 1) }
    }

    /// CKB `block_median_time(tip)`: sort up to 37 timestamps ending at the tip and
    /// take index `len / 2`.
    pub fn median(&self) -> Option<u64> {
        if self.ts.is_empty() {
            return None;
        }
        let mut v: Vec<u64> = self.ts.iter().copied().collect();
        v.sort_unstable();
        Some(v[v.len() >> 1])
    }

    pub fn push(&mut self, timestamp: u64) {
        self.ts.push_back(timestamp);
        while self.ts.len() > MEDIAN_WINDOW {
            self.ts.pop_front();
        }
    }

    /// `clock(b)` for the next block. Genesis has no parent; its clock is taken as
    /// its own timestamp (it carries no protocol objects).
    pub fn clock_for_next(&self, own_timestamp: u64) -> u64 {
        self.median().unwrap_or(own_timestamp)
    }
}

/// Well-known cells every standard chain spec places in its genesis block.
#[derive(Clone, Debug)]
pub struct GenesisCells {
    /// secp256k1_blake160_sighash_all dep group (genesis tx 1, output 0).
    pub secp_dep_group: CellDep,
    /// Nervos DAO code cell (genesis tx 0, output 2).
    pub dao_code: CellDep,
}

/// Optional script identities for development chains (Omnilock / PW Lock are not
/// deployed there; a demo may still declare identities to exercise EVM owners).
#[derive(Clone, Debug, Default, serde::Deserialize, serde::Serialize)]
pub struct NetworkOverrides {
    pub omnilock: Option<ScriptIdConfig>,
    pub pw_lock: Option<ScriptIdConfig>,
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
pub struct ScriptIdConfig {
    pub code_hash: String,
    pub hash_type: String,
}

impl ScriptIdConfig {
    pub fn to_id(&self) -> Result<ScriptId> {
        Ok(ScriptId {
            code_hash: parse_hash(&self.code_hash, "code_hash").map_err(|e| anyhow!("{e}"))?,
            hash_type: HashType::parse(&self.hash_type).map_err(|e| anyhow!("{e}"))?,
        })
    }
}

/// Network parameters from the genesis block: the fixed registry for mainnet and
/// testnet, otherwise identities read from the development chain's own genesis.
pub fn discover_network(genesis: &RawBlock, overrides: &NetworkOverrides) -> Result<(NetworkParams, GenesisCells)> {
    if genesis.number != 0 || genesis.txs.len() < 2 {
        bail!("not a genesis block");
    }
    let tx0 = &genesis.txs[0];
    let tx1 = &genesis.txs[1];
    let cells = GenesisCells {
        secp_dep_group: CellDep { out_point: OutPoint { tx_hash: tx1.hash, index: 0 }, dep_type: DepType::DepGroup },
        dao_code: CellDep { out_point: OutPoint { tx_hash: tx0.hash, index: 2 }, dep_type: DepType::Code },
    };
    if let Some(known) = NetworkParams::known(&genesis.hash) {
        if overrides.omnilock.is_some() || overrides.pw_lock.is_some() {
            bail!("script overrides are only allowed on development chains");
        }
        return Ok((known, cells));
    }
    let type_hash = |i: usize, what: &str| -> Result<ScriptId> {
        let t = tx0
            .outputs
            .get(i)
            .and_then(|o| o.type_.as_ref())
            .ok_or_else(|| anyhow!("genesis output {i} ({what}) has no type script"))?;
        Ok(ScriptId { code_hash: t.hash(), hash_type: HashType::Type })
    };
    let mut net = NetworkParams::devnet(genesis.hash, type_hash(1, "secp256k1")?, type_hash(2, "dao")?);
    net.omnilock = overrides.omnilock.as_ref().map(|c| c.to_id()).transpose()?;
    net.pw_lock = overrides.pw_lock.as_ref().map(|c| c.to_id()).transpose()?;
    Ok((net, cells))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn median_matches_ckb_definition() {
        let mut w = MedianWindow::new();
        assert_eq!(w.clock_for_next(5), 5);
        w.push(0);
        assert_eq!(w.median(), Some(0));
        w.push(10);
        // [0, 10] -> index 1
        assert_eq!(w.median(), Some(10));
        w.push(5);
        // [0, 5, 10] -> index 1
        assert_eq!(w.median(), Some(5));
        for t in 100..200 {
            w.push(t);
        }
        // last 37 values are 163..=199, median index 18 -> 181
        assert_eq!(w.median(), Some(181));
    }
}
