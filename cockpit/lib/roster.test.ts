import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SANDBOX_BRANCH_TEMPLATE,
  addAgent,
  readRoster,
  removeAgent,
  RosterInputError,
  sandboxBranchTemplate,
  sandboxLaunchOptions,
  writeRoster,
  type SandboxConfig,
} from '@/lib/roster';

// Pure view helpers over a project's `sandbox:` block (fixture-backed splice
// round-trips live below in Phase 2). We construct plain objects matching the
// SandboxConfig shape.
const cfg = (o: Partial<SandboxConfig>): SandboxConfig => ({ default: 'local', ...o } as SandboxConfig);

describe('sandboxLaunchOptions', () => {
  it('offers only worktree (L1) when no worktree_env profile is declared', () => {
    const opts = sandboxLaunchOptions(cfg({}));
    expect(opts.levels.map((l) => l.level)).toEqual(['worktree']);
    expect(opts.defaultLevel).toBe('worktree'); // local is never offered -> fallback
  });

  it('offers worktree_env when its profile is declared', () => {
    const opts = sandboxLaunchOptions(cfg({ worktree_env: { branch: 'feat/${SANDBOX_ID}' } as any }));
    expect(opts.levels.map((l) => l.level)).toEqual(['worktree', 'worktree_env']);
  });

  it('preselects sandbox.default when it is an offered level', () => {
    const opts = sandboxLaunchOptions(cfg({ default: 'worktree_env', worktree_env: {} as any }));
    expect(opts.defaultLevel).toBe('worktree_env');
  });

  it('falls back to worktree when default is not offerable', () => {
    const opts = sandboxLaunchOptions(cfg({ default: 'worktree_env' })); // no profile -> not offered
    expect(opts.defaultLevel).toBe('worktree');
  });

  it('surfaces the level branch template, else the engine default', () => {
    const opts = sandboxLaunchOptions(cfg({ worktree: { branch: 'sbx/${SANDBOX_ID}' } as any }));
    expect(opts.levels[0]!.branchTemplate).toBe('sbx/${SANDBOX_ID}');
  });
});

describe('sandboxBranchTemplate', () => {
  it('returns the level profile branch', () => {
    const c = cfg({ worktree_env: { branch: 'feat/${SANDBOX_ID}' } as any });
    expect(sandboxBranchTemplate(c, 'worktree_env')).toBe('feat/${SANDBOX_ID}');
  });
  it('falls back to the engine default for an unconfigured or unknown level', () => {
    expect(sandboxBranchTemplate(cfg({}), 'worktree')).toBe(DEFAULT_SANDBOX_BRANCH_TEMPLATE);
    expect(sandboxBranchTemplate(cfg({}), 'container')).toBe(DEFAULT_SANDBOX_BRANCH_TEMPLATE);
  });
});

// ── Surgical YAML splicing (tmp config file) ──────────────────────────────────
// The most bug-prone file in the repo: byte-level edits that must preserve every
// comment. We round-trip real edits and assert the load-bearing comments survive.
const FIXTURE = `# The factory roster - these comments must survive edits.
defaults:
  coding_agent: pi
  model: openai-codex/old-model
  thinking: medium                 # the default thinking budget

agents:
  # the planner leads the chain
  - name: planner
    model: anthropic/claude-fable-5
    purpose: Plan the work.
    prompt_engineering:
      system: pe/planner/system.md
      user: pe/planner/user.md
  - name: builder
    purpose: Build it.
    prompt_engineering:
      system: pe/builder/system.md
      user: pe/builder/user.md
`;

describe('roster surgical writes', () => {
  let dir: string;
  let cfg: string;
  let peDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atelier-roster-'));
    cfg = join(dir, 'sssf.config.yaml');
    peDir = join(dir, 'pe');
    writeFileSync(cfg, FIXTURE);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writeRoster changes one value and preserves comments', () => {
    writeRoster({ defaults: { thinking: 'high' } }, cfg);
    const after = readFileSync(cfg, 'utf8');
    expect(readRoster(cfg).defaults.thinking).toBe('high');
    // comments intact, old value gone
    expect(after).toContain('# The factory roster');
    expect(after).toContain('# the default thinking budget');
    expect(after).toContain('# the planner leads the chain');
    expect(after).not.toContain('thinking: medium');
  });

  it('addAgent appends an entry, bootstraps prompt files, keeps existing agents', () => {
    addAgent({ name: 'reviewer', model: 'openai-codex/x', purpose: 'Review it.' }, cfg, peDir, 'pe');
    const roster = readRoster(cfg);
    expect(roster.agents.map((a) => a.name)).toEqual(['planner', 'builder', 'reviewer']);
    // the two prompt files exist on disk
    expect(readFileSync(join(peDir, 'reviewer', 'system.md'), 'utf8')).toBeTruthy();
    expect(readFileSync(join(peDir, 'reviewer', 'user.md'), 'utf8')).toBeTruthy();
    // a new agent starts read-only (writes: [])
    const reviewer = roster.agents.find((a) => a.name === 'reviewer')!;
    expect(reviewer.writes).toEqual([]);
    // existing comments preserved
    expect(readFileSync(cfg, 'utf8')).toContain('# the planner leads the chain');
  });

  it('addAgent rejects a duplicate name', () => {
    expect(() => addAgent({ name: 'planner' }, cfg, peDir, 'pe')).toThrow();
  });

  it('removeAgent splices an entry out and preserves the rest', () => {
    removeAgent('builder', cfg);
    expect(readRoster(cfg).agents.map((a) => a.name)).toEqual(['planner']);
    expect(readFileSync(cfg, 'utf8')).toContain('# the planner leads the chain');
  });

  it('removeAgent refuses the last agent', () => {
    removeAgent('builder', cfg);
    expect(() => removeAgent('planner', cfg)).toThrow(RosterInputError);
  });

  it('removeAgent rejects an unknown name', () => {
    expect(() => removeAgent('ghost', cfg)).toThrow(RosterInputError);
  });
});
