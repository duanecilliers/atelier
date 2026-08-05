/**
 * Compiled-prompt reader — the exact system + user prompts an agent was sent.
 *
 * Files are the raw record: the engine writes them to
 * `{sessionsDir}/{adw_id}/{agent}/prompts/{system,user}.md` (agents.py), and the
 * db keeps no copy. This reads them straight off disk for the run-detail phase
 * drill-down. Read-only, server-side only.
 *
 * Mirrors SSSF's `/api/sessions/:adw_id/agents/:agent/prompts` handler: the same
 * SAFE_SEGMENT guard and the same "absent file → null" contract (a prompt is
 * simply missing whenever the agent never ran in this session).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export interface CompiledPrompts {
  system: string | null;
  user: string | null;
}

// adw_id and agent name are path segments on disk — anything that isn't a plain
// identifier is rejected outright rather than sanitized.
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

export function isSafeSegment(value: string): boolean {
  return SAFE_SEGMENT.test(value) && value !== '.' && value !== '..';
}

export function readAgentPrompts(
  sessionsDir: string,
  adwId: string,
  agent: string,
): CompiledPrompts {
  if (!isSafeSegment(adwId) || !isSafeSegment(agent)) return { system: null, user: null };

  const dir = resolve(sessionsDir, adwId, agent, 'prompts');
  // Defense in depth: the segment check already forbids traversal.
  if (dir !== sessionsDir && !dir.startsWith(sessionsDir + sep)) return { system: null, user: null };

  const read = (name: string): string | null => {
    const file = join(dir, `${name}.md`);
    try {
      return existsSync(file) ? readFileSync(file, 'utf8') : null;
    } catch {
      return null;
    }
  };

  return { system: read('system'), user: read('user') };
}
