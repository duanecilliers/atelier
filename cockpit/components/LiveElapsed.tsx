'use client';

import { useEffect, useState } from 'react';
import { duration } from '@/lib/format';

/**
 * A self-ticking elapsed-time cell for a running row. A run stays `running`
 * through its whole life, so the list-level signature doesn't change mid-run and
 * a server-rendered timer would freeze between status changes. This leaf owns
 * just the timer: it ticks once a second and renders mm:ss from `startedAt` to
 * now — everything around it stays server-rendered. Only mount this for rows in
 * the running state; terminal rows show a static "ago" from the server.
 *
 * `serverNow` is the page's render-time clock. Seeding state with it (not
 * Date.now()) makes the server HTML and the first client render identical — no
 * hydration mismatch — then the mount effect takes over ticking with real time.
 */
export function LiveElapsed({ startedAt, serverNow }: { startedAt: string | null; serverNow: number }) {
  const [now, setNow] = useState(serverNow);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  return <>{duration(startedAt, new Date(now).toISOString())}</>;
}
