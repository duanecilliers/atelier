/**
 * The control seam — the ONLY place the cockpit writes to sssf.db.
 *
 * The determinism spine (plan D2 + the HIGH risk on a web process launching
 * agents): the cockpit must never spawn a subprocess and must never mutate a
 * run. So this connection is deliberately tiny. It touches exactly one table —
 * run_queue — and does exactly two things:
 *
 *   • enqueue()       INSERT a launch spec for the worker to pick up
 *   • requestCancel() ask a run to stop (flip a flag, or cancel a not-yet-started row)
 *
 * It never writes sessions/phases/events/envelopes/gates/processes — a run's
 * trace and acceptance are written only by the ADW subprocess itself, exactly as
 * on the CLI. adw_worker.py is the only thing that turns a queued row into a
 * process. Kept separate from AtelierDb (which stays readonly) so the read path
 * can never accidentally acquire write intent.
 */
import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { ADW_NAMES } from './adws';
import { resolveDbPath } from './db';
import { RunQueueRowSchema } from './schemas';
import type { QueueStatus, RunQueueRow } from './types';

// Mirrors engine/adws/adw_modules/queue.py::RUN_QUEUE_DDL. Kept in sync by hand;
// pnpm check:contract fails loudly if the columns the cockpit expects drift.
const RUN_QUEUE_DDL = `
CREATE TABLE IF NOT EXISTS run_queue (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  adw_id        TEXT,
  adw_name      TEXT,
  agent         TEXT,
  request       TEXT,
  config        TEXT,
  status        TEXT DEFAULT 'queued',
  requested_by  TEXT,
  cancel_requested INTEGER DEFAULT 0,
  pid           INTEGER,
  exit_code     INTEGER,
  error         TEXT,
  enqueued_at   TEXT,
  claimed_at    TEXT,
  started_at    TEXT,
  ended_at      TEXT
);`;

/** The validated shape a caller may enqueue. adw_name must be in the allowlist. */
export const EnqueueSpecSchema = z.object({
  adw_name: z.string().refine((n) => ADW_NAMES.has(n), 'unknown adw_name'),
  request: z.string().trim().min(1, 'request is required').max(20_000),
  agent: z.string().trim().min(1).max(64).nullable().optional(),
  config: z.string().trim().min(1).max(512).nullable().optional(),
  requested_by: z.string().trim().min(1).max(120).nullable().optional(),
});
export type EnqueueSpec = z.infer<typeof EnqueueSpecSchema>;

function nowIso(): string {
  // Matches the engine's now_iso(): UTC, millisecond precision.
  return new Date().toISOString().replace(/(\.\d{3})\d*Z$/, '$1+00:00');
}

/** Same shape as the engine's new_id(8): 8 lowercase hex chars. */
function newAdwId(): string {
  return randomBytes(4).toString('hex');
}

export class AtelierControl {
  private readonly db: Database.Database;

  constructor(path: string) {
    if (!existsSync(path)) {
      throw new Error(
        `sssf.db not found at ${path} — run an ADW in the engine (or set SSSF_DB) ` +
          `so the db exists before enqueuing.`,
      );
    }
    this.db = new Database(path);
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = NORMAL');
    // We own the write side of run_queue, so we may create it — but only it.
    this.db.exec(RUN_QUEUE_DDL);
  }

  close(): void {
    this.db.close();
  }

  /** INSERT a launch spec; returns the queue id + the adw_id the run will use. */
  enqueue(spec: EnqueueSpec): { id: number; adw_id: string } {
    const parsed = EnqueueSpecSchema.parse(spec);
    const adwId = newAdwId();
    const info = this.db
      .prepare(
        `INSERT INTO run_queue (adw_id, adw_name, agent, request, config, status,
                                requested_by, cancel_requested, enqueued_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, 0, ?)`,
      )
      .run(
        adwId,
        parsed.adw_name,
        parsed.agent ?? null,
        parsed.request,
        parsed.config ?? null,
        parsed.requested_by ?? null,
        nowIso(),
      );
    return { id: Number(info.lastInsertRowid), adw_id: adwId };
  }

  /**
   * Ask a run to stop. cancel_requested is ALWAYS set first, unconditionally —
   * it is the durable backstop the worker honours once a run is live. Then, only
   * if the row is still `queued` (never claimed), it is canceled outright here so
   * no process is ever spawned. Doing the flag first closes the race where the
   * worker claims the row between our read and our write: a conditional
   * `WHERE status='queued'` cancel would miss, but the flag is already set, so
   * the worker signals the process the moment it starts running. Returns the
   * row's new state, or null if the id is unknown or already terminal.
   */
  requestCancel(id: number): RunQueueRow | null {
    const row = this.db.prepare('SELECT status FROM run_queue WHERE id = ?').get(id) as
      | { status: QueueStatus | null }
      | undefined;
    if (!row) return null;
    if (row.status && (['done', 'failed', 'canceled'] as QueueStatus[]).includes(row.status)) {
      return null; // already terminal — nothing to stop
    }
    // Durable backstop: set regardless of the current status.
    this.db.prepare('UPDATE run_queue SET cancel_requested=1 WHERE id=?').run(id);
    // If still unclaimed, finish it here — the worker will never pick it up
    // (claim_next only takes 'queued' rows), so no process is spawned.
    this.db
      .prepare(
        "UPDATE run_queue SET status='canceled', ended_at=? WHERE id=? AND status='queued'",
      )
      .run(nowIso(), id);
    return this.get(id);
  }

  get(id: number): RunQueueRow | null {
    const row = this.db
      .prepare(
        `SELECT id, adw_id, adw_name, agent, request, config, status, requested_by,
                cancel_requested, pid, exit_code, error,
                enqueued_at, claimed_at, started_at, ended_at
           FROM run_queue WHERE id = ?`,
      )
      .get(id);
    return row ? (RunQueueRowSchema.parse(row) as RunQueueRow) : null;
  }
}

const globalForControl = globalThis as unknown as { __atelierControl?: AtelierControl };

/** Memoized control connection, mirroring getDb()'s HMR-safe singleton. */
export function getControl(): AtelierControl {
  if (!globalForControl.__atelierControl) {
    globalForControl.__atelierControl = new AtelierControl(resolveDbPath());
  }
  return globalForControl.__atelierControl;
}
