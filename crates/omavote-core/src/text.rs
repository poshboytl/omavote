//! Deterministic signed texts (docs/03 §3.1 and §5, docs/11 §3).
//!
//! Every verifier re-renders these bytes and verifies signatures against them;
//! texts carried in envelopes are never trusted.

use crate::error::{Error, Result};
use crate::json::to_jcs;
use crate::messages::short_id;
use crate::messages::{Action, Authority, BallotBody, ControlAction, ControlBody, ProcessRecord, RecordDetail, RevokeMode, Role};
use crate::molecule::Script;
use crate::network::NetworkParams;
use crate::types::{
    Manifest, ProposalType, CLOCK_ID, DAO_NAMESPACE, SHANNON_PER_CKB, SIG_FORMAT_AUTHORIZATION, SIG_FORMAT_PROCESS, SIG_FORMAT_PROPOSAL,
    SIG_FORMAT_READABLE,
};
use crate::util::{to_hex, utc_date, utc_ms};

pub const MAX_SUMMARY_BYTES: usize = 60;

/// Exact decimal CKB: integer part, then up to eight fractional digits without trailing zeros.
pub fn render_ckb(shannon: u128) -> String {
    let int = shannon / SHANNON_PER_CKB;
    let frac = shannon % SHANNON_PER_CKB;
    if frac == 0 {
        int.to_string()
    } else {
        let f = format!("{:08}", frac);
        format!("{}.{}", int, f.trim_end_matches('0'))
    }
}

fn budget_summary(m: &Manifest) -> String {
    match m.proposal_type {
        ProposalType::MetaRule => "META-RULE".into(),
        ProposalType::Grant => format!("{}CKB", m.budget_ckb_shannon / SHANNON_PER_CKB),
    }
}

fn check_summary(s: String) -> Result<String> {
    if s.len() > MAX_SUMMARY_BYTES || !s.bytes().all(|b| (0x20..=0x7e).contains(&b)) {
        return Err(Error::format(format!("summary line is not printable ASCII within {MAX_SUMMARY_BYTES} bytes")));
    }
    Ok(s)
}

fn join(lines: Vec<String>) -> String {
    lines.join("\n")
}

fn budget_line(m: &Manifest) -> String {
    match m.proposal_type {
        ProposalType::MetaRule => "none".into(),
        ProposalType::Grant => render_ckb(m.budget_ckb_shannon),
    }
}

fn recipient_line(m: &Manifest, net: &NetworkParams) -> Result<String> {
    match &m.recipient_lock_script {
        None => Ok("none".into()),
        Some(s) => net.address(s),
    }
}

/// `omavote-readable-v2` ballot text.
pub fn ballot_text(m: &Manifest, b: &BallotBody, net: &NetworkParams) -> Result<String> {
    if b.poll_id != m.poll_id() {
        return Err(Error::rule("ballot belongs to another poll"));
    }
    if b.rules_hash != m.rules_hash() || b.genesis != m.genesis {
        return Err(Error::rule("ballot network or rules do not match the manifest"));
    }
    let summary = check_summary(format!("OMAVOTE VOTE {} #{} {}", b.action.as_str(), short_id(&b.poll_id), budget_summary(m)))?;
    let choice = match b.action {
        Action::Yes => "YES (Approve)",
        Action::No => "NO (Reject)",
        Action::Cancel => "CANCEL (Withdraw vote)",
    };
    let authority = match b.authority {
        Authority::Owner => "OWNER (Direct)",
        Authority::Delegate => "DELEGATE (Voting key)",
    };
    let opt = |h: &Option<[u8; 32]>| h.map(|x| to_hex(&x)).unwrap_or_else(|| "none".into());
    Ok(join(vec![
        summary,
        "OMAVOTE V2 - VOTE ONLY, NO ASSET TRANSFER".into(),
        String::new(),
        format!("Format: {SIG_FORMAT_READABLE}"),
        format!("DAO: {DAO_NAMESPACE}"),
        format!("Network-Genesis: {}", to_hex(&b.genesis)),
        format!("Proposal: {}", to_hex(&b.poll_id)),
        format!("Title: {}", m.signing_title),
        format!("Budget-CKB: {}", budget_line(m)),
        format!("Recipient: {}", recipient_line(m, net)?),
        format!("Choice: {choice}"),
        format!("Owner: {}", net.address(&b.owner_lock)?),
        format!("Authority: {authority}"),
        format!("Authorization: {}", opt(&b.authorization_id)),
        format!("Signer-Key: {}", opt(&b.signer_key_id)),
        format!("Anchor-Block: {}", to_hex(&b.anchor_block_hash)),
        format!("Clock: {CLOCK_ID}"),
        format!("End-Chain-Time-UTC: {}", utc_ms(m.end_ms)?),
        format!("Rules-Hash: {}", to_hex(&b.rules_hash)),
        format!("Ballot-Hash: {}", to_hex(&b.ballot_id())),
    ]))
}

/// `omavote-authorization-v2` control text.
pub fn control_text(c: &ControlBody, net: &NetworkParams) -> Result<String> {
    let summary = match c.action {
        ControlAction::Grant => {
            let key = c.key_descriptor.as_ref().expect("validated");
            let word = if c.cancels_open() { "GRANT+CANCEL" } else { "GRANT" };
            format!("OMAVOTE {word} {} TO {}", key.key_short(net)?, utc_date(c.expires_at_ms.expect("validated"))?)
        }
        ControlAction::Revoke => match c.revoke_mode.expect("validated") {
            RevokeMode::StopOnly => "OMAVOTE REVOKE STOP-ONLY".to_string(),
            RevokeMode::StopAndCancelOpen => "OMAVOTE REVOKE STOP+CANCEL-OPEN".to_string(),
        },
    };
    let summary = check_summary(summary)?;
    let (key_address, key_descriptor, key_id) = match &c.key_descriptor {
        Some(k) => (k.key_display(net)?, to_jcs(&k.to_json()), to_hex(&k.key_id())),
        None => ("none".into(), "none".into(), "none".into()),
    };
    Ok(join(vec![
        summary,
        "OMAVOTE V2 - VOTING AUTHORIZATION ONLY, NO ASSET TRANSFER".into(),
        String::new(),
        format!("Format: {SIG_FORMAT_AUTHORIZATION}"),
        format!("DAO: {DAO_NAMESPACE}"),
        format!("Network-Genesis: {}", to_hex(&c.genesis)),
        format!("Owner: {}", net.address(&c.owner_lock)?),
        format!(
            "Action: {}",
            match c.action {
                ControlAction::Grant => "GRANT",
                ControlAction::Revoke => "REVOKE",
            }
        ),
        format!("Key-Address: {key_address}"),
        format!("Key-Descriptor: {key_descriptor}"),
        format!("Key-ID: {key_id}"),
        format!(
            "Expires-Chain-Time-UTC: {}",
            match c.expires_at_ms {
                Some(ms) => utc_ms(ms)?,
                None => "none".into(),
            }
        ),
        format!("Revoke-Mode: {}", c.revoke_mode.map(|m| m.as_str()).unwrap_or("none")),
        format!("Anchor-Block: {}", to_hex(&c.anchor_block_hash)),
        format!("Publish-Before-Chain-Time-UTC: {}", utc_ms(c.publication_deadline_ms)?),
        format!("Policy-Hash: {}", to_hex(&c.auth_policy_hash)),
        format!("Authorization-Hash: {}", to_hex(&c.authorization_id())),
    ]))
}

/// `omavote-proposal-v2` text signed by each proposer lock.
pub fn proposal_text(m: &Manifest, proposer: &Script, net: &NetworkParams) -> Result<String> {
    let poll_id = m.poll_id();
    let summary = check_summary(format!("OMAVOTE PROPOSE #{} {}", short_id(&poll_id), budget_summary(m)))?;
    Ok(join(vec![
        summary,
        "OMAVOTE V2 - PROPOSAL SUBMISSION, NO ASSET TRANSFER".into(),
        String::new(),
        format!("Format: {SIG_FORMAT_PROPOSAL}"),
        format!("DAO: {DAO_NAMESPACE}"),
        format!("Network-Genesis: {}", to_hex(&m.genesis)),
        format!("Proposal: {}", to_hex(&poll_id)),
        format!(
            "Type: {}",
            match m.proposal_type {
                ProposalType::Grant => "FUNDING",
                ProposalType::MetaRule => "META-RULE",
            }
        ),
        format!("Title: {}", m.signing_title),
        format!("Budget-CKB: {}", budget_line(m)),
        format!("Recipient: {}", recipient_line(m, net)?),
        format!("Start-Chain-Time-UTC: {}", utc_ms(m.start_ms)?),
        format!("End-Chain-Time-UTC: {}", utc_ms(m.end_ms)?),
        format!("Proposer: {}", net.address(proposer)?),
        format!("Rules-Hash: {}", to_hex(&m.rules_hash())),
    ]))
}

/// `omavote-process-v2` text signed by each role member.
pub fn process_text(r: &ProcessRecord) -> Result<String> {
    let value = match &r.detail {
        RecordDetail::Admission { admitted } => Some(if *admitted { "ADMITTED" } else { "REJECTED" }.to_string()),
        RecordDetail::Notice { code } => Some(code.clone()),
        RecordDetail::GovernanceStatus { status } => Some(status.as_str().to_string()),
        RecordDetail::ResultAttestation { pass, .. } => Some(if *pass { "PASS" } else { "FAIL" }.to_string()),
        RecordDetail::Execution { .. } | RecordDetail::RolesUpdate { .. } => None,
    };
    let mut summary = format!("OMAVOTE {} #{}", r.record_type().summary_word(), short_id(&r.summary_target()));
    if let Some(v) = value {
        summary.push(' ');
        summary.push_str(&v);
    }
    let summary = check_summary(summary)?;
    Ok(join(vec![
        summary,
        "OMAVOTE V2 - PROCESS RECORD, NO ASSET TRANSFER".into(),
        String::new(),
        format!("Format: {SIG_FORMAT_PROCESS}"),
        format!("DAO: {DAO_NAMESPACE}"),
        format!("Network-Genesis: {}", to_hex(&r.genesis)),
        format!("Record-Type: {}", r.record_type().as_str()),
        format!(
            "Role: {}",
            match r.role {
                Role::Committee => "COMMITTEE",
                Role::Coordinator => "COORDINATOR",
            }
        ),
        format!("Proposal: {}", r.poll_id.map(|p| to_hex(&p)).unwrap_or_else(|| "none".into())),
        format!("Detail: {}", to_jcs(&r.detail.to_json())),
        format!("Evidence-Hash: {}", r.evidence_hash.map(|p| to_hex(&p)).unwrap_or_else(|| "none".into())),
        format!("Anchor-Block: {}", to_hex(&r.anchor_block_hash)),
        format!("Publish-Before-Chain-Time-UTC: {}", utc_ms(r.publication_deadline_ms)?),
        format!("Roles-Hash: {}", to_hex(&r.roles_hash)),
        format!("Record-Hash: {}", to_hex(&r.record_id())),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ckb_rendering() {
        assert_eq!(render_ckb(100_000_000_000_000), "1000000");
        assert_eq!(render_ckb(100_000_001), "1.00000001");
        assert_eq!(render_ckb(150_000_000), "1.5");
        assert_eq!(render_ckb(0), "0");
        assert_eq!(render_ckb(1), "0.00000001");
    }
}
