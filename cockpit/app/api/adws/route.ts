import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { listSteps, buildAdw, AdwBuildError } from '@/lib/adw-builder';

/**
 * The ADW builder's HTTP face. GET returns the block catalog for the composer;
 * POST generates a new ADW script (or, with `preview: true`, returns the source
 * without writing).
 *
 * NOTE — the one write surface in the cockpit that spawns a process: it shells
 * out to `uv run engine/adws/make_adw.py` (see lib/adw-builder.ts). That is a
 * deterministic code generator — no model, no db, no run trace — and the script
 * it emits is reviewed before it can be launched. The determinism spine is
 * intact: adw_worker.py remains the only thing that turns a queued row into a
 * run. Contrast lib/roster.ts, which writes config files directly and spawns
 * nothing. Always live.
 */
export const dynamic = 'force-dynamic';

/** Zod / AdwBuildError (a bad spec, caught by the generator) are 4xx; else 5xx. */
function errorResponse(e: unknown): NextResponse {
  if (e instanceof ZodError) {
    return NextResponse.json({ error: 'invalid recipe', issues: e.issues }, { status: 400 });
  }
  if (e instanceof AdwBuildError) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
  return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
}

export async function GET() {
  try {
    return NextResponse.json(await listSteps());
  } catch (e) {
    return errorResponse(e);
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
    return NextResponse.json(await buildAdw(body as never));
  } catch (e) {
    return errorResponse(e);
  }
}
