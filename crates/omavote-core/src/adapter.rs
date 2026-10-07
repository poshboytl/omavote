//! Signature adapters (docs/03 §5.1). Each adapter ID fixes the message domain,
//! the signature encoding and how a recovered signer matches an owner lock or key.

use k256::ecdsa::{RecoveryId, Signature, SigningKey, VerifyingKey};

use crate::error::{Error, Result};
use crate::hash::{blake160, ckb_hash, keccak256, CkbHasher};
use crate::messages::KeyDescriptor;
use crate::molecule::Script;
use crate::network::NetworkParams;

pub const CKB_SECP256K1_MESSAGE_V1: &str = "ckb-secp256k1-message-v1";
pub const EVM_PERSONAL_MESSAGE_V1: &str = "evm-personal-message-v1";
pub const WEBAUTHN_ES256_V2: &str = "webauthn-es256-v2";

/// Prefix Neuron prepends before hashing a signed message.
pub const NERVOS_MESSAGE_PREFIX: &[u8] = b"Nervos Message:";

/// Every adapter ID defined by the V2 specification.
pub fn is_defined_adapter(id: &str) -> bool {
    matches!(id, CKB_SECP256K1_MESSAGE_V1 | EVM_PERSONAL_MESSAGE_V1 | WEBAUTHN_ES256_V2)
}

/// Global, append-only set of owner adapters accepted for authorization controls,
/// with the block height from which each one is effective (docs/03 §5.1).
pub const CONTROL_ADAPTERS: &[(&str, u64)] = &[(CKB_SECP256K1_MESSAGE_V1, 0), (EVM_PERSONAL_MESSAGE_V1, 0)];

pub fn is_control_adapter(id: &str, height: u64) -> bool {
    CONTROL_ADAPTERS.iter().any(|(a, h)| *a == id && height >= *h)
}

pub fn validate_compressed_pubkey(pk: &[u8; 33]) -> Result<()> {
    if pk[0] != 0x02 && pk[0] != 0x03 {
        return Err(Error::format("public key must be a compressed secp256k1 point"));
    }
    VerifyingKey::from_sec1_bytes(pk).map_err(|_| Error::format("invalid secp256k1 public key"))?;
    Ok(())
}

/// Digest signed by Neuron's "Sign Message": CKB hash of the prefix followed by the UTF-8 text.
pub fn ckb_message_digest(text: &[u8]) -> [u8; 32] {
    let mut h = CkbHasher::new();
    h.update(NERVOS_MESSAGE_PREFIX).update(text);
    h.finalize()
}

/// EIP-191 personal_sign digest.
pub fn evm_message_digest(text: &[u8]) -> [u8; 32] {
    let mut data = format!("\x19Ethereum Signed Message:\n{}", text.len()).into_bytes();
    data.extend_from_slice(text);
    keccak256(&data)
}

fn recover(digest: &[u8; 32], rs: &[u8], recid: u8) -> Result<VerifyingKey> {
    let mut sig = Signature::from_slice(rs).map_err(|_| Error::signature("malformed signature"))?;
    let mut recid = recid;
    // Accept high-s encodings by normalising; the recovered key is unchanged.
    if let Some(normalized) = sig.normalize_s() {
        sig = normalized;
        recid ^= 1;
    }
    let rid = RecoveryId::from_byte(recid).ok_or_else(|| Error::signature("invalid recovery id"))?;
    VerifyingKey::recover_from_prehash(digest, &sig, rid).map_err(|_| Error::signature("public key recovery failed"))
}

fn compressed(vk: &VerifyingKey) -> [u8; 33] {
    let ep = vk.to_encoded_point(true);
    let mut out = [0u8; 33];
    out.copy_from_slice(ep.as_bytes());
    out
}

fn evm_address_of(vk: &VerifyingKey) -> [u8; 20] {
    let ep = vk.to_encoded_point(false);
    let h = keccak256(&ep.as_bytes()[1..]);
    let mut out = [0u8; 20];
    out.copy_from_slice(&h[12..]);
    out
}

/// Recover the compressed public key of a CKB message signature (`r || s || v`, v in {0,1}).
pub fn recover_ckb(text: &[u8], sig: &[u8; 65]) -> Result<[u8; 33]> {
    if sig[64] > 1 {
        return Err(Error::signature("CKB signatures use recovery id 0 or 1"));
    }
    Ok(compressed(&recover(&ckb_message_digest(text), &sig[..64], sig[64])?))
}

/// Recover the compressed public key of a recoverable signature over a 32-byte digest
/// (relay receipts; v in {0,1}).
pub fn recover_digest(digest: &[u8; 32], sig: &[u8; 65]) -> Result<[u8; 33]> {
    if sig[64] > 1 {
        return Err(Error::signature("recovery id must be 0 or 1"));
    }
    Ok(compressed(&recover(digest, &sig[..64], sig[64])?))
}

/// Recover the address of an EIP-191 signature (`r || s || v`, v in {27,28} or {0,1}).
pub fn recover_evm(text: &[u8], sig: &[u8; 65]) -> Result<[u8; 20]> {
    let v = match sig[64] {
        27 | 28 => sig[64] - 27,
        0 | 1 => sig[64],
        _ => return Err(Error::signature("invalid EVM signature v")),
    };
    Ok(evm_address_of(&recover(&evm_message_digest(text), &sig[..64], v)?))
}

/// Owner scripts an EVM address may control under `evm-personal-message-v1`:
/// Omnilock in plain Ethereum auth mode (args = 0x01 || address || 0x00) and PW Lock (args = address).
pub fn evm_owner_scripts(network: &NetworkParams, addr: &[u8; 20]) -> Vec<Script> {
    let mut v = Vec::new();
    if let Some(omni) = network.omnilock {
        let mut args = vec![0x01];
        args.extend_from_slice(addr);
        args.push(0x00);
        v.push(omni.with_args(args));
    }
    if let Some(pw) = network.pw_lock {
        v.push(pw.with_args(addr.to_vec()));
    }
    v
}

/// Verify that `sig` over `text` was produced by whoever controls `owner` under `adapter_id`.
pub fn verify_owner_signature(
    adapter_id: &str,
    network: &NetworkParams,
    owner: &Script,
    text: &str,
    sig: &[u8; 65],
) -> Result<()> {
    match adapter_id {
        CKB_SECP256K1_MESSAGE_V1 => {
            let pk = recover_ckb(text.as_bytes(), sig)?;
            let expected = network.secp256k1.with_args(blake160(&pk).to_vec());
            if &expected != owner {
                return Err(Error::signature("signature does not belong to the owner lock"));
            }
            Ok(())
        }
        EVM_PERSONAL_MESSAGE_V1 => {
            let addr = recover_evm(text.as_bytes(), sig)?;
            if !evm_owner_scripts(network, &addr).iter().any(|s| s == owner) {
                return Err(Error::signature("signature does not belong to the owner lock"));
            }
            Ok(())
        }
        WEBAUTHN_ES256_V2 => Err(Error::unsupported("webauthn owner signatures")),
        other => Err(Error::format(format!("undefined adapter {other}"))),
    }
}

/// Verify a signature made by a voting or process key.
pub fn verify_key_signature(key: &KeyDescriptor, text: &str, sig: &[u8; 65]) -> Result<()> {
    match key {
        KeyDescriptor::Secp256k1 { public_key } => {
            if &recover_ckb(text.as_bytes(), sig)? != public_key {
                return Err(Error::signature("signature does not match the key descriptor"));
            }
            Ok(())
        }
        KeyDescriptor::EvmEoa { address } => {
            if &recover_evm(text.as_bytes(), sig)? != address {
                return Err(Error::signature("signature does not match the key descriptor"));
            }
            Ok(())
        }
    }
}

// ---------------------------------------------------------------------------
// Signing helpers (tests, vectors, development tools and the relay)

fn signing_key(secret: &[u8; 32]) -> Result<SigningKey> {
    SigningKey::from_slice(secret).map_err(|_| Error::format("invalid secp256k1 secret key"))
}

pub fn sign_digest_recoverable(secret: &[u8; 32], digest: &[u8; 32]) -> Result<[u8; 65]> {
    let sk = signing_key(secret)?;
    let (sig, rid) = sk
        .sign_prehash_recoverable(digest)
        .map_err(|_| Error::signature("signing failed"))?;
    let mut out = [0u8; 65];
    out[..64].copy_from_slice(&sig.to_bytes());
    out[64] = rid.to_byte();
    Ok(out)
}

pub fn ckb_sign_message(secret: &[u8; 32], text: &str) -> Result<[u8; 65]> {
    sign_digest_recoverable(secret, &ckb_message_digest(text.as_bytes()))
}

pub fn evm_sign_message(secret: &[u8; 32], text: &str) -> Result<[u8; 65]> {
    let mut sig = sign_digest_recoverable(secret, &evm_message_digest(text.as_bytes()))?;
    sig[64] += 27;
    Ok(sig)
}

pub fn secp256k1_pubkey(secret: &[u8; 32]) -> Result<[u8; 33]> {
    Ok(compressed(signing_key(secret)?.verifying_key()))
}

pub fn evm_address(secret: &[u8; 32]) -> Result<[u8; 20]> {
    Ok(evm_address_of(signing_key(secret)?.verifying_key()))
}

/// Standard secp256k1_blake160 lock args for a secret key.
pub fn secp256k1_lock_args(secret: &[u8; 32]) -> Result<[u8; 20]> {
    Ok(blake160(&secp256k1_pubkey(secret)?))
}

/// Deterministic test secret derived from a label (never use for real funds).
pub fn test_secret(label: &str) -> [u8; 32] {
    let mut s = ckb_hash(label.as_bytes());
    // Make sure the value is a valid scalar (practically always the case).
    if s == [0u8; 32] {
        s[31] = 1;
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ckb_message_roundtrip() {
        let sk = test_secret("alice");
        let sig = ckb_sign_message(&sk, "hello").unwrap();
        assert_eq!(recover_ckb(b"hello", &sig).unwrap(), secp256k1_pubkey(&sk).unwrap());
        assert_ne!(recover_ckb(b"hellO", &sig).unwrap_or([0; 33]), secp256k1_pubkey(&sk).unwrap());
    }

    #[test]
    fn evm_message_roundtrip_and_known_vector() {
        // Well-known: private key 0x...01 has address 0x7e5f4552091a69125d5dfcb7b8c2659029395bdf.
        let mut one = [0u8; 32];
        one[31] = 1;
        assert_eq!(crate::util::to_hex(&evm_address(&one).unwrap()), "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf");
        let sig = evm_sign_message(&one, "hello").unwrap();
        assert!(sig[64] == 27 || sig[64] == 28);
        assert_eq!(recover_evm(b"hello", &sig).unwrap(), evm_address(&one).unwrap());
    }

    #[test]
    fn high_s_signature_is_normalised() {
        let sk = test_secret("bob");
        let mut sig = ckb_sign_message(&sk, "x").unwrap();
        // Flip to the high-s form: s' = n - s, v' = v ^ 1.
        let s = Signature::from_slice(&sig[..64]).unwrap();
        let n_minus_s = -*s.s();
        let high = Signature::from_scalars(s.r().to_bytes(), n_minus_s.to_bytes()).unwrap();
        sig[..64].copy_from_slice(&high.to_bytes());
        sig[64] ^= 1;
        assert_eq!(recover_ckb(b"x", &sig).unwrap(), secp256k1_pubkey(&sk).unwrap());
    }
}
