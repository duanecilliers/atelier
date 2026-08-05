import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { getDb } from '@/lib/data';
import { getControl, EnqueueSpecSchema, EnqueueError } from '@/lib/control';

// The control seam's HTTP face. GET lists the run_queue; POST enqueues a launch
// spec for the worker to drain. Both scope to ?project=<id>. This route NEVER
// spawns anything — it only writes a run_queue row (see lib/control.ts). Always live.
export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get('project') ?? undefined;
  try {
    return NextResponse.json({ queue: getDb(projectId).queue() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get('project') ?? undefined;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  try {
    const spec = EnqueueSpecSchema.parse(body);
    const { id, adw_id } = getControl(projectId).enqueue(spec);
    return NextResponse.json({ id, adw_id }, { status: 201 });
  } catch (e) {
    if (e instanceof ZodError) {
      return NextResponse.json({ error: 'invalid launch spec', issues: e.issues }, { status: 400 });
    }
    if (e instanceof EnqueueError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
