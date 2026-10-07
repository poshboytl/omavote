//! Omavote server binary: chain sync and replay, relay, public API, and the
//! independent `verify` command (docs/13).

mod chain;
mod rpc;
mod store;
mod sync;
mod util;
mod verify;
mod views;

use anyhow::{anyhow, Result};
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "omavote", version, about = "Omavote: signed DAO votes relayed on CKB, replayed from your own node")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Replay from your own node and print result_core / result_hash (and an evidence bundle).
    Verify(verify::VerifyArgs),
    /// Print the network parameters read from the node's genesis block.
    Network {
        #[arg(long, default_value = "http://127.0.0.1:8114")]
        rpc: String,
        #[arg(long)]
        network_overrides: Option<std::path::PathBuf>,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with_writer(std::io::stderr)
        .init();
    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Verify(args) => verify::run(args).await,
        Cmd::Network { rpc, network_overrides } => {
            let rpc = rpc::Rpc::new(&rpc);
            let g = chain::RawBlock::from_rpc(&rpc.block_by_number(0).await?.ok_or_else(|| anyhow!("no genesis"))?)?;
            let (net, cells) = chain::discover_network(&g, &verify::load_overrides(&network_overrides)?)?;
            let mut v = util::to_serde(&net.to_json());
            v["genesis_cells"] = serde_json::json!({
                "secp256k1_dep_group": chain::out_point_to_rpc(&cells.secp_dep_group.out_point),
                "dao_code": chain::out_point_to_rpc(&cells.dao_code.out_point),
            });
            println!("{}", serde_json::to_string_pretty(&v)?);
            Ok(())
        }
    }
}
