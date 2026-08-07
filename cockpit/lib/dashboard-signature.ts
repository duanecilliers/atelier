/**
 * Structural signatures for the two live list views. A signature is a cheap,
 * order-sensitive hash of exactly what the page renders — when it changes, the
 * page needs to repaint; when it doesn't, a refresh would be wasted work. The
 * SSE route (`/api/dashboard/stream`) diffs it each tick to decide whether to
 * push a frame; the server components compute it from the rows they already
 * loaded and hand it to <LiveRefresh> as the baseline (so no refresh fires for
 * state the page was already rendered from). Pure — no DB access here.
 */

import type { RunQueueRow, Sandbox, SessionSummary } from '@/lib/types';

/** 32-bit FNV-1a → short hex. Cheap and order-sensitive; plenty to diff on. */
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** Queue board: each row's status + cancel_requested — captures lane moves, new
 *  rows, and the cancel_requested flip that shows "stopping…". */
export function queueSig(rows: RunQueueRow[]): string {
  return hash(rows.map((r) => `${r.id}:${r.status ?? ''}:${r.cancel_requested ?? ''}`).join('|'));
}

/** Sandbox list: each sandbox's status + shutdown/land flags + tip + land result —
 *  captures provisioning, teardown, a run committing a new tip, and a land landing. */
export function sandboxesSig(rows: Sandbox[]): string {
  return hash(
    rows
      .map(
        (s) =>
          `${s.id}:${s.status ?? ''}:${s.shutdown_requested ?? ''}:${s.land_requested ?? ''}:` +
          `${s.tip_sha ?? ''}:${s.land_result ?? ''}`,
      )
      .join('|'),
  );
}

/** Runs list: each session's status + its phase-dot statuses, so a phase
 *  advancing (queued→running→success) repaints the progress dots. */
export function runsSig(sessions: SessionSummary[]): string {
  return hash(
    sessions
      .map((s) => `${s.adw_id}:${s.status ?? ''}:${s.phases.map((p) => p.status ?? '').join(',')}`)
      .join('|'),
  );
}
