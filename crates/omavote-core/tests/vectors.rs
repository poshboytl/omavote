//! Cross-language test vectors (golden files under `/vectors`).
//!
//! `cargo test -p omavote-core --test vectors` checks the committed files;
//! `OMAVOTE_WRITE_VECTORS=1 cargo test -p omavote-core --test vectors` regenerates them.

use std::path::PathBuf;

use omavote_core::adapter;
use omavote_core::carrier::{self, Kind};
use omavote_core::engine::{BlockInput, Engine};
use omavote_core::hash::{ckb_hash, domain, domain_hash};
use omavote_core::json::{jcs_bytes, parse, to_jcs, Object, Value};
use omavote_core::messages::*;
use omavote_core::molecule::{HashType, Script};
use omavote_core::network::NetworkParams;
use omavote_core::tally;
use omavote_core::testkit::*;
use omavote_core::text;
use omavote_core::types::*;
use omavote_core::util::{dec, to_hex};

const T0: u64 = 1_800_000_000_000;
const HOUR: u64 = 3_600_000;

fn s(v: impl Into<String>) -> Value {
    Value::str(v)
}

fn obj(pairs: Vec<(&str, Value)>) -> Value {
    let mut o = Object::new();
    for (k, v) in pairs {
        o.insert(k, v);
    }
    Value::Object(o)
}

fn arr(v: Vec<Value>) -> Value {
    Value::Array(v)
}

fn vectors_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../vectors")
}

fn check_or_write(name: &str, v: &Value) {
    let path = vectors_dir().join(name);
    let mut text = pretty(v, 0);
    text.push('\n');
    if std::env::var("OMAVOTE_WRITE_VECTORS").is_ok() {
        std::fs::create_dir_all(vectors_dir()).unwrap();
        std::fs::write(&path, text).unwrap();
        return;
    }
    let existing = std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("missing {name}; run with OMAVOTE_WRITE_VECTORS=1"));
    assert_eq!(parse(existing.as_bytes()).unwrap(), parse(text.as_bytes()).unwrap(), "{name} differs from generated vectors");
}

/// Human-friendly JSON (still parseable by the strict parser: no numbers are used).
fn pretty(v: &Value, indent: usize) -> String {
    let pad = "  ".repeat(indent + 1);
    let end = "  ".repeat(indent);
    match v {
        Value::Array(items) if !items.is_empty() => {
            let inner: Vec<String> = items.iter().map(|i| format!("{pad}{}", pretty(i, indent + 1))).collect();
            format!("[\n{}\n{end}]", inner.join(",\n"))
        }
        Value::Object(o) if !o.is_empty() => {
            let inner: Vec<String> = o
                .iter()
                .map(|(k, val)| format!("{pad}{}: {}", to_jcs(&Value::str(k.clone())), pretty(val, indent + 1)))
                .collect();
            format!("{{\n{}\n{end}}}", inner.join(",\n"))
        }
        other => to_jcs(other),
    }
}

fn network_json(n: &NetworkParams) -> Value {
    let id = |x: &Option<omavote_core::network::ScriptId>| match x {
        Some(i) => obj(vec![("code_hash", s(to_hex(&i.code_hash))), ("hash_type", s(i.hash_type.as_str()))]),
        None => Value::Null,
    };
    obj(vec![
        ("name", s(n.name.clone())),
        ("genesis_hash", s(to_hex(&n.genesis_hash))),
        ("hrp", s(n.hrp.clone())),
        ("secp256k1", id(&Some(n.secp256k1))),
        ("dao", id(&Some(n.dao))),
        ("omnilock", id(&n.omnilock)),
        ("pw_lock", id(&n.pw_lock)),
    ])
}

fn block_json(b: &BlockInput) -> Value {
    obj(vec![
        ("number", s(dec(b.number))),
        ("hash", s(to_hex(&b.hash))),
        ("parent_hash", s(to_hex(&b.parent_hash))),
        ("clock_ms", s(dec(b.clock_ms))),
        (
            "transactions",
            arr(b
                .transactions
                .iter()
                .map(|t| {
                    obj(vec![
                        ("hash", s(to_hex(&t.hash))),
                        (
                            "inputs",
                            arr(t.inputs.iter().map(|i| obj(vec![("tx_hash", s(to_hex(&i.tx_hash))), ("index", s(dec(i.index)))])).collect()),
                        ),
                        (
                            "outputs",
                            arr(t
                                .outputs
                                .iter()
                                .map(|o| {
                                    obj(vec![
                                        ("index", s(dec(o.index))),
                                        ("capacity", s(dec(o.capacity))),
                                        ("lock", o.lock.to_json()),
                                        ("type", o.type_.as_ref().map(|t| t.to_json()).unwrap_or(Value::Null)),
                                        ("data", s(to_hex(&o.data))),
                                    ])
                                })
                                .collect()),
                        ),
                        ("witnesses", arr(t.witnesses.iter().map(|w| s(to_hex(w))).collect())),
                    ])
                })
                .collect()),
        ),
    ])
}

#[test]
fn jcs_and_hash_vectors() {
    let valid = [
        r#"{"b":"2","a":"1"}"#,
        "{\"\u{fb01}\":\"x\",\"\u{1f600}\":\"y\",\"a\":[null,true,false]}",
        r#"{"esc":"\u0001\b\f\n\r\t\"\\/","uni":"é中"}"#,
        r#"[ ]"#,
    ];
    let invalid = [
        r#"{"a":1}"#,
        r#"{"a":"1","a":"2"}"#,
        r#""\ud800""#,
        "\"a\u{1}\"",
        r#"{"a":"1"} trailing"#,
    ];
    let v = obj(vec![
        (
            "jcs",
            arr(valid
                .iter()
                .map(|i| obj(vec![("input", s(*i)), ("canonical", s(to_jcs(&parse(i.as_bytes()).unwrap())))]))
                .collect()),
        ),
        ("reject", arr(invalid.iter().map(|i| s(*i)).collect())),
        (
            "ckb_hash",
            arr(["", "abc", "OMAVOTE"]
                .iter()
                .map(|i| obj(vec![("utf8", s(*i)), ("hash", s(to_hex(&ckb_hash(i.as_bytes()))))]))
                .collect()),
        ),
        (
            "domain_hash",
            arr(vec![obj(vec![
                ("prefix", s("OMAVOTE/BALLOT/V2\\0")),
                ("data_utf8", s("{}")),
                ("hash", s(to_hex(&domain_hash(domain::BALLOT, b"{}")))),
            ])]),
        ),
    ]);
    check_or_write("encoding.json", &v);
}

#[test]
fn script_and_address_vectors() {
    let scripts = [
        Script::new(NetworkParams::mainnet().secp256k1.code_hash, HashType::Type, vec![0xb3; 20]),
        Script::new([0x11; 32], HashType::Data1, vec![]),
        Script::new([0x22; 32], HashType::Data2, vec![1, 2, 3]),
    ];
    let v = arr(scripts
        .iter()
        .map(|sc| {
            obj(vec![
                ("script", sc.to_json()),
                ("molecule", s(to_hex(&sc.serialize()))),
                ("script_hash", s(to_hex(&sc.hash()))),
                ("mainnet_address", s(omavote_core::address::full_address("ckb", sc).unwrap())),
                ("testnet_address", s(omavote_core::address::full_address("ckt", sc).unwrap())),
            ])
        })
        .collect());
    check_or_write("scripts.json", &v);
}

#[test]
fn signature_vectors() {
    let text = "OMAVOTE VOTE YES #0011223344556677 1000CKB\nexample";
    let mut cases = Vec::new();
    for label in ["sig-a", "sig-b"] {
        let secret = adapter::test_secret(label);
        let ckb_sig = adapter::ckb_sign_message(&secret, text).unwrap();
        let evm_sig = adapter::evm_sign_message(&secret, text).unwrap();
        cases.push(obj(vec![
            ("secret", s(to_hex(&secret))),
            ("message_utf8", s(text)),
            ("ckb_digest", s(to_hex(&adapter::ckb_message_digest(text.as_bytes())))),
            ("ckb_signature", s(to_hex(&ckb_sig))),
            ("ckb_public_key", s(to_hex(&adapter::secp256k1_pubkey(&secret).unwrap()))),
            ("ckb_lock_args", s(to_hex(&adapter::secp256k1_lock_args(&secret).unwrap()))),
            ("evm_digest", s(to_hex(&adapter::evm_message_digest(text.as_bytes())))),
            ("evm_signature", s(to_hex(&evm_sig))),
            ("evm_address", s(to_hex(&adapter::evm_address(&secret).unwrap()))),
        ]));
    }
    check_or_write("signatures.json", &arr(cases));
}

/// Builds the replay scenario shared by the message and replay vectors.
struct Scenario {
    chain: TestChain,
    manifest: Manifest,
    payload: ManifestPayload,
    roles: ProcessRoles,
    messages: Vec<(String, Value, String, String)>,
}

fn scenario() -> Scenario {
    let committee: Vec<TestKey> = (0..3).map(|i| TestKey::evm(&format!("committee-{i}"))).collect();
    let coordinator = TestKey::secp("coordinator");
    let net = test_network();
    let roles = ProcessRoles::build(
        net.genesis_hash,
        None,
        (2, committee.iter().map(|k| k.descriptor.clone()).collect()),
        (1, vec![coordinator.descriptor.clone()]),
        [3; 32],
    )
    .unwrap();
    let rh = roles.roles_hash();
    let mut c = TestChain::with_config(T0, |cfg| cfg.initial_roles_hash = Some(rh));
    let alice = TestOwner::ckb("alice", &c.net);
    let bob = TestOwner::ckb("bob", &c.net);
    let carol = TestOwner::evm_omnilock("carol", &c.net);
    let key = TestKey::evm("voting-key");
    let key2 = TestKey::secp("voting-key-2");
    c.deposit(&alice.lock, 120_000);
    c.deposit(&alice.lock, 80_000);
    c.deposit(&bob.lock, 300_000);
    c.deposit(&carol.lock, 50_000);
    c.publish_policy();
    c.publish_roles(&roles);
    c.mine(HOUR);
    let mut messages = Vec::new();

    let anchor = c.tip_hash;
    let ga = c.grant(&alice, &key, 365 * DAY, anchor);
    let gb = c.grant(&bob, &key, 90 * DAY, anchor);
    c.publish_controls(&[ga.clone(), gb.clone()]);
    c.mine(HOUR);
    messages.push(("grant".into(), ga.to_json(), to_hex(&ga.body.authorization_id()), text::control_text(&ga.body, &c.net).unwrap()));

    let start = c.clock_ms + 6 * HOUR;
    let payload = c.manifest(&[&alice], start, TestChain::default_registry(), RulesParams { opening_confirmations: 2, ..RulesParams::default() }, 25_000);
    let m = payload.manifest.clone();
    c.publish_manifest(&payload);
    c.mine(HOUR);
    messages.push((
        "proposal".into(),
        payload.to_json(),
        to_hex(&m.poll_id()),
        text::proposal_text(&m, &alice.lock, &c.net).unwrap(),
    ));
    let anchor = c.tip_hash;
    let admit = c.record(&roles, Role::Coordinator, &[&coordinator], Some(m.poll_id()), RecordDetail::Admission { admitted: true }, anchor);
    c.publish_records(m.poll_id(), &[admit.clone()]);
    c.mine(HOUR);
    messages.push(("admission".into(), admit.to_json(), to_hex(&admit.body.record_id()), text::process_text(&admit.body).unwrap()));
    while c.clock_ms < m.start_ms {
        c.mine(HOUR);
    }
    // Delegate votes for alice and bob, a direct vote for carol (EVM owner).
    let anchor = c.tip_hash;
    let va = c.delegate_ballot(&m, &alice, &ga, &key, Action::Yes, anchor);
    let vb = c.delegate_ballot(&m, &bob, &gb, &key, Action::Yes, anchor);
    let vc = c.direct_ballot(&m, &carol, Action::No, anchor);
    c.publish_ballots(m.poll_id(), &[va.clone(), vb, vc.clone()]);
    c.mine(HOUR);
    messages.push(("delegate_ballot".into(), va.to_json(), to_hex(&va.body.ballot_id()), text::ballot_text(&m, &va.body, &c.net).unwrap()));
    messages.push(("direct_ballot".into(), vc.to_json(), to_hex(&vc.body.ballot_id()), text::ballot_text(&m, &vc.body, &c.net).unwrap()));
    // Bob swaps keys after suspecting a leak: GRANT+CANCEL, then votes No with the new key.
    let anchor = c.tip_hash;
    let gb2 = c.grant_cancel(&bob, &key2, 30 * DAY, anchor);
    c.publish_controls(&[gb2.clone()]);
    c.mine(HOUR);
    messages.push(("grant_cancel".into(), gb2.to_json(), to_hex(&gb2.body.authorization_id()), text::control_text(&gb2.body, &c.net).unwrap()));
    let anchor = c.tip_hash;
    let vb2 = c.delegate_ballot(&m, &bob, &gb2, &key2, Action::No, anchor);
    c.publish_ballots(m.poll_id(), &[vb2]);
    c.mine(HOUR);
    // Alice revokes STOP_ONLY: her earlier Yes is kept.
    let anchor = c.tip_hash;
    let ra = c.revoke(&alice, RevokeMode::StopOnly, anchor);
    c.publish_controls(&[ra.clone()]);
    c.mine(HOUR);
    messages.push(("revoke".into(), ra.to_json(), to_hex(&ra.body.authorization_id()), text::control_text(&ra.body, &c.net).unwrap()));
    // A rejected late delegate ballot for alice (no active grant).
    let anchor = c.tip_hash;
    let late = c.delegate_ballot(&m, &alice, &ga, &key, Action::No, anchor);
    c.publish_ballots(m.poll_id(), &[late]);
    c.mine(HOUR);
    while c.engine.polls[&m.poll_id()].close.is_none() {
        c.mine(HOUR);
    }
    let rc = tally::result_core(&c.engine, &m.poll_id()).unwrap().unwrap();
    let anchor = c.tip_hash;
    let att = c.record(&roles, Role::Committee, &[&committee[0], &committee[2]], Some(m.poll_id()), RecordDetail::ResultAttestation { result_hash: rc.result_hash(), pass: rc.tally.passed }, anchor);
    c.publish_records(m.poll_id(), &[att.clone()]);
    c.mine(HOUR);
    messages.push(("result_attestation".into(), att.to_json(), to_hex(&att.body.record_id()), text::process_text(&att.body).unwrap()));
    Scenario { chain: c, manifest: m, payload, roles, messages }
}

#[test]
fn message_vectors() {
    let sc = scenario();
    let mut items = vec![
        obj(vec![("name", s("auth_policy")), ("json", sc.chain.policy.to_json().clone()), ("hash", s(to_hex(&sc.chain.policy.hash())))]),
        obj(vec![("name", s("process_roles")), ("json", sc.roles.to_json().clone()), ("hash", s(to_hex(&sc.roles.roles_hash())))]),
        obj(vec![
            ("name", s("manifest")),
            ("json", sc.manifest.to_json().clone()),
            ("poll_id", s(to_hex(&sc.manifest.poll_id()))),
            ("rules_hash", s(to_hex(&sc.manifest.rules_hash()))),
            ("auth_registry_hash", s(to_hex(&sc.manifest.auth_registry_hash()))),
        ]),
    ];
    for (name, json, id, signed_text) in &sc.messages {
        items.push(obj(vec![("name", s(name.clone())), ("envelope", json.clone()), ("id", s(id.clone())), ("signed_text", s(signed_text.clone()))]));
    }
    let key = TestKey::evm("voting-key");
    items.push(obj(vec![
        ("name", s("key_descriptor")),
        ("json", key.descriptor.to_json()),
        ("key_id", s(to_hex(&key.id()))),
        ("key_display", s(key.descriptor.key_display(&sc.chain.net).unwrap())),
    ]));
    let _ = &sc.payload;
    check_or_write("messages.json", &obj(vec![("network", network_json(&sc.chain.net)), ("items", arr(items))]));
}

#[test]
fn carrier_vectors() {
    let payload = carrier::batch_payload(vec![obj(vec![("body", obj(vec![])), ("proof", obj(vec![]))])]);
    let h = carrier::Header { kind: Kind::BallotBatch, scope_id: [0x5a; 32], payload_hash: carrier::payload_hash(Kind::BallotBatch, &payload), witness_index: 1 };
    let v = obj(vec![
        ("kind", s("2")),
        ("scope_id", s(to_hex(&h.scope_id))),
        ("witness_index", s("1")),
        ("payload_utf8", s(String::from_utf8(payload.clone()).unwrap())),
        ("payload_hash", s(to_hex(&h.payload_hash))),
        ("header", s(to_hex(&h.encode()))),
    ]);
    check_or_write("carrier.json", &v);
}

#[test]
fn replay_vectors() {
    let sc = scenario();
    let c = &sc.chain;
    let poll_id = sc.manifest.poll_id();
    // Determinism: replaying the recorded blocks gives the same result.
    let mut fresh = Engine::new(c.engine.cfg.clone());
    for b in &c.blocks {
        fresh.process_block(b).unwrap();
    }
    let rc = tally::result_core(&fresh, &poll_id).unwrap().unwrap();
    let poll = &fresh.polls[&poll_id];
    let admission = match tally::admission(&fresh, poll) {
        tally::AdmissionView::Admitted(_) => "ADMITTED",
        tally::AdmissionView::Rejected(_) => "REJECTED",
        tally::AdmissionView::Missing => "MISSING",
        tally::AdmissionView::Conflict => "CONFLICT",
        tally::AdmissionView::Pending => "PENDING",
    };
    let attestation = match tally::attestation(&fresh, &poll_id, Some(&rc)) {
        tally::AttestationView::Confirmed(_) => "CONFIRMED",
        tally::AttestationView::Disputed(_) => "DISPUTED",
        tally::AttestationView::Conflict => "CONFLICT",
        tally::AttestationView::None => "NONE",
    };
    let diagnostics: Vec<Value> = fresh
        .diagnostics
        .iter()
        .map(|d| {
            obj(vec![
                ("height", s(dec(d.position.height))),
                ("kind", s(d.kind)),
                ("id", Value::opt_str(d.id.map(|h| to_hex(&h)))),
                ("code", s(d.code)),
            ])
        })
        .collect();
    let v = obj(vec![
        ("network", network_json(&c.net)),
        ("initial_roles_hash", s(to_hex(&sc.roles.roles_hash()))),
        ("process_publication_delay_ms", s(dec(MAX_PROCESS_PUBLICATION_DELAY_MS))),
        ("blocks", arr(c.blocks.iter().map(block_json).collect())),
        (
            "expected",
            obj(vec![
                ("poll_id", s(to_hex(&poll_id))),
                ("result_core", rc.value.clone()),
                ("result_hash", s(to_hex(&rc.result_hash()))),
                ("admission", s(admission)),
                ("attestation", s(attestation)),
                ("diagnostics", arr(diagnostics)),
            ]),
        ),
    ]);
    let status = |o: &str| {
        rc.value
            .as_object()
            .unwrap()
            .get("owners")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r.as_object().unwrap().get("owner_id").unwrap().as_str() == Some(o))
            .map(|r| r.as_object().unwrap().get("final_status").unwrap().as_str().unwrap().to_string())
    };
    let alice = TestOwner::ckb("alice", &c.net);
    let bob = TestOwner::ckb("bob", &c.net);
    assert_eq!(status(&to_hex(&alice.id())).as_deref(), Some("YES"));
    assert_eq!(status(&to_hex(&bob.id())).as_deref(), Some("NO"));
    assert_eq!(admission, "ADMITTED");
    assert_eq!(attestation, "CONFIRMED");
    let _ = jcs_bytes(&v);
    check_or_write("replay.json", &v);
}
