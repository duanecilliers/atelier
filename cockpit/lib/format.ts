/** Small display helpers. Durations/relative times are derived, never stored. */

/** Compact token counts: 48366 → "48.4k". */
export function compact(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Dollars: 0.1856 → "$0.19". Sub-cent runs still read as a number, not "$0.00…". */
export function usd(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n === 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/** mm:ss between two ISO timestamps; "—" if either is missing. */
export function duration(start: string | null, end: string | null): string {
  if (!start || !end) return '—';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** "just now" / "4m ago" / "2h ago" / "3d ago" from an ISO timestamp. */
export function ago(iso: string | null, now: number): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '—';
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** ISO → epoch ms, or NaN. The one place the waterfall parses timestamps. */
export function tsMs(iso: string | null | undefined): number {
  if (!iso) return NaN;
  return new Date(iso).getTime();
}

/** A duration as a compact offset label for a time axis: "0s" / "12s" / "3m" / "1h4m". */
export function fmtOffset(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

/**
 * `count` evenly-spaced axis ticks across a span, each with its left-% and an
 * offset label. Linear — the waterfall's blocks carry the exact geometry; these
 * are just reading guides.
 */
export function axisTicks(spanMs: number, count: number): { pct: number; label: string }[] {
  const n = Math.max(2, count);
  const out: { pct: number; label: string }[] = [];
  for (let i = 0; i < n; i++) {
    const frac = i / (n - 1);
    out.push({ pct: frac * 100, label: fmtOffset(frac * spanMs) });
  }
  return out;
}

/**
 * Dollars to four places — the per-component cost table runs to fractions of a
 * cent, where usd()'s two-place rounding would read as "$0.00". "<$0.0001" keeps
 * a real-but-tiny cost from rendering as nothing.
 */
export function usd4(n: number | null | undefined): string {
  if (n == null || n === 0) return '$0';
  if (n < 0.0001) return '<$0.0001';
  return `$${n.toFixed(4)}`;
}
