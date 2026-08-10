import { describe, expect, it } from 'vitest';
import { parseRecipe } from '@/lib/skills';

// parseRecipe drives the /skills cookbook. It exercises the private splitSteps
// (depth-tracking so a bounded-loop group stays one step) and parseAgents
// (REQUIRED_AGENTS in its three shapes). The real ADW docstring titles use a
// U+2014 em-dash, which parseRecipe's title regex requires; we produce it via an
// escape so there's no literal em-dash in this source.
const EMDASH = '\u2014';

function src(opts: { title?: string; phases: string; required?: string }): string {
  const title = opts.title ?? `ADW Foo ${EMDASH} a one-line tagline`;
  const req = opts.required ? `\n${opts.required}\n` : '\n';
  return `"""${title}\n\nPhases: ${opts.phases}\n\nWhy this exists.\n"""${req}`;
}

describe('parseRecipe title', () => {
  it('parses name + tagline from an em-dash title', () => {
    const r = parseRecipe('adw_foo.py', src({ phases: 'engineer(request) -> planner' }));
    expect(r.name).toBe('Foo');
    expect(r.tagline).toBe('a one-line tagline');
  });

  it('falls back to the id-derived name when the title has no em-dash', () => {
    const r = parseRecipe('adw_plan_build.py', src({ title: 'ADW plain title', phases: 'a -> b' }));
    expect(r.name).toBe('plan build');
    expect(r.tagline).toBe('');
  });
});

describe('parseRecipe steps (splitSteps)', () => {
  it('keeps a bounded-loop group intact as one step', () => {
    const phases =
      'engineer(request) -> planner -> code(test) [-> builder(fix) -> code(test) ... bounded] -> git(commit)';
    const r = parseRecipe('adw_x.py', src({ phases }));
    expect(r.steps).toHaveLength(4);
    // the bracketed group is a single step, inner arrows not split out
    expect(r.steps.some((s) => s.includes('bounded'))).toBe(true);
    expect(r.steps[0]).toBe('engineer(request)');
    expect(r.steps.at(-1)).toBe('git(commit)');
  });
});

describe('parseRecipe agents (REQUIRED_AGENTS)', () => {
  it('parses a populated list', () => {
    const r = parseRecipe('adw_x.py', src({ phases: 'a -> b', required: 'REQUIRED_AGENTS = ["planner", "builder"]' }));
    expect(r.agents).toEqual(['planner', 'builder']);
  });

  it('parses an empty typed list as [] (deterministic recipe)', () => {
    const r = parseRecipe('adw_x.py', src({ phases: 'a -> b', required: 'REQUIRED_AGENTS: list[str] = []' }));
    expect(r.agents).toEqual([]);
  });

  it('is null when absent (roster chosen per run)', () => {
    const r = parseRecipe('adw_x.py', src({ phases: 'a -> b' }));
    expect(r.agents).toBeNull();
  });
});
