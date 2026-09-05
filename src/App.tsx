import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useDeck } from "./store";
import { Sidebar } from "./components/Sidebar";
import { TerminalPane } from "./components/TerminalPane";
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
      <Sidebar />
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
    </div>
  );
}

export default App;
