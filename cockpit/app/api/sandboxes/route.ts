import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { getDb } from '@/lib/data';
import { getControl, CreateSandboxSpecSchema } from '@/lib/control';
import { pathsForProject } from '@/lib/projects';
import { projectSandboxBranchTemplate } from '@/lib/roster';

// The sandbox control seam's HTTP face. GET lists sandboxes; POST requests a new
// one (status `requested`) for the worker to provision. Both scope to ?project=<id>.
// This route NEVER spawns anything — it only writes a `sandboxes` row (see
// lib/control.ts); the worker turns intent into a real worktree. Always live.
export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get('project') ?? undefined;
  const activeOnly = req.nextUrl.searchParams.get('active') === '1';
  try {
    return NextResponse.json({ sandboxes: getDb(projectId).sandboxes(100, activeOnly) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get('project') ?? undefined;
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    // empty body is fine — the spec defaults level to 'worktree'
  }
  try {
    const spec = CreateSandboxSpecSchema.parse(body ?? {});
    const branchTemplate = projectSandboxBranchTemplate(pathsForProject(projectId).configPath, spec.level);
    const { id } = getControl(projectId).createSandbox(spec, branchTemplate);
    return NextResponse.json({ id }, { status: 201 });
  } catch (e) {
    if (e instanceof ZodError) {
      return NextResponse.json({ error: 'invalid sandbox spec', issues: e.issues }, { status: 400 });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
