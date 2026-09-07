use crate::backend::{self, SessionBackend};
use crate::session_cache::{SessionCacheState, TokenEntry};
use chrono::{DateTime, Local, NaiveDate, Utc};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

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
        // Every session counts toward the lifetime token total, including
        // hidden ChatGPT-app Codex rollouts (per the product decision): the
        // tokenmaxxing number is the honest all-surfaces total, even though
        // those sessions stay hidden in the sidebar list.

        // Transcripts are append-only, so a file whose mtime falls
        // before local midnight cannot contain any of today's
        // records — skip the per-line timestamp parse/compare for
        // those files entirely. Pure overhead saved on a long history
        // of old sessions; today's own files still get the full check.
        let could_have_today = std::fs::metadata(&file_path)
            .and_then(|m| m.modified())
            .map(|m| DateTime::<Local>::from(m).date_naive() >= today)
            .unwrap_or(true);

        // Stream line-by-line rather than read_to_string: a single Codex
        // rollout reaches 1.48 GB, and slurping it would blow memory and time.
        let Ok(file) = std::fs::File::open(&file_path) else {
            continue;
        };
        let reader = BufReader::new(file);
        let mut had_usage = false;
        for line in reader.lines().map_while(Result::ok) {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
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

/// Fold one file's (or backend's) stats into the running fleet total.
/// Field-wise add, factored out so the summation is unit-testable without
/// reaching the real `~/.claude` / `~/.codex` roots.
fn accumulate(total: &mut TokenStats, s: &TokenStats) {
    total.today_output += s.today_output;
    total.today_input += s.today_input;
    total.today_cache_read += s.today_cache_read;
    total.total_output += s.total_output;
    total.total_input += s.total_input;
    total.session_count += s.session_count;
}

/// Usage summed out of one contiguous byte range of a transcript.
#[derive(Default)]
struct RangeUsage {
    total_input: u64,
    total_output: u64,
    today_input: u64,
    today_output: u64,
    today_cache_read: u64,
    had_usage: bool,
}

/// Stream `[from_offset, EOF)` of `path`, summing usage line-by-line (never
/// slurping — a rollout can be 1.48 GB). `from_offset` must sit on a line
/// boundary; we only ever pass a previously stored `size`, and both CLIs write
/// one newline-terminated record per line, so appended bytes start a fresh
/// record. Today buckets are counted against `today`.
fn stream_usage_from(
    backend: &dyn SessionBackend,
    path: &Path,
    from_offset: u64,
    today: NaiveDate,
) -> RangeUsage {
    let mut u = RangeUsage::default();
    let Ok(mut file) = std::fs::File::open(path) else {
        return u;
    };
    if from_offset > 0 && file.seek(SeekFrom::Start(from_offset)).is_err() {
        return u;
    }
    let reader = BufReader::new(file);
    for line in reader.lines().map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let Some((input, output, cache_read)) = backend.usage_from_record(&v) else {
            continue;
        };
        u.had_usage = true;
        u.total_input += input;
        u.total_output += output;
        if let Some(ts) = backend.record_timestamp(&v) {
            if ts.with_timezone(&Local).date_naive() == today {
                u.today_input += input;
                u.today_output += output;
                u.today_cache_read += cache_read;
            }
        }
    }
    u
}

/// The fleet total, computed against the persisted per-file token cache. Every
/// transcript is summed — including hidden ChatGPT-app Codex rollouts, per the
/// product decision that the lifetime total be honest across all surfaces. For
/// each transcript:
///   * an unchanged `(mtime, size)` reuses cached totals with no read — today
///     buckets are honored only when they were computed for the same local
///     date, else they reset to zero;
///   * a grown (appended) file reads only its new `[offset, size)` bytes and
///     adds them to the cached running totals;
///   * a new or rewritten (shrunk) file is read whole.
///
/// Cache entries for vanished files are pruned. This is where the 27 GB stops
/// being rescanned every 60 s.
///
/// Operates on the token map ALONE (not the whole [`PersistentCache`]) so the
/// caller can clone just that map and run this — a ~35 s cold read of every
/// surface — WITHOUT holding the shared cache lock, keeping the session watcher
/// and startup scan responsive meanwhile (see [`refresh_if_stale`]).
fn compute_stats_all_cached(
    tokens: &mut HashMap<String, TokenEntry>,
    today: NaiveDate,
) -> TokenStats {
    let roots = backend::all_backends()
        .iter()
        .map(|b| (*b, b.transcripts_root()));
    compute_over_cached(tokens, roots, today)
}

/// The cache-aware summation core, taking explicit `(backend, root)` pairs so
/// it is unit-testable against fixture roots without mutating the process-wide
/// `AGENT_TARMAC_*_DIR` env vars that other tests read in parallel.
fn compute_over_cached<'a>(
    tokens: &mut HashMap<String, TokenEntry>,
    roots: impl Iterator<Item = (&'a dyn SessionBackend, std::path::PathBuf)>,
    today: NaiveDate,
) -> TokenStats {
    let mut total = TokenStats::default();
    let mut seen = HashSet::new();
    for (b, root) in roots {
        for path in b.transcript_files(&root) {
            let key = path.to_string_lossy().to_string();
            seen.insert(key.clone());
            let Some((mtime, size)) = crate::session_cache::stat_key(&path) else {
                continue;
            };

            let prior = tokens.get(&key).cloned();
            let entry = match &prior {
                // Unchanged: reuse everything; today buckets only if same day.
                Some(e) if e.mtime == mtime && e.size == size => {
                    let mut e = e.clone();
                    if e.today_date != Some(today) {
                        e.today_date = Some(today);
                        e.today_input = 0;
                        e.today_output = 0;
                        e.today_cache_read = 0;
                    }
                    e
                }
                // Grew (append-only): sum only the new tail bytes onto cached
                // totals. today buckets seed from cache only when same-day.
                Some(e) if size > e.size => {
                    let seed_today = e.today_date == Some(today);
                    let d = stream_usage_from(b, &path, e.offset, today);
                    TokenEntry {
                        mtime,
                        size,
                        offset: size,
                        total_input: e.total_input + d.total_input,
                        total_output: e.total_output + d.total_output,
                        has_usage: e.has_usage || d.had_usage,
                        today_date: Some(today),
                        today_input: if seed_today { e.today_input } else { 0 } + d.today_input,
                        today_output: if seed_today { e.today_output } else { 0 } + d.today_output,
                        today_cache_read: if seed_today { e.today_cache_read } else { 0 }
                            + d.today_cache_read,
                    }
                }
                // New file, or one that shrank / was rewritten: read it whole.
                _ => {
                    let d = stream_usage_from(b, &path, 0, today);
                    TokenEntry {
                        mtime,
                        size,
                        offset: size,
                        total_input: d.total_input,
                        total_output: d.total_output,
                        has_usage: d.had_usage,
                        today_date: Some(today),
                        today_input: d.today_input,
                        today_output: d.today_output,
                        today_cache_read: d.today_cache_read,
                    }
                }
            };

            accumulate(
                &mut total,
                &TokenStats {
                    today_output: entry.today_output,
                    today_input: entry.today_input,
                    today_cache_read: entry.today_cache_read,
                    total_output: entry.total_output,
                    total_input: entry.total_input,
                    session_count: if entry.has_usage { 1 } else { 0 },
                },
            );
            tokens.insert(key, entry);
        }
    }
    tokens.retain(|k, _| seen.contains(k));
    total
}

fn refresh_if_stale(cache_state: &SessionCacheState, cache_path: Option<&Path>) -> TokenStats {
    let mut guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let stale = guard
        .as_ref()
        .map(|c| c.scanned_at.elapsed() >= REFRESH_INTERVAL)
        .unwrap_or(true);
    if stale {
        let today = Local::now().date_naive();

        // Clone JUST the token map out from under the cache lock, then compute
        // (a possibly ~35 s cold read of every surface) with NO lock held, so
        // the session watcher and startup scan aren't stalled behind us. The
        // `token_stats` command runs this on Tauri's blocking pool (see there),
        // never the UI thread, so the window stays responsive; Home shows its
        // last-known / zero number until we return.
        let mut tokens = {
            let pc = cache_state.0.lock().unwrap_or_else(|e| e.into_inner());
            pc.tokens.clone()
        };
        let stats = compute_stats_all_cached(&mut tokens, today);

        // Write the updated token map back, preserving any session-cache
        // updates the watcher made while we were reading, then snapshot for the
        // lock-free disk save.
        let snapshot = {
            let mut pc = cache_state.0.lock().unwrap_or_else(|e| e.into_inner());
            pc.tokens = tokens;
            pc.clone()
        };
        if let Some(path) = cache_path {
            let _ = crate::session_cache::save(path, &snapshot);
        }
        *guard = Some(CacheEntry {
            stats,
            scanned_at: Instant::now(),
        });
    }
    guard.as_ref().expect("populated above").stats
}

#[tauri::command]
pub async fn token_stats(app: tauri::AppHandle) -> Result<TokenStats, String> {
    // CRITICAL: a plain synchronous `#[tauri::command]` runs on Tauri's MAIN
    // thread, so the ~35 s cold read below would freeze the entire webview —
    // no splash animation, a sidebar that can't paint the sessions the
    // background scan already found, the whole UI locked until it returns.
    // `spawn_blocking` moves it onto the dedicated blocking pool (never the UI
    // thread, never an async worker), keeping the window fully responsive while
    // the tokens compute; Home renders its `tokensLoaded=false` state meanwhile.
    tauri::async_runtime::spawn_blocking(move || {
        let path = crate::session_cache::cache_path(&app);
        let cache = app.state::<SessionCacheState>();
        refresh_if_stale(&cache, path.as_deref())
    })
    .await
    .map_err(|e| e.to_string())
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

    // ---- cached / incremental path (compute_over_cached) ----

    fn write_claude_usage(path: &std::path::Path, records: &[(u64, u64, u64, &str)]) {
        use std::io::Write;
        let mut f = std::fs::File::create(path).unwrap();
        for (input, output, cache_read, ts) in records {
            writeln!(
                f,
                r#"{{"type":"assistant","timestamp":"{ts}","message":{{"usage":{{"input_tokens":{input},"output_tokens":{output},"cache_read_input_tokens":{cache_read}}}}}}}"#
            )
            .unwrap();
        }
        f.flush().unwrap();
    }

    fn append_claude_usage(path: &std::path::Path, records: &[(u64, u64, u64, &str)]) {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().append(true).open(path).unwrap();
        for (input, output, cache_read, ts) in records {
            writeln!(
                f,
                r#"{{"type":"assistant","timestamp":"{ts}","message":{{"usage":{{"input_tokens":{input},"output_tokens":{output},"cache_read_input_tokens":{cache_read}}}}}}}"#
            )
            .unwrap();
        }
        f.flush().unwrap();
    }

    #[test]
    fn cached_scan_matches_uncached_on_a_cold_cache() {
        // A cold cache must produce byte-identical numbers to the direct
        // `compute_stats` over the same Claude fixture root — the cache is a
        // speedup, never a semantics change.
        let b: &dyn SessionBackend = &backend::CLAUDE;
        let today = today_from_fixture();
        let direct = compute_stats(b, &fixtures_dir(), today);

        let mut cache: HashMap<String, TokenEntry> = HashMap::new();
        let cached = compute_over_cached(&mut cache, std::iter::once((b, fixtures_dir())), today);
        assert_eq!(cached, direct);
    }

    #[test]
    fn cached_scan_reads_only_appended_bytes_and_stays_correct() {
        let b: &dyn SessionBackend = &backend::CLAUDE;
        let dir = tempfile::tempdir().unwrap();
        let proj = dir.path().join("-Users-me-proj");
        std::fs::create_dir_all(&proj).unwrap();
        let file = proj.join("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl");

        let today = "2026-06-15T12:00:00Z"
            .parse::<DateTime<Utc>>()
            .unwrap()
            .with_timezone(&Local)
            .date_naive();

        // First scan: one record dated today.
        write_claude_usage(&file, &[(100, 50, 10, "2026-06-15T12:00:00Z")]);
        let mut cache: HashMap<String, TokenEntry> = HashMap::new();
        let root = dir.path().to_path_buf();
        let s1 = compute_over_cached(&mut cache, std::iter::once((b, root.clone())), today);
        assert_eq!((s1.total_input, s1.total_output), (100, 50));
        assert_eq!(
            (s1.today_input, s1.today_output, s1.today_cache_read),
            (100, 50, 10)
        );
        assert_eq!(s1.session_count, 1);
        let offset_after_first = cache.values().next().unwrap().offset;

        // Append a second record dated in the past (not today). Rescan reuses
        // the cached running totals and only reads the new bytes.
        append_claude_usage(&file, &[(200, 80, 5, "2026-01-01T00:00:00Z")]);
        let s2 = compute_over_cached(&mut cache, std::iter::once((b, root.clone())), today);
        assert_eq!((s2.total_input, s2.total_output), (300, 130));
        // Today bucket unchanged — the appended record isn't today.
        assert_eq!(
            (s2.today_input, s2.today_output, s2.today_cache_read),
            (100, 50, 10)
        );
        assert_eq!(s2.session_count, 1);
        // The stored offset advanced past the appended bytes.
        assert!(cache.values().next().unwrap().offset > offset_after_first);

        // Third scan, file unchanged: pure cache hit, identical numbers.
        let s3 = compute_over_cached(&mut cache, std::iter::once((b, root)), today);
        assert_eq!(s3, s2);
    }

    #[test]
    fn cached_scan_prunes_vanished_files_and_resets_today_on_new_day() {
        let b: &dyn SessionBackend = &backend::CLAUDE;
        let dir = tempfile::tempdir().unwrap();
        let proj = dir.path().join("-Users-me-proj");
        std::fs::create_dir_all(&proj).unwrap();
        let file = proj.join("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl");
        write_claude_usage(&file, &[(100, 50, 10, "2026-06-15T12:00:00Z")]);

        let day1 = "2026-06-15T12:00:00Z"
            .parse::<DateTime<Utc>>()
            .unwrap()
            .with_timezone(&Local)
            .date_naive();
        let mut cache: HashMap<String, TokenEntry> = HashMap::new();
        let root = dir.path().to_path_buf();
        let s1 = compute_over_cached(&mut cache, std::iter::once((b, root.clone())), day1);
        assert_eq!(s1.today_input, 100);

        // Same file, unchanged, but scanned on a later day: totals persist,
        // today buckets reset to zero (the record is no longer "today").
        let day2 = day1.succ_opt().unwrap();
        let s2 = compute_over_cached(&mut cache, std::iter::once((b, root.clone())), day2);
        assert_eq!(s2.total_input, 100);
        assert_eq!(
            (s2.today_input, s2.today_output, s2.today_cache_read),
            (0, 0, 0)
        );

        // Delete the file: its cache entry is pruned and totals go to zero.
        std::fs::remove_file(&file).unwrap();
        let s3 = compute_over_cached(&mut cache, std::iter::once((b, root)), day2);
        assert_eq!(s3, TokenStats::default());
        assert!(cache.is_empty());
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
