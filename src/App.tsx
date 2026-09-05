import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useDeck } from "./store";
import { Sidebar } from "./components/Sidebar";
import { TerminalPane } from "./components/TerminalPane";
import { CommandBar } from "./components/CommandBar";
import { NewSessionDialog } from "./components/NewSessionDialog";
import { RestoreBanner } from "./components/RestoreBanner";
import { UpdateBanner } from "./components/UpdateBanner";
import { Home } from "./components/Home";
import { writeExited, writeOutput } from "./terminals";
import type { SessionMeta, StatusChange } from "./types";
import type { Workspace } from "./lib/workspaceMeta";

interface PtyOutputPayload {
  sessionId: string;
  dataB64: string;
}

interface PtyExitedPayload {
  sessionId: string;
}

function App() {
  const setSessions = useDeck((state) => state.setSessions);
  const setStatus = useDeck((state) => state.setStatus);
  const openIds = useDeck((state) => state.openIds);
  const activeId = useDeck((state) => state.activeId);
  const focus = useDeck((state) => state.focus);
  const hydrateMeta = useDeck((state) => state.hydrateMeta);
  const toggleMarkedUnread = useDeck((state) => state.toggleMarkedUnread);

  const [commandBarOpen, setCommandBarOpen] = useState(false);
  const [newSessionOpen, setNewSessionOpen] = useState(false);

  // Global shortcuts. Attached at window level with capture:true so they
  // fire even while the xterm terminal has focus: xterm's own keydown
  // handling (evaluateKeyboardEvent) never sets a key for meta-key chords
  // outside its built-in copy/paste bindings, so it doesn't call
  // preventDefault for Cmd combos and lets them bubble — capture just makes
  // that reliable rather than order-dependent.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey) return;

      // Any focused text input the app itself owns (a rename field, the
      // command bar/new-session dialog inputs, the context menu's tag
      // input) should get the keystroke, not have it intercepted as a
      // shortcut — checked generically rather than only while a modal is
      // open, since sidebar/pane rename inputs are never modal.
      //
      // This is an ALLOWLIST (`data-app-editable`), not a blanket
      // INPUT/TEXTAREA/contentEditable check: xterm.js renders keyboard
      // input through its own hidden `<textarea class="xterm-helper-
      // textarea">`, which is the actual event target whenever a terminal
      // pane has focus — the common case. A blanket editable-element check
      // would match that textarea too and silently swallow every shortcut
      // during normal terminal use. Marking only the app's own inputs
      // means an unmarked one (like xterm's) still lets shortcuts through,
      // and a future unmarked app input degrades to a minor annoyance
      // rather than a dead shortcut.
      const target = e.target as HTMLElement | null;
      const isAppEditableTarget = !!target && !!target.closest("[data-app-editable]");

      if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandBarOpen((open) => !open);
        setNewSessionOpen(false);
        return;
      }

      if (isAppEditableTarget) return;

      if (e.shiftKey && e.key.toLowerCase() === "u") {
        e.preventDefault();
        if (activeId) toggleMarkedUnread(activeId);
        return;
      }

      if (e.key.toLowerCase() === "n") {
        e.preventDefault();
        setNewSessionOpen(true);
        setCommandBarOpen(false);
        return;
      }

      if (e.key >= "1" && e.key <= "9") {
        const index = Number(e.key) - 1;
        const id = openIds[index];
        if (id) {
          e.preventDefault();
          focus(id);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [commandBarOpen, newSessionOpen, openIds, focus, activeId, toggleMarkedUnread]);

  useEffect(() => {
    invoke<SessionMeta[]>("list_sessions")
      .then(setSessions)
      // Hydrate persisted read/unread, tags, and rename metadata once the
      // session index has landed, so hydrateMeta has known sessions to
      // merge into (a session_meta entry for an id nobody's scanned yet is
      // simply skipped — see store.ts).
      .then(() => invoke<Workspace>("get_workspace"))
      .then(hydrateMeta)
      .catch((err) => console.error("Failed to load sessions", err));

    // Keep the listen() promises themselves rather than a `let fn` captured by a
    // later .then(); under StrictMode's dev-only mount->cleanup->remount, cleanup
    // can run before the promise resolves, which would otherwise leak a listener.
    const sessionsUpdated = listen<SessionMeta[]>("sessions_updated", (event) =>
      setSessions(event.payload),
    );
    const statusChanged = listen<StatusChange>("session_status_changed", (event) =>
      setStatus(event.payload.sessionId, event.payload.status),
    );
    // Single global listener per event, routed to the right terminal by
    // sessionId inside terminals.ts — never one listener per pane.
    const ptyOutput = listen<PtyOutputPayload>("pty_output", (event) =>
      writeOutput(event.payload.sessionId, event.payload.dataB64),
    );
    const ptyExited = listen<PtyExitedPayload>("pty_exited", (event) =>
      writeExited(event.payload.sessionId),
    );

    return () => {
      sessionsUpdated.then((unlisten) => unlisten());
      statusChanged.then((unlisten) => unlisten());
      ptyOutput.then((unlisten) => unlisten());
      ptyExited.then((unlisten) => unlisten());
    };
  }, [setSessions, setStatus, hydrateMeta]);

  return (
    <div className="flex h-dvh w-full min-h-0 overflow-hidden bg-app-bg text-ink">
      <Sidebar
        onOpenCommandBar={() => setCommandBarOpen(true)}
        onOpenNewSession={() => setNewSessionOpen(true)}
      />
      <main className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex flex-col">
          <UpdateBanner />
          <RestoreBanner />
        </div>
        {openIds.map((id) => (
          <TerminalPane key={id} sessionId={id} active={id === activeId} />
        ))}
        {activeId === null && (
          <div className="absolute inset-0">
            <Home />
          </div>
        )}
      </main>

      {commandBarOpen && (
        <CommandBar
          onClose={() => setCommandBarOpen(false)}
          onFocusSession={(id) => {
            focus(id);
            setCommandBarOpen(false);
          }}
          onNewSession={() => {
            setCommandBarOpen(false);
            setNewSessionOpen(true);
          }}
        />
      )}

      {newSessionOpen && (
        <NewSessionDialog
          onClose={() => setNewSessionOpen(false)}
          onStarted={(sessionId, cwd) => {
            focus(sessionId, cwd);
            setNewSessionOpen(false);
          }}
        />
      )}
    </div>
  );
}

export default App;
