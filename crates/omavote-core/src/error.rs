use std::fmt;

pub type Result<T> = std::result::Result<T, Error>;

/// Errors are classified so that callers can distinguish malformed protocol data
/// (a diagnosable rejection) from failed signatures and unsupported features.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// Malformed or non-canonical encoding, unknown or missing fields.
    Format(String),
    /// Signature does not verify or does not match the claimed signer.
    Signature(String),
    /// Well-formed but uses a feature this implementation does not support.
    Unsupported(String),
    /// Violates a protocol rule (window, policy, ordering, limits).
    Rule(String),
}

impl Error {
    pub fn format(msg: impl Into<String>) -> Self {
        Error::Format(msg.into())
    }
    pub fn signature(msg: impl Into<String>) -> Self {
        Error::Signature(msg.into())
    }
    pub fn unsupported(msg: impl Into<String>) -> Self {
        Error::Unsupported(msg.into())
    }
    pub fn rule(msg: impl Into<String>) -> Self {
        Error::Rule(msg.into())
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Format(m) => write!(f, "format error: {m}"),
            Error::Signature(m) => write!(f, "signature error: {m}"),
            Error::Unsupported(m) => write!(f, "unsupported: {m}"),
            Error::Rule(m) => write!(f, "rule violation: {m}"),
        }
    }
}

impl std::error::Error for Error {}
