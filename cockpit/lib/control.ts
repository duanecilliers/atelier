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
import { SANDBOX_LEVELS, validateBranchName } from './roster-constants';
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
  purpose            TEXT,
  ports              TEXT,
  status             TEXT DEFAULT 'requested',
  tip_sha            TEXT,
  shutdown_requested INTEGER DEFAULT 0,
  land_requested     INTEGER DEFAULT 0,
  land_result        TEXT,
  error              TEXT,
  created_at         TEXT
);`;

// A sandbox is created at a provisionable level — `local` is the no-sandbox
// default (a run at REPO_ROOT), never a row here. Slice 1 provisions `worktree`;
// `worktree_env` is accepted so the seam is ready for slices 2–3.
const CREATABLE_LEVELS = SANDBOX_LEVELS.filter((l) => l !== 'local');

/** The validated shape a caller may create a sandbox with. `branch` defaults to
 *  `adw/<id>` when omitted. It is validated to a git-refname- AND shell-safe
 *  charset because the worker interpolates ${BRANCH} into shell setup/land
 *  commands — a git-legal name with a `;`/`$`/backtick would otherwise inject. */
export const CreateSandboxSpecSchema = z.object({
  level: z.enum(CREATABLE_LEVELS as [string, ...string[]]).default('worktree'),
  branch: z
    .string()
    .trim()
    .nullable()
    .optional()
    .superRefine((b, ctx) => {
      if (b == null) return;
      const err = validateBranchName(b);
      if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, message: err });
    }),
  /** Optional human intent ("add rate limiting to the API"). When set and no explicit
   *  `branch` is given, the branch is left NULL at create and the worker names it from
   *  this via a cheap model (branch_namer.py), falling back to `adw/<id>`. */
  purpose: z.string().trim().max(500).nullable().optional(),
});
export type CreateSandboxSpec = z.infer<typeof CreateSandboxSpecSchema>;

/** The validated shape a caller may enqueue. adw_name's on-disk existence (the
 *  dynamic allowlist — so a cockpit-built ADW is launchable at once) is checked
 *  in enqueue() against THIS project's adws/ dir, not here, since the schema has
 *  no project context; the worker re-checks it before it spawns anything. */
export const EnqueueSpecSchema = z
  .object({
    adw_name: z.string().trim().min(1).max(64),
    request: z.string().trim().min(1, 'request is required').max(20_000),
    agent: z.string().trim().min(1).max(64).nullable().optional(),
    config: z.string().trim().min(1).max(512).nullable().optional(),
    /** Bind this run to an EXISTING sandbox (sandboxes.id); omitted/null = a local
     *  run at REPO_ROOT. Mutually exclusive with `new_sandbox`. */
    sandbox_id: z.string().trim().min(1).max(64).nullable().optional(),
    /** Create a FRESH sandbox and run inside it (the "＋ New sandbox" launcher path).
     *  When set, the run's `request` doubles as the sandbox purpose, so the worker
     *  names the branch from it — no separate typing. Mutually exclusive with an
     *  explicit `sandbox_id`. */
    new_sandbox: z
      .object({ level: z.enum(CREATABLE_LEVELS as [string, ...string[]]).default('worktree') })
      .nullable()
      .optional(),
    requested_by: z.string().trim().min(1).max(120).nullable().optional(),
  })
  .superRefine((s, ctx) => {
    if (s.new_sandbox && s.sandbox_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'cannot both attach to a sandbox and create a new one',
        path: ['new_sandbox'],
      });
    }
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
    // Same for the slice-4 land_* columns over a sandboxes table made before them
    // (we flip land_requested) — the write-side mirror of tracer.py MIGRATIONS and
    // sandboxes.py::ensure_schema.
    const sbCols = this.db.prepare('PRAGMA table_info(sandboxes)').all() as { name: string }[];
    if (!sbCols.some((c) => c.name === 'land_requested')) {
      this.db.exec('ALTER TABLE sandboxes ADD COLUMN land_requested INTEGER DEFAULT 0');
    }
    if (!sbCols.some((c) => c.name === 'land_result')) {
      this.db.exec('ALTER TABLE sandboxes ADD COLUMN land_result TEXT');
    }
    // Same for `purpose` (the human intent the worker names a branch from) over a
    // sandboxes table made before it — the write-side mirror of tracer.py MIGRATIONS
    // and sandboxes.py::ensure_schema. We INSERT into it.
    if (!sbCols.some((c) => c.name === 'purpose')) {
      this.db.exec('ALTER TABLE sandboxes ADD COLUMN purpose TEXT');
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

  /** Create a FRESH sandbox and enqueue a run bound to it — the "＋ New sandbox"
   *  launcher path — as ONE transaction, so a rejected enqueue never leaves an
   *  orphan sandbox. The run's `request` doubles as the sandbox `purpose` (capped
   *  to the purpose column's 500 chars), so the worker names the branch from the
   *  same text (branch_namer, `adw/<id>` fallback) — the operator types nothing
   *  extra. Same determinism spine: two INSERTs, the worker disposes.
   *
   *  No branch template is read here: a non-empty purpose (the request is required)
   *  always defers naming to the worker (branch NULL), so a config-derived template
   *  would never be interpolated — createSandbox's own default suffices. */
  enqueueInNewSandbox(spec: EnqueueSpec): { id: number; adw_id: string; sandbox_id: string } {
    const parsed = EnqueueSpecSchema.parse(spec);
    if (!parsed.new_sandbox) {
      throw new EnqueueError('enqueueInNewSandbox requires new_sandbox');
    }
    // Validate the ADW up front so we don't open a transaction we'll only roll back.
    if (!readAdwNames(this.adwsDir).has(parsed.adw_name)) {
      throw new EnqueueError(`unknown adw_name '${parsed.adw_name}' for this project`);
    }
    const level = parsed.new_sandbox.level;
    const run = this.db.transaction(() => {
      const { id: sandbox_id } = this.createSandbox({ level, purpose: parsed.request.slice(0, 500) });
      const { id, adw_id } = this.enqueue({
        adw_name: parsed.adw_name,
        request: parsed.request,
        agent: parsed.agent ?? null,
        config: parsed.config ?? null,
        sandbox_id,
        requested_by: parsed.requested_by ?? null,
      });
      return { id, adw_id, sandbox_id };
    });
    return run();
  }

  // ── sandboxes ──────────────────────────────────────────────────────────────
  // Same determinism spine as run_queue: create = INSERT a `requested` row; shut
  // down = flip `shutdown_requested`. The worker provisions the worktree and
  // disposes — the cockpit never spawns a process.

  private readonly SANDBOX_COLS =
    `id, project_root, level, worktree_path, branch, purpose, ports, status, tip_sha,
     shutdown_requested, land_requested, land_result, error, created_at`;

  /** INSERT a sandbox request; returns the id the worker will provision under.
   *
   *  Branch resolution: an explicit `spec.branch` (a schema-validated, literal
   *  operator override) wins; otherwise the sandbox branches from `branchTemplate`
   *  — the selected level's profile `branch` from config — with `${SANDBOX_ID}`
   *  filled in with the freshly minted id. The template is trusted (it comes from
   *  the project's own config, resolved by the route), but we re-validate the
   *  interpolated result: it is spliced into the row the worker reads AND (via the
   *  profile's ${BRANCH}) into shell setup/land commands, so a malformed or unsafe
   *  template must fail loudly here rather than at `git worktree add`. */
  createSandbox(
    spec: CreateSandboxSpec,
    branchTemplate = 'adw/${SANDBOX_ID}',
  ): { id: string } {
    const parsed = CreateSandboxSpecSchema.parse(spec);
    const id = newAdwId(); // same 8-hex shape as an adw_id
    const purpose = parsed.purpose?.trim() || null;
    // Branch precedence: an explicit override wins; else, when a purpose is given,
    // defer to the worker (branch NULL now → branch_namer mints a readable slug at
    // provision, adw/<id> fallback); else interpolate the level's template now.
    const branch = parsed.branch
      ? parsed.branch
      : purpose
        ? null
        : branchTemplate.replaceAll('${SANDBOX_ID}', id);
    if (branch != null) {
      const branchErr = validateBranchName(branch);
      if (branchErr) throw new EnqueueError(`sandbox branch — ${branchErr}`);
    }
    this.db
      .prepare(
        `INSERT INTO sandboxes (id, project_root, level, branch, purpose, status,
                                shutdown_requested, created_at)
         VALUES (?, ?, ?, ?, ?, 'requested', 0, ?)`,
      )
      .run(id, this.projectRoot, parsed.level, branch, purpose, nowIso());
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

  /** Ask the worker to run this sandbox's `land` hook (flip `land_requested`).
   *  Only an `active` sandbox can land — a run may only target an active tree and
   *  the worktree must exist for the hook — so a non-active sandbox is rejected
   *  (null). Idempotent; landing never destroys the sandbox. Returns the new state. */
  requestLand(id: string): Sandbox | null {
    const sb = this.getSandbox(id);
    if (!sb) return null;
    if (sb.status !== 'active') return null;
    this.db.prepare('UPDATE sandboxes SET land_requested=1 WHERE id=?').run(id);
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
