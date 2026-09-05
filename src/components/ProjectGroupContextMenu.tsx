import { useEffect, useMemo, useRef } from "react";

interface ProjectGroupContextMenuProps {
  /** The cwd/key of the project group. */
  cwd: string;
  /** Current display label (basename or custom name). */
  currentLabel: string;
  /** Viewport coordinates of the right-click that opened the menu. */
  x: number;
  y: number;
  onClose(): void;
  /** Called when the user picks "Rename project…". */
  onRequestRename(): void;
}

const MENU_WIDTH = 200;
const MENU_MARGIN = 8;

/**
 * A minimal context menu for project group headers. Right now it only exposes
 * "Rename project…" but is structured like `SessionContextMenu` so items can
 * be added later without refactoring.
 *
 * Keyboard behaviour: Escape dismisses (captured in the capture phase via a
 * document listener, same as SessionContextMenu).
 */
export function ProjectGroupContextMenu({
  currentLabel,
  x,
  y,
  onClose,
  onRequestRename,
}: ProjectGroupContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);

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

  const style = useMemo(() => {
    const left = Math.min(x, window.innerWidth - MENU_WIDTH - MENU_MARGIN);
    const estimatedHeight = 60;
    const top = Math.min(y, window.innerHeight - estimatedHeight - MENU_MARGIN);
    return { left: Math.max(MENU_MARGIN, left), top: Math.max(MENU_MARGIN, top) };
  }, [x, y]);

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={`Options for project ${currentLabel}`}
      style={{ position: "fixed", left: style.left, top: style.top, width: MENU_WIDTH }}
      className="z-50 rounded-lg border border-border bg-surface p-1 shadow-2xl"
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onRequestRename();
          onClose();
        }}
        className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm text-ink hover:bg-surface-hover"
      >
        Rename project…
      </button>
    </div>
  );
}
