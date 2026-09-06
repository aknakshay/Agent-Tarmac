/**
 * Compact token-count formatting for the Home stats and the share card —
 * "12.4k" / "1.2M" / "1.1B" rather than raw digit counts, which stop being
 * legible for anyone with real usage history within a day or two.
 */
export function formatTokenCount(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs < 1000) return `${sign}${abs}`;

  const units: [number, string][] = [
    [1_000_000_000, "B"],
    [1_000_000, "M"],
    [1_000, "k"],
  ];
  for (const [threshold, suffix] of units) {
    if (abs >= threshold) {
      const value = abs / threshold;
      // One decimal below 100 of the unit ("12.4k"), none at/above ("142k") —
      // keeps the string short without losing precision where it matters.
      const formatted = value < 100 ? value.toFixed(1).replace(/\.0$/, "") : Math.round(value).toString();
      return `${sign}${formatted}${suffix}`;
    }
  }
  return `${sign}${abs}`;
}
