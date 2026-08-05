'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Re-pulls this server component tree on an interval while `active`. Used on the
 * Runs list so a run kicked from the CLI (or a running one advancing) appears
 * without a manual reload. Cheap: force-dynamic pages just re-query sqlite.
 */
export function AutoRefresh({ active, intervalMs = 2000 }: { active: boolean; intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs, router]);
  return null;
}
