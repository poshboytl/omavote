//! `omavote verify`: replay from the operator's own node and print `result_core`,
//! `result_hash` and the evidence bundle. It never reads the server database
//! (docs/13 §5).

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{anyhow, bail, Context, Result};
use omavote_core::engine::{BlockInput, EngineConfig};
use omavote_core::json::parse;
use omavote_core::tally;
use omavote_core::types::MAX_PROCESS_PUBLICATION_DELAY_MS;
use omavote_core::util::{to_hex, Hash32};
use serde_json::{json, Value};

use crate::chain::{discover_network, NetworkOverrides, RawBlock};
use crate::rpc::Rpc;
use crate::store::Store;
use crate::sync::{read, SyncConfig, Syncer};
use crate::util::{core_err, dec, hash_arg, now_ms, to_serde};
use crate::views;

#[derive(clap::Args, Debug)]
pub struct VerifyArgs {
    /// JSON-RPC endpoint of your own CKB node.
    #[arg(long, default_value = "http://127.0.0.1:8114")]
    pub rpc: String,
    /// Poll to report (default: every poll found).
    #[arg(long)]
    pub poll: Option<String>,
    /// Initial process roles hash fixed by the deployment (switch proposal).
    #[arg(long)]
    pub initial_roles_hash: Option<String>,
    /// Process record publication delay in ms (deployment parameter, candidate 72h).
    #[arg(long, default_value_t = MAX_PROCESS_PUBLICATION_DELAY_MS)]
    pub process_delay_ms: u64,
    /// Development chains only: TOML/JSON file declaring Omnilock / PW Lock identities.
    #[arg(long)]
    pub network_overrides: Option<PathBuf>,
    /// Replay up to this height (default: the node tip when the run starts).
    #[arg(long)]
    pub to: Option<u64>,
    /// Cross-check every computed clock against the node's get_block_median_time.
    #[arg(long)]
    pub check_clock: bool,
    /// Write the evidence bundle of `--poll` to this file.
    #[arg(long)]
    pub out: Option<PathBuf>,
    /// Write the reduced block data (replay-vector format) for differential testing.
    #[arg(long)]
    pub dump_blocks: Option<PathBuf>,
}

pub fn load_overrides(path: &Option<PathBuf>) -> Result<NetworkOverrides> {
    match path {
        None => Ok(NetworkOverrides::default()),
        Some(p) => {
            let text = std::fs::read_to_string(p).with_context(|| format!("read {}", p.display()))?;
            if p.extension().map(|e| e == "json").unwrap_or(false) {
                Ok(serde_json::from_str(&text)?)
            } else {
                Ok(toml::from_str(&text)?)
            }
        }
    }
}

pub async fn run(args: VerifyArgs) -> Result<()> {
    let rpc = Rpc::new(&args.rpc);
    let genesis = RawBlock::from_rpc(&rpc.block_by_number(0).await?.ok_or_else(|| anyhow!("node has no genesis block"))?)?;
    let (net, _) = discover_network(&genesis, &load_overrides(&args.network_overrides)?)?;
    let mut ecfg = EngineConfig::new(net.clone());
    ecfg.initial_roles_hash = args.initial_roles_hash.as_deref().map(hash_arg).transpose()?;
    ecfg.process_publication_delay_ms = args.process_delay_ms;
    let tip = rpc.tip_number().await?;
    let to = args.to.unwrap_or(tip).min(tip);
    let mut cfg = SyncConfig::new(ecfg.clone());
    cfg.batch = 100;
    cfg.check_clock = args.check_clock;
    cfg.stop_at = Some(to);
    cfg.snapshot_every = 0;
    let store = Arc::new(Store::in_memory()?);
    let syncer = Syncer::new(rpc, Some(store.clone()), cfg);
    let started = std::time::Instant::now();
    syncer.catch_up().await.context("replay")?;
    let st = read(&syncer.state);
    let engine = &st.engine;
    eprintln!(
        "replayed {} blocks (0..={}) in {:.1}s{}",
        to + 1,
        to,
        started.elapsed().as_secs_f64(),
        if args.check_clock { ", clock checked against the node" } else { "" }
    );

    let wanted: Option<Hash32> = args.poll.as_deref().map(hash_arg).transpose()?;
    let mut polls = Vec::new();
    for (id, poll) in &engine.polls {
        if wanted.map(|w| &w != id).unwrap_or(false) {
            continue;
        }
        let rc = tally::result_core(engine, id);
        let (result_core, result_hash, error) = match &rc {
            Ok(Some(r)) => (to_serde(&r.value), Value::String(to_hex(&r.result_hash())), Value::Null),
            Ok(None) => (Value::Null, Value::Null, json!("poll still open at this height")),
            Err(e) => (Value::Null, Value::Null, json!(e.to_string())),
        };
        let rc_ok = rc.ok().flatten();
        polls.push(json!({
            "poll_id": to_hex(id),
            "title": poll.manifest.title,
            "status": views::poll_status(engine, poll, rc_ok.as_ref()),
            "admission": views::admission_json(&tally::admission(engine, poll)),
            "attestation": views::attestation_json(&tally::attestation(engine, id, rc_ok.as_ref())),
            "governance": views::governance_json(&tally::governance(engine, id)),
            "result_hash": result_hash,
            "result_core": result_core,
            "note": error,
        }));
    }
    if let Some(w) = wanted {
        if polls.is_empty() {
            bail!("poll {} not found up to height {to}", to_hex(&w));
        }
        if let Some(out) = &args.out {
            let b = views::bundle(engine, &w, &views::BundleMeta { mode: "full-replay-from-genesis".into(), generated_at_ms: now_ms() })?;
            std::fs::write(out, serde_json::to_string_pretty(&b)? + "\n")?;
            eprintln!("evidence bundle written to {}", out.display());
        }
    }
    let report = json!({
        "verifier": {"name": "omavote verify", "version": env!("CARGO_PKG_VERSION"), "mode": "full-replay-from-genesis", "clock_checked": args.check_clock},
        "network": to_serde(&net.to_json()),
        "tip": views::at(engine),
        "initial_roles_hash": args.initial_roles_hash,
        "process_publication_delay_ms": dec(args.process_delay_ms),
        "diagnostics": engine.diagnostics.len().to_string(),
        "polls": polls,
    });
    println!("{}", serde_json::to_string_pretty(&report)?);

    if let Some(path) = &args.dump_blocks {
        let mut blocks = Vec::new();
        store.for_each_block(0, to, |row| {
            let b = match &row.body {
                Some(body) => BlockInput::from_json(&parse(body.as_bytes()).map_err(core_err)?).map_err(core_err)?,
                None => BlockInput {
                    number: row.number,
                    hash: row.hash,
                    parent_hash: row.parent_hash,
                    clock_ms: row.clock_ms,
                    transactions: Vec::new(),
                },
            };
            blocks.push(to_serde(&b.to_json()));
            Ok(())
        })?;
        let dump = json!({
            "network": to_serde(&net.to_json()),
            "initial_roles_hash": args.initial_roles_hash,
            "process_publication_delay_ms": dec(args.process_delay_ms),
            "blocks": blocks,
        });
        std::fs::write(path, serde_json::to_string(&dump)? + "\n")?;
        eprintln!("reduced blocks written to {}", path.display());
    }
    Ok(())
}
