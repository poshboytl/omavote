//! Omavote V2 protocol core.
//!
//! Pure, deterministic and IO-free: canonical JSON, hashes, CKB encodings, signed
//! texts, signature adapters, on-chain carriers, the replay engine and the tally.
//! The same code runs in the server, the command-line verifier and the browser (WASM).

pub mod adapter;
pub mod address;
pub mod carrier;
pub mod engine;
pub mod error;
pub mod hash;
pub mod json;
pub mod messages;
pub mod molecule;
pub mod network;
pub mod testkit;
pub mod tally;
pub mod text;
pub mod types;
pub mod util;

pub use error::{Error, Result};
