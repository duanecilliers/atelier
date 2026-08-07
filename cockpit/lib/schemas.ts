/**
 * Zod row schemas — the enforced half of the seam contract.
 *
 * One schema per table in sssf.db, keyed by the exact snake_case column names
 * the engine's tracer.py writes. Two jobs:
 *   1. Validate rows as they cross the SQLite → TS boundary (lib/db.ts), the
 *      same discipline FounderOS used on its own repo layer.
 *   2. Enumerate the column contract. TABLE_COLUMNS is derived from these
 *      schemas and checked against the live db by scripts/check-contract.ts, so
 *      a Python-side schema change that isn't mirrored here fails loudly instead
 *      of drifting silently (the plan's #1 HIGH risk).
 *
 * Columns are `.nullable()` wherever the tracer can leave them NULL, and columns
 * added by tracer.py's additive migrations (adw_name, archived, checks_json,
 * color, context_tokens, context_window) are additionally `.optional()` so a db
 * written by an older tracer still validates.
 */
import { z } from 'zod';

/** SQLite integer boolean (0 | 1), tolerant of nulls. */
const sqliteBool = z.number().int().nullable();

export const SessionRowSchema = z.object({
  adw_id: z.string(),
  adw_name: z.string().nullable().optional(), // migration-added
  request: z.string().nullable(),
  status: z.string().nullable(),
  engineer: z.string().nullable(),
  started_at: z.string().nullable(),
  ended_at: z.string().nullable(),
  total_tokens: z.number().nullable(),
  total_cost: z.number().nullable(),
  archived: sqliteBool.optional(), // migration-added
});

export const PhaseRowSchema = z.object({
  phase_id: z.string(),
  adw_id: z.string(),
  seq: z.number().int().nullable(),
  name: z.string().nullable(),
  kind: z.string().nullable(),
  owner: z.string().nullable(),
  description: z.string().nullable(),
  status: z.string().nullable(),
  attempt: z.number().int().nullable(),
  retries: z.number().int().nullable(),
  error: z.string().nullable(),
  started_at: z.string().nullable(),
  ended_at: z.string().nullable(),
});

export const EventRowSchema = z.object({
  event_id: z.string(),
  adw_id: z.string(),
  phase_id: z.string().nullable(),
  parent_id: z.string().nullable(),
  type: z.string().nullable(),
  name: z.string().nullable(),
  payload_json: z.string().nullable(),
  tokens: z.number().int().nullable(),
  started_at: z.string().nullable(),
  ended_at: z.string().nullable(),
});

export const EnvelopeRowSchema = z.object({
  envelope_id: z.string(),
  adw_id: z.string(),
  phase_id: z.string().nullable(),
  agent: z.string().nullable(),
  output_type: z.string().nullable(),
  payload_json: z.string().nullable(),
  valid: sqliteBool,
  attempt: z.number().int().nullable(),
  created_at: z.string().nullable(),
});

export const GateResultRowSchema = z.object({
  id: z.number().int(),
  adw_id: z.string(),
  phase_id: z.string().nullable(),
  attempt: z.number().int().nullable(),
  gate: z.string().nullable(),
  passed: sqliteBool,
  violations_json: z.string().nullable(),
  checks_json: z.string().nullable().optional(), // migration-added
  created_at: z.string().nullable(),
});

export const ProcessRowSchema = z.object({
  id: z.number().int(),
  adw_id: z.string(),
  kind: z.string().nullable(),
  name: z.string().nullable(),
  pid: z.number().int().nullable(),
  command: z.string().nullable(),
  started_at: z.string().nullable(),
  ended_at: z.string().nullable(),
});

export const AgentSessionRowSchema = z.object({
  adw_id: z.string(),
  agent: z.string(),
  coding_agent: z.string().nullable(),
  model: z.string().nullable(),
  color: z.string().nullable().optional(), // migration-added
  session_id: z.string().nullable(),
  context_tokens: z.number().int().nullable().optional(), // migration-added
  context_window: z.number().int().nullable().optional(), // migration-added
  created_at: z.string().nullable(),
  last_used_at: z.string().nullable(),
});

/**
 * run_queue — the Phase 2 control seam. The one table the cockpit WRITES (via a
 * narrow read-write connection): it INSERTs a launch spec and, to stop a run,
 * sets cancel_requested. The worker (engine/adws/adw_worker.py) drains it and
 * owns every other column. DDL source: engine/adws/adw_modules/queue.py.
 */
export const RunQueueRowSchema = z.object({
  id: z.number().int(),
  adw_id: z.string().nullable(),
  adw_name: z.string().nullable(),
  agent: z.string().nullable(),
  request: z.string().nullable(),
  config: z.string().nullable(),
  sandbox_id: z.string().nullable().optional(), // migration-added
  status: z.string().nullable(),
  requested_by: z.string().nullable(),
  cancel_requested: sqliteBool,
  pid: z.number().int().nullable(),
  exit_code: z.number().int().nullable(),
  error: z.string().nullable(),
  enqueued_at: z.string().nullable(),
  claimed_at: z.string().nullable(),
  started_at: z.string().nullable(),
  ended_at: z.string().nullable(),
});

/**
 * workers — the per-project liveness heartbeat (Part F). The worker
 * (engine/adws/adw_worker.py) upserts a row every poll; the cockpit only reads
 * it. DDL source: engine/adws/adw_modules/workers.py. All columns ship in the
 * CREATE (not migration-added), so none are optional — a fresh `workers` table
 * is a hard requirement of check:contract.
 */
export const WorkerRowSchema = z.object({
  host: z.string().nullable(),
  pid: z.number().int().nullable(),
  started_at: z.string().nullable(),
  last_seen_at: z.string().nullable(),
});

/**
 * sandboxes — the persistent-workspace control seam (design: docs/design/sandbox-runs.md).
 * The cockpit WRITES it (INSERT a `requested` row; flip `shutdown_requested`); the
 * worker (engine/adws/adw_worker.py) provisions/disposes and owns every engine
 * column. DDL source: engine/adws/adw_modules/sandboxes.py. All columns ship in the
 * CREATE (not migration-added) EXCEPT the slice-4 land_* columns, so a fresh
 * `sandboxes` table is a hard requirement of check:contract but land_* are tolerated
 * absent on an older db (MIGRATION_COLUMNS there).
 */
export const SandboxRowSchema = z.object({
  id: z.string(),
  project_root: z.string().nullable(),
  level: z.string().nullable(),
  worktree_path: z.string().nullable(),
  branch: z.string().nullable(),
  purpose: z.string().nullable().optional(), // migration-added; the worker names a branch from it
  ports: z.string().nullable(),
  status: z.string().nullable(),
  tip_sha: z.string().nullable(),
  shutdown_requested: sqliteBool,
  land_requested: sqliteBool.optional(), // migration-added (slice 4)
  land_result: z.string().nullable().optional(), // migration-added (slice 4)
  error: z.string().nullable(),
  created_at: z.string().nullable(),
});

/**
 * The column contract, table → column names, derived straight from the schemas
 * above so it can never disagree with them. scripts/check-contract.ts asserts
 * every one of these columns exists in the live sssf.db.
 */
export const TABLE_COLUMNS = {
  sessions: Object.keys(SessionRowSchema.shape),
  phases: Object.keys(PhaseRowSchema.shape),
  events: Object.keys(EventRowSchema.shape),
  envelopes: Object.keys(EnvelopeRowSchema.shape),
  gate_results: Object.keys(GateResultRowSchema.shape),
  processes: Object.keys(ProcessRowSchema.shape),
  agent_sessions: Object.keys(AgentSessionRowSchema.shape),
  run_queue: Object.keys(RunQueueRowSchema.shape),
  workers: Object.keys(WorkerRowSchema.shape),
  sandboxes: Object.keys(SandboxRowSchema.shape),
} as const satisfies Record<string, string[]>;

export type TableName = keyof typeof TABLE_COLUMNS;
