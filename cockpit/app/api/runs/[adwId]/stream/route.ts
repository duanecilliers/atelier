import { NextRequest } from 'next/server';
import { getDb } from '@/lib/data';

// The live tail, as a server-pushed SSE stream (Phase 5). Same rowid-cursor
// contract the `/events` poll route serves — GET resumes from Last-Event-ID (or
// ?after=<rowid>) and streams `data: {events,cursor,status}` frames as the engine
// writes them (WAL reads see live writes). One long-lived connection per run
// replaces the client's 800ms fetch loop; the internal sqlite tick is cheap and
// local, and `req.signal` tears it down the moment the browser disconnects.
//
// better-sqlite3 is synchronous → this must be the Node runtime, not edge.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TICK_MS = 300; // how often we look for new rows
const HEARTBEAT_MS = 15_000; // keep-alive comment so idle proxies don't drop us
const LIMIT = 500;

export async function GET(req: NextRequest, { params }: { params: { adwId: string } }) {
  const adwId = params.adwId;
  // Reconnecting EventSources send the last id they saw; a fresh one uses ?after.
  const lastId = req.headers.get('last-event-id');
  const afterParam = Number(lastId ?? req.nextUrl.searchParams.get('after') ?? '0');
  let cursor = Number.isFinite(afterParam) ? Math.max(0, afterParam) : 0;
  const projectId = req.nextUrl.searchParams.get('project') ?? undefined;

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const db = getDb(projectId);
      let closed = false;
      let lastStatus: string | null | undefined; // undefined = not yet sent
      let tick: ReturnType<typeof setInterval> | undefined;
      let beat: ReturnType<typeof setInterval> | undefined;

      const send = (data: unknown, id?: number) => {
        if (closed) return;
        const idLine = id !== undefined ? `id: ${id}\n` : '';
        try {
          controller.enqueue(encoder.encode(`${idLine}data: ${JSON.stringify(data)}\n\n`));
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
          const page = db.events(adwId, cursor, LIMIT);
          const status = db.session(adwId)?.status ?? null;
          const statusChanged = status !== lastStatus;
          // Only push a frame when there's something new to say.
          if (page.events.length > 0 || statusChanged) {
            cursor = page.cursor;
            lastStatus = status;
            send({ events: page.events, cursor, status }, cursor);
          }
          // A finished run ends the stream; the client does its final refresh.
          if (status !== null && status !== 'running') cleanup();
        } catch {
          // transient read error — the next tick retries (mirrors the poll route)
        }
      };

      // Client disconnect (tab closed, navigated away) aborts the request signal.
      req.signal.addEventListener('abort', cleanup);

      pump(); // emit the current state immediately, then tail
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
