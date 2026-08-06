'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useProjectId } from '@/lib/use-project';
import { withProject } from '@/lib/project-url';

/**
 * Archive a run out of the review list — the review seam's only UI.
 *
 * POSTs to /api/runs/:id/archive, then either redirects (the run-detail header,
 * where the run you're viewing has just left the list) or refreshes in place
 * (the run-log row overlay). The `icon` variant lives INSIDE a row-level <Link>,
 * so it stops the click from navigating. Archiving is reversible from the db;
 * there's no destructive confirm.
 */
export function ArchiveControl({
  adwId,
  variant = 'button',
  redirectTo,
}: {
  adwId: string;
  variant?: 'button' | 'icon';
  redirectTo?: string;
}) {
  const router = useRouter();
  const projectId = useProjectId();
  const [busy, setBusy] = useState(false);

  async function archive(e: React.MouseEvent) {
    // The icon variant is nested in a <Link>; never let the click navigate.
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(withProject(`/api/runs/${adwId}/archive`, projectId), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ archived: true }),
      });
      if (!res.ok) throw new Error(String(res.status));
      if (redirectTo) router.push(redirectTo);
      else router.refresh();
    } catch {
      // A failed archive just leaves the run in the list — no destructive state.
      setBusy(false);
    }
  }

  if (variant === 'icon') {
    return (
      <button
        type="button"
        onClick={archive}
        disabled={busy}
        title="Archive — remove from the review list"
        aria-label="Archive run"
        className="grid h-6 w-6 shrink-0 place-items-center rounded-sm-t text-os-dim opacity-0 transition-opacity hover:bg-[color-mix(in_oklab,var(--err)_16%,transparent)] hover:text-os-err focus-visible:opacity-100 group-hover:opacity-100"
      >
        ×
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={archive}
      disabled={busy}
      title="Archive — remove from the review list"
      className="rounded-sm-t border border-os-border-strong px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-os-dim transition-colors hover:border-[color-mix(in_oklab,var(--err)_45%,var(--border))] hover:text-os-err disabled:opacity-50"
    >
      {busy ? 'archiving…' : 'Archive'}
    </button>
  );
}
