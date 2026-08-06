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
import { readAdwNames } from './skills';
import { pathsForProject } from './projects';
import { RunQueueRowSchema, SandboxRowSchema } from './schemas';
import { SANDBOX_LEVELS } from './roster-constants';
import { TERMINAL_SANDBOX_STATUSES } from './types';
import type { QueueStatus, RunQueueRow, Sandbox, SandboxStatus } from './types';

/** A rejected enqueue the route maps to 400 (e.g. an adw_name not on disk for
 *  this project). Distinct from a 5xx so a bad spec reads as user error. */
export class EnqueueError extends Error {}

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
  sandbox_id    TEXT,
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

// Mirrors engine/adws/adw_modules/sandboxes.py::SANDBOXES_DDL. The cockpit owns
// the write side (INSERT a `requested` row; flip `shutdown_requested`), so it may
// create the table — the worker fills every engine column. Kept in sync by hand.
const SANDBOXES_DDL = `
CREATE TABLE IF NOT EXISTS sandboxes (
  id                 TEXT PRIMARY KEY,
  project_root       TEXT,
  level              TEXT,
  worktree_path      TEXT,
  branch             TEXT,
  ports              TEXT,
  status             TEXT DEFAULT 'requested',
  tip_sha            TEXT,
  shutdown_requested INTEGER DEFAULT 0,
  error              TEXT,
  created_at         TEXT
);`;

// A sandbox is created at a provisionable level — `local` is the no-sandbox
// default (a run at REPO_ROOT), never a row here. Slice 1 provisions `worktree`;
// `worktree_env` is accepted so the seam is ready for slices 2–3.
const CREATABLE_LEVELS = SANDBOX_LEVELS.filter((l) => l !== 'local');

/** The validated shape a caller may create a sandbox with. `branch` defaults to
 *  `adw/<id>` when omitted (the interpolation engine lands in slice 2). */
export const CreateSandboxSpecSchema = z.object({
  level: z.enum(CREATABLE_LEVELS as [string, ...string[]]).default('worktree'),
  branch: z.string().trim().min(1).max(200).nullable().optional(),
});
export type CreateSandboxSpec = z.infer<typeof CreateSandboxSpecSchema>;

/** The validated shape a caller may enqueue. adw_name's on-disk existence (the
 *  dynamic allowlist — so a cockpit-built ADW is launchable at once) is checked
 *  in enqueue() against THIS project's adws/ dir, not here, since the schema has
 *  no project context; the worker re-checks it before it spawns anything. */
export const EnqueueSpecSchema = z.object({
  adw_name: z.string().trim().min(1).max(64),
  request: z.string().trim().min(1, 'request is required').max(20_000),
  agent: z.string().trim().min(1).max(64).nullable().optional(),
  config: z.string().trim().min(1).max(512).nullable().optional(),
  /** Bind this run to a sandbox (sandboxes.id); omitted/null = a local run at REPO_ROOT. */
  sandbox_id: z.string().trim().min(1).max(64).nullable().optional(),
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
  /** This project's adws/ dir — the allowlist enqueue() validates adw_name against. */
  private readonly adwsDir: string;
  /** This project's repo root — recorded on a sandbox row (display; the worker
   *  keys its git ops off its own REPO_ROOT). */
  private readonly projectRoot: string;

  constructor(path: string, adwsDir: string, projectRoot: string) {
    if (!existsSync(path)) {
      throw new Error(
        `sssf.db not found at ${path} — run an ADW in the engine (or set SSSF_DB) ` +
          `so the db exists before enqueuing.`,
      );
    }
    this.adwsDir = adwsDir;
    this.projectRoot = projectRoot;
    this.db = new Database(path);
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = NORMAL');
    // We own the write side of run_queue + sandboxes, so we may create them — but
    // only those. The worker fills every engine-owned column.
    this.db.exec(RUN_QUEUE_DDL);
    this.db.exec(SANDBOXES_DDL);
    // CREATE IF NOT EXISTS won't add sandbox_id to a run_queue made before it, so
    // self-heal that additive column (we INSERT into it) — the write-side mirror
    // of the tracer's MIGRATIONS and queue.py::ensure_schema.
    const cols = this.db.prepare('PRAGMA table_info(run_queue)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'sandbox_id')) {
      this.db.exec('ALTER TABLE run_queue ADD COLUMN sandbox_id TEXT');
    }
  }

  close(): void {
    this.db.close();
  }

  /** INSERT a launch spec; returns the queue id + the adw_id the run will use. */
  enqueue(spec: EnqueueSpec): { id: number; adw_id: string } {
    const parsed = EnqueueSpecSchema.parse(spec);
    // The dynamic allowlist, scoped to this project's ADWs on disk.
    if (!readAdwNames(this.adwsDir).has(parsed.adw_name)) {
      throw new EnqueueError(`unknown adw_name '${parsed.adw_name}' for this project`);
    }
    // A sandbox-bound run must target a sandbox that can still host it — reject a
    // stale/unknown/gone id here so the operator sees the error, rather than the
    // run sitting queued until the worker fails it as orphaned.
    if (parsed.sandbox_id != null) {
      const sb = this.getSandbox(parsed.sandbox_id);
      if (!sb) throw new EnqueueError(`unknown sandbox '${parsed.sandbox_id}'`);
      if (sb.status && TERMINAL_SANDBOX_STATUSES.includes(sb.status)) {
        throw new EnqueueError(`sandbox '${parsed.sandbox_id}' is ${sb.status}`);
      }
    }
    const adwId = newAdwId();
    const info = this.db
      .prepare(
        `INSERT INTO run_queue (adw_id, adw_name, agent, request, config, sandbox_id,
                                status, requested_by, cancel_requested, enqueued_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, 0, ?)`,
      )
      .run(
        adwId,
        parsed.adw_name,
        parsed.agent ?? null,
        parsed.request,
        parsed.config ?? null,
        parsed.sandbox_id ?? null,
        parsed.requested_by ?? null,
        nowIso(),
      );
    return { id: Number(info.lastInsertRowid), adw_id: adwId };
  }

  // ── sandboxes ──────────────────────────────────────────────────────────────
  // Same determinism spine as run_queue: create = INSERT a `requested` row; shut
  // down = flip `shutdown_requested`. The worker provisions the worktree and
  // disposes — the cockpit never spawns a process.

  private readonly SANDBOX_COLS =
    `id, project_root, level, worktree_path, branch, ports, status, tip_sha,
     shutdown_requested, error, created_at`;

  /** INSERT a sandbox request; returns the id the worker will provision under. */
  createSandbox(spec: CreateSandboxSpec): { id: string } {
    const parsed = CreateSandboxSpecSchema.parse(spec);
    const id = newAdwId(); // same 8-hex shape as an adw_id
    const branch = parsed.branch ?? `adw/${id}`;
    this.db
      .prepare(
        `INSERT INTO sandboxes (id, project_root, level, branch, status,
                                shutdown_requested, created_at)
         VALUES (?, ?, ?, ?, 'requested', 0, ?)`,
      )
      .run(id, this.projectRoot, parsed.level, branch, nowIso());
    return { id };
  }

  /** Ask the worker to tear a sandbox down (flip the flag). Idempotent; returns
   *  the row's new state, or null if unknown or already gone. */
  requestShutdown(id: string): Sandbox | null {
    const sb = this.getSandbox(id);
    if (!sb) return null;
    if (sb.status && TERMINAL_SANDBOX_STATUSES.includes(sb.status)) return null;
    this.db.prepare('UPDATE sandboxes SET shutdown_requested=1 WHERE id=?').run(id);
    return this.getSandbox(id);
  }

  getSandbox(id: string): Sandbox | null {
    const row = this.db
      .prepare(`SELECT ${this.SANDBOX_COLS} FROM sandboxes WHERE id=?`)
      .get(id);
    return row ? (SandboxRowSchema.parse(row) as Sandbox) : null;
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

const globalForControl = globalThis as unknown as { __atelierControls?: Map<string, AtelierControl> };

/** Memoized control connection per project, keyed by resolved db path — mirroring
 *  getDb()'s HMR-safe, path-keyed singleton. */
export function getControl(projectId?: string): AtelierControl {
  const paths = pathsForProject(projectId);
  const map = (globalForControl.__atelierControls ??= new Map<string, AtelierControl>());
  let control = map.get(paths.dbPath);
  if (!control) {
    control = new AtelierControl(paths.dbPath, paths.adwsDir, paths.root);
    map.set(paths.dbPath, control);
  }
  return control;
}
