'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useProjectId } from '@/lib/use-project';
import { withProject } from '@/lib/project-url';

/**
 * Request a new sandbox. POSTs to /api/sandboxes, which INSERTs a `requested`
 * `sandboxes` row — it never spawns anything. The worker (just worker) provisions
 * a git worktree on a named branch and flips it to `active`. Optimistic; the real
 * row arrives on the next live refresh.
 *
 * Slice 1 ships one provisionable level (`worktree`), so there is no level picker
 * yet — that (and per-project provisioning) lands with the sandbox profile in
 * slice 2. The button just requests a worktree sandbox.
 */
export function NewSandboxButton() {
  const router = useRouter();
  const projectId = useProjectId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(withProject('/api/sandboxes', projectId), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ level: 'worktree' }),
      });
      const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!res.ok || !data.id) throw new Error(data.error ?? `create failed (${res.status})`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={create}
        disabled={busy}
        className="rounded-sm-t border border-[var(--accent-line)] bg-[var(--accent-soft)] px-4 py-[7px] font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-os-accent transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? 'Requesting…' : '+ New sandbox'}
      </button>
      {error && (
        <span className="font-mono text-[11px] text-os-err" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}
