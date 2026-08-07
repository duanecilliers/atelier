import Link from 'next/link';
import { getDb } from '@/lib/data';
import { Badge, Dot, Label, type BadgeTone } from '@/components/terminal';
import { LiveRefresh } from '@/components/LiveRefresh';
import { LiveElapsed } from '@/components/LiveElapsed';
import { QueueLauncher, type SandboxOption } from '@/components/queue/QueueLauncher';
import { CancelButton } from '@/components/queue/CancelButton';
import { ago } from '@/lib/format';
import { queueSig } from '@/lib/dashboard-signature';
import { readRecipes } from '@/lib/skills';
import { pathsForProject } from '@/lib/projects';
import { projectHref } from '@/lib/project-url';
import type { AdwSpec } from '@/lib/adws';
import { TERMINAL_QUEUE_STATUSES, type QueueStatus, type RunQueueRow } from '@/lib/types';

// The queue changes as the worker drains it, so never cache this view.
export const dynamic = 'force-dynamic';

const STATUS_TONE: Record<QueueStatus, BadgeTone> = {
  queued: 'default',
  claimed: 'warn',
  running: 'warn',
  done: 'ok',
  failed: 'err',
  canceled: 'default',
};

// The Kanban lanes, in lifecycle order: a run flows left→right as the worker
// claims it, runs it, and it settles into a terminal lane.
const LANES: readonly QueueStatus[] = ['queued', 'claimed', 'running', 'done', 'failed', 'canceled'];

const ACTIVE: readonly QueueStatus[] = ['queued', 'claimed', 'running'];

function isActive(s: QueueStatus | null): boolean {
  return s != null && ACTIVE.includes(s);
}

function loadQueue(projectId: string): { queue: RunQueueRow[]; error: string | null } {
  try {
    return { queue: getDb(projectId).queue(), error: null };
  } catch (e) {
    return { queue: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/** The launcher menu, built live from THIS project's ADWs on disk (smallest chain
 *  first, as readRecipes() sorts them). Empty if the dir can't be read — the
 *  launcher then disables itself rather than crash the whole queue view. */
function loadCatalog(projectId: string): AdwSpec[] {
  try {
    return readRecipes(pathsForProject(projectId).adwsDir).map((r) => ({
      name: r.id,
      label: r.name,
      blurb: r.tagline,
      usesAgent: r.agents === null,
    }));
  } catch {
    return [];
  }
}

/** The project's ACTIVE sandboxes — the ones a run can attach to. Empty (and the
 *  launcher hides its picker) on any read error or a db with none. */
function loadSandboxes(projectId: string): SandboxOption[] {
  try {
    return getDb(projectId)
      .sandboxes(100, true)
      .map((s) => ({ id: s.id, branch: s.branch }));
  } catch {
    return [];
  }
}

export default function QueuePage({ params }: { params: { project: string } }) {
  const now = Date.now();
  const { queue, error } = loadQueue(params.project);
  const catalog = loadCatalog(params.project);
  const sandboxes = loadSandboxes(params.project);

  // Group into lanes once; keep enqueue order within a lane (queue() is id DESC,
  // i.e. newest first — which reads right for a "most recent on top" column).
  const byLane: Record<QueueStatus, RunQueueRow[]> = {
    queued: [],
    claimed: [],
    running: [],
    done: [],
    failed: [],
    canceled: [],
  };
  for (const row of queue) {
    const status = (row.status ?? 'queued') as QueueStatus;
    (byLane[status] ?? byLane.queued).push(row);
  }

  return (
    <div className="view">
      <LiveRefresh watch="queue" initialSig={queueSig(queue)} />
      <p className="page-eyebrow mb-2.5 font-mono text-[9.5px] font-bold uppercase tracking-[0.32em] text-os-dim">
        {' '}
        Control plane
      </p>
      <div className="mb-1 flex items-center gap-3">
        <h1 className="text-[28px] font-bold uppercase tracking-[0.06em]">
          Queue<span className="caret-blink" />
        </h1>
        <Badge tone="accent">Phase 2</Badge>
      </div>
      <p className="mb-6 max-w-[72ch] text-[13px] text-os-muted">
        Launch runs from the cockpit. The Conductor enqueues a{' '}
        <code className="border border-os-border bg-os-surface2 px-1 text-[11.5px] text-os-text">run_queue</code>{' '}
        row — it never spawns a process. The engine-side worker (
        <code className="border border-os-border bg-os-surface2 px-1 text-[11.5px] text-os-text">just worker</code>)
        drains the queue, launching each run exactly as the CLI would, so it lands in the trace identically.
      </p>

      {error ? (
        <DbError message={error} />
      ) : (
        <>
          <div className="mb-6">
            <QueueLauncher catalog={catalog} sandboxes={sandboxes} />
          </div>

          {queue.length === 0 ? (
            <EmptyQueue />
          ) : (
            <div className="flex gap-px overflow-x-auto border border-os-border bg-os-border">
              {LANES.map((lane) => (
                <Lane key={lane} status={lane} rows={byLane[lane]} now={now} projectId={params.project} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Lane({
  status,
  rows,
  now,
  projectId,
}: {
  status: QueueStatus;
  rows: RunQueueRow[];
  now: number;
  projectId: string;
}) {
  return (
    <div className="flex min-w-[220px] flex-1 flex-col bg-os-bg">
      <div className="border-b border-os-hairline px-3 pt-3">
        <Label count={rows.length} rule>
          {status}
        </Label>
      </div>
      <div className="flex flex-col gap-2 p-2">
        {rows.length === 0 ? (
          <p className="px-1 py-3 font-mono text-[10.5px] text-os-dim">—</p>
        ) : (
          rows.map((row) => <QueueCard key={row.id} row={row} now={now} projectId={projectId} />)
        )}
      </div>
    </div>
  );
}

function QueueCard({ row, now, projectId }: { row: RunQueueRow; now: number; projectId: string }) {
  const status = (row.status ?? 'queued') as QueueStatus;
  const tone = STATUS_TONE[status] ?? 'default';
  const canceling = row.cancel_requested === 1 && !TERMINAL_QUEUE_STATUSES.includes(status);
  const runLink = row.adw_id ? projectHref(projectId, `/runs/${row.adw_id}`) : null;

  return (
    <div className="flex flex-col gap-2 border border-os-border bg-os-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <Badge tone={tone}>
          {status === 'running' && <span className="dot warn pulse" />}
          {status}
        </Badge>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-os-dim">
          {status === 'running' ? (
            <LiveElapsed startedAt={row.started_at} serverNow={now} />
          ) : (
            ago(row.ended_at ?? row.started_at ?? row.enqueued_at, now)
          )}
        </span>
      </div>

      <div className="flex items-center gap-2 font-mono text-[10.5px] text-os-dim">
        {runLink ? (
          <Link href={runLink} className="text-[12px] text-os-text hover:text-os-accent">
            {row.adw_id}
          </Link>
        ) : (
          <span className="text-[12px] text-os-dim">—</span>
        )}
        <span className="truncate">
          {row.adw_name}
          {row.agent ? <span className="text-os-muted"> · {row.agent}</span> : null}
        </span>
      </div>

      {row.sandbox_id && (
        <Link
          href={projectHref(projectId, '/sandboxes')}
          className="inline-flex w-fit items-center gap-1 border border-os-border bg-os-surface2 px-1.5 py-[2px] font-mono text-[9.5px] uppercase tracking-[0.12em] text-os-dim hover:text-os-accent"
          title="This run is bound to a sandbox (isolated worktree)"
        >
          ⬡ {row.sandbox_id}
        </Link>
      )}

      <p className="line-clamp-2 text-[12.5px] text-os-muted" title={row.request ?? ''}>
        {row.request ?? '—'}
      </p>

      {row.error && (
        <p className="font-mono text-[10.5px] text-os-err" title={row.error}>
          {row.error}
        </p>
      )}

      {isActive(status) && (
        <div className="flex justify-end">
          {canceling ? (
            <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-os-warn">stopping…</span>
          ) : (
            <CancelButton id={row.id} />
          )}
        </div>
      )}
    </div>
  );
}

function EmptyQueue() {
  return (
    <div className="border border-dashed border-os-border-strong p-8 text-center font-mono text-[12px] text-os-dim">
      Nothing queued. Describe a task in the Conductor above, then run{' '}
      <span className="text-os-muted">just worker</span> to drain it.
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
