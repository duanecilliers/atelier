import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/data';

// The rowid-cursor polling contract, exactly as the engine's tracer + visualizer
// define it: GET ?after=<rowid> returns events with rowid > after, plus the new
// cursor to send next time. As of Phase 5 the cockpit's live tail streams over
// SSE (`../stream`) instead of polling this; the route is retained as the
// non-streaming form of the same contract (parity with the engine visualizer).
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { adwId: string } }) {
  const after = Number(req.nextUrl.searchParams.get('after') ?? '0');
  const limit = Number(req.nextUrl.searchParams.get('limit') ?? '500');
  const projectId = req.nextUrl.searchParams.get('project') ?? undefined;
  try {
    const db = getDb(projectId);
    const page = db.events(params.adwId, Number.isFinite(after) ? after : 0, limit);
    // The run's status rides along so the client knows when to stop polling.
    const session = db.session(params.adwId);
    return NextResponse.json({ ...page, status: session?.status ?? null });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
