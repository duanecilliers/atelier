'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useProjectId } from '@/lib/use-project';
import { withProject } from '@/lib/project-url';

/**
 * Live refresh for the two list views (Runs list `/`, Queue board `/queue`).
 * Subscribes to the list-level SSE stream (GET /api/dashboard/stream?watch=…)
 * and calls router.refresh() only when the slice's structural signature changes
 * — so cards move lanes and rows repaint the moment a run's status advances,
 * with zero refreshes while nothing changes. Replaces the blind 2s AutoRefresh.
 *
 * `initialSig` is the signature of the rows this page was server-rendered from
 * (computed by the page from the same data). Seeding the baseline with it means
 * a change that slipped in between render and connect still triggers exactly one
 * refresh, and no redundant refresh fires for state already on screen.
 *
 * No onerror handler: EventSource auto-reconnects (and re-reads the current
 * signature, so a change missed while disconnected still triggers one refresh).
 * Matches the per-run tail's tradeoff — fine for the local single-user cockpit.
 */
export function LiveRefresh({
  watch,
  initialSig,
}: {
  watch: 'runs' | 'queue' | 'sandboxes';
  initialSig: string;
}) {
  const router = useRouter();
  const projectId = useProjectId();
  const lastSig = useRef(initialSig);

  useEffect(() => {
    const es = new EventSource(withProject(`/api/dashboard/stream?watch=${watch}`, projectId));

    es.onmessage = (ev) => {
      let frame: { sig?: string };
      try {
        frame = JSON.parse(ev.data);
      } catch {
        return; // ignore a malformed frame; the next one retries
      }
      if (!frame.sig || frame.sig === lastSig.current) return;
      lastSig.current = frame.sig;
      router.refresh();
    };

    return () => es.close();
  }, [watch, router, projectId]);

  return null;
}
