'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useProjectId } from '@/lib/use-project';
import { withProject } from '@/lib/project-url';

/**
 * Land a sandbox's work. POSTs to /api/sandboxes/[id]/land, which flips
 * `land_requested`; the worker runs the project's declared `land` hook
 * (pr | merge | manual) once and returns the sandbox to `active` — landing never
 * destroys the sandbox (shut down separately for that). The captured result (a PR
 * URL / summary) surfaces on the next refresh. The cockpit never runs the hook
 * itself. Optimistic label; the real state arrives on the next refresh.
 */
export function LandButton({ id }: { id: string }) {
  const router = useRouter();
  const projectId = useProjectId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function land() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(withProject(`/api/sandboxes/${id}/land`, projectId), {
        method: 'POST',
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `land failed (${res.status})`);
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={land}
      disabled={busy}
      title={error ?? 'Run this project’s land hook (PR / merge / manual); the sandbox stays alive'}
      className={`rounded-sm-t border px-2 py-[3px] font-mono text-[9.5px] uppercase tracking-[0.14em] transition-opacity hover:opacity-80 disabled:opacity-40 ${
        error ? 'border-os-err/50 text-os-err' : 'border-os-border-strong text-os-muted'
      }`}
    >
      {busy ? '…' : error ? 'retry' : 'land'}
    </button>
  );
}
