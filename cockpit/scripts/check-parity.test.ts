import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkRosterMirror } from './check-roster-mirror';
import { checkSchemaTypes } from './check-schema-types';

// The two static seam guards are the crown jewels - hand-kept mirrors they alone
// defend. But they are regex/brace parsers, so a parser regression could silently
// stop them biting. These tests pin BOTH directions: they still hold on the real
// repo (a parse regression -> "could not parse" -> red), AND they still fail on a
// concrete injected drift (a blindness regression -> no problem raised -> red).

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Stage a throwaway repo containing just `files` (real copies at their real
 *  relative paths), optionally mutating one file's text in place. */
function stageRepo(files: string[], mutate?: { rel: string; fn: (s: string) => string }): string {
  const root = mkdtempSync(join(tmpdir(), 'atelier-parity-'));
  for (const rel of files) {
    const dst = join(root, rel);
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(join(REPO, rel), dst);
  }
  if (mutate) {
    const p = join(root, mutate.rel);
    const before = readFileSync(p, 'utf8');
    const after = mutate.fn(before);
    expect(after, `mutation of ${mutate.rel} changed nothing - the test would be vacuous`).not.toBe(before);
    writeFileSync(p, after);
  }
  return root;
}

const ROSTER_FILES = [
  'engine/adws/adw_modules/data_types.py',
  'cockpit/lib/roster.ts',
  'cockpit/lib/roster-constants.ts',
];
const SCHEMA_FILES = [
  'engine/adws/adw_modules/tracer.py',
  'engine/adws/adw_modules/queue.py',
  'engine/adws/adw_modules/sandboxes.py',
  'engine/adws/adw_modules/workers.py',
  'cockpit/lib/control.ts',
  'cockpit/scripts/check-contract.ts',
];

let dirs: string[] = [];
beforeEach(() => (dirs = []));
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const stage = (...a: Parameters<typeof stageRepo>): string => {
  const d = stageRepo(...a);
  dirs.push(d);
  return d;
};

describe('checkRosterMirror', () => {
  it('holds on the real repo', () => {
    const { problems, models, enums } = checkRosterMirror();
    expect(problems, problems.join('\n')).toEqual([]);
    expect(models).toBeGreaterThan(0);
    expect(enums).toBeGreaterThan(0);
  });

  it('bites when a Pydantic field has no Zod mirror', () => {
    // Inject a field into AgentConfig that AgentConfigSchema does not have.
    const repo = stage(ROSTER_FILES, {
      rel: 'engine/adws/adw_modules/data_types.py',
      fn: (s) => s.replace('class AgentConfig(BaseModel):\n', 'class AgentConfig(BaseModel):\n    injected_drift_field: str = ""\n'),
    });
    const { problems } = checkRosterMirror(repo);
    expect(problems.some((p) => p.includes('injected_drift_field'))).toBe(true);
  });

  it('bites when an enum value drifts', () => {
    // Drop a coding_agent literal on the Python side only.
    const repo = stage(ROSTER_FILES, {
      rel: 'engine/adws/adw_modules/data_types.py',
      fn: (s) => s.replaceAll('Literal["pi", "claude_code"]', 'Literal["pi"]'),
    });
    const { problems } = checkRosterMirror(repo);
    expect(problems.some((p) => p.includes('coding_agent') && p.includes('claude_code'))).toBe(true);
  });
});

describe('checkSchemaTypes', () => {
  it('holds on the real repo', () => {
    const { problems, tables, migrations } = checkSchemaTypes();
    expect(problems, problems.join('\n')).toEqual([]);
    expect(tables).toBeGreaterThan(0);
    expect(migrations).toBeGreaterThan(0);
  });

  it('bites when the engine gains a column the cockpit lacks', () => {
    // Add a column to sessions (a table TABLE_COLUMNS mirrors) in tracer.py only.
    const repo = stage(SCHEMA_FILES, {
      rel: 'engine/adws/adw_modules/tracer.py',
      fn: (s) => s.replace('CREATE TABLE IF NOT EXISTS sessions (\n', 'CREATE TABLE IF NOT EXISTS sessions (\n  zzz_injected TEXT,\n'),
    });
    const { problems } = checkSchemaTypes(repo);
    expect(problems.some((p) => p.includes('zzz_injected'))).toBe(true);
  });

  it('bites when control.ts drifts from the engine DDL (no longer masked)', () => {
    // Remove a column from control.ts's sandboxes mirror. The engine still has it,
    // so the separate control<->engine check must flag it (the union used to hide this).
    const repo = stage(SCHEMA_FILES, {
      rel: 'cockpit/lib/control.ts',
      fn: (s) => s.replace(/^\s*land_result\s+TEXT,\n/m, ''),
    });
    const { problems } = checkSchemaTypes(repo);
    expect(problems.some((p) => p.includes('land_result') && p.includes('control.ts'))).toBe(true);
  });
});
