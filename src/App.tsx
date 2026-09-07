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
import { SplashScreen } from "./components/SplashScreen";
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
  const goHome = useDeck((state) => state.goHome);
  const hydrateMeta = useDeck((state) => state.hydrateMeta);
  const toggleMarkedUnread = useDeck((state) => state.toggleMarkedUnread);

  const [commandBarOpen, setCommandBarOpen] = useState(false);
  const [newSessionOpen, setNewSessionOpen] = useState(false);

  // The launch splash plays once per app launch, as a full-viewport overlay
  // above the already-mounted app. Startup is instant now (the scan fills the
  // sidebar in the background), so the splash isn't gated on any load — its
  // ~1.8s takeoff is purely the launch moment, and it naturally outlasts the
  // fast scan. `splashLifting` runs a brief opacity fade as it unmounts so the
  // app is revealed beneath rather than snapping in.
  const [showSplash, setShowSplash] = useState(true);
  const [splashLifting, setSplashLifting] = useState(false);
  const handleSplashComplete = () => {
    setSplashLifting(true);
    window.setTimeout(() => setShowSplash(false), 420);
  };

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

      if (e.key === "0") {
        e.preventDefault();
        goHome();
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
  }, [commandBarOpen, newSessionOpen, openIds, focus, goHome, activeId, toggleMarkedUnread]);

  useEffect(() => {
    // The session list arrives two ways, both needed: live via the
    // `sessions_updated` event from the non-blocking startup scan (the backend
    // index starts EMPTY in lib.rs and a background thread fills it — first from
    // the persisted cache, then a fresh disk reconcile), AND via a one-shot
    // `list_sessions` backfill below that recovers the startup emit if it raced
    // ahead of this webview subscribing (see that call's comment). We prime the
    // persisted read/unread, tags, favorites, and rename caches first so the
    // first batch (whichever path delivers it) paints with them already applied;
    // `hydrateMeta` also back-fills a batch that lands before it (it merges into
    // whatever sessions are present — see store.ts).
    invoke<Workspace>("get_workspace")
      .then(hydrateMeta)
      .catch((err) => console.error("Failed to load workspace meta", err));

    // One-time probe for installed terminals (Ghostty, iTerm2, ...) so the
    // pop-out control can offer real choices and label itself truthfully.
    invoke<string[]>("detect_terminals")
      .then((terminals) => useDeck.getState().setAvailableTerminals(terminals))
      .catch((err) => console.error("detect_terminals failed", err));

    // Seed the popped-out set from the backend's startup reconciliation so
    // "Bring back" survives a relaunch (pane-local state resets, this doesn't).
    invoke<string[]>("list_external_sessions")
      .then((ids) => useDeck.getState().setExternalIds(ids))
      .catch((err) => console.error("list_external_sessions failed", err));

    // Keep the listen() promises themselves rather than a `let fn` captured by a
    // later .then(); under StrictMode's dev-only mount->cleanup->remount, cleanup
    // can run before the promise resolves, which would otherwise leak a listener.
    const sessionsUpdated = listen<SessionMeta[]>("sessions_updated", (event) =>
      setSessions(event.payload),
    );
    // The background startup scan brackets its fresh disk reconcile with these
    // two events; the store turns them into the `scanning`/`scanCount` that
    // drives the sidebar's climbing-jet loader (see Sidebar.tsx). Same
    // StrictMode-safe promise-cleanup pattern as the listeners around it.
    const scanStarted = listen<{ cached: number }>("scan_started", (event) =>
      useDeck.getState().startScan(event.payload.cached),
    );
    const scanComplete = listen<{ count: number }>("scan_complete", (event) =>
      useDeck.getState().completeScan(event.payload.count),
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

    // Backfill the current index once, AFTER the listeners above are set up.
    // The background startup scan (start_background_scan, in lib.rs .setup)
    // emits its `sessions_updated`/`scan_*` events almost immediately on a warm
    // cache — often BEFORE this webview has finished loading and subscribed, so
    // those one-shot events are lost and the sidebar would spin on its loader
    // until the next file-watcher tick (a transcript write) happened to re-emit.
    // `list_sessions` reads `SessionIndexState`, which both the scan and the
    // watcher keep current (they write it before emitting), so this recovers
    // whatever the scan already published. Guarded to a non-empty result so it
    // never flips `sessionsLoaded` true against a still-empty index mid-scan —
    // that premature flip is what made RestoreBanner clear live ids, and why
    // this call was originally removed; the guard keeps that fix intact while
    // closing the event-race hole.
    invoke<SessionMeta[]>("list_sessions")
      .then((metas) => {
        if (metas.length > 0) setSessions(metas);
      })
      .catch((err) => console.error("list_sessions backfill failed", err));

    return () => {
      sessionsUpdated.then((unlisten) => unlisten());
      scanStarted.then((unlisten) => unlisten());
      scanComplete.then((unlisten) => unlisten());
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

      {showSplash && (
        <div className="splash-overlay" data-lifting={splashLifting ? "true" : undefined}>
          <SplashScreen onComplete={handleSplashComplete} />
        </div>
      )}
    </div>
  );
}

export default App;
