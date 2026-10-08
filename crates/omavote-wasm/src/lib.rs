//! JSON-in/JSON-out bindings so that the browser renders signed texts, computes IDs
//! and checks signatures with exactly the same code as the server and verifier.
//!
//! The browser builds message bodies as plain JSON objects (with every field present)
//! and asks the core to validate them, compute their IDs and render the text to sign.

use omavote_core::adapter;
use omavote_core::address;
use omavote_core::error::{Error, Result};
use omavote_core::hash::ckb_hash;
use omavote_core::json::{parse, to_jcs, Fields, Object, Value};
use omavote_core::messages::{short_id, BallotBody, ControlBody, KeyDescriptor, ProcessRecord};
use omavote_core::molecule::Script;
use omavote_core::network::NetworkParams;
use omavote_core::text;
use omavote_core::types::{AuthPolicy, AuthRegistry, ConfirmationPolicy, Manifest, ManifestDraft, ProposalType, RulesParams, RulesProfile};
use omavote_core::util::{dec, parse_dec_u128, parse_dec_u64, parse_hash, parse_hex, parse_hex_fixed, to_hex, utc_ms};

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

fn field<'a>(p: &'a Value, key: &str) -> Result<&'a Value> {
    p.as_object().and_then(|o| o.get(key)).ok_or_else(|| Error::format(format!("missing parameter {key}")))
}

fn str_param<'a>(p: &'a Value, key: &str) -> Result<&'a str> {
    field(p, key)?.as_str().ok_or_else(|| Error::format(format!("parameter {key} must be a string")))
}

fn network(p: &Value) -> Result<NetworkParams> {
    NetworkParams::from_json(field(p, "network")?)
}

fn manifest(p: &Value) -> Result<Manifest> {
    Manifest::from_json(field(p, "manifest")?)
}

fn sig65(p: &Value) -> Result<[u8; 65]> {
    parse_hex_fixed::<65>(str_param(p, "signature")?, "signature")
}

fn key_info(k: &KeyDescriptor, net: Option<&NetworkParams>) -> Result<Value> {
    let mut pairs = vec![("descriptor", k.to_json()), ("key_id", s(to_hex(&k.key_id()))), ("adapter", s(k.adapter_id()))];
    if let Some(n) = net {
        pairs.push(("key_display", s(k.key_display(n)?)));
        pairs.push(("key_short", s(k.key_short(n)?)));
    }
    Ok(obj(pairs))
}

fn manifest_info(m: &Manifest, net: Option<&NetworkParams>) -> Result<Value> {
    let poll_id = m.poll_id();
    let mut pairs = vec![
        ("poll_id", s(to_hex(&poll_id))),
        ("short_id", s(short_id(&poll_id))),
        ("rules_hash", s(to_hex(&m.rules_hash()))),
        ("auth_policy_hash", s(to_hex(&m.auth_policy_hash()))),
        ("auth_registry_hash", s(to_hex(&m.auth_registry_hash()))),
        ("proposal_type", s(m.proposal_type.as_str())),
        ("budget_ckb", s(text::render_ckb(m.budget_ckb_shannon))),
        ("quorum_required_shannon", s(dec(m.quorum_required()))),
        ("start_ms", s(dec(m.start_ms))),
        ("end_ms", s(dec(m.end_ms))),
        ("delegate_end_ms", s(dec(m.delegate_end_ms()))),
        ("start_utc", s(utc_ms(m.start_ms)?)),
        ("end_utc", s(utc_ms(m.end_ms)?)),
    ];
    if let (Some(n), Some(r)) = (net, &m.recipient_lock_script) {
        pairs.push(("recipient_address", s(n.address(r)?)));
    }
    Ok(obj(pairs))
}

fn manifest_from_draft(p: &Value) -> Result<Manifest> {
    let d = field(p, "draft")?;
    let mut f = Fields::new(d, "manifest draft")?;
    let genesis = parse_hash(f.str("genesis")?, "genesis")?;
    let nonce = parse_hash(f.str("nonce")?, "nonce")?;
    let proposal_type = match f.str("proposal_type")? {
        "grant" => ProposalType::Grant,
        "meta_rule" => ProposalType::MetaRule,
        other => return Err(Error::format(format!("unknown proposal_type {other}"))),
    };
    let title = f.str("title")?.to_string();
    let signing_title = f.str("signing_title")?.to_string();
    let content_hash = parse_hash(f.str("content_hash")?, "content_hash")?;
    let content_locations = f
        .array("content_locations")?
        .iter()
        .map(|x| x.as_str().map(str::to_string).ok_or_else(|| Error::format("content location must be a string")))
        .collect::<Result<Vec<_>>>()?;
    let forum_topic_id = f.str("forum_topic_id")?.to_string();
    let forum_revision = f.str("forum_revision")?.to_string();
    let opt_hash = |v: Option<&str>| -> Result<Option<[u8; 32]>> { v.map(|x| parse_hash(x, "hash")).transpose() };
    let discussion_evidence_hash = opt_hash(f.opt_str("discussion_evidence_hash")?)?;
    let budget_ckb_shannon = parse_dec_u128(f.str("budget_ckb_shannon")?, "budget_ckb_shannon")?;
    let quorum_base_shannon = parse_dec_u128(f.str("quorum_base_shannon")?, "quorum_base_shannon")?;
    let payment_terms_hash = opt_hash(f.opt_str("payment_terms_hash")?)?;
    let recipient_lock_script = match f.value("recipient_lock_script")? {
        Value::Null => None,
        v => Some(Script::from_json(v)?),
    };
    let proposer_owner_locks = f.array("proposer_owner_locks")?.iter().map(Script::from_json).collect::<Result<Vec<_>>>()?;
    let rules = RulesProfile::from_json(f.value("rules_profile")?)?;
    let auth_registry = AuthRegistry::from_json(f.value("auth_registry")?)?;
    let auth_policy = AuthPolicy::from_json(f.value("authorization_policy")?)?;
    let start_ms = parse_dec_u64(f.str("start_ms")?, "start_ms")?;
    let result_confirmations = parse_dec_u64(f.str("result_confirmations")?, "result_confirmations")?;
    let review_window_ms = parse_dec_u64(f.str("review_window_ms")?, "review_window_ms")?;
    f.finish()?;
    ManifestDraft {
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
        start_ms,
        confirmation: ConfirmationPolicy { result_confirmations, review_window_ms },
    }
    .build()
}

/// Dispatch one call. Every method returns a JSON object.
pub fn dispatch(method: &str, p: &Value) -> Result<Value> {
    match method {
        "jcs" => Ok(obj(vec![("jcs", s(to_jcs(field(p, "value")?)))])),
        "ckb_hash" => Ok(obj(vec![("hash", s(to_hex(&ckb_hash(&parse_hex(str_param(p, "data")?, "data")?))))])),
        "utc" => Ok(obj(vec![("utc", s(utc_ms(parse_dec_u64(str_param(p, "ms")?, "ms")?)?))])),
        "render_ckb" => Ok(obj(vec![("ckb", s(text::render_ckb(parse_dec_u128(str_param(p, "shannon")?, "shannon")?)))])),
        "known_network" => {
            let n = match str_param(p, "name")? {
                "mainnet" => NetworkParams::mainnet(),
                "testnet" => NetworkParams::testnet(),
                other => return Err(Error::format(format!("unknown network {other}"))),
            };
            Ok(n.to_json())
        }
        "address" => {
            let net = network(p)?;
            Ok(obj(vec![("address", s(net.address(&Script::from_json(field(p, "script")?)?)?))]))
        }
        "parse_address" => {
            let (hrp, script) = address::parse_full_address(str_param(p, "address")?)?;
            Ok(obj(vec![("hrp", s(hrp)), ("script", script.to_json()), ("script_hash", s(to_hex(&script.hash())))]))
        }
        "script_hash" => Ok(obj(vec![("hash", s(to_hex(&Script::from_json(field(p, "script")?)?.hash())))])),
        "secp256k1_lock" => {
            let net = network(p)?;
            let pk = parse_hex_fixed::<33>(str_param(p, "public_key")?, "public_key")?;
            adapter::validate_compressed_pubkey(&pk)?;
            let lock = net.secp256k1.with_args(omavote_core::hash::blake160(&pk).to_vec());
            Ok(obj(vec![("script", lock.to_json()), ("address", s(net.address(&lock)?)), ("owner_id", s(to_hex(&lock.hash())))]))
        }
        "evm_owner_locks" => {
            let net = network(p)?;
            let addr = parse_hex_fixed::<20>(&str_param(p, "address")?.to_lowercase(), "address")?;
            let locks: Vec<Value> = adapter::evm_owner_scripts(&net, &addr)
                .iter()
                .map(|l| Ok(obj(vec![("script", l.to_json()), ("address", s(net.address(l)?)), ("owner_id", s(to_hex(&l.hash())))])))
                .collect::<Result<_>>()?;
            Ok(obj(vec![("locks", Value::Array(locks))]))
        }
        "default_rules" => {
            let mut params = RulesParams::default();
            if let Some(Value::String(v)) = p.as_object().and_then(|o| o.get("opening_confirmations")) {
                params.opening_confirmations = parse_dec_u64(v, "opening_confirmations")?;
            }
            if let Some(Value::String(v)) = p.as_object().and_then(|o| o.get("voting_period_ms")) {
                params.voting_period_ms = parse_dec_u64(v, "voting_period_ms")?;
            }
            let r = RulesProfile::build(&params);
            Ok(obj(vec![("rules_profile", r.to_json().clone()), ("rules_hash", s(to_hex(&r.hash())))]))
        }
        "auth_policy" => {
            let pol = AuthPolicy::build(parse_hash(str_param(p, "genesis")?, "genesis")?);
            Ok(obj(vec![("policy", pol.to_json().clone()), ("hash", s(to_hex(&pol.hash())))]))
        }
        "registry" => {
            let r = AuthRegistry::from_json(field(p, "registry")?)?;
            Ok(obj(vec![("registry", r.to_json()), ("hash", s(to_hex(&r.hash())))]))
        }
        "manifest_from_draft" => {
            let m = manifest_from_draft(p)?;
            let net = p.as_object().and_then(|o| o.get("network")).map(NetworkParams::from_json).transpose()?;
            Ok(obj(vec![("manifest", m.to_json().clone()), ("info", manifest_info(&m, net.as_ref())?)]))
        }
        "manifest_info" => {
            let m = manifest(p)?;
            let net = p.as_object().and_then(|o| o.get("network")).map(NetworkParams::from_json).transpose()?;
            manifest_info(&m, net.as_ref())
        }
        "proposal_text" => {
            let net = network(p)?;
            let m = manifest(p)?;
            let lock = Script::from_json(field(p, "proposer_lock")?)?;
            Ok(obj(vec![("text", s(text::proposal_text(&m, &lock, &net)?))]))
        }
        "ballot" => {
            let net = network(p)?;
            let m = manifest(p)?;
            let b = BallotBody::from_json(field(p, "body")?)?;
            let t = text::ballot_text(&m, &b, &net)?;
            Ok(obj(vec![
                ("body", b.to_json().clone()),
                ("ballot_id", s(to_hex(&b.ballot_id()))),
                ("owner_id", s(to_hex(&b.owner_id()))),
                ("summary", s(t.lines().next().unwrap_or_default())),
                ("text", s(t)),
            ]))
        }
        "control" => {
            let net = network(p)?;
            let c = ControlBody::from_json(field(p, "body")?)?;
            let t = text::control_text(&c, &net)?;
            Ok(obj(vec![
                ("body", c.to_json().clone()),
                ("authorization_id", s(to_hex(&c.authorization_id()))),
                ("owner_id", s(to_hex(&c.owner_id()))),
                ("summary", s(t.lines().next().unwrap_or_default())),
                ("text", s(t)),
            ]))
        }
        "record" => {
            let r = ProcessRecord::from_json(field(p, "body")?)?;
            let t = text::process_text(&r)?;
            Ok(obj(vec![("body", r.to_json().clone()), ("record_id", s(to_hex(&r.record_id()))), ("text", s(t))]))
        }
        "key" => {
            let k = KeyDescriptor::from_json(field(p, "descriptor")?)?;
            let net = p.as_object().and_then(|o| o.get("network")).map(NetworkParams::from_json).transpose()?;
            key_info(&k, net.as_ref())
        }
        "evm_key" => {
            let addr = parse_hex_fixed::<20>(&str_param(p, "address")?.to_lowercase(), "address")?;
            let net = p.as_object().and_then(|o| o.get("network")).map(NetworkParams::from_json).transpose()?;
            key_info(&KeyDescriptor::EvmEoa { address: addr }, net.as_ref())
        }
        "verify_owner" => {
            let net = network(p)?;
            let lock = Script::from_json(field(p, "owner_lock")?)?;
            let r = adapter::verify_owner_signature(str_param(p, "adapter")?, &net, &lock, str_param(p, "text")?, &sig65(p)?);
            Ok(obj(vec![("ok", Value::Bool(r.is_ok())), ("error", Value::opt_str(r.err().map(|e| e.to_string())))]))
        }
        "verify_key" => {
            let k = KeyDescriptor::from_json(field(p, "descriptor")?)?;
            let r = adapter::verify_key_signature(&k, str_param(p, "text")?, &sig65(p)?);
            Ok(obj(vec![("ok", Value::Bool(r.is_ok())), ("error", Value::opt_str(r.err().map(|e| e.to_string())))]))
        }
        "recover_evm" => {
            let a = adapter::recover_evm(str_param(p, "text")?.as_bytes(), &sig65(p)?)?;
            Ok(obj(vec![("address", s(to_hex(&a))), ("checksum_address", s(address::eip55(&a)))]))
        }
        "recover_ckb" => {
            let pk = adapter::recover_ckb(str_param(p, "text")?.as_bytes(), &sig65(p)?)?;
            Ok(obj(vec![("public_key", s(to_hex(&pk))), ("lock_args", s(to_hex(&omavote_core::hash::blake160(&pk))))]))
        }
        "receipt_signer" => {
            // Relay receipts: secp256k1 recoverable signature over
            // H("OMAVOTE/RELAY-RECEIPT/V2\0" || JCS(body)); returns the signer key.
            let body = field(p, "body")?;
            let digest = omavote_core::hash::domain_hash(omavote_core::hash::domain::RELAY_RECEIPT, &omavote_core::json::jcs_bytes(body));
            let pk = adapter::recover_digest(&digest, &sig65(p)?)?;
            Ok(obj(vec![("public_key", s(to_hex(&pk)))]))
        }
        "nonce" => {
            // 32 random bytes from the platform RNG (crypto.getRandomValues in browsers).
            let mut n = [0u8; 32];
            getrandom_fill(&mut n)?;
            Ok(obj(vec![("nonce", s(to_hex(&n)))]))
        }
        other => Err(Error::format(format!("unknown method {other}"))),
    }
}

fn getrandom_fill(buf: &mut [u8]) -> Result<()> {
    getrandom::getrandom(buf).map_err(|_| Error::format("random number generator unavailable"))
}

/// String-level entry point shared by the WASM export and native callers.
pub fn call_json(method: &str, params_json: &str) -> std::result::Result<String, String> {
    let params = parse(params_json.as_bytes()).map_err(|e| e.to_string())?;
    dispatch(method, &params).map(|v| to_jcs(&v)).map_err(|e| e.to_string())
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use wasm_bindgen::prelude::*;

    /// `call(method, paramsJson)` returns a JSON string or throws an error message.
    #[wasm_bindgen]
    pub fn call(method: &str, params_json: &str) -> Result<String, JsValue> {
        super::call_json(method, params_json).map_err(|e| JsValue::from_str(&e))
    }

    #[wasm_bindgen]
    pub fn version() -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use omavote_core::testkit::{test_network, TestChain, TestOwner};

    #[test]
    fn ballot_roundtrip_matches_core() {
        let mut c = TestChain::new(1_800_000_000_000);
        let a = TestOwner::ckb("alice", &c.net);
        c.deposit(&a.lock, 200_000);
        c.publish_policy();
        c.mine(3_600_000);
        let start = c.clock_ms + 10 * 3_600_000;
        let p = c.manifest(&[&a], start, TestChain::default_registry(), RulesParams::default(), 1000);
        let anchor = c.tip_hash;
        let env = c.direct_ballot(&p.manifest, &a, omavote_core::messages::Action::Yes, anchor);
        let params = format!(
            r#"{{"network":{},"manifest":{},"body":{}}}"#,
            to_jcs(&test_network().to_json()),
            to_jcs(p.manifest.to_json()),
            to_jcs(env.body.to_json())
        );
        let out = parse(call_json("ballot", &params).unwrap().as_bytes()).unwrap();
        let text = out.as_object().unwrap().get("text").unwrap().as_str().unwrap().to_string();
        assert_eq!(text, text::ballot_text(&p.manifest, &env.body, &c.net).unwrap());
        let verify = format!(
            r#"{{"network":{},"adapter":"ckb-secp256k1-message-v1","owner_lock":{},"text":{},"signature":"{}"}}"#,
            to_jcs(&test_network().to_json()),
            to_jcs(&a.lock.to_json()),
            to_jcs(&Value::str(text)),
            to_hex(&env.proof.signature)
        );
        let v = parse(call_json("verify_owner", &verify).unwrap().as_bytes()).unwrap();
        assert_eq!(v.as_object().unwrap().get("ok"), Some(&Value::Bool(true)));
    }
}
