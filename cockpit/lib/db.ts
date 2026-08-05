/**
 * SQLite reader over the engine's sssf.db — the cockpit half of the seam.
 *
 * READ-ONLY by construction (Phase 1 is observe-first). The connection is opened
 * readonly and every query is a SELECT; the writers are the tracers of running
 * ADW processes, and WAL lets us read straight through their inserts. The cockpit
 * never mutates a run — it observes. (Control lands in Phase 2 via a run_queue
 * table + worker, never by this process spawning anything.)
 *
 * Ported from SSSF's own reference reader
 * (.claude/skills/sssf/apps/visualizer/server/db.ts), bun:sqlite → better-sqlite3,
 * keeping the same SQL, the same optionalColumn() migration tolerance, and the
 * same rowid-cursor polling contract. Rows are validated through lib/schemas.ts
 * at the boundary on the structural reads; the hot events path is cast directly.
 */
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import {
  AgentSessionRowSchema,
  EnvelopeRowSchema,
  GateResultRowSchema,
  PhaseRowSchema,
  ProcessRowSchema,
  RunQueueRowSchema,
  SessionRowSchema,
} from './schemas';
import type {
  AgentSession,
  AgentStartPayload,
  CostRollup,
  Envelope,
  Event,
  EventsPage,
  GateResult,
  GateRollup,
  ModelSpend,
  Phase,
  PhaseCost,
  Process,
  RunQueueRow,
  Session,
  SessionDetail,
  SessionSummary,
  SessionUsage,
} from './types';

const DEFAULT_DB_RELATIVE = '../engine/adws/adw_data/sssf.db';
const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 500;

/** Resolve the db path: SSSF_DB wins, else <cwd>/../engine/adws/adw_data/sssf.db. */
export function resolveDbPath(): string {
  const raw = process.env.SSSF_DB ?? DEFAULT_DB_RELATIVE;
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * Split one `agent_end` payload into read/written tokens and cost — the same
 * derivation `usage()` does per row, factored out because the Phase 3 rollups
 * need it too. `read` = new input + cache writes (what actually moved), NOT the
 * billed input (which re-counts cached re-reads). A payload from an older tracer
 * simply contributes zeros.
 */
function splitAgentEnd(payloadJson: string | null): { read: number; written: number; cost: number } {
  if (!payloadJson) return { read: 0, written: 0, cost: 0 };
  try {
    const p = JSON.parse(payloadJson) as { cost?: number; usage?: Record<string, number> };
    const u = p.usage ?? {};
    return {
      read: (u.input_tokens ?? 0) + (u.cache_write_tokens ?? 0),
      written: u.output_tokens ?? 0,
      cost: p.cost ?? 0,
    };
  } catch {
    return { read: 0, written: 0, cost: 0 };
  }
}

export class AtelierDb {
  readonly path: string;
  /** Where the ADW session dirs live: `{data_dir}/sessions/{adw_id}/{agent}/`. */
  readonly sessionsDir: string;
  readonly journalMode: string;
  private readonly db: Database.Database;
  /** Cache for optionalColumn(), keyed "table.column". Only ever false → true. */
  private readonly columnCache = new Map<string, boolean>();

  constructor(path: string) {
    if (!existsSync(path)) {
      throw new Error(
        `sssf.db not found at ${path}\n` +
          `Point the cockpit at the engine: set SSSF_DB, or run an ADW in ../engine ` +
          `so it creates ${DEFAULT_DB_RELATIVE}.`,
      );
    }
    this.path = path;
    this.sessionsDir = resolve(dirname(path), 'sessions');
    this.db = new Database(path, { readonly: true });

    // WAL is set by the tracer when it creates the db; a readonly connection
    // cannot change it, so we assert rather than set, and always take the
    // busy_timeout so a concurrent writer never turns into a failed request.
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = NORMAL');
    const mode = this.db.pragma('journal_mode', { simple: true }) as string;
    this.journalMode = mode ?? 'unknown';
    if (this.journalMode.toLowerCase() !== 'wal') {
      console.warn(
        `[db] journal_mode is "${this.journalMode}", expected "wal" — ` +
          `live reads during agent writes may block`,
      );
    }
  }

  /**
   * True if a migration-added column exists. We open readonly and cannot run the
   * ALTERs ourselves, so selecting one blindly throws on an older db. Probe and
   * substitute NULL instead. Re-probes while missing (the tracer's ALTER can land
   * while we serve); latches once seen.
   */
  private hasColumn(table: string, column: string): boolean {
    const key = `${table}.${column}`;
    if (!this.columnCache.get(key)) {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      this.columnCache.set(key, cols.some((c) => c.name === column));
    }
    return this.columnCache.get(key) ?? false;
  }

  private optionalColumn(table: string, column: string): string {
    return this.hasColumn(table, column) ? column : `NULL AS ${column}`;
  }

  /**
   * True if a table exists. run_queue is created by the engine/worker/control
   * connection, so a cockpit reading an untouched db must tolerate its absence
   * (a readonly connection can't create it). Cached like hasColumn.
   */
  private hasTable(table: string): boolean {
    const key = `table:${table}`;
    if (!this.columnCache.get(key)) {
      const row = this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .get(table);
      this.columnCache.set(key, row != null);
    }
    return this.columnCache.get(key) ?? false;
  }

  close(): void {
    this.db.close();
  }

  /** Sessions, most recent first, each with phases + agents for the progress dots. */
  sessions(limit = 200): SessionSummary[] {
    const rows = z.array(SessionRowSchema).parse(
      this.db
        .prepare(
          `SELECT adw_id, ${this.optionalColumn('sessions', 'adw_name')}, request,
                  status, engineer, started_at, ended_at,
                  total_tokens, total_cost,
                  ${this.optionalColumn('sessions', 'archived')}
             FROM sessions
            WHERE COALESCE(${this.hasColumn('sessions', 'archived') ? 'archived' : '0'}, 0) = 0
            ORDER BY started_at DESC, rowid DESC
            LIMIT ?`,
        )
        .all(clamp(limit, 1, MAX_LIMIT)),
    ) as Session[];

    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.adw_id);
    const placeholders = ids.map(() => '?').join(', ');
    const phaseRows = z.array(PhaseRowSchema).parse(
      this.db
        .prepare(
          `SELECT phase_id, adw_id, seq, name, kind, owner, description, status,
                  attempt, retries, error, started_at, ended_at
             FROM phases WHERE adw_id IN (${placeholders}) ORDER BY seq, rowid`,
        )
        .all(...ids),
    ) as Phase[];

    const byAdw = new Map<string, Phase[]>();
    for (const phase of phaseRows) {
      const list = byAdw.get(phase.adw_id);
      if (list) list.push(phase);
      else byAdw.set(phase.adw_id, [phase]);
    }

    const agentsByAdw = this.agentsFor(ids);

    return rows.map((session) => {
      const phases = byAdw.get(session.adw_id) ?? [];
      return Object.assign(session, {
        phases,
        phase_count: phases.length,
        agents: agentsByAdw.get(session.adw_id) ?? [],
      });
    });
  }

  session(adwId: string): Session | null {
    const row = this.db
      .prepare(
        `SELECT adw_id, ${this.optionalColumn('sessions', 'adw_name')}, request,
                status, engineer, started_at, ended_at, total_tokens, total_cost,
                ${this.optionalColumn('sessions', 'archived')}
           FROM sessions WHERE adw_id = ?`,
      )
      .get(adwId);
    return row ? (SessionRowSchema.parse(row) as Session) : null;
  }

  phases(adwId: string): Phase[] {
    return z.array(PhaseRowSchema).parse(
      this.db
        .prepare(
          `SELECT phase_id, adw_id, seq, name, kind, owner, description, status,
                  attempt, retries, error, started_at, ended_at
             FROM phases WHERE adw_id = ? ORDER BY seq, rowid`,
        )
        .all(adwId),
    ) as Phase[];
  }

  agentSessions(adwId: string): AgentSession[] {
    return this.agentsFor([adwId]).get(adwId) ?? [];
  }

  /**
   * Agents per session for a set of ids: the agent_sessions rows plus anything
   * that has started but not finished (agents.py writes the row only after the
   * envelope persists, so a running agent's label comes off its agent_start event).
   */
  private agentsFor(adwIds: string[]): Map<string, AgentSession[]> {
    const byAdw = new Map<string, AgentSession[]>();
    if (adwIds.length === 0) return byAdw;
    const placeholders = adwIds.map(() => '?').join(', ');

    const append = (adwId: string, agent: AgentSession) => {
      const list = byAdw.get(adwId);
      if (list) list.push(agent);
      else byAdw.set(adwId, [agent]);
    };

    const color = this.optionalColumn('agent_sessions', 'color');
    const ctxUsed = this.optionalColumn('agent_sessions', 'context_tokens');
    const ctxWindow = this.optionalColumn('agent_sessions', 'context_window');

    const completed = z.array(AgentSessionRowSchema).parse(
      this.db
        .prepare(
          `SELECT adw_id, agent, coding_agent, model, session_id, ${color},
                  ${ctxUsed}, ${ctxWindow}, created_at, last_used_at
             FROM agent_sessions WHERE adw_id IN (${placeholders})
            ORDER BY created_at, agent`,
        )
        .all(...adwIds),
    ) as AgentSession[];
    for (const row of completed) append(row.adw_id, row);

    const started = this.db
      .prepare(
        `SELECT e.adw_id, p.owner AS agent, e.payload_json, e.started_at
           FROM events e JOIN phases p ON p.phase_id = e.phase_id
          WHERE e.adw_id IN (${placeholders}) AND e.type = 'agent_start'
          ORDER BY e.rowid`,
      )
      .all(...adwIds) as {
      adw_id: string;
      agent: string | null;
      payload_json: string | null;
      started_at: string | null;
    }[];

    for (const row of started) {
      if (!row.agent) continue;
      if (byAdw.get(row.adw_id)?.some((a) => a.agent === row.agent)) continue;
      let payload: AgentStartPayload = {};
      try {
        payload = JSON.parse(row.payload_json ?? '{}') as AgentStartPayload;
      } catch {
        // A malformed payload just means no label — never a failed request.
      }
      append(row.adw_id, {
        adw_id: row.adw_id,
        agent: row.agent,
        coding_agent: null,
        model: payload.model ?? null,
        session_id: payload.session_id ?? null,
        color: payload.color ?? null,
        context_tokens: null,
        context_window: null,
        created_at: row.started_at,
        last_used_at: row.started_at,
      });
    }
    return byAdw;
  }

  /** Session + usage + phases + agents in one shot — the run-detail view needs all four. */
  sessionDetail(adwId: string): SessionDetail | null {
    const session = this.session(adwId);
    if (!session) return null;
    return {
      session,
      usage: this.usage(adwId),
      phases: this.phases(adwId),
      agents: this.agentSessions(adwId),
    };
  }

  /**
   * Raw tokens read and written, derived from agent_end payloads (not stored), so
   * every historical run gets the split without a re-run. NOT the billed total,
   * which re-counts cached re-reads every turn.
   */
  usage(adwId: string): SessionUsage {
    const rows = this.db
      .prepare("SELECT payload_json FROM events WHERE adw_id = ? AND type = 'agent_end'")
      .all(adwId) as { payload_json: string | null }[];

    let read = 0;
    let written = 0;
    for (const row of rows) {
      const s = splitAgentEnd(row.payload_json);
      read += s.read;
      written += s.written;
    }
    return { read, written };
  }

  /**
   * The most-recent (non-archived) adw_ids, newest first — the scan window the
   * cross-run rollups bound themselves to so a 1000-run db stays cheap. Built the
   * same way sessions() filters archived, tolerating a db without that column.
   */
  private recentAdwIds(limit: number): string[] {
    const archived = this.hasColumn('sessions', 'archived') ? 'archived' : '0';
    const rows = this.db
      .prepare(
        `SELECT adw_id FROM sessions
          WHERE COALESCE(${archived}, 0) = 0
          ORDER BY started_at DESC, rowid DESC
          LIMIT ?`,
      )
      .all(clamp(limit, 1, MAX_LIMIT)) as { adw_id: string }[];
    return rows.map((r) => r.adw_id);
  }

  /**
   * The per-run model stack: one row per phase, in seq order, carrying the model
   * that ran it (from agent_sessions — null while a run is still live), its
   * retry count, and the phase's token/cost totals (already summed across
   * retries by the engine). LEFT JOIN so a phase whose agent_session row hasn't
   * landed yet still appears, just without a model.
   */
  runModelStack(adwId: string): PhaseCost[] {
    const rows = this.db
      .prepare(
        `SELECT e.phase_id, e.name AS agent, e.payload_json,
                p.seq, p.name AS phase_name, p.attempt, p.retries,
                s.model, s.coding_agent
           FROM events e
           JOIN phases p ON p.phase_id = e.phase_id
           LEFT JOIN agent_sessions s ON s.adw_id = e.adw_id AND s.agent = e.name
          WHERE e.adw_id = ? AND e.type = 'agent_end'
          ORDER BY p.seq, e.rowid`,
      )
      .all(adwId) as {
      phase_id: string;
      agent: string | null;
      payload_json: string | null;
      seq: number;
      phase_name: string | null;
      attempt: number | null;
      retries: number | null;
      model: string | null;
      coding_agent: string | null;
    }[];

    return rows.map((r) => {
      const { read, written, cost } = splitAgentEnd(r.payload_json);
      return {
        phase_id: r.phase_id,
        seq: r.seq,
        phase_name: r.phase_name ?? '—',
        agent: r.agent ?? '—',
        model: r.model,
        coding_agent: r.coding_agent,
        attempt: r.attempt,
        retries: r.retries,
        read,
        written,
        cost,
      };
    });
  }

  /**
   * Cross-run spend, grouped by model. Walks the agent_end payloads of the most
   * recent `limit` runs, attributing each to its model (falling back to the
   * backend, then "unknown", when agent_sessions has no model). `runs` per model
   * is a distinct-adw_id count; `share` is each model's slice of grand-total $.
   */
  costRollup(limit = 200): CostRollup {
    const empty: CostRollup = { totals: { runs: 0, read: 0, written: 0, cost: 0 }, byModel: [] };
    const ids = this.recentAdwIds(limit);
    if (ids.length === 0) return empty;
    const placeholders = ids.map(() => '?').join(', ');

    const rows = this.db
      .prepare(
        `SELECT e.adw_id, e.name AS agent, e.payload_json, s.model, s.coding_agent
           FROM events e
           LEFT JOIN agent_sessions s ON s.adw_id = e.adw_id AND s.agent = e.name
          WHERE e.type = 'agent_end' AND e.adw_id IN (${placeholders})`,
      )
      .all(...ids) as {
      adw_id: string;
      agent: string | null;
      payload_json: string | null;
      model: string | null;
      coding_agent: string | null;
    }[];

    type Acc = ModelSpend & { runIds: Set<string> };
    const byModel = new Map<string, Acc>();
    const allRuns = new Set<string>();
    const totals = { read: 0, written: 0, cost: 0 };

    for (const r of rows) {
      const key = r.model ?? r.coding_agent ?? 'unknown';
      const { read, written, cost } = splitAgentEnd(r.payload_json);
      let acc = byModel.get(key);
      if (!acc) {
        acc = {
          model: key,
          coding_agent: r.coding_agent,
          runs: 0,
          read: 0,
          written: 0,
          cost: 0,
          share: 0,
          runIds: new Set<string>(),
        };
        byModel.set(key, acc);
      }
      if (acc.coding_agent == null && r.coding_agent != null) acc.coding_agent = r.coding_agent;
      acc.read += read;
      acc.written += written;
      acc.cost += cost;
      acc.runIds.add(r.adw_id);
      allRuns.add(r.adw_id);
      totals.read += read;
      totals.written += written;
      totals.cost += cost;
    }

    const spend = [...byModel.values()].map(({ runIds, ...m }) => {
      m.runs = runIds.size;
      m.share = totals.cost > 0 ? m.cost / totals.cost : 0;
      return m;
    });
    spend.sort((a, b) => b.cost - a.cost);

    return { totals: { runs: allRuns.size, ...totals }, byModel: spend };
  }

  /**
   * Cross-run gate health, grouped by gate type: pass/fail/retry counts and a
   * pass-rate, plus the latest failing results (each linking back to its run).
   * Bounded to the most recent `limit` runs like the cost rollup.
   */
  gateRollup(limit = 200, failuresLimit = 20): GateRollup {
    const ids = this.recentAdwIds(limit);
    if (ids.length === 0) return { byGate: [], recentFailures: [] };
    const placeholders = ids.map(() => '?').join(', ');

    const rows = this.db
      .prepare(
        `SELECT adw_id, gate, phase_id, passed, attempt, created_at
           FROM gate_results
          WHERE adw_id IN (${placeholders})
          ORDER BY id DESC`,
      )
      .all(...ids) as {
      adw_id: string;
      gate: string;
      phase_id: string;
      passed: number | null;
      attempt: number | null;
      created_at: string | null;
    }[];

    type Acc = GateRollup['byGate'][number] & { runIds: Set<string> };
    const byGate = new Map<string, Acc>();
    const recentFailures: GateRollup['recentFailures'] = [];

    for (const r of rows) {
      let acc = byGate.get(r.gate);
      if (!acc) {
        acc = { gate: r.gate, runs: 0, passed: 0, failed: 0, retries: 0, passRate: 1, runIds: new Set() };
        byGate.set(r.gate, acc);
      }
      const passed = r.passed === 1;
      if (passed) acc.passed += 1;
      else acc.failed += 1;
      if ((r.attempt ?? 1) > 1) acc.retries += 1;
      acc.runIds.add(r.adw_id);
      if (!passed && recentFailures.length < failuresLimit) {
        recentFailures.push({
          adw_id: r.adw_id,
          gate: r.gate,
          phase_id: r.phase_id,
          attempt: r.attempt,
          created_at: r.created_at,
        });
      }
    }

    const gates = [...byGate.values()].map(({ runIds, ...g }) => {
      g.runs = runIds.size;
      const total = g.passed + g.failed;
      g.passRate = total > 0 ? g.passed / total : 1;
      return g;
    });
    gates.sort((a, b) => a.gate.localeCompare(b.gate));

    return { byGate: gates, recentFailures };
  }

  /**
   * The polling query. Rowid cursor, insertion order, bounded page — the same
   * mechanism serves the live tail and lazy-paged history. Hot path: cast, not
   * per-row Zod (the contract check + structural reads carry the validation).
   */
  events(adwId: string, after = 0, limit = DEFAULT_LIMIT): EventsPage {
    const cappedLimit = clamp(limit, 1, MAX_LIMIT);
    const events = this.db
      .prepare(
        `SELECT rowid, event_id, adw_id, phase_id, parent_id, type, name,
                payload_json, tokens, started_at, ended_at
           FROM events
          WHERE adw_id = ? AND rowid > ?
          ORDER BY rowid
          LIMIT ?`,
      )
      .all(adwId, Math.max(0, after), cappedLimit) as Event[];

    return {
      events,
      cursor: events.length > 0 ? events[events.length - 1]!.rowid : Math.max(0, after),
      has_more: events.length === cappedLimit,
    };
  }

  envelopes(adwId: string): Envelope[] {
    return z.array(EnvelopeRowSchema).parse(
      this.db
        .prepare(
          `SELECT envelope_id, adw_id, phase_id, agent, output_type, payload_json,
                  valid, attempt, created_at
             FROM envelopes WHERE adw_id = ? ORDER BY created_at, rowid`,
        )
        .all(adwId),
    ) as Envelope[];
  }

  gates(adwId: string): GateResult[] {
    const checks = this.optionalColumn('gate_results', 'checks_json');
    return z.array(GateResultRowSchema).parse(
      this.db
        .prepare(
          `SELECT id, adw_id, phase_id, attempt, gate, passed, violations_json,
                  ${checks}, created_at
             FROM gate_results WHERE adw_id = ? ORDER BY id`,
        )
        .all(adwId),
    ) as GateResult[];
  }

  /** Live processes for a run (ended_at NULL = believed alive) — cancel targets in Phase 2. */
  processes(adwId: string): Process[] {
    return z.array(ProcessRowSchema).parse(
      this.db
        .prepare(
          `SELECT id, adw_id, kind, name, pid, command, started_at, ended_at
             FROM processes WHERE adw_id = ? ORDER BY id`,
        )
        .all(adwId),
    ) as Process[];
  }

  /**
   * The run_queue, most recent first — the control-plane view. Empty (not an
   * error) on a db the engine/worker has never touched, so the queue page can
   * render before the first run is ever enqueued.
   */
  queue(limit = 100): RunQueueRow[] {
    if (!this.hasTable('run_queue')) return [];
    return z.array(RunQueueRowSchema).parse(
      this.db
        .prepare(
          `SELECT id, adw_id, adw_name, agent, request, config, status, requested_by,
                  cancel_requested, pid, exit_code, error,
                  enqueued_at, claimed_at, started_at, ended_at
             FROM run_queue ORDER BY id DESC LIMIT ?`,
        )
        .all(clamp(limit, 1, MAX_LIMIT)),
    ) as RunQueueRow[];
  }

  sessionCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
    return row?.n ?? 0;
  }
}
