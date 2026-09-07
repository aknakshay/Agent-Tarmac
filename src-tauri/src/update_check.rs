//! Background check against the GitHub releases API for a newer published
//! version. Entirely best-effort: any failure (offline, rate-limited, DNS,
//! parse error) is silent — checking for updates must never surface an error
//! to the user or affect app startup.

use serde::Serialize;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

// confirmed at publish time
const REPO: &str = "aknakshay/Agent-Tarmac";

/// Optional telemetry + update-check endpoint (a Cloudflare Worker — see
/// `telemetry/` at the repo root). When set, the launch check hits this URL
/// instead of GitHub directly: the Worker counts the anonymous launch and
/// returns the latest-release JSON in GitHub's shape, so one call does both.
/// `None` (the default) means NO telemetry — the check goes straight to
/// GitHub exactly as before. Any failure against this endpoint falls back to
/// GitHub, so update checks never depend on it being up.
///
/// To enable: deploy `telemetry/` and set this to your Worker's `/check` URL,
/// e.g. `Some("https://agent-tarmac-telemetry.<subdomain>.workers.dev/check")`.
const TELEMETRY_ENDPOINT: Option<&str> = None;

/// Env var that disables the anonymous launch ping regardless of
/// [`TELEMETRY_ENDPOINT`]. Set to anything (`AGENT_TARMAC_NO_TELEMETRY=1`) to
/// opt out; the update check then always goes straight to GitHub.
const OPT_OUT_ENV: &str = "AGENT_TARMAC_NO_TELEMETRY";

const USER_AGENT: &str = "agent-tarmac-update-check";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const OVERALL_TIMEOUT: Duration = Duration::from_secs(10);

const INITIAL_DELAY: Duration = Duration::from_secs(10);
const RECHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAvailable {
    pub version: String,
    pub url: String,
}

/// Extracts `(version, html_url)` from a GitHub `/releases/latest` JSON
/// response, stripping a leading `v` from `tag_name`. Returns `None` for
/// any malformed or unexpected payload rather than propagating an error —
/// callers treat "couldn't determine the latest version" as equivalent to
/// "no update available" all the way up.
pub fn parse_latest(json: &str) -> Option<(String, String)> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    let tag = value.get("tag_name")?.as_str()?;
    let url = value.get("html_url")?.as_str()?;
    let version = tag.strip_prefix('v').unwrap_or(tag);
    if version.is_empty() || url.is_empty() {
        return None;
    }
    Some((version.to_string(), url.to_string()))
}

/// Hand-rolled semver-ish comparison: `latest` and `current` are split on
/// `.`, compared numerically segment by segment, with a missing trailing
/// segment on either side treated as `0`. Any non-numeric segment makes the
/// comparison bail out as "not newer" — a malformed version string must
/// never be treated as an update.
pub fn is_newer(latest: &str, current: &str) -> bool {
    let parse =
        |s: &str| -> Option<Vec<u64>> { s.split('.').map(|seg| seg.parse::<u64>().ok()).collect() };

    let (Some(latest_parts), Some(current_parts)) = (parse(latest), parse(current)) else {
        return false;
    };

    let len = latest_parts.len().max(current_parts.len());
    for i in 0..len {
        let l = latest_parts.get(i).copied().unwrap_or(0);
        let c = current_parts.get(i).copied().unwrap_or(0);
        if l != c {
            return l > c;
        }
    }
    false
}

/// One best-effort HTTP GET, returning the body as a string. `None` on any
/// failure (offline, timeout, non-2xx, non-UTF-8).
fn http_get(url: &str) -> Option<String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(CONNECT_TIMEOUT)
        .timeout(OVERALL_TIMEOUT)
        .build();

    agent
        .get(url)
        .set("User-Agent", USER_AGENT)
        .call()
        .ok()?
        .into_string()
        .ok()
}

/// Whether the user has opted out of the anonymous launch ping.
fn opted_out() -> bool {
    std::env::var_os(OPT_OUT_ENV).is_some()
}

/// A stable, anonymous per-install id: a random UUID generated once and
/// persisted to `app_data_dir/install-id`. No account, machine, or user
/// identifier is involved — it exists only so the endpoint can distinguish
/// "a new install" from "the same install checking again" (unique vs. total).
/// `None` if the data dir can't be resolved; the ping then omits the id.
fn install_id(app: &AppHandle) -> Option<String> {
    let dir = app.path().app_data_dir().ok()?;
    let path = dir.join("install-id");
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(&path, &id);
    Some(id)
}

/// Builds the telemetry `/check` URL with the anonymous install id, current
/// version, and OS as query params — or `None` when telemetry is unconfigured
/// or opted out, in which case the caller goes straight to GitHub.
fn telemetry_url(app: &AppHandle) -> Option<String> {
    if opted_out() {
        return None;
    }
    let base = TELEMETRY_ENDPOINT?;
    let version = env!("CARGO_PKG_VERSION");
    let id = install_id(app).unwrap_or_default();
    Some(format!("{base}?id={id}&v={version}&os=macos"))
}

/// Fetches the latest release `(version, url)`. Prefers the telemetry endpoint
/// (which counts the launch and returns the same GitHub JSON shape), and falls
/// back to GitHub directly on any miss — so update checks work identically
/// whether or not telemetry is configured or reachable.
fn fetch_latest(app: &AppHandle) -> Option<(String, String)> {
    if let Some(url) = telemetry_url(app) {
        if let Some(parsed) = http_get(&url).and_then(|body| parse_latest(&body)) {
            return Some(parsed);
        }
    }
    let github = format!("https://api.github.com/repos/{REPO}/releases/latest");
    http_get(&github).and_then(|body| parse_latest(&body))
}

fn check_once(app: &AppHandle) {
    let Some((latest, url)) = fetch_latest(app) else {
        return;
    };

    let current = env!("CARGO_PKG_VERSION");
    if is_newer(&latest, current) {
        let _ = app.emit(
            "update_available",
            UpdateAvailable {
                version: latest,
                url,
            },
        );
    }
}

/// Starts the update-check loop on a background thread: an initial check
/// after `INITIAL_DELAY` (so it doesn't compete with startup work), then
/// every `RECHECK_INTERVAL` thereafter. No state, no persistence — a
/// dismissed banner may reappear on the next launch.
pub fn start(app: AppHandle) {
    thread::spawn(move || {
        thread::sleep(INITIAL_DELAY);
        loop {
            check_once(&app);
            thread::sleep(RECHECK_INTERVAL);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_latest_strips_leading_v() {
        let json =
            r#"{"tag_name": "v1.2.3", "html_url": "https://github.com/x/y/releases/tag/v1.2.3"}"#;
        assert_eq!(
            parse_latest(json),
            Some((
                "1.2.3".to_string(),
                "https://github.com/x/y/releases/tag/v1.2.3".to_string()
            ))
        );
    }

    #[test]
    fn parse_latest_without_leading_v() {
        let json = r#"{"tag_name": "1.2.3", "html_url": "https://example.com"}"#;
        assert_eq!(
            parse_latest(json),
            Some(("1.2.3".to_string(), "https://example.com".to_string()))
        );
    }

    #[test]
    fn parse_latest_missing_fields_is_none() {
        assert_eq!(parse_latest(r#"{"tag_name": "v1.0.0"}"#), None);
        assert_eq!(parse_latest(r#"{"html_url": "https://example.com"}"#), None);
        assert_eq!(parse_latest(r#"{}"#), None);
    }

    #[test]
    fn parse_latest_malformed_json_is_none() {
        assert_eq!(parse_latest("not json"), None);
        assert_eq!(parse_latest(""), None);
    }

    #[test]
    fn parse_latest_empty_values_is_none() {
        assert_eq!(
            parse_latest(r#"{"tag_name": "v", "html_url": "https://x"}"#),
            None
        );
        assert_eq!(
            parse_latest(r#"{"tag_name": "v1.0.0", "html_url": ""}"#),
            None
        );
    }

    #[test]
    fn is_newer_table() {
        let cases: Vec<(&str, &str, bool)> = vec![
            ("1.0.1", "1.0.0", true),
            ("1.10.0", "1.9.9", true),
            ("1.0.0", "1.0.0", false),
            ("1.0.0", "1.0.1", false),
            ("2.0", "1.9.9", true),
            ("1.0", "1.0.0", false),
            ("1.0.0", "1.0", false),
            ("garbage", "1.0.0", false),
            ("1.0.0", "garbage", false),
            ("1.0.0-beta", "1.0.0", false),
        ];

        for (latest, current, expected) in cases {
            assert_eq!(
                is_newer(latest, current),
                expected,
                "is_newer({latest:?}, {current:?})"
            );
        }
    }
}
