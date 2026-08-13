import { describe, expect, it } from 'vitest';
import { MIN_BLOCK_PCT, waterfallLayout } from '@/lib/waterfall';
import type { Phase } from '@/lib/types';

// Seconds-from-epoch-ish ISO timestamps; only relative order/spacing matters.
function at(sec: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, sec)).toISOString();
}

function phase(over: Partial<Phase>): Phase {
  return {
    phase_id: 'p',
    adw_id: 'a',
    seq: 0,
    name: 'n',
    kind: 'agent',
    owner: 'x',
    description: '',
    status: 'success',
    attempt: 0,
    retries: 0,
    error: null,
    started_at: null,
    ended_at: null,
    ...over,
  } as Phase;
}

const OPTS = { zone: 14, nowMs: 0 };

describe('waterfallLayout', () => {
  it('renders a fan-out as concurrent: same start -> same x, different widths', () => {
    // Three reviewers, distinct owners (lanes), all starting at t=30s - the smoke's shape.
    const phases: Phase[] = [
      phase({ phase_id: 'build', owner: 'builder', started_at: at(0), ended_at: at(30) }),
      phase({ phase_id: 'r1', owner: 'pr_reviewer_1', started_at: at(30), ended_at: at(66) }),
      phase({ phase_id: 'r2', owner: 'pr_reviewer_2', started_at: at(30), ended_at: at(63) }),
      phase({ phase_id: 'r3', owner: 'pr_reviewer_3', started_at: at(30), ended_at: at(79) }),
      phase({ phase_id: 'synth', owner: 'synthesizer', started_at: at(79), ended_at: at(110) }),
    ];
    const box = waterfallLayout(phases, { ...OPTS, originMs: Date.parse(at(0)), postSpan: 110_000 });

    // All three reviewers begin at the SAME x - that is what "parallel" must look like.
    expect(box.r1!.left).toBeCloseTo(box.r2!.left, 5);
    expect(box.r2!.left).toBeCloseTo(box.r3!.left, 5);

    // Widths reflect real durations: r3 (49s) > r1 (36s) > r2 (33s).
    expect(box.r3!.width).toBeGreaterThan(box.r1!.width);
    expect(box.r1!.width).toBeGreaterThan(box.r2!.width);

    // The barrier holds: the builder is before the reviewers, the synthesizer after.
    expect(box.build!.left).toBeLessThan(box.r1!.left);
    expect(box.synth!.left).toBeGreaterThan(box.r3!.left);
  });

  it('keeps a sequential run a left-to-right staircase (one phase per lane)', () => {
    const phases: Phase[] = [
      phase({ phase_id: 'plan', owner: 'planner', started_at: at(0), ended_at: at(10) }),
      phase({ phase_id: 'build', owner: 'builder', started_at: at(10), ended_at: at(40) }),
      phase({ phase_id: 'review', owner: 'reviewer', started_at: at(40), ended_at: at(55) }),
    ];
    const box = waterfallLayout(phases, { ...OPTS, originMs: Date.parse(at(0)), postSpan: 55_000 });
    expect(box.plan!.left).toBeLessThan(box.build!.left);
    expect(box.build!.left).toBeLessThan(box.review!.left);
  });

  it('floors a tiny phase to MIN_BLOCK_PCT so it stays clickable', () => {
    const phases: Phase[] = [
      phase({ phase_id: 'commit', kind: 'code', owner: 'git', started_at: at(0), ended_at: at(0) }),
    ];
    const box = waterfallLayout(phases, { ...OPTS, originMs: Date.parse(at(0)), postSpan: 60_000 });
    // width is scaled by avail/maxEdge; assert it is at least the floored share.
    expect(box.commit!.width).toBeGreaterThan(MIN_BLOCK_PCT * 0.5);
  });

  it('sequential phases in ONE lane still avoid overlap after the min-block floor', () => {
    // Same owner runs build then a quick revise back-to-back - must not collide.
    const phases: Phase[] = [
      phase({ phase_id: 'build', owner: 'builder', started_at: at(0), ended_at: at(30) }),
      phase({ phase_id: 'revise', owner: 'builder', started_at: at(30), ended_at: at(30) }),
    ];
    const box = waterfallLayout(phases, { ...OPTS, originMs: Date.parse(at(0)), postSpan: 30_000 });
    expect(box.revise!.left).toBeGreaterThanOrEqual(box.build!.left + box.build!.width - 1e-6);
  });
});
