import { NextResponse } from 'next/server';
import { getDb } from '@/lib/data';
import { getProject, isRegistryMode, setWorkerDesired, WorkerIntentError } from '@/lib/projects';

// Per-project worker control + status — the cockpit half of Part F.
//   GET  → { attached, desired, registryMode, last_seen_at } for the footer poll.
//   POST → flip workerDesired in atelier.projects.json (the "start/stop" intent).
// POST writes INTENT only; the supervisor (adw_worker.py --supervise) disposes.
// The cockpit still never spawns a process — the determinism spine, one level up.
export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  const projectId = new URL(req.url).searchParams.get('project') ?? undefined;
  const registryMode = isRegistryMode();
  const desired = Boolean(getProject(projectId ?? '')?.workerDesired);
  let attached = false;
  let last_seen_at: string | null = null;
  try {
    const status = getDb(projectId).workerStatus();
    attached = status.attached;
    last_seen_at = status.last_seen_at;
  } catch {
    // A missing sssf.db must never 500 the chrome — report detached.
  }
  return NextResponse.json({ attached, desired, registryMode, last_seen_at });
}

export async function POST(req: Request) {
  let body: { project?: unknown; desired?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    // fall through to the query param / validation below
  }
  const project =
    typeof body.project === 'string'
      ? body.project
      : (new URL(req.url).searchParams.get('project') ?? undefined);
  if (!project) {
    return NextResponse.json({ error: 'project is required' }, { status: 400 });
  }
  try {
    const result = setWorkerDesired(project, Boolean(body.desired));
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof WorkerIntentError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
