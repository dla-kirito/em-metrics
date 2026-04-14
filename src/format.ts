/**
 * Shared formatting utilities used across CLI, dashboard, trace, and reporter.
 */

export function formatDuration(ms: number): string {
  if (ms < 1000) return Math.round(ms) + "ms";
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + "s";
  const m = Math.floor(s / 60);
  const remainder = s % 60;
  return `${m}m ${remainder.toFixed(0)}s`;
}

export function formatNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(Math.round(n));
}

/** Right-align a value in a fixed-width column */
export function col(v: string, w = 10): string {
  return v.padStart(w);
}
