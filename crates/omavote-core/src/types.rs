//! Poll-level protocol objects: rules profile, authorization policy, adapter registry and manifest.

use crate::error::{Error, Result};
use crate::hash::{domain, domain_hash};
use crate::json::{jcs_bytes, Fields, Object, Value};
use crate::molecule::Script;
use crate::util::{dec, parse_dec_u64, parse_hash, to_hex, Hash32};

pub const PROTOCOL_VERSION: &str = "2";
pub const DAO_NAMESPACE: &str = "ckb-community-fund-dao";
pub const CLOCK_ID: &str = "ckb-parent-mtp-v1";
pub const PUBLICATION_POLICY: &str = "full-onchain-v2";
pub const SIG_FORMAT_READABLE: &str = "omavote-readable-v2";
pub const SIG_FORMAT_AUTHORIZATION: &str = "omavote-authorization-v2";
pub const SIG_FORMAT_PROPOSAL: &str = "omavote-proposal-v2";
pub const SIG_FORMAT_PROCESS: &str = "omavote-process-v2";
pub const AUTH_SEMANTICS: &str = "omavote-authorization-semantics-v2";

pub const DAY_MS: u64 = 86_400_000;
pub const MAX_TERM_MS: u64 = 365 * DAY_MS;
pub const MAX_CONTROL_PUBLICATION_DELAY_MS: u64 = DAY_MS;
/// Protocol constant for process records (candidate value, see docs/03 §3.1).
pub const MAX_PROCESS_PUBLICATION_DELAY_MS: u64 = 3 * DAY_MS;
pub const SHANNON_PER_CKB: u128 = 100_000_000;

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

// ---------------------------------------------------------------------------
// Rules profile (docs/03 §4, encoding in docs/13 §4)

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ratio {
    pub numerator: u128,
    pub denominator: u128,
}

impl Ratio {
    fn to_json(&self) -> Value {
        Value::Object(
            Object::new()
                .with("numerator", Value::str(dec(self.numerator)))
                .with("denominator", Value::str(dec(self.denominator))),
        )
    }
    fn from_json(v: &Value) -> Result<Self> {
        let mut f = Fields::new(v, "ratio")?;
        let numerator = parse_dec_u64(f.str("numerator")?, "numerator")? as u128;
        let denominator = parse_dec_u64(f.str("denominator")?, "denominator")? as u128;
        f.finish()?;
        if denominator == 0 || numerator > denominator {
            return Err(Error::format("ratio must satisfy 0 <= numerator <= denominator, denominator > 0"));
        }
        Ok(Ratio { numerator, denominator })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RulesProfile {
    pub profile: String,
    pub quorum_grant_multiplier: u128,
    pub quorum_meta_rule_shannon: u128,
    pub approval_grant: Ratio,
    pub approval_meta_rule: Ratio,
    pub threshold_inclusive: bool,
    pub opening_confirmations: u64,
    pub delegate_cutoff_ms: u64,
    pub voting_period_ms: u64,
    pub proposer_min_deposit_shannon: u128,
    raw: Value,
}

const RULE_FIXED: &[(&str, &str)] = &[
    ("asset", "nervos-dao-deposit"),
    ("amount", "raw-capacity-principal"),
    ("weight_time", "final-accepted-block-state"),
    ("withdraw_phase1", "excluded"),
    ("cast_eligibility", "positive-deposit-at-valid-inclusion"),
    ("revote", "direct-priority-latest-anchor"),
    ("authorization", "term-limited-max-365-chain-days"),
    ("cancel", "exclude-both-sides-and-quorum"),
    ("precision", "exact-shannon"),
];

/// Builder parameters for a rules profile.
#[derive(Clone, Debug)]
pub struct RulesParams {
    pub threshold_inclusive: bool,
    pub opening_confirmations: u64,
    pub delegate_cutoff_ms: u64,
    pub voting_period_ms: u64,
}

impl Default for RulesParams {
    fn default() -> Self {
        RulesParams {
            threshold_inclusive: true,
            opening_confirmations: 100,
            delegate_cutoff_ms: 0,
            voting_period_ms: 7 * DAY_MS,
        }
    }
}

impl RulesProfile {
    pub fn build(p: &RulesParams) -> Self {
        let mut o = Object::new().with("profile", Value::str("omavote-ckb-community-fund-v2"));
        for (k, v) in RULE_FIXED {
            o.insert(*k, Value::str(*v));
        }
        o.insert(
            "choices",
            Value::Array(vec![Value::str("YES"), Value::str("NO"), Value::str("CANCEL")]),
        );
        o.insert("quorum_grant_multiplier", Value::str("3"));
        o.insert("quorum_meta_rule_shannon", Value::str(dec(185_000_000u128 * SHANNON_PER_CKB)));
        o.insert("approval_grant", Ratio { numerator: 51, denominator: 100 }.to_json());
        o.insert("approval_meta_rule", Ratio { numerator: 67, denominator: 100 }.to_json());
        o.insert(
            "threshold_comparison",
            Value::str(if p.threshold_inclusive { "inclusive" } else { "strict" }),
        );
        o.insert("opening_confirmations", Value::str(dec(p.opening_confirmations)));
        o.insert("delegate_cutoff_ms", Value::str(dec(p.delegate_cutoff_ms)));
        o.insert("voting_period_ms", Value::str(dec(p.voting_period_ms)));
        o.insert("proposer_min_deposit_shannon", Value::str(dec(100_000u128 * SHANNON_PER_CKB)));
        Self::from_json(&Value::Object(o)).expect("default rules profile is valid")
    }

    pub fn from_json(v: &Value) -> Result<Self> {
        let mut f = Fields::new(v, "rules_profile")?;
        let profile = f.str("profile")?.to_string();
        if profile != "omavote-ckb-community-fund-v2" {
            return Err(Error::unsupported(format!("rules profile {profile}")));
        }
        for (k, expected) in RULE_FIXED {
            let got = f.str(k)?;
            if got != *expected {
                return Err(Error::unsupported(format!("rules_profile.{k} = {got:?}")));
            }
        }
        let choices = f.array("choices")?;
        let names: Vec<&str> = choices.iter().filter_map(|c| c.as_str()).collect();
        if names != ["YES", "NO", "CANCEL"] {
            return Err(Error::unsupported("rules_profile.choices"));
        }
        let quorum_grant_multiplier = parse_dec_u64(f.str("quorum_grant_multiplier")?, "quorum_grant_multiplier")? as u128;
        let quorum_meta_rule_shannon = parse_dec_u64(f.str("quorum_meta_rule_shannon")?, "quorum_meta_rule_shannon")? as u128;
        let approval_grant = Ratio::from_json(f.value("approval_grant")?)?;
        let approval_meta_rule = Ratio::from_json(f.value("approval_meta_rule")?)?;
        let threshold_inclusive = match f.str("threshold_comparison")? {
            "inclusive" => true,
            "strict" => false,
            other => return Err(Error::unsupported(format!("threshold_comparison {other}"))),
        };
        let opening_confirmations = parse_dec_u64(f.str("opening_confirmations")?, "opening_confirmations")?;
        let delegate_cutoff_ms = parse_dec_u64(f.str("delegate_cutoff_ms")?, "delegate_cutoff_ms")?;
        let voting_period_ms = parse_dec_u64(f.str("voting_period_ms")?, "voting_period_ms")?;
        let proposer_min_deposit_shannon =
            parse_dec_u64(f.str("proposer_min_deposit_shannon")?, "proposer_min_deposit_shannon")? as u128;
        f.finish()?;
        if voting_period_ms == 0 || delegate_cutoff_ms > voting_period_ms {
            return Err(Error::format("rules_profile: invalid voting period or delegate cutoff"));
        }
        Ok(RulesProfile {
            profile,
            quorum_grant_multiplier,
            quorum_meta_rule_shannon,
            approval_grant,
            approval_meta_rule,
            threshold_inclusive,
            opening_confirmations,
            delegate_cutoff_ms,
            voting_period_ms,
            proposer_min_deposit_shannon,
            raw: v.clone(),
        })
    }

    pub fn to_json(&self) -> &Value {
        &self.raw
    }

    pub fn hash(&self) -> Hash32 {
        domain_hash(domain::RULES, &jcs_bytes(&self.raw))
    }
}

// ---------------------------------------------------------------------------
// Authorization policy (docs/11 §2)

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthPolicy {
    pub genesis: Hash32,
    pub dao_namespace: String,
    pub max_term_ms: u64,
    pub max_control_publication_delay_ms: u64,
    raw: Value,
}

impl AuthPolicy {
    pub fn build(genesis: Hash32) -> Self {
        let o = Object::new()
            .with("message_kind", Value::str("authorization_policy"))
            .with("protocol_version", Value::str(PROTOCOL_VERSION))
            .with("network_genesis_hash", Value::str(to_hex(&genesis)))
            .with("dao_namespace", Value::str(DAO_NAMESPACE))
            .with("clock", Value::str(CLOCK_ID))
            .with("max_term_ms", Value::str(dec(MAX_TERM_MS)))
            .with("max_control_publication_delay_ms", Value::str(dec(MAX_CONTROL_PUBLICATION_DELAY_MS)))
            .with("semantics", Value::str(AUTH_SEMANTICS));
        Self::from_json(&Value::Object(o)).expect("default policy is valid")
    }

    pub fn from_json(v: &Value) -> Result<Self> {
        let mut f = Fields::new(v, "authorization_policy")?;
        f.literal("message_kind", "authorization_policy")?;
        f.literal("protocol_version", PROTOCOL_VERSION)?;
        let genesis = hash_field(&mut f, "network_genesis_hash")?;
        let dao_namespace = f.str("dao_namespace")?.to_string();
        if dao_namespace != DAO_NAMESPACE {
            return Err(Error::unsupported(format!("dao_namespace {dao_namespace}")));
        }
        f.literal("clock", CLOCK_ID)?;
        let max_term_ms = parse_dec_u64(f.str("max_term_ms")?, "max_term_ms")?;
        let max_control_publication_delay_ms =
            parse_dec_u64(f.str("max_control_publication_delay_ms")?, "max_control_publication_delay_ms")?;
        f.literal("semantics", AUTH_SEMANTICS)?;
        f.finish()?;
        if max_term_ms != MAX_TERM_MS || max_control_publication_delay_ms != MAX_CONTROL_PUBLICATION_DELAY_MS {
            return Err(Error::unsupported("authorization policy constants differ from V2"));
        }
        Ok(AuthPolicy { genesis, dao_namespace, max_term_ms, max_control_publication_delay_ms, raw: v.clone() })
    }

    pub fn to_json(&self) -> &Value {
        &self.raw
    }

    pub fn hash(&self) -> Hash32 {
        domain_hash(domain::AUTH_POLICY, &jcs_bytes(&self.raw))
    }
}

// ---------------------------------------------------------------------------
// Per-poll adapter acceptance list (docs/03 §5.1)

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthRegistry {
    pub owner_adapters: Vec<String>,
    pub key_adapters: Vec<String>,
}

impl AuthRegistry {
    pub fn new(mut owner: Vec<String>, mut key: Vec<String>) -> Self {
        owner.sort();
        owner.dedup();
        key.sort();
        key.dedup();
        AuthRegistry { owner_adapters: owner, key_adapters: key }
    }

    pub fn to_json(&self) -> Value {
        let arr = |v: &Vec<String>| Value::Array(v.iter().map(|s| Value::str(s.clone())).collect());
        Value::Object(
            Object::new()
                .with("owner_adapters", arr(&self.owner_adapters))
                .with("key_adapters", arr(&self.key_adapters)),
        )
    }

    pub fn from_json(v: &Value) -> Result<Self> {
        let mut f = Fields::new(v, "auth_registry")?;
        let read = |a: &Vec<Value>| -> Result<Vec<String>> {
            let list: Vec<String> = a
                .iter()
                .map(|x| x.as_str().map(str::to_string).ok_or_else(|| Error::format("adapter id must be a string")))
                .collect::<Result<_>>()?;
            let mut sorted = list.clone();
            sorted.sort();
            sorted.dedup();
            if sorted != list {
                return Err(Error::format("auth_registry lists must be sorted and unique"));
            }
            for id in &list {
                if !crate::adapter::is_defined_adapter(id) {
                    return Err(Error::format(format!("auth_registry: undefined adapter {id}")));
                }
            }
            Ok(list)
        };
        let owner_adapters = read(f.array("owner_adapters")?)?;
        let key_adapters = read(f.array("key_adapters")?)?;
        f.finish()?;
        Ok(AuthRegistry { owner_adapters, key_adapters })
    }

    pub fn hash(&self) -> Hash32 {
        domain_hash(domain::AUTH_REGISTRY, &jcs_bytes(&self.to_json()))
    }

    pub fn accepts_owner(&self, id: &str) -> bool {
        self.owner_adapters.iter().any(|a| a == id)
    }

    pub fn accepts_key(&self, id: &str) -> bool {
        self.key_adapters.iter().any(|a| a == id)
    }
}

// ---------------------------------------------------------------------------
// Manifest (docs/03 §3)

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProposalType {
    Grant,
    MetaRule,
}

impl ProposalType {
    pub fn as_str(self) -> &'static str {
        match self {
            ProposalType::Grant => "grant",
            ProposalType::MetaRule => "meta_rule",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfirmationPolicy {
    pub result_confirmations: u64,
    pub review_window_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Manifest {
    pub genesis: Hash32,
    pub nonce: Hash32,
    pub proposal_type: ProposalType,
    pub title: String,
    pub signing_title: String,
    pub content_hash: Hash32,
    pub content_locations: Vec<String>,
    pub forum_topic_id: String,
    pub forum_revision: String,
    pub discussion_evidence_hash: Option<Hash32>,
    pub budget_ckb_shannon: u128,
    pub quorum_base_shannon: u128,
    pub payment_terms_hash: Option<Hash32>,
    pub recipient_lock_script: Option<Script>,
    pub proposer_owner_locks: Vec<Script>,
    pub rules: RulesProfile,
    pub auth_registry: AuthRegistry,
    pub auth_policy: AuthPolicy,
    pub signature_formats: Vec<String>,
    pub start_ms: u64,
    pub end_ms: u64,
    pub confirmation: ConfirmationPolicy,
    raw: Value,
}

/// Fields needed to build a manifest; derived fields (hashes) are computed.
#[derive(Clone, Debug)]
pub struct ManifestDraft {
    pub genesis: Hash32,
    pub nonce: Hash32,
    pub proposal_type: ProposalType,
    pub title: String,
    pub signing_title: String,
    pub content_hash: Hash32,
    pub content_locations: Vec<String>,
    pub forum_topic_id: String,
    pub forum_revision: String,
    pub discussion_evidence_hash: Option<Hash32>,
    pub budget_ckb_shannon: u128,
    pub quorum_base_shannon: u128,
    pub payment_terms_hash: Option<Hash32>,
    pub recipient_lock_script: Option<Script>,
    pub proposer_owner_locks: Vec<Script>,
    pub rules: RulesProfile,
    pub auth_registry: AuthRegistry,
    pub auth_policy: AuthPolicy,
    pub start_ms: u64,
    pub confirmation: ConfirmationPolicy,
}

impl ManifestDraft {
    pub fn build(mut self) -> Result<Manifest> {
        self.proposer_owner_locks.sort_by_key(|s| s.hash());
        self.proposer_owner_locks.dedup();
        let opt_hash = |h: &Option<Hash32>| Value::opt_str(h.map(|x| to_hex(&x)));
        let o = Object::new()
            .with("message_kind", Value::str("manifest"))
            .with("protocol_version", Value::str(PROTOCOL_VERSION))
            .with("network_genesis_hash", Value::str(to_hex(&self.genesis)))
            .with("dao_namespace", Value::str(DAO_NAMESPACE))
            .with("nonce", Value::str(to_hex(&self.nonce)))
            .with("proposal_type", Value::str(self.proposal_type.as_str()))
            .with("title", Value::str(self.title.clone()))
            .with("signing_title", Value::str(self.signing_title.clone()))
            .with("content_hash", Value::str(to_hex(&self.content_hash)))
            .with(
                "content_locations",
                Value::Array(self.content_locations.iter().map(|s| Value::str(s.clone())).collect()),
            )
            .with("forum_topic_id", Value::str(self.forum_topic_id.clone()))
            .with("forum_revision", Value::str(self.forum_revision.clone()))
            .with("discussion_evidence_hash", opt_hash(&self.discussion_evidence_hash))
            .with("budget_ckb_shannon", Value::str(dec(self.budget_ckb_shannon)))
            .with("quorum_base_shannon", Value::str(dec(self.quorum_base_shannon)))
            .with("payment_terms_hash", opt_hash(&self.payment_terms_hash))
            .with(
                "recipient_lock_script",
                self.recipient_lock_script.as_ref().map(|s| s.to_json()).unwrap_or(Value::Null),
            )
            .with(
                "proposer_owner_locks",
                Value::Array(self.proposer_owner_locks.iter().map(|s| s.to_json()).collect()),
            )
            .with("rules_profile", self.rules.to_json().clone())
            .with("rules_hash", Value::str(to_hex(&self.rules.hash())))
            .with("auth_registry", self.auth_registry.to_json())
            .with("auth_registry_hash", Value::str(to_hex(&self.auth_registry.hash())))
            .with("authorization_policy", self.auth_policy.to_json().clone())
            .with("auth_policy_hash", Value::str(to_hex(&self.auth_policy.hash())))
            .with("signature_formats", Value::Array(vec![Value::str(SIG_FORMAT_READABLE)]))
            .with("clock", Value::str(CLOCK_ID))
            .with("start_ms", Value::str(dec(self.start_ms)))
            .with("end_ms", Value::str(dec(self.start_ms + self.rules.voting_period_ms)))
            .with(
                "confirmation_policy",
                Value::Object(
                    Object::new()
                        .with("result_confirmations", Value::str(dec(self.confirmation.result_confirmations)))
                        .with("review_window_ms", Value::str(dec(self.confirmation.review_window_ms))),
                ),
            )
            .with("publication_policy", Value::str(PUBLICATION_POLICY));
        Manifest::from_json(&Value::Object(o))
    }
}

/// Signing title rules from docs/03 §5 rule 2.
pub fn validate_signing_title(t: &str) -> Result<()> {
    let n = t.chars().count();
    if !(1..=80).contains(&n) {
        return Err(Error::format("signing_title must have 1-80 Unicode scalar values"));
    }
    if t.starts_with(char::is_whitespace) || t.ends_with(char::is_whitespace) {
        return Err(Error::format("signing_title must not have leading or trailing whitespace"));
    }
    for c in t.chars() {
        let u = c as u32;
        let forbidden = u <= 0x1f
            || (0x7f..=0x9f).contains(&u)
            || u == 0x2028
            || u == 0x2029
            || u == 0x061c
            || u == 0x200e
            || u == 0x200f
            || (0x202a..=0x202e).contains(&u)
            || (0x2066..=0x2069).contains(&u);
        if forbidden {
            return Err(Error::format(format!("signing_title contains forbidden character U+{u:04X}")));
        }
    }
    Ok(())
}

impl Manifest {
    pub fn from_json(v: &Value) -> Result<Self> {
        let mut f = Fields::new(v, "manifest")?;
        f.literal("message_kind", "manifest")?;
        f.literal("protocol_version", PROTOCOL_VERSION)?;
        let genesis = hash_field(&mut f, "network_genesis_hash")?;
        f.literal("dao_namespace", DAO_NAMESPACE)?;
        let nonce = hash_field(&mut f, "nonce")?;
        let proposal_type = match f.str("proposal_type")? {
            "grant" => ProposalType::Grant,
            "meta_rule" => ProposalType::MetaRule,
            other => return Err(Error::format(format!("unknown proposal_type {other}"))),
        };
        let title = f.str("title")?.to_string();
        if title.is_empty() {
            return Err(Error::format("title must not be empty"));
        }
        let signing_title = f.str("signing_title")?.to_string();
        validate_signing_title(&signing_title)?;
        let content_hash = hash_field(&mut f, "content_hash")?;
        let content_locations = f
            .array("content_locations")?
            .iter()
            .map(|x| x.as_str().map(str::to_string).ok_or_else(|| Error::format("content location must be a string")))
            .collect::<Result<Vec<_>>>()?;
        let forum_topic_id = f.str("forum_topic_id")?.to_string();
        parse_dec_u64(&forum_topic_id, "forum_topic_id")?;
        let forum_revision = f.str("forum_revision")?.to_string();
        parse_dec_u64(&forum_revision, "forum_revision")?;
        let discussion_evidence_hash = opt_hash_field(&mut f, "discussion_evidence_hash")?;
        let budget_ckb_shannon = parse_dec_u64(f.str("budget_ckb_shannon")?, "budget_ckb_shannon")? as u128;
        let quorum_base_shannon = parse_dec_u64(f.str("quorum_base_shannon")?, "quorum_base_shannon")? as u128;
        let payment_terms_hash = opt_hash_field(&mut f, "payment_terms_hash")?;
        let recipient_lock_script = match f.value("recipient_lock_script")? {
            Value::Null => None,
            other => Some(Script::from_json(other)?),
        };
        let proposer_owner_locks = f
            .array("proposer_owner_locks")?
            .iter()
            .map(Script::from_json)
            .collect::<Result<Vec<_>>>()?;
        let rules = RulesProfile::from_json(f.value("rules_profile")?)?;
        let rules_hash = hash_field(&mut f, "rules_hash")?;
        let auth_registry = AuthRegistry::from_json(f.value("auth_registry")?)?;
        let auth_registry_hash = hash_field(&mut f, "auth_registry_hash")?;
        let auth_policy = AuthPolicy::from_json(f.value("authorization_policy")?)?;
        let auth_policy_hash = hash_field(&mut f, "auth_policy_hash")?;
        let signature_formats = f
            .array("signature_formats")?
            .iter()
            .map(|x| x.as_str().map(str::to_string).ok_or_else(|| Error::format("signature format must be a string")))
            .collect::<Result<Vec<_>>>()?;
        f.literal("clock", CLOCK_ID)?;
        let start_ms = parse_dec_u64(f.str("start_ms")?, "start_ms")?;
        let end_ms = parse_dec_u64(f.str("end_ms")?, "end_ms")?;
        let confirmation = {
            let mut c = Fields::new(f.value("confirmation_policy")?, "confirmation_policy")?;
            let result_confirmations = parse_dec_u64(c.str("result_confirmations")?, "result_confirmations")?;
            let review_window_ms = parse_dec_u64(c.str("review_window_ms")?, "review_window_ms")?;
            c.finish()?;
            ConfirmationPolicy { result_confirmations, review_window_ms }
        };
        f.literal("publication_policy", PUBLICATION_POLICY)?;
        f.finish()?;

        if rules_hash != rules.hash() {
            return Err(Error::format("manifest.rules_hash does not match rules_profile"));
        }
        if auth_registry_hash != auth_registry.hash() {
            return Err(Error::format("manifest.auth_registry_hash does not match auth_registry"));
        }
        if auth_policy_hash != auth_policy.hash() {
            return Err(Error::format("manifest.auth_policy_hash does not match authorization_policy"));
        }
        if auth_policy.genesis != genesis {
            return Err(Error::format("authorization policy belongs to another network"));
        }
        if signature_formats != [SIG_FORMAT_READABLE] {
            return Err(Error::unsupported("only omavote-readable-v2 ballots are supported"));
        }
        if end_ms != start_ms.saturating_add(rules.voting_period_ms) || end_ms <= start_ms {
            return Err(Error::format("manifest window must equal rules_profile.voting_period_ms"));
        }
        if proposer_owner_locks.is_empty() {
            return Err(Error::format("manifest needs at least one proposer lock"));
        }
        let ids: Vec<Hash32> = proposer_owner_locks.iter().map(|s| s.hash()).collect();
        if ids.windows(2).any(|w| w[0] >= w[1]) {
            return Err(Error::format("proposer_owner_locks must be sorted by owner_id and unique"));
        }
        match proposal_type {
            ProposalType::Grant => {
                if budget_ckb_shannon == 0 || recipient_lock_script.is_none() || quorum_base_shannon == 0 {
                    return Err(Error::format("grant proposals need a budget, quorum base and recipient"));
                }
            }
            ProposalType::MetaRule => {
                if budget_ckb_shannon != 0 || quorum_base_shannon != 0 || recipient_lock_script.is_some() {
                    return Err(Error::format("meta-rule proposals have zero budget and no recipient"));
                }
            }
        }
        Ok(Manifest {
            genesis,
            nonce,
            proposal_type,
            title,
            signing_title,
            content_hash,
            content_locations,
            forum_topic_id,
            forum_revision,
            discussion_evidence_hash,
            budget_ckb_shannon,
            quorum_base_shannon,
            payment_terms_hash,
            recipient_lock_script,
            proposer_owner_locks,
            rules,
            auth_registry,
            auth_policy,
            signature_formats,
            start_ms,
            end_ms,
            confirmation,
            raw: v.clone(),
        })
    }

    pub fn to_json(&self) -> &Value {
        &self.raw
    }

    pub fn poll_id(&self) -> Hash32 {
        domain_hash(domain::POLL, &jcs_bytes(&self.raw))
    }

    pub fn rules_hash(&self) -> Hash32 {
        self.rules.hash()
    }

    pub fn auth_policy_hash(&self) -> Hash32 {
        self.auth_policy.hash()
    }

    pub fn auth_registry_hash(&self) -> Hash32 {
        self.auth_registry.hash()
    }

    /// Required quorum in shannons.
    pub fn quorum_required(&self) -> u128 {
        match self.proposal_type {
            ProposalType::Grant => self.rules.quorum_grant_multiplier * self.quorum_base_shannon,
            ProposalType::MetaRule => self.rules.quorum_meta_rule_shannon,
        }
    }

    pub fn approval(&self) -> &Ratio {
        match self.proposal_type {
            ProposalType::Grant => &self.rules.approval_grant,
            ProposalType::MetaRule => &self.rules.approval_meta_rule,
        }
    }

    /// Last chain time (exclusive) at which delegate ballots are accepted.
    pub fn delegate_end_ms(&self) -> u64 {
        self.end_ms - self.rules.delegate_cutoff_ms
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signing_title_rules() {
        assert!(validate_signing_title("Fund the explorer").is_ok());
        assert!(validate_signing_title("资助浏览器开发").is_ok());
        assert!(validate_signing_title("").is_err());
        assert!(validate_signing_title(" lead").is_err());
        assert!(validate_signing_title("trail ").is_err());
        assert!(validate_signing_title("bidi\u{202e}x").is_err());
        assert!(validate_signing_title(&"x".repeat(81)).is_err());
        assert!(validate_signing_title(&"字".repeat(80)).is_ok());
    }

    #[test]
    fn rules_profile_roundtrip() {
        let r = RulesProfile::build(&RulesParams::default());
        let back = RulesProfile::from_json(r.to_json()).unwrap();
        assert_eq!(back.hash(), r.hash());
        assert_eq!(r.opening_confirmations, 100);
        assert!(r.threshold_inclusive);
    }
}
