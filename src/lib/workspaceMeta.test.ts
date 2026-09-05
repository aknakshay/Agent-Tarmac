import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Workspace } from "./workspaceMeta";

// A tiny fake backend: get_workspace/set_workspace round-trip against
// `stored`, with an artificial delay so two `updateWorkspace` calls started
// close together actually have a chance to interleave if nothing serializes
// them (which is exactly the race this test guards against).
let stored: Workspace;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args?: { ws: Workspace }) => {
    if (cmd === "get_workspace") {
      const snapshot = JSON.parse(JSON.stringify(stored)) as Workspace;
      return new Promise<Workspace>((resolve) => setTimeout(() => resolve(snapshot), 5));
    }
    if (cmd === "set_workspace") {
      return new Promise<void>((resolve) =>
        setTimeout(() => {
          stored = args!.ws;
          resolve();
        }, 5),
      );
    }
    return Promise.resolve(undefined);
  }),
}));

const { updateWorkspace } = await import("./workspaceMeta");

beforeEach(async () => {
  stored = { live_session_ids: [], favorites: [], session_meta: {}, project_meta: {} };
  const invokeMock = (await import("@tauri-apps/api/core")).invoke as ReturnType<typeof vi.fn>;
  invokeMock.mockClear();
});

describe("updateWorkspace", () => {
  it("serializes overlapping calls so a write for one session id doesn't clobber another's", async () => {
    await Promise.all([
      updateWorkspace((ws) => ({
        ...ws,
        session_meta: {
          ...ws.session_meta,
          a: { last_seen_at: null, marked_unread: true, tags: [], custom_title: null },
        },
      })),
      updateWorkspace((ws) => ({
        ...ws,
        session_meta: {
          ...ws.session_meta,
          b: { last_seen_at: null, marked_unread: true, tags: [], custom_title: null },
        },
      })),
    ]);

    expect(stored.session_meta).toHaveProperty("a");
    expect(stored.session_meta).toHaveProperty("b");
  });

  it("a rejected call doesn't wedge the queue for the next one", async () => {
    const invokeMock = (await import("@tauri-apps/api/core")).invoke as ReturnType<typeof vi.fn>;
    invokeMock.mockImplementationOnce(() => Promise.reject(new Error("boom")));

    await updateWorkspace(() => {
      throw new Error("unreachable — get_workspace itself failed");
    }).catch(() => undefined);

    await updateWorkspace((ws) => ({ ...ws, favorites: ["ok"] }));
    expect(stored.favorites).toEqual(["ok"]);
  });

  it("mutate returning the same reference skips the write (used to short-circuit no-op RMWs)", async () => {
    await updateWorkspace((ws) => ws);
    const invokeMock = (await import("@tauri-apps/api/core")).invoke as ReturnType<typeof vi.fn>;
    expect(invokeMock).not.toHaveBeenCalledWith("set_workspace", expect.anything());
  });

  it("project_meta defaults to {} when missing from an older workspace.json payload", async () => {
    // Simulate a workspace.json written before project_meta existed: the
    // hydrated object should default it to {}.
    (stored as unknown as Record<string, unknown>).project_meta = undefined;
    const result = await updateWorkspace((ws) => ws);
    expect(result.project_meta).toEqual({});
  });

  it("serializes overlapping project_meta writes without clobbering", async () => {
    await Promise.all([
      updateWorkspace((ws) => ({
        ...ws,
        project_meta: {
          ...ws.project_meta,
          "/p1": { custom_name: "Project One" },
        },
      })),
      updateWorkspace((ws) => ({
        ...ws,
        project_meta: {
          ...ws.project_meta,
          "/p2": { custom_name: "Project Two" },
        },
      })),
    ]);
    expect(stored.project_meta).toHaveProperty("/p1");
    expect(stored.project_meta).toHaveProperty("/p2");
  });
});
