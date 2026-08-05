import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { getDb } from '@/lib/data';
import { getControl, EnqueueSpecSchema } from '@/lib/control';

// The control seam's HTTP face. GET lists the run_queue; POST enqueues a launch
// spec for the worker to drain. This route NEVER spawns anything — it only
// writes a run_queue row (see lib/control.ts). Always live.
export const dynamic = 'force-dynamic';

export function GET() {
  try {
    return NextResponse.json({ queue: getDb().queue() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  try {
    const spec = EnqueueSpecSchema.parse(body);
    const { id, adw_id } = getControl().enqueue(spec);
    return NextResponse.json({ id, adw_id }, { status: 201 });
  } catch (e) {
    if (e instanceof ZodError) {
      return NextResponse.json({ error: 'invalid launch spec', issues: e.issues }, { status: 400 });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
