/**
 * The launchable ADW catalog + roster — what the cockpit is allowed to enqueue.
 *
 * This is an allowlist by construction: an enqueue whose adw_name is not in
 * ADW_NAMES is rejected before it ever reaches the db, and the worker validates
 * the name a second time against the actual scripts on disk. Mirrors the ADWs
 * exposed in the engine justfile; Phase 4's roster editor will make it dynamic.
 */

export interface AdwSpec {
  /** Script stem in engine/adws/, e.g. "adw_scout". Becomes the worker's argv. */
  name: string;
  label: string;
  blurb: string;
  /** True only for adw_prompt — the one ADW that takes a --agent. */
  usesAgent: boolean;
}

export const ADW_CATALOG: readonly AdwSpec[] = [
  { name: 'adw_prompt', label: 'Prompt', blurb: 'One agent, one prompt — the smallest run.', usesAgent: true },
  { name: 'adw_scout', label: 'Scout', blurb: 'Read-only recon. Changes nothing.', usesAgent: false },
  { name: 'adw_plan', label: 'Plan', blurb: 'Planner drafts a plan; nothing is built.', usesAgent: false },
  { name: 'adw_plan_build', label: 'Plan + Build', blurb: 'Plan, build, commit.', usesAgent: false },
  { name: 'adw_plan_build_test', label: 'SDLC', blurb: 'Plan, build, test, commit.', usesAgent: false },
  { name: 'adw_simple_sdlc', label: 'Full SDLC', blurb: 'Plan, build, test, review, document.', usesAgent: false },
] as const;

export const ADW_NAMES: ReadonlySet<string> = new Set(ADW_CATALOG.map((a) => a.name));

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
