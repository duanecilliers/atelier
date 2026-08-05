/**
 * The review seam — the cockpit's second (and last) write surface.
 *
 * Isolated from BOTH the readonly reader (lib/db.ts, AtelierDb) and the
 * run_queue control (lib/control.ts, AtelierControl, which documents itself as
 * touching only run_queue). This connection writes exactly ONE column —
 * `sessions.archived` — which the engine schema explicitly reserves for the UI:
 *
 *   archived  INTEGER DEFAULT 0   -- review triage, set by the UI; never by a run
 *
 * Archiving is reader state living on the row: it records that a human has
 * triaged a run out of the review list. It never touches a run's trace or
 * acceptance (sessions.status, phases, events, envelopes, gates), so it does not
 * belong to the control plane and cannot be issued by the readonly reader. The
 * read path (AtelierDb.sessions / recentAdwIds) already filters `archived = 0`;
 * this is the only place that sets it.
 */
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { resolveDbPath } from './db';

export class AtelierReview {
  private readonly db: Database.Database;
  /** False on an older db predating the archived migration — the writer no-ops. */
  readonly canArchive: boolean;

  constructor(path: string) {
    if (!existsSync(path)) {
      throw new Error(
        `sssf.db not found at ${path} — run an ADW in the engine (or set SSSF_DB) ` +
          `so the db exists before archiving.`,
      );
    }
    this.db = new Database(path);
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = NORMAL');
    const cols = this.db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
    this.canArchive = cols.some((c) => c.name === 'archived');
  }

  close(): void {
    this.db.close();
  }

  /**
   * Set (or clear) a session's archived flag. Returns true if a row changed;
   * false if the adw_id is unknown. Throws if the column is absent (older db) so
   * the route can surface an honest "not supported here" rather than silently
   * doing nothing.
   */
  setArchived(adwId: string, archived: boolean): boolean {
    if (!this.canArchive) {
      throw new Error('this db predates the archived column — run the engine once to migrate it');
    }
    const info = this.db
      .prepare('UPDATE sessions SET archived = ? WHERE adw_id = ?')
      .run(archived ? 1 : 0, adwId);
    return info.changes > 0;
  }
}

const globalForReview = globalThis as unknown as { __atelierReview?: AtelierReview };

/** Memoized review connection, mirroring getDb()/getControl()'s HMR-safe singleton. */
export function getReview(): AtelierReview {
  if (!globalForReview.__atelierReview) {
    globalForReview.__atelierReview = new AtelierReview(resolveDbPath());
  }
  return globalForReview.__atelierReview;
}
