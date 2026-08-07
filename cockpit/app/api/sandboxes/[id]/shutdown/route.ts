import { NextRequest, NextResponse } from 'next/server';
import { getControl } from '@/lib/control';

// Ask the worker to tear a sandbox down: flip `shutdown_requested`. The worker
// runs `git worktree remove` and marks the row `gone` — the ONLY thing that tears
// a sandbox down. The cockpit never removes a worktree itself. Scoped to ?project=<id>.
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const projectId = req.nextUrl.searchParams.get('project') ?? undefined;
  try {
    const row = getControl(projectId).requestShutdown(params.id);
    if (!row) {
      return NextResponse.json(
        { error: `sandbox '${params.id}' is unknown or already gone` },
        { status: 404 },
      );
    }
    return NextResponse.json({ sandbox: row });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
