'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Label } from '@/components/terminal';
import { ContextBar } from '@/components/run/ContextBar';
import { ModelBadge } from '@/components/run/ModelBadge';
import { axisTicks, duration, fmtOffset, tsMs } from '@/lib/format';
import type { AgentSession, Event, Phase, PhaseKind } from '@/lib/types';

/**
 * The waterfall — the run read as a shape in time. Phases lay on a shared,
 * proportional time axis, grouped into lanes (engineer · code · one per agent
 * owner), with tool-call tick-marks inside each block. Clicking a block selects
 * its phase (?phase=…) to open the drill-down below; the selection is URL state
 * so it survives the live refresh and is shareable.
 *
 * Geometry ported from SSSF's SessionTrace.vue (reserved request-zone, min-block
 * floor, sequential-shift-then-normalize so a 200ms git commit stays readable and
 * nothing overlaps). Re-skinned to Monolith Signal: a block's color is its
 * STATUS (traffic-light rule), agent identity is a small swatch only, flat.
 */

const MIN_BLOCK_PCT = 4;
const REQ_ZONE_PCT = 14;

const KIND_LABEL: Record<PhaseKind, string> = { engineer: 'engineer', code: 'code', agent: 'agent' };

// Block border/background by STATUS — the same traffic-light mapping ProcessMap
// uses, so the two views read identically.
const BLOCK_STATUS: Record<string, string> = {
  success: 'border-[color-mix(in_oklab,var(--ok)_45%,var(--border))]',
  running:
    'border-[color-mix(in_oklab,var(--warn)_55%,var(--border))] bg-[color-mix(in_oklab,var(--warn)_10%,transparent)]',
  fail: 'border-[color-mix(in_oklab,var(--err)_55%,var(--border))] bg-[color-mix(in_oklab,var(--err)_9%,transparent)]',
  queued: 'border-dashed border-os-border-strong',
};

const GLYPH: Record<string, string> = { success: '✓', fail: '✗', running: '●', queued: '○' };

// Fallback identity swatches when an agent has no config color. Identity, not
// status — kept muted and used only as a tiny dot on the lane label.
const PALETTE = ['#7c8cff', '#4bb5c1', '#c58bd6', '#d0a24a', '#5aa6e0', '#9b8cff'];

interface Lane {
  id: string;
  label: string;
  kind: PhaseKind;
  color: string | null;
  model: string | null;
  ctxUsed: number | null;
  ctxWindow: number | null;
  phases: Phase[];
}

function payloadOk(json: string | null): boolean {
  if (!json) return true;
  try {
    const p = JSON.parse(json) as { ok?: boolean };
    return p.ok !== false;
  } catch {
    return true;
  }
}

export function Waterfall({
  adwId,
  phases,
  events,
  agents,
  sessionStatus,
  sessionStart,
  sessionEnd,
  selectedPhaseId,
}: {
  adwId: string;
  phases: Phase[];
  events: Event[];
  agents: AgentSession[];
  sessionStatus: string | null;
  sessionStart: string | null;
  sessionEnd: string | null;
  selectedPhaseId: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();

  const anyRunning = sessionStatus === 'running' || phases.some((p) => p.status === 'running');
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [anyRunning]);

  // ── Lanes ──────────────────────────────────────────────────────────────────
  const lanes = useMemo<Lane[]>(() => {
    const out: Lane[] = [];
    const eng = phases.filter((p) => p.kind === 'engineer');
    if (eng.length) {
      out.push({
        id: 'engineer',
        label: 'engineer',
        kind: 'engineer',
        color: null,
        model: null,
        ctxUsed: null,
        ctxWindow: null,
        phases: eng,
      });
    }
    const code = phases.filter((p) => p.kind === 'code');
    if (code.length) {
      out.push({
        id: 'code',
        label: 'code',
        kind: 'code',
        color: null,
        model: null,
        ctxUsed: null,
        ctxWindow: null,
        phases: code,
      });
    }
    const owners: string[] = [];
    for (const p of phases) {
      if (p.kind === 'agent' && p.owner && !owners.includes(p.owner)) owners.push(p.owner);
    }
    owners.forEach((owner, i) => {
      const info = agents.find((a) => a.agent === owner);
      out.push({
        id: `agent:${owner}`,
        label: owner,
        kind: 'agent',
        color: info?.color ?? PALETTE[i % PALETTE.length]!,
        model: info?.model ?? null,
        ctxUsed: info?.context_tokens ?? null,
        ctxWindow: info?.context_window ?? null,
        phases: phases.filter((p) => p.kind === 'agent' && p.owner === owner),
      });
    });
    return out;
  }, [phases, agents]);

  // ── Time range ─────────────────────────────────────────────────────────────
  const range = useMemo(() => {
    let t0 = Infinity;
    let t1 = -Infinity;
    const consider = (v: number, endToo = false) => {
      if (Number.isFinite(v)) {
        t0 = Math.min(t0, v);
        if (endToo) t1 = Math.max(t1, v);
      }
    };
    consider(tsMs(sessionStart));
    if (Number.isFinite(tsMs(sessionEnd))) t1 = Math.max(t1, tsMs(sessionEnd));
    for (const p of phases) {
      const a = tsMs(p.started_at);
      const b = tsMs(p.ended_at);
      if (Number.isFinite(a)) {
        t0 = Math.min(t0, a);
        t1 = Math.max(t1, a);
      }
      if (Number.isFinite(b)) t1 = Math.max(t1, b);
    }
    if (sessionStatus === 'running') t1 = Math.max(t1, nowMs);
    if (!Number.isFinite(t0)) {
      t0 = nowMs;
      t1 = nowMs + 1000;
    }
    if (t1 - t0 < 1000) t1 = t0 + 1000;
    return { t0, t1 };
  }, [phases, sessionStart, sessionEnd, sessionStatus, nowMs]);

  const hasReqZone = useMemo(
    () => phases.some((p) => p.kind === 'engineer' && p.started_at),
    [phases],
  );
  const zone = hasReqZone ? REQ_ZONE_PCT : 0;

  // Where the post-request axis begins: the earliest NON-engineer phase start,
  // not the request's end (a request row's ended_at can run to the whole run).
  const originMs = useMemo(() => {
    if (!hasReqZone) return range.t0;
    let earliest = Infinity;
    for (const p of phases) {
      if (p.kind === 'engineer') continue;
      const s = tsMs(p.started_at);
      if (Number.isFinite(s)) earliest = Math.min(earliest, s);
    }
    return Number.isFinite(earliest) ? Math.max(earliest, range.t0) : range.t0;
  }, [phases, hasReqZone, range.t0]);

  const postSpan = Math.max(range.t1 - originMs, 1000);
  const ticks = useMemo(
    () => axisTicks(postSpan, 6).map((t) => ({ pct: zone + (t.pct * (100 - zone)) / 100, label: t.label })),
    [postSpan, zone],
  );

  // ── Block layout: sequential shift, then normalize back into the track ──────
  const layout = useMemo<Record<string, { left: number; width: number }>>(() => {
    const avail = 100 - zone - 0.4;
    const timed = phases
      .filter((p) => p.kind !== 'engineer' && Number.isFinite(tsMs(p.started_at)))
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
    const rows: { id: string; left: number; width: number }[] = [];
    for (const b of timed) {
      let left = b.left + shift;
      if (left < prevEdge) {
        shift += prevEdge - left;
        left = prevEdge;
      }
      const width = Math.max(b.width, MIN_BLOCK_PCT);
      shift += width - b.width;
      prevEdge = left + width;
      rows.push({ id: b.id, left, width });
    }
    const scale = avail / Math.max(prevEdge, avail);
    const out: Record<string, { left: number; width: number }> = {};
    for (const r of rows) out[r.id] = { left: zone + r.left * scale, width: r.width * scale };
    return out;
  }, [phases, zone, originMs, postSpan, nowMs]);

  // ── Tool-call ticks per phase ──────────────────────────────────────────────
  const toolTicks = useMemo(() => {
    const map: Record<string, { t: number; ok: boolean }[]> = {};
    for (const e of events) {
      if (e.type !== 'tool_call' || !e.phase_id) continue;
      (map[e.phase_id] ??= []).push({ t: tsMs(e.started_at), ok: payloadOk(e.payload_json) });
    }
    return map;
  }, [events]);

  function ticksFor(p: Phase): { x: number; ok: boolean }[] {
    const start = tsMs(p.started_at);
    if (!Number.isFinite(start)) return [];
    let end = tsMs(p.ended_at);
    if (!Number.isFinite(end)) end = p.status === 'running' ? nowMs : start;
    const width = Math.max(end - start, 1);
    return (toolTicks[p.phase_id] ?? [])
      .filter((m) => Number.isFinite(m.t))
      .map((m) => ({ x: Math.min(Math.max(((m.t - start) / width) * 100, 2), 98), ok: m.ok }));
  }

  function geom(p: Phase): { left: string; width: string } | null {
    if (p.kind === 'engineer' && zone > 0) return { left: '0.4%', width: `${zone - 0.8}%` };
    const g = layout[p.phase_id];
    if (!g) return null;
    return { left: `${g.left}%`, width: `${g.width}%` };
  }

  function blockDuration(p: Phase): string {
    const end = p.status === 'running' ? new Date(nowMs).toISOString() : p.ended_at;
    return duration(p.started_at, end);
  }

  function select(p: Phase) {
    const params = new URLSearchParams(search.toString());
    if (selectedPhaseId === p.phase_id) params.delete('phase');
    else params.set('phase', p.phase_id);
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  const queuedByLane = useMemo(() => {
    const map: Record<string, Phase[]> = {};
    for (const lane of lanes) map[lane.id] = lane.phases.filter((p) => !p.started_at);
    return map;
  }, [lanes]);

  return (
    <div className="mb-8">
      <div className="mb-3">
        <Label count={phases.length} rule>
          Waterfall
        </Label>
      </div>
      <div className="overflow-x-auto border border-os-border bg-os-bg2">
        <div className="min-w-[640px]">
          {/* axis */}
          <div className="grid grid-cols-[168px_1fr] border-b border-os-border">
            <div className="border-r border-os-border" />
            <div className="relative h-6">
              {zone > 0 && (
                <span
                  className="absolute inset-y-0 left-0 flex items-center justify-center border-r border-os-border font-mono text-[8.5px] uppercase tracking-[0.14em] text-os-dim"
                  style={{ width: `${zone}%` }}
                >
                  request
                </span>
              )}
              {ticks.map((t, i) => (
                <span
                  key={i}
                  className="absolute bottom-1 -translate-x-1/2 font-mono text-[9px] tabular-nums text-os-dim"
                  style={{ left: `${t.pct}%` }}
                >
                  {t.label}
                </span>
              ))}
            </div>
          </div>

          {/* lanes */}
          {lanes.map((lane) => (
            <div
              key={lane.id}
              className="grid grid-cols-[168px_1fr] border-b border-os-hairline last:border-b-0"
            >
              <div className="min-w-0 border-r border-os-border px-3 py-2">
                <div className="flex items-center gap-1.5">
                  {lane.color && (
                    <span className="h-1.5 w-1.5 shrink-0" style={{ background: lane.color }} aria-hidden />
                  )}
                  <span className="truncate font-mono text-[11px] font-semibold text-os-text" title={lane.label}>
                    {lane.label}
                  </span>
                </div>
                <div className="mt-0.5 font-mono text-[8px] uppercase tracking-[0.14em] text-os-dim">
                  {KIND_LABEL[lane.kind]}
                </div>
                {lane.model && <ModelBadge model={lane.model} className="mt-1 text-[10px]" />}
                {lane.ctxUsed != null && lane.ctxWindow != null && (
                  <ContextBar used={lane.ctxUsed} window={lane.ctxWindow} className="mt-1.5" />
                )}
              </div>

              <div className="relative h-[60px]">
                {zone > 0 && (
                  <span className="absolute inset-y-0 border-l border-os-border" style={{ left: `${zone}%` }} />
                )}
                {ticks.map((t, i) => (
                  <span
                    key={i}
                    className="absolute inset-y-0 border-l border-os-hairline"
                    style={{ left: `${t.pct}%` }}
                    aria-hidden
                  />
                ))}

                {lane.phases.map((p) => {
                  const g = geom(p);
                  if (!g) return null;
                  const status = p.status ?? 'queued';
                  const selected = p.phase_id === selectedPhaseId;
                  return (
                    <button
                      key={p.phase_id}
                      onClick={() => select(p)}
                      title={`${p.name} — ${status}${p.description ? `\n${p.description}` : ''}`}
                      className={`absolute top-2 flex h-[44px] flex-col justify-start overflow-hidden border px-2 py-1 text-left transition-shadow ${
                        BLOCK_STATUS[status] ?? BLOCK_STATUS.queued
                      } ${selected ? 'outline outline-2 outline-os-accent' : ''}`}
                      style={{ left: g.left, width: g.width }}
                    >
                      <span className="flex items-baseline gap-1.5">
                        <span
                          className={`shrink-0 text-[10px] ${
                            status === 'success'
                              ? 'text-os-ok'
                              : status === 'fail'
                                ? 'text-os-err'
                                : status === 'running'
                                  ? 'text-os-warn'
                                  : 'text-os-dim'
                          }`}
                        >
                          {GLYPH[status] ?? '○'}
                        </span>
                        <span className="truncate font-mono text-[11px] font-semibold text-os-text">{p.name}</span>
                        <span className="ml-auto shrink-0 font-mono text-[9px] tabular-nums text-os-dim">
                          {blockDuration(p)}
                        </span>
                      </span>
                      {p.description && (
                        <span className="truncate text-[10px] text-os-dim">{p.description}</span>
                      )}
                      {ticksFor(p).map((tk, i) => (
                        <span
                          key={i}
                          className={`absolute bottom-1 h-1.5 w-[2px] ${tk.ok ? 'bg-os-dim' : 'bg-os-err'}`}
                          style={{ left: `${tk.x}%` }}
                          aria-hidden
                        />
                      ))}
                    </button>
                  );
                })}

                {/* queued phases park at the right edge, dashed */}
                {(queuedByLane[lane.id] ?? []).map((p, i) => {
                  const selected = p.phase_id === selectedPhaseId;
                  return (
                    <button
                      key={p.phase_id}
                      onClick={() => select(p)}
                      title={`${p.name} — queued`}
                      className={`absolute top-2 flex h-[44px] w-[120px] flex-col justify-center overflow-hidden border border-dashed border-os-border-strong px-2 text-left text-os-dim ${
                        selected ? 'outline outline-2 outline-os-accent' : ''
                      }`}
                      style={{ right: `${8 + i * 6}px` }}
                    >
                      <span className="flex items-baseline gap-1.5">
                        <span className="shrink-0 text-[10px]">○</span>
                        <span className="truncate font-mono text-[11px] font-semibold">{p.name}</span>
                      </span>
                      <span className="text-[10px]">queued</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
      <p className="mt-2 font-mono text-[9px] text-os-dim">
        {fmtOffset(range.t1 - range.t0)} total · click a phase to drill in
      </p>
    </div>
  );
}
