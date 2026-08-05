import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '@/lib/data';
import { readAgentPrompts, type CompiledPrompts } from '@/lib/prompts';
import { Badge, type BadgeTone, Label, Stat } from '@/components/terminal';
import { Waterfall } from '@/components/run/Waterfall';
import { PhaseDetail } from '@/components/run/PhaseDetail';
import { ModelStack } from '@/components/run/ModelStack';
import { ModelBadge } from '@/components/run/ModelBadge';
import { ContextBar } from '@/components/run/ContextBar';
import { EnvelopePanel } from '@/components/run/EnvelopePanel';
import { GatePanel } from '@/components/run/GatePanel';
import { LiveTail } from '@/components/run/LiveTail';
import { ArchiveControl } from '@/components/run/ArchiveControl';
import { compact, duration, usd } from '@/lib/format';
import type { Envelope, Event, GateResult, Phase, PhaseCost, SessionDetail } from '@/lib/types';

export const dynamic = 'force-dynamic';

const STATUS_TONE: Record<string, BadgeTone> = { success: 'ok', running: 'warn', fail: 'err' };

type Loaded = {
  detail: SessionDetail;
  envelopes: Envelope[];
  gates: GateResult[];
  modelStack: PhaseCost[];
  events: Event[];
  cursor: number;
  sessionsDir: string;
};

function load(adwId: string): { data: Loaded | null; error: string | null; missing: boolean } {
  try {
    const db = getDb();
    const detail = db.sessionDetail(adwId);
    if (!detail) return { data: null, error: null, missing: true };
    const page = db.events(adwId, 0, 1000);
    return {
      data: {
        detail,
        envelopes: db.envelopes(adwId),
        gates: db.gates(adwId),
        modelStack: db.runModelStack(adwId),
        events: page.events,
        cursor: page.cursor,
        sessionsDir: db.sessionsDir,
      },
      error: null,
      missing: false,
    };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : String(e), missing: false };
  }
}

export default function RunDetailPage({
  params,
  searchParams,
}: {
  params: { adwId: string };
  searchParams?: { [key: string]: string | string[] | undefined };
}) {
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

  const { detail, envelopes, gates, modelStack, events, cursor, sessionsDir } = data;
  const { session, phases, agents, usage } = detail;
  const status = session.status ?? 'fail';

  // The selected phase drives the drill-down. Only a real phase_id counts.
  const phaseParam = searchParams?.phase;
  const selectedPhaseId = typeof phaseParam === 'string' ? phaseParam : null;
  const selectedPhase = selectedPhaseId ? (phases.find((p) => p.phase_id === selectedPhaseId) ?? null) : null;

  // Compiled prompts come off disk for the selected agent phase (the db has no copy).
  let prompts: CompiledPrompts | null = null;
  if (selectedPhase?.kind === 'agent' && selectedPhase.owner) {
    prompts = readAgentPrompts(sessionsDir, session.adw_id, selectedPhase.owner);
  }

  return (
    <div className="view">
      <BackLink />

      {/* header */}
      <div className="mb-1 mt-3 flex flex-wrap items-center gap-3">
        <h1 className="font-mono text-[24px] font-bold tracking-[0.02em]">{session.adw_id}</h1>
        <Badge tone={STATUS_TONE[status] ?? 'default'}>{status}</Badge>
        {session.adw_name && <Badge>{session.adw_name}</Badge>}
        <div className="ml-auto">
          <ArchiveControl adwId={session.adw_id} redirectTo="/" />
        </div>
      </div>
      <p className="mb-6 max-w-[80ch] text-[13px] text-os-muted">{session.request ?? '—'}</p>

      {/* stat tiles */}
      <div className="mb-8 grid grid-cols-2 gap-px border border-os-border bg-os-border sm:grid-cols-4">
        <Stat label="Tokens read" value={compact(usage.read)} />
        <Stat label="Tokens written" value={compact(usage.written)} />
        <Stat label="Cost" value={usd(session.total_cost)} />
        <Stat label="Duration" value={duration(session.started_at, session.ended_at)} />
      </div>

      <Waterfall
        adwId={session.adw_id}
        phases={phases}
        events={events}
        agents={agents}
        sessionStatus={session.status}
        sessionStart={session.started_at}
        sessionEnd={session.ended_at}
        selectedPhaseId={selectedPhaseId}
      />

      {agents.length > 0 && <Agents agents={agents} />}

      <ModelStack stack={modelStack} />

      {/* Selecting a phase swaps the run-wide envelope/gate panels for the
          scoped, in-depth drill-down; otherwise show the whole run's outputs. */}
      {selectedPhase ? (
        <PhaseDetail
          phase={selectedPhase}
          events={events}
          envelopes={envelopes}
          gates={gates}
          prompts={prompts}
        />
      ) : (
        <>
          <EnvelopePanel envelopes={envelopes} />
          <GatePanel gates={gates} />
        </>
      )}

      <LiveTail adwId={session.adw_id} initialEvents={events} initialCursor={cursor} initialStatus={session.status} />
    </div>
  );
}

function Agents({ agents }: { agents: SessionDetail['agents'] }) {
  return (
    <div className="mb-8">
      <div className="mb-3">
        <Label count={agents.length} rule>
          Agents
        </Label>
      </div>
      <div className="border border-os-border">
        {agents.map((a) => (
          <div key={a.agent} className="flex items-center gap-3 border-t border-os-hairline px-4 py-2.5 first:border-t-0">
            <span className="h-2 w-2 shrink-0" style={{ background: a.color ?? 'var(--text-3)' }} aria-hidden />
            <span className="w-[110px] shrink-0 font-mono text-[12.5px] text-os-text">{a.agent}</span>
            <span className="min-w-0 flex-1">
              <ModelBadge model={a.model} className="text-[11.5px]" />
            </span>
            <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.12em] text-os-dim">
              {a.coding_agent ?? 'running'}
            </span>
            {a.context_tokens != null && a.context_window ? (
              <ContextBar used={a.context_tokens} window={a.context_window} className="w-[96px] shrink-0" />
            ) : null}
          </div>
        ))}
      </div>
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
