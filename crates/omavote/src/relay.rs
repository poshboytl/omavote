//! Relay: intake of signed envelopes with relay-signed receipts, and the publisher
//! that batches them into carriers paid for by the relay (docs/03 §12, docs/13 §6).
//!
//! Intake checks are a sponsorship pre-check against the indexed state. They never
//! decide validity: the replay engine re-checks everything at the inclusion position.

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use omavote_core::adapter::{self, sign_digest_recoverable};
use omavote_core::carrier::{self, Kind};
use omavote_core::engine::Engine;
use omavote_core::hash::{ckb_hash, domain, domain_hash};
use omavote_core::json::{self as cj, jcs_bytes, parse, Object};
use omavote_core::messages::{
    Action, Authority, BallotEnvelope, ControlAction, ControlEnvelope, KeyDescriptor, ManifestPayload, ProcessEnvelope, ProcessRoles,
};
use omavote_core::molecule::OutPoint;
use omavote_core::network::NetworkParams;
use omavote_core::text;
use omavote_core::types::{AuthPolicy, PROTOCOL_VERSION};
use omavote_core::util::{to_hex, Hash32};
use serde_json::{json, Value};

use crate::chain::GenesisCells;
use crate::config::RelayConfig;
use crate::rpc::Rpc;
use crate::store::{RelayItem, RelayTx, Store};
use crate::sync::{read, Shared};
use crate::txbuilder::{self, LiveCell, TxPlan, Wallet};
use crate::util::{dec, now_ms, to_serde};

// ---------------------------------------------------------------------------
// Intake

#[derive(Debug)]
pub struct Reject {
    pub code: &'static str,
    pub detail: String,
}

fn rej<T>(code: &'static str, detail: impl Into<String>) -> std::result::Result<T, Reject> {
    Err(Reject { code, detail: detail.into() })
}

struct Accepted {
    message_kind: &'static str,
    object_id: Hash32,
    carrier_kind: Kind,
    scope_id: Hash32,
    publish_by_ms: Option<u64>,
    on_chain: bool,
}

pub struct Intake {
    pub store: Arc<Store>,
    pub state: Shared,
    pub receipt_key: Wallet,
}

fn tip_clock(engine: &Engine) -> u64 {
    engine.tip.map(|t| t.2).unwrap_or(0)
}

/// A control envelope waiting in this relay's queue (grant published together with a ballot).
fn queued_control(store: &Store, id: &Hash32) -> Option<ControlEnvelope> {
    let item = store.relay_find("authorization_control", &to_hex(id)).ok().flatten()?;
    if matches!(item.status.as_str(), "FAILED" | "EXPIRED") {
        return None;
    }
    ControlEnvelope::from_json(&parse(item.envelope.as_bytes()).ok()?).ok()
}

fn queued_policy(store: &Store, id: &Hash32) -> Option<AuthPolicy> {
    let item = store.relay_find("authorization_policy", &to_hex(id)).ok().flatten()?;
    AuthPolicy::from_json(&parse(item.envelope.as_bytes()).ok()?).ok()
}

fn check_ballot(engine: &Engine, store: &Store, env: &BallotEnvelope) -> std::result::Result<Accepted, Reject> {
    let net = engine.network();
    let b = &env.body;
    let poll = match engine.polls.get(&b.poll_id) {
        Some(p) => p,
        None => return rej("UNKNOWN_POLL", "poll is not registered on chain"),
    };
    if poll.late_manifest {
        return rej("LATE_MANIFEST", "poll has no valid opening");
    }
    let m = &poll.manifest;
    if b.genesis != net.genesis_hash || b.rules_hash != m.rules_hash() {
        return rej("WRONG_NETWORK", "ballot network or rules do not match the manifest");
    }
    let now = tip_clock(engine);
    if now < m.start_ms {
        return rej("OUT_OF_WINDOW", "voting has not started");
    }
    let end = if b.authority == Authority::Delegate { m.delegate_end_ms() } else { m.end_ms };
    if now >= end {
        return rej("OUT_OF_WINDOW", "voting has ended");
    }
    match engine.block_clock(&b.anchor_block_hash) {
        Some((n, _)) if n >= poll.registered.height => {}
        Some(_) => return rej("ANCHOR_INVALID", "anchor is older than the manifest"),
        None => return rej("ANCHOR_INVALID", "anchor is not a known canonical block"),
    }
    let text = text::ballot_text(m, b, net).map_err(|e| Reject { code: "INVALID_FORMAT", detail: e.to_string() })?;
    let ballot_id = b.ballot_id();
    let owner_id = b.owner_id();
    match b.authority {
        Authority::Owner => {
            if !m.auth_registry.accepts_owner(&b.auth_adapter) {
                return rej("ADAPTER_NOT_ACCEPTED", format!("owner adapter {}", b.auth_adapter));
            }
            if let Err(e) = adapter::verify_owner_signature(&b.auth_adapter, net, &b.owner_lock, &text, &env.proof.signature) {
                return rej("INVALID_SIGNATURE", e.to_string());
            }
        }
        Authority::Delegate => {
            let auth_id = b.authorization_id.expect("validated");
            let key: KeyDescriptor = match engine.grants.get(&auth_id) {
                Some(g) => {
                    if g.owner_id != owner_id {
                        return rej("WRONG_OWNER", "grant belongs to another owner");
                    }
                    if engine.current_grant(&g.policy_hash, &owner_id).map(|c| c.authorization_id) != Some(auth_id) {
                        return rej("NO_ACTIVE_GRANT", "grant is not the owner's current grant");
                    }
                    g.key.clone()
                }
                None => match queued_control(store, &auth_id) {
                    Some(c) if c.body.action == ControlAction::Grant && c.body.owner_id() == owner_id => {
                        c.body.key_descriptor.clone().expect("validated")
                    }
                    _ => return rej("NO_ACTIVE_GRANT", "authorization_id is not a known grant"),
                },
            };
            if b.signer_key_id != Some(key.key_id()) || b.auth_adapter != key.adapter_id() {
                return rej("KEY_MISMATCH", "signer key does not match the grant");
            }
            if !m.auth_registry.accepts_key(key.adapter_id()) {
                return rej("ADAPTER_NOT_ACCEPTED", format!("key adapter {}", key.adapter_id()));
            }
            if let Err(e) = adapter::verify_key_signature(&key, &text, &env.proof.signature) {
                return rej("INVALID_SIGNATURE", e.to_string());
            }
        }
    }
    if b.action != Action::Cancel && engine.owner_balance(&owner_id) == 0 {
        return rej("NO_DEPOSIT_AT_CAST", "the represented owner has no active Nervos DAO deposit");
    }
    if b.action == Action::Cancel && engine.owner_balance(&owner_id) == 0 && !poll.owner_locks.contains_key(&owner_id) {
        return rej("NOT_SPONSORED", "zero-balance CANCEL is only sponsored for owners with an earlier ballot");
    }
    Ok(Accepted {
        message_kind: "ballot",
        object_id: ballot_id,
        carrier_kind: Kind::BallotBatch,
        scope_id: b.poll_id,
        publish_by_ms: Some(end),
        on_chain: poll.ballots.iter().any(|a| a.ballot_id == ballot_id),
    })
}

fn check_control(engine: &Engine, store: &Store, env: &ControlEnvelope) -> std::result::Result<Accepted, Reject> {
    let net = engine.network();
    let c = &env.body;
    if c.genesis != net.genesis_hash {
        return rej("WRONG_NETWORK", "control for another network");
    }
    let policy = match engine.policies.get(&c.auth_policy_hash) {
        Some((p, _)) => p.clone(),
        None => match queued_policy(store, &c.auth_policy_hash) {
            Some(p) => p,
            None => return rej("POLICY_UNPUBLISHED", "authorization policy is not published"),
        },
    };
    let height = engine.tip.map(|t| t.0).unwrap_or(0);
    if !adapter::is_control_adapter(&c.owner_auth_adapter, height) {
        return rej("ADAPTER_NOT_ACCEPTED", format!("{} is not a control adapter", c.owner_auth_adapter));
    }
    let (_, t_anchor) = match engine.block_clock(&c.anchor_block_hash) {
        Some(a) => a,
        None => return rej("ANCHOR_INVALID", "anchor is not a known canonical block"),
    };
    if c.publication_deadline_ms != t_anchor + policy.max_control_publication_delay_ms {
        return rej("INVALID_FORMAT", "publication_deadline_ms must equal clock(anchor) + publication delay");
    }
    let now = tip_clock(engine);
    if now >= c.publication_deadline_ms {
        return rej("PUBLICATION_EXPIRED", "publication deadline has passed");
    }
    if c.action == ControlAction::Grant {
        let exp = c.expires_at_ms.expect("validated");
        if exp <= t_anchor || exp - t_anchor > policy.max_term_ms {
            return rej("INVALID_TERM", "expiry must be within (anchor, anchor + max term]");
        }
        if now >= exp {
            return rej("GRANT_EXPIRED", "grant already expired");
        }
    }
    let text = text::control_text(c, net).map_err(|e| Reject { code: "INVALID_FORMAT", detail: e.to_string() })?;
    if let Err(e) = adapter::verify_owner_signature(&c.owner_auth_adapter, net, &c.owner_lock, &text, &env.proof.signature) {
        return rej("INVALID_SIGNATURE", e.to_string());
    }
    let owner_id = c.owner_id();
    let has_history = engine.streams.contains_key(&(c.auth_policy_hash, owner_id));
    if engine.owner_balance(&owner_id) == 0 && !has_history {
        return rej("NOT_SPONSORED", "controls are sponsored for owners with a deposit or an existing authorization");
    }
    let id = c.authorization_id();
    Ok(Accepted {
        message_kind: "authorization_control",
        object_id: id,
        carrier_kind: Kind::AuthorizationBatch,
        scope_id: c.auth_policy_hash,
        publish_by_ms: Some(c.publication_deadline_ms),
        on_chain: engine
            .streams
            .get(&(c.auth_policy_hash, owner_id))
            .map(|s| s.history.iter().any(|e| e.authorization_id == id))
            .unwrap_or(false),
    })
}

fn check_record(engine: &Engine, env: &ProcessEnvelope) -> std::result::Result<Accepted, Reject> {
    let r = &env.body;
    if r.genesis != engine.network().genesis_hash {
        return rej("WRONG_NETWORK", "record for another network");
    }
    let (_, t_anchor) = match engine.block_clock(&r.anchor_block_hash) {
        Some(a) => a,
        None => return rej("ANCHOR_INVALID", "anchor is not a known canonical block"),
    };
    if r.publication_deadline_ms != t_anchor + engine.cfg.process_publication_delay_ms {
        return rej("INVALID_FORMAT", "publication_deadline_ms must equal clock(anchor) + process delay");
    }
    if tip_clock(engine) >= r.publication_deadline_ms {
        return rej("PUBLICATION_EXPIRED", "publication deadline has passed");
    }
    if engine.current_roles != Some(r.roles_hash) {
        return rej("ROLES_MISMATCH", "roles_hash is not the effective process roles");
    }
    let roles = &engine.roles_objects[&r.roles_hash].0;
    let members = roles.members(r.role);
    let text = text::process_text(r).map_err(|e| Reject { code: "INVALID_FORMAT", detail: e.to_string() })?;
    let mut valid = HashSet::new();
    for (key_id, proof) in &env.proofs {
        if let Some(k) = members.member(key_id) {
            if adapter::verify_key_signature(k, &text, &proof.signature).is_ok() {
                valid.insert(*key_id);
            }
        }
    }
    if (valid.len() as u64) < members.threshold {
        return rej("INVALID_SIGNATURE", format!("{} valid member signatures, threshold {}", valid.len(), members.threshold));
    }
    let id = r.record_id();
    Ok(Accepted {
        message_kind: "process_record",
        object_id: id,
        carrier_kind: Kind::ProcessBatch,
        scope_id: r.summary_target(),
        publish_by_ms: Some(r.publication_deadline_ms),
        on_chain: engine.records.iter().any(|x| x.record_id == id),
    })
}

fn check_manifest(engine: &Engine, store: &Store, p: &ManifestPayload) -> std::result::Result<Accepted, Reject> {
    let net = engine.network();
    let m = &p.manifest;
    if m.genesis != net.genesis_hash {
        return rej("WRONG_NETWORK", "manifest for another network");
    }
    let policy_hash = m.auth_policy_hash();
    if !engine.policies.contains_key(&policy_hash) && queued_policy(store, &policy_hash).is_none() {
        return rej("POLICY_UNPUBLISHED", "authorization policy must be published before the manifest");
    }
    if p.proposer_proofs.len() != m.proposer_owner_locks.len() {
        return rej("INVALID_SIGNATURE", "one proposer proof per proposer lock is required");
    }
    for (lock, proof) in m.proposer_owner_locks.iter().zip(&p.proposer_proofs) {
        if &proof.owner_lock != lock {
            return rej("INVALID_SIGNATURE", "proposer proofs must follow proposer_owner_locks order");
        }
        if !m.auth_registry.accepts_owner(&proof.auth_adapter) {
            return rej("ADAPTER_NOT_ACCEPTED", format!("proposer adapter {}", proof.auth_adapter));
        }
        let t = text::proposal_text(m, lock, net).map_err(|e| Reject { code: "INVALID_FORMAT", detail: e.to_string() })?;
        if let Err(e) = adapter::verify_owner_signature(&proof.auth_adapter, net, lock, &t, &proof.proof.signature) {
            return rej("INVALID_SIGNATURE", e.to_string());
        }
    }
    if tip_clock(engine) >= m.start_ms {
        return rej("LATE_MANIFEST", "start time has already passed");
    }
    let deposit: u128 = m.proposer_owner_locks.iter().map(|l| engine.owner_balance(&l.hash())).sum();
    if deposit < m.rules.proposer_min_deposit_shannon {
        return rej("NOT_SPONSORED", "proposer deposits are below the minimum");
    }
    let id = m.poll_id();
    Ok(Accepted {
        message_kind: "manifest",
        object_id: id,
        carrier_kind: Kind::Manifest,
        scope_id: id,
        publish_by_ms: Some(m.start_ms),
        on_chain: engine.polls.contains_key(&id),
    })
}

/// Classify a submitted JSON object and run the sponsorship pre-check.
fn precheck(engine: &Engine, store: &Store, v: &cj::Value) -> std::result::Result<Accepted, Reject> {
    let o = match v.as_object() {
        Some(o) => o,
        None => return rej("INVALID_FORMAT", "submission must be a JSON object"),
    };
    let fmt = |e: omavote_core::Error| Reject { code: "INVALID_FORMAT", detail: e.to_string() };
    if o.get("manifest").is_some() {
        return check_manifest(engine, store, &ManifestPayload::from_json(v).map_err(fmt)?);
    }
    if o.get("proofs").is_some() {
        return check_record(engine, &ProcessEnvelope::from_json(v).map_err(fmt)?);
    }
    if let Some(body) = o.get("body") {
        let kind = body.as_object().and_then(|b| b.get("message_kind")).and_then(|k| k.as_str()).unwrap_or("");
        return match kind {
            "ballot" => check_ballot(engine, store, &BallotEnvelope::from_json(v).map_err(fmt)?),
            "authorization_control" => check_control(engine, store, &ControlEnvelope::from_json(v).map_err(fmt)?),
            other => rej("INVALID_FORMAT", format!("unknown envelope message_kind {other:?}")),
        };
    }
    match o.get("message_kind").and_then(|k| k.as_str()) {
        Some("authorization_policy") => {
            let p = AuthPolicy::from_json(v).map_err(fmt)?;
            if p.genesis != engine.network().genesis_hash {
                return rej("WRONG_NETWORK", "policy for another network");
            }
            let h = p.hash();
            Ok(Accepted {
                message_kind: "authorization_policy",
                object_id: h,
                carrier_kind: Kind::AuthorizationPolicy,
                scope_id: h,
                publish_by_ms: None,
                on_chain: engine.policies.contains_key(&h),
            })
        }
        Some("process_roles") => {
            let r = ProcessRoles::from_json(v).map_err(fmt)?;
            if r.genesis != engine.network().genesis_hash {
                return rej("WRONG_NETWORK", "roles for another network");
            }
            let h = r.roles_hash();
            Ok(Accepted {
                message_kind: "process_roles",
                object_id: h,
                carrier_kind: Kind::ProcessRoles,
                scope_id: h,
                publish_by_ms: None,
                on_chain: engine.roles_objects.contains_key(&h),
            })
        }
        _ => rej("INVALID_FORMAT", "unrecognised submission"),
    }
}

pub enum SubmitOutcome {
    Accepted(Value),
    Rejected(Reject),
}

impl Intake {
    pub fn receipt_public_key(&self) -> String {
        to_hex(&self.receipt_key.pubkey)
    }

    /// Validate, deduplicate by `(message_kind, id)` and queue; returns the receipt.
    pub fn submit(&self, bytes: &[u8]) -> Result<SubmitOutcome> {
        let v = match parse(bytes) {
            Ok(v) => v,
            Err(e) => return Ok(SubmitOutcome::Rejected(Reject { code: "INVALID_FORMAT", detail: e.to_string() })),
        };
        let envelope = jcs_bytes(&v);
        if envelope.len() > carrier::MAX_WITNESS_BYTES {
            return Ok(SubmitOutcome::Rejected(Reject { code: "INVALID_FORMAT", detail: "submission exceeds 32 KiB".into() }));
        }
        let (acc, genesis) = {
            let st = read(&self.state);
            let acc = match precheck(&st.engine, &self.store, &v) {
                Ok(a) => a,
                Err(r) => return Ok(SubmitOutcome::Rejected(r)),
            };
            (acc, st.engine.network().genesis_hash)
        };
        if matches!(acc.carrier_kind, Kind::BallotBatch | Kind::AuthorizationBatch | Kind::ProcessBatch)
            && envelope.len() > carrier::MAX_ENVELOPE_BYTES
        {
            return Ok(SubmitOutcome::Rejected(Reject { code: "INVALID_FORMAT", detail: "envelope exceeds 8 KiB".into() }));
        }
        let object_id = to_hex(&acc.object_id);
        if let Some(existing) = self.store.relay_find(acc.message_kind, &object_id)? {
            return Ok(SubmitOutcome::Accepted(item_json(&existing, true)));
        }
        if acc.on_chain {
            return Ok(SubmitOutcome::Accepted(json!({
                "status": "ALREADY_ON_CHAIN",
                "message_kind": acc.message_kind,
                "object_id": object_id,
            })));
        }
        let envelope_hash = to_hex(&ckb_hash(&envelope));
        let received = now_ms();
        let body = cj::Value::Object(
            Object::new()
                .with("message_kind", cj::Value::str("relay_receipt"))
                .with("protocol_version", cj::Value::str(PROTOCOL_VERSION))
                .with("network_genesis_hash", cj::Value::str(to_hex(&genesis)))
                .with("relay_receipt_key", cj::Value::str(self.receipt_public_key()))
                .with("item_kind", cj::Value::str(acc.message_kind))
                .with("object_id", cj::Value::str(object_id.clone()))
                .with("envelope_hash", cj::Value::str(envelope_hash.clone()))
                .with("received_at_ms", cj::Value::str(dec(received)))
                .with("publish_by_ms", cj::Value::opt_str(acc.publish_by_ms.map(dec))),
        );
        let digest = domain_hash(domain::RELAY_RECEIPT, &jcs_bytes(&body));
        let sig = sign_digest_recoverable(self.receipt_key.secret(), &digest).map_err(|e| anyhow!("{e}"))?;
        let receipt = json!({"body": to_serde(&body), "signature": to_hex(&sig)});
        let envelope_text = String::from_utf8(envelope).expect("JCS is UTF-8");
        self.store.relay_insert(
            acc.message_kind,
            &object_id,
            acc.carrier_kind as u8,
            &to_hex(&acc.scope_id),
            &envelope_text,
            &envelope_hash,
            received,
            acc.publish_by_ms,
            &receipt.to_string(),
        )?;
        let item = self.store.relay_find(acc.message_kind, &object_id)?.ok_or_else(|| anyhow!("queued item vanished"))?;
        Ok(SubmitOutcome::Accepted(item_json(&item, false)))
    }
}

/// Owner of a queued ballot or control (None for other kinds).
pub fn item_owner(i: &RelayItem) -> Option<String> {
    let v = parse(i.envelope.as_bytes()).ok()?;
    let lock = v.as_object()?.get("body")?.as_object()?.get("owner_lock")?;
    Some(to_hex(&omavote_core::molecule::Script::from_json(lock).ok()?.hash()))
}

pub fn item_json(i: &RelayItem, duplicate: bool) -> Value {
    json!({
        "status": i.status,
        "duplicate": duplicate,
        "message_kind": i.message_kind,
        "object_id": i.object_id,
        "scope_id": i.scope_id,
        "owner_id": item_owner(i),
        "tx_hash": i.tx_hash,
        "block_number": i.block_number.map(dec),
        "block_hash": i.block_hash,
        "error": i.error,
        "received_ms": dec(i.received_ms),
        "envelope_hash": i.envelope_hash,
        "receipt": serde_json::from_str::<Value>(&i.receipt).unwrap_or(Value::Null),
    })
}

// ---------------------------------------------------------------------------
// Publisher

pub struct Publisher {
    pub rpc: Rpc,
    pub store: Arc<Store>,
    pub wallet: Wallet,
    pub net: NetworkParams,
    pub genesis: GenesisCells,
    pub cfg: RelayConfig,
    /// Indexed chain state when the publisher runs inside `serve`: queued objects
    /// that another relay already put on chain are not published again.
    pub state: Option<Shared>,
}

/// Where an object already appears on the canonical chain: `(tx_hash, height)`.
fn on_chain(engine: &Engine, item: &RelayItem) -> Option<(Option<Hash32>, u64)> {
    let id = crate::util::hash_arg(&item.object_id).ok()?;
    match item.message_kind.as_str() {
        "ballot" => {
            let poll = crate::util::hash_arg(&item.scope_id).ok()?;
            engine.polls.get(&poll)?.ballots.iter().find(|b| b.ballot_id == id).map(|b| (Some(b.tx_hash), b.position.height))
        }
        "authorization_control" => engine
            .streams
            .values()
            .flat_map(|s| s.history.iter())
            .find(|e| e.authorization_id == id)
            .map(|e| (Some(e.tx_hash), e.position.height)),
        "process_record" => engine.records.iter().find(|r| r.record_id == id).map(|r| (Some(r.tx_hash), r.position.height)),
        "manifest" => engine.polls.get(&id).map(|p| (Some(p.registered_tx), p.registered.height)),
        "authorization_policy" => engine.policies.get(&id).map(|(_, at)| (None, at.height)),
        "process_roles" => engine.roles_objects.get(&id).map(|(_, at)| (None, at.height)),
        _ => None,
    }
}

/// Carrier order inside one transaction: objects others depend on come first.
fn kind_priority(k: u8) -> u8 {
    match k {
        4 => 0, // authorization policy
        6 => 1, // process roles
        1 => 2, // manifest
        5 => 3, // authorization batch
        7 => 4, // process batch
        2 => 5, // ballot batch
        _ => 6,
    }
}

struct PlannedCarrier {
    kind: Kind,
    scope: Hash32,
    payload: Vec<u8>,
    item_ids: Vec<i64>,
}

fn plan_carriers(items: &[RelayItem]) -> Result<Vec<PlannedCarrier>> {
    let mut groups: BTreeMap<(u8, String), Vec<&RelayItem>> = BTreeMap::new();
    for i in items {
        groups.entry((kind_priority(i.carrier_kind), i.scope_id.clone())).or_default().push(i);
    }
    let mut out = Vec::new();
    for ((_, scope), group) in groups {
        let kind = Kind::from_byte(group[0].carrier_kind).map_err(|e| anyhow!("{e}"))?;
        let scope = crate::util::hash_arg(&scope)?;
        match kind {
            Kind::BallotBatch | Kind::AuthorizationBatch | Kind::ProcessBatch => {
                let mut batch: Vec<cj::Value> = Vec::new();
                let mut ids = Vec::new();
                for item in group {
                    let env = parse(item.envelope.as_bytes()).map_err(|e| anyhow!("{e}"))?;
                    let mut trial = batch.clone();
                    trial.push(env.clone());
                    let too_big = carrier::batch_payload(trial).len() > carrier::MAX_WITNESS_BYTES;
                    if !batch.is_empty() && (batch.len() >= carrier::MAX_ENVELOPES || too_big) {
                        out.push(PlannedCarrier {
                            kind,
                            scope,
                            payload: carrier::batch_payload(std::mem::take(&mut batch)),
                            item_ids: std::mem::take(&mut ids),
                        });
                    }
                    batch.push(env);
                    ids.push(item.id);
                }
                if !batch.is_empty() {
                    out.push(PlannedCarrier { kind, scope, payload: carrier::batch_payload(batch), item_ids: ids });
                }
            }
            _ => {
                for item in group {
                    out.push(PlannedCarrier { kind, scope, payload: item.envelope.clone().into_bytes(), item_ids: vec![item.id] });
                }
            }
        }
    }
    Ok(out)
}

impl Publisher {
    pub async fn run(self) {
        tracing::info!(address = %self.wallet.address(&self.net), "relay publisher started");
        loop {
            if let Err(e) = self.tick().await {
                tracing::warn!("relay: {e:#}");
            }
            tokio::time::sleep(Duration::from_millis(self.cfg.interval_ms)).await;
        }
    }

    pub async fn tick(&self) -> Result<()> {
        self.reconcile().await?;
        if !self.store.relay_txs_with_status(&["BROADCAST"])?.is_empty() {
            return Ok(()); // one transaction in flight at a time
        }
        self.publish().await
    }

    async fn block_number_of(&self, block_hash: &str) -> Result<u64> {
        let h = self.rpc.call("get_header", json!([block_hash])).await?;
        crate::chain::hex_u64(&h["number"])
    }

    async fn reconcile(&self) -> Result<()> {
        for t in self.store.relay_txs_with_status(&["BROADCAST"])? {
            let (status, block_hash) = self.rpc.tx_status(&t.tx_hash).await?;
            match status.as_str() {
                "committed" => {
                    let bh = block_hash.ok_or_else(|| anyhow!("committed without block hash"))?;
                    let n = self.block_number_of(&bh).await?;
                    self.store.relay_tx_update(&t.tx_hash, "INCLUDED", Some((n, &bh)))?;
                    self.store.relay_set_status(&t.item_ids, "INCLUDED", Some(&t.tx_hash), Some((n, &bh)), None)?;
                    tracing::info!(tx = %t.tx_hash, block = n, items = t.item_ids.len(), "relay transaction included");
                }
                "rejected" => {
                    self.store.relay_tx_update(&t.tx_hash, "FAILED", None)?;
                    self.store.relay_set_status(&t.item_ids, "RECEIVED", None, None, Some("transaction rejected by the node; retrying"))?;
                }
                "unknown" => {
                    // Dropped from the pool or removed by a reorg: resend the same transaction.
                    let raw: Value = serde_json::from_str(&t.raw)?;
                    if let Err(e) = self.rpc.send_transaction(raw).await {
                        tracing::warn!(tx = %t.tx_hash, "resend failed: {e:#}");
                        self.store.relay_tx_update(&t.tx_hash, "FAILED", None)?;
                        self.store.relay_set_status(&t.item_ids, "RECEIVED", None, None, Some("transaction lost; rebuilding"))?;
                    }
                }
                _ => {}
            }
        }
        let tip = self.rpc.tip_number().await?;
        for t in self.store.relay_txs_with_status(&["INCLUDED"])? {
            let (n, bh) = (t.block_number.unwrap_or(0), t.block_hash.clone().unwrap_or_default());
            let canonical = self.rpc.block_hash(n).await?;
            if canonical.as_deref() != Some(bh.as_str()) {
                tracing::warn!(tx = %t.tx_hash, block = n, "relay transaction left the canonical chain");
                self.store.relay_tx_update(&t.tx_hash, "BROADCAST", None)?;
                self.store.relay_set_status(&t.item_ids, "BROADCAST", Some(&t.tx_hash), None, None)?;
            } else if tip >= n + self.cfg.confirmations {
                self.store.relay_tx_update(&t.tx_hash, "CONFIRMED", Some((n, &bh)))?;
                self.store.relay_set_status(&t.item_ids, "CONFIRMED", Some(&t.tx_hash), Some((n, &bh)), None)?;
            }
        }
        Ok(())
    }

    /// Any helper may publish the same envelope (docs/03 §12). Objects already on the
    /// canonical chain are marked ALREADY_ON_CHAIN instead of being published twice,
    /// and go back to the queue if a reorg removes them.
    fn reconcile_foreign(&self) -> Result<()> {
        let state = match &self.state {
            Some(s) => s,
            None => return Ok(()),
        };
        let items = self.store.relay_with_status(&["RECEIVED", "ALREADY_ON_CHAIN"])?;
        let st = read(state);
        for item in items {
            match (on_chain(&st.engine, &item), item.status.as_str()) {
                (Some((tx, height)), "RECEIVED") => {
                    let block = st.hashes.get(&height).map(|h| to_hex(h));
                    let tx = tx.map(|t| to_hex(&t));
                    self.store.relay_set_status(
                        &[item.id],
                        "ALREADY_ON_CHAIN",
                        tx.as_deref(),
                        block.as_deref().map(|b| (height, b)),
                        Some("published on chain by another relay or helper"),
                    )?;
                    tracing::info!(object = %item.object_id, "already on chain; not publishing again");
                }
                (None, "ALREADY_ON_CHAIN") => {
                    self.store.relay_set_status(&[item.id], "RECEIVED", None, None, Some("left the canonical chain; queued again"))?;
                }
                _ => {}
            }
        }
        Ok(())
    }

    async fn publish(&self) -> Result<()> {
        self.reconcile_foreign()?;
        let mut items = self.store.relay_with_status(&["RECEIVED"])?;
        if items.is_empty() {
            return Ok(());
        }
        let tip = self.rpc.tip_number().await?;
        let tip_hash = self.rpc.block_hash(tip).await?.ok_or_else(|| anyhow!("no tip hash"))?;
        // clock(next block) = median time ending at the current tip.
        let next_clock = self.rpc.median_time(&tip_hash).await?;
        let (expired, live): (Vec<RelayItem>, Vec<RelayItem>) =
            items.drain(..).partition(|i| i.publish_by_ms.map(|d| next_clock >= d).unwrap_or(false));
        if !expired.is_empty() {
            let ids: Vec<i64> = expired.iter().map(|i| i.id).collect();
            self.store.relay_set_status(&ids, "EXPIRED", None, None, Some("publication deadline passed before inclusion"))?;
        }
        if live.is_empty() {
            return Ok(());
        }
        let mut carriers = plan_carriers(&live)?;
        carriers.truncate(self.cfg.max_carriers_per_tx.max(1));
        let busy: HashSet<String> =
            self.store.relay_txs_with_status(&["BROADCAST", "INCLUDED"])?.into_iter().flat_map(|t| t.inputs).collect();
        let cells: Vec<LiveCell> = txbuilder::live_cells(&self.rpc, &self.wallet.lock)
            .await?
            .into_iter()
            .filter(|c| c.spendable_by_relay() && !busy.contains(&op_key(&c.out_point)))
            .collect();
        let plan = TxPlan {
            cell_deps: vec![self.genesis.secp_dep_group.clone()],
            carriers: carriers.iter().map(|c| (c.kind, c.scope, c.payload.clone())).collect(),
            ..Default::default()
        };
        let built = txbuilder::build(&plan, &self.wallet, cells, &[], self.cfg.fee_rate)?;
        let raw = txbuilder::tx_to_rpc(&built.tx);
        let hash = self.rpc.send_transaction(raw.clone()).await?;
        if hash != to_hex(&built.hash) {
            tracing::warn!("node returned tx hash {hash}, computed {}", to_hex(&built.hash));
        }
        let item_ids: Vec<i64> = carriers.iter().flat_map(|c| c.item_ids.clone()).collect();
        self.store.relay_tx_insert(&RelayTx {
            tx_hash: hash.clone(),
            raw: raw.to_string(),
            status: "BROADCAST".into(),
            created_ms: now_ms(),
            block_number: None,
            block_hash: None,
            item_ids: item_ids.clone(),
            inputs: built.inputs.iter().map(op_key).collect(),
        })?;
        self.store.relay_set_status(&item_ids, "BROADCAST", Some(&hash), None, None)?;
        tracing::info!(tx = %hash, carriers = carriers.len(), items = item_ids.len(), fee = built.fee, "relay transaction broadcast");
        Ok(())
    }
}

fn op_key(op: &OutPoint) -> String {
    format!("{}:{}", to_hex(&op.tx_hash), op.index)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verify a receipt signature and return the signer's compressed public key.
    fn verify_receipt(receipt: &Value) -> Result<String> {
        let body = crate::util::from_serde(&receipt["body"])?;
        let sig = omavote_core::util::parse_hex_fixed::<65>(receipt["signature"].as_str().unwrap_or(""), "signature")
            .map_err(|e| anyhow!("{e}"))?;
        let digest = domain_hash(domain::RELAY_RECEIPT, &jcs_bytes(&body));
        let pk = adapter::recover_digest(&digest, &sig).map_err(|e| anyhow!("{e}"))?;
        Ok(to_hex(&pk))
    }

    use omavote_core::testkit::{TestChain, TestKey, TestOwner};
    use omavote_core::types::RulesParams;

    fn intake_with(chain: &TestChain) -> Intake {
        let mut cfg = crate::sync::SyncConfig::new(chain.engine.cfg.clone());
        cfg.snapshot_every = 0;
        let state = crate::sync::ChainState::new(&cfg);
        let shared: Shared = Arc::new(std::sync::RwLock::new(state));
        crate::sync::write(&shared).engine = chain.engine.clone();
        Intake {
            store: Arc::new(Store::in_memory().unwrap()),
            state: shared,
            receipt_key: Wallet::from_secret(adapter::test_secret("receipt"), &chain.net).unwrap(),
        }
    }

    fn submit(i: &Intake, v: &cj::Value) -> std::result::Result<Value, Reject> {
        match i.submit(&jcs_bytes(v)).unwrap() {
            SubmitOutcome::Accepted(v) => Ok(v),
            SubmitOutcome::Rejected(r) => Err(r),
        }
    }

    #[test]
    fn intake_checks_signatures_dedups_and_signs_receipts() {
        let mut c = TestChain::new(1_800_000_000_000);
        let alice = TestOwner::ckb("alice", &c.net);
        c.deposit(&alice.lock, 200_000);
        c.publish_policy();
        c.mine(3_600_000);
        let start = c.clock_ms + 200 * 60_000;
        let p = c.manifest(&[&alice], start, TestChain::default_registry(), RulesParams::default(), 1000);
        c.publish_manifest(&p);
        c.mine_n(210, 60_000);
        let anchor = c.tip_hash;
        let env = c.direct_ballot(&p.manifest, &alice, Action::Yes, anchor);
        let intake = intake_with(&c);

        let r = submit(&intake, &env.to_json()).unwrap();
        assert_eq!(r["status"], "RECEIVED");
        assert_eq!(r["duplicate"], false);
        assert_eq!(verify_receipt(&r["receipt"]).unwrap(), intake.receipt_public_key());
        let again = submit(&intake, &env.to_json()).unwrap();
        assert_eq!(again["duplicate"], true);

        // A forged signature cannot occupy a ballot id.
        let bob = TestOwner::ckb("bob", &c.net);
        let env_b = c.direct_ballot(&p.manifest, &bob, Action::No, anchor);
        let mut wrong = env_b.clone();
        wrong.proof = env.proof.clone();
        assert_eq!(submit(&intake, &wrong.to_json()).unwrap_err().code, "INVALID_SIGNATURE");
        // Bob has no deposit: YES/NO are not sponsored.
        assert_eq!(submit(&intake, &env_b.to_json()).unwrap_err().code, "NO_DEPOSIT_AT_CAST");

        // Delegate ballot whose grant is still queued in this relay.
        let k = TestKey::evm("k");
        let g = c.grant(&alice, &k, 30 * 86_400_000, anchor);
        assert_eq!(submit(&intake, &g.to_json()).unwrap()["status"], "RECEIVED");
        let d = c.delegate_ballot(&p.manifest, &alice, &g, &k, Action::No, anchor);
        assert_eq!(submit(&intake, &d.to_json()).unwrap()["status"], "RECEIVED");
        let items = intake.store.relay_with_status(&["RECEIVED"]).unwrap();
        let planned = plan_carriers(&items).unwrap();
        assert_eq!(planned.len(), 2);
        assert_eq!(planned[0].kind, Kind::AuthorizationBatch, "grants are placed before ballots");
        assert_eq!(planned[1].kind, Kind::BallotBatch);
        assert_eq!(planned[1].item_ids.len(), 2);
    }
}
