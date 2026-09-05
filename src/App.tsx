import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useDeck } from "./store";
import { Sidebar } from "./components/Sidebar";
import { TerminalPane } from "./components/TerminalPane";
import { CommandBar } from "./components/CommandBar";
import { NewSessionDialog } from "./components/NewSessionDialog";
import { writeExited, writeOutput } from "./terminals";
import type { SessionMeta, StatusChange } from "./types";

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
  const hasSessions = useDeck((state) => Object.keys(state.sessions).length > 0);
  const openIds = useDeck((state) => state.openIds);
  const activeId = useDeck((state) => state.activeId);
  const focus = useDeck((state) => state.focus);

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

      const target = e.target as HTMLElement | null;
      const inModalInput =
        (commandBarOpen || newSessionOpen) &&
        !!target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA");

      if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandBarOpen((open) => !open);
        setNewSessionOpen(false);
        return;
      }

      if (inModalInput) return;

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
  }, [commandBarOpen, newSessionOpen, openIds, focus]);

  useEffect(() => {
    invoke<SessionMeta[]>("list_sessions")
      .then(setSessions)
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
  }, [setSessions, setStatus]);

  return (
    <div className="flex h-dvh w-full bg-app-bg text-ink">
      <Sidebar
        onOpenCommandBar={() => setCommandBarOpen(true)}
        onOpenNewSession={() => setNewSessionOpen(true)}
      />
      <main className="relative flex-1">
        {openIds.map((id) => (
          <TerminalPane key={id} sessionId={id} active={id === activeId} />
        ))}
        {activeId === null && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-8 text-center">
            <span className="text-lg font-semibold text-ink">Claude Deck</span>
            <p className="max-w-sm text-sm text-ink-faint">
              {hasSessions
                ? "Select a session from the sidebar to open its terminal."
                : "Waiting for Claude Code sessions to appear."}
            </p>
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
