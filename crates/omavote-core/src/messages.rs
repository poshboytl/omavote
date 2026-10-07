//! Signed protocol messages: key descriptors, ballots, authorization controls,
//! process roles and process records, plus their envelopes.

use crate::adapter;
use crate::error::{Error, Result};
use crate::hash::{blake160, domain, domain_hash};
use crate::json::{jcs_bytes, Fields, Object, Value};
use crate::molecule::Script;
use crate::network::NetworkParams;
use crate::types::{DAO_NAMESPACE, PROTOCOL_VERSION, SIG_FORMAT_AUTHORIZATION, SIG_FORMAT_READABLE};
use crate::util::{dec, parse_dec_u64, parse_hash, parse_hex, parse_hex_fixed, to_hex, to_hex_bare, Hash32};

fn hash_field(f: &mut Fields, key: &str) -> Result<Hash32> {
    let s = f.str(key)?;
    parse_hash(s, key)
}

fn opt_hash_field(f: &mut Fields, key: &str) -> Result<Option<Hash32>> {
    match f.opt_str(key)? {
        Some(s) => Ok(Some(parse_hash(s, key)?)),
        None => Ok(None),
    }
}

fn opt_hash_value(h: &Option<Hash32>) -> Value {
    Value::opt_str(h.map(|x| to_hex(&x)))
}

// ---------------------------------------------------------------------------
// Signatures

/// `{"signature": "0x<65 bytes>"}` for both message adapters.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Proof {
    pub signature: [u8; 65],
}

impl Proof {
    pub fn to_json(&self) -> Value {
        Value::Object(Object::new().with("signature", Value::str(to_hex(&self.signature))))
    }
    pub fn from_json(v: &Value) -> Result<Self> {
        let mut f = Fields::new(v, "proof")?;
        let signature = parse_hex_fixed::<65>(f.str("signature")?, "proof.signature")?;
        f.finish()?;
        Ok(Proof { signature })
    }
}

// ---------------------------------------------------------------------------
// Key descriptors (docs/11 §4.1)

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KeyDescriptor {
    Secp256k1 { public_key: [u8; 33] },
    EvmEoa { address: [u8; 20] },
}

impl KeyDescriptor {
    pub fn adapter_id(&self) -> &'static str {
        match self {
            KeyDescriptor::Secp256k1 { .. } => adapter::CKB_SECP256K1_MESSAGE_V1,
            KeyDescriptor::EvmEoa { .. } => adapter::EVM_PERSONAL_MESSAGE_V1,
        }
    }

    pub fn to_json(&self) -> Value {
        match self {
            KeyDescriptor::Secp256k1 { public_key } => Value::Object(
                Object::new()
                    .with("kind", Value::str("secp256k1"))
                    .with("public_key", Value::str(to_hex(public_key)))
                    .with("adapter", Value::str(self.adapter_id())),
            ),
            KeyDescriptor::EvmEoa { address } => Value::Object(
                Object::new()
                    .with("kind", Value::str("evm_eoa"))
                    .with("address", Value::str(to_hex(address)))
                    .with("adapter", Value::str(self.adapter_id())),
            ),
        }
    }

    pub fn from_json(v: &Value) -> Result<Self> {
        let mut f = Fields::new(v, "key_descriptor")?;
        let kind = f.str("kind")?;
        let d = match kind {
            "secp256k1" => {
                let public_key = parse_hex_fixed::<33>(f.str("public_key")?, "public_key")?;
                adapter::validate_compressed_pubkey(&public_key)?;
                KeyDescriptor::Secp256k1 { public_key }
            }
            "evm_eoa" => KeyDescriptor::EvmEoa { address: parse_hex_fixed::<20>(f.str("address")?, "address")? },
            "webauthn_es256" => return Err(Error::unsupported("webauthn_es256 key descriptors (independent PoC)")),
            other => return Err(Error::format(format!("unknown key kind {other}"))),
        };
        let adapter_id = f.str("adapter")?;
        if adapter_id != d.adapter_id() {
            return Err(Error::format("key descriptor adapter does not match its kind"));
        }
        f.finish()?;
        Ok(d)
    }

    pub fn key_id(&self) -> Hash32 {
        domain_hash(domain::KEY, &jcs_bytes(&self.to_json()))
    }

    /// Wallet-visible address used in the GRANT text (docs/11 §4.1).
    pub fn key_display(&self, network: &NetworkParams) -> Result<String> {
        match self {
            KeyDescriptor::Secp256k1 { public_key } => {
                network.address(&network.secp256k1.with_args(blake160(public_key).to_vec()))
            }
            KeyDescriptor::EvmEoa { address } => Ok(crate::address::eip55(address)),
        }
    }

    /// Abbreviation for the Ledger summary line.
    pub fn key_short(&self, network: &NetworkParams) -> Result<String> {
        let full = self.key_display(network)?;
        Ok(match self {
            KeyDescriptor::Secp256k1 { .. } => format!("{}..{}", &full[..4], &full[full.len() - 16..]),
            KeyDescriptor::EvmEoa { .. } => format!("{}..{}", &full[..10], &full[full.len() - 8..]),
        })
    }
}

// ---------------------------------------------------------------------------
// Ballots (docs/03 §5)

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Action {
    Yes,
    No,
    Cancel,
}

impl Action {
    pub fn as_str(self) -> &'static str {
        match self {
            Action::Yes => "YES",
            Action::No => "NO",
            Action::Cancel => "CANCEL",
        }
    }
    pub fn parse(s: &str) -> Result<Self> {
        Ok(match s {
            "YES" => Action::Yes,
            "NO" => Action::No,
            "CANCEL" => Action::Cancel,
            _ => return Err(Error::format(format!("unknown action {s}"))),
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Authority {
    Owner,
    Delegate,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BallotBody {
    pub action: Action,
    pub authority: Authority,
    pub authorization_id: Option<Hash32>,
    pub signer_key_id: Option<Hash32>,
    pub nonce: Hash32,
    pub anchor_block_hash: Hash32,
    pub auth_adapter: String,
    pub genesis: Hash32,
    pub owner_lock: Script,
    pub poll_id: Hash32,
    pub rules_hash: Hash32,
    raw: Value,
}

#[derive(Clone, Debug)]
pub struct BallotDraft {
    pub action: Action,
    pub authority: Authority,
    pub authorization_id: Option<Hash32>,
    pub signer_key_id: Option<Hash32>,
    pub nonce: Hash32,
    pub anchor_block_hash: Hash32,
    pub auth_adapter: String,
    pub genesis: Hash32,
    pub owner_lock: Script,
    pub poll_id: Hash32,
    pub rules_hash: Hash32,
}

impl BallotDraft {
    pub fn build(&self) -> Result<BallotBody> {
        let o = Object::new()
            .with("message_kind", Value::str("ballot"))
            .with("protocol_version", Value::str(PROTOCOL_VERSION))
            .with("action", Value::str(self.action.as_str()))
            .with(
                "authority",
                Value::str(match self.authority {
                    Authority::Owner => "owner",
                    Authority::Delegate => "delegate",
                }),
            )
            .with("authorization_id", opt_hash_value(&self.authorization_id))
            .with("signer_key_id", opt_hash_value(&self.signer_key_id))
            .with("nonce", Value::str(to_hex(&self.nonce)))
            .with("anchor_block_hash", Value::str(to_hex(&self.anchor_block_hash)))
            .with("auth_adapter", Value::str(self.auth_adapter.clone()))
            .with("dao_namespace", Value::str(DAO_NAMESPACE))
            .with("network_genesis_hash", Value::str(to_hex(&self.genesis)))
            .with("owner_lock", self.owner_lock.to_json())
            .with("poll_id", Value::str(to_hex(&self.poll_id)))
            .with("rules_hash", Value::str(to_hex(&self.rules_hash)))
            .with("signature_format", Value::str(SIG_FORMAT_READABLE));
        BallotBody::from_json(&Value::Object(o))
    }
}

impl BallotBody {
    pub fn from_json(v: &Value) -> Result<Self> {
        let mut f = Fields::new(v, "ballot")?;
        f.literal("message_kind", "ballot")?;
        f.literal("protocol_version", PROTOCOL_VERSION)?;
        let action = Action::parse(f.str("action")?)?;
        let authority = match f.str("authority")? {
            "owner" => Authority::Owner,
            "delegate" => Authority::Delegate,
            other => return Err(Error::format(format!("unknown authority {other}"))),
        };
        let authorization_id = opt_hash_field(&mut f, "authorization_id")?;
        let signer_key_id = opt_hash_field(&mut f, "signer_key_id")?;
        let nonce = hash_field(&mut f, "nonce")?;
        let anchor_block_hash = hash_field(&mut f, "anchor_block_hash")?;
        let auth_adapter = f.str("auth_adapter")?.to_string();
        f.literal("dao_namespace", DAO_NAMESPACE)?;
        let genesis = hash_field(&mut f, "network_genesis_hash")?;
        let owner_lock = Script::from_json(f.value("owner_lock")?)?;
        let poll_id = hash_field(&mut f, "poll_id")?;
        let rules_hash = hash_field(&mut f, "rules_hash")?;
        f.literal("signature_format", SIG_FORMAT_READABLE)?;
        f.finish()?;
        match authority {
            Authority::Owner if authorization_id.is_some() || signer_key_id.is_some() => {
                return Err(Error::format("direct ballots must have null authorization_id and signer_key_id"))
            }
            Authority::Delegate if authorization_id.is_none() || signer_key_id.is_none() => {
                return Err(Error::format("delegate ballots need authorization_id and signer_key_id"))
            }
            _ => {}
        }
        if !adapter::is_defined_adapter(&auth_adapter) {
            return Err(Error::format(format!("undefined auth_adapter {auth_adapter}")));
        }
        Ok(BallotBody {
            action,
            authority,
            authorization_id,
            signer_key_id,
            nonce,
            anchor_block_hash,
            auth_adapter,
            genesis,
            owner_lock,
            poll_id,
            rules_hash,
            raw: v.clone(),
        })
    }

    pub fn to_json(&self) -> &Value {
        &self.raw
    }

    pub fn ballot_id(&self) -> Hash32 {
        domain_hash(domain::BALLOT, &jcs_bytes(&self.raw))
    }

    pub fn owner_id(&self) -> Hash32 {
        self.owner_lock.hash()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BallotEnvelope {
    pub body: BallotBody,
    pub proof: Proof,
}

impl BallotEnvelope {
    pub fn to_json(&self) -> Value {
        Value::Object(Object::new().with("body", self.body.to_json().clone()).with("proof", self.proof.to_json()))
    }
    pub fn from_json(v: &Value) -> Result<Self> {
        let mut f = Fields::new(v, "ballot envelope")?;
        let body = BallotBody::from_json(f.value("body")?)?;
        let proof = Proof::from_json(f.value("proof")?)?;
        f.finish()?;
        Ok(BallotEnvelope { body, proof })
    }
}

// ---------------------------------------------------------------------------
// Authorization controls (docs/11 §3)

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ControlAction {
    Grant,
    Revoke,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RevokeMode {
    StopOnly,
    StopAndCancelOpen,
}

impl RevokeMode {
    pub fn as_str(self) -> &'static str {
        match self {
            RevokeMode::StopOnly => "STOP_ONLY",
            RevokeMode::StopAndCancelOpen => "STOP_AND_CANCEL_OPEN",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ControlBody {
    pub genesis: Hash32,
    pub auth_policy_hash: Hash32,
    pub owner_lock: Script,
    pub owner_auth_adapter: String,
    pub action: ControlAction,
    pub key_descriptor: Option<KeyDescriptor>,
    pub expires_at_ms: Option<u64>,
    pub revoke_mode: Option<RevokeMode>,
    pub anchor_block_hash: Hash32,
    pub publication_deadline_ms: u64,
    pub nonce: Hash32,
    raw: Value,
}

#[derive(Clone, Debug)]
pub struct ControlDraft {
    pub genesis: Hash32,
    pub auth_policy_hash: Hash32,
    pub owner_lock: Script,
    pub owner_auth_adapter: String,
    pub action: ControlAction,
    pub key_descriptor: Option<KeyDescriptor>,
    pub expires_at_ms: Option<u64>,
    pub revoke_mode: Option<RevokeMode>,
    pub anchor_block_hash: Hash32,
    pub publication_deadline_ms: u64,
    pub nonce: Hash32,
}

impl ControlDraft {
    pub fn build(&self) -> Result<ControlBody> {
        let o = Object::new()
            .with("protocol_version", Value::str(PROTOCOL_VERSION))
            .with("message_kind", Value::str("authorization_control"))
            .with("network_genesis_hash", Value::str(to_hex(&self.genesis)))
            .with("dao_namespace", Value::str(DAO_NAMESPACE))
            .with("auth_policy_hash", Value::str(to_hex(&self.auth_policy_hash)))
            .with("owner_lock", self.owner_lock.to_json())
            .with("owner_auth_adapter", Value::str(self.owner_auth_adapter.clone()))
            .with(
                "action",
                Value::str(match self.action {
                    ControlAction::Grant => "GRANT",
                    ControlAction::Revoke => "REVOKE",
                }),
            )
            .with("key_descriptor", self.key_descriptor.as_ref().map(|k| k.to_json()).unwrap_or(Value::Null))
            .with("expires_at_ms", Value::opt_str(self.expires_at_ms.map(dec)))
            .with("revoke_mode", Value::opt_str(self.revoke_mode.map(|m| m.as_str())))
            .with("anchor_block_hash", Value::str(to_hex(&self.anchor_block_hash)))
            .with("publication_deadline_ms", Value::str(dec(self.publication_deadline_ms)))
            .with("nonce", Value::str(to_hex(&self.nonce)))
            .with("signature_format", Value::str(SIG_FORMAT_AUTHORIZATION));
        ControlBody::from_json(&Value::Object(o))
    }
}

impl ControlBody {
    pub fn from_json(v: &Value) -> Result<Self> {
        let mut f = Fields::new(v, "authorization_control")?;
        f.literal("protocol_version", PROTOCOL_VERSION)?;
        f.literal("message_kind", "authorization_control")?;
        let genesis = hash_field(&mut f, "network_genesis_hash")?;
        f.literal("dao_namespace", DAO_NAMESPACE)?;
        let auth_policy_hash = hash_field(&mut f, "auth_policy_hash")?;
        let owner_lock = Script::from_json(f.value("owner_lock")?)?;
        let owner_auth_adapter = f.str("owner_auth_adapter")?.to_string();
        let action = match f.str("action")? {
            "GRANT" => ControlAction::Grant,
            "REVOKE" => ControlAction::Revoke,
            other => return Err(Error::format(format!("unknown control action {other}"))),
        };
        let key_descriptor = match f.value("key_descriptor")? {
            Value::Null => None,
            other => Some(KeyDescriptor::from_json(other)?),
        };
        let expires_at_ms = match f.opt_str("expires_at_ms")? {
            Some(s) => Some(parse_dec_u64(s, "expires_at_ms")?),
            None => None,
        };
        let revoke_mode = match f.opt_str("revoke_mode")? {
            None => None,
            Some("STOP_ONLY") => Some(RevokeMode::StopOnly),
            Some("STOP_AND_CANCEL_OPEN") => Some(RevokeMode::StopAndCancelOpen),
            Some(other) => return Err(Error::format(format!("unknown revoke_mode {other}"))),
        };
        let anchor_block_hash = hash_field(&mut f, "anchor_block_hash")?;
        let publication_deadline_ms = parse_dec_u64(f.str("publication_deadline_ms")?, "publication_deadline_ms")?;
        let nonce = hash_field(&mut f, "nonce")?;
        f.literal("signature_format", SIG_FORMAT_AUTHORIZATION)?;
        f.finish()?;
        match action {
            ControlAction::Grant => {
                if key_descriptor.is_none() || expires_at_ms.is_none() {
                    return Err(Error::format("GRANT needs key_descriptor and expires_at_ms"));
                }
                if revoke_mode == Some(RevokeMode::StopOnly) {
                    return Err(Error::format("GRANT revoke_mode may only be null or STOP_AND_CANCEL_OPEN"));
                }
            }
            ControlAction::Revoke => {
                if key_descriptor.is_some() || expires_at_ms.is_some() || revoke_mode.is_none() {
                    return Err(Error::format("REVOKE needs revoke_mode and null key/expiry"));
                }
            }
        }
        Ok(ControlBody {
            genesis,
            auth_policy_hash,
            owner_lock,
            owner_auth_adapter,
            action,
            key_descriptor,
            expires_at_ms,
            revoke_mode,
            anchor_block_hash,
            publication_deadline_ms,
            nonce,
            raw: v.clone(),
        })
    }

    pub fn to_json(&self) -> &Value {
        &self.raw
    }

    pub fn authorization_id(&self) -> Hash32 {
        domain_hash(domain::AUTHORIZATION, &jcs_bytes(&self.raw))
    }

    pub fn owner_id(&self) -> Hash32 {
        self.owner_lock.hash()
    }

    /// True when this control establishes the safe revocation barrier.
    pub fn cancels_open(&self) -> bool {
        self.revoke_mode == Some(RevokeMode::StopAndCancelOpen)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ControlEnvelope {
    pub body: ControlBody,
    pub proof: Proof,
}

impl ControlEnvelope {
    pub fn to_json(&self) -> Value {
        Value::Object(Object::new().with("body", self.body.to_json().clone()).with("proof", self.proof.to_json()))
    }
    pub fn from_json(v: &Value) -> Result<Self> {
        let mut f = Fields::new(v, "control envelope")?;
        let body = ControlBody::from_json(f.value("body")?)?;
        let proof = Proof::from_json(f.value("proof")?)?;
        f.finish()?;
        Ok(ControlEnvelope { body, proof })
    }
}

// ---------------------------------------------------------------------------
// Process roles and records (docs/03 §3.1)

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Role {
    Committee,
    Coordinator,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Committee => "committee",
            Role::Coordinator => "coordinator",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoleMembers {
    pub threshold: u64,
    pub members: Vec<KeyDescriptor>,
}

impl RoleMembers {
    fn to_json(&self) -> Value {
        Value::Object(
            Object::new()
                .with("threshold", Value::str(dec(self.threshold)))
                .with("members", Value::Array(self.members.iter().map(|m| m.to_json()).collect())),
        )
    }
    fn from_json(v: &Value) -> Result<Self> {
        let mut f = Fields::new(v, "role")?;
        let threshold = parse_dec_u64(f.str("threshold")?, "threshold")?;
        let members = f.array("members")?.iter().map(KeyDescriptor::from_json).collect::<Result<Vec<_>>>()?;
        f.finish()?;
        let ids: Vec<Hash32> = members.iter().map(|m| m.key_id()).collect();
        if ids.windows(2).any(|w| w[0] >= w[1]) {
            return Err(Error::format("role members must be sorted by key_id and unique"));
        }
        if threshold == 0 || threshold as usize > members.len() {
            return Err(Error::format("role threshold must be between 1 and the member count"));
        }
        Ok(RoleMembers { threshold, members })
    }
    pub fn member(&self, key_id: &Hash32) -> Option<&KeyDescriptor> {
        self.members.iter().find(|m| &m.key_id() == key_id)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessRoles {
    pub genesis: Hash32,
    pub previous_roles_hash: Option<Hash32>,
    pub committee: RoleMembers,
    pub coordinator: RoleMembers,
    pub nonce: Hash32,
    raw: Value,
}

impl ProcessRoles {
    pub fn build(
        genesis: Hash32,
        previous_roles_hash: Option<Hash32>,
        committee: (u64, Vec<KeyDescriptor>),
        coordinator: (u64, Vec<KeyDescriptor>),
        nonce: Hash32,
    ) -> Result<Self> {
        let sort = |mut v: Vec<KeyDescriptor>| {
            v.sort_by_key(|k| k.key_id());
            v.dedup();
            v
        };
        let roles = Object::new()
            .with("committee", RoleMembers { threshold: committee.0, members: sort(committee.1) }.to_json())
            .with("coordinator", RoleMembers { threshold: coordinator.0, members: sort(coordinator.1) }.to_json());
        let o = Object::new()
            .with("message_kind", Value::str("process_roles"))
            .with("protocol_version", Value::str(PROTOCOL_VERSION))
            .with("network_genesis_hash", Value::str(to_hex(&genesis)))
            .with("dao_namespace", Value::str(DAO_NAMESPACE))
            .with("previous_roles_hash", opt_hash_value(&previous_roles_hash))
            .with("roles", Value::Object(roles))
            .with("nonce", Value::str(to_hex(&nonce)));
        Self::from_json(&Value::Object(o))
    }

    pub fn from_json(v: &Value) -> Result<Self> {
        let mut f = Fields::new(v, "process_roles")?;
        f.literal("message_kind", "process_roles")?;
        f.literal("protocol_version", PROTOCOL_VERSION)?;
        let genesis = hash_field(&mut f, "network_genesis_hash")?;
        f.literal("dao_namespace", DAO_NAMESPACE)?;
        let previous_roles_hash = opt_hash_field(&mut f, "previous_roles_hash")?;
        let (committee, coordinator) = {
            let mut r = Fields::new(f.value("roles")?, "roles")?;
            let committee = RoleMembers::from_json(r.value("committee")?)?;
            let coordinator = RoleMembers::from_json(r.value("coordinator")?)?;
            r.finish()?;
            (committee, coordinator)
        };
        let nonce = hash_field(&mut f, "nonce")?;
        f.finish()?;
        Ok(ProcessRoles { genesis, previous_roles_hash, committee, coordinator, nonce, raw: v.clone() })
    }

    pub fn to_json(&self) -> &Value {
        &self.raw
    }

    pub fn roles_hash(&self) -> Hash32 {
        domain_hash(domain::ROLES, &jcs_bytes(&self.raw))
    }

    pub fn members(&self, role: Role) -> &RoleMembers {
        match role {
            Role::Committee => &self.committee,
            Role::Coordinator => &self.coordinator,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum RecordType {
    Admission,
    Notice,
    GovernanceStatus,
    ResultAttestation,
    Execution,
    RolesUpdate,
}

impl RecordType {
    pub fn as_str(self) -> &'static str {
        match self {
            RecordType::Admission => "ADMISSION",
            RecordType::Notice => "NOTICE",
            RecordType::GovernanceStatus => "GOVERNANCE_STATUS",
            RecordType::ResultAttestation => "RESULT_ATTESTATION",
            RecordType::Execution => "EXECUTION",
            RecordType::RolesUpdate => "ROLES_UPDATE",
        }
    }
    pub fn summary_word(self) -> &'static str {
        match self {
            RecordType::Admission => "ADMIT",
            RecordType::Notice => "NOTICE",
            RecordType::GovernanceStatus => "STATUS",
            RecordType::ResultAttestation => "RESULT",
            RecordType::Execution => "EXECUTION",
            RecordType::RolesUpdate => "ROLES-UPDATE",
        }
    }
    fn parse(s: &str) -> Result<Self> {
        Ok(match s {
            "ADMISSION" => RecordType::Admission,
            "NOTICE" => RecordType::Notice,
            "GOVERNANCE_STATUS" => RecordType::GovernanceStatus,
            "RESULT_ATTESTATION" => RecordType::ResultAttestation,
            "EXECUTION" => RecordType::Execution,
            "ROLES_UPDATE" => RecordType::RolesUpdate,
            _ => return Err(Error::format(format!("unknown record_type {s}"))),
        })
    }
    /// Record types ordered by anchor height per poll.
    pub fn is_ordered(self) -> bool {
        matches!(self, RecordType::Admission | RecordType::GovernanceStatus | RecordType::ResultAttestation)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RecordDetail {
    Admission { admitted: bool },
    Notice { code: String },
    GovernanceStatus { status: GovStatus },
    ResultAttestation { result_hash: Hash32, pass: bool },
    Execution { tx_hash: Hash32 },
    RolesUpdate { new_roles_hash: Hash32 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum GovStatus {
    HoldExecution,
    Cleared,
    Voided,
}

impl GovStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            GovStatus::HoldExecution => "HOLD_EXECUTION",
            GovStatus::Cleared => "CLEARED",
            GovStatus::Voided => "VOIDED",
        }
    }
}

impl RecordDetail {
    pub fn record_type(&self) -> RecordType {
        match self {
            RecordDetail::Admission { .. } => RecordType::Admission,
            RecordDetail::Notice { .. } => RecordType::Notice,
            RecordDetail::GovernanceStatus { .. } => RecordType::GovernanceStatus,
            RecordDetail::ResultAttestation { .. } => RecordType::ResultAttestation,
            RecordDetail::Execution { .. } => RecordType::Execution,
            RecordDetail::RolesUpdate { .. } => RecordType::RolesUpdate,
        }
    }

    pub fn to_json(&self) -> Value {
        let o = match self {
            RecordDetail::Admission { admitted } => {
                Object::new().with("decision", Value::str(if *admitted { "ADMITTED" } else { "REJECTED" }))
            }
            RecordDetail::Notice { code } => Object::new().with("code", Value::str(code.clone())),
            RecordDetail::GovernanceStatus { status } => Object::new().with("status", Value::str(status.as_str())),
            RecordDetail::ResultAttestation { result_hash, pass } => Object::new()
                .with("result_hash", Value::str(to_hex(result_hash)))
                .with("outcome", Value::str(if *pass { "PASS" } else { "FAIL" })),
            RecordDetail::Execution { tx_hash } => Object::new().with("tx_hash", Value::str(to_hex(tx_hash))),
            RecordDetail::RolesUpdate { new_roles_hash } => {
                Object::new().with("new_roles_hash", Value::str(to_hex(new_roles_hash)))
            }
        };
        Value::Object(o)
    }

    fn from_json(t: RecordType, v: &Value) -> Result<Self> {
        let mut f = Fields::new(v, "record detail")?;
        let d = match t {
            RecordType::Admission => RecordDetail::Admission {
                admitted: match f.str("decision")? {
                    "ADMITTED" => true,
                    "REJECTED" => false,
                    other => return Err(Error::format(format!("unknown decision {other}"))),
                },
            },
            RecordType::Notice => {
                let code = f.str("code")?.to_string();
                if code.is_empty()
                    || code.len() > 16
                    || !code.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
                {
                    return Err(Error::format("notice code must be 1-16 of A-Z, 0-9, _"));
                }
                RecordDetail::Notice { code }
            }
            RecordType::GovernanceStatus => RecordDetail::GovernanceStatus {
                status: match f.str("status")? {
                    "HOLD_EXECUTION" => GovStatus::HoldExecution,
                    "CLEARED" => GovStatus::Cleared,
                    "VOIDED" => GovStatus::Voided,
                    other => return Err(Error::format(format!("unknown status {other}"))),
                },
            },
            RecordType::ResultAttestation => {
                let result_hash = hash_field(&mut f, "result_hash")?;
                let pass = match f.str("outcome")? {
                    "PASS" => true,
                    "FAIL" => false,
                    other => return Err(Error::format(format!("unknown outcome {other}"))),
                };
                RecordDetail::ResultAttestation { result_hash, pass }
            }
            RecordType::Execution => RecordDetail::Execution { tx_hash: hash_field(&mut f, "tx_hash")? },
            RecordType::RolesUpdate => RecordDetail::RolesUpdate { new_roles_hash: hash_field(&mut f, "new_roles_hash")? },
        };
        f.finish()?;
        Ok(d)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessRecord {
    pub genesis: Hash32,
    pub roles_hash: Hash32,
    pub role: Role,
    pub poll_id: Option<Hash32>,
    pub detail: RecordDetail,
    pub evidence_hash: Option<Hash32>,
    pub anchor_block_hash: Hash32,
    pub publication_deadline_ms: u64,
    pub nonce: Hash32,
    raw: Value,
}

#[derive(Clone, Debug)]
pub struct RecordDraft {
    pub genesis: Hash32,
    pub roles_hash: Hash32,
    pub role: Role,
    pub poll_id: Option<Hash32>,
    pub detail: RecordDetail,
    pub evidence_hash: Option<Hash32>,
    pub anchor_block_hash: Hash32,
    pub publication_deadline_ms: u64,
    pub nonce: Hash32,
}

impl RecordDraft {
    pub fn build(&self) -> Result<ProcessRecord> {
        let o = Object::new()
            .with("message_kind", Value::str("process_record"))
            .with("protocol_version", Value::str(PROTOCOL_VERSION))
            .with("network_genesis_hash", Value::str(to_hex(&self.genesis)))
            .with("dao_namespace", Value::str(DAO_NAMESPACE))
            .with("roles_hash", Value::str(to_hex(&self.roles_hash)))
            .with("role", Value::str(self.role.as_str()))
            .with("record_type", Value::str(self.detail.record_type().as_str()))
            .with("poll_id", opt_hash_value(&self.poll_id))
            .with("detail", self.detail.to_json())
            .with("evidence_hash", opt_hash_value(&self.evidence_hash))
            .with("anchor_block_hash", Value::str(to_hex(&self.anchor_block_hash)))
            .with("publication_deadline_ms", Value::str(dec(self.publication_deadline_ms)))
            .with("nonce", Value::str(to_hex(&self.nonce)));
        ProcessRecord::from_json(&Value::Object(o))
    }
}

impl ProcessRecord {
    pub fn from_json(v: &Value) -> Result<Self> {
        let mut f = Fields::new(v, "process_record")?;
        f.literal("message_kind", "process_record")?;
        f.literal("protocol_version", PROTOCOL_VERSION)?;
        let genesis = hash_field(&mut f, "network_genesis_hash")?;
        f.literal("dao_namespace", DAO_NAMESPACE)?;
        let roles_hash = hash_field(&mut f, "roles_hash")?;
        let role = match f.str("role")? {
            "committee" => Role::Committee,
            "coordinator" => Role::Coordinator,
            other => return Err(Error::format(format!("unknown role {other}"))),
        };
        let record_type = RecordType::parse(f.str("record_type")?)?;
        let poll_id = opt_hash_field(&mut f, "poll_id")?;
        let detail = RecordDetail::from_json(record_type, f.value("detail")?)?;
        let evidence_hash = opt_hash_field(&mut f, "evidence_hash")?;
        let anchor_block_hash = hash_field(&mut f, "anchor_block_hash")?;
        let publication_deadline_ms = parse_dec_u64(f.str("publication_deadline_ms")?, "publication_deadline_ms")?;
        let nonce = hash_field(&mut f, "nonce")?;
        f.finish()?;
        let role_ok = match record_type {
            RecordType::Admission => role == Role::Coordinator,
            RecordType::Notice => true,
            _ => role == Role::Committee,
        };
        if !role_ok {
            return Err(Error::format(format!("{} cannot be signed by {}", record_type.as_str(), role.as_str())));
        }
        let poll_ok = match record_type {
            RecordType::RolesUpdate => poll_id.is_none(),
            _ => poll_id.is_some(),
        };
        if !poll_ok {
            return Err(Error::format("poll_id presence does not match record_type"));
        }
        Ok(ProcessRecord {
            genesis,
            roles_hash,
            role,
            poll_id,
            detail,
            evidence_hash,
            anchor_block_hash,
            publication_deadline_ms,
            nonce,
            raw: v.clone(),
        })
    }

    pub fn to_json(&self) -> &Value {
        &self.raw
    }

    pub fn record_id(&self) -> Hash32 {
        domain_hash(domain::PROCESS, &jcs_bytes(&self.raw))
    }

    pub fn record_type(&self) -> RecordType {
        self.detail.record_type()
    }

    /// Hash shown after `#` in the summary line.
    pub fn summary_target(&self) -> Hash32 {
        match &self.detail {
            RecordDetail::RolesUpdate { new_roles_hash } => *new_roles_hash,
            _ => self.poll_id.expect("validated"),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessEnvelope {
    pub body: ProcessRecord,
    pub proofs: Vec<(Hash32, Proof)>,
}

impl ProcessEnvelope {
    pub fn to_json(&self) -> Value {
        Value::Object(
            Object::new().with("body", self.body.to_json().clone()).with(
                "proofs",
                Value::Array(
                    self.proofs
                        .iter()
                        .map(|(k, p)| {
                            Value::Object(
                                Object::new()
                                    .with("signer_key_id", Value::str(to_hex(k)))
                                    .with("proof", p.to_json()),
                            )
                        })
                        .collect(),
                ),
            ),
        )
    }
    pub fn from_json(v: &Value) -> Result<Self> {
        let mut f = Fields::new(v, "process envelope")?;
        let body = ProcessRecord::from_json(f.value("body")?)?;
        let mut proofs = Vec::new();
        for p in f.array("proofs")? {
            let mut pf = Fields::new(p, "process proof")?;
            let k = hash_field(&mut pf, "signer_key_id")?;
            let proof = Proof::from_json(pf.value("proof")?)?;
            pf.finish()?;
            proofs.push((k, proof));
        }
        f.finish()?;
        Ok(ProcessEnvelope { body, proofs })
    }
}

// ---------------------------------------------------------------------------
// Manifest payload with proposer signatures (docs/03 §3.1)

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProposerProof {
    pub owner_lock: Script,
    pub auth_adapter: String,
    pub proof: Proof,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ManifestPayload {
    pub manifest: crate::types::Manifest,
    pub proposer_proofs: Vec<ProposerProof>,
}

impl ManifestPayload {
    pub fn to_json(&self) -> Value {
        Value::Object(
            Object::new()
                .with("protocol_version", Value::str(PROTOCOL_VERSION))
                .with("manifest", self.manifest.to_json().clone())
                .with(
                    "proposer_proofs",
                    Value::Array(
                        self.proposer_proofs
                            .iter()
                            .map(|p| {
                                Value::Object(
                                    Object::new()
                                        .with("owner_lock", p.owner_lock.to_json())
                                        .with("auth_adapter", Value::str(p.auth_adapter.clone()))
                                        .with("proof", p.proof.to_json()),
                                )
                            })
                            .collect(),
                    ),
                ),
        )
    }

    pub fn from_json(v: &Value) -> Result<Self> {
        let mut f = Fields::new(v, "manifest payload")?;
        f.literal("protocol_version", PROTOCOL_VERSION)?;
        let manifest = crate::types::Manifest::from_json(f.value("manifest")?)?;
        let mut proposer_proofs = Vec::new();
        for p in f.array("proposer_proofs")? {
            let mut pf = Fields::new(p, "proposer proof")?;
            let owner_lock = Script::from_json(pf.value("owner_lock")?)?;
            let auth_adapter = pf.str("auth_adapter")?.to_string();
            let proof = Proof::from_json(pf.value("proof")?)?;
            pf.finish()?;
            proposer_proofs.push(ProposerProof { owner_lock, auth_adapter, proof });
        }
        f.finish()?;
        Ok(ManifestPayload { manifest, proposer_proofs })
    }
}

/// Decode a `0x` hex string of arbitrary length (helper for API callers).
pub fn hex_bytes(s: &str) -> Result<Vec<u8>> {
    parse_hex(s, "hex")
}

/// Short identifier shown as `#xxxxxxxxxxxxxxxx` (first 16 hex digits).
pub fn short_id(h: &Hash32) -> String {
    to_hex_bare(&h[..8])
}
