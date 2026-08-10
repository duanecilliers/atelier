import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { AtelierDb } from '@/lib/db';

// One focused rollup test: it exercises the private splitAgentEnd (read =
// input_tokens + cache_write_tokens, cost from the payload) plus costRollup's
// distinct-run Set counting and the model/coding_agent/"unknown" fallback. We
// seed the minimal three tables the rollup reads. (Exhaustive rollup coverage is
// deliberately out of scope - this is display derivation, not the control seam.)

let dir: string;

function seed(): string {
  dir = mkdtempSync(join(tmpdir(), 'atelier-db-'));
  const path = join(dir, 'sssf.db');
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE sessions (adw_id TEXT PRIMARY KEY, started_at TEXT, archived INTEGER DEFAULT 0);
    CREATE TABLE agent_sessions (adw_id TEXT, agent TEXT, model TEXT, coding_agent TEXT);
    CREATE TABLE events (adw_id TEXT, name TEXT, type TEXT, payload_json TEXT);
  `);
  db.prepare('INSERT INTO sessions VALUES (?,?,0)').run('r1', '2026-01-02T00:00:00Z');
  db.prepare('INSERT INTO sessions VALUES (?,?,0)').run('r2', '2026-01-01T00:00:00Z');
  db.prepare('INSERT INTO agent_sessions VALUES (?,?,?,?)').run('r1', 'builder', 'anthropic/x', 'claude_code');
  const ev = db.prepare('INSERT INTO events (adw_id, name, type, payload_json) VALUES (?,?,?,?)');
  ev.run('r1', 'builder', 'agent_end', JSON.stringify({ cost: 0.1, usage: { input_tokens: 10, cache_write_tokens: 5, output_tokens: 3 } }));
  ev.run('r1', 'builder', 'agent_end', JSON.stringify({ cost: 0.2, usage: { input_tokens: 2, output_tokens: 1 } }));
  // r2 has no agent_sessions row -> model null -> key falls back to "unknown"
  ev.run('r2', 'scout', 'agent_end', JSON.stringify({ cost: 0.05, usage: { output_tokens: 4 } }));
  db.close();
  return path;
}

let adb: AtelierDb;
beforeEach(() => {
  adb = new AtelierDb(seed());
});
afterEach(() => {
  adb.close(); // release the sqlite handle before removing the db (symmetry with control.test.ts)
  rmSync(dir, { recursive: true, force: true });
});

describe('costRollup', () => {
  it('counts distinct runs and totals across models', () => {
    const roll = adb.costRollup();
    expect(roll.totals.runs).toBe(2); // r1 + r2, distinct
    expect(roll.totals.read).toBe(17); // (10+5) + (2+0)
    expect(roll.totals.written).toBe(8); // 3 + 1 + 4
    expect(roll.totals.cost).toBeCloseTo(0.35);
  });

  it('folds cache_write into read and sums per model', () => {
    const m = adb.costRollup().byModel.find((b) => b.model === 'anthropic/x')!;
    expect(m.read).toBe(17); // input + cache_write across both r1 events
    expect(m.written).toBe(4);
    expect(m.cost).toBeCloseTo(0.3);
    expect(m.runs).toBe(1); // both events are the same run r1
  });

  it('buckets a run with no model row under "unknown"', () => {
    const unknown = adb.costRollup().byModel.find((b) => b.model === 'unknown')!;
    expect(unknown).toBeDefined();
    expect(unknown.written).toBe(4);
    expect(unknown.cost).toBeCloseTo(0.05);
  });
});
