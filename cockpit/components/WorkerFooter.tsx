'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * The shell footer's worker status (Part F). Polls the per-project worker
 * endpoint so "no worker attached" is honest and live — a killed worker shows
 * within a poll or two, and a started one flips back to attached once its
 * heartbeat lands. In registry mode it also offers the start/stop toggle, which
 * writes INTENT (workerDesired) — the supervisor spawns the actual process.
 * Single-project (env-fallback) mode shows status only: there's no registry file
 * to write intent into, so there's nothing to toggle.
 */
type Status = {
  attached: boolean;
  desired: boolean;
  registryMode: boolean;
  last_seen_at: string | null;
};

const POLL_MS = 4000;

export function WorkerFooter({ projectId }: { projectId: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/worker?project=${encodeURIComponent(projectId)}`, {
        cache: 'no-store',
      });
      if (res.ok) setStatus((await res.json()) as Status);
    } catch {
      // transient — keep the last known status rather than flapping
    }
  }, [projectId]);

  useEffect(() => {
    setStatus(null); // clear stale project's status on switch
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const toggle = useCallback(async () => {
    if (!status) return;
    setBusy(true);
    // Optimistic: reflect the new intent immediately; the poll reconciles.
    setStatus({ ...status, desired: !status.desired });
    try {
      await fetch('/api/projects/worker', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project: projectId, desired: !status.desired }),
      });
      await load();
    } finally {
      setBusy(false);
    }
  }, [status, projectId, load]);

  // Tri-state: attached (heartbeat fresh) · starting (desired, no beat yet) · idle.
  const state = !status ? 'unknown' : status.attached ? 'attached' : status.desired ? 'starting' : 'idle';
  const dotClass = { attached: 'dot ok pulse', starting: 'dot warn pulse', idle: 'dot off', unknown: 'dot off' }[state];
  const label = { attached: 'worker attached', starting: 'worker starting…', idle: 'no worker', unknown: 'worker status…' }[state];

  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2 whitespace-nowrap font-mono text-[10px] text-os-muted">
        <span className={dotClass} /> {label}
      </div>
      {status?.registryMode && (
        <button
          type="button"
          onClick={toggle}
          disabled={busy}
          className="rounded-sm-t border border-os-border px-1.5 py-[3px] font-mono text-[9px] uppercase tracking-[0.1em] text-os-muted transition-colors hover:border-os-border-strong hover:text-os-text disabled:opacity-50"
          aria-label={status.desired ? 'Stop worker' : 'Start worker'}
        >
          {status.desired ? 'stop' : 'start'}
        </button>
      )}
    </div>
  );
}
