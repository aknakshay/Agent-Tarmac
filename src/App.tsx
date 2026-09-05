import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useDeck } from "./store";
import { Sidebar } from "./components/Sidebar";
import type { SessionMeta, StatusChange } from "./types";

function App() {
  const setSessions = useDeck((state) => state.setSessions);
  const setStatus = useDeck((state) => state.setStatus);
  const hasSessions = useDeck((state) => Object.keys(state.sessions).length > 0);

  useEffect(() => {
    let unlistenSessions: (() => void) | undefined;
    let unlistenStatus: (() => void) | undefined;

    invoke<SessionMeta[]>("list_sessions")
      .then(setSessions)
      .catch((err) => console.error("Failed to load sessions", err));

    listen<SessionMeta[]>("sessions_updated", (event) => setSessions(event.payload)).then(
      (fn) => (unlistenSessions = fn),
    );

    listen<StatusChange>("session_status_changed", (event) =>
      setStatus(event.payload.sessionId, event.payload.status),
    ).then((fn) => (unlistenStatus = fn));

    return () => {
      unlistenSessions?.();
      unlistenStatus?.();
    };
  }, [setSessions, setStatus]);

  return (
    <div className="flex h-dvh w-full bg-app-bg text-ink">
      <Sidebar />
      <main className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
        <span className="text-lg font-semibold text-ink">Claude Deck</span>
        <p className="max-w-sm text-sm text-ink-faint">
          {hasSessions
            ? "Select a session from the sidebar to open its terminal."
            : "Waiting for Claude Code sessions to appear."}
        </p>
      </main>
    </div>
  );
}

export default App;
