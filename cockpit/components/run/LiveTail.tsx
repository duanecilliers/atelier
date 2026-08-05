'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Label } from '@/components/terminal';
import type { Event, EventType } from '@/lib/types';

/**
 * The live event tail. Polls the engine's rowid-cursor contract
 * (GET /api/runs/:id/events?after=<rowid>) while the run is running, appends new
 * events newest-first, and calls router.refresh() when a STRUCTURAL event lands
 * (phase/gate/agent boundary) so the server-rendered Process Map, Envelopes and
 * Gates re-paint. When the run reaches a terminal status, it stops and does a
 * final refresh. (Phase 5 replaces this poll with SSE — same cursor, new transport.)
 */

const POLL_MS = 800;
const MAX_ROWS = 300;

// Events that change the server-rendered panels — worth a refresh when seen.
const STRUCTURAL: Set<EventType> = new Set([
  'phase_start',
  'phase_end',
  'agent_start',
  'agent_end',
  'gate_pass',
  'gate_fail',
  'handoff',
  'error',
]);

const DOT: Record<string, string> = {
  gate_pass: 'bg-os-ok',
  agent_end: 'bg-os-ok',
  handoff: 'bg-os-ok',
  gate_fail: 'bg-os-err',
  error: 'bg-os-err',
  phase_start: 'bg-os-accent',
  phase_end: 'bg-os-accent',
  agent_start: 'bg-os-accent',
  tool_call: 'bg-os-dim',
  log: 'bg-os-dim',
};

function clockOf(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toTimeString().slice(0, 8);
}

export function LiveTail({
  adwId,
  initialEvents,
  initialCursor,
  initialStatus,
}: {
  adwId: string;
  initialEvents: Event[];
  initialCursor: number;
  initialStatus: string | null;
}) {
  const router = useRouter();
  // Newest-first for display; server hands them oldest-first (rowid asc).
  const [events, setEvents] = useState<Event[]>(() => [...initialEvents].reverse());
  const [status, setStatus] = useState<string | null>(initialStatus);
  const cursorRef = useRef(initialCursor);
  const running = status === 'running';

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/runs/${adwId}/events?after=${cursorRef.current}`, { cache: 'no-store' });
      if (!res.ok) return;
      const page = (await res.json()) as { events: Event[]; cursor: number; status: string | null };
      if (page.events.length > 0) {
        cursorRef.current = page.cursor;
        setEvents((prev) => [...[...page.events].reverse(), ...prev].slice(0, MAX_ROWS));
        if (page.events.some((e) => e.type && STRUCTURAL.has(e.type))) router.refresh();
      }
      if (page.status !== status) {
        setStatus(page.status);
        if (page.status !== 'running') router.refresh(); // final paint
      }
    } catch {
      // transient fetch error — the next tick retries
    }
  }, [adwId, router, status]);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, [running, poll]);

  return (
    <div className="mb-8">
      <div className="mb-3 flex items-center gap-2">
        <Label count={events.length} rule>
          Activity
        </Label>
        {running && (
          <span className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-os-warn">
            <span className="dot ok pulse" /> live
          </span>
        )}
      </div>
      <div className="max-h-[420px] overflow-y-auto border border-os-border">
        {events.length === 0 ? (
          <div className="px-4 py-5 font-mono text-[11.5px] text-os-dim">No events.</div>
        ) : (
          events.map((e) => (
            <div
              key={e.event_id}
              className="flex items-center gap-2.5 border-t border-os-hairline px-4 py-1.5 first:border-t-0"
            >
              <span className={`h-1.5 w-1.5 shrink-0 ${DOT[e.type ?? ''] ?? 'bg-os-dim'}`} aria-hidden />
              <span className="w-[80px] shrink-0 font-mono text-[9.5px] uppercase tracking-[0.08em] text-os-dim">
                {e.type}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-os-muted" title={e.name ?? ''}>
                {e.name}
              </span>
              <span className="shrink-0 font-mono text-[10px] tabular-nums text-os-dim">
                {clockOf(e.started_at ?? e.ended_at)}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
