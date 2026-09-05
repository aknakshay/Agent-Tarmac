import { basename } from "./paths";
import { updateWorkspace } from "./workspaceMeta";

const PERSIST_DEBOUNCE_MS = 1000;
const pendingProjectPersists = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * The display name to render for a project group: the user's custom name if
 * set, otherwise the basename of the cwd. Mirrors the `displayTitle` helper
 * family in `session.ts`.
 */
export function displayProjectName(cwd: string | null, customName: string | null | undefined): string {
  if (customName && customName.trim()) return customName.trim();
  return basename(cwd);
}

/**
 * Debounced persist of a project's custom_name. Reads the latest value from
 * the caller-supplied `getName` thunk when the timer fires (same pattern as
 * `scheduleMetaPersist` in store.ts) so rapid changes only flush once.
 */
export function scheduleProjectNamePersist(cwd: string, getName: () => string | null): void {
  const existing = pendingProjectPersists.get(cwd);
  if (existing) clearTimeout(existing);
  const timeout = setTimeout(() => {
    pendingProjectPersists.delete(cwd);
    const name = getName();
    updateWorkspace((ws) => ({
      ...ws,
      project_meta: {
        ...ws.project_meta,
        [cwd]: { custom_name: name || null },
      },
    })).catch((err) => console.error(`Failed to persist project name for ${cwd}`, err));
  }, PERSIST_DEBOUNCE_MS);
  pendingProjectPersists.set(cwd, timeout);
}
