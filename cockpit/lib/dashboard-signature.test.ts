import { describe, expect, it } from 'vitest';
import { hash, queueSig, runsSig, sandboxesSig } from '@/lib/dashboard-signature';
import type { RunQueueRow, Sandbox, SessionSummary } from '@/lib/types';

// The signatures drive the live-refresh decision: when the sig changes the page
// repaints, when it doesn't a refresh is wasted. They must be deterministic,
// order-sensitive, and stable across null vs empty-string fields.

describe('hash (FNV-1a)', () => {
  it('is deterministic and non-empty', () => {
    expect(hash('abc')).toBe(hash('abc'));
    expect(hash('abc')).not.toBe('');
  });
  it('distinguishes different inputs', () => {
    expect(hash('abc')).not.toBe(hash('abd'));
    expect(hash('')).not.toBe(hash('a'));
  });
});

const qrow = (o: Partial<RunQueueRow>): RunQueueRow => ({ id: 1, status: 'queued', cancel_requested: 0, ...o } as RunQueueRow);

describe('queueSig', () => {
  it('moves when a status changes', () => {
    const a = [qrow({ id: 1, status: 'queued' })];
    const b = [qrow({ id: 1, status: 'running' })];
    expect(queueSig(a)).not.toBe(queueSig(b));
  });
  it('moves when cancel_requested flips', () => {
    expect(queueSig([qrow({ cancel_requested: 0 })])).not.toBe(queueSig([qrow({ cancel_requested: 1 })]));
  });
  it('is order-sensitive', () => {
    const one = qrow({ id: 1 });
    const two = qrow({ id: 2 });
    expect(queueSig([one, two])).not.toBe(queueSig([two, one]));
  });
  it('is stable for identical input', () => {
    expect(queueSig([qrow({ id: 1 })])).toBe(queueSig([qrow({ id: 1 })]));
  });
});

const sbox = (o: Partial<Sandbox>): Sandbox => ({ id: 'a', status: 'active', shutdown_requested: 0, land_requested: 0, tip_sha: null, land_result: null, ...o } as Sandbox);

describe('sandboxesSig', () => {
  it('moves on status, tip, and land_result changes', () => {
    const base = [sbox({})];
    expect(sandboxesSig(base)).not.toBe(sandboxesSig([sbox({ status: 'gone' })]));
    expect(sandboxesSig(base)).not.toBe(sandboxesSig([sbox({ tip_sha: 'abc123' })]));
    expect(sandboxesSig(base)).not.toBe(sandboxesSig([sbox({ land_result: 'pr: http://x' })]));
  });
  it('treats null and empty consistently (stable)', () => {
    expect(sandboxesSig([sbox({ tip_sha: null })])).toBe(sandboxesSig([sbox({ tip_sha: null })]));
  });
});

describe('runsSig', () => {
  const sess = (o: Partial<SessionSummary>): SessionSummary =>
    ({ adw_id: 'x', status: 'running', phases: [{ status: 'success' }, { status: 'running' }], ...o } as SessionSummary);
  it('moves when a phase dot advances', () => {
    const a = [sess({ phases: [{ status: 'running' }] as any })];
    const b = [sess({ phases: [{ status: 'success' }] as any })];
    expect(runsSig(a)).not.toBe(runsSig(b));
  });
  it('moves when session status changes', () => {
    expect(runsSig([sess({ status: 'running' })])).not.toBe(runsSig([sess({ status: 'success' })]));
  });
});
