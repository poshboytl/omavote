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
    /// Accelerated mode: start at this height with the DAO deposit set derived from the
    /// node's indexer (valid only if no protocol object exists at or below it).
    #[arg(long)]
    pub from_height: Option<u64>,
    /// Blocks below `--from-height` kept as possible anchors.
    #[arg(long, default_value_t = 20_000)]
    pub anchor_blocks: u64,
    /// With `--from-height`: also replay from genesis and require identical deposit
    /// sets at the start height and identical result hashes.
    #[arg(long)]
    pub compare: bool,
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

pub struct ReplayOptions {
    pub rpc: String,
    pub overrides: NetworkOverrides,
    pub initial_roles_hash: Option<Hash32>,
    pub process_delay_ms: u64,
    pub to: Option<u64>,
    pub check_clock: bool,
    /// Accelerated start `(height, anchor_blocks)`.
    pub from: Option<(u64, u64)>,
}

pub struct Replay {
    pub syncer: Syncer<Rpc>,
    pub store: Arc<Store>,
    pub net: omavote_core::network::NetworkParams,
    pub to: u64,
    pub bootstrap: Option<crate::bootstrap::Bootstrap>,
}

/// Full replay from genesis using only the node (and an in-memory block cache).
pub async fn replay(o: &ReplayOptions) -> Result<Replay> {
    let rpc = Rpc::new(&o.rpc);
    let genesis = RawBlock::from_rpc(&rpc.block_by_number(0).await?.ok_or_else(|| anyhow!("node has no genesis block"))?)?;
    let (net, _) = discover_network(&genesis, &o.overrides)?;
    let mut ecfg = EngineConfig::new(net.clone());
    ecfg.initial_roles_hash = o.initial_roles_hash;
    ecfg.process_publication_delay_ms = o.process_delay_ms;
    let tip = rpc.tip_number().await?;
    let to = o.to.unwrap_or(tip).min(tip);
    let mut cfg = SyncConfig::new(ecfg);
    cfg.batch = 100;
    cfg.check_clock = o.check_clock;
    cfg.stop_at = Some(to);
    cfg.snapshot_every = 0;
    if let Some((h0, anchors)) = o.from {
        if h0 > to {
            bail!("--from-height {h0} is above the replay end {to}");
        }
        cfg.bootstrap = Some(crate::bootstrap::build(&rpc, &net, h0, anchors).await?);
    }
    let bootstrap = cfg.bootstrap.clone();
    let store = Arc::new(Store::in_memory()?);
    let syncer = Syncer::new(rpc, Some(store.clone()), cfg);
    syncer.catch_up().await.context("replay")?;
    Ok(Replay { syncer, store, net, to, bootstrap })
}

/// Deposit set of an engine as comparable tuples.
fn deposit_set(engine: &omavote_core::engine::Engine) -> std::collections::BTreeSet<(String, u32, String, u64)> {
    engine.dao_cells.iter().map(|(op, c)| (to_hex(&op.tx_hash), op.index, to_hex(&c.owner_id), c.capacity)).collect()
}

/// Accelerated mode must reproduce the full replay: same deposits at the start height
/// and the same result hash for every poll.
async fn compare_modes(opts: &ReplayOptions, fast: &Replay) -> Result<Value> {
    let b = fast.bootstrap.as_ref().ok_or_else(|| anyhow!("--compare needs --from-height"))?;
    let at_start = replay(&ReplayOptions { to: Some(b.height), from: None, check_clock: false, ..opts.clone_basic() }).await?;
    let full_set = deposit_set(&read(&at_start.syncer.state).engine);
    let mut boot = omavote_core::engine::Engine::new(omavote_core::engine::EngineConfig::new(fast.net.clone()));
    boot.bootstrap(b.height, b.hash, b.clock_ms, b.cells.clone());
    let boot_set = deposit_set(&boot);
    let deposits_equal = full_set == boot_set;
    let full = replay(&ReplayOptions { to: Some(fast.to), from: None, check_clock: false, ..opts.clone_basic() }).await?;
    let full_report = poll_report(&read(&full.syncer.state).engine, None);
    let fast_report = poll_report(&read(&fast.syncer.state).engine, None);
    // Only polls registered above the start height can be compared: objects at or
    // below it are, by the mode's precondition, not supposed to exist.
    let after_start =
        |p: &&Value| p["registered_height"].as_str().and_then(|h| h.parse::<u64>().ok()).map(|h| h > b.height).unwrap_or(false);
    let hashes = |r: &Vec<Value>| -> std::collections::BTreeMap<String, Value> {
        r.iter().filter(after_start).map(|p| (p["poll_id"].as_str().unwrap_or("").to_string(), p["result_hash"].clone())).collect()
    };
    let (fh, ah) = (hashes(&full_report), hashes(&fast_report));
    let results_equal = fh == ah;
    if !deposits_equal || !results_equal {
        bail!(
            "accelerated replay differs from the full replay: deposits equal {deposits_equal}, results equal {results_equal} ({} vs {} deposits)",
            boot_set.len(),
            full_set.len()
        );
    }
    Ok(json!({
        "start_height": b.height.to_string(),
        "deposits_at_start": boot_set.len().to_string(),
        "deposits_equal": true,
        "polls_compared": fh.len().to_string(),
        "results_equal": true,
    }))
}

impl ReplayOptions {
    fn clone_basic(&self) -> ReplayOptions {
        ReplayOptions {
            rpc: self.rpc.clone(),
            overrides: self.overrides.clone(),
            initial_roles_hash: self.initial_roles_hash,
            process_delay_ms: self.process_delay_ms,
            to: self.to,
            check_clock: self.check_clock,
            from: self.from,
        }
    }
}

/// Per-poll verification report.
pub fn poll_report(engine: &omavote_core::engine::Engine, wanted: Option<Hash32>) -> Vec<Value> {
    let mut polls = Vec::new();
    for (id, poll) in &engine.polls {
        if wanted.map(|w| &w != id).unwrap_or(false) {
            continue;
        }
        let rc = tally::result_core(engine, id);
        let (result_core, result_hash, note) = match &rc {
            Ok(Some(r)) => (to_serde(&r.value), Value::String(to_hex(&r.result_hash())), Value::Null),
            Ok(None) => (Value::Null, Value::Null, json!("poll still open at this height")),
            Err(e) => (Value::Null, Value::Null, json!(e.to_string())),
        };
        let rc_ok = rc.ok().flatten();
        polls.push(json!({
            "poll_id": to_hex(id),
            "registered_height": poll.registered.height.to_string(),
            "title": poll.manifest.title,
            "status": views::poll_status(engine, poll, rc_ok.as_ref()),
            "admission": views::admission_json(&tally::admission(engine, poll)),
            "attestation": views::attestation_json(&tally::attestation(engine, id, rc_ok.as_ref())),
            "governance": views::governance_json(&tally::governance(engine, id)),
            "result_hash": result_hash,
            "result_core": result_core,
            "tally_diagnostics": views::tally_diagnostics(engine, id),
            "note": note,
        }));
    }
    polls
}

/// Reduced blocks in the replay-vector format (input for the TypeScript verifier).
pub fn dump_blocks(r: &Replay, initial_roles_hash: Option<Hash32>, process_delay_ms: u64) -> Result<Value> {
    let mut blocks = Vec::new();
    r.store.for_each_block(0, r.to, |row| {
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
    Ok(json!({
        "network": to_serde(&r.net.to_json()),
        "initial_roles_hash": initial_roles_hash.map(|h| to_hex(&h)),
        "process_publication_delay_ms": dec(process_delay_ms),
        "blocks": blocks,
    }))
}

pub async fn run(args: VerifyArgs) -> Result<()> {
    let opts = ReplayOptions {
        rpc: args.rpc.clone(),
        overrides: load_overrides(&args.network_overrides)?,
        initial_roles_hash: args.initial_roles_hash.as_deref().map(hash_arg).transpose()?,
        process_delay_ms: args.process_delay_ms,
        to: args.to,
        check_clock: args.check_clock,
        from: args.from_height.map(|h| (h, args.anchor_blocks)),
    };
    let started = std::time::Instant::now();
    let r = replay(&opts).await?;
    let comparison = if args.compare { Some(compare_modes(&opts, &r).await?) } else { None };
    let st = read(&r.syncer.state);
    let engine = &st.engine;
    let first = r.bootstrap.as_ref().map(|b| b.height + 1).unwrap_or(0);
    eprintln!(
        "replayed {} blocks ({}..={}) in {:.1}s{}",
        r.to + 1 - first,
        first,
        r.to,
        started.elapsed().as_secs_f64(),
        if args.check_clock { ", clock checked against the node" } else { "" }
    );
    let wanted: Option<Hash32> = args.poll.as_deref().map(hash_arg).transpose()?;
    let polls = poll_report(engine, wanted);
    if let Some(w) = wanted {
        if polls.is_empty() {
            bail!("poll {} not found up to height {}", to_hex(&w), r.to);
        }
        if let Some(out) = &args.out {
            let b = views::bundle(engine, &w, &views::BundleMeta { mode: "full-replay-from-genesis".into(), generated_at_ms: now_ms() })?;
            std::fs::write(out, serde_json::to_string_pretty(&b)? + "\n")?;
            eprintln!("evidence bundle written to {}", out.display());
        }
    }
    let mode = match &r.bootstrap {
        Some(b) => format!("accelerated-from-height-{}", b.height),
        None => "full-replay-from-genesis".to_string(),
    };
    let report = json!({
        "verifier": {"name": "omavote verify", "version": env!("CARGO_PKG_VERSION"), "mode": mode, "clock_checked": args.check_clock},
        "bootstrap": r.bootstrap.as_ref().map(|b| json!({
            "height": b.height.to_string(),
            "hash": to_hex(&b.hash),
            "deposits": b.cells.len().to_string(),
            "derived_at_indexer_tip": [b.derived_at.0.to_string(), to_hex(&b.derived_at.1)],
        })),
        "comparison_with_full_replay": comparison,
        "network": to_serde(&r.net.to_json()),
        "tip": views::at(engine),
        "initial_roles_hash": args.initial_roles_hash,
        "process_publication_delay_ms": dec(args.process_delay_ms),
        "diagnostics": engine.diagnostics.len().to_string(),
        "polls": polls,
    });
    println!("{}", serde_json::to_string_pretty(&report)?);
    if let Some(path) = &args.dump_blocks {
        let dump = dump_blocks(&r, opts.initial_roles_hash, args.process_delay_ms)?;
        std::fs::write(path, serde_json::to_string(&dump)? + "\n")?;
        eprintln!("reduced blocks written to {}", path.display());
    }
    Ok(())
}

#[derive(clap::Args, Debug)]
pub struct EvidenceArgs {
    /// Evidence bundle downloaded with `?history=true` (or a block dump).
    #[arg(long)]
    pub input: PathBuf,
    /// Poll to report (default: every poll in the history).
    #[arg(long)]
    pub poll: Option<String>,
    /// Your own node: every block is compared with it and re-reduced, which proves
    /// that the provided history is complete. Without it the check is offline only.
    #[arg(long)]
    pub rpc: Option<String>,
}

/// Replay an evidence bundle (or dump) and recompute every result. Offline this checks
/// internal consistency (links, median-time clocks from the timestamps, results);
/// with `--rpc` it also proves that no protocol data was left out or altered.
pub async fn verify_evidence(a: EvidenceArgs) -> Result<()> {
    let v: Value = serde_json::from_slice(&std::fs::read(&a.input).with_context(|| format!("read {}", a.input.display()))?)?;
    let net = omavote_core::network::NetworkParams::from_json(&crate::util::from_serde(&v["network"])?).map_err(core_err)?;
    let mut ecfg = EngineConfig::new(net.clone());
    ecfg.initial_roles_hash = v["initial_roles_hash"].as_str().map(hash_arg).transpose()?;
    if let Some(d) = v["process_publication_delay_ms"].as_str() {
        ecfg.process_publication_delay_ms = d.parse().context("process_publication_delay_ms")?;
    }
    let mut cfg = SyncConfig::new(ecfg);
    if let Some(seed) = v.get("bootstrap").filter(|s| !s.is_null()) {
        cfg.bootstrap = Some(crate::bootstrap::Bootstrap::from_json(seed)?);
    }
    let blocks = v["blocks"].as_array().ok_or_else(|| anyhow!("no `blocks`: download the bundle with ?history=true"))?;
    let rpc = a.rpc.as_deref().map(Rpc::new);
    if let Some(rpc) = &rpc {
        let g = rpc.block_hash(0).await?.unwrap_or_default();
        if g != to_hex(&net.genesis_hash) {
            bail!("your node's genesis {g} is not the bundle's network");
        }
    }
    let mut st = crate::sync::ChainState::new(&cfg);
    let mut checked = 0u64;
    for chunk in blocks.chunks(200) {
        let raws = match &rpc {
            Some(rpc) => {
                let numbers: Vec<u64> =
                    chunk.iter().map(|b| b["number"].as_str().unwrap_or("x").parse::<u64>()).collect::<Result<_, _>>()?;
                futures::future::try_join_all(numbers.iter().map(|n| rpc.block_by_number(*n))).await?
            }
            None => Vec::new(),
        };
        for (i, b) in chunk.iter().enumerate() {
            let mut b = b.clone();
            let ts: Option<u64> =
                b.as_object_mut().and_then(|o| o.remove("timestamp_ms")).and_then(|t| t.as_str().and_then(|s| s.parse().ok()));
            let input = BlockInput::from_json(&crate::util::from_serde(&b)?).map_err(core_err)?;
            if let Some(ts) = ts {
                let expected = st.window.clock_for_next(ts);
                if expected != input.clock_ms {
                    bail!("block {}: clock {} differs from the median time {expected} of the timestamps", input.number, input.clock_ms);
                }
            }
            if let Some(raw) = raws.get(i) {
                let raw = RawBlock::from_rpc(raw.as_ref().ok_or_else(|| anyhow!("your node has no block {}", input.number))?)?;
                if raw.hash != input.hash || Some(raw.timestamp) != ts {
                    bail!("block {} differs from your node's canonical block", input.number);
                }
                let engine = &st.engine;
                let reduced = raw.reduce(input.clock_ms, &net, &|op: &omavote_core::molecule::OutPoint| engine.is_tracked(op));
                if omavote_core::json::to_jcs(&reduced.to_json()) != omavote_core::json::to_jcs(&input.to_json()) {
                    bail!("block {}: the bundle leaves out or alters protocol data", input.number);
                }
                checked += 1;
            }
            st.engine.process_block(&input).map_err(core_err).with_context(|| format!("block {}", input.number))?;
            if let Some(ts) = ts {
                st.window.push(ts);
            }
        }
    }
    let wanted: Option<Hash32> = a.poll.as_deref().map(hash_arg).transpose()?;
    let polls = poll_report(&st.engine, wanted);
    let claimed = v["result_hash"].as_str().map(str::to_string);
    let bundle_poll = v["poll"]["poll_id"].as_str().map(str::to_string);
    let matches_claim = match (&claimed, &bundle_poll) {
        (Some(c), Some(p)) => {
            polls.iter().find(|x| x["poll_id"].as_str() == Some(p.as_str())).map(|x| x["result_hash"].as_str() == Some(c.as_str()))
        }
        _ => None,
    };
    let first = blocks.first().and_then(|b| b["number"].as_str()).unwrap_or("?");
    let last = blocks.last().and_then(|b| b["number"].as_str()).unwrap_or("?");
    let report = json!({
        "verifier": {"name": "omavote verify-evidence", "version": env!("CARGO_PKG_VERSION")},
        "history": {"from_height": first, "to_height": last, "accelerated_start": cfg.bootstrap.is_some()},
        "completeness": match &a.rpc {
            Some(url) => json!(format!("checked: every block equals your node ({url}) and was re-reduced ({checked} blocks)")),
            None => json!("unproven: offline replay of the provided data only; add --rpc with your own node"),
        },
        "bundle_result_hash": claimed,
        "recomputed_matches_bundle": matches_claim,
        "polls": polls,
    });
    println!("{}", serde_json::to_string_pretty(&report)?);
    if matches_claim == Some(false) {
        bail!("the recomputed result_hash differs from the bundle's");
    }
    Ok(())
}
