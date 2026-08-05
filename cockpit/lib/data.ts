/**
 * getDb(projectId) — one readonly AtelierDb per project, memoized.
 *
 * Cached on globalThis so Next's dev HMR (which re-evaluates modules on edit)
 * reuses connections instead of leaking one per reload. Multi-project (Part E):
 * the cockpit fronts several stamped repos, so connections are keyed by the
 * resolved db PATH (not the project id) — an env-fallback project and any id map
 * to the same path and therefore the same connection, and two ids that happen to
 * point at one db share too. `pathsForProject` (lib/projects.ts) turns the route
 * segment into that path.
 */
import { AtelierDb } from './db';
import { pathsForProject } from './projects';

const globalForDb = globalThis as unknown as { __atelierDbs?: Map<string, AtelierDb> };

export function getDb(projectId?: string): AtelierDb {
  const path = pathsForProject(projectId).dbPath;
  const map = (globalForDb.__atelierDbs ??= new Map<string, AtelierDb>());
  let db = map.get(path);
  if (!db) {
    db = new AtelierDb(path);
    map.set(path, db);
  }
  return db;
}
