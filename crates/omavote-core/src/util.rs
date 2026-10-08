//! Canonical hex and decimal-string helpers shared by every protocol object.

use crate::error::{Error, Result};

pub type Hash32 = [u8; 32];

/// Lowercase `0x`-prefixed hex.
pub fn to_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(2 + bytes.len() * 2);
    s.push_str("0x");
    for b in bytes {
        s.push(DIGITS[(b >> 4) as usize] as char);
        s.push(DIGITS[(b & 0x0f) as usize] as char);
    }
    s
}

/// Hex without the `0x` prefix.
pub fn to_hex_bare(bytes: &[u8]) -> String {
    to_hex(bytes)[2..].to_string()
}

/// Parse canonical hex: `0x` prefix, lowercase digits, even length.
pub fn parse_hex(s: &str, what: &str) -> Result<Vec<u8>> {
    let body = s.strip_prefix("0x").ok_or_else(|| Error::format(format!("{what}: hex must start with 0x")))?;
    if body.len() % 2 != 0 {
        return Err(Error::format(format!("{what}: odd hex length")));
    }
    let mut out = Vec::with_capacity(body.len() / 2);
    let bytes = body.as_bytes();
    for pair in bytes.chunks(2) {
        let hi = hex_val(pair[0]).ok_or_else(|| Error::format(format!("{what}: non-canonical hex digit")))?;
        let lo = hex_val(pair[1]).ok_or_else(|| Error::format(format!("{what}: non-canonical hex digit")))?;
        out.push((hi << 4) | lo);
    }
    Ok(out)
}

fn hex_val(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        _ => None,
    }
}

pub fn parse_hex_fixed<const N: usize>(s: &str, what: &str) -> Result<[u8; N]> {
    let v = parse_hex(s, what)?;
    if v.len() != N {
        return Err(Error::format(format!("{what}: expected {N} bytes, got {}", v.len())));
    }
    let mut out = [0u8; N];
    out.copy_from_slice(&v);
    Ok(out)
}

pub fn parse_hash(s: &str, what: &str) -> Result<Hash32> {
    parse_hex_fixed::<32>(s, what)
}

/// Canonical non-negative decimal string: digits only, no sign, no leading zero except "0".
pub fn parse_dec_u128(s: &str, what: &str) -> Result<u128> {
    if s.is_empty() {
        return Err(Error::format(format!("{what}: empty decimal")));
    }
    if !s.bytes().all(|b| b.is_ascii_digit()) {
        return Err(Error::format(format!("{what}: decimal must contain digits only")));
    }
    if s.len() > 1 && s.starts_with('0') {
        return Err(Error::format(format!("{what}: leading zero")));
    }
    s.parse::<u128>().map_err(|_| Error::format(format!("{what}: decimal out of range")))
}

pub fn parse_dec_u64(s: &str, what: &str) -> Result<u64> {
    let v = parse_dec_u128(s, what)?;
    u64::try_from(v).map_err(|_| Error::format(format!("{what}: exceeds u64")))
}

pub fn dec(v: impl Into<u128>) -> String {
    v.into().to_string()
}

/// Render milliseconds since the Unix epoch as `YYYY-MM-DDTHH:mm:ss.SSSZ` (UTC, four-digit year).
pub fn utc_ms(ms: u64) -> Result<String> {
    let (date, rem) = civil_from_ms(ms)?;
    let secs = rem / 1000;
    let millis = rem % 1000;
    Ok(format!("{}T{:02}:{:02}:{:02}.{:03}Z", date, secs / 3600, (secs % 3600) / 60, secs % 60, millis))
}

/// Render the UTC calendar date `YYYY-MM-DD` of a millisecond timestamp.
pub fn utc_date(ms: u64) -> Result<String> {
    Ok(civil_from_ms(ms)?.0)
}

fn civil_from_ms(ms: u64) -> Result<(String, u64)> {
    let days = (ms / 86_400_000) as i64;
    let rem = ms % 86_400_000;
    // Howard Hinnant's days -> civil algorithm.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    if !(1..=9999).contains(&y) {
        return Err(Error::format("timestamp outside year range 0001-9999"));
    }
    Ok((format!("{:04}-{:02}-{:02}", y, m, d), rem))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_roundtrip_and_strictness() {
        assert_eq!(to_hex(&[0xab, 0x01]), "0xab01");
        assert_eq!(parse_hex("0xab01", "t").unwrap(), vec![0xab, 0x01]);
        assert!(parse_hex("0xAB01", "t").is_err());
        assert!(parse_hex("ab01", "t").is_err());
        assert!(parse_hex("0xab0", "t").is_err());
        assert_eq!(parse_hex("0x", "t").unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn decimal_strictness() {
        assert_eq!(parse_dec_u128("0", "t").unwrap(), 0);
        assert_eq!(parse_dec_u128("1234", "t").unwrap(), 1234);
        assert!(parse_dec_u128("01", "t").is_err());
        assert!(parse_dec_u128("-1", "t").is_err());
        assert!(parse_dec_u128("1e3", "t").is_err());
        assert!(parse_dec_u128("", "t").is_err());
        assert!(parse_dec_u64("18446744073709551616", "t").is_err());
    }

    #[test]
    fn utc_rendering() {
        assert_eq!(utc_ms(0).unwrap(), "1970-01-01T00:00:00.000Z");
        assert_eq!(utc_ms(1_791_417_600_123).unwrap(), "2026-10-08T00:00:00.123Z");
        assert_eq!(utc_date(951_782_400_000).unwrap(), "2000-02-29");
        assert_eq!(utc_ms(253_402_300_799_999).unwrap(), "9999-12-31T23:59:59.999Z");
        assert!(utc_ms(253_402_300_800_000).is_err());
    }
}
