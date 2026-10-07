//! `omavote demo`: an end-to-end run on a development chain. Real transactions,
//! real relay, real replay. Test keys are derived from public labels and are only
//! for development chains.
//!
//! Story: five owners deposit into the Nervos DAO; a proposal is registered,
//! admitted and opened; owners vote directly and through delegate keys, revote,
//! revoke with STOP_AND_CANCEL_OPEN and withdraw; the committee attests the
//! result; an independent replay from the node must reproduce the result hash.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use omavote_core::hash::ckb_hash;
use omavote_core::json as cj;
use omavote_core::messages::{
    Action, Authority, BallotDraft, BallotEnvelope, ControlAction, ControlDraft, ControlEnvelope, ManifestPayload, ProcessEnvelope,
    ProcessRoles, ProposerProof, RecordDetail, RecordDraft, RevokeMode, Role,
};
use omavote_core::molecule::{CellOutput, OutPoint, Script};
use omavote_core::network::NetworkParams;
use omavote_core::testkit::{TestKey, TestOwner};
use omavote_core::text;
use omavote_core::types::{AuthPolicy, AuthRegistry, ConfirmationPolicy, ManifestDraft, ProposalType, RulesParams, RulesProfile, DAY_MS};
use omavote_core::util::{to_hex, Hash32};
use serde_json::{json, Value};

use crate::chain::{discover_network, GenesisCells, NetworkOverrides, RawBlock, ScriptIdConfig};
use crate::rpc::Rpc;
use crate::sync::read;
use crate::txbuilder::{self, LiveCell, TxPlan, Wallet, SHANNONS};
use crate::util::{from_serde, hash_arg};
use crate::verify;

#[derive(clap::Args, Debug)]
pub struct DemoArgs {
    #[arg(long, default_value = "http://127.0.0.1:18114")]
    pub rpc: String,
    #[arg(long, default_value = "http://127.0.0.1:18080")]
    pub api: String,
    /// Development-chain key that pays for deposits and funds the relay.
    #[arg(long)]
    pub faucet_key: PathBuf,
    /// Voting period in seconds of chain time.
    #[arg(long, default_value_t = 150)]
    pub period_secs: u64,
    /// Seconds of chain time between registration and the start.
    #[arg(long, default_value_t = 60)]
    pub lead_secs: u64,
    /// Truncate the chain under the relayed ballots (needs the IntegrationTest RPC module).
    #[arg(long)]
    pub reorg_test: bool,
    /// Directory for the evidence bundle, verify report and block dump.
    #[arg(long, default_value = "devnet/demo-out")]
    pub out_dir: PathBuf,
}

/// Deterministic demo process roles (committee 2-of-3, coordinator 1-of-2).
pub fn demo_roles(genesis: Hash32) -> (ProcessRoles, Vec<TestKey>, Vec<TestKey>) {
    let committee: Vec<TestKey> = (1..=3).map(|i| TestKey::secp(&format!("omavote-demo-committee-{i}"))).collect();
    let coordinator = vec![TestKey::evm("omavote-demo-coordinator-1"), TestKey::secp("omavote-demo-coordinator-2")];
    let roles = ProcessRoles::build(
        genesis,
        None,
        (2, committee.iter().map(|k| k.descriptor.clone()).collect()),
        (1, coordinator.iter().map(|k| k.descriptor.clone()).collect()),
        ckb_hash(b"omavote-demo-roles"),
    )
    .expect("demo roles are valid");
    (roles, committee, coordinator)
}

fn nonce() -> Hash32 {
    let mut n = [0u8; 32];
    getrandom::getrandom(&mut n).expect("random");
    n
}

struct Anchor {
    hash: Hash32,
    clock_ms: u64,
    control_deadline_ms: u64,
    process_deadline_ms: u64,
}

struct Demo {
    rpc: Rpc,
    http: reqwest::Client,
    api: String,
    cells: GenesisCells,
    faucet: Wallet,
    started: Instant,
    log: Vec<Value>,
}

impl Demo {
    fn say(&mut self, msg: impl Into<String>) {
        let msg = msg.into();
        eprintln!("[{:>6.1}s] {msg}", self.started.elapsed().as_secs_f64());
        self.log.push(json!({"t_s": format!("{:.1}", self.started.elapsed().as_secs_f64()), "step": msg}));
    }

    async fn get(&self, path: &str) -> Result<Value> {
        let r = self.http.get(format!("{}{}", self.api, path)).send().await.with_context(|| format!("GET {path}"))?;
        let status = r.status();
        let v: Value = r.json().await.with_context(|| format!("GET {path} body"))?;
        if !status.is_success() {
            bail!("GET {path}: {status} {v}");
        }
        Ok(v)
    }

    async fn submit(&self, v: &cj::Value) -> Result<Value> {
        let r = self
            .http
            .post(format!("{}/api/envelopes", self.api))
            .header("content-type", "application/json")
            .body(cj::to_jcs(v))
            .send()
            .await?;
        let status = r.status();
        let body: Value = r.json().await?;
        if !status.is_success() {
            bail!("submission rejected: {status} {body}");
        }
        Ok(body)
    }

    async fn wait<T, F, Fut>(&self, what: &str, timeout_s: u64, mut f: F) -> Result<T>
    where
        F: FnMut() -> Fut,
        Fut: std::future::Future<Output = Result<Option<T>>>,
    {
        let deadline = Instant::now() + Duration::from_secs(timeout_s);
        loop {
            match f().await {
                Ok(Some(v)) => return Ok(v),
                Ok(None) => {}
                Err(e) => tracing::debug!("{what}: {e:#}"),
            }
            if Instant::now() > deadline {
                bail!("timed out waiting for {what}");
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    async fn anchor(&self) -> Result<Anchor> {
        let v = self.get("/api/anchor").await?;
        let a = &v["anchor"];
        let n = |k: &str| a[k].as_str().and_then(|x| x.parse::<u64>().ok()).ok_or_else(|| anyhow!("anchor field {k}"));
        Ok(Anchor {
            hash: hash_arg(a["hash"].as_str().unwrap_or(""))?,
            clock_ms: n("clock_ms")?,
            control_deadline_ms: n("control_publication_deadline_ms")?,
            process_deadline_ms: n("process_publication_deadline_ms")?,
        })
    }

    /// A fresh anchor strictly newer than `than` (selection compares anchor heights).
    async fn newer_anchor(&self, than: &Hash32) -> Result<Anchor> {
        let than = *than;
        self.wait("a newer anchor block", 60, || async move {
            let a = self.anchor().await?;
            Ok(if a.hash != than { Some(a) } else { None })
        })
        .await
    }

    async fn chain_clock(&self) -> Result<u64> {
        let s = self.get("/api/status").await?;
        s["indexed"]["clock_ms"].as_str().and_then(|x| x.parse().ok()).ok_or_else(|| anyhow!("no indexed clock"))
    }

    async fn indexer_caught_up(&self, block: u64) -> Result<()> {
        let rpc = self.rpc.clone();
        self.wait("the node indexer", 60, || {
            let rpc = rpc.clone();
            async move {
                let t = rpc.call("get_indexer_tip", json!([])).await?;
                let n = crate::chain::hex_u64(&t["block_number"])?;
                Ok(if n >= block { Some(()) } else { None })
            }
        })
        .await
    }

    /// Build, sign, send a faucet-paid transaction and wait until it is committed.
    async fn send(&mut self, plan: TxPlan, extra: &[&Wallet], what: &str) -> Result<(Hash32, Hash32, u64)> {
        let cells: Vec<LiveCell> = txbuilder::live_cells(&self.rpc, &self.faucet.lock)
            .await?
            .into_iter()
            .filter(|c| c.type_.is_none() && c.data.is_empty())
            .collect();
        let built = txbuilder::build(&plan, &self.faucet, cells, extra, 1000)?;
        let hash = self.rpc.send_transaction(txbuilder::tx_to_rpc(&built.tx)).await.with_context(|| what.to_string())?;
        let rpc = self.rpc.clone();
        let (block_hash, number) = self
            .wait(what, 120, || {
                let rpc = rpc.clone();
                let hash = hash.clone();
                async move {
                    let (st, bh) = rpc.tx_status(&hash).await?;
                    if st == "rejected" {
                        bail!("transaction rejected");
                    }
                    match (st.as_str(), bh) {
                        ("committed", Some(bh)) => {
                            let h = rpc.call("get_header", json!([bh])).await?;
                            Ok(Some((bh, crate::chain::hex_u64(&h["number"])?)))
                        }
                        _ => Ok(None),
                    }
                }
            })
            .await?;
        self.indexer_caught_up(number).await?;
        self.say(format!("{what}: tx {hash} in block {number}"));
        Ok((hash_arg(&hash)?, hash_arg(&block_hash)?, number))
    }

    /// Wait until every given object id has a relay receipt with one of `statuses`.
    async fn wait_relay(&mut self, ids: &[Hash32], statuses: &[&str], what: &str) -> Result<()> {
        {
            let this: &Demo = &*self;
            for id in ids {
                let path = format!("/api/receipts/{}", to_hex(id));
                let statuses: Vec<String> = statuses.iter().map(|s| s.to_string()).collect();
                this.wait(what, 180, || {
                    let path = path.clone();
                    let statuses = statuses.clone();
                    async move {
                        let v = this.get(&path).await?;
                        let st = v["items"][0]["status"].as_str().unwrap_or("").to_string();
                        if st == "EXPIRED" || st == "FAILED" {
                            bail!("relay item {st}: {}", v["items"][0]["error"]);
                        }
                        Ok(if statuses.contains(&st) { Some(()) } else { None })
                    }
                })
                .await?;
            }
        }
        self.say(format!("{what}: relayed ({} item(s))", ids.len()));
        Ok(())
    }

    async fn poll_view(&self, poll_id: &Hash32) -> Result<Value> {
        self.get(&format!("/api/proposals/{}", to_hex(poll_id))).await
    }
}

fn dao_output(net: &NetworkParams, lock: &Script, ckb: u64) -> (CellOutput, Vec<u8>) {
    (CellOutput { capacity: ckb * SHANNONS, lock: lock.clone(), type_: Some(net.dao_script()) }, vec![0u8; 8])
}

fn ballot(net: &NetworkParams, m: &omavote_core::types::Manifest, owner: &TestOwner, action: Action, a: &Anchor) -> BallotEnvelope {
    let body = BallotDraft {
        action,
        authority: Authority::Owner,
        authorization_id: None,
        signer_key_id: None,
        nonce: nonce(),
        anchor_block_hash: a.hash,
        auth_adapter: owner.adapter.into(),
        genesis: net.genesis_hash,
        owner_lock: owner.lock.clone(),
        poll_id: m.poll_id(),
        rules_hash: m.rules_hash(),
    }
    .build()
    .unwrap();
    let t = text::ballot_text(m, &body, net).unwrap();
    BallotEnvelope { proof: owner.sign(&t), body }
}

fn delegate_ballot(
    net: &NetworkParams,
    m: &omavote_core::types::Manifest,
    owner: &TestOwner,
    grant: &ControlEnvelope,
    key: &TestKey,
    action: Action,
    a: &Anchor,
) -> BallotEnvelope {
    let body = BallotDraft {
        action,
        authority: Authority::Delegate,
        authorization_id: Some(grant.body.authorization_id()),
        signer_key_id: Some(key.id()),
        nonce: nonce(),
        anchor_block_hash: a.hash,
        auth_adapter: key.descriptor.adapter_id().into(),
        genesis: net.genesis_hash,
        owner_lock: owner.lock.clone(),
        poll_id: m.poll_id(),
        rules_hash: m.rules_hash(),
    }
    .build()
    .unwrap();
    let t = text::ballot_text(m, &body, net).unwrap();
    BallotEnvelope { proof: key.sign(&t), body }
}

fn control(
    net: &NetworkParams,
    policy: &AuthPolicy,
    owner: &TestOwner,
    action: ControlAction,
    key: Option<&TestKey>,
    mode: Option<RevokeMode>,
    a: &Anchor,
) -> ControlEnvelope {
    let body = ControlDraft {
        genesis: net.genesis_hash,
        auth_policy_hash: policy.hash(),
        owner_lock: owner.lock.clone(),
        owner_auth_adapter: owner.adapter.into(),
        action,
        key_descriptor: key.map(|k| k.descriptor.clone()),
        expires_at_ms: key.map(|_| a.clock_ms + 30 * DAY_MS),
        revoke_mode: mode,
        anchor_block_hash: a.hash,
        publication_deadline_ms: a.control_deadline_ms,
        nonce: nonce(),
    }
    .build()
    .unwrap();
    let t = text::control_text(&body, net).unwrap();
    ControlEnvelope { proof: owner.sign(&t), body }
}

fn record(net: &NetworkParams, roles: &ProcessRoles, role: Role, signers: &[&TestKey], poll: Option<Hash32>, detail: RecordDetail, a: &Anchor) -> ProcessEnvelope {
    let body = RecordDraft {
        genesis: net.genesis_hash,
        roles_hash: roles.roles_hash(),
        role,
        poll_id: poll,
        detail,
        evidence_hash: None,
        anchor_block_hash: a.hash,
        publication_deadline_ms: a.process_deadline_ms,
        nonce: nonce(),
    }
    .build()
    .unwrap();
    let t = text::process_text(&body).unwrap();
    ProcessEnvelope { proofs: signers.iter().map(|k| (k.id(), k.sign(&t))).collect(), body }
}

fn owner_row<'a>(rc: &'a Value, owner: &TestOwner) -> Result<&'a Value> {
    let id = to_hex(&owner.id());
    rc["owners"]
        .as_array()
        .and_then(|a| a.iter().find(|r| r["owner_id"].as_str() == Some(&id)))
        .ok_or_else(|| anyhow!("owner {id} missing from result_core"))
}

fn expect(cond: bool, what: &str) -> Result<()> {
    if !cond {
        bail!("check failed: {what}");
    }
    Ok(())
}

pub async fn run(args: DemoArgs) -> Result<()> {
    let rpc = Rpc::new(&args.rpc);
    let http = reqwest::Client::builder().timeout(Duration::from_secs(60)).build()?;
    let info: Value = http.get(format!("{}/api/network", args.api)).send().await?.json().await?;
    let net = NetworkParams::from_json(&from_serde(&info["network"])?).map_err(|e| anyhow!("{e}"))?;
    if NetworkParams::known(&net.genesis_hash).is_some() {
        bail!("the demo only runs on development chains");
    }
    let genesis = RawBlock::from_rpc(&rpc.block_by_number(0).await?.ok_or_else(|| anyhow!("no genesis"))?)?;
    if genesis.hash != net.genesis_hash {
        bail!("the API server and --rpc point at different chains");
    }
    let overrides = NetworkOverrides {
        omnilock: net.omnilock.map(|o| ScriptIdConfig { code_hash: to_hex(&o.code_hash), hash_type: o.hash_type.as_str().into() }),
        pw_lock: net.pw_lock.map(|o| ScriptIdConfig { code_hash: to_hex(&o.code_hash), hash_type: o.hash_type.as_str().into() }),
    };
    let (_, cells) = discover_network(&genesis, &overrides)?;
    let faucet = Wallet::from_key_file(&args.faucet_key, &net)?;
    let mut d = Demo { rpc, http, api: args.api.clone(), cells, faucet, started: Instant::now(), log: Vec::new() };
    std::fs::create_dir_all(&args.out_dir)?;
    d.say(format!("devnet {} ; faucet {}", to_hex(&net.genesis_hash), d.faucet.address(&net)));

    // --- Relay funding -------------------------------------------------------
    let status = d.get("/api/status").await?;
    let relay_addr = status["relay"]["address"].as_str().ok_or_else(|| anyhow!("server has no relay wallet configured"))?.to_string();
    let relay_lock = omavote_core::address::parse_full_address(&relay_addr).map_err(|e| anyhow!("{e}"))?.1;
    let balance: u64 = status["relay"]["balance_shannon"].as_str().and_then(|x| x.parse().ok()).unwrap_or(0);
    if balance < 20_000 * SHANNONS {
        let plan = TxPlan {
            cell_deps: vec![d.cells.secp_dep_group.clone()],
            outputs: vec![(CellOutput { capacity: 100_000 * SHANNONS, lock: relay_lock, type_: None }, vec![])],
            ..Default::default()
        };
        d.send(plan, &[], "fund the relay hot wallet with 100000 CKB").await?;
    }

    // --- Owners and deposits ---------------------------------------------------
    let alice = TestOwner::ckb("omavote-demo-alice", &net);
    let bob = TestOwner::ckb("omavote-demo-bob", &net);
    let dave = TestOwner::ckb("omavote-demo-dave", &net);
    let erin = TestOwner::ckb("omavote-demo-erin", &net);
    let carol = if net.omnilock.is_some() { Some(TestOwner::evm_omnilock("omavote-demo-carol", &net)) } else { None };
    let k1 = TestKey::evm("omavote-demo-delegate-k1");
    let k2 = TestKey::secp("omavote-demo-delegate-k2");
    let mut outputs = vec![
        dao_output(&net, &alice.lock, 150_000),
        dao_output(&net, &bob.lock, 60_000),
        dao_output(&net, &dave.lock, 30_000),
        dao_output(&net, &erin.lock, 20_000),
    ];
    if let Some(c) = &carol {
        outputs.push(dao_output(&net, &c.lock, 80_000));
    } else {
        d.say("no Omnilock identity declared for this devnet: skipping the EVM owner");
    }
    let plan = TxPlan {
        cell_deps: vec![d.cells.secp_dep_group.clone(), d.cells.dao_code.clone()],
        outputs,
        ..Default::default()
    };
    let (deposit_tx, deposit_block, _) = d.send(plan, &[], "Nervos DAO deposits for five owners").await?;

    // --- Policy and process roles ----------------------------------------------
    let policy = AuthPolicy::build(net.genesis_hash);
    let (roles, committee, coordinator) = demo_roles(net.genesis_hash);
    let expected_roles = info["initial_roles_hash"].as_str().map(str::to_string);
    expect(
        expected_roles.as_deref() == Some(to_hex(&roles.roles_hash()).as_str()),
        "server initial_roles_hash matches the demo roles (run `omavote demo-roles`)",
    )?;
    let mut ids = Vec::new();
    for v in [policy.to_json().clone(), roles.to_json().clone()] {
        let r = d.submit(&v).await?;
        if r["status"] != "ALREADY_ON_CHAIN" {
            ids.push(hash_arg(r["object_id"].as_str().unwrap_or(""))?);
        }
    }
    d.wait_relay(&ids, &["INCLUDED", "CONFIRMED"], "authorization policy and process roles").await?;
    d.wait("the roles to take effect", 60, || async {
        let v = d.get("/api/network").await?;
        Ok(if v["current_roles"].is_null() || v["authorization_policy"]["published"].is_null() { None } else { Some(()) })
    })
    .await?;

    // --- Proposal ------------------------------------------------------------------
    let clock = d.chain_clock().await?;
    let start_ms = clock + args.lead_secs * 1000;
    let rules = RulesProfile::build(&RulesParams {
        threshold_inclusive: true,
        opening_confirmations: 10,
        delegate_cutoff_ms: 0,
        voting_period_ms: args.period_secs * 1000,
    });
    let registry: AuthRegistry = AuthRegistry::from_json(&from_serde(&info["default_registry"]["object"])?).map_err(|e| anyhow!("{e}"))?;
    let manifest = ManifestDraft {
        genesis: net.genesis_hash,
        nonce: nonce(),
        proposal_type: ProposalType::Grant,
        title: "Demo: fund an independent CKB block explorer".into(),
        signing_title: "Demo block explorer grant".into(),
        content_hash: ckb_hash(b"Demo proposal body (devnet)"),
        content_locations: vec!["https://example.invalid/omavote-demo".into()],
        forum_topic_id: "1".into(),
        forum_revision: "1".into(),
        discussion_evidence_hash: None,
        budget_ckb_shannon: 1_000 * SHANNONS as u128,
        quorum_base_shannon: 1_000 * SHANNONS as u128,
        payment_terms_hash: None,
        recipient_lock_script: Some(alice.lock.clone()),
        proposer_owner_locks: vec![alice.lock.clone()],
        rules,
        auth_registry: registry,
        auth_policy: policy.clone(),
        start_ms,
        confirmation: ConfirmationPolicy { result_confirmations: 5, review_window_ms: 30_000 },
    }
    .build()
    .map_err(|e| anyhow!("{e}"))?;
    let proposal_text = text::proposal_text(&manifest, &alice.lock, &net).unwrap();
    let payload = ManifestPayload {
        manifest: manifest.clone(),
        proposer_proofs: vec![ProposerProof { owner_lock: alice.lock.clone(), auth_adapter: alice.adapter.into(), proof: alice.sign(&proposal_text) }],
    };
    let poll_id = manifest.poll_id();
    d.submit(&payload.to_json()).await?;
    d.say(format!("proposal #{} submitted; voting {}s from chain clock {}", omavote_core::messages::short_id(&poll_id), args.period_secs, start_ms));
    d.wait_relay(&[poll_id], &["INCLUDED", "CONFIRMED"], "manifest").await?;

    // Admission by the coordinator, early enough for the opening confirmations.
    let a = d.anchor().await?;
    let admit = record(&net, &roles, Role::Coordinator, &[&coordinator[0]], Some(poll_id), RecordDetail::Admission { admitted: true }, &a);
    d.submit(&admit.to_json()).await?;
    // Grants before the start: Carol (EVM) delegates to K1, Erin delegates to K2.
    let erin_grant = control(&net, &policy, &erin, ControlAction::Grant, Some(&k2), None, &a);
    d.submit(&erin_grant.to_json()).await?;
    let mut grant_ids = vec![admit.body.record_id(), erin_grant.body.authorization_id()];
    let carol_grant = match &carol {
        Some(c) => {
            let g = control(&net, &policy, c, ControlAction::Grant, Some(&k1), None, &a);
            d.submit(&g.to_json()).await?;
            grant_ids.push(g.body.authorization_id());
            Some(g)
        }
        None => None,
    };
    d.wait_relay(&grant_ids, &["INCLUDED", "CONFIRMED"], "admission record and delegate grants").await?;

    d.wait("the poll to open", args.lead_secs + 120, || async {
        let v = d.poll_view(&poll_id).await?;
        Ok(match v["status"].as_str() {
            Some("OPEN") => Some(()),
            Some("LATE_MANIFEST") => bail!("poll became LATE_MANIFEST"),
            _ => None,
        })
    })
    .await?;
    let v = d.poll_view(&poll_id).await?;
    expect(v["admission"]["state"] == "ADMITTED", "admission record counted before the opening boundary")?;
    d.say("poll is OPEN and ADMITTED");

    // --- First round of ballots --------------------------------------------------
    let a1 = d.anchor().await?;
    let mut first = vec![
        ballot(&net, &manifest, &alice, Action::Yes, &a1),
        ballot(&net, &manifest, &bob, Action::No, &a1),
        ballot(&net, &manifest, &dave, Action::Yes, &a1),
        delegate_ballot(&net, &manifest, &erin, &erin_grant, &k2, Action::No, &a1),
    ];
    if let (Some(c), Some(g)) = (&carol, &carol_grant) {
        first.push(delegate_ballot(&net, &manifest, c, g, &k1, Action::No, &a1));
    }
    for b in &first {
        d.submit(&b.to_json()).await?;
    }
    let first_ids: Vec<Hash32> = first.iter().map(|b| b.body.ballot_id()).collect();
    d.wait_relay(&first_ids, &["INCLUDED", "CONFIRMED"], "first ballots (direct and delegated)").await?;

    // Dave withdraws (phase 1): his deposit leaves the DAO before the close.
    let dave_cell = LiveCell {
        out_point: OutPoint { tx_hash: deposit_tx, index: 2 },
        capacity: 30_000 * SHANNONS,
        lock: dave.lock.clone(),
        type_: Some(net.dao_script()),
        data: vec![0; 8],
    };
    let deposit_number = {
        let h = d.rpc.call("get_header", json!([to_hex(&deposit_block)])).await?;
        crate::chain::hex_u64(&h["number"])?
    };
    let dave_wallet = Wallet::from_secret(dave.secret, &net)?;
    let plan = TxPlan {
        cell_deps: vec![d.cells.secp_dep_group.clone(), d.cells.dao_code.clone()],
        header_deps: vec![deposit_block],
        fixed_inputs: vec![dave_cell],
        outputs: vec![(
            CellOutput { capacity: 30_000 * SHANNONS, lock: dave.lock.clone(), type_: Some(net.dao_script()) },
            deposit_number.to_le_bytes().to_vec(),
        )],
        ..Default::default()
    };
    d.send(plan, &[&dave_wallet], "Dave's phase-1 withdrawal").await?;

    // --- Second round: revote, direct override, revoke with cancel -------------------
    let a2 = d.newer_anchor(&a1.hash).await?;
    let mut second = vec![ballot(&net, &manifest, &bob, Action::Yes, &a2)];
    if let Some(c) = &carol {
        second.push(ballot(&net, &manifest, c, Action::Yes, &a2));
    }
    let erin_revoke = control(&net, &policy, &erin, ControlAction::Revoke, None, Some(RevokeMode::StopAndCancelOpen), &a2);
    d.submit(&erin_revoke.to_json()).await?;
    for b in &second {
        d.submit(&b.to_json()).await?;
    }
    let mut second_ids: Vec<Hash32> = second.iter().map(|b| b.body.ballot_id()).collect();
    second_ids.push(erin_revoke.body.authorization_id());
    d.wait_relay(&second_ids, &["INCLUDED", "CONFIRMED"], "revote, owner override and REVOKE STOP+CANCEL-OPEN").await?;

    // --- Optional reorg: remove the block with the second round and let the relay recover.
    let mut reorg = Value::Null;
    if args.reorg_test {
        let r = d.get(&format!("/api/receipts/{}", to_hex(&second_ids[0]))).await?;
        let n: u64 = r["items"][0]["block_number"].as_str().and_then(|x| x.parse().ok()).ok_or_else(|| anyhow!("no inclusion block"))?;
        let old_block = r["items"][0]["block_hash"].as_str().unwrap_or("").to_string();
        // Truncate two blocks below the inclusion block: the miner may hold a solved block
        // for the next height and would otherwise re-attach the identical block.
        let target_n = n - 2;
        let target = d.rpc.block_hash(target_n).await?.ok_or_else(|| anyhow!("no block {target_n}"))?;
        let before = d.get("/api/status").await?["reorgs"]["count"].as_str().unwrap_or("0").parse::<u64>().unwrap_or(0);
        // The node may race the truncation with a block already in flight; repeat until
        // the block that carried the second round is really gone.
        // `truncate` only rewinds the tip: the removed blocks stay in the node's store and
        // the external miner may extend them again. Mining a few blocks right away makes
        // the new branch the heavier one, so the old block cannot come back.
        let mut attempts = 0;
        loop {
            attempts += 1;
            d.rpc.call("truncate", json!([target])).await.context("truncate (enable the IntegrationTest RPC module)")?;
            for _ in 0..6 {
                d.rpc.call("generate_block", json!([])).await.context("generate_block")?;
            }
            tokio::time::sleep(Duration::from_millis(1500)).await;
            let now = d.rpc.block_hash(n).await?;
            if now.as_deref() != Some(old_block.as_str()) {
                break;
            }
            if attempts >= 10 {
                bail!("the node did not switch to a new branch");
            }
        }
        d.say(format!("truncated the chain to block {target_n} (removing block {n} with the second round; attempt {attempts})"));
        reorg = d
            .wait("the server to roll back", 60, || async {
                let s = d.get("/api/status").await?;
                let c: u64 = s["reorgs"]["count"].as_str().unwrap_or("0").parse().unwrap_or(0);
                Ok(if c > before { Some(s["reorgs"]["last"].clone()) } else { None })
            })
            .await?;
        d.say(format!("server rolled back: {reorg}"));
        let path = format!("/api/receipts/{}", to_hex(&second_ids[0]));
        let new_block = d
            .wait("the relay to re-include the second round in a new block", 120, || async {
                let v = d.get(&path).await?;
                let it = &v["items"][0];
                let st = it["status"].as_str().unwrap_or("");
                let bh = it["block_hash"].as_str().unwrap_or("");
                Ok(if (st == "INCLUDED" || st == "CONFIRMED") && !bh.is_empty() && bh != old_block { Some(bh.to_string()) } else { None })
            })
            .await?;
        d.say(format!("relay re-included the second round in block {new_block}"));
        let wanted: Vec<String> = second_ids[..second.len()].iter().map(|h| to_hex(h)).collect();
        d.wait("the replayed ballots to reappear", 60, || async {
            let ballots = d.get(&format!("/api/proposals/{}/ballots", to_hex(&poll_id))).await?;
            let seen: Vec<String> =
                ballots["ballots"].as_array().cloned().unwrap_or_default().iter().filter_map(|b| b["ballot_id"].as_str().map(str::to_string)).collect();
            Ok(if wanted.iter().all(|w| seen.contains(w)) { Some(()) } else { None })
        })
        .await?;
        d.say("second-round ballots are back after the reorg");
    }

    // --- Close, result, attestation ----------------------------------------------------
    let summary = d
        .wait("the poll to close and reach its confirmations", args.period_secs + args.lead_secs + 240, || async {
            let v = d.poll_view(&poll_id).await?;
            Ok(match v["status"].as_str() {
                Some("AUDITABLE") | Some("FINALIZED_BY_POLICY") => Some(v),
                _ => None,
            })
        })
        .await?;
    let rc = &summary["result_core"];
    let result_hash = hash_arg(summary["result_hash"].as_str().unwrap_or(""))?;
    d.say(format!("closed: outcome {} result_hash {}", rc["outcome"], to_hex(&result_hash)));
    let ckb = |n: u64| (n * SHANNONS).to_string();
    let row = |o: &TestOwner| owner_row(rc, o).cloned();
    expect(row(&alice)?["final_status"] == "YES" && row(&alice)?["counted_weight_shannon"] == ckb(150_000), "Alice YES with 150000 CKB")?;
    expect(row(&bob)?["final_status"] == "YES" && row(&bob)?["counted_weight_shannon"] == ckb(60_000), "Bob's revote YES replaces his NO")?;
    expect(row(&dave)?["final_status"] == "YES" && row(&dave)?["counted_weight_shannon"] == "0", "Dave's withdrawn deposit counts zero")?;
    expect(row(&erin)?["final_status"] == "CANCELLED_BY_CONTROL", "Erin's REVOKE STOP+CANCEL-OPEN cancels the delegate ballot")?;
    let mut yes = 210_000u64;
    if let Some(c) = &carol {
        expect(row(c)?["final_status"] == "YES" && row(c)?["counted_weight_shannon"] == ckb(80_000), "Carol's direct YES overrides her delegate's NO")?;
        yes += 80_000;
    }
    expect(rc["yes_shannon"] == ckb(yes) && rc["no_shannon"] == "0" && rc["outcome"] == "PASS", "tally and outcome")?;

    let a3 = d.anchor().await?;
    let attest = record(
        &net,
        &roles,
        Role::Committee,
        &[&committee[0], &committee[2]],
        Some(poll_id),
        RecordDetail::ResultAttestation { result_hash, pass: true },
        &a3,
    );
    d.submit(&attest.to_json()).await?;
    d.wait_relay(&[attest.body.record_id()], &["INCLUDED", "CONFIRMED"], "committee RESULT_ATTESTATION (2 of 3)").await?;
    let v = d.poll_view(&poll_id).await?;
    expect(v["attestation"]["state"] == "CONFIRMED", "attestation matches the recomputed result")?;

    // --- Independent replay from the node ---------------------------------------------
    let roles_hash = roles.roles_hash();
    let process_delay: u64 = info["process_publication_delay_ms"].as_str().and_then(|x| x.parse().ok()).unwrap_or(0);
    let replay = verify::replay(&verify::ReplayOptions {
        rpc: args.rpc.clone(),
        overrides,
        initial_roles_hash: Some(roles_hash),
        process_delay_ms: process_delay,
        to: None,
        check_clock: true,
    })
    .await?;
    let report = {
        let st = read(&replay.syncer.state);
        verify::poll_report(&st.engine, Some(poll_id))
    };
    let replayed = report.first().and_then(|p| p["result_hash"].as_str()).unwrap_or("").to_string();
    expect(replayed == to_hex(&result_hash), "independent replay from the node reproduces result_hash")?;
    d.say(format!("independent replay (clock checked) reproduces {replayed}"));
    let bundle = d.get(&format!("/api/results/{}/bundle", to_hex(&poll_id))).await?;
    std::fs::write(args.out_dir.join("bundle.json"), serde_json::to_string_pretty(&bundle)? + "\n")?;
    std::fs::write(args.out_dir.join("verify-report.json"), serde_json::to_string_pretty(&report)? + "\n")?;
    let dump = verify::dump_blocks(&replay, Some(roles_hash), process_delay)?;
    std::fs::write(args.out_dir.join("blocks.json"), serde_json::to_string(&dump)? + "\n")?;
    let out = json!({
        "ok": true,
        "poll_id": to_hex(&poll_id),
        "result_hash": to_hex(&result_hash),
        "outcome": rc["outcome"],
        "yes_shannon": rc["yes_shannon"],
        "no_shannon": rc["no_shannon"],
        "reorg": reorg,
        "steps": d.log,
    });
    std::fs::write(args.out_dir.join("summary.json"), serde_json::to_string_pretty(&out)? + "\n")?;
    println!("{}", serde_json::to_string_pretty(&out)?);
    Ok(())
}
