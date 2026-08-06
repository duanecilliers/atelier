import { NextRequest } from 'next/server';
import { getDb } from '@/lib/data';
import { queueSig, runsSig } from '@/lib/dashboard-signature';

// List-level live stream (Phase 5). The per-run tail (`/api/runs/[id]/stream`)
// pushes event rows; the two *list* views — the Runs list (`/`) and the Queue
// board (`/queue`) — don't need the rows, only a nudge to re-render when their
// contents structurally change. So this endpoint pushes a compact `data: {sig}`
// change-signature frame instead: the client (`components/LiveRefresh`) calls
// router.refresh() only when the signature moves, and the force-dynamic server
// component re-queries sqlite and re-groups the rows. That keeps the read path
// readonly and server-rendered — no card state crosses to the client — while
// replacing the blind 2s `AutoRefresh` poll with a change-driven refresh.
//
// Scoped by `?watch=runs|queue` so each page only wakes on its own slice.
// Unlike the per-run route this never auto-closes — a list view is always live.
//
// better-sqlite3 is synchronous → this must be the Node runtime, not edge.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TICK_MS = 300; // how often we recompute the signature
const HEARTBEAT_MS = 15_000; // keep-alive comment so idle proxies don't drop us

type Watch = 'runs' | 'queue';

/** The structural signature of the requested slice, read fresh from sqlite.
 *  Read errors bubble to the caller (pump), which swallows and retries. */
function signature(watch: Watch, projectId: string | undefined): string {
  const db = getDb(projectId);
  return watch === 'queue' ? queueSig(db.queue()) : runsSig(db.sessions());
}

export async function GET(req: NextRequest) {
  const watch: Watch = req.nextUrl.searchParams.get('watch') === 'queue' ? 'queue' : 'runs';
  const projectId = req.nextUrl.searchParams.get('project') ?? undefined;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let lastSig: string | undefined; // undefined = nothing sent yet (first tick seeds)
      let tick: ReturnType<typeof setInterval> | undefined;
      let beat: ReturnType<typeof setInterval> | undefined;

      const send = (data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          // controller already torn down — stop pushing
          cleanup();
        }
      };

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (tick) clearInterval(tick);
        if (beat) clearInterval(beat);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      const pump = () => {
        if (closed) return;
        try {
          const sig = signature(watch, projectId);
          // First tick always emits (seeds the client); after that only on change.
          if (sig !== lastSig) {
            lastSig = sig;
            send({ sig });
          }
        } catch {
          // transient read error — the next tick retries (mirrors the poll route)
        }
      };

      // Client disconnect (tab closed, navigated away) aborts the request signal.
      req.signal.addEventListener('abort', cleanup);

      pump(); // emit the current signature immediately, then diff
      if (!closed) {
        tick = setInterval(pump, TICK_MS);
        beat = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(': ping\n\n'));
          } catch {
            cleanup();
          }
        }, HEARTBEAT_MS);
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
