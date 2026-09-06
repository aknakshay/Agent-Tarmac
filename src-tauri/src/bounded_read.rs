//! Bounded head+tail file reading for transcript metadata extraction.
//!
//! Everything the sidebar needs from a transcript lives at the file *edges*:
//! the session_meta / first user turn at the HEAD, and the last activity /
//! last role in the final record at the TAIL. The middle — which on this
//! author's machine reaches 1.48 GB in a single Codex rollout, 27 GB across
//! all of them — is never needed by a launcher+dashboard: opening a session
//! spawns the CLI, which loads its own history. So we read only the edges and
//! never the middle.
//!
//! [`read_head_tail`] returns the JSONL lines to parse, in file order, with the
//! guarantee that a file small enough to fit in `head + tail` is read whole —
//! so its extracted [`crate::transcript::SessionMeta`] is byte-identical to a
//! full-file parse (every existing fixture is far under the window). A larger
//! file yields the first [`HEAD_BYTES`] and last [`TAIL_BYTES`] only; the tail
//! chunk's first, likely-partial line is discarded.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// Bytes read from the start of a large file. Sized to comfortably clear the
/// `session_meta` record plus the first several user/assistant turns (the
/// title source) on any real transcript — the widest observed head prefix is a
/// few KB.
pub const HEAD_BYTES: u64 = 128 * 1024;

/// Bytes read from the end of a large file. The last record (last_activity,
/// last_role) sits at the very tail; 64 KB clears even a large trailing
/// assistant message plus its usage record.
pub const TAIL_BYTES: u64 = 64 * 1024;

/// The head and (for large files) tail text of a transcript. Iterate
/// [`lines`](Chunks::lines) to parse it exactly as a full-file `content.lines()`
/// walk would, head records before tail records.
pub struct Chunks {
    head: String,
    /// `None` when the whole file fit in the window and was read into `head`.
    tail: Option<String>,
    /// True when the middle was skipped (a large file). Exposed for tests /
    /// diagnostics; the parse path doesn't care.
    pub bounded: bool,
}

impl Chunks {
    /// The JSONL lines to parse, in file order: every head line, then every
    /// tail line (the tail's discarded partial first line already stripped).
    /// A line the head window cut mid-record simply fails JSON parse at the
    /// call site and is skipped, exactly like any other malformed line.
    pub fn lines(&self) -> impl Iterator<Item = &str> {
        self.head
            .lines()
            .chain(self.tail.as_deref().unwrap_or("").lines())
    }
}

/// Read the head (and, for a large file, the tail) of `path`. `None` only if
/// the file can't be opened or its length can't be stat'd.
///
/// A file of `len <= HEAD_BYTES + TAIL_BYTES` is read whole via
/// [`std::fs::read_to_string`] — identical to the pre-existing full-file read,
/// so small fixtures parse bit-for-bit as before (invalid UTF-8 ⇒ `None`, as
/// before). A larger file is read as two byte windows and decoded lossily,
/// since a fixed byte offset can land mid-codepoint; a replacement char in a
/// boundary line just makes that one line fail JSON parse.
pub fn read_head_tail(path: &Path) -> Option<Chunks> {
    let mut file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();

    if len <= HEAD_BYTES + TAIL_BYTES {
        // Small file: read it whole, matching the old read_to_string path
        // exactly (this is what keeps every existing parse fixture identical).
        let content = std::fs::read_to_string(path).ok()?;
        return Some(Chunks {
            head: content,
            tail: None,
            bounded: false,
        });
    }

    // Large file: head window from the start.
    let mut head_buf = vec![0u8; HEAD_BYTES as usize];
    file.read_exact(&mut head_buf).ok()?;
    let head = String::from_utf8_lossy(&head_buf).into_owned();

    // Tail window from the end. Since len > HEAD_BYTES + TAIL_BYTES the two
    // windows cannot overlap, so no record is seen twice.
    file.seek(SeekFrom::Start(len - TAIL_BYTES)).ok()?;
    let mut tail_buf = vec![0u8; TAIL_BYTES as usize];
    file.read_exact(&mut tail_buf).ok()?;
    let tail_raw = String::from_utf8_lossy(&tail_buf).into_owned();

    // The tail window almost certainly starts mid-line; drop everything up to
    // and including the first newline so the first *kept* line is a complete
    // record. If there's no newline at all (one pathological 64 KB+ line),
    // keep nothing rather than feed a guaranteed-partial record to the parser.
    let tail = match tail_raw.find('\n') {
        Some(nl) => tail_raw[nl + 1..].to_string(),
        None => String::new(),
    };

    Some(Chunks {
        head,
        tail: Some(tail),
        bounded: true,
    })
}

/// Read just the head window of `path` as text — for a cheap classification
/// probe (e.g. a transcript's originator) that never needs the tail. Returns
/// the whole file if it's smaller than [`HEAD_BYTES`].
pub fn read_head(path: &Path) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    if len <= HEAD_BYTES {
        return std::fs::read_to_string(path).ok();
    }
    let mut head_buf = vec![0u8; HEAD_BYTES as usize];
    file.read_exact(&mut head_buf).ok()?;
    Some(String::from_utf8_lossy(&head_buf).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn small_file_is_read_whole_not_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("small.jsonl");
        std::fs::write(&p, "{\"a\":1}\n{\"b\":2}\n").unwrap();
        let chunks = read_head_tail(&p).unwrap();
        assert!(!chunks.bounded, "a small file must not be windowed");
        let lines: Vec<&str> = chunks.lines().collect();
        assert_eq!(lines, vec!["{\"a\":1}", "{\"b\":2}"]);
    }

    /// Append benign `{"pad":..}` filler lines until at least `bytes` more have
    /// been written past `written`; returns the new running byte count. The
    /// filler is what pushes the sentinel out of the head window (and the tail
    /// line out of the tail window's reach of the sentinel).
    fn pad(f: &mut File, mut written: u64, bytes: u64) -> u64 {
        let line = format!(r#"{{"pad":"{}"}}"#, "p".repeat(200));
        let target = written + bytes;
        while written < target {
            writeln!(f, "{line}").unwrap();
            written += line.len() as u64 + 1;
        }
        written
    }

    #[test]
    fn large_file_reads_edges_not_middle() {
        // Layout: real head line, >HEAD_BYTES of benign pad, a MIDDLE_SENTINEL
        // block in the deep middle, >TAIL_BYTES of benign pad, real tail line.
        // The sentinel therefore sits strictly between the head and tail
        // windows; if the middle were read it would appear in the output.
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("big.jsonl");
        let mut f = File::create(&p).unwrap();
        let mut written = 0u64;
        written += writeln_len(&mut f, r#"{"head":"first"}"#);
        written = pad(&mut f, written, HEAD_BYTES + 16 * 1024);
        // Deep middle: ~1 MB of sentinel lines.
        let sentinel = format!(r#"{{"MIDDLE_SENTINEL":"{}"}}"#, "x".repeat(200));
        let mid_target = written + 1024 * 1024;
        while written < mid_target {
            writeln!(f, "{sentinel}").unwrap();
            written += sentinel.len() as u64 + 1;
        }
        let written = pad(&mut f, written, TAIL_BYTES + 16 * 1024);
        let _ = written;
        writeln_len(&mut f, r#"{"tail":"last"}"#);
        f.flush().unwrap();
        drop(f);

        let len = std::fs::metadata(&p).unwrap().len();
        assert!(
            len > HEAD_BYTES + TAIL_BYTES,
            "test file must exceed window"
        );

        let chunks = read_head_tail(&p).unwrap();
        assert!(chunks.bounded, "a large file must be windowed");
        let joined: String = chunks.lines().collect::<Vec<_>>().join("\n");
        assert!(
            joined.contains("\"head\":\"first\""),
            "head must be present"
        );
        assert!(joined.contains("\"tail\":\"last\""), "tail must be present");
        assert!(
            !joined.contains("MIDDLE_SENTINEL"),
            "the middle must never be read"
        );
    }

    fn writeln_len(f: &mut File, line: &str) -> u64 {
        writeln!(f, "{line}").unwrap();
        line.len() as u64 + 1
    }

    #[test]
    fn missing_file_returns_none() {
        assert!(read_head_tail(Path::new("/nope/does-not-exist.jsonl")).is_none());
        assert!(read_head(Path::new("/nope/does-not-exist.jsonl")).is_none());
    }
}
