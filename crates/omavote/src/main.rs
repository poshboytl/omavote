//! Omavote server binary: chain sync and replay, relay, public API, and the
//! independent `verify` command (docs/13).

mod api;
mod bootstrap;
mod chain;
mod config;
mod demo;
mod relay;
mod rpc;
mod store;
mod sync;
mod txbuilder;
mod util;
mod verify;
mod views;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use clap::{Parser, Subcommand};
use omavote_core::engine::EngineConfig;

#[derive(Parser)]
#[command(name = "omavote", version, about = "Omavote: signed DAO votes relayed on CKB, replayed from your own node")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Sync from the node, serve the API and frontend, accept envelopes (and relay them if embedded).
    Serve {
        #[arg(long, default_value = "omavote.toml")]
        config: PathBuf,
    },
    /// Run only the relay publisher (separate process holding the hot wallet key).
    Relay {
        #[arg(long, default_value = "omavote.toml")]
        config: PathBuf,
    },
    /// Replay from your own node and print result_core / result_hash (and an evidence bundle).
    Verify(verify::VerifyArgs),
    /// Print the network parameters read from the node's genesis block.
    Network {
        #[arg(long, default_value = "http://127.0.0.1:8114")]
        rpc: String,
        #[arg(long)]
        network_overrides: Option<PathBuf>,
    },
    /// Generate a secp256k1 key file (mode 0600) and print its lock address for the node's network.
    Keygen {
        path: PathBuf,
        #[arg(long)]
        rpc: Option<String>,
    },
    /// Print an example configuration file.
    ExampleConfig,
    /// Development chains: end-to-end run with real deposits, relay, votes and replay.
    Demo(demo::DemoArgs),
    /// Sign a text with a key file, as Neuron (`ckb`) or MetaMask personal_sign (`evm`) would.
    /// For operators who keep a role key in a file; wallets remain the normal path.
    Sign {
        #[arg(long)]
        key: PathBuf,
        #[arg(long, value_parser = ["ckb", "evm"])]
        format: String,
        /// File with the exact text (UTF-8); `-` reads stdin.
        #[arg(long)]
        text_file: PathBuf,
    },
    /// Development chains: print the deterministic demo process roles (initial_roles_file).
    DemoRoles {
        #[arg(long, default_value = "http://127.0.0.1:18114")]
        rpc: String,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with_writer(std::io::stderr)
        .init();
    match Cli::parse().cmd {
        Cmd::Serve { config } => serve(config::Config::load(&config)?).await,
        Cmd::Relay { config } => relay_only(config::Config::load(&config)?).await,
        Cmd::Verify(args) => verify::run(args).await,
        Cmd::Network { rpc, network_overrides } => {
            let rpc = rpc::Rpc::new(&rpc);
            let (net, cells) = discover(&rpc, &verify::load_overrides(&network_overrides)?).await?;
            let mut v = util::to_serde(&net.to_json());
            v["genesis_cells"] = serde_json::json!({
                "secp256k1_dep_group": chain::out_point_to_rpc(&cells.secp_dep_group.out_point),
                "dao_code": chain::out_point_to_rpc(&cells.dao_code.out_point),
            });
            println!("{}", serde_json::to_string_pretty(&v)?);
            Ok(())
        }
        Cmd::Keygen { path, rpc } => {
            txbuilder::generate_key_file(&path)?;
            eprintln!("wrote {}", path.display());
            if let Some(rpc) = rpc {
                let (net, _) = discover(&rpc::Rpc::new(&rpc), &Default::default()).await?;
                let w = txbuilder::Wallet::from_key_file(&path, &net)?;
                println!("{}", w.address(&net));
            }
            Ok(())
        }
        Cmd::ExampleConfig => {
            print!("{}", config::EXAMPLE);
            Ok(())
        }
        Cmd::Demo(args) => demo::run(args).await,
        Cmd::Sign { key, format, text_file } => {
            let text = if text_file.as_os_str() == "-" {
                let mut t = String::new();
                std::io::Read::read_to_string(&mut std::io::stdin(), &mut t)?;
                t
            } else {
                std::fs::read_to_string(&text_file)?
            };
            let secret_text = std::fs::read_to_string(&key)?;
            let secret = omavote_core::util::parse_hex_fixed::<32>(secret_text.trim(), "secret key").map_err(|e| anyhow!("{e}"))?;
            let sig = match format.as_str() {
                "ckb" => omavote_core::adapter::ckb_sign_message(&secret, &text),
                _ => omavote_core::adapter::evm_sign_message(&secret, &text),
            }
            .map_err(|e| anyhow!("{e}"))?;
            println!("{}", omavote_core::util::to_hex(&sig));
            Ok(())
        }
        Cmd::DemoRoles { rpc } => {
            let (net, _) = discover(&rpc::Rpc::new(&rpc), &Default::default()).await?;
            if omavote_core::network::NetworkParams::known(&net.genesis_hash).is_some() {
                bail!("demo roles are for development chains only");
            }
            let (roles, _, _) = demo::demo_roles(net.genesis_hash);
            println!("{}", omavote_core::json::to_jcs(roles.to_json()));
            Ok(())
        }
    }
}

async fn discover(rpc: &rpc::Rpc, overrides: &chain::NetworkOverrides) -> Result<(omavote_core::network::NetworkParams, chain::GenesisCells)> {
    let g = rpc.block_by_number(0).await.context("connect to the node")?.ok_or_else(|| anyhow!("node has no genesis block"))?;
    chain::discover_network(&chain::RawBlock::from_rpc(&g)?, overrides)
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutting down");
}

fn publisher(cfg: &config::Config, rpc: &rpc::Rpc, store: Arc<store::Store>, net: &omavote_core::network::NetworkParams, cells: &chain::GenesisCells) -> Result<relay::Publisher> {
    let key = cfg.relay.key_file.as_ref().ok_or_else(|| anyhow!("[relay] key_file is required"))?;
    let wallet = txbuilder::Wallet::from_key_file(&cfg.path(key), net)?;
    Ok(relay::Publisher {
        rpc: rpc.clone(),
        store,
        wallet,
        net: net.clone(),
        genesis: cells.clone(),
        cfg: config::RelayConfig {
            embedded: cfg.relay.embedded,
            key_file: cfg.relay.key_file.clone(),
            fee_rate: cfg.relay.fee_rate,
            interval_ms: cfg.relay.interval_ms,
            confirmations: cfg.relay.confirmations,
            max_carriers_per_tx: cfg.relay.max_carriers_per_tx,
        },
    })
}

async fn serve(cfg: config::Config) -> Result<()> {
    let rpc = rpc::Rpc::new(&cfg.node.rpc);
    let (net, cells) = discover(&rpc, &cfg.network).await?;
    let store = Arc::new(store::Store::open(&cfg.path(&cfg.server.database))?);
    let mut ecfg = EngineConfig::new(net.clone());
    ecfg.initial_roles_hash = cfg.initial_roles_hash()?;
    ecfg.process_publication_delay_ms = cfg.protocol.process_publication_delay_ms;
    // Chain-derived tables are rebuilt whenever the replay settings change.
    let fingerprint = format!(
        "{}|{:?}|{}|{}",
        omavote_core::json::to_jcs(&net.to_json()),
        ecfg.initial_roles_hash.map(|h| omavote_core::util::to_hex(&h)),
        ecfg.process_publication_delay_ms,
        cfg.sync.start_height
    );
    if store.meta_get("replay_settings")?.as_deref() != Some(fingerprint.as_str()) {
        tracing::info!("replay settings changed or new database: rebuilding the chain cache");
        store.reset_chain()?;
        store.meta_set("bootstrap", "")?;
        store.meta_set("replay_settings", &fingerprint)?;
    }
    let mut scfg = sync::SyncConfig::new(ecfg);
    scfg.poll_interval = Duration::from_millis(cfg.node.poll_interval_ms);
    if cfg.sync.start_height > 0 {
        // The bootstrap state is derived once and kept, so restarts replay the same start.
        let saved = store.meta_get("bootstrap")?.filter(|s| !s.is_empty());
        let b = match saved {
            Some(text) => bootstrap::Bootstrap::from_json(&serde_json::from_str(&text)?)?,
            None => {
                tracing::info!(height = cfg.sync.start_height, "deriving the Nervos DAO deposit set from the node's indexer");
                let b = bootstrap::build(&rpc, &net, cfg.sync.start_height, cfg.sync.anchor_blocks).await?;
                store.meta_set("bootstrap", &b.to_json().to_string())?;
                b
            }
        };
        tracing::info!(height = b.height, deposits = b.cells.len(), "accelerated start");
        scfg.bootstrap = Some(b);
    }
    let syncer = Arc::new(sync::Syncer::new(rpc.clone(), Some(store.clone()), scfg));
    let loaded = syncer.load_from_store()?;
    tracing::info!(network = %net.name, blocks = loaded, "chain cache loaded");
    tokio::spawn(syncer.clone().run());

    let intake = match &cfg.server.receipt_key_file {
        Some(p) => Some(Arc::new(relay::Intake {
            store: store.clone(),
            state: syncer.state.clone(),
            receipt_key: txbuilder::Wallet::from_key_file(&cfg.path(p), &net)?,
        })),
        None => {
            tracing::warn!("no receipt_key_file: POST /api/envelopes is disabled");
            None
        }
    };
    let mut relay_lock = None;
    if cfg.relay.embedded {
        let p = publisher(&cfg, &rpc, store.clone(), &net, &cells)?;
        relay_lock = Some(p.wallet.lock.clone());
        tokio::spawn(p.run());
    } else if let Some(k) = &cfg.relay.key_file {
        if let Ok(w) = txbuilder::Wallet::from_key_file(&cfg.path(k), &net) {
            relay_lock = Some(w.lock.clone());
        }
    }
    let state = api::AppState {
        chain: syncer.state.clone(),
        store,
        intake,
        info: Arc::new(api::ServerInfo { rpc, network: net, genesis: cells, relay_lock }),
    };
    let web_root = cfg.server.web_root.as_ref().map(|p| cfg.path(p)).filter(|p| p.join("index.html").exists());
    if cfg.server.web_root.is_some() && web_root.is_none() {
        tracing::warn!("web_root has no index.html; serving the API only");
    }
    let app = api::router(state, web_root, &cfg.server.cors_origins);
    let listener = tokio::net::TcpListener::bind(&cfg.server.listen).await.with_context(|| format!("bind {}", cfg.server.listen))?;
    tracing::info!(listen = %cfg.server.listen, "serving");
    axum::serve(listener, app).with_graceful_shutdown(shutdown_signal()).await?;
    Ok(())
}

async fn relay_only(cfg: config::Config) -> Result<()> {
    if cfg.relay.embedded {
        bail!("[relay] embedded = true: the publisher already runs inside `omavote serve`");
    }
    let rpc = rpc::Rpc::new(&cfg.node.rpc);
    let (net, cells) = discover(&rpc, &cfg.network).await?;
    let store = Arc::new(store::Store::open(&cfg.path(&cfg.server.database))?);
    let p = publisher(&cfg, &rpc, store, &net, &cells)?;
    tokio::select! {
        _ = p.run() => {}
        _ = shutdown_signal() => {}
    }
    Ok(())
}
