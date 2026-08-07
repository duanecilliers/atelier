import { NextRequest, NextResponse } from 'next/server';
import { getControl } from '@/lib/control';

// Ask the worker to run a sandbox's `land` hook: flip `land_requested`. The worker
// runs the project's declared land workflow (pr | merge | manual) once, in the
// worktree, and returns the sandbox to `active` — landing never destroys it. The
// cockpit never runs the hook itself. Only an `active` sandbox can land. Scoped to
// ?project=<id>.
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const projectId = req.nextUrl.searchParams.get('project') ?? undefined;
  try {
    const row = getControl(projectId).requestLand(params.id);
    if (!row) {
      return NextResponse.json(
        { error: `sandbox '${params.id}' is unknown or not active (only an active sandbox can land)` },
        { status: 404 },
      );
    }
    return NextResponse.json({ sandbox: row });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
