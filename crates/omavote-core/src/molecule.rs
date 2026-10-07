//! Minimal Molecule serialization for the CKB structures the protocol needs:
//! `Script` (for owner_id and addresses) and transactions (for the relay).

use crate::error::{Error, Result};
use crate::hash::ckb_hash;
use crate::json::{Fields, Object, Value};
use crate::util::{parse_hash, parse_hex, to_hex, Hash32};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum HashType {
    Data,
    Type,
    Data1,
    Data2,
}

impl HashType {
    pub fn byte(self) -> u8 {
        match self {
            HashType::Data => 0,
            HashType::Type => 1,
            HashType::Data1 => 2,
            HashType::Data2 => 4,
        }
    }
    pub fn from_byte(b: u8) -> Result<Self> {
        Ok(match b {
            0 => HashType::Data,
            1 => HashType::Type,
            2 => HashType::Data1,
            4 => HashType::Data2,
            _ => return Err(Error::format(format!("unknown hash_type byte {b}"))),
        })
    }
    pub fn as_str(self) -> &'static str {
        match self {
            HashType::Data => "data",
            HashType::Type => "type",
            HashType::Data1 => "data1",
            HashType::Data2 => "data2",
        }
    }
    pub fn parse(s: &str) -> Result<Self> {
        Ok(match s {
            "data" => HashType::Data,
            "type" => HashType::Type,
            "data1" => HashType::Data1,
            "data2" => HashType::Data2,
            _ => return Err(Error::format(format!("unknown hash_type {s:?}"))),
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Script {
    pub code_hash: Hash32,
    pub hash_type: HashType,
    pub args: Vec<u8>,
}

impl Script {
    pub fn new(code_hash: Hash32, hash_type: HashType, args: Vec<u8>) -> Self {
        Script { code_hash, hash_type, args }
    }

    pub fn serialize(&self) -> Vec<u8> {
        table(&[self.code_hash.to_vec(), vec![self.hash_type.byte()], bytes(&self.args)])
    }

    /// Standard CKB script hash (the protocol's `owner_id`).
    pub fn hash(&self) -> Hash32 {
        ckb_hash(&self.serialize())
    }

    pub fn to_json(&self) -> Value {
        Value::Object(
            Object::new()
                .with("code_hash", Value::str(to_hex(&self.code_hash)))
                .with("hash_type", Value::str(self.hash_type.as_str()))
                .with("args", Value::str(to_hex(&self.args))),
        )
    }

    pub fn from_json(v: &Value) -> Result<Self> {
        let mut f = Fields::new(v, "script")?;
        let code_hash = parse_hash(f.str("code_hash")?, "script.code_hash")?;
        let hash_type = HashType::parse(f.str("hash_type")?)?;
        let args = parse_hex(f.str("args")?, "script.args")?;
        f.finish()?;
        Ok(Script { code_hash, hash_type, args })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct OutPoint {
    pub tx_hash: Hash32,
    pub index: u32,
}

impl OutPoint {
    pub fn serialize(&self) -> Vec<u8> {
        let mut v = self.tx_hash.to_vec();
        v.extend_from_slice(&self.index.to_le_bytes());
        v
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DepType {
    Code,
    DepGroup,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CellDep {
    pub out_point: OutPoint,
    pub dep_type: DepType,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CellInput {
    pub since: u64,
    pub previous_output: OutPoint,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CellOutput {
    pub capacity: u64,
    pub lock: Script,
    pub type_: Option<Script>,
}

impl CellOutput {
    pub fn serialize(&self) -> Vec<u8> {
        table(&[
            self.capacity.to_le_bytes().to_vec(),
            self.lock.serialize(),
            self.type_.as_ref().map(|s| s.serialize()).unwrap_or_default(),
        ])
    }

    /// Occupied capacity in shannons for this output with `data_len` bytes of data.
    pub fn occupied_capacity(&self, data_len: usize) -> u64 {
        let script_size = |s: &Script| 32 + 1 + s.args.len() as u64;
        let bytes = 8 + script_size(&self.lock) + self.type_.as_ref().map(script_size).unwrap_or(0) + data_len as u64;
        bytes * 100_000_000
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct RawTransaction {
    pub version: u32,
    pub cell_deps: Vec<CellDep>,
    pub header_deps: Vec<Hash32>,
    pub inputs: Vec<CellInput>,
    pub outputs: Vec<CellOutput>,
    pub outputs_data: Vec<Vec<u8>>,
}

impl RawTransaction {
    pub fn serialize(&self) -> Vec<u8> {
        let mut deps = Vec::new();
        for d in &self.cell_deps {
            deps.push({
                let mut v = d.out_point.serialize();
                v.push(match d.dep_type {
                    DepType::Code => 0,
                    DepType::DepGroup => 1,
                });
                v
            });
        }
        let inputs: Vec<Vec<u8>> = self
            .inputs
            .iter()
            .map(|i| {
                let mut v = i.since.to_le_bytes().to_vec();
                v.extend(i.previous_output.serialize());
                v
            })
            .collect();
        let header_deps: Vec<Vec<u8>> = self.header_deps.iter().map(|h| h.to_vec()).collect();
        table(&[
            self.version.to_le_bytes().to_vec(),
            fixvec(&deps),
            fixvec(&header_deps),
            fixvec(&inputs),
            dynvec(&self.outputs.iter().map(|o| o.serialize()).collect::<Vec<_>>()),
            dynvec(&self.outputs_data.iter().map(|d| bytes(d)).collect::<Vec<_>>()),
        ])
    }

    pub fn hash(&self) -> Hash32 {
        ckb_hash(&self.serialize())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct WitnessArgs {
    pub lock: Option<Vec<u8>>,
    pub input_type: Option<Vec<u8>>,
    pub output_type: Option<Vec<u8>>,
}

impl WitnessArgs {
    pub fn serialize(&self) -> Vec<u8> {
        let opt = |o: &Option<Vec<u8>>| o.as_ref().map(|b| bytes(b)).unwrap_or_default();
        table(&[opt(&self.lock), opt(&self.input_type), opt(&self.output_type)])
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Transaction {
    pub raw: RawTransaction,
    pub witnesses: Vec<Vec<u8>>,
}

impl Transaction {
    pub fn serialize(&self) -> Vec<u8> {
        table(&[self.raw.serialize(), dynvec(&self.witnesses.iter().map(|w| bytes(w)).collect::<Vec<_>>())])
    }

    pub fn serialized_size(&self) -> usize {
        self.serialize().len()
    }
}

// ---------------------------------------------------------------------------
// Molecule primitives

/// `Bytes` = fixvec<byte>: u32 LE item count followed by the bytes.
pub fn bytes(b: &[u8]) -> Vec<u8> {
    let mut v = (b.len() as u32).to_le_bytes().to_vec();
    v.extend_from_slice(b);
    v
}

/// fixvec of fixed-size items.
pub fn fixvec(items: &[Vec<u8>]) -> Vec<u8> {
    let mut v = (items.len() as u32).to_le_bytes().to_vec();
    for i in items {
        v.extend_from_slice(i);
    }
    v
}

/// dynvec / table share the same layout: full size, offsets, then items.
pub fn dynvec(items: &[Vec<u8>]) -> Vec<u8> {
    table(items)
}

pub fn table(fields: &[Vec<u8>]) -> Vec<u8> {
    let header = 4 + 4 * fields.len();
    let total: usize = header + fields.iter().map(|f| f.len()).sum::<usize>();
    let mut v = Vec::with_capacity(total);
    v.extend_from_slice(&(total as u32).to_le_bytes());
    let mut offset = header;
    for f in fields {
        v.extend_from_slice(&(offset as u32).to_le_bytes());
        offset += f.len();
    }
    for f in fields {
        v.extend_from_slice(f);
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_dynvec_and_bytes() {
        assert_eq!(dynvec(&[]), vec![4, 0, 0, 0]);
        assert_eq!(bytes(&[]), vec![0, 0, 0, 0]);
        assert_eq!(bytes(&[0xab]), vec![1, 0, 0, 0, 0xab]);
    }

    #[test]
    fn script_layout() {
        let s = Script::new([0x11; 32], HashType::Type, vec![0xaa, 0xbb]);
        let b = s.serialize();
        // total = 16 header + 32 + 1 + (4 + 2)
        assert_eq!(b.len(), 55);
        assert_eq!(&b[0..4], &55u32.to_le_bytes());
        assert_eq!(&b[4..8], &16u32.to_le_bytes());
        assert_eq!(&b[8..12], &48u32.to_le_bytes());
        assert_eq!(&b[12..16], &49u32.to_le_bytes());
        assert_eq!(b[48], 1);
        assert_eq!(&b[49..53], &2u32.to_le_bytes());
    }

    #[test]
    fn occupied_capacity_of_carrier_cell() {
        let out = CellOutput {
            capacity: 0,
            lock: Script::new([0; 32], HashType::Type, vec![0; 20]),
            type_: None,
        };
        // 8 + 32 + 1 + 20 + 78 = 139 bytes => 139 CKB, matching 03 §7.
        assert_eq!(out.occupied_capacity(78), 139 * 100_000_000);
    }
}
