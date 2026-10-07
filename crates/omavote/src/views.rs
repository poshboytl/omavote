//! JSON views over the replay state: API responses and evidence bundles
//! (docs/03 §10–§12). Views are cached interpretations, never protocol facts.

use std::collections::BTreeMap;

use anyhow::{anyhow, Result};
use omavote_core::engine::{BallotAppearance, Diagnostic, Engine, GrantInfo, PollState, Position, RecordAppearance};
use omavote_core::messages::{short_id, Authority, ControlAction};
use omavote_core::tally::{
    self, admission, attestation, governance, proposer_eligible, AdmissionView, AttestationView, FinalStatus, GovernanceView,
    ResultCore, Selection,
};
use omavote_core::util::{to_hex, Hash32};
use serde_json::{json, Value};

use crate::util::{dec, to_serde};

pub fn pos(p: &Position) -> Value {
    json!({"height": dec(p.height), "tx_index": dec(p.tx_index), "output_index": dec(p.output_index), "envelope_index": dec(p.envelope_index)})
}

fn hx(h: &Hash32) -> Value {
    Value::String(to_hex(h))
}

fn opt_hx(h: &Option<Hash32>) -> Value {
    h.as_ref().map(hx).unwrap_or(Value::Null)
}

/// Height and hash every response is computed at.
pub fn at(engine: &Engine) -> Value {
    match engine.tip {
        Some((n, h, c)) => json!({"number": dec(n), "hash": to_hex(&h), "clock_ms": dec(c)}),
        None => Value::Null,
    }
}

pub fn diag(d: &Diagnostic) -> Value {
    json!({
        "position": pos(&d.position),
        "tx_hash": to_hex(&d.tx_hash),
        "kind": d.kind,
        "id": opt_hx(&d.id),
        "poll_id": opt_hx(&d.poll_id),
        "owner_id": opt_hx(&d.owner_id),
        "code": d.code,
        "detail": d.detail,
    })
}

pub fn admission_json(v: &AdmissionView) -> Value {
    match v {
        AdmissionView::Pending => json!({"state": "PENDING"}),
        AdmissionView::Admitted(id) => json!({"state": "ADMITTED", "record_id": to_hex(id)}),
        AdmissionView::Rejected(id) => json!({"state": "REJECTED", "record_id": to_hex(id)}),
        AdmissionView::Missing => json!({"state": "MISSING"}),
        AdmissionView::Conflict => json!({"state": "RECORD_CONFLICT"}),
    }
}

pub fn governance_json(v: &GovernanceView) -> Value {
    match v {
        GovernanceView::None => json!({"state": "NONE"}),
        GovernanceView::Status(s, id) => json!({"state": s.as_str(), "record_id": to_hex(id)}),
        GovernanceView::Conflict => json!({"state": "RECORD_CONFLICT", "effective": "HOLD_EXECUTION"}),
    }
}

pub fn attestation_json(v: &AttestationView) -> Value {
    match v {
        AttestationView::None => json!({"state": "NONE"}),
        AttestationView::Confirmed(id) => json!({"state": "CONFIRMED", "record_id": to_hex(id)}),
        AttestationView::Disputed(why) => json!({"state": "DISPUTED", "detail": why}),
        AttestationView::Conflict => json!({"state": "RECORD_CONFLICT"}),
    }
}

/// Lifecycle state per docs/03 §10 (operator view; never part of result_core).
pub fn poll_status(engine: &Engine, poll: &PollState, rc: Option<&ResultCore>) -> &'static str {
    if poll.late_manifest {
        return "LATE_MANIFEST";
    }
    let close = match (&poll.start_boundary, &poll.close) {
        (None, _) => return "ANNOUNCED",
        (Some(_), None) => return "OPEN",
        (Some(_), Some(c)) => c,
    };
    let poll_id = poll.manifest.poll_id();
    if engine
        .records
        .iter()
        .any(|r| r.poll_id == Some(poll_id) && r.record_type == omavote_core::messages::RecordType::Execution)
    {
        return "EXECUTED";
    }
    if let AttestationView::Disputed(_) | AttestationView::Conflict = attestation(engine, &poll_id, rc) {
        return "DISPUTED";
    }
    let (tip_n, _, tip_clock) = engine.tip.expect("closed poll implies a tip");
    if tip_n.saturating_sub(close.number) < poll.manifest.confirmation.result_confirmations {
        return "CLOSED_UNCONFIRMED";
    }
    if tip_clock >= poll.manifest.end_ms.saturating_add(poll.manifest.confirmation.review_window_ms) {
        "FINALIZED_BY_POLICY"
    } else {
        "AUDITABLE"
    }
}

fn selection_map(engine: &Engine, poll: &PollState) -> BTreeMap<Hash32, Selection> {
    tally::select(engine, poll).into_iter().map(|s| (s.owner_id, s)).collect()
}

/// Per-appearance status relative to the owner's current final selection.
fn ballot_status(engine: &Engine, poll: &PollState, b: &BallotAppearance, sel: Option<&Selection>) -> &'static str {
    let sel = match sel {
        Some(s) => s,
        None => return "UNKNOWN",
    };
    if sel.ballot_id == Some(b.ballot_id) {
        return "SELECTED";
    }
    match sel.status {
        FinalStatus::Conflict => "CONFLICT",
        FinalStatus::CancelledByControl => "CANCELLED_BY_CONTROL",
        _ => {
            if b.authority == Authority::Delegate && sel.authority == Some(Authority::Owner) {
                return "OVERRIDDEN_BY_OWNER";
            }
            if b.authority == Authority::Delegate {
                let m = &poll.manifest;
                let barred = engine
                    .streams
                    .get(&(m.auth_policy_hash(), b.owner_id))
                    .map(|s| {
                        s.barriers
                            .iter()
                            .any(|bar| bar.clock_ms >= m.start_ms && bar.clock_ms < m.end_ms && b.position <= bar.position)
                    })
                    .unwrap_or(false);
                if barred {
                    return "CANCELLED_BY_CONTROL";
                }
            }
            "SUPERSEDED"
        }
    }
}

pub fn ballot_json(b: &BallotAppearance, status: &str) -> Value {
    json!({
        "ballot_id": to_hex(&b.ballot_id),
        "owner_id": to_hex(&b.owner_id),
        "authority": match b.authority { Authority::Owner => "owner", Authority::Delegate => "delegate" },
        "authorization_id": opt_hx(&b.authorization_id),
        "action": b.action.as_str(),
        "anchor_height": dec(b.anchor_height),
        "grant_anchor_height": dec(b.grant_anchor_height),
        "position": pos(&b.position),
        "tx_hash": to_hex(&b.tx_hash),
        "status": status,
        "envelope": to_serde(&b.envelope.to_json()),
    })
}

pub fn poll_ballots(engine: &Engine, poll: &PollState) -> Vec<Value> {
    let sels = selection_map(engine, poll);
    poll.ballots.iter().map(|b| ballot_json(b, ballot_status(engine, poll, b, sels.get(&b.owner_id)))).collect()
}

pub fn rejected_for_poll(engine: &Engine, poll_id: &Hash32) -> Vec<Value> {
    engine.diagnostics.iter().filter(|d| d.poll_id.as_ref() == Some(poll_id)).map(diag).collect()
}

pub fn record_json(r: &RecordAppearance) -> Value {
    json!({
        "record_id": to_hex(&r.record_id),
        "record_type": r.record_type.as_str(),
        "poll_id": opt_hx(&r.poll_id),
        "detail": to_serde(&r.detail.to_json()),
        "anchor_height": dec(r.anchor_height),
        "position": pos(&r.position),
        "tx_hash": to_hex(&r.tx_hash),
        "signers": r.signers.iter().map(hx).collect::<Vec<_>>(),
        "envelope": to_serde(&r.envelope.to_json()),
    })
}

pub fn grant_state(engine: &Engine, g: &GrantInfo) -> &'static str {
    let stream = engine.streams.get(&(g.policy_hash, g.owner_id));
    if stream.map(|s| s.current == Some(g.authorization_id)).unwrap_or(false) {
        match engine.tip {
            Some((_, _, clock)) if clock >= g.expires_at_ms => "EXPIRED",
            _ => "CURRENT",
        }
    } else if stream.map(|s| s.conflict).unwrap_or(false) {
        "CONFLICT_OR_REPLACED"
    } else {
        "NOT_CURRENT"
    }
}

pub fn grant_json(engine: &Engine, g: &GrantInfo) -> Value {
    json!({
        "authorization_id": to_hex(&g.authorization_id),
        "policy_hash": to_hex(&g.policy_hash),
        "owner_id": to_hex(&g.owner_id),
        "owner_adapter": g.owner_adapter,
        "key_descriptor": to_serde(&g.key.to_json()),
        "key_id": to_hex(&g.key_id),
        "expires_at_ms": dec(g.expires_at_ms),
        "position": pos(&g.position),
        "anchor_height": dec(g.anchor_height),
        "cancels_open": g.cancels_open,
        "state": grant_state(engine, g),
    })
}

/// Control stream of one owner under one policy, with full signed history.
pub fn stream_json(engine: &Engine, policy: &Hash32, owner_id: &Hash32) -> Value {
    let s = match engine.streams.get(&(*policy, *owner_id)) {
        Some(s) => s,
        None => return json!({"policy_hash": to_hex(policy), "owner_id": to_hex(owner_id), "current": null, "history": []}),
    };
    let current = s.current.and_then(|id| engine.grants.get(&id)).map(|g| grant_json(engine, g));
    json!({
        "policy_hash": to_hex(policy),
        "owner_id": to_hex(owner_id),
        "owner_lock": s.owner_lock.as_ref().map(|l| to_serde(&l.to_json())),
        "max_anchor_height": s.a_max.map(dec),
        "conflict": s.conflict,
        "current": current,
        "barriers": s.barriers.iter().map(|b| json!({"position": pos(&b.position), "clock_ms": dec(b.clock_ms)})).collect::<Vec<_>>(),
        "history": s.history.iter().map(|e| json!({
            "authorization_id": to_hex(&e.authorization_id),
            "action": match e.action { ControlAction::Grant => "GRANT", ControlAction::Revoke => "REVOKE" },
            "anchor_height": dec(e.anchor_height),
            "position": pos(&e.position),
            "tx_hash": to_hex(&e.tx_hash),
            "outcome": e.outcome,
            "envelope": to_serde(&e.envelope.to_json()),
        })).collect::<Vec<_>>(),
    })
}

pub fn owner_power(engine: &Engine, owner_id: &Hash32) -> Value {
    let lock = engine.owner_locks.get(owner_id);
    let deposits = engine.owner_deposits(owner_id);
    let total: u128 = deposits.iter().map(|(_, c)| *c as u128).sum();
    json!({
        "owner_id": to_hex(owner_id),
        "owner_lock": lock.map(|l| to_serde(&l.to_json())),
        "address": lock.and_then(|l| engine.network().address(l).ok()),
        "total_shannon": dec(total),
        "deposits": deposits.iter().map(|(op, cap)| json!({
            "tx_hash": to_hex(&op.tx_hash),
            "index": dec(op.index),
            "capacity_shannon": dec(*cap),
            "created": engine.dao_cells.get(op).map(|c| pos(&c.created)),
        })).collect::<Vec<_>>(),
    })
}

fn tally_json(t: &tally::Tally, kind: &str) -> Value {
    json!({
        "kind": kind,
        "yes_shannon": dec(t.yes),
        "no_shannon": dec(t.no),
        "participation_shannon": dec(t.yes + t.no),
        "quorum_required_shannon": dec(t.quorum_required),
        "outcome": if t.passed { "PASS" } else { "FAIL" },
        "owners": t.rows.len().to_string(),
    })
}

pub fn poll_summary(engine: &Engine, poll: &PollState) -> Value {
    let m = &poll.manifest;
    let poll_id = m.poll_id();
    let rc = tally::result_core(engine, &poll_id).ok().flatten();
    let status = poll_status(engine, poll, rc.as_ref());
    let tally = match (&rc, status) {
        (Some(rc), _) => {
            let mut t = tally_json(&rc.tally, "FINAL");
            t["result_hash"] = Value::String(to_hex(&rc.result_hash()));
            t
        }
        (None, "OPEN") => {
            // Diagnostic preview with current deposits: never an official outcome.
            let t = tally::tally_with(engine, poll, &|o| engine.owner_deposits(o));
            let mut v = tally_json(&t, "PROVISIONAL");
            v["note"] = json!("current deposits at the indexed tip; not a result");
            v
        }
        _ => Value::Null,
    };
    json!({
        "poll_id": to_hex(&poll_id),
        "short_id": short_id(&poll_id),
        "title": m.title,
        "signing_title": m.signing_title,
        "proposal_type": m.proposal_type.as_str(),
        "budget_ckb_shannon": dec(m.budget_ckb_shannon),
        "start_ms": dec(m.start_ms),
        "end_ms": dec(m.end_ms),
        "delegate_end_ms": dec(m.delegate_end_ms()),
        "status": status,
        "registered": {"position": pos(&poll.registered), "tx_hash": to_hex(&poll.registered_tx)},
        "late_manifest": poll.late_manifest,
        "proposer_deposit_shannon": dec(poll.proposer_deposit_shannon),
        "proposer_eligible": proposer_eligible(poll),
        "admission": admission_json(&admission(engine, poll)),
        "governance": governance_json(&governance(engine, &poll_id)),
        "attestation": attestation_json(&attestation(engine, &poll_id, rc.as_ref())),
        "ballot_count": poll.ballots.len().to_string(),
        "tally": tally,
    })
}

pub fn poll_detail(engine: &Engine, poll: &PollState) -> Value {
    let m = &poll.manifest;
    let poll_id = m.poll_id();
    let mut v = poll_summary(engine, poll);
    let rc = tally::result_core(engine, &poll_id).ok().flatten();
    v["manifest_payload"] = to_serde(&poll.payload.to_json());
    v["hashes"] = json!({
        "poll_id": to_hex(&poll_id),
        "rules_hash": to_hex(&m.rules_hash()),
        "auth_policy_hash": to_hex(&m.auth_policy_hash()),
        "auth_registry_hash": to_hex(&m.auth_registry_hash()),
        "content_hash": to_hex(&m.content_hash),
    });
    v["start_boundary"] = poll.start_boundary.map(|(n, h)| json!({"number": dec(n), "hash": to_hex(&h)})).unwrap_or(Value::Null);
    v["close"] = poll.close.as_ref().map(|c| json!({"number": dec(c.number), "hash": to_hex(&c.hash)})).unwrap_or(Value::Null);
    v["result_core"] = rc.as_ref().map(|r| to_serde(&r.value)).unwrap_or(Value::Null);
    v["result_hash"] = rc.as_ref().map(|r| Value::String(to_hex(&r.result_hash()))).unwrap_or(Value::Null);
    v["records"] = Value::Array(records_for_poll(engine, &poll_id));
    v
}

pub fn records_for_poll(engine: &Engine, poll_id: &Hash32) -> Vec<Value> {
    engine.records.iter().filter(|r| r.poll_id.as_ref() == Some(poll_id)).map(record_json).collect()
}

pub struct BundleMeta {
    pub mode: String,
    pub generated_at_ms: u64,
}

/// Evidence bundle for one poll (docs/03 §11).
pub fn bundle(engine: &Engine, poll_id: &Hash32, meta: &BundleMeta) -> Result<Value> {
    let poll = engine.polls.get(poll_id).ok_or_else(|| anyhow!("unknown poll"))?;
    let m = &poll.manifest;
    let policy_hash = m.auth_policy_hash();
    let rc = tally::result_core(engine, poll_id).map_err(crate::util::core_err)?;
    let owners: Vec<Hash32> = poll.owner_locks.keys().copied().collect();
    let close_cells = poll.close.as_ref().map(|c| {
        owners
            .iter()
            .map(|o| {
                let cells = c.cells.get(o).cloned().unwrap_or_default();
                json!({
                    "owner_id": to_hex(o),
                    "owner_lock": to_serde(&poll.owner_locks[o].to_json()),
                    "cells": cells.iter().map(|(op, cap)| json!({
                        "tx_hash": to_hex(&op.tx_hash),
                        "index": dec(op.index),
                        "capacity_shannon": dec(*cap),
                        "created": c.created.get(op).map(pos),
                    })).collect::<Vec<_>>(),
                })
            })
            .collect::<Vec<_>>()
    });
    let policy = engine.policies.get(&policy_hash).map(|(p, at)| json!({"object": to_serde(p.to_json()), "position": pos(at)}));
    let roles: Vec<Value> = engine
        .roles_objects
        .iter()
        .map(|(h, (r, at))| json!({"roles_hash": to_hex(h), "object": to_serde(r.to_json()), "position": pos(at)}))
        .collect();
    let owner_ids: std::collections::BTreeSet<Hash32> = owners.iter().copied().collect();
    let diagnostics: Vec<Value> = engine
        .diagnostics
        .iter()
        .filter(|d| d.poll_id.as_ref() == Some(poll_id) || d.owner_id.map(|o| owner_ids.contains(&o)).unwrap_or(false))
        .map(diag)
        .collect();
    let result_records: Vec<Value> = engine
        .result_records
        .iter()
        .map(|(p, tx, v)| json!({"position": pos(p), "tx_hash": to_hex(tx), "record": to_serde(v)}))
        .filter(|v| v["record"]["poll_id"].as_str() == Some(&to_hex(poll_id)))
        .collect();
    Ok(json!({
        "bundle_version": "1",
        "verifier": {
            "name": "omavote",
            "version": env!("CARGO_PKG_VERSION"),
            "mode": meta.mode,
            "generated_at_ms": dec(meta.generated_at_ms),
            "tip": at(engine),
            "replay_from_height": "0",
        },
        "network": to_serde(&engine.network().to_json()),
        "initial_roles_hash": opt_hx(&engine.cfg.initial_roles_hash),
        "process_publication_delay_ms": dec(engine.cfg.process_publication_delay_ms),
        "poll": poll_detail(engine, poll),
        "authorization_policy": policy,
        "roles": {"objects": roles, "history": engine.roles_history.iter().map(|(p, h)| json!({"position": pos(p), "roles_hash": to_hex(h)})).collect::<Vec<_>>()},
        "ballots": poll_ballots(engine, poll),
        "controls": owners.iter().map(|o| stream_json(engine, &policy_hash, o)).collect::<Vec<_>>(),
        "close_deposits": close_cells,
        "result_records": result_records,
        "diagnostics": diagnostics,
        "result_core": rc.as_ref().map(|r| to_serde(&r.value)),
        "result_hash": rc.as_ref().map(|r| to_hex(&r.result_hash())),
    }))
}
