//! Vectors produced outside this repository (wallet and SDK outputs), see vectors/external.json.

use omavote_core::adapter::{ckb_message_digest, ckb_sign_message, evm_message_digest, evm_sign_message, recover_ckb, recover_evm};
use omavote_core::address::eip55;
use omavote_core::hash::{blake160, ckb_hash};
use omavote_core::json::{parse, Value};
use omavote_core::molecule::WitnessArgs;
use omavote_core::util::{parse_hex, parse_hex_fixed, to_hex};

fn load() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../vectors/external.json");
    parse(&std::fs::read(path).unwrap()).unwrap()
}

fn items<'a>(v: &'a Value, key: &str) -> &'a Vec<Value> {
    v.as_object().unwrap().get(key).unwrap().as_array().unwrap()
}

fn get<'a>(v: &'a Value, key: &str) -> &'a str {
    v.as_object().unwrap().get(key).unwrap().as_str().unwrap()
}

#[test]
fn ckb_hash_vectors() {
    let v = load();
    for it in items(&v, "ckb_hash") {
        assert_eq!(to_hex(&ckb_hash(&parse_hex(get(it, "data"), "d").unwrap())), get(it, "hash"));
    }
}

#[test]
fn neuron_vectors() {
    let v = load();
    for it in items(&v, "neuron") {
        let text = get(it, "text");
        assert_eq!(to_hex(&ckb_message_digest(text.as_bytes())), get(it, "digest"));
        let secret = parse_hex_fixed::<32>(get(it, "secret"), "s").unwrap();
        let sig = ckb_sign_message(&secret, text).unwrap();
        assert_eq!(to_hex(&sig), get(it, "signature"), "deterministic RFC 6979 signature matches Neuron/lumos");
        let pk = recover_ckb(text.as_bytes(), &sig).unwrap();
        assert_eq!(to_hex(&pk), get(it, "pubkey"));
        assert_eq!(to_hex(&blake160(&pk)), get(it, "lock_args"));
    }
}

#[test]
fn eip191_vectors() {
    let v = load();
    for it in items(&v, "eip191") {
        let text = get(it, "text");
        assert_eq!(to_hex(&evm_message_digest(text.as_bytes())), get(it, "digest"));
        let secret = parse_hex_fixed::<32>(get(it, "secret"), "s").unwrap();
        let sig = evm_sign_message(&secret, text).unwrap();
        assert_eq!(to_hex(&sig), get(it, "signature"));
        let addr = recover_evm(text.as_bytes(), &sig).unwrap();
        assert_eq!(to_hex(&addr), get(it, "address"));
        assert_eq!(eip55(&addr), get(it, "checksum_address"));
    }
}

#[test]
fn high_s_signatures_are_equivalent() {
    // (r, n - s, v ^ 1) recovers the same key; the chain's secp256k1 lock accepts it too.
    let v = load();
    let it = &items(&v, "neuron")[0];
    let text = get(it, "text");
    let mut sig = parse_hex_fixed::<65>(get(it, "signature"), "sig").unwrap();
    let n = parse_hex_fixed::<32>("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141", "n").unwrap();
    let mut s = [0u8; 32];
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let d = n[i] as i16 - sig[32 + i] as i16 - borrow;
        s[i] = d.rem_euclid(256) as u8;
        borrow = if d < 0 { 1 } else { 0 };
    }
    sig[32..64].copy_from_slice(&s);
    sig[64] ^= 1;
    assert_eq!(to_hex(&recover_ckb(text.as_bytes(), &sig).unwrap()), get(it, "pubkey"));
}

#[test]
fn witness_args_vectors() {
    let v = load();
    for it in items(&v, "witness_args") {
        let lock = match it.as_object().unwrap().get("lock").unwrap() {
            Value::Null => None,
            l => Some(parse_hex(l.as_str().unwrap(), "lock").unwrap()),
        };
        let w = WitnessArgs { lock, input_type: None, output_type: None };
        assert_eq!(to_hex(&w.serialize()), get(it, "serialized"));
    }
}
