//! Transaction construction for the relay and development tools: input selection,
//! carrier outputs with payload witnesses after all input witnesses, change, fee and
//! secp256k1_blake160_sighash_all signing (docs/03 §7, docs/13 §6).

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{anyhow, bail, Context, Result};
use omavote_core::adapter::{secp256k1_pubkey, sign_digest_recoverable};
use omavote_core::carrier::{self, Header, Kind};
use omavote_core::hash::{blake160, CkbHasher};
use omavote_core::molecule::{CellDep, CellInput, CellOutput, DepType, OutPoint, RawTransaction, Script, Transaction, WitnessArgs};
use omavote_core::network::NetworkParams;
use omavote_core::util::{parse_hex_fixed, to_hex, Hash32};
use serde_json::{json, Value};

use crate::chain::{hex_bytes, hex_u64, out_point_from_rpc, out_point_to_rpc, script_from_rpc, script_to_rpc};
use crate::rpc::Rpc;

pub const SHANNONS: u64 = 100_000_000;
/// Smallest change cell with a standard secp256k1 lock (61 CKB).
pub const MIN_CHANGE: u64 = 61 * SHANNONS;

/// A secp256k1_blake160 key. Keep relay keys in their own file with 0600 permissions;
/// development keys must never hold real funds.
#[derive(Clone)]
pub struct Wallet {
    secret: [u8; 32],
    pub pubkey: [u8; 33],
    pub lock: Script,
}

impl Wallet {
    pub fn from_secret(secret: [u8; 32], net: &NetworkParams) -> Result<Self> {
        let pubkey = secp256k1_pubkey(&secret).map_err(|e| anyhow!("{e}"))?;
        let lock = net.secp256k1.with_args(blake160(&pubkey).to_vec());
        Ok(Wallet { secret, pubkey, lock })
    }

    pub fn from_key_file(path: &Path, net: &NetworkParams) -> Result<Self> {
        let text = std::fs::read_to_string(path).with_context(|| format!("read key file {}", path.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(path)?.permissions().mode();
            if mode & 0o077 != 0 {
                tracing::warn!("key file {} is readable by other users (mode {:o}); use chmod 600", path.display(), mode & 0o777);
            }
        }
        let secret = parse_hex_fixed::<32>(text.trim(), "secret key").map_err(|e| anyhow!("{e}"))?;
        Self::from_secret(secret, net)
    }

    pub fn secret(&self) -> &[u8; 32] {
        &self.secret
    }

    pub fn address(&self, net: &NetworkParams) -> String {
        net.address(&self.lock).unwrap_or_default()
    }
}

/// Write a fresh random secret key to `path` (mode 0600).
pub fn generate_key_file(path: &Path) -> Result<()> {
    if path.exists() {
        bail!("{} already exists; refusing to overwrite a key", path.display());
    }
    let mut secret = [0u8; 32];
    loop {
        getrandom::getrandom(&mut secret).map_err(|e| anyhow!("random: {e}"))?;
        if secp256k1_pubkey(&secret).is_ok() {
            break;
        }
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    use std::io::Write;
    let mut f = opts.open(path)?;
    writeln!(f, "{}", to_hex(&secret))?;
    Ok(())
}

#[derive(Clone, Debug)]
pub struct LiveCell {
    pub out_point: OutPoint,
    pub capacity: u64,
    pub lock: Script,
    pub type_: Option<Script>,
    pub data: Vec<u8>,
}

impl LiveCell {
    pub fn from_indexer(v: &Value) -> Result<Self> {
        let o = &v["output"];
        Ok(LiveCell {
            out_point: out_point_from_rpc(&v["out_point"])?,
            capacity: hex_u64(&o["capacity"])?,
            lock: script_from_rpc(&o["lock"])?,
            type_: match &o["type"] {
                Value::Null => None,
                t => Some(script_from_rpc(t)?),
            },
            data: hex_bytes(&v["output_data"]).unwrap_or_default(),
        })
    }

    /// Plain capacity cells and our own reclaimable carrier cells.
    pub fn spendable_by_relay(&self) -> bool {
        self.type_.is_none() && (self.data.is_empty() || (self.data.len() == carrier::HEADER_LEN && self.data.starts_with(carrier::MAGIC)))
    }
}

/// All live cells of a lock from the node's indexer.
pub async fn live_cells(rpc: &Rpc, lock: &Script) -> Result<Vec<LiveCell>> {
    let lock_json = script_to_rpc(lock);
    let mut out = Vec::new();
    let mut cursor = None;
    loop {
        let (objects, next) = rpc.cells_by_lock(&lock_json, 200, cursor).await?;
        let n = objects.len();
        for o in &objects {
            out.push(LiveCell::from_indexer(o)?);
        }
        if n < 200 || next.is_none() {
            break;
        }
        cursor = next;
    }
    Ok(out)
}

/// What to build; inputs beyond `fixed_inputs` are selected from the payer's cells.
#[derive(Clone, Debug, Default)]
pub struct TxPlan {
    pub cell_deps: Vec<CellDep>,
    pub header_deps: Vec<Hash32>,
    /// Inputs that must be spent (e.g. a deposit being withdrawn), with their locks.
    pub fixed_inputs: Vec<LiveCell>,
    pub outputs: Vec<(CellOutput, Vec<u8>)>,
    /// Carriers: one output each (payer lock, no type) plus one payload witness.
    pub carriers: Vec<(Kind, Hash32, Vec<u8>)>,
}

pub struct Built {
    pub tx: Transaction,
    pub hash: Hash32,
    pub fee: u64,
    pub inputs: Vec<OutPoint>,
}

fn carrier_output(lock: &Script) -> CellOutput {
    let mut o = CellOutput { capacity: 0, lock: lock.clone(), type_: None };
    o.capacity = o.occupied_capacity(carrier::HEADER_LEN);
    o
}

fn assemble(plan: &TxPlan, payer: &Script, inputs: &[LiveCell], change: Option<u64>) -> Transaction {
    let n_inputs = inputs.len();
    let mut outputs = Vec::new();
    let mut outputs_data = Vec::new();
    for (o, d) in &plan.outputs {
        outputs.push(o.clone());
        outputs_data.push(d.clone());
    }
    let mut payload_witnesses = Vec::new();
    for (i, (kind, scope, payload)) in plan.carriers.iter().enumerate() {
        let header = Header {
            kind: *kind,
            scope_id: *scope,
            payload_hash: carrier::payload_hash(*kind, payload),
            witness_index: (n_inputs + i) as u32,
        };
        outputs.push(carrier_output(payer));
        outputs_data.push(header.encode());
        payload_witnesses.push(payload.clone());
    }
    if let Some(c) = change {
        outputs.push(CellOutput { capacity: c, lock: payer.clone(), type_: None });
        outputs_data.push(Vec::new());
    }
    // One witness per input: the first input of each lock group carries a 65-byte
    // placeholder lock, other group members stay empty.
    let mut seen: Vec<&Script> = Vec::new();
    let mut witnesses = Vec::new();
    for c in inputs {
        if seen.contains(&&c.lock) {
            witnesses.push(Vec::new());
        } else {
            seen.push(&c.lock);
            witnesses.push(WitnessArgs { lock: Some(vec![0u8; 65]), input_type: None, output_type: None }.serialize());
        }
    }
    witnesses.extend(payload_witnesses);
    Transaction {
        raw: RawTransaction {
            version: 0,
            cell_deps: plan.cell_deps.clone(),
            header_deps: plan.header_deps.clone(),
            inputs: inputs.iter().map(|c| CellInput { since: 0, previous_output: c.out_point }).collect(),
            outputs,
            outputs_data,
        },
        witnesses,
    }
}

fn fee_for(tx: &Transaction, fee_rate: u64) -> u64 {
    // Block inclusion counts 4 extra bytes for the transaction offset.
    let size = tx.serialized_size() as u64 + 4;
    (size * fee_rate).div_ceil(1000)
}

/// Sign every lock group with the matching key (secp256k1_blake160_sighash_all).
pub fn sign(tx: &mut Transaction, input_locks: &[Script], keys: &[&Wallet]) -> Result<()> {
    let tx_hash = tx.raw.hash();
    let n_inputs = input_locks.len();
    let mut groups: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    let mut first_of: Vec<usize> = Vec::new();
    for (i, lock) in input_locks.iter().enumerate() {
        let first = input_locks.iter().position(|l| l == lock).unwrap();
        groups.entry(first).or_default().push(i);
        if first == i {
            first_of.push(i);
        }
    }
    for (first, members) in groups {
        let lock = &input_locks[first];
        let key = keys.iter().find(|k| &k.lock == lock).ok_or_else(|| anyhow!("no key for input lock {}", to_hex(&lock.args)))?;
        let placeholder = WitnessArgs { lock: Some(vec![0u8; 65]), input_type: None, output_type: None }.serialize();
        let mut h = CkbHasher::new();
        h.update(&tx_hash);
        h.update(&(placeholder.len() as u64).to_le_bytes()).update(&placeholder);
        for &i in &members[1..] {
            let w = &tx.witnesses[i];
            h.update(&(w.len() as u64).to_le_bytes()).update(w);
        }
        for w in &tx.witnesses[n_inputs..] {
            h.update(&(w.len() as u64).to_le_bytes()).update(w);
        }
        let sig = sign_digest_recoverable(key.secret(), &h.finalize()).map_err(|e| anyhow!("{e}"))?;
        tx.witnesses[first] = WitnessArgs { lock: Some(sig.to_vec()), input_type: None, output_type: None }.serialize();
    }
    Ok(())
}

/// Select payer inputs, add change, compute the fee and sign.
pub fn build(plan: &TxPlan, payer: &Wallet, mut available: Vec<LiveCell>, extra_keys: &[&Wallet], fee_rate: u64) -> Result<Built> {
    for (k, _, payload) in &plan.carriers {
        if payload.len() > carrier::MAX_WITNESS_BYTES {
            bail!("{k:?} payload exceeds the 32 KiB witness limit");
        }
    }
    available.sort_by(|a, b| b.capacity.cmp(&a.capacity).then(a.out_point.tx_hash.cmp(&b.out_point.tx_hash)));
    let out_total: u64 =
        plan.outputs.iter().map(|(o, _)| o.capacity).sum::<u64>() + plan.carriers.len() as u64 * carrier_output(&payer.lock).capacity;
    let fixed_total: u64 = plan.fixed_inputs.iter().map(|c| c.capacity).sum();
    let mut selected: Vec<LiveCell> = Vec::new();
    let mut avail = available.into_iter();
    loop {
        let inputs: Vec<LiveCell> = plan.fixed_inputs.iter().cloned().chain(selected.iter().cloned()).collect();
        let in_total = fixed_total + selected.iter().map(|c| c.capacity).sum::<u64>();
        // Estimate with a change output (the common case).
        let probe = assemble(plan, &payer.lock, &inputs, Some(MIN_CHANGE));
        let fee = fee_for(&probe, fee_rate);
        if in_total >= out_total + fee + MIN_CHANGE {
            let change = in_total - out_total - fee;
            let mut tx = assemble(plan, &payer.lock, &inputs, Some(change));
            let locks: Vec<Script> = inputs.iter().map(|c| c.lock.clone()).collect();
            let mut keys: Vec<&Wallet> = vec![payer];
            keys.extend_from_slice(extra_keys);
            sign(&mut tx, &locks, &keys)?;
            let hash = tx.raw.hash();
            return Ok(Built { hash, fee, inputs: inputs.iter().map(|c| c.out_point).collect(), tx });
        }
        match avail.next() {
            Some(c) => selected.push(c),
            None => {
                bail!("insufficient capacity: need {} CKB, have {} CKB", (out_total + fee + MIN_CHANGE) / SHANNONS, in_total / SHANNONS)
            }
        }
    }
}

pub fn tx_to_rpc(tx: &Transaction) -> Value {
    let r = &tx.raw;
    json!({
        "version": format!("0x{:x}", r.version),
        "cell_deps": r.cell_deps.iter().map(|d| json!({
            "out_point": out_point_to_rpc(&d.out_point),
            "dep_type": match d.dep_type { DepType::Code => "code", DepType::DepGroup => "dep_group" },
        })).collect::<Vec<_>>(),
        "header_deps": r.header_deps.iter().map(|h| to_hex(h)).collect::<Vec<_>>(),
        "inputs": r.inputs.iter().map(|i| json!({"since": format!("0x{:x}", i.since), "previous_output": out_point_to_rpc(&i.previous_output)})).collect::<Vec<_>>(),
        "outputs": r.outputs.iter().map(|o| json!({
            "capacity": format!("0x{:x}", o.capacity),
            "lock": script_to_rpc(&o.lock),
            "type": o.type_.as_ref().map(script_to_rpc),
        })).collect::<Vec<_>>(),
        "outputs_data": r.outputs_data.iter().map(|d| to_hex(d)).collect::<Vec<_>>(),
        "witnesses": tx.witnesses.iter().map(|w| to_hex(w)).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
pub fn tx_from_rpc(v: &Value) -> Result<Transaction> {
    let arr = |k: &str| v[k].as_array().cloned().ok_or_else(|| anyhow!("transaction field {k}"));
    let cell_deps = arr("cell_deps")?
        .iter()
        .map(|d| {
            Ok(CellDep {
                out_point: out_point_from_rpc(&d["out_point"])?,
                dep_type: if d["dep_type"] == "dep_group" { DepType::DepGroup } else { DepType::Code },
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let header_deps = arr("header_deps")?.iter().map(crate::chain::h32).collect::<Result<Vec<_>>>()?;
    let inputs = arr("inputs")?
        .iter()
        .map(|i| Ok(CellInput { since: hex_u64(&i["since"])?, previous_output: out_point_from_rpc(&i["previous_output"])? }))
        .collect::<Result<Vec<_>>>()?;
    let outputs = arr("outputs")?
        .iter()
        .map(|o| {
            Ok(CellOutput {
                capacity: hex_u64(&o["capacity"])?,
                lock: script_from_rpc(&o["lock"])?,
                type_: if o["type"].is_null() { None } else { Some(script_from_rpc(&o["type"])?) },
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let outputs_data = arr("outputs_data")?.iter().map(hex_bytes).collect::<Result<Vec<_>>>()?;
    let witnesses = arr("witnesses")?.iter().map(hex_bytes).collect::<Result<Vec<_>>>()?;
    Ok(Transaction {
        raw: RawTransaction { version: hex_u64(&v["version"])? as u32, cell_deps, header_deps, inputs, outputs, outputs_data },
        witnesses,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use omavote_core::testkit::test_network;

    fn cell(lock: &Script, ckb: u64, tag: u8) -> LiveCell {
        LiveCell {
            out_point: OutPoint { tx_hash: [tag; 32], index: 0 },
            capacity: ckb * SHANNONS,
            lock: lock.clone(),
            type_: None,
            data: vec![],
        }
    }

    #[test]
    fn carrier_tx_layout_and_balance() {
        let net = test_network();
        let w = Wallet::from_secret(omavote_core::adapter::test_secret("relay"), &net).unwrap();
        let plan = TxPlan {
            cell_deps: vec![],
            header_deps: vec![],
            fixed_inputs: vec![],
            outputs: vec![],
            carriers: vec![(Kind::BallotBatch, [1; 32], b"{\"a\":\"b\"}".to_vec()), (Kind::AuthorizationBatch, [2; 32], b"{}".to_vec())],
        };
        let b = build(&plan, &w, vec![cell(&w.lock, 100, 1), cell(&w.lock, 1000, 2)], &[], 1000).unwrap();
        let tx = &b.tx;
        assert_eq!(tx.raw.inputs.len(), 1, "largest cell first");
        assert_eq!(tx.witnesses.len(), 3, "one input witness then two payload witnesses");
        let h0 = Header::decode(&tx.raw.outputs_data[0]).unwrap().unwrap();
        let h1 = Header::decode(&tx.raw.outputs_data[1]).unwrap().unwrap();
        assert_eq!((h0.witness_index, h1.witness_index), (1, 2));
        assert_eq!(tx.raw.outputs[0].capacity, 139 * SHANNONS);
        let out: u64 = tx.raw.outputs.iter().map(|o| o.capacity).sum();
        assert_eq!(out + b.fee, 1000 * SHANNONS);
        assert_eq!(tx_from_rpc(&tx_to_rpc(tx)).unwrap(), *tx);
        assert!(b.fee > 0 && b.fee < SHANNONS);
    }
}
