//! Forum import for proposal creation (docs/13 §8): read the current revision of a
//! Nervos Talk (Discourse) topic so the proposer starts from the discussed text.
//!
//! The server, not the browser, fetches (the page's CSP only allows same-origin
//! scripts). Only `https://talk.nervos.org` is contacted, redirects are refused, and
//! time, size and concurrency are bounded. Nothing imported is trusted: budget, recipient and text
//! must be confirmed by the proposer, and forum likes are not verified.

use std::collections::BTreeSet;
use std::sync::OnceLock;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use omavote_core::hash::ckb_hash;
use omavote_core::util::to_hex;
use serde_json::{json, Value};

pub const FORUM_HOST: &str = "talk.nervos.org";
const MAX_BYTES: usize = 2_000_000;
/// Imports fetched at the same time; more are refused (`FORUM_BUSY`) rather than queued.
const MAX_CONCURRENT: usize = 4;

/// Topic ID from a number or a Nervos Talk topic URL (`/t/<id>`, `/t/<slug>/<id>[/<post>]`).
pub fn forum_topic(input: &str) -> Result<String> {
    let value = input.trim();
    let positive = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) && !s.starts_with('0');
    if positive(value) {
        return Ok(value.into());
    }
    let url = reqwest::Url::parse(value).context("enter a topic number or a https://talk.nervos.org/t/… link")?;
    if url.scheme() != "https"
        || url.host_str() != Some(FORUM_HOST)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        bail!("FORUM_LINK_REQUIRES_HTTPS_NERVOS_TALK");
    }
    let parts: Vec<&str> = url.path_segments().context("forum path")?.filter(|s| !s.is_empty()).collect();
    if parts.first() != Some(&"t") {
        bail!("FORUM_TOPIC_LINK_REQUIRED");
    }
    let strip = |s: &&str| s.trim_end_matches(".json").to_string();
    let candidate = match parts.get(1).map(strip) {
        Some(s) if positive(&s) => s,
        _ => parts.get(2).map(strip).context("FORUM_TOPIC_LINK_REQUIRED")?,
    };
    if !positive(&candidate) {
        bail!("FORUM_TOPIC_ID_INVALID");
    }
    Ok(candidate)
}

async fn get_json(client: &reqwest::Client, url: &str) -> Result<Value> {
    let mut response = client.get(url).send().await?.error_for_status()?;
    if response.content_length().is_some_and(|n| n as usize > MAX_BYTES) {
        bail!("FORUM_SIZE_LIMIT");
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if bytes.len() + chunk.len() > MAX_BYTES {
            bail!("FORUM_SIZE_LIMIT");
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(serde_json::from_slice(&bytes)?)
}

/// CKB addresses mentioned in the text (candidates for the recipient, never chosen automatically).
pub fn address_candidates(raw: &str) -> Vec<String> {
    raw.split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|s| (s.starts_with("ckb1") || s.starts_with("ckt1")) && s.len() > 40)
        .map(str::to_string)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

/// The `FORUM_*` code in an error chain, or `default`.
pub fn error_code(e: &anyhow::Error, default: &str) -> String {
    format!("{e:#}").split(|c: char| !(c.is_ascii_uppercase() || c == '_')).find(|w| w.starts_with("FORUM_")).unwrap_or(default).to_string()
}

fn limiter() -> &'static tokio::sync::Semaphore {
    static LIMIT: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
    LIMIT.get_or_init(|| tokio::sync::Semaphore::new(MAX_CONCURRENT))
}

pub async fn import(input: &str) -> Result<Value> {
    let topic = forum_topic(input)?;
    let _permit = limiter().try_acquire().map_err(|_| anyhow!("FORUM_BUSY: too many imports in progress; retry shortly"))?;
    let client = reqwest::Client::builder().timeout(Duration::from_secs(15)).redirect(reqwest::redirect::Policy::none()).build()?;
    let topic_url = format!("https://{FORUM_HOST}/t/{topic}.json");
    let t = get_json(&client, &topic_url).await?;
    let first = t["post_stream"]["posts"].as_array().and_then(|p| p.first()).context("FORUM_FIRST_POST_UNAVAILABLE")?;
    let post_id = first["id"].as_u64().context("forum post id")?;
    // The topic JSON carries rendered HTML; the raw text comes from the post itself.
    let post_url = format!("https://{FORUM_HOST}/posts/{post_id}.json");
    let post = if first["raw"].is_string() { first.clone() } else { get_json(&client, &post_url).await? };
    if post["topic_id"].as_u64().is_some_and(|id| id.to_string() != topic) {
        bail!("FORUM_POST_TOPIC_MISMATCH");
    }
    let raw = post["raw"].as_str().context("FORUM_RAW_CONTENT_UNAVAILABLE")?;
    let revision = post["version"].as_u64().context("FORUM_REVISION_UNAVAILABLE")?;
    Ok(json!({
        "source": format!("https://{FORUM_HOST}/t/{topic}"),
        "topic_id": topic,
        "title": t["title"].as_str().unwrap_or_default(),
        "revision": revision.to_string(),
        "post_id": post_id.to_string(),
        "author": post["username"].as_str(),
        "created_at": post["created_at"].as_str(),
        "updated_at": post["updated_at"].as_str(),
        "content_raw": raw,
        "content_hash": to_hex(&ckb_hash(raw.as_bytes())),
        "recipient_candidates": address_candidates(raw),
        "historical_likes_verified": false,
        "requires_proposer_confirmation": ["title", "content", "revision", "budget", "recipient"],
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn topic_links_are_parsed_without_accepting_foreign_sources() {
        for (input, expected) in [
            ("42", "42"),
            (" 42 ", "42"),
            ("https://talk.nervos.org/t/42", "42"),
            ("https://talk.nervos.org/t/proposal-title/42/3?u=alice#post", "42"),
            ("https://talk.nervos.org/t/42.json", "42"),
            ("https://talk.nervos.org/t/slug/42/", "42"),
        ] {
            assert_eq!(forum_topic(input).unwrap(), expected, "{input}");
        }
        for input in [
            "0",
            "042",
            "-1",
            "https://other.example/t/42",
            "http://talk.nervos.org/t/42",
            "https://talk.nervos.org@evil.example/t/42",
            "https://alice@talk.nervos.org/t/42",
            "https://talk.nervos.org:8443/t/42",
            "https://talk.nervos.org/categories/42",
            "https://talk.nervos.org/t/slug-only",
        ] {
            assert!(forum_topic(input).is_err(), "accepted {input}");
        }
    }

    #[test]
    fn error_codes_come_from_the_error_chain() {
        let e = forum_topic("https://other.example/t/42").unwrap_err();
        assert_eq!(error_code(&e, "X"), "FORUM_LINK_REQUIRES_HTTPS_NERVOS_TALK");
        let e = forum_topic("not a link").unwrap_err();
        assert_eq!(error_code(&e, "FORUM_TOPIC_LINK_REQUIRED"), "FORUM_TOPIC_LINK_REQUIRED");
        assert_eq!(error_code(&anyhow!("FORUM_BUSY: retry").context("import"), "X"), "FORUM_BUSY");
    }

    #[test]
    fn recipient_candidates_are_only_suggestions() {
        let text = "Pay to ckb1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqtzmhvwnndc8lsqm65mt8yxnpz75a3kyeswe2gl0, \
                    or ckt1short, or https://x/ckb1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsqtzmhvwnndc8lsqm65mt8yxnpz75a3kyeswe2gl0";
        let c = address_candidates(text);
        assert_eq!(c.len(), 1);
        assert!(c[0].starts_with("ckb1"));
    }
}
