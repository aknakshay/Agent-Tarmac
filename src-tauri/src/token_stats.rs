use crate::backend::{self, SessionBackend};
use chrono::{DateTime, Local, NaiveDate, Utc};
use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Aggregated agent token usage across every transcript on disk, summed over
/// all backends (Claude + Codex) — backs the Home screen's "tokenmaxxing"
/// stats and the shareable snapshot card. Field names are camelCase on the
/// wire so the TS side needs no manual mapping.
#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TokenStats {
    pub today_output: u64,
    pub today_input: u64,
    pub today_cache_read: u64,
    pub total_output: u64,
    pub total_input: u64,
    /// Distinct transcripts (sessions) that contain at least one usage
    /// record, across every backend's transcript root. All-time, not "today".
    pub session_count: u64,
}

struct CacheEntry {
    stats: TokenStats,
    scanned_at: Instant,
}

/// A full scan of every transcript is too slow to repeat on every call once
/// history grows large, so results are cached and refreshed at most this
/// often; callers in between get the last computed snapshot. Mirrors
/// session_index's watcher-driven cache in spirit, but time-based since
/// usage counts don't have as cheap a filesystem-event trigger.
const REFRESH_INTERVAL: Duration = Duration::from_secs(60);

static CACHE: Mutex<Option<CacheEntry>> = Mutex::new(None);

/// Pulls `(input, output, cache_read)` out of an `{"type":"assistant",
/// "message":{"usage":{...}}}` record. `None` for any other record shape
/// (user/summary lines, or a line serde_json can't even parse — callers
/// skip those before this is called).
///
/// `pub` so [`crate::backend::ClaudeBackend`] can expose it as its token-usage
/// seam; the pure parse logic stays here in the seam module.
pub fn usage_from_record(v: &serde_json::Value) -> Option<(u64, u64, u64)> {
    if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
        return None;
    }
    let usage = v.get("message")?.get("usage")?;
    let input = usage
        .get("input_tokens")
        .and_then(|n| n.as_u64())
        .unwrap_or(0);
    let output = usage
        .get("output_tokens")
        .and_then(|n| n.as_u64())
        .unwrap_or(0);
    let cache_read = usage
        .get("cache_read_input_tokens")
        .and_then(|n| n.as_u64())
        .unwrap_or(0);
    Some((input, output, cache_read))
}

/// The wall-clock timestamp of one transcript record. `pub` for the same
/// reason as [`usage_from_record`] — it's part of the token-usage seam the
/// Claude backend exposes.
pub fn record_timestamp(v: &serde_json::Value) -> Option<DateTime<Utc>> {
    v.get("timestamp")?.as_str()?.parse().ok()
}

/// Pure scan over one `backend`'s transcripts under `root`, bucketed against
/// the caller-supplied `today` local calendar date rather than reading the
/// wall clock itself — keeps this directly unit-testable with fixed fixture
/// timestamps, the same pattern `stats.ts`'s `dayKey` follows on the frontend.
///
/// The on-disk topology (which files exist) and the per-record parse
/// (`usage_from_record`, `record_timestamp`) come from the backend; the
/// today-vs-all-time bucketing and the mtime fast-path here are
/// backend-agnostic.
pub fn compute_stats(backend: &dyn SessionBackend, root: &Path, today: NaiveDate) -> TokenStats {
    let mut stats = TokenStats::default();
    for file_path in backend.transcript_files(root) {
        let Ok(content) = std::fs::read_to_string(&file_path) else {
            continue;
        };

        // Transcripts are append-only, so a file whose mtime falls
        // before local midnight cannot contain any of today's
        // records — skip the per-line timestamp parse/compare for
        // those files entirely. Pure overhead saved on a long history
        // of old sessions; today's own files still get the full check.
        let could_have_today = std::fs::metadata(&file_path)
            .and_then(|m| m.modified())
            .map(|m| DateTime::<Local>::from(m).date_naive() >= today)
            .unwrap_or(true);

        let mut had_usage = false;
        for line in content.lines() {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            let Some((input, output, cache_read)) = backend.usage_from_record(&v) else {
                continue;
            };
            had_usage = true;
            stats.total_input += input;
            stats.total_output += output;
            if could_have_today {
                if let Some(ts) = backend.record_timestamp(&v) {
                    if ts.with_timezone(&Local).date_naive() == today {
                        stats.today_input += input;
                        stats.today_output += output;
                        stats.today_cache_read += cache_read;
                    }
                }
            }
        }
        if had_usage {
            stats.session_count += 1;
        }
    }
    stats
}

/// Fold one backend's stats into the running fleet total. Field-wise add,
/// factored out so `compute_stats_all`'s summation is unit-testable without
/// reaching the real `~/.claude` / `~/.codex` roots.
fn accumulate(total: &mut TokenStats, s: &TokenStats) {
    total.today_output += s.today_output;
    total.today_input += s.today_input;
    total.today_cache_read += s.today_cache_read;
    total.total_output += s.total_output;
    total.total_input += s.total_input;
    total.session_count += s.session_count;
}

/// Sum token usage across every registered backend (Claude + Codex), each
/// scanned at its own on-disk root. This is what the Home "tokenmaxxing"
/// number and the snapshot card ultimately read, so Codex usage flows into
/// the fleet total here.
fn compute_stats_all(today: NaiveDate) -> TokenStats {
    let mut total = TokenStats::default();
    for b in backend::all_backends() {
        let s = compute_stats(*b, &b.transcripts_root(), today);
        accumulate(&mut total, &s);
    }
    total
}

fn refresh_if_stale() -> TokenStats {
    let mut guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let stale = guard
        .as_ref()
        .map(|c| c.scanned_at.elapsed() >= REFRESH_INTERVAL)
        .unwrap_or(true);
    if stale {
        let today = Local::now().date_naive();
        let stats = compute_stats_all(today);
        *guard = Some(CacheEntry {
            stats,
            scanned_at: Instant::now(),
        });
    }
    guard.as_ref().expect("populated above").stats
}

#[tauri::command]
pub fn token_stats() -> TokenStats {
    refresh_if_stale()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixtures_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/token_projects")
    }

    fn codex_fixtures_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/codex")
    }

    /// "today" derived from the Codex fixture's token_usage_record timestamp
    /// through the same Utc -> Local -> date_naive path the code uses, so the
    /// bucketing test is timezone-independent.
    fn codex_today_from_fixture() -> NaiveDate {
        "2026-09-06T14:47:34Z"
            .parse::<DateTime<Utc>>()
            .unwrap()
            .with_timezone(&Local)
            .date_naive()
    }

    /// The "today" fixture record's own timestamp, converted through the
    /// same Utc -> Local -> date_naive path the code uses, so this test
    /// passes under any machine timezone instead of assuming UTC.
    fn today_from_fixture() -> NaiveDate {
        "2026-01-01T12:00:00Z"
            .parse::<DateTime<Utc>>()
            .unwrap()
            .with_timezone(&Local)
            .date_naive()
    }

    #[test]
    fn buckets_today_vs_all_time_and_counts_sessions() {
        let stats = compute_stats(&backend::CLAUDE, &fixtures_dir(), today_from_fixture());
        // Only the proj-a record dated 2026-01-01 counts toward "today".
        assert_eq!(stats.today_input, 100);
        assert_eq!(stats.today_output, 50);
        assert_eq!(stats.today_cache_read, 10);
        // All three usage records across both files count toward totals.
        assert_eq!(stats.total_input, 100 + 200 + 300);
        assert_eq!(stats.total_output, 50 + 80 + 150);
        // Two files carried at least one usage record.
        assert_eq!(stats.session_count, 2);
    }

    #[test]
    fn non_matching_today_yields_zero_today_bucket_but_same_totals() {
        // A "today" that matches none of the fixture timestamps: totals are
        // unaffected, today bucket stays at zero.
        let far_future = NaiveDate::from_ymd_opt(2099, 1, 1).unwrap();
        let stats = compute_stats(&backend::CLAUDE, &fixtures_dir(), far_future);
        assert_eq!(stats.today_input, 0);
        assert_eq!(stats.today_output, 0);
        assert_eq!(stats.today_cache_read, 0);
        assert_eq!(stats.total_input, 100 + 200 + 300);
        assert_eq!(stats.session_count, 2);
    }

    #[test]
    fn missing_dir_returns_default() {
        assert_eq!(
            compute_stats(
                &backend::CLAUDE,
                Path::new("/nope/definitely-not-here"),
                today_from_fixture()
            ),
            TokenStats::default()
        );
    }

    #[test]
    fn codex_backend_extracts_per_response_usage() {
        // Codex flows through the SAME compute_stats seam as Claude, just with
        // the Codex backend + its date-sharded fixture tree. Fixture A carries
        // one token_usage_record (100/50/10) dated 2026-09-06; fixture B has
        // none, so it contributes nothing (no session, no tokens).
        let stats = compute_stats(
            &backend::CODEX,
            &codex_fixtures_dir(),
            codex_today_from_fixture(),
        );
        assert_eq!(stats.total_input, 100);
        // 50, NOT 55 — reasoning_output_tokens (5) is already inside output.
        assert_eq!(stats.total_output, 50);
        assert_eq!(stats.today_input, 100);
        assert_eq!(stats.today_output, 50);
        assert_eq!(stats.today_cache_read, 10);
        // Only fixture A has a usage record; fixture B (desktop-bundled shape)
        // does not, so exactly one session counts.
        assert_eq!(stats.session_count, 1);
    }

    #[test]
    fn fleet_total_sums_claude_and_codex_without_disturbing_claude() {
        // Mirrors what compute_stats_all does (accumulate over all backends),
        // but with fixture roots instead of the real ~/.claude / ~/.codex.
        // Proves Codex tokens ADD to the fleet total and Claude's numbers are
        // unchanged by Codex's presence.
        let claude = compute_stats(&backend::CLAUDE, &fixtures_dir(), today_from_fixture());
        let codex = compute_stats(&backend::CODEX, &codex_fixtures_dir(), today_from_fixture());

        let mut fleet = TokenStats::default();
        accumulate(&mut fleet, &claude);
        accumulate(&mut fleet, &codex);

        // Claude portion is exactly the standalone Claude numbers (unchanged).
        assert_eq!(claude.total_input, 100 + 200 + 300);
        assert_eq!(claude.total_output, 50 + 80 + 150);
        assert_eq!(claude.session_count, 2);

        // Fleet total is Claude + Codex, field by field.
        assert_eq!(fleet.total_input, claude.total_input + codex.total_input);
        assert_eq!(fleet.total_output, claude.total_output + codex.total_output);
        assert_eq!(
            fleet.session_count,
            claude.session_count + codex.session_count
        );
        assert_eq!(fleet.today_input, claude.today_input + codex.today_input);
        assert_eq!(fleet.today_output, claude.today_output + codex.today_output);
        assert_eq!(
            fleet.today_cache_read,
            claude.today_cache_read + codex.today_cache_read
        );
    }
}
