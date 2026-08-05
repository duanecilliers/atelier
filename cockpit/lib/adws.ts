/**
 * Client-safe ADW helpers for the launcher — the light NL→ADW inference and the
 * agent roster for adw_prompt's `--agent`.
 *
 * The launchable catalog and the enqueue allowlist are BOTH read live from disk
 * now (Phase 4): the queue page builds the launcher menu from `readRecipes()` and
 * `lib/control.ts` validates enqueue against `readAdwNames()` — the same on-disk
 * rule the worker re-checks. So a cockpit-built ADW is launchable at once. This
 * module stays free of `node:fs` on purpose: QueueLauncher is a client component.
 */

/** One entry in the launcher's ADW menu (built from a Recipe on the server). */
export interface AdwSpec {
  /** Script stem in engine/adws/, e.g. "adw_scout". Becomes the worker's argv. */
  name: string;
  label: string;
  blurb: string;
  /** True only for adw_prompt — the one ADW that takes a --agent. */
  usesAgent: boolean;
}

/**
 * The roster from sssf.config.yaml. Only adw_prompt uses it (to pick which agent
 * answers). Kept in sync with the config by hand until the Phase 4 roster editor.
 */
export const AGENT_ROSTER = ['scout', 'planner', 'builder', 'reviewer', 'documenter'] as const;
export type AgentName = (typeof AGENT_ROSTER)[number];

/**
 * The light-NL launcher: map a free-text ask to an ADW. Deliberately simple and
 * transparent (the operator sees and can override the pick) — recon-shaped asks
 * scout, "plan"-only asks plan, test/review asks run the longer chains, and the
 * default for "do X" is plan + build.
 */
export function inferAdw(text: string): string {
  const t = text.toLowerCase();
  const buildish = /\b(build|implement|add|fix|create|write|refactor|wire|make)\b/.test(t);
  if (/\b(scout|recon|investigate|explore|where|how does|explain|understand|audit|inspect)\b/.test(t) && !buildish) {
    return 'adw_scout';
  }
  if (/\b(review|document|docs|full sdlc|ship it)\b/.test(t)) return 'adw_simple_sdlc';
  if (/\b(test|sdlc)\b/.test(t)) return 'adw_plan_build_test';
  if (/\bplan\b/.test(t) && !buildish) return 'adw_plan';
  return 'adw_plan_build';
}
