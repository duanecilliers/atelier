import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '@/lib/data';
import { Badge, type BadgeTone } from '@/components/terminal';
import { ProcessMap } from '@/components/run/ProcessMap';
import { EnvelopePanel } from '@/components/run/EnvelopePanel';
import { GatePanel } from '@/components/run/GatePanel';
import { LiveTail } from '@/components/run/LiveTail';
import { compact, duration, usd } from '@/lib/format';
import type { Envelope, Event, GateResult, SessionDetail } from '@/lib/types';

export const dynamic = 'force-dynamic';

const STATUS_TONE: Record<string, BadgeTone> = { success: 'ok', running: 'warn', fail: 'err' };

type Loaded = {
  detail: SessionDetail;
  envelopes: Envelope[];
  gates: GateResult[];
  events: Event[];
  cursor: number;
};

function load(adwId: string): { data: Loaded | null; error: string | null; missing: boolean } {
  try {
    const db = getDb();
    const detail = db.sessionDetail(adwId);
    if (!detail) return { data: null, error: null, missing: true };
    const page = db.events(adwId, 0, 1000);
    return {
      data: { detail, envelopes: db.envelopes(adwId), gates: db.gates(adwId), events: page.events, cursor: page.cursor },
      error: null,
      missing: false,
    };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : String(e), missing: false };
  }
}

export default function RunDetailPage({ params }: { params: { adwId: string } }) {
  const { data, error, missing } = load(params.adwId);
  if (missing) notFound();
  if (error || !data) {
    return (
      <div className="view">
        <BackLink />
        <pre className="mt-4 whitespace-pre-wrap border border-os-err/40 p-4 font-mono text-[11.5px] text-os-muted">
          {error}
        </pre>
      </div>
    );
  }

  const { detail, envelopes, gates, events, cursor } = data;
  const { session, phases, agents, usage } = detail;
  const status = session.status ?? 'fail';

  return (
    <div className="view">
      <BackLink />

      {/* header */}
      <div className="mb-1 mt-3 flex flex-wrap items-center gap-3">
        <h1 className="font-mono text-[24px] font-bold tracking-[0.02em]">{session.adw_id}</h1>
        <Badge tone={STATUS_TONE[status] ?? 'default'}>{status}</Badge>
        {session.adw_name && <Badge>{session.adw_name}</Badge>}
      </div>
      <p className="mb-6 max-w-[80ch] text-[13px] text-os-muted">{session.request ?? '—'}</p>

      {/* stat tiles */}
      <div className="mb-8 grid grid-cols-2 gap-px border border-os-border bg-os-border sm:grid-cols-4">
        <Stat label="Tokens read" value={compact(usage.read)} />
        <Stat label="Tokens written" value={compact(usage.written)} />
        <Stat label="Cost" value={usd(session.total_cost)} />
        <Stat label="Duration" value={duration(session.started_at, session.ended_at)} />
      </div>

      <ProcessMap phases={phases} agents={agents} />

      {agents.length > 0 && <Agents agents={agents} />}

      <EnvelopePanel envelopes={envelopes} />
      <GatePanel gates={gates} />

      <LiveTail adwId={session.adw_id} initialEvents={events} initialCursor={cursor} initialStatus={session.status} />
    </div>
  );
}

function Agents({ agents }: { agents: SessionDetail['agents'] }) {
  return (
    <div className="mb-8">
      <div className="mb-3 font-mono text-[10px] font-bold uppercase tracking-[0.26em] text-os-dim">
        <span className="flex items-center gap-2">
          Agents <span className="text-os-muted">{agents.length}</span>
          <span className="h-px flex-1 bg-os-border" />
        </span>
      </div>
      <div className="border border-os-border">
        {agents.map((a) => (
          <div key={a.agent} className="flex items-center gap-3 border-t border-os-hairline px-4 py-2.5 first:border-t-0">
            <span className="h-2 w-2 shrink-0" style={{ background: a.color ?? 'var(--text-3)' }} aria-hidden />
            <span className="w-[110px] shrink-0 font-mono text-[12.5px] text-os-text">{a.agent}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-os-muted">{a.model ?? '—'}</span>
            <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.12em] text-os-dim">
              {a.coding_agent ?? 'running'}
            </span>
            {a.context_tokens != null && a.context_window ? (
              <span className="w-[64px] shrink-0 text-right font-mono text-[10px] tabular-nums text-os-dim">
                {Math.round((a.context_tokens / a.context_window) * 100)}% ctx
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-os-bg px-4 py-3">
      <div className="font-mono text-[8.5px] uppercase tracking-[0.16em] text-os-dim">{label}</div>
      <div className="mt-1 font-mono text-[20px] font-bold tabular-nums text-os-text">{value}</div>
    </div>
  );
}

function BackLink() {
  return (
    <Link href="/" className="font-mono text-[11px] text-os-dim transition-colors hover:text-os-accent">
      ← runs
    </Link>
  );
}
