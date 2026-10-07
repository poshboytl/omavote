//! TOML configuration for `serve` and `relay` (see deploy/omavote.example.toml).

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use omavote_core::json::parse;
use omavote_core::messages::ProcessRoles;
use omavote_core::types::MAX_PROCESS_PUBLICATION_DELAY_MS;
use omavote_core::util::Hash32;
use serde::Deserialize;

use crate::chain::NetworkOverrides;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub node: NodeConfig,
    #[serde(default)]
    pub network: NetworkOverrides,
    #[serde(default)]
    pub protocol: ProtocolConfig,
    #[serde(default)]
    pub server: ServerConfig,
    #[serde(default)]
    pub relay: RelayConfig,
    /// Directory the relative paths in this file are resolved against.
    #[serde(skip)]
    pub base: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NodeConfig {
    pub rpc: String,
    #[serde(default = "default_poll_ms")]
    pub poll_interval_ms: u64,
}

fn default_poll_ms() -> u64 {
    1000
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProtocolConfig {
    /// Initial process roles hash fixed by the switch proposal.
    pub initial_roles_hash: Option<String>,
    /// Alternatively a file with the roles object; its hash is used.
    pub initial_roles_file: Option<PathBuf>,
    #[serde(default = "default_process_delay")]
    pub process_publication_delay_ms: u64,
}

fn default_process_delay() -> u64 {
    MAX_PROCESS_PUBLICATION_DELAY_MS
}

impl Default for ProtocolConfig {
    fn default() -> Self {
        ProtocolConfig { initial_roles_hash: None, initial_roles_file: None, process_publication_delay_ms: default_process_delay() }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServerConfig {
    #[serde(default = "default_listen")]
    pub listen: String,
    #[serde(default = "default_db")]
    pub database: PathBuf,
    /// Built frontend (web/dist); omitted = API only.
    pub web_root: Option<PathBuf>,
    /// Key that signs relay receipts (service evidence; holds no funds).
    pub receipt_key_file: Option<PathBuf>,
    /// Blocks below the tip suggested as signing anchors.
    #[serde(default = "default_anchor_depth")]
    pub anchor_depth: u64,
    /// Allowed browser origins for the API (CORS); empty = same origin only.
    #[serde(default)]
    pub cors_origins: Vec<String>,
}

fn default_listen() -> String {
    "127.0.0.1:8080".into()
}
fn default_db() -> PathBuf {
    "omavote.sqlite".into()
}
fn default_anchor_depth() -> u64 {
    4
}

impl Default for ServerConfig {
    fn default() -> Self {
        ServerConfig {
            listen: default_listen(),
            database: default_db(),
            web_root: None,
            receipt_key_file: None,
            anchor_depth: default_anchor_depth(),
            cors_origins: Vec::new(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RelayConfig {
    /// Run the publisher inside `serve` (otherwise run `omavote relay` separately).
    #[serde(default)]
    pub embedded: bool,
    /// Hot wallet key (limited working capital only).
    pub key_file: Option<PathBuf>,
    /// Shannons per 1000 bytes.
    #[serde(default = "default_fee_rate")]
    pub fee_rate: u64,
    #[serde(default = "default_interval")]
    pub interval_ms: u64,
    #[serde(default = "default_confirmations")]
    pub confirmations: u64,
    #[serde(default = "default_max_carriers")]
    pub max_carriers_per_tx: usize,
}

fn default_fee_rate() -> u64 {
    1000
}
fn default_interval() -> u64 {
    3000
}
fn default_confirmations() -> u64 {
    24
}
fn default_max_carriers() -> usize {
    8
}

impl Default for RelayConfig {
    fn default() -> Self {
        RelayConfig {
            embedded: false,
            key_file: None,
            fee_rate: default_fee_rate(),
            interval_ms: default_interval(),
            confirmations: default_confirmations(),
            max_carriers_per_tx: default_max_carriers(),
        }
    }
}

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let text = std::fs::read_to_string(path).with_context(|| format!("read config {}", path.display()))?;
        let mut c: Config = toml::from_str(&text).with_context(|| format!("parse config {}", path.display()))?;
        c.base = path.parent().map(Path::to_path_buf).unwrap_or_default();
        Ok(c)
    }

    pub fn path(&self, p: &Path) -> PathBuf {
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            self.base.join(p)
        }
    }

    pub fn initial_roles_hash(&self) -> Result<Option<Hash32>> {
        if let Some(h) = &self.protocol.initial_roles_hash {
            return Ok(Some(crate::util::hash_arg(h)?));
        }
        if let Some(f) = &self.protocol.initial_roles_file {
            let bytes = std::fs::read(self.path(f))?;
            let roles = ProcessRoles::from_json(&parse(&bytes).map_err(|e| anyhow!("{e}"))?).map_err(|e| anyhow!("{e}"))?;
            return Ok(Some(roles.roles_hash()));
        }
        Ok(None)
    }
}

pub const EXAMPLE: &str = r#"# Omavote server configuration (all paths relative to this file).

[node]
# Your own CKB node with the Indexer RPC module enabled.
rpc = "http://127.0.0.1:8114"
poll_interval_ms = 1000

# Development chains only: declare Omnilock / PW Lock identities (mainnet and
# testnet use the fixed registry and refuse overrides).
# [network]
# omnilock = { code_hash = "0x...", hash_type = "type" }

[protocol]
# Fixed by the switch proposal. Either the hash or a file with the roles object.
# initial_roles_hash = "0x..."
# initial_roles_file = "roles.json"
process_publication_delay_ms = 259200000   # 72 hours (candidate value)

[server]
listen = "127.0.0.1:8080"
database = "omavote.sqlite"
web_root = "web/dist"
receipt_key_file = "receipt.key"   # omavote keygen receipt.key
anchor_depth = 4
cors_origins = []

[relay]
embedded = true          # false: run `omavote relay --config ...` as its own process
key_file = "relay.key"   # hot wallet: keep only limited working capital here
fee_rate = 1000          # shannons per 1000 bytes
interval_ms = 3000
confirmations = 24
max_carriers_per_tx = 8
"#;
