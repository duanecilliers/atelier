/**
 * Static seam-drift guard - the complement to check-contract.ts.
 *
 * check-contract.ts asserts (one-directionally, against a LIVE db) that every
 * column the cockpit expects exists. This script closes the gaps it can't:
 *   1. BIDIRECTIONAL column-set parity between the ENGINE schema (tracer.py
 *      SCHEMA + queue/sandboxes/workers DDL + MIGRATIONS) and the cockpit's
 *      TABLE_COLUMNS - so a column added on EITHER side that the other lacks
 *      fails here, with no db required (CI-friendly).
 *   2. The cockpit's write-side DDL mirror (control.ts) vs the authoritative
 *      engine DDL for the two control tables it re-declares. control.ts is a
 *      hand-copied mirror of queue.py/sandboxes.py; it is checked SEPARATELY,
 *      not folded into the engine set - folding it in would let the mirror and
 *      the engine drift together undetected (a dropped engine column masked by
 *      control.ts still declaring it).
 *   3. The two hand-maintained migration lists agree: tracer.py MIGRATIONS vs
 *      check-contract.ts MIGRATION_COLUMNS.
 *
 * Pure text parse of the source files - no live db. The core is exported as
 * `checkSchemaTypes(repoRoot)` so scripts/check-parity.test.ts can point it at a
 * fixture with injected drift and prove it still bites. Repo root is derived from
 * this file's own location, not cwd, so it resolves the same sources from anywhere.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argv } from 'node:process';
import { TABLE_COLUMNS } from '../lib/schemas';

const DEFAULT_REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const CONSTRAINTS = /^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)$/i;

/** Column names from every `CREATE TABLE [IF NOT EXISTS] name ( ... );` in `src`. */
function parseCreateTables(src: string): Record<string, string[]> {
  // Strip SQL line-comments FIRST: a `);` inside a comment (e.g. run_queue's
  // "(sandboxes.id); NULL = ...") would otherwise truncate the CREATE TABLE body.
  const clean = src.replace(/--[^\n]*/g, '');
  const out: Record<string, string[]> = {};
  const re = /CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\(([\s\S]*?)\)\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const cols: string[] = [];
    // Split the body on TOP-LEVEL commas (depth 0) so multi-column lines
    // ("started_at TEXT, ended_at TEXT") each yield a column, while a
    // "PRIMARY KEY (adw_id, agent)" constraint's inner comma does not split.
    let depth = 0;
    let buf = '';
    const defs: string[] = [];
    for (const ch of m[2]!) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) {
        defs.push(buf);
        buf = '';
      } else buf += ch;
    }
    defs.push(buf);
    for (const d of defs) {
      const col = d.trim().match(/^([a-z_][a-z0-9_]*)\b/i);
      if (col && !CONSTRAINTS.test(col[1]!)) cols.push(col[1]!);
    }
    out[m[1]!] = cols;
  }
  return out;
}

/** (table, column) pairs from tracer.py's MIGRATIONS list. */
function parseMigrations(src: string): Set<string> {
  const set = new Set<string>();
  const block = src.match(/MIGRATIONS\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? '';
  for (const m of block.matchAll(/\(\s*"(\w+)"\s*,\s*"(\w+)"\s*,/g)) set.add(`${m[1]}.${m[2]}`);
  return set;
}

/** MIGRATION_COLUMNS from check-contract.ts as (table, column) pairs. */
function parseMigrationColumns(src: string): Set<string> {
  const set = new Set<string>();
  const block = src.match(/MIGRATION_COLUMNS[^{]*\{([\s\S]*?)\n\};/)?.[1] ?? '';
  for (const line of block.matchAll(/(\w+):\s*new Set\(\[([^\]]*)\]\)/g)) {
    for (const c of line[2]!.matchAll(/'([^']+)'/g)) set.add(`${line[1]}.${c[1]}`);
  }
  return set;
}

export interface SchemaTypesResult {
  problems: string[];
  tables: number;
  migrations: number;
}

export function checkSchemaTypes(repo: string = DEFAULT_REPO): SchemaTypesResult {
  const read = (rel: string) => readFileSync(resolve(repo, rel), 'utf8');
  const problems: string[] = [];

  // ── 1. Engine schema (engine sources + migrations) vs cockpit TABLE_COLUMNS ──
  // NOTE: control.ts is deliberately NOT in this list - it is a cockpit mirror,
  // not engine schema, and is checked against the engine in step 2 instead.
  const engine: Record<string, Set<string>> = {};
  for (const f of [
    'engine/adws/adw_modules/tracer.py',
    'engine/adws/adw_modules/queue.py',
    'engine/adws/adw_modules/sandboxes.py',
    'engine/adws/adw_modules/workers.py',
  ]) {
    for (const [t, cols] of Object.entries(parseCreateTables(read(f)))) {
      engine[t] = new Set([...(engine[t] ?? []), ...cols]);
    }
  }
  const migrations = parseMigrations(read('engine/adws/adw_modules/tracer.py'));
  for (const tc of migrations) {
    const [t, c] = tc.split('.');
    (engine[t!] ??= new Set()).add(c!);
  }

  for (const [table, cockpitCols] of Object.entries(TABLE_COLUMNS)) {
    const eng = engine[table];
    if (!eng) {
      problems.push(`table '${table}' is in cockpit TABLE_COLUMNS but no engine DDL defines it`);
      continue;
    }
    const cockpit = new Set(cockpitCols as readonly string[]);
    for (const c of cockpit) if (!eng.has(c)) problems.push(`${table}.${c}: cockpit expects it, engine schema lacks it`);
    for (const c of eng) if (!cockpit.has(c)) problems.push(`${table}.${c}: engine schema has it, cockpit mirror lacks it`);
  }

  // ── 2. control.ts write-side DDL mirror vs the authoritative engine DDL ───────
  // control.ts re-declares run_queue + sandboxes so the cockpit can INSERT before
  // the worker exists. Those must match the engine table (CREATE + MIGRATIONS)
  // column-for-column, or the cockpit writes a row the engine reader can't parse.
  const control = parseCreateTables(read('cockpit/lib/control.ts'));
  for (const [table, controlCols] of Object.entries(control)) {
    const eng = engine[table];
    if (!eng) {
      problems.push(`table '${table}' is declared in control.ts but no engine DDL defines it`);
      continue;
    }
    const ctl = new Set(controlCols);
    for (const c of ctl) if (!eng.has(c)) problems.push(`${table}.${c}: control.ts declares it, engine schema lacks it`);
    for (const c of eng) if (!ctl.has(c)) problems.push(`${table}.${c}: engine schema has it, control.ts mirror lacks it`);
  }

  // ── 3. tracer.py MIGRATIONS  vs  check-contract.ts MIGRATION_COLUMNS ──────────
  const migCols = parseMigrationColumns(read('cockpit/scripts/check-contract.ts'));
  for (const m of migrations) if (!migCols.has(m)) problems.push(`migration ${m}: in tracer.py MIGRATIONS, missing from check-contract MIGRATION_COLUMNS`);
  for (const m of migCols) if (!migrations.has(m)) problems.push(`migration ${m}: in check-contract MIGRATION_COLUMNS, missing from tracer.py MIGRATIONS`);

  return { problems, tables: Object.keys(TABLE_COLUMNS).length, migrations: migrations.size };
}

// ── CLI (only when run directly, not when imported by the test) ───────────────
const invokedDirectly = !!argv[1] && realpathSync(argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const { problems, tables, migrations } = checkSchemaTypes();
  if (problems.length) {
    console.error('✗ schema-type parity FAILED:\n' + problems.map((p) => `  - ${p}`).join('\n'));
    process.exit(1);
  }
  console.log(`✓ schema parity holds (${tables} tables, ${migrations} migrations)`);
}
