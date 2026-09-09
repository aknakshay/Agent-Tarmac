import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { DiffView, DiffModeEnum } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view-pure.css";
import type { StatusChange } from "../types";

type GitFileStatus = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflict";

interface GitFile {
  path: string;
  status: GitFileStatus;
  staged: boolean;
  additions: number;
  deletions: number;
  binary: boolean;
}

interface GitChanges {
  isRepo: boolean;
  repoRoot: string | null;
  branch: string | null;
  files: GitFile[];
}

interface FileDiff {
  path: string;
  diff: string;
  binary: boolean;
  truncated: boolean;
}

interface ChangesPanelProps {
  sessionId: string;
  cwd: string | null;
}

const STATUS_LETTER: Record<GitFileStatus, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  conflict: "!",
};

const STATUS_CLASS: Record<GitFileStatus, string> = {
  modified: "text-accent",
  added: "text-working",
  deleted: "text-needs-you",
  renamed: "text-ink-muted",
  untracked: "text-ink-faint",
  conflict: "text-needs-you",
};

/** Splits a path into (dir, basename) for the dimmed-dir / bold-name display. */
function splitPath(path: string): { dir: string; base: string } {
  const idx = path.lastIndexOf("/");
  if (idx === -1) return { dir: "", base: path };
  return { dir: path.slice(0, idx + 1), base: path.slice(idx + 1) };
}

const REFRESH_DEBOUNCE_MS = 300;

export function ChangesPanel({ sessionId, cwd }: ChangesPanelProps) {
  const [loading, setLoading] = useState(true);
  const [changes, setChanges] = useState<GitChanges | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileDiff, setFileDiff] = useState<FileDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [diffMode, setDiffMode] = useState<DiffModeEnum>(DiffModeEnum.Unified);

  const fetchChanges = useCallback(() => {
    if (!cwd) {
      setLoading(false);
      setChanges({ isRepo: false, repoRoot: null, branch: null, files: [] });
      return;
    }
    setError(null);
    invoke<GitChanges>("git_changes", { cwd })
      .then((result) => {
        setChanges(result);
        // Drop the selection if that file no longer shows as changed (e.g.
        // it was committed or reverted between refreshes).
        setSelectedPath((prev) => (prev && result.files.some((f) => f.path === prev) ? prev : null));
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [cwd]);

  // Initial load + reload whenever the pane's cwd changes.
  useEffect(() => {
    setLoading(true);
    fetchChanges();
  }, [fetchChanges]);

  // Auto-refresh the moment this session's agent stops (idle/needsYou),
  // debounced so a burst of status flapping only triggers one refetch.
  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const statusChanged = listen<StatusChange>("session_status_changed", (event) => {
      if (event.payload.sessionId !== sessionId) return;
      if (event.payload.status !== "idle" && event.payload.status !== "needsYou") return;
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(fetchChanges, REFRESH_DEBOUNCE_MS);
    });
    return () => {
      if (timeout) clearTimeout(timeout);
      statusChanged.then((unlisten) => unlisten());
    };
  }, [sessionId, fetchChanges]);

  // Load the selected file's diff on demand.
  const selectedPathRef = useRef<string | null>(null);
  selectedPathRef.current = selectedPath;
  useEffect(() => {
    if (!selectedPath || !cwd) {
      setFileDiff(null);
      return;
    }
    setDiffLoading(true);
    setDiffError(null);
    invoke<FileDiff>("git_file_diff", { cwd, path: selectedPath })
      .then((result) => {
        // Ignore a stale response for a file the user has since deselected.
        if (selectedPathRef.current === selectedPath) setFileDiff(result);
      })
      .catch((err) => {
        if (selectedPathRef.current === selectedPath) setDiffError(String(err));
      })
      .finally(() => {
        if (selectedPathRef.current === selectedPath) setDiffLoading(false);
      });
  }, [selectedPath, cwd]);

  const isEmpty = changes?.isRepo && changes.files.length === 0;

  return (
    <div className="flex h-full min-h-0 w-full">
      {/* Left: changed-file list */}
      <div className="flex w-64 min-w-0 shrink-0 flex-col border-r border-border">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink-muted">
            {changes?.branch ? changes.branch : "Changes"}
          </span>
          <button
            type="button"
            title="Refresh"
            onClick={() => {
              setLoading(true);
              fetchChanges();
            }}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-faint transition-colors hover:bg-surface-hover hover:text-ink-muted"
          >
            <RefreshIcon />
          </button>
        </div>
        <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto">
          {loading && !changes && <ListSkeleton />}
          {!loading && error && (
            <p className="px-3 py-3 text-xs text-needs-you">Couldn't load changes: {error}</p>
          )}
          {!loading && !error && changes && !changes.isRepo && (
            <p className="px-3 py-3 text-xs text-ink-faint">Not a git repository</p>
          )}
          {!loading && !error && isEmpty && (
            <p className="px-3 py-3 text-xs text-ink-faint">No changes</p>
          )}
          {!loading &&
            !error &&
            changes?.isRepo &&
            changes.files.map((file) => {
              const { dir, base } = splitPath(file.path);
              const active = file.path === selectedPath;
              return (
                <button
                  key={file.path}
                  type="button"
                  onClick={() => setSelectedPath(file.path)}
                  aria-current={active ? "true" : undefined}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors duration-100 ${
                    active ? "bg-surface-hover" : "hover:bg-surface-hover"
                  }`}
                >
                  <span
                    className={`w-3 shrink-0 text-center text-[11px] font-semibold ${STATUS_CLASS[file.status]}`}
                    title={file.status}
                    aria-hidden="true"
                  >
                    {STATUS_LETTER[file.status]}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs">
                    <span className="text-ink-faint">{dir}</span>
                    <span className="text-ink">{base}</span>
                  </span>
                  {!file.binary && (
                    <span className="flex shrink-0 items-center gap-1 text-[11px] tabular-nums">
                      {file.additions > 0 && <span className="text-working">+{file.additions}</span>}
                      {file.deletions > 0 && <span className="text-needs-you">−{file.deletions}</span>}
                    </span>
                  )}
                </button>
              );
            })}
        </div>
      </div>

      {/* Right: selected file's diff */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {selectedPath && (
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink">{selectedPath}</span>
            <div className="flex shrink-0 items-center rounded-md border border-border p-0.5 text-[11px]">
              <button
                type="button"
                onClick={() => setDiffMode(DiffModeEnum.Unified)}
                className={`rounded-sm px-2 py-0.5 font-medium transition-colors ${
                  diffMode === DiffModeEnum.Unified
                    ? "bg-surface-hover text-ink"
                    : "text-ink-faint hover:text-ink-muted"
                }`}
              >
                Unified
              </button>
              <button
                type="button"
                onClick={() => setDiffMode(DiffModeEnum.Split)}
                className={`rounded-sm px-2 py-0.5 font-medium transition-colors ${
                  diffMode === DiffModeEnum.Split
                    ? "bg-surface-hover text-ink"
                    : "text-ink-faint hover:text-ink-muted"
                }`}
              >
                Split
              </button>
            </div>
          </div>
        )}
        <div className="thin-scrollbar min-h-0 flex-1 overflow-auto">
          {!selectedPath && (
            <div className="flex h-full items-center justify-center text-xs text-ink-faint">
              Select a file to see its diff
            </div>
          )}
          {selectedPath && diffLoading && (
            <div className="flex h-full items-center justify-center text-xs text-ink-faint">Loading diff…</div>
          )}
          {selectedPath && !diffLoading && diffError && (
            <p className="px-3 py-3 text-xs text-needs-you">Couldn't load diff: {diffError}</p>
          )}
          {selectedPath && !diffLoading && !diffError && fileDiff?.binary && (
            <div className="flex h-full items-center justify-center text-xs text-ink-faint">
              Binary file — no preview
            </div>
          )}
          {selectedPath && !diffLoading && !diffError && fileDiff && !fileDiff.binary && (
            <>
              {fileDiff.truncated && (
                <p className="border-b border-border bg-surface px-3 py-1.5 text-[11px] text-needs-you">
                  Diff truncated
                </p>
              )}
              {fileDiff.diff.trim() === "" ? (
                <p className="px-3 py-3 text-xs text-ink-faint">No visible diff</p>
              ) : (
                <DiffView
                  key={fileDiff.path}
                  data={{
                    oldFile: { fileName: fileDiff.path },
                    newFile: { fileName: fileDiff.path },
                    hunks: [fileDiff.diff],
                  }}
                  diffViewMode={diffMode}
                  diffViewTheme="dark"
                  diffViewHighlight
                  diffViewFontSize={12}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-1 px-3 py-3">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="h-4 animate-pulse rounded bg-surface-hover" style={{ opacity: 1 - i * 0.12 }} />
      ))}
    </div>
  );
}

function RefreshIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3 w-3 shrink-0 fill-none stroke-current"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M13 8A5 5 0 1 1 11.5 4.5" />
      <path d="M13 2v3.5H9.5" />
    </svg>
  );
}
