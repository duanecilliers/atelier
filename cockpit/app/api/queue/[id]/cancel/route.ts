import { NextResponse } from 'next/server';
import { getControl } from '@/lib/control';

// Ask a run to stop. A queued row is canceled outright; a running one gets its
// cancel_requested flag flipped for the worker to act on. Never touches the run's
// trace — the worker signals the process and the ADW closes its own.
export const dynamic = 'force-dynamic';

export function POST(req: Request, { params }: { params: { id: string } }) {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id < 1) {
    return NextResponse.json({ error: 'invalid queue id' }, { status: 400 });
  }
  const projectId = new URL(req.url).searchParams.get('project') ?? undefined;
  try {
    const row = getControl(projectId).requestCancel(id);
    if (!row) {
      return NextResponse.json({ error: 'not found or already finished' }, { status: 409 });
    }
    return NextResponse.json({ row });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
