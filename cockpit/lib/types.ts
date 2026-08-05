/**
 * THE SEAM — the frozen TypeScript mirror of sssf.db.
 *
 * Every interface here mirrors a table in the engine's SQLite database
 * (engine/adws/adw_modules/tracer.py) one-for-one. This is the Python↔TS
 * contract the whole architecture rests on: the engine writes these rows, the
 * cockpit reads them. If tracer.py's schema changes, this file and lib/schemas.ts
 * must change with it — `pnpm check:contract` guards against silent drift.
 *
 * Provenance: lifted from SSSF's own read-only visualizer
 * (.claude/skills/sssf/apps/visualizer/shared/types.ts), which is itself the
 * reference reader over this exact schema. Nothing here is derived state — phase
 * durations, run progress and lane layout are computed in the UI, never stored.
 */

/** sessions.status — a run is running until it earns success. */
export type SessionStatus = 'running' | 'success' | 'fail';

/** phases.status — queued only for manifest-declared phases not yet entered. */
export type PhaseStatus = 'queued' | 'running' | 'success' | 'fail';

/** phases.kind — decides which lane a block renders in. Agent proposes, code disposes. */
export type PhaseKind = 'engineer' | 'code' | 'agent';

/** events.type — the ten types tracer.py emits. */
export type EventType =
  | 'phase_start'
  | 'phase_end'
  | 'agent_start'
  | 'agent_end'
  | 'tool_call'
  | 'handoff'
  | 'gate_pass'
  | 'gate_fail'
  | 'log'
  | 'error';

export interface Session {
  adw_id: string;
  /** ADW script(s) that ran this session, e.g. "adw_plan + adw_build_test". */
  adw_name: string | null;
  request: string | null;
  status: SessionStatus | null;
  engineer: string | null;
  started_at: string | null;
  ended_at: string | null;
  total_tokens: number | null;
  total_cost: number | null;
  /** 1 once archived out of the review list. Review state, not run state. */
  archived: number | null;
}

/**
 * A session row with its phases embedded, so the run list draws the
 * mini-progress dots without a second request per row.
 */
export interface SessionSummary extends Session {
  /** Full phase rows, ordered by seq — one dot each. */
  phases: Phase[];
  phase_count: number;
  /** The session's agents, so a card can color its per-agent dots. */
  agents: AgentSession[];
}

export interface Phase {
  phase_id: string;
  adw_id: string;
  seq: number | null;
  name: string | null;
  kind: PhaseKind | null;
  owner: string | null;
  description: string | null;
  status: PhaseStatus | null;
  attempt: number | null;
  retries: number | null;
  error: string | null;
  started_at: string | null;
  ended_at: string | null;
}

export interface Event {
  /** SQLite rowid — the polling cursor. Monotonic, insertion-ordered. */
  rowid: number;
  event_id: string;
  adw_id: string;
  phase_id: string | null;
  /** Span nesting: an agent phase expands into its tool-call children. */
  parent_id: string | null;
  type: EventType | null;
  name: string | null;
  /** Raw JSON string as written by the tracer; parse at the point of display. */
  payload_json: string | null;
  tokens: number | null;
  started_at: string | null;
  ended_at: string | null;
}

export interface Envelope {
  envelope_id: string;
  adw_id: string;
  phase_id: string | null;
  agent: string | null;
  /** Name of the data_types model the response was parsed against. */
  output_type: string | null;
  payload_json: string | null;
  /** SQLite integer boolean. */
  valid: number | null;
  attempt: number | null;
  created_at: string | null;
}

export interface GateResult {
  id: number;
  adw_id: string;
  phase_id: string | null;
  attempt: number | null;
  gate: string | null;
  /** SQLite integer boolean. */
  passed: number | null;
  /** JSON array of violation strings; "[]" on a pass. */
  violations_json: string | null;
  /**
   * JSON array of GateCheck — the per-item evidence behind the verdict, so a
   * green gate can say WHAT it verified. Null on rows written before the tracer
   * recorded checks; fall back to the verdict alone.
   */
  checks_json: string | null;
  created_at: string | null;
}

/** One item a gate inspected — the parsed element of `checks_json`. */
export interface GateCheck {
  item: string;
  ok: boolean;
  note: string;
}

/** processes — every pid a run has spawned, so a hung run is killable. */
export interface Process {
  id: number;
  adw_id: string;
  /** 'adw' (the workflow process) | 'agent' (a coding-agent child). */
  kind: string | null;
  name: string | null;
  pid: number | null;
  command: string | null;
  started_at: string | null;
  /** NULL = believed alive. */
  ended_at: string | null;
}

/** agent_sessions — the queryable mirror of agent_map.json. Supplies lane labels (`name · model`). */
export interface AgentSession {
  adw_id: string;
  agent: string;
  coding_agent: string | null;
  model: string | null;
  session_id: string | null;
  /** The agent's lane color from sssf.config.yaml, e.g. "#a78bfa". Null → UI palette. */
  color: string | null;
  /** Window occupancy after the last turn, and the model's ceiling. Null while running. */
  context_tokens: number | null;
  context_window: number | null;
  created_at: string | null;
  last_used_at: string | null;
}

/** run_queue.status — the control-plane lifecycle, set by the worker. */
export type QueueStatus = 'queued' | 'claimed' | 'running' | 'done' | 'failed' | 'canceled';

/** Terminal queue statuses — a row here is finished and won't move again. */
export const TERMINAL_QUEUE_STATUSES: readonly QueueStatus[] = ['done', 'failed', 'canceled'];

/**
 * run_queue — the Phase 2 control seam. The cockpit INSERTs a launch spec and
 * flips cancel_requested; the worker (adw_worker.py) drains it, spawns the ADW,
 * and owns pid/status/exit_code. The cockpit never spawns a process itself.
 */
export interface RunQueueRow {
  id: number;
  /** Minted at enqueue so the cockpit can deep-link to the run before it starts. */
  adw_id: string | null;
  /** The ADW script to run, e.g. "adw_scout". */
  adw_name: string | null;
  /** adw_prompt's --agent; null for multi-agent ADWs. */
  agent: string | null;
  request: string | null;
  /** Roster config path; null = the worker's default. */
  config: string | null;
  status: QueueStatus | null;
  requested_by: string | null;
  /** SQLite integer boolean — the cockpit sets this to ask the worker to stop. */
  cancel_requested: number | null;
  /** The worker-spawned adw pid (also tracked in processes). */
  pid: number | null;
  exit_code: number | null;
  error: string | null;
  enqueued_at: string | null;
  claimed_at: string | null;
  started_at: string | null;
  ended_at: string | null;
}

// ── payload_json shapes ──────────────────────────────────────────────────────
// events.payload_json is stored as a string. These are the parsed shapes; every
// field is optional because the tracer writes what the coding agent reported.

/** Parsed `agent_start` payload — the live source of a lane's label and color. */
export interface AgentStartPayload {
  model?: string;
  thinking?: string;
  session_id?: string;
  color?: string;
  coding_agent?: string;
  purpose?: string;
  tools?: string[] | null;
  harness_engineering?: string[];
}

/**
 * Tokens and dollars per component for one agent phase, summed across every
 * send it made. Mirrors pi's `usage`: `input_tokens` EXCLUDES cache reads.
 */
export interface UsageBreakdown {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  /** Reasoning SHARE of output_tokens, not a fifth component. */
  reasoning_tokens?: number;
  total_tokens: number;
  input_cost: number;
  output_cost: number;
  cache_read_cost: number;
  cache_write_cost: number;
  total_cost: number;
}

/** Parsed `agent_end` payload — closes out a call with its cost and context use. */
export interface AgentEndPayload {
  cost?: number;
  usage?: UsageBreakdown;
  context_tokens?: number;
  context_window?: number;
}

/** Parsed `tool_call` payload — one event per real tool call, emitted when the tool returns. */
export interface ToolCallPayload {
  tool?: string;
  tool_call_id?: string;
  args?: Record<string, unknown>;
  result_snippet?: string;
  ok?: boolean;
  duration_ms?: number;
  agent?: string;
}

// ── derived read shapes ──────────────────────────────────────────────────────

/**
 * What actually moved through a session, summed across every agent — NOT the
 * billed total (which re-counts cached re-reads every turn).
 */
export interface SessionUsage {
  /** Raw prompt tokens read for the first time: new input + cache writes. */
  read: number;
  /** Tokens generated. */
  written: number;
}

export interface SessionDetail {
  session: Session;
  usage: SessionUsage;
  phases: Phase[];
  agents: AgentSession[];
}

/**
 * The polling page. `after` = the cursor from the previous response; `cursor` is
 * the highest rowid in this page (or the `after` you sent when empty), so it
 * feeds straight back in. `has_more` means the page hit the limit.
 */
export interface EventsPage {
  events: Event[];
  cursor: number;
  has_more: boolean;
}

// ── Phase 3: observability & cost (all derived from agent_end + gate_results) ─
// None of these mirror a db row — they're aggregates the cockpit computes over
// the trace the engine already writes. The seam contract (row interfaces +
// schemas.ts) is untouched by Phase 3.

/**
 * One phase's cost, for the per-run model stack. Numbers are the engine's
 * phase totals — already summed across retries (agents.py writes them that way).
 */
export interface PhaseCost {
  phase_id: string;
  seq: number;
  phase_name: string;
  /** The agent that ran the phase (phases.owner / agent_end.name). */
  agent: string;
  /** Model + backend from agent_sessions; null while a run is still live. */
  model: string | null;
  coding_agent: string | null;
  attempt: number | null;
  retries: number | null;
  /** Split the same way SessionUsage does: read = input + cache_write. */
  read: number;
  written: number;
  cost: number;
}

/** Cross-run spend for one model (or backend/"unknown" when model is absent). */
export interface ModelSpend {
  model: string;
  coding_agent: string | null;
  /** Distinct runs this model appeared in. */
  runs: number;
  read: number;
  written: number;
  cost: number;
  /** cost / grand-total cost, 0..1. 0 when the grand total is 0. */
  share: number;
}

/** The /cost dashboard: grand totals + a per-model breakdown, most-spend first. */
export interface CostRollup {
  totals: { runs: number; read: number; written: number; cost: number };
  byModel: ModelSpend[];
}

/** Cross-run health for one gate type. */
export interface GateHealth {
  gate: string;
  /** Distinct runs this gate fired in. */
  runs: number;
  passed: number;
  failed: number;
  /** Gate results recorded on a retry (attempt > 1). */
  retries: number;
  /** passed / (passed + failed), 0..1. 1 when nothing has failed. */
  passRate: number;
}

/** A pointer to one failing gate result, for the recent-failures list. */
export interface GateFailureRef {
  adw_id: string;
  gate: string;
  phase_id: string;
  attempt: number | null;
  created_at: string | null;
}

/** The /gates dashboard: per-gate health + the latest failures across runs. */
export interface GateRollup {
  byGate: GateHealth[];
  recentFailures: GateFailureRef[];
}
