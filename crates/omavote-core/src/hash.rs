//! CKB Blake2b-256 (personalization `ckb-default-hash`), domain-separated hashes and Keccak-256.

use crate::util::Hash32;

pub const CKB_PERSONALIZATION: &[u8; 16] = b"ckb-default-hash";

/// Domain prefixes. Each ends with a NUL byte so that no prefix is a prefix of another.
pub mod domain {
    pub const RULES: &[u8] = b"OMAVOTE/RULES/V2\0";
    pub const POLL: &[u8] = b"OMAVOTE/POLL/V2\0";
    pub const BALLOT: &[u8] = b"OMAVOTE/BALLOT/V2\0";
    pub const KEY: &[u8] = b"OMAVOTE/KEY/V2\0";
    pub const AUTHORIZATION: &[u8] = b"OMAVOTE/AUTHORIZATION/V2\0";
    pub const AUTH_POLICY: &[u8] = b"OMAVOTE/AUTH-POLICY/V2\0";
    pub const AUTH_REGISTRY: &[u8] = b"OMAVOTE/AUTH-REGISTRY/V2\0";
    pub const ROLES: &[u8] = b"OMAVOTE/ROLES/V2\0";
    pub const PROCESS: &[u8] = b"OMAVOTE/PROCESS/V2\0";
    pub const PAYLOAD: &[u8] = b"OMAVOTE/PAYLOAD/V2\0";
    pub const RESULT: &[u8] = b"OMAVOTE/RESULT/V2\0";
    pub const WEBAUTHN_BALLOT: &[u8] = b"OMAVOTE/WEBAUTHN/BALLOT/V2\0";
    /// Relay receipts (service accountability evidence; not part of any protocol ID).
    pub const RELAY_RECEIPT: &[u8] = b"OMAVOTE/RELAY-RECEIPT/V2\0";
}

/// Incremental CKB Blake2b-256.
pub struct CkbHasher(blake2b_simd::State);

impl CkbHasher {
    pub fn new() -> Self {
        CkbHasher(
            blake2b_simd::Params::new()
                .hash_length(32)
                .personal(CKB_PERSONALIZATION)
                .to_state(),
        )
    }
    pub fn update(&mut self, data: &[u8]) -> &mut Self {
        self.0.update(data);
        self
    }
    pub fn finalize(&self) -> Hash32 {
        let mut out = [0u8; 32];
        out.copy_from_slice(self.0.finalize().as_bytes());
        out
    }
}

impl Default for CkbHasher {
    fn default() -> Self {
        Self::new()
    }
}

pub fn ckb_hash(data: &[u8]) -> Hash32 {
    let mut h = CkbHasher::new();
    h.update(data);
    h.finalize()
}

/// `H(prefix || data)`.
pub fn domain_hash(prefix: &[u8], data: &[u8]) -> Hash32 {
    let mut h = CkbHasher::new();
    h.update(prefix).update(data);
    h.finalize()
}

/// First 20 bytes of the CKB hash, as used for secp256k1 lock args.
pub fn blake160(data: &[u8]) -> [u8; 20] {
    let h = ckb_hash(data);
    let mut out = [0u8; 20];
    out.copy_from_slice(&h[..20]);
    out
}

pub fn keccak256(data: &[u8]) -> [u8; 32] {
    use tiny_keccak::{Hasher, Keccak};
    let mut k = Keccak::v256();
    k.update(data);
    let mut out = [0u8; 32];
    k.finalize(&mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::to_hex;

    #[test]
    fn ckb_hash_of_empty_input() {
        // Well-known CKB constant: blake2b-256("") with personalization "ckb-default-hash".
        assert_eq!(
            to_hex(&ckb_hash(b"")),
            "0x44f4c69744d5f8c55d642062949dcae49bc4e7ef43d388c5a12f42b5633d163e"
        );
    }

    #[test]
    fn keccak_of_empty_input() {
        assert_eq!(
            to_hex(&keccak256(b"")),
            "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
        );
    }
}
