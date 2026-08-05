/**
 * Seam contract check — the guard against Python↔TS schema drift.
 *
 * Opens the live sssf.db and, for every table in TABLE_COLUMNS, asserts each
 * column the cockpit expects actually exists (PRAGMA table_info). Migration-added
 * columns may legitimately be absent on an old db, so those are reported as a
 * warning, never a failure — matching lib/db.ts's optionalColumn() tolerance.
 *
 * Run: `pnpm check:contract`  (exits non-zero on a hard mismatch, for CI).
 */
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { TABLE_COLUMNS } from '../lib/schemas';

// Columns tracer.py adds by additive migration — absent on an old db, not drift.
const MIGRATION_COLUMNS: Record<string, Set<string>> = {
  sessions: new Set(['adw_name', 'archived']),
  gate_results: new Set(['checks_json']),
  agent_sessions: new Set(['color', 'context_tokens', 'context_window']),
};

function dbPath(): string {
  const raw = process.env.SSSF_DB ?? '../engine/adws/adw_data/sssf.db';
  return resolve(process.cwd(), raw);
}

function main(): number {
  const path = dbPath();
  if (!existsSync(path)) {
    console.error(`✗ sssf.db not found at ${path}\n  Set SSSF_DB or run an ADW in ../engine first.`);
    return 1;
  }
  const db = new Database(path, { readonly: true });
  const tables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name),
  );

  let hardFail = 0;
  let warnings = 0;

  for (const [table, columns] of Object.entries(TABLE_COLUMNS)) {
    if (!tables.has(table)) {
      console.error(`✗ table '${table}' missing from db`);
      hardFail++;
      continue;
    }
    const live = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c: any) => c.name));
    const missing = columns.filter((c) => !live.has(c));
    for (const col of missing) {
      if (MIGRATION_COLUMNS[table]?.has(col)) {
        console.warn(`  ~ ${table}.${col} absent (migration-added; ok on an older db)`);
        warnings++;
      } else {
        console.error(`✗ ${table}.${col} expected by the cockpit but missing from db`);
        hardFail++;
      }
    }
    if (missing.length === 0) console.log(`✓ ${table} (${columns.length} cols)`);
  }

  db.close();
  console.log(
    `\n${hardFail === 0 ? '✓ contract holds' : `✗ ${hardFail} mismatch(es)`}` +
      `${warnings ? ` · ${warnings} migration warning(s)` : ''}`,
  );
  return hardFail === 0 ? 0 : 1;
}

process.exit(main());
