/**
 * getDb() — one readonly AtelierDb over the shared sssf.db, memoized.
 *
 * Cached on globalThis so Next's dev HMR (which re-evaluates modules on edit)
 * reuses a single connection instead of leaking one per reload. The path comes
 * from SSSF_DB (see .env.local) — the same env the engine's data_dir resolves to.
 */
import { AtelierDb, resolveDbPath } from './db';

const globalForDb = globalThis as unknown as { __atelierDb?: AtelierDb };

export function getDb(): AtelierDb {
  if (!globalForDb.__atelierDb) {
    globalForDb.__atelierDb = new AtelierDb(resolveDbPath());
  }
  return globalForDb.__atelierDb;
}
