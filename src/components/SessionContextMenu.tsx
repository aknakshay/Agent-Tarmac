import { useEffect, useMemo, useRef, useState } from "react";
import { useDeck } from "../store";
import type { Session } from "../types";

interface SessionContextMenuProps {
  session: Session;
  /** Viewport coordinates of the click that opened the menu. */
  x: number;
  y: number;
  allTags: string[];
  onClose(): void;
  onRequestRename(): void;
}

const MENU_WIDTH = 240;
const MENU_MARGIN = 8;

export function SessionContextMenu({ session, x, y, allTags, onClose, onRequestRename }: SessionContextMenuProps) {
  const setMarkedUnread = useDeck((state) => state.setMarkedUnread);
  const toggleFavorite = useDeck((state) => state.toggleFavorite);
  const addTag = useDeck((state) => state.addTag);
  const removeTag = useDeck((state) => state.removeTag);

  const menuRef = useRef<HTMLDivElement | null>(null);
  const tagInputRef = useRef<HTMLInputElement | null>(null);
  const [tagQuery, setTagQuery] = useState("");
  const [tagInputFocused, setTagInputFocused] = useState(false);

  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [onClose]);

  // Clamp so the menu never renders off the right/bottom edge of the window.
  const style = useMemo(() => {
    const left = Math.min(x, window.innerWidth - MENU_WIDTH - MENU_MARGIN);
    const estimatedHeight = 320;
    const top = Math.min(y, window.innerHeight - estimatedHeight - MENU_MARGIN);
    return { left: Math.max(MENU_MARGIN, left), top: Math.max(MENU_MARGIN, top) };
  }, [x, y]);

  const suggestions = useMemo(() => {
    const q = tagQuery.trim().toLowerCase();
    return allTags
      .filter((t) => !session.tags.includes(t))
      .filter((t) => !q || t.toLowerCase().includes(q))
      .slice(0, 6);
  }, [allTags, session.tags, tagQuery]);

  const commitTag = (tag: string) => {
    const trimmed = tag.trim();
    if (!trimmed) return;
    addTag(session.id, trimmed);
    setTagQuery("");
    tagInputRef.current?.focus();
  };

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={`Options for ${session.title || "session"}`}
      style={{ position: "fixed", left: style.left, top: style.top, width: MENU_WIDTH }}
      className="z-50 rounded-lg border border-border bg-surface p-1 shadow-2xl"
    >
      <MenuItem
        onClick={() => {
          setMarkedUnread(session.id, !session.markedUnread);
          onClose();
        }}
      >
        {session.markedUnread ? "Mark as read" : "Mark as unread"}
      </MenuItem>
      <MenuItem
        onClick={() => {
          onRequestRename();
          onClose();
        }}
      >
        Rename…
      </MenuItem>
      <MenuItem
        onClick={() => {
          toggleFavorite(session.id);
          onClose();
        }}
      >
        {session.favorite ? "Unfavorite" : "Favorite"}
      </MenuItem>

      <div className="my-1 border-t border-border" />

      <div className="px-2 py-1">
        <label className="mb-1 block text-[11px] font-medium text-ink-faint">Tags</label>
        {session.tags.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1">
            {session.tags.map((tag) => (
              <span
                key={tag}
                className="flex items-center gap-1 rounded-full bg-surface-hover px-2 py-0.5 text-xs text-ink-muted"
              >
                {tag}
                <button
                  type="button"
                  aria-label={`Remove tag ${tag}`}
                  onClick={() => removeTag(session.id, tag)}
                  className="text-ink-faint hover:text-needs-you"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <input
          ref={tagInputRef}
          value={tagQuery}
          onChange={(e) => setTagQuery(e.target.value)}
          onFocus={() => setTagInputFocused(true)}
          onBlur={() => setTagInputFocused(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitTag(tagQuery);
            } else if (e.key === "Escape") {
              // Let the outer document handler close the whole menu instead
              // of only clearing the input.
              e.stopPropagation();
              onClose();
            }
          }}
          placeholder="Add tag…"
          aria-label="Add tag"
          className="h-7 w-full rounded-md border border-border bg-app-bg px-2 text-xs text-ink placeholder:text-ink-faint focus:border-accent/50 focus:outline-none"
        />
        {tagInputFocused && suggestions.length > 0 && (
          <div className="mt-1 flex flex-col gap-0.5 rounded-md border border-border bg-app-bg p-1">
            {suggestions.map((tag) => (
              <button
                key={tag}
                type="button"
                // onMouseDown (not onClick) fires before the input's onBlur,
                // so the suggestion click isn't lost to the blur closing it.
                onMouseDown={(e) => {
                  e.preventDefault();
                  commitTag(tag);
                }}
                className="rounded px-2 py-1 text-left text-xs text-ink-muted hover:bg-surface-hover"
              >
                {tag}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MenuItem({ children, onClick }: { children: React.ReactNode; onClick(): void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm text-ink hover:bg-surface-hover"
    >
      {children}
    </button>
  );
}
