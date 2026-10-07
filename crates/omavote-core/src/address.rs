//! RFC 0021 full-format CKB addresses (bech32m) and EIP-55 Ethereum addresses.

use crate::error::{Error, Result};
use crate::hash::keccak256;
use crate::molecule::{HashType, Script};

const CHARSET: &[u8; 32] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32M_CONST: u32 = 0x2bc8_30a3;

fn polymod(values: &[u8]) -> u32 {
    const GEN: [u32; 5] = [0x3b6a_57b2, 0x2650_8e6d, 0x1ea1_19fa, 0x3d42_33dd, 0x2a14_62b3];
    let mut chk: u32 = 1;
    for v in values {
        let top = chk >> 25;
        chk = ((chk & 0x01ff_ffff) << 5) ^ (*v as u32);
        for (i, g) in GEN.iter().enumerate() {
            if (top >> i) & 1 == 1 {
                chk ^= g;
            }
        }
    }
    chk
}

fn hrp_expand(hrp: &str) -> Vec<u8> {
    let mut v: Vec<u8> = hrp.bytes().map(|b| b >> 5).collect();
    v.push(0);
    v.extend(hrp.bytes().map(|b| b & 31));
    v
}

fn convert_bits(data: &[u8], from: u32, to: u32, pad: bool) -> Result<Vec<u8>> {
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    let maxv: u32 = (1 << to) - 1;
    let mut out = Vec::new();
    for &value in data {
        let v = value as u32;
        if v >> from != 0 {
            return Err(Error::format("invalid data for bit conversion"));
        }
        acc = (acc << from) | v;
        bits += from;
        while bits >= to {
            bits -= to;
            out.push(((acc >> bits) & maxv) as u8);
        }
    }
    if pad {
        if bits > 0 {
            out.push(((acc << (to - bits)) & maxv) as u8);
        }
    } else if bits >= from || ((acc << (to - bits)) & maxv) != 0 {
        return Err(Error::format("invalid padding in address"));
    }
    Ok(out)
}

pub fn bech32m_encode(hrp: &str, payload: &[u8]) -> Result<String> {
    let data = convert_bits(payload, 8, 5, true)?;
    let mut values = hrp_expand(hrp);
    values.extend(&data);
    values.extend([0u8; 6]);
    let pm = polymod(&values) ^ BECH32M_CONST;
    let mut s = String::with_capacity(hrp.len() + 1 + data.len() + 6);
    s.push_str(hrp);
    s.push('1');
    for d in &data {
        s.push(CHARSET[*d as usize] as char);
    }
    for i in 0..6 {
        s.push(CHARSET[((pm >> (5 * (5 - i))) & 31) as usize] as char);
    }
    Ok(s)
}

pub fn bech32m_decode(addr: &str) -> Result<(String, Vec<u8>)> {
    if addr.bytes().any(|b| b.is_ascii_uppercase()) {
        return Err(Error::format("address must be lowercase"));
    }
    let pos = addr.rfind('1').ok_or_else(|| Error::format("address has no separator"))?;
    let (hrp, rest) = (&addr[..pos], &addr[pos + 1..]);
    if hrp.is_empty() || rest.len() < 6 {
        return Err(Error::format("address too short"));
    }
    let mut data = Vec::with_capacity(rest.len());
    for c in rest.bytes() {
        let idx = CHARSET
            .iter()
            .position(|x| *x == c)
            .ok_or_else(|| Error::format("invalid bech32 character"))?;
        data.push(idx as u8);
    }
    let mut values = hrp_expand(hrp);
    values.extend(&data);
    if polymod(&values) != BECH32M_CONST {
        return Err(Error::format("bad bech32m checksum"));
    }
    let payload = convert_bits(&data[..data.len() - 6], 5, 8, false)?;
    Ok((hrp.to_string(), payload))
}

/// RFC 0021 full address: payload = 0x00 || code_hash || hash_type || args.
pub fn full_address(hrp: &str, script: &Script) -> Result<String> {
    let mut payload = vec![0x00];
    payload.extend_from_slice(&script.code_hash);
    payload.push(script.hash_type.byte());
    payload.extend_from_slice(&script.args);
    bech32m_encode(hrp, &payload)
}

pub fn parse_full_address(addr: &str) -> Result<(String, Script)> {
    let (hrp, payload) = bech32m_decode(addr)?;
    if payload.len() < 34 || payload[0] != 0x00 {
        return Err(Error::format("not a full-format CKB address"));
    }
    let mut code_hash = [0u8; 32];
    code_hash.copy_from_slice(&payload[1..33]);
    let hash_type = HashType::from_byte(payload[33])?;
    Ok((hrp, Script::new(code_hash, hash_type, payload[34..].to_vec())))
}

/// EIP-55 mixed-case checksum encoding of a 20-byte address.
pub fn eip55(addr: &[u8; 20]) -> String {
    let lower = crate::util::to_hex_bare(addr);
    let h = keccak256(lower.as_bytes());
    let mut out = String::from("0x");
    for (i, c) in lower.chars().enumerate() {
        let nibble = (h[i / 2] >> (if i % 2 == 0 { 4 } else { 0 })) & 0x0f;
        if c.is_ascii_alphabetic() && nibble >= 8 {
            out.push(c.to_ascii_uppercase());
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::{parse_hash, parse_hex};

    #[test]
    fn rfc0021_full_address_vector() {
        // RFC 0021 example: secp256k1_blake160 lock with the given args on mainnet.
        let script = Script::new(
            parse_hash("0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8", "t").unwrap(),
            HashType::Type,
            parse_hex("0xb39bbc0b3673c7d36450bc14cfcdad2d559c6c64", "t").unwrap(),
        );
        let addr = full_address("ckb", &script).unwrap();
        assert_eq!(
            addr,
            "ckb1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqdnnw7qkdnnclfkg59uzn8umtfd2kwxceqxwquc4"
        );
        let (hrp, back) = parse_full_address(&addr).unwrap();
        assert_eq!(hrp, "ckb");
        assert_eq!(back, script);
    }

    #[test]
    fn eip55_vectors() {
        // Test vectors from EIP-55.
        let cases = [
            "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
            "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
            "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
            "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
        ];
        for c in cases {
            let bytes: [u8; 20] = crate::util::parse_hex_fixed(&c.to_lowercase(), "t").unwrap();
            assert_eq!(eip55(&bytes), c);
        }
    }
}
