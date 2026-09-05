/** Formats an ISO timestamp as a short relative string ("2m", "3h", "yesterday"). */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";

  const diffSec = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (diffSec < 5) return "now";
  if (diffSec < 60) return `${diffSec}s`;

  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;

  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h`;

  const diffDay = Math.round(diffHour / 24);
  if (diffDay === 1) return "yesterday";
  if (diffDay < 7) return `${diffDay}d`;

  const diffWeek = Math.round(diffDay / 7);
  if (diffWeek < 5) return `${diffWeek}w`;

  const diffMonth = Math.round(diffDay / 30);
  if (diffMonth < 12) return `${diffMonth}mo`;

  const diffYear = Math.round(diffDay / 365);
  return `${diffYear}y`;
}
