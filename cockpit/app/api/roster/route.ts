import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { readRoster, writeRoster, rosterWarnings, RosterEditSchema, RosterInputError } from '@/lib/roster';

/**
 * The config seam's HTTP face. GET returns the current roster + advisory
 * warnings; POST applies an allowlisted patch to sssf.config.yaml.
 *
 * Like the run_queue control route, this NEVER spawns anything and never touches
 * a run's trace — it writes a single configuration FILE, surgically and
 * atomically (see lib/roster.ts). The engine re-validates via Pydantic at run
 * time, so a bad write can at worst be rejected there; the Zod mirror + strict
 * patch schema catch it first. Always live.
 */
export const dynamic = 'force-dynamic';

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
    if (e instanceof ZodError) {
      return NextResponse.json({ error: 'invalid roster edit', issues: e.issues }, { status: 400 });
    }
    if (e instanceof RosterInputError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
