import Link from 'next/link';
import { getDb } from '@/lib/data';
import { Badge, Dot, Label, type BadgeTone } from '@/components/terminal';
import { LiveRefresh } from '@/components/LiveRefresh';
import { LiveElapsed } from '@/components/LiveElapsed';
import { ArchiveControl } from '@/components/run/ArchiveControl';
import { ago, compact, usd } from '@/lib/format';
import { runsSig } from '@/lib/dashboard-signature';
import type { SessionSummary } from '@/lib/types';

// The db changes as runs happen, so never cache this view.
export const dynamic = 'force-dynamic';

const STATUS_TONE: Record<string, BadgeTone> = {
  success: 'ok',
  running: 'warn',
  fail: 'err',
};

const STATUS_LABEL: Record<string, string> = {
  success: 'OK',
  running: 'RUN',
  fail: 'FAIL',
};

function loadSessions(): { sessions: SessionSummary[]; error: string | null; dbPath: string } {
  try {
    const db = getDb();
    return { sessions: db.sessions(), error: null, dbPath: db.path };
  } catch (e) {
    return { sessions: [], error: e instanceof Error ? e.message : String(e), dbPath: '' };
  }
}

export default function RunsPage() {
  const now = Date.now();
  const { sessions, error } = loadSessions();

  const stats = {
    total: sessions.length,
    ok: sessions.filter((s) => s.status === 'success').length,
    fail: sessions.filter((s) => s.status === 'fail').length,
    running: sessions.filter((s) => s.status === 'running').length,
  };

  return (
    <div className="view">
      {/* Live over SSE: a status/phase change repaints; a CLI-kicked run appears
          from idle. Baseline is the signature of the rows we just rendered. */}
      <LiveRefresh watch="runs" initialSig={runsSig(sessions)} />
      {/* header */}
      <p className="page-eyebrow mb-2.5 font-mono text-[9.5px] font-bold uppercase tracking-[0.32em] text-os-dim">
        {' '}
        Factory floor
      </p>
      <div className="mb-1 flex items-center gap-3">
        <h1 className="text-[28px] font-bold uppercase tracking-[0.06em]">
          Runs<span className="caret-blink" />
        </h1>
      </div>
      <p className="mb-7 max-w-[70ch] text-[13px] text-os-muted">
        Every ADW session, newest first, read live from the engine&apos;s{' '}
        <code className="border border-os-border bg-os-surface2 px-1 text-[11.5px] text-os-text">sssf.db</code>.
        Agents propose inside bounded phases; deterministic code disposes. Kick a run from the CLI in{' '}
        <code className="border border-os-border bg-os-surface2 px-1 text-[11.5px] text-os-text">../engine</code>{' '}
        and watch it land here.
      </p>

      {error ? (
        <DbError message={error} />
      ) : (
        <>
          {/* stat tiles */}
          <div className="mb-6 grid grid-cols-2 gap-px border border-os-border bg-os-border sm:grid-cols-4">
            <Stat label="Runs" value={stats.total} />
            <Stat label="Accepted" value={stats.ok} tone="ok" />
            <Stat label="Failed" value={stats.fail} tone={stats.fail ? 'err' : 'default'} />
            <Stat label="Running" value={stats.running} tone={stats.running ? 'warn' : 'default'} />
          </div>

          <div className="mb-2">
            <Label count={sessions.length} rule>
              Run log
            </Label>
          </div>

          {sessions.length === 0 ? (
            <EmptyRuns />
          ) : (
            <div className="border border-os-border">
              {sessions.map((s) => (
                <RunRow key={s.adw_id} session={s} now={now} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone = 'default' }: { label: string; value: number; tone?: BadgeTone }) {
  const color =
    tone === 'ok' ? 'text-os-ok' : tone === 'err' ? 'text-os-err' : tone === 'warn' ? 'text-os-warn' : 'text-os-text';
  return (
    <div className="bg-os-bg px-4 py-3">
      <div className="font-mono text-[8.5px] uppercase tracking-[0.16em] text-os-dim">{label}</div>
      <div className={`mt-1 font-mono text-[22px] font-bold tabular-nums ${color}`}>{value}</div>
    </div>
  );
}

function RunRow({ session, now }: { session: SessionSummary; now: number }) {
  const status = session.status ?? 'fail';
  const tone = STATUS_TONE[status] ?? 'default';
  const label = STATUS_LABEL[status] ?? status.toUpperCase();

  return (
    <Link
      href={`/runs/${session.adw_id}`}
      className="hoverable group flex items-center gap-3 border-t border-os-hairline px-4 py-3 first:border-t-0"
    >
      <span className="w-[42px] shrink-0">
        <Badge tone={tone}>{label}</Badge>
      </span>
      <span className="w-[68px] shrink-0 font-mono text-[12px] text-os-text">{session.adw_id}</span>
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-os-muted" title={session.request ?? ''}>
        {session.request ?? '—'}
      </span>
      {/* phase progress dots — one per phase, colored by status */}
      <span className="hidden shrink-0 items-center gap-1 md:flex" title={`${session.phase_count} phases`}>
        {session.phases.map((p) => (
          <Dot key={p.phase_id} state={p.status ?? 'queued'} pulse={p.status === 'running'} />
        ))}
      </span>
      <span className="hidden w-[52px] shrink-0 text-right font-mono text-[11px] tabular-nums text-os-dim sm:block">
        {compact(session.total_tokens)}
      </span>
      <span className="w-[56px] shrink-0 text-right font-mono text-[11px] tabular-nums text-os-dim">
        {usd(session.total_cost)}
      </span>
      <span className="w-[64px] shrink-0 text-right font-mono text-[11px] tabular-nums text-os-dim">
        {status === 'running' ? (
          <LiveElapsed startedAt={session.started_at} serverNow={now} />
        ) : (
          ago(session.ended_at ?? session.started_at, now)
        )}
      </span>
      <ArchiveControl adwId={session.adw_id} variant="icon" />
    </Link>
  );
}

function EmptyRuns() {
  return (
    <div className="border border-dashed border-os-border-strong p-8 text-center font-mono text-[12px] text-os-dim">
      No runs yet. In <span className="text-os-muted">../engine</span>, run:
      <div className="mt-3 inline-block border border-os-border bg-os-surface2 px-3 py-2 text-[11.5px] text-os-text">
        just demo
      </div>
    </div>
  );
}

function DbError({ message }: { message: string }) {
  return (
    <div className="border border-os-err/40 bg-[color-mix(in_oklab,var(--err)_7%,transparent)] p-6">
      <div className="mb-2 flex items-center gap-2">
        <Dot state="fail" />
        <span className="font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-os-err">
          can&apos;t reach sssf.db
        </span>
      </div>
      <pre className="whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-os-muted">{message}</pre>
    </div>
  );
}
