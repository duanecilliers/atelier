import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import {
  readRoster,
  writeRoster,
  addAgent,
  removeAgent,
  rosterWarnings,
  RosterEditSchema,
  AgentCreateSchema,
  RosterInputError,
} from '@/lib/roster';

/**
 * The config seam's HTTP face. GET returns the current roster + advisory
 * warnings; POST patches allowlisted fields; PUT adds a new agent (+ its prompt
 * files); DELETE removes one.
 *
 * Like the run_queue control route, this NEVER spawns anything and never touches
 * a run's trace — it writes a single configuration FILE (and, on PUT, the two
 * prompt files a new agent requires), surgically and atomically (see
 * lib/roster.ts). The engine re-validates via Pydantic at run time, so a bad
 * write can at worst be rejected there; the Zod mirror + strict schemas catch it
 * first. Always live.
 */
export const dynamic = 'force-dynamic';

/** Map an error to a response: Zod / RosterInputError are 4xx, anything else 5xx. */
function errorResponse(e: unknown, badRequestLabel: string): NextResponse {
  if (e instanceof ZodError) {
    return NextResponse.json({ error: badRequestLabel, issues: e.issues }, { status: 400 });
  }
  if (e instanceof RosterInputError) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
  return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
}

export function GET() {
  try {
    const roster = readRoster();
    return NextResponse.json({ roster, warnings: rosterWarnings(roster) });
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
    const edit = RosterEditSchema.parse(body);
    const roster = writeRoster(edit);
    return NextResponse.json({ roster, warnings: rosterWarnings(roster) });
  } catch (e) {
    return errorResponse(e, 'invalid roster edit');
  }
}

/** Add a new agent (create the entry + bootstrap its prompt files). */
export async function PUT(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  try {
    const spec = AgentCreateSchema.parse(body);
    const roster = addAgent(spec);
    return NextResponse.json({ roster, warnings: rosterWarnings(roster) });
  } catch (e) {
    return errorResponse(e, 'invalid agent');
  }
}

/** Remove an agent by name (?name=…). Leaves its prompt files on disk. */
export function DELETE(req: NextRequest) {
  const name = new URL(req.url).searchParams.get('name');
  if (!name) {
    return NextResponse.json({ error: 'missing ?name=' }, { status: 400 });
  }
  try {
    const roster = removeAgent(name);
    return NextResponse.json({ roster, warnings: rosterWarnings(roster) });
  } catch (e) {
    return errorResponse(e, 'invalid agent name');
  }
}
