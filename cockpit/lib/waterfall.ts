import { tsMs } from '@/lib/format';
import type { Phase } from '@/lib/types';

/**
 * Waterfall block geometry - the run read as a shape in time.
 *
 * Phases lay on a shared, proportional time axis. Two adjustments keep it
 * readable: a MIN_BLOCK floor so a 200ms phase stays clickable, and an
 * anti-overlap shift so blocks widened by that floor don't collide.
 *
 * The shift is applied PER LANE (agent phases grouped by owner; code phases
 * together), never globally. That is the whole point: two phases in DIFFERENT
 * lanes may share the same x-range, so a fan-out (three reviewers that started at
 * the same instant) renders as three blocks stacked at the same x - concurrent -
 * instead of a staircase. A sequential run has one phase per lane at each step,
 * so every block still sits at its true proportional position.
 *
 * Geometry originally ported from SSSF's SessionTrace.vue, which only ever drew
 * sequential runs and so shifted globally; per-lane grouping is the correction
 * that makes concurrency legible.
 */

export const MIN_BLOCK_PCT = 4;

export interface Box {
  left: number;
  width: number;
}

type LayoutPhase = Pick<Phase, 'phase_id' | 'kind' | 'owner' | 'started_at' | 'ended_at' | 'status'>;

function laneKey(p: LayoutPhase): string {
  return p.kind === 'code' ? 'code' : `agent:${p.owner ?? ''}`;
}

export function waterfallLayout(
  phases: LayoutPhase[],
  opts: { zone: number; originMs: number; postSpan: number; nowMs: number },
): Record<string, Box> {
  const { zone, originMs, postSpan, nowMs } = opts;
  const avail = 100 - zone - 0.4;

  // Group the timed, non-engineer phases into lanes. Collision is resolved
  // within a lane only - cross-lane blocks may overlap in x (different rows).
  const byLane = new Map<string, LayoutPhase[]>();
  for (const p of phases) {
    if (p.kind === 'engineer' || !Number.isFinite(tsMs(p.started_at))) continue;
    const key = laneKey(p);
    let arr = byLane.get(key);
    if (!arr) {
      arr = [];
      byLane.set(key, arr);
    }
    arr.push(p);
  }

  const pre: Record<string, Box> = {};
  let maxEdge = avail; // the axis never shrinks below the full track
  for (const lanePhases of byLane.values()) {
    const timed = lanePhases
      .map((p) => {
        const start = tsMs(p.started_at);
        let end = tsMs(p.ended_at);
        if (!Number.isFinite(end)) end = p.status === 'running' ? nowMs : start;
        return {
          id: p.phase_id,
          start,
          left: ((start - originMs) / postSpan) * avail,
          width: ((Math.max(end, start) - start) / postSpan) * avail,
        };
      })
      .sort((a, b) => a.start - b.start);

    let shift = 0;
    let prevEdge = 0;
    for (const b of timed) {
      let left = b.left + shift;
      if (left < prevEdge) {
        shift += prevEdge - left;
        left = prevEdge;
      }
      const width = Math.max(b.width, MIN_BLOCK_PCT);
      shift += width - b.width;
      prevEdge = left + width;
      pre[b.id] = { left, width };
      maxEdge = Math.max(maxEdge, prevEdge);
    }
  }

  // One global scale so the shared axis stays consistent across lanes.
  const scale = avail / Math.max(maxEdge, avail);
  const out: Record<string, Box> = {};
  for (const id in pre) {
    const b = pre[id]!;
    out[id] = { left: zone + b.left * scale, width: b.width * scale };
  }
  return out;
}
