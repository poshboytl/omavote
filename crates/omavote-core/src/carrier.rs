//! On-chain carriers (docs/03 §7): a 78-byte header in an ordinary cell's data
//! that commits to a canonical JSON payload stored in one witness of the same transaction.

use crate::error::{Error, Result};
use crate::hash::{domain, CkbHasher};
use crate::json::{jcs_bytes, parse_canonical, Fields, Object, Value};
use crate::messages::{BallotEnvelope, ControlEnvelope, ManifestPayload, ProcessEnvelope, ProcessRoles};
use crate::types::{AuthPolicy, PROTOCOL_VERSION};
use crate::util::Hash32;

pub const MAGIC: &[u8; 8] = b"OMAVOTE\0";
pub const HEADER_LEN: usize = 78;
pub const VERSION: u8 = 2;
pub const MAX_WITNESS_BYTES: usize = 32 * 1024;
pub const MAX_ENVELOPE_BYTES: usize = 8 * 1024;
pub const MAX_ENVELOPES: usize = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Kind {
    Manifest = 1,
    BallotBatch = 2,
    ResultRecord = 3,
    AuthorizationPolicy = 4,
    AuthorizationBatch = 5,
    ProcessRoles = 6,
    ProcessBatch = 7,
}

impl Kind {
    pub fn from_byte(b: u8) -> Result<Self> {
        Ok(match b {
            1 => Kind::Manifest,
            2 => Kind::BallotBatch,
            3 => Kind::ResultRecord,
            4 => Kind::AuthorizationPolicy,
            5 => Kind::AuthorizationBatch,
            6 => Kind::ProcessRoles,
            7 => Kind::ProcessBatch,
            _ => return Err(Error::format(format!("unknown carrier kind {b}"))),
        })
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Manifest => "manifest",
            Kind::BallotBatch => "ballot_batch",
            Kind::ResultRecord => "result_record",
            Kind::AuthorizationPolicy => "authorization_policy",
            Kind::AuthorizationBatch => "authorization_batch",
            Kind::ProcessRoles => "process_roles",
            Kind::ProcessBatch => "process_batch",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Header {
    pub kind: Kind,
    pub scope_id: Hash32,
    pub payload_hash: Hash32,
    pub witness_index: u32,
}

impl Header {
    pub fn encode(&self) -> Vec<u8> {
        let mut v = Vec::with_capacity(HEADER_LEN);
        v.extend_from_slice(MAGIC);
        v.push(self.kind as u8);
        v.push(VERSION);
        v.extend_from_slice(&self.scope_id);
        v.extend_from_slice(&self.payload_hash);
        v.extend_from_slice(&self.witness_index.to_le_bytes());
        v
    }

    /// Returns `Ok(None)` for data that is not an Omavote carrier at all.
    pub fn decode(data: &[u8]) -> Result<Option<Header>> {
        if data.len() != HEADER_LEN || &data[..8] != MAGIC {
            return Ok(None);
        }
        if data[9] != VERSION {
            return Err(Error::unsupported(format!("carrier version {}", data[9])));
        }
        let kind = Kind::from_byte(data[8])?;
        let mut scope_id = [0u8; 32];
        scope_id.copy_from_slice(&data[10..42]);
        let mut payload_hash = [0u8; 32];
        payload_hash.copy_from_slice(&data[42..74]);
        let witness_index = u32::from_le_bytes([data[74], data[75], data[76], data[77]]);
        Ok(Some(Header { kind, scope_id, payload_hash, witness_index }))
    }
}

pub fn payload_hash(kind: Kind, payload: &[u8]) -> Hash32 {
    let mut h = CkbHasher::new();
    h.update(domain::PAYLOAD).update(&[kind as u8]).update(payload);
    h.finalize()
}

/// Decoded payload. Batch entries are decoded individually so that one malformed
/// envelope does not invalidate the rest of the batch.
#[derive(Clone, Debug)]
pub enum Payload {
    Manifest(Box<ManifestPayload>),
    BallotBatch(Vec<Result<BallotEnvelope>>),
    ResultRecord(Value),
    AuthorizationPolicy(AuthPolicy),
    AuthorizationBatch(Vec<Result<ControlEnvelope>>),
    ProcessRoles(ProcessRoles),
    ProcessBatch(Vec<Result<ProcessEnvelope>>),
}

fn batch_entries(v: &Value) -> Result<Vec<Value>> {
    let mut f = Fields::new(v, "batch")?;
    f.literal("protocol_version", PROTOCOL_VERSION)?;
    let entries = f.array("envelopes")?.clone();
    f.finish()?;
    if entries.is_empty() || entries.len() > MAX_ENVELOPES {
        return Err(Error::rule(format!("batch must contain 1-{MAX_ENVELOPES} envelopes")));
    }
    Ok(entries)
}

fn sized<T>(entry: &Value, decode: impl Fn(&Value) -> Result<T>) -> Result<T> {
    if jcs_bytes(entry).len() > MAX_ENVELOPE_BYTES {
        return Err(Error::rule("envelope exceeds 8 KiB"));
    }
    decode(entry)
}

/// Validate the header/witness binding and decode the payload.
pub fn decode_payload(header: &Header, witness: &[u8]) -> Result<Payload> {
    if witness.len() > MAX_WITNESS_BYTES {
        return Err(Error::rule("payload witness exceeds 32 KiB"));
    }
    if payload_hash(header.kind, witness) != header.payload_hash {
        return Err(Error::format("payload hash does not match carrier header"));
    }
    let v = parse_canonical(witness)?;
    let payload = match header.kind {
        Kind::Manifest => {
            let p = ManifestPayload::from_json(&v)?;
            if p.manifest.poll_id() != header.scope_id {
                return Err(Error::format("manifest scope_id must equal poll_id"));
            }
            Payload::Manifest(Box::new(p))
        }
        Kind::BallotBatch => Payload::BallotBatch(
            batch_entries(&v)?
                .iter()
                .map(|e| {
                    sized(e, BallotEnvelope::from_json).and_then(|b| {
                        if b.body.poll_id != header.scope_id {
                            Err(Error::format("ballot batch entries must belong to the carrier poll"))
                        } else {
                            Ok(b)
                        }
                    })
                })
                .collect(),
        ),
        Kind::ResultRecord => Payload::ResultRecord(v),
        Kind::AuthorizationPolicy => {
            let p = AuthPolicy::from_json(&v)?;
            if p.hash() != header.scope_id {
                return Err(Error::format("policy scope_id must equal auth_policy_hash"));
            }
            Payload::AuthorizationPolicy(p)
        }
        Kind::AuthorizationBatch => Payload::AuthorizationBatch(
            batch_entries(&v)?
                .iter()
                .map(|e| {
                    sized(e, ControlEnvelope::from_json).and_then(|c| {
                        if c.body.auth_policy_hash != header.scope_id {
                            Err(Error::format("authorization batch entries must share the carrier policy"))
                        } else {
                            Ok(c)
                        }
                    })
                })
                .collect(),
        ),
        Kind::ProcessRoles => {
            let r = ProcessRoles::from_json(&v)?;
            if r.roles_hash() != header.scope_id {
                return Err(Error::format("roles scope_id must equal roles_hash"));
            }
            Payload::ProcessRoles(r)
        }
        Kind::ProcessBatch => Payload::ProcessBatch(
            batch_entries(&v)?
                .iter()
                .map(|e| {
                    sized(e, ProcessEnvelope::from_json).and_then(|p| {
                        if p.body.summary_target() != header.scope_id {
                            Err(Error::format("process batch entries must share the carrier scope"))
                        } else {
                            Ok(p)
                        }
                    })
                })
                .collect(),
        ),
    };
    Ok(payload)
}

/// Build a batch payload (relay side).
pub fn batch_payload(envelopes: Vec<Value>) -> Vec<u8> {
    jcs_bytes(&Value::Object(
        Object::new()
            .with("protocol_version", Value::str(PROTOCOL_VERSION))
            .with("envelopes", Value::Array(envelopes)),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_roundtrip_and_non_carrier_data() {
        let h = Header { kind: Kind::BallotBatch, scope_id: [7; 32], payload_hash: [9; 32], witness_index: 3 };
        let enc = h.encode();
        assert_eq!(enc.len(), HEADER_LEN);
        assert_eq!(Header::decode(&enc).unwrap(), Some(h));
        assert_eq!(Header::decode(&[0u8; 8]).unwrap(), None);
        assert_eq!(Header::decode(&[0u8; 78]).unwrap(), None);
        let mut bad = enc.clone();
        bad[9] = 3;
        assert!(Header::decode(&bad).is_err());
    }
}
