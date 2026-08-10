import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { AtelierControl, EnqueueError } from '@/lib/control';

// The read-write control seam. We drive real branch precedence, the enqueue
// allowlist/terminal guards, the cancel race, and the constructor's DDL self-heal
// against a throwaway sqlite db + a throwaway adws/ dir (the allowlist source).

let dir: string;
let ctl: AtelierControl;

function make(): AtelierControl {
  const db = join(dir, 'sssf.db');
  writeFileSync(db, ''); // empty file -> a fresh sqlite db the constructor DDLs
  const adws = join(dir, 'adws');
  mkdirSync(adws, { recursive: true });
  writeFileSync(join(adws, 'adw_scout.py'), '"""x"""');
  writeFileSync(join(adws, 'adw_plan_build.py'), '"""x"""');
  return new AtelierControl(db, adws, '/repo');
}

/** Poke the db directly to reach states the public API has no setter for (a
 *  worker-owned status). Opens + closes so it never holds a lock on ctl's conn. */
function poke(sql: string, ...args: unknown[]): void {
  const raw = new Database(join(dir, 'sssf.db'));
  raw.pragma('busy_timeout = 5000');
  raw.prepare(sql).run(...args);
  raw.close();
}

function sandboxCount(): number {
  const raw = new Database(join(dir, 'sssf.db'));
  raw.pragma('busy_timeout = 5000');
  const { c } = raw.prepare('SELECT count(*) c FROM sandboxes').get() as { c: number };
  raw.close();
  return c;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atelier-control-'));
  ctl = make();
});
afterEach(() => {
  ctl.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('createSandbox branch precedence', () => {
  it('an explicit branch wins verbatim', () => {
    const { id } = ctl.createSandbox({ level: 'worktree', branch: 'feature/PROJ-1_x' });
    expect(ctl.getSandbox(id)!.branch).toBe('feature/PROJ-1_x');
  });

  it('a purpose defers naming to the worker (branch null)', () => {
    const { id } = ctl.createSandbox({ level: 'worktree', purpose: 'do a thing' });
    const sb = ctl.getSandbox(id)!;
    expect(sb.branch).toBeNull();
    expect(sb.purpose).toBe('do a thing');
  });

  it('an explicit branch plus a purpose records both (branch wins naming)', () => {
    const { id } = ctl.createSandbox({
      level: 'worktree',
      branch: 'feature/PROJ-1_x',
      purpose: 'do a thing',
    });
    const sb = ctl.getSandbox(id)!;
    expect(sb.branch).toBe('feature/PROJ-1_x');
    expect(sb.purpose).toBe('do a thing');
  });

  it('neither -> the level template is interpolated now', () => {
    const { id } = ctl.createSandbox({ level: 'worktree' }, 'adw/${SANDBOX_ID}');
    expect(ctl.getSandbox(id)!.branch).toBe(`adw/${id}`);
  });

  it('rejects an unsafe explicit branch', () => {
    // rejected at the CreateSandboxSpecSchema boundary (superRefine ->
    // validateBranchName); the post-interpolate check is the second guard.
    expect(() => ctl.createSandbox({ level: 'worktree', branch: 'bad;branch' })).toThrow();
  });
});

describe('enqueue', () => {
  it('accepts an on-disk adw_name', () => {
    const { id, adw_id } = ctl.enqueue({ adw_name: 'adw_scout', request: 'recon' });
    expect(id).toBeGreaterThan(0);
    expect(adw_id).toMatch(/^[0-9a-f]{8}$/);
  });

  it('rejects an unknown adw_name', () => {
    expect(() => ctl.enqueue({ adw_name: 'adw_nope', request: 'x' })).toThrow(EnqueueError);
  });

  it('rejects an unknown sandbox_id', () => {
    expect(() => ctl.enqueue({ adw_name: 'adw_scout', request: 'x', sandbox_id: 'ghost' })).toThrow(
      EnqueueError,
    );
  });

  it('rejects a terminal sandbox', () => {
    const { id } = ctl.createSandbox({ level: 'worktree' });
    poke("UPDATE sandboxes SET status='gone' WHERE id=?", id); // force it terminal
    expect(() => ctl.enqueue({ adw_name: 'adw_scout', request: 'x', sandbox_id: id })).toThrow(
      EnqueueError,
    );
  });
});

describe('enqueueInNewSandbox', () => {
  it('creates a sandbox and binds the run to it', () => {
    const r = ctl.enqueueInNewSandbox({ adw_name: 'adw_scout', request: 'do it', new_sandbox: { level: 'worktree' } });
    expect(ctl.getSandbox(r.sandbox_id)).not.toBeNull();
    expect(ctl.get(r.id)!.adw_id).toBe(r.adw_id);
  });

  it('a rejected enqueue leaves no orphan sandbox', () => {
    const before = sandboxCount();
    expect(() =>
      ctl.enqueueInNewSandbox({ adw_name: 'adw_nope', request: 'x', new_sandbox: { level: 'worktree' } }),
    ).toThrow(EnqueueError);
    expect(sandboxCount()).toBe(before);
  });
});

describe('requestCancel', () => {
  it('cancels a still-queued row outright and sets the flag', () => {
    const { id } = ctl.enqueue({ adw_name: 'adw_scout', request: 'x' });
    const row = ctl.requestCancel(id)!;
    expect(row.status).toBe('canceled');
    expect(row.cancel_requested).toBe(1);
  });

  it('is a no-op on a terminal row', () => {
    const { id } = ctl.enqueue({ adw_name: 'adw_scout', request: 'x' });
    poke("UPDATE run_queue SET status='done' WHERE id=?", id);
    expect(ctl.requestCancel(id)).toBeNull();
  });

  it('returns null for an unknown id', () => {
    expect(ctl.requestCancel(99999)).toBeNull();
  });
});

describe('requestLand', () => {
  it('only an active sandbox can land', () => {
    const { id } = ctl.createSandbox({ level: 'worktree' }); // status 'requested', not active
    expect(ctl.requestLand(id)).toBeNull();
    poke("UPDATE sandboxes SET status='active' WHERE id=?", id);
    const sb = ctl.requestLand(id)!;
    expect(sb.land_requested).toBe(1);
  });
});

describe('constructor DDL self-heal', () => {
  it('adds sandbox_id to a pre-sandbox run_queue', () => {
    const p = join(dir, 'old.db');
    const raw = new Database(p);
    // a realistic pre-sandbox run_queue: every column the enqueue INSERT writes,
    // EXCEPT sandbox_id (the additive column the constructor must self-heal).
    raw.exec(
      `CREATE TABLE run_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, adw_id TEXT,
        adw_name TEXT, agent TEXT, request TEXT, config TEXT, status TEXT DEFAULT 'queued',
        requested_by TEXT, cancel_requested INTEGER DEFAULT 0, pid INTEGER, exit_code INTEGER,
        error TEXT, enqueued_at TEXT, claimed_at TEXT, started_at TEXT, ended_at TEXT)`,
    );
    raw.close();
    const adws = join(dir, 'adws');
    const c = new AtelierControl(p, adws, '/repo');
    // enqueue writes sandbox_id -> would throw if the column were missing
    expect(() => c.enqueue({ adw_name: 'adw_scout', request: 'x' })).not.toThrow();
    c.close();
  });
});
