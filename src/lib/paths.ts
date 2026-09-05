/** Returns the last path segment of a project directory, for display. */
export function basename(cwd: string | null): string {
  if (!cwd) return "no project";
  const trimmed = cwd.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
}
