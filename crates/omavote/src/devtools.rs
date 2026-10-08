//! Development-chain helpers for demos and end-to-end tests. Every command refuses
//! mainnet and testnet: test identities come from public labels and the faucet is the
//! dev chain's genesis key.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use omavote_core::adapter;
use omavote_core::address::parse_full_address;
use omavote_core::hash::blake160;
use omavote_core::molecule::{CellOutput, Script};
use omavote_core::network::NetworkParams;
use omavote_core::util::to_hex;
use serde_json::json;

use crate::chain::{discover_network, script_to_rpc, GenesisCells, RawBlock};
use crate::rpc::Rpc;
use crate::txbuilder::{self, LiveCell, TxPlan, Wallet, SHANNONS};

#[derive(clap::Subcommand, Debug)]
pub enum DevCmd {
    /// Print a test identity derived from a public label (never for real funds).
    Identity {
        #[arg(long)]
        label: String,
    },
    /// Send plain CKB from the faucet key to an address.
    Fund {
        #[arg(long, default_value = "http://127.0.0.1:18114")]
        rpc: String,
        #[arg(long)]
        faucet_key: PathBuf,
        #[arg(long)]
        to: String,
        #[arg(long)]
        ckb: u64,
    },
    /// Create a Nervos DAO deposit owned by an address, paid by the faucet key.
    Deposit {
        #[arg(long, default_value = "http://127.0.0.1:18114")]
        rpc: String,
        #[arg(long)]
        faucet_key: PathBuf,
        #[arg(long)]
        address: String,
        #[arg(long)]
        ckb: u64,
    },
    /// Ordinary capacity (cells without type and data) held by an address, in shannons.
    Balance {
        #[arg(long, default_value = "http://127.0.0.1:18114")]
        rpc: String,
        #[arg(long)]
        address: String,
    },
}

async fn dev_network(rpc: &Rpc) -> Result<(NetworkParams, GenesisCells)> {
    let g = RawBlock::from_rpc(&rpc.block_by_number(0).await?.ok_or_else(|| anyhow!("no genesis"))?)?;
    let (net, cells) = discover_network(&g, &Default::default())?;
    if NetworkParams::known(&net.genesis_hash).is_some() {
        bail!("development-chain helpers refuse mainnet and testnet");
    }
    Ok((net, cells))
}

fn address_lock(address: &str) -> Result<Script> {
    Ok(parse_full_address(address).map_err(|e| anyhow!("{e}"))?.1)
}

/// Build, sign and send a faucet-paid transaction; wait until committed and indexed.
async fn send(rpc: &Rpc, faucet: &Wallet, plan: TxPlan) -> Result<(String, u64)> {
    let cells: Vec<LiveCell> =
        txbuilder::live_cells(rpc, &faucet.lock).await?.into_iter().filter(|c| c.type_.is_none() && c.data.is_empty()).collect();
    let built = txbuilder::build(&plan, faucet, cells, &[], 1000)?;
    let hash = rpc.send_transaction(txbuilder::tx_to_rpc(&built.tx)).await?;
    let deadline = Instant::now() + Duration::from_secs(120);
    let number = loop {
        let (st, bh) = rpc.tx_status(&hash).await?;
        match (st.as_str(), bh) {
            ("committed", Some(bh)) => break crate::chain::hex_u64(&rpc.call("get_header", json!([bh])).await?["number"])?,
            ("rejected", _) => bail!("transaction {hash} rejected"),
            _ if Instant::now() > deadline => bail!("transaction {hash} not committed in time"),
            _ => tokio::time::sleep(Duration::from_millis(300)).await,
        }
    };
    while rpc.indexer_tip().await?.0 < number {
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    Ok((hash, number))
}

pub async fn run(cmd: DevCmd) -> Result<()> {
    match cmd {
        DevCmd::Identity { label } => {
            let secret = adapter::test_secret(&label);
            let pk = adapter::secp256k1_pubkey(&secret).map_err(|e| anyhow!("{e}"))?;
            let evm = adapter::evm_address(&secret).map_err(|e| anyhow!("{e}"))?;
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({
                    "label": label,
                    "secret": to_hex(&secret),
                    "public_key": to_hex(&pk),
                    "lock_args": to_hex(&blake160(&pk)),
                    "evm_address": to_hex(&evm),
                    "note": "development chains only: derived from a public label",
                }))?
            );
        }
        DevCmd::Fund { rpc, faucet_key, to, ckb } => {
            let rpc = Rpc::new(&rpc);
            let (net, cells) = dev_network(&rpc).await?;
            let faucet = Wallet::from_key_file(&faucet_key, &net)?;
            let lock = address_lock(&to)?;
            let plan = TxPlan {
                cell_deps: vec![cells.secp_dep_group.clone()],
                outputs: vec![(CellOutput { capacity: ckb * SHANNONS, lock, type_: None }, vec![])],
                ..Default::default()
            };
            let (hash, n) = send(&rpc, &faucet, plan).await.context("fund")?;
            println!("{}", json!({"tx_hash": hash, "block": n.to_string()}));
        }
        DevCmd::Deposit { rpc, faucet_key, address, ckb } => {
            let rpc = Rpc::new(&rpc);
            let (net, cells) = dev_network(&rpc).await?;
            let faucet = Wallet::from_key_file(&faucet_key, &net)?;
            let lock = address_lock(&address)?;
            let plan = TxPlan {
                cell_deps: vec![cells.secp_dep_group.clone(), cells.dao_code.clone()],
                outputs: vec![(CellOutput { capacity: ckb * SHANNONS, lock, type_: Some(net.dao_script()) }, vec![0u8; 8])],
                ..Default::default()
            };
            let (hash, n) = send(&rpc, &faucet, plan).await.context("deposit")?;
            println!("{}", json!({"tx_hash": hash, "index": "0", "block": n.to_string()}));
        }
        DevCmd::Balance { rpc, address } => {
            let rpc = Rpc::new(&rpc);
            dev_network(&rpc).await?;
            let lock = address_lock(&address)?;
            let key = json!({
                "script": script_to_rpc(&lock), "script_type": "lock", "script_search_mode": "exact",
                "filter": {"script_len_range": ["0x0", "0x1"], "output_data_len_range": ["0x0", "0x1"]}
            });
            let cap = rpc.call("get_cells_capacity", json!([key])).await?;
            let shannons = crate::chain::hex_u64(&cap["capacity"]).unwrap_or(0);
            println!("{}", json!({"address": address, "ordinary_capacity_shannon": shannons.to_string()}));
        }
    }
    Ok(())
}
