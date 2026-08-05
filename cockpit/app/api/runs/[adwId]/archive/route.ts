import { NextRequest, NextResponse } from 'next/server';
import { getReview } from '@/lib/review';
import { isSafeSegment } from '@/lib/prompts';

/**
 * POST /api/runs/:adwId/archive — the review seam's HTTP face.
 *
 * Sets (or clears, with `{archived:false}`) a run's archived flag via
 * lib/review.ts. Like the run_queue control route and the roster route, it never
 * spawns anything and never touches a run's trace — archiving is review triage,
 * the one column the engine schema reserves for the UI. Always live.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest, { params }: { params: { adwId: string } }) {
  const adwId = params.adwId;
  if (!isSafeSegment(adwId)) {
    return NextResponse.json({ error: 'invalid adw_id' }, { status: 400 });
  }

  let archived = true;
  try {
    const body = (await req.json()) as { archived?: unknown };
    if (typeof body?.archived === 'boolean') archived = body.archived;
  } catch {
    // No body (or malformed) → default to archiving.
  }

  try {
    const changed = getReview().setArchived(adwId, archived);
    if (!changed) return NextResponse.json({ error: `no session ${adwId}` }, { status: 404 });
    return NextResponse.json({ adw_id: adwId, archived });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
