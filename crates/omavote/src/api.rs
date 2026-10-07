//! Public read API, envelope intake and Atom feeds (docs/03 §12). Every response is
//! a cached view computed at the reported block (`at`), never a protocol fact.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use omavote_core::address::parse_full_address;
use omavote_core::engine::Engine;
use omavote_core::messages::short_id;
use omavote_core::molecule::Script;
use omavote_core::network::NetworkParams;
use omavote_core::tally;
use omavote_core::types::{AuthPolicy, AuthRegistry, RulesParams, RulesProfile, MAX_CONTROL_PUBLICATION_DELAY_MS};
use omavote_core::util::{to_hex, utc_ms, Hash32};
use serde::Deserialize;
use serde_json::{json, Value};
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;

use crate::chain::{script_to_rpc, GenesisCells};
use crate::relay::{item_json, Intake, SubmitOutcome};
use crate::rpc::Rpc;
use crate::store::Store;
use crate::sync::{read, ChainState, Shared};
use crate::util::{dec, hash_arg, now_ms, to_serde};
use crate::views;

pub struct ServerInfo {
    pub rpc: Rpc,
    pub network: NetworkParams,
    pub genesis: GenesisCells,
    pub anchor_depth: u64,
    pub relay_lock: Option<Script>,
}

#[derive(Clone)]
pub struct AppState {
    pub chain: Shared,
    pub store: Arc<Store>,
    pub intake: Option<Arc<Intake>>,
    pub info: Arc<ServerInfo>,
}

fn ok(v: Value) -> Response {
    Json(v).into_response()
}

fn err(status: StatusCode, code: &str, detail: impl std::fmt::Display) -> Response {
    (status, Json(json!({"error": {"code": code, "detail": detail.to_string()}}))).into_response()
}

fn bad(detail: impl std::fmt::Display) -> Response {
    err(StatusCode::BAD_REQUEST, "BAD_REQUEST", detail)
}

fn not_found(what: &str) -> Response {
    err(StatusCode::NOT_FOUND, "NOT_FOUND", format!("{what} not found"))
}

fn id_param(s: &str) -> Result<Hash32, Response> {
    hash_arg(s).map_err(|_| bad("expected a 0x-prefixed 32-byte hex id"))
}

fn with_at(engine: &Engine, mut v: Value) -> Value {
    v["at"] = views::at(engine);
    v
}

pub fn router(state: AppState, web_root: Option<std::path::PathBuf>, cors_origins: &[String]) -> Router {
    let api = Router::new()
        .route("/api/status", get(status))
        .route("/api/network", get(network))
        .route("/api/anchor", get(anchor))
        .route("/api/proposals", get(proposals))
        .route("/api/proposals/{id}", get(proposal))
        .route("/api/proposals/{id}/ballots", get(proposal_ballots))
        .route("/api/proposals/{id}/records", get(proposal_records))
        .route("/api/results/{id}/bundle", get(bundle))
        .route("/api/owners/{id}/power", get(owner_power))
        .route("/api/owners/{id}/authorizations", get(owner_authorizations))
        .route("/api/owners/{id}/ballots", get(owner_ballots))
        .route("/api/owners/{id}/feed.atom", get(owner_feed))
        .route("/api/address/{address}", get(address))
        .route("/api/authorizations/{id}", get(authorization))
        .route("/api/keys/{id}/authorizations", get(key_authorizations))
        .route("/api/receipts/{id}", get(receipts))
        .route("/api/diagnostics", get(diagnostics))
        .route("/api/envelopes", post(envelopes))
        .route("/api/core/{method}", post(core_call))
        .route("/feed.atom", get(global_feed))
        .with_state(state);
    let mut app = match web_root {
        Some(root) => {
            let index = root.join("index.html");
            api.fallback_service(ServeDir::new(root).fallback(ServeFile::new(index)))
        }
        None => api,
    };
    // Strict CSP for the bundled frontend (no third-party scripts or analytics).
    app = app
        .layer(SetResponseHeaderLayer::overriding(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(
                "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
            ),
        ))
        .layer(SetResponseHeaderLayer::overriding(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")))
        .layer(SetResponseHeaderLayer::overriding(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer")));
    if !cors_origins.is_empty() {
        let origins: Vec<HeaderValue> = cors_origins.iter().filter_map(|o| HeaderValue::from_str(o).ok()).collect();
        app = app.layer(
            CorsLayer::new()
                .allow_origin(AllowOrigin::list(origins))
                .allow_methods([axum::http::Method::GET, axum::http::Method::POST])
                .allow_headers([header::CONTENT_TYPE]),
        );
    }
    app
}

// ---------------------------------------------------------------------------

async fn status(State(s): State<AppState>) -> Response {
    let (mut v, tip_n) = {
        let st = read(&s.chain);
        let tip_n = st.tip().map(|t| t.0);
        let last_reorg = st.reorgs.last().map(|r| {
            json!({"at_ms": dec(r.at_ms), "old_tip": dec(r.old_tip), "fork_height": dec(r.fork_height), "depth": dec(r.depth)})
        });
        (
            json!({
                "version": env!("CARGO_PKG_VERSION"),
                "network": {"name": st.engine.network().name, "genesis_hash": to_hex(&st.engine.network().genesis_hash)},
                "indexed": views::at(&st.engine),
                "node_tip": st.node_tip.map(dec),
                "synced": st.synced,
                "last_sync_ms": dec(st.last_sync_ms),
                "last_error": st.last_error,
                "reorgs": {"count": st.reorgs.len().to_string(), "last": last_reorg},
                "polls": st.engine.polls.len().to_string(),
                "diagnostics": st.engine.diagnostics.len().to_string(),
            }),
            tip_n,
        )
    };
    v["lag_blocks"] = match (v["node_tip"].as_str().and_then(|x| x.parse::<u64>().ok()), tip_n) {
        (Some(n), Some(t)) => json!(dec(n.saturating_sub(t))),
        _ => Value::Null,
    };
    let counts = s.store.relay_counts().unwrap_or_default();
    let mut relay = json!({
        "intake": s.intake.is_some(),
        "receipt_key": s.intake.as_ref().map(|i| i.receipt_public_key()),
        "queue": counts.into_iter().map(|(k, n)| (k, json!(n.to_string()))).collect::<serde_json::Map<_, _>>(),
    });
    if let Some(lock) = &s.info.relay_lock {
        relay["address"] = json!(s.info.network.address(lock).ok());
        let cap = s
            .info
            .rpc
            .call("get_cells_capacity", json!([{"script": script_to_rpc(lock), "script_type": "lock", "script_search_mode": "exact"}]))
            .await;
        relay["balance_shannon"] = match cap {
            Ok(c) => c["capacity"].as_str().and_then(|h| u64::from_str_radix(h.trim_start_matches("0x"), 16).ok()).map(dec).into(),
            Err(_) => Value::Null,
        };
    }
    v["relay"] = relay;
    ok(v)
}

async fn network(State(s): State<AppState>) -> Response {
    let st = read(&s.chain);
    let e = &st.engine;
    let net = e.network();
    let policy = AuthPolicy::build(net.genesis_hash);
    let ph = policy.hash();
    let registry = AuthRegistry::new(
        vec![omavote_core::adapter::CKB_SECP256K1_MESSAGE_V1.into(), omavote_core::adapter::EVM_PERSONAL_MESSAGE_V1.into()],
        vec![omavote_core::adapter::CKB_SECP256K1_MESSAGE_V1.into(), omavote_core::adapter::EVM_PERSONAL_MESSAGE_V1.into()],
    );
    let rules = RulesProfile::build(&RulesParams::default());
    let roles = e.current_roles.map(|h| json!({"roles_hash": to_hex(&h), "object": to_serde(e.roles_objects[&h].0.to_json())}));
    ok(with_at(
        e,
        json!({
            "network": to_serde(&net.to_json()),
            "genesis_cells": {
                "secp256k1_dep_group": crate::chain::out_point_to_rpc(&s.info.genesis.secp_dep_group.out_point),
                "dao_code": crate::chain::out_point_to_rpc(&s.info.genesis.dao_code.out_point),
            },
            "authorization_policy": {
                "object": to_serde(policy.to_json()),
                "hash": to_hex(&ph),
                "published": e.policies.get(&ph).map(|(_, p)| views::pos(p)),
            },
            "default_registry": {"object": to_serde(&registry.to_json()), "hash": to_hex(&registry.hash())},
            "default_rules": {"object": to_serde(rules.to_json()), "hash": to_hex(&rules.hash())},
            "initial_roles_hash": e.cfg.initial_roles_hash.map(|h| to_hex(&h)),
            "current_roles": roles,
            "process_publication_delay_ms": dec(e.cfg.process_publication_delay_ms),
            "max_control_publication_delay_ms": dec(MAX_CONTROL_PUBLICATION_DELAY_MS),
            "receipt_key": s.intake.as_ref().map(|i| i.receipt_public_key()),
        }),
    ))
}

fn anchor_info(st: &ChainState, depth: u64) -> Option<Value> {
    let (tip, _, _) = st.tip()?;
    let n = tip.saturating_sub(depth);
    let h = *st.hashes.get(&n)?;
    let (_, clock) = st.engine.block_clock(&h)?;
    Some(json!({
        "number": dec(n),
        "hash": to_hex(&h),
        "clock_ms": dec(clock),
        "control_publication_deadline_ms": dec(clock + MAX_CONTROL_PUBLICATION_DELAY_MS),
        "process_publication_deadline_ms": dec(clock + st.engine.cfg.process_publication_delay_ms),
    }))
}

async fn anchor(State(s): State<AppState>) -> Response {
    let st = read(&s.chain);
    match anchor_info(&st, s.info.anchor_depth) {
        Some(a) => ok(with_at(&st.engine, json!({"anchor": a}))),
        None => err(StatusCode::SERVICE_UNAVAILABLE, "NOT_SYNCED", "no indexed blocks yet"),
    }
}

async fn proposals(State(s): State<AppState>) -> Response {
    let st = read(&s.chain);
    let e = &st.engine;
    let mut polls: Vec<_> = e.polls.values().collect();
    polls.sort_by(|a, b| b.registered.cmp(&a.registered));
    let list: Vec<Value> = polls.iter().map(|p| views::poll_summary(e, p)).collect();
    ok(with_at(e, json!({"proposals": list})))
}

async fn proposal(State(s): State<AppState>, Path(id): Path<String>) -> Response {
    let id = match id_param(&id) {
        Ok(i) => i,
        Err(r) => return r,
    };
    let st = read(&s.chain);
    match st.engine.polls.get(&id) {
        Some(p) => ok(with_at(&st.engine, views::poll_detail(&st.engine, p))),
        None => not_found("proposal"),
    }
}

#[derive(Deserialize)]
struct BallotQuery {
    owner: Option<String>,
}

async fn proposal_ballots(State(s): State<AppState>, Path(id): Path<String>, Query(q): Query<BallotQuery>) -> Response {
    let id = match id_param(&id) {
        Ok(i) => i,
        Err(r) => return r,
    };
    let owner = match q.owner.as_deref().map(id_param).transpose() {
        Ok(o) => o,
        Err(r) => return r,
    };
    let st = read(&s.chain);
    let e = &st.engine;
    let poll = match e.polls.get(&id) {
        Some(p) => p,
        None => return not_found("proposal"),
    };
    let owner_hex = owner.map(|o| to_hex(&o));
    let keep = |v: &Value| owner_hex.as_ref().map(|o| v["owner_id"].as_str() == Some(o.as_str())).unwrap_or(true);
    let ballots: Vec<Value> = views::poll_ballots(e, poll).into_iter().filter(|v| keep(v)).collect();
    let rejected: Vec<Value> = views::rejected_for_poll(e, &id).into_iter().filter(|v| keep(v)).collect();
    ok(with_at(e, json!({"poll_id": to_hex(&id), "order": "canonical position", "ballots": ballots, "rejected": rejected})))
}

async fn proposal_records(State(s): State<AppState>, Path(id): Path<String>) -> Response {
    let id = match id_param(&id) {
        Ok(i) => i,
        Err(r) => return r,
    };
    let st = read(&s.chain);
    let e = &st.engine;
    let poll = match e.polls.get(&id) {
        Some(p) => p,
        None => return not_found("proposal"),
    };
    let rc = tally::result_core(e, &id).ok().flatten();
    let rejected: Vec<Value> = e
        .diagnostics
        .iter()
        .filter(|d| d.kind == "process_record" && d.poll_id == Some(id))
        .map(views::diag)
        .collect();
    ok(with_at(
        e,
        json!({
            "poll_id": to_hex(&id),
            "records": views::records_for_poll(e, &id),
            "rejected": rejected,
            "admission": views::admission_json(&tally::admission(e, poll)),
            "governance": views::governance_json(&tally::governance(e, &id)),
            "attestation": views::attestation_json(&tally::attestation(e, &id, rc.as_ref())),
        }),
    ))
}

async fn bundle(State(s): State<AppState>, Path(id): Path<String>) -> Response {
    let id = match id_param(&id) {
        Ok(i) => i,
        Err(r) => return r,
    };
    let st = read(&s.chain);
    match views::bundle(&st.engine, &id, &views::BundleMeta { mode: "server-cache".into(), generated_at_ms: now_ms() }) {
        Ok(b) => {
            let name = format!("attachment; filename=\"omavote-{}-bundle.json\"", short_id(&id));
            let mut r = ok(b);
            if let Ok(v) = HeaderValue::from_str(&name) {
                r.headers_mut().insert(header::CONTENT_DISPOSITION, v);
            }
            r
        }
        Err(_) => not_found("proposal"),
    }
}

#[derive(Deserialize)]
struct AtQuery {
    block_hash: Option<String>,
    at_block_hash: Option<String>,
    policy_hash: Option<String>,
}

async fn owner_power(State(s): State<AppState>, Path(id): Path<String>, Query(q): Query<AtQuery>) -> Response {
    let owner = match id_param(&id) {
        Ok(i) => i,
        Err(r) => return r,
    };
    let st = read(&s.chain);
    let e = &st.engine;
    match q.block_hash.as_deref().map(id_param).transpose() {
        Err(r) => r,
        Ok(None) => ok(with_at(e, views::owner_power(e, &owner))),
        Ok(Some(h)) => {
            let (n, clock) = match e.block_clock(&h) {
                Some(x) => x,
                None => return not_found("canonical block"),
            };
            match s.store.deposits_at(&owner, n) {
                Ok(cells) => {
                    let total: u128 = cells.iter().map(|(_, c, _)| *c as u128).sum();
                    ok(json!({
                        "at": {"number": dec(n), "hash": to_hex(&h), "clock_ms": dec(clock)},
                        "owner_id": to_hex(&owner),
                        "total_shannon": dec(total),
                        "deposits": cells.iter().map(|(op, cap, created)| json!({
                            "tx_hash": to_hex(&op.tx_hash), "index": dec(op.index), "capacity_shannon": dec(*cap), "created_height": dec(*created),
                        })).collect::<Vec<_>>(),
                    }))
                }
                Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, "STORE", e),
            }
        }
    }
}

async fn owner_authorizations(State(s): State<AppState>, Path(id): Path<String>, Query(q): Query<AtQuery>) -> Response {
    let owner = match id_param(&id) {
        Ok(i) => i,
        Err(r) => return r,
    };
    let st = read(&s.chain);
    let e = &st.engine;
    if let Some(h) = &q.at_block_hash {
        if Some(h.as_str()) != e.tip.map(|t| to_hex(&t.1)).as_deref() {
            return bad("historical views: use the positions in `history` (only the indexed tip is served)");
        }
    }
    let policy = match q.policy_hash.as_deref().map(id_param).transpose() {
        Ok(Some(p)) => p,
        Ok(None) => AuthPolicy::build(e.network().genesis_hash).hash(),
        Err(r) => return r,
    };
    ok(with_at(e, views::stream_json(e, &policy, &owner)))
}

async fn owner_ballots(State(s): State<AppState>, Path(id): Path<String>) -> Response {
    let owner = match id_param(&id) {
        Ok(i) => i,
        Err(r) => return r,
    };
    let st = read(&s.chain);
    let e = &st.engine;
    let oh = to_hex(&owner);
    let mut out = Vec::new();
    for (pid, poll) in &e.polls {
        let ballots: Vec<Value> = views::poll_ballots(e, poll).into_iter().filter(|b| b["owner_id"].as_str() == Some(&oh)).collect();
        if !ballots.is_empty() {
            out.push(json!({"poll_id": to_hex(pid), "title": poll.manifest.title, "ballots": ballots}));
        }
    }
    ok(with_at(e, json!({"owner_id": oh, "polls": out})))
}

async fn address(State(s): State<AppState>, Path(addr): Path<String>) -> Response {
    let (hrp, script) = match parse_full_address(&addr) {
        Ok(x) => x,
        Err(e) => return bad(e),
    };
    let st = read(&s.chain);
    let e = &st.engine;
    if hrp != e.network().hrp {
        return bad(format!("address prefix {hrp} does not belong to this network"));
    }
    let owner = script.hash();
    let mut v = views::owner_power(e, &owner);
    v["owner_lock"] = to_serde(&script.to_json());
    v["address"] = json!(addr);
    v["lock_kind"] = json!(lock_kind(e.network(), &script));
    ok(with_at(e, v))
}

fn lock_kind(net: &NetworkParams, s: &Script) -> &'static str {
    if net.secp256k1.matches(s) {
        "secp256k1_blake160"
    } else if net.omnilock.map(|o| o.matches(s)).unwrap_or(false) {
        "omnilock"
    } else if net.pw_lock.map(|o| o.matches(s)).unwrap_or(false) {
        "pw_lock"
    } else {
        "other"
    }
}

async fn authorization(State(s): State<AppState>, Path(id): Path<String>) -> Response {
    let id = match id_param(&id) {
        Ok(i) => i,
        Err(r) => return r,
    };
    let st = read(&s.chain);
    let e = &st.engine;
    let grant = e.grants.get(&id).map(|g| views::grant_json(e, g));
    let mut events = Vec::new();
    for ((policy, owner), stream) in &e.streams {
        if stream.history.iter().any(|h| h.authorization_id == id) {
            events.push(views::stream_json(e, policy, owner));
        }
    }
    let rejected: Vec<Value> = e.diagnostics.iter().filter(|d| d.id == Some(id)).map(views::diag).collect();
    if grant.is_none() && events.is_empty() && rejected.is_empty() {
        return not_found("authorization");
    }
    ok(with_at(e, json!({"authorization_id": to_hex(&id), "grant": grant, "streams": events, "rejected": rejected})))
}

async fn key_authorizations(State(s): State<AppState>, Path(id): Path<String>) -> Response {
    let key = match id_param(&id) {
        Ok(i) => i,
        Err(r) => return r,
    };
    let st = read(&s.chain);
    let e = &st.engine;
    let grants: Vec<Value> = e.grants_for_key(&key).into_iter().map(|g| views::grant_json(e, g)).collect();
    ok(with_at(e, json!({"key_id": to_hex(&key), "grants": grants})))
}

async fn receipts(State(s): State<AppState>, Path(id): Path<String>) -> Response {
    if id_param(&id).is_err() {
        return bad("expected a 0x-prefixed 32-byte hex id");
    }
    match s.store.relay_by_object(&id.to_lowercase()) {
        Ok(items) if !items.is_empty() => ok(json!({"items": items.iter().map(|i| item_json(i, false)).collect::<Vec<_>>()})),
        Ok(_) => not_found("receipt"),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, "STORE", e),
    }
}

#[derive(Deserialize)]
struct DiagQuery {
    limit: Option<usize>,
    kind: Option<String>,
}

async fn diagnostics(State(s): State<AppState>, Query(q): Query<DiagQuery>) -> Response {
    let st = read(&s.chain);
    let e = &st.engine;
    let limit = q.limit.unwrap_or(100).min(1000);
    let list: Vec<Value> = e
        .diagnostics
        .iter()
        .rev()
        .filter(|d| q.kind.as_deref().map(|k| d.kind == k).unwrap_or(true))
        .take(limit)
        .map(views::diag)
        .collect();
    ok(with_at(e, json!({"order": "newest first", "diagnostics": list})))
}

async fn envelopes(State(s): State<AppState>, body: Bytes) -> Response {
    let intake = match &s.intake {
        Some(i) => i.clone(),
        None => return err(StatusCode::SERVICE_UNAVAILABLE, "RELAY_DISABLED", "this server does not accept submissions"),
    };
    match tokio::task::spawn_blocking(move || intake.submit(&body)).await {
        Ok(Ok(SubmitOutcome::Accepted(v))) => ok(v),
        Ok(Ok(SubmitOutcome::Rejected(r))) => err(StatusCode::UNPROCESSABLE_ENTITY, r.code, r.detail),
        Ok(Err(e)) => err(StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL", e),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL", e),
    }
}

/// The browser core over HTTP (same dispatch as the WASM module), for CLI clients.
async fn core_call(Path(method): Path<String>, body: Bytes) -> Response {
    let text = match std::str::from_utf8(&body) {
        Ok(t) => t,
        Err(_) => return bad("body must be UTF-8 JSON"),
    };
    match omavote_wasm::call_json(&method, text) {
        Ok(out) => ([(header::CONTENT_TYPE, "application/json")], out).into_response(),
        Err(e) => bad(e),
    }
}

// ---------------------------------------------------------------------------
// Atom feeds (public notifications; no subscriber identity)

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn height_time(st: &ChainState, height: u64) -> String {
    let clock = st
        .hashes
        .get(&height)
        .and_then(|h| st.engine.block_clock(h))
        .map(|x| x.1)
        .or(st.engine.tip.map(|t| t.2))
        .unwrap_or(0);
    utc_ms(clock).unwrap_or_else(|_| "1970-01-01T00:00:00.000Z".into())
}

fn atom(title: &str, id: &str, entries: Vec<(String, String, String, String)>, updated: &str) -> Response {
    let mut x = String::from("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<feed xmlns=\"http://www.w3.org/2005/Atom\">\n");
    x += &format!("<title>{}</title>\n<id>{}</id>\n<updated>{}</updated>\n", xml_escape(title), xml_escape(id), updated);
    for (eid, etitle, eupdated, summary) in entries {
        x += &format!(
            "<entry><id>{}</id><title>{}</title><updated>{}</updated><summary>{}</summary></entry>\n",
            xml_escape(&eid),
            xml_escape(&etitle),
            eupdated,
            xml_escape(&summary)
        );
    }
    x += "</feed>\n";
    ([(header::CONTENT_TYPE, "application/atom+xml; charset=utf-8")], x).into_response()
}

async fn global_feed(State(s): State<AppState>) -> Response {
    let st = read(&s.chain);
    let e = &st.engine;
    let mut entries = Vec::new();
    for (id, p) in &e.polls {
        entries.push((
            p.registered.height,
            format!("urn:omavote:poll:{}", to_hex(id)),
            format!("Proposal registered: {}", p.manifest.title),
            format!("#{} voting {} to {}", short_id(id), utc_ms(p.manifest.start_ms).unwrap_or_default(), utc_ms(p.manifest.end_ms).unwrap_or_default()),
        ));
    }
    for r in &e.records {
        entries.push((
            r.position.height,
            format!("urn:omavote:record:{}", to_hex(&r.record_id)),
            format!("Process record {}", r.record_type.as_str()),
            r.poll_id.map(|p| format!("poll #{}", short_id(&p))).unwrap_or_default(),
        ));
    }
    entries.sort_by(|a, b| b.0.cmp(&a.0));
    entries.truncate(100);
    let updated = e.tip.map(|t| utc_ms(t.2).unwrap_or_default()).unwrap_or_default();
    let list = entries.into_iter().map(|(h, id, t, sm)| (id, t, height_time(&st, h), sm)).collect();
    atom("Omavote proposals and process records", "urn:omavote:feed", list, &updated)
}

async fn owner_feed(State(s): State<AppState>, Path(id): Path<String>) -> Response {
    let owner = match id_param(&id) {
        Ok(i) => i,
        Err(r) => return r,
    };
    let st = read(&s.chain);
    let e = &st.engine;
    let mut entries = Vec::new();
    for (pid, p) in &e.polls {
        for b in p.ballots.iter().filter(|b| b.owner_id == owner) {
            entries.push((
                b.position.height,
                format!("urn:omavote:ballot:{}", to_hex(&b.ballot_id)),
                format!("Ballot {} on #{}", b.action.as_str(), short_id(pid)),
                format!(
                    "{} ballot included in block {}",
                    match b.authority {
                        omavote_core::messages::Authority::Owner => "owner",
                        omavote_core::messages::Authority::Delegate => "delegate",
                    },
                    b.position.height
                ),
            ));
        }
    }
    for ((_, o), stream) in &e.streams {
        if o != &owner {
            continue;
        }
        for ev in &stream.history {
            entries.push((
                ev.position.height,
                format!("urn:omavote:control:{}", to_hex(&ev.authorization_id)),
                format!("Authorization control {}", match ev.action { omavote_core::messages::ControlAction::Grant => "GRANT", _ => "REVOKE" }),
                format!("outcome {} at block {}", ev.outcome, ev.position.height),
            ));
        }
    }
    entries.sort_by(|a, b| b.0.cmp(&a.0));
    entries.truncate(100);
    let updated = e.tip.map(|t| utc_ms(t.2).unwrap_or_default()).unwrap_or_default();
    let list = entries.into_iter().map(|(h, id, t, sm)| (id, t, height_time(&st, h), sm)).collect();
    atom(&format!("Omavote activity for owner {}", to_hex(&owner)), &format!("urn:omavote:owner:{}", to_hex(&owner)), list, &updated)
}
