'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Cancel a queued or running run. POSTs to /api/queue/[id]/cancel, which either
 * cancels an unclaimed row outright or flips cancel_requested so the worker
 * signals the live process. Optimistic label; the row's real state arrives on
 * the next refresh.
 */
export function CancelButton({ id }: { id: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancel() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/queue/${id}/cancel`, { method: 'POST' });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `cancel failed (${res.status})`);
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
      onClick={cancel}
      disabled={busy}
      title={error ?? 'Stop this run'}
      className={`rounded-sm-t border px-2 py-[3px] font-mono text-[9.5px] uppercase tracking-[0.14em] transition-opacity hover:opacity-80 disabled:opacity-40 ${
        error
          ? 'border-os-err/50 text-os-err'
          : 'border-os-border-strong text-os-muted'
      }`}
    >
      {busy ? '…' : error ? 'retry' : 'cancel'}
    </button>
  );
}
