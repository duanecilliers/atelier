'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useProjectId } from '@/lib/use-project';
import { withProject } from '@/lib/project-url';

/**
 * Shut a sandbox down. POSTs to /api/sandboxes/[id]/shutdown, which flips
 * `shutdown_requested`; the worker runs `git worktree remove` and marks the row
 * `gone` (the branch and its commits survive in the shared .git). The cockpit
 * never removes a worktree itself. Optimistic label; the real state arrives on
 * the next refresh.
 */
export function ShutdownButton({ id }: { id: string }) {
  const router = useRouter();
  const projectId = useProjectId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function shutdown() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(withProject(`/api/sandboxes/${id}/shutdown`, projectId), {
        method: 'POST',
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `shutdown failed (${res.status})`);
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
      onClick={shutdown}
      disabled={busy}
      title={error ?? 'Remove this sandbox’s worktree (the branch survives)'}
      className={`rounded-sm-t border px-2 py-[3px] font-mono text-[9.5px] uppercase tracking-[0.14em] transition-opacity hover:opacity-80 disabled:opacity-40 ${
        error ? 'border-os-err/50 text-os-err' : 'border-os-border-strong text-os-muted'
      }`}
    >
      {busy ? '…' : error ? 'retry' : 'shut down'}
    </button>
  );
}
