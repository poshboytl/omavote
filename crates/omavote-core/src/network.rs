//! Network registry: address prefix and well-known script identities per genesis hash.
//!
//! Mainnet and testnet values are fixed here; development chains supply their own
//! parameters (read from the operator's node) and the verifier records them in reports.

use crate::error::{Error, Result};
use crate::molecule::{HashType, Script};
use crate::util::{parse_hash, to_hex, Hash32};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ScriptId {
    pub code_hash: Hash32,
    pub hash_type: HashType,
}

impl ScriptId {
    pub fn matches(&self, s: &Script) -> bool {
        s.code_hash == self.code_hash && s.hash_type == self.hash_type
    }
    pub fn with_args(&self, args: Vec<u8>) -> Script {
        Script::new(self.code_hash, self.hash_type, args)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NetworkParams {
    pub name: String,
    pub genesis_hash: Hash32,
    pub hrp: String,
    /// Standard secp256k1_blake160_sighash_all lock.
    pub secp256k1: ScriptId,
    /// Nervos DAO type script (args must be empty).
    pub dao: ScriptId,
    /// Omnilock (plain Ethereum auth mode is accepted for EVM owners).
    pub omnilock: Option<ScriptId>,
    /// Historical PW Lock.
    pub pw_lock: Option<ScriptId>,
}

fn id(code_hash: &str) -> ScriptId {
    ScriptId { code_hash: parse_hash(code_hash, "registry").expect("static hash"), hash_type: HashType::Type }
}

const SECP256K1_TYPE_HASH: &str = "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8";
const DAO_TYPE_HASH: &str = "0x82d76d1b75fe2fd9a27dfbaa65a039221a380d76c926f378d3f81cf3e7e13f2e";

impl NetworkParams {
    pub fn mainnet() -> Self {
        NetworkParams {
            name: "mainnet".into(),
            genesis_hash: parse_hash("0x92b197aa1fba0f63633922c61c92375c9c074a93e85963554f5499fe1450d0e5", "g").unwrap(),
            hrp: "ckb".into(),
            secp256k1: id(SECP256K1_TYPE_HASH),
            dao: id(DAO_TYPE_HASH),
            omnilock: Some(id("0x9b819793a64463aed77c615d6cb226eea5487ccfc0783043a587254cda2b6f26")),
            pw_lock: Some(id("0xbf43c3602455798c1a61a596e0d95278864c552fafe231c063b3fabf97a8febc")),
        }
    }

    pub fn testnet() -> Self {
        NetworkParams {
            name: "testnet".into(),
            genesis_hash: parse_hash("0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606", "g").unwrap(),
            hrp: "ckt".into(),
            secp256k1: id(SECP256K1_TYPE_HASH),
            dao: id(DAO_TYPE_HASH),
            omnilock: Some(id("0xf329effd1c475a2978453c8600e1eaf0bc2087ee093c3ee64cc96ec6847752cb")),
            pw_lock: Some(id("0x58c5f491aba6d61678b7cf7edf4910b1f5e00ec0cde2f42e0abb4fd9aff25a63")),
        }
    }

    /// Development chain: identities come from the operator's own node.
    pub fn devnet(genesis_hash: Hash32, secp256k1: ScriptId, dao: ScriptId) -> Self {
        NetworkParams {
            name: "devnet".into(),
            genesis_hash,
            hrp: "ckt".into(),
            secp256k1,
            dao,
            omnilock: None,
            pw_lock: None,
        }
    }

    pub fn known(genesis_hash: &Hash32) -> Option<Self> {
        [Self::mainnet(), Self::testnet()].into_iter().find(|n| &n.genesis_hash == genesis_hash)
    }

    pub fn dao_script(&self) -> Script {
        self.dao.with_args(Vec::new())
    }

    pub fn is_dao_type(&self, s: &Script) -> bool {
        self.dao.matches(s) && s.args.is_empty()
    }

    pub fn address(&self, script: &Script) -> Result<String> {
        crate::address::full_address(&self.hrp, script)
    }

    pub fn describe(&self) -> String {
        format!(
            "{} genesis={} secp256k1={} dao={}",
            self.name,
            to_hex(&self.genesis_hash),
            to_hex(&self.secp256k1.code_hash),
            to_hex(&self.dao.code_hash)
        )
    }

    pub fn to_json(&self) -> crate::json::Value {
        use crate::json::{Object, Value};
        let id = |x: &Option<ScriptId>| match x {
            Some(i) => Value::Object(
                Object::new()
                    .with("code_hash", Value::str(to_hex(&i.code_hash)))
                    .with("hash_type", Value::str(i.hash_type.as_str())),
            ),
            None => Value::Null,
        };
        Value::Object(
            Object::new()
                .with("name", Value::str(self.name.clone()))
                .with("genesis_hash", Value::str(to_hex(&self.genesis_hash)))
                .with("hrp", Value::str(self.hrp.clone()))
                .with("secp256k1", id(&Some(self.secp256k1)))
                .with("dao", id(&Some(self.dao)))
                .with("omnilock", id(&self.omnilock))
                .with("pw_lock", id(&self.pw_lock)),
        )
    }

    pub fn from_json(v: &crate::json::Value) -> Result<Self> {
        use crate::json::{Fields, Value};
        let mut f = Fields::new(v, "network")?;
        let name = f.str("name")?.to_string();
        let genesis_hash = parse_hash(f.str("genesis_hash")?, "genesis_hash")?;
        let hrp = f.str("hrp")?.to_string();
        if hrp != "ckb" && hrp != "ckt" {
            return Err(Error::format("hrp must be ckb or ckt"));
        }
        let read = |v: &Value| -> Result<Option<ScriptId>> {
            if v.is_null() {
                return Ok(None);
            }
            let mut g = Fields::new(v, "script id")?;
            let code_hash = parse_hash(g.str("code_hash")?, "code_hash")?;
            let hash_type = HashType::parse(g.str("hash_type")?)?;
            g.finish()?;
            Ok(Some(ScriptId { code_hash, hash_type }))
        };
        let secp256k1 = read(f.value("secp256k1")?)?.ok_or_else(|| Error::format("secp256k1 is required"))?;
        let dao = read(f.value("dao")?)?.ok_or_else(|| Error::format("dao is required"))?;
        let omnilock = read(f.value("omnilock")?)?;
        let pw_lock = read(f.value("pw_lock")?)?;
        f.finish()?;
        let n = NetworkParams { name, genesis_hash, hrp, secp256k1, dao, omnilock, pw_lock };
        // Known networks must match the fixed registry exactly.
        if let Some(known) = NetworkParams::known(&n.genesis_hash) {
            if known != n {
                return Err(Error::rule("network parameters differ from the fixed registry for this genesis"));
            }
        }
        Ok(n)
    }

    pub fn require_genesis(&self, g: &Hash32) -> Result<()> {
        if &self.genesis_hash != g {
            return Err(Error::rule("network genesis hash does not match this verifier's network"));
        }
        Ok(())
    }
}
