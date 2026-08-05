import Link from 'next/link';
import { getDb } from '@/lib/data';
import { Badge, Dot, Label, type BadgeTone } from '@/components/terminal';
import { AutoRefresh } from '@/components/AutoRefresh';
import { QueueLauncher } from '@/components/queue/QueueLauncher';
import { CancelButton } from '@/components/queue/CancelButton';
import { ago, duration } from '@/lib/format';
import { readRecipes } from '@/lib/skills';
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

const ACTIVE: readonly QueueStatus[] = ['queued', 'claimed', 'running'];

function isActive(s: QueueStatus | null): boolean {
  return s != null && ACTIVE.includes(s);
}

function loadQueue(): { queue: RunQueueRow[]; error: string | null } {
  try {
    return { queue: getDb().queue(), error: null };
  } catch (e) {
    return { queue: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/** The launcher menu, built live from the ADWs on disk (smallest chain first, as
 *  readRecipes() sorts them). Empty if the dir can't be read — the launcher then
 *  disables itself rather than crash the whole queue view. */
function loadCatalog(): AdwSpec[] {
  try {
    return readRecipes().map((r) => ({
      name: r.id,
      label: r.name,
      blurb: r.tagline,
      usesAgent: r.agents === null,
    }));
  } catch {
    return [];
  }
}

export default function QueuePage() {
  const now = Date.now();
  const { queue, error } = loadQueue();
  const catalog = loadCatalog();
  const active = queue.filter((r) => isActive(r.status)).length;

  return (
    <div className="view">
      <AutoRefresh active={active > 0} />
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
            <QueueLauncher catalog={catalog} />
          </div>

          <div className="mb-2">
            <Label count={queue.length} rule>
              Queue
            </Label>
          </div>

          {queue.length === 0 ? (
            <EmptyQueue />
          ) : (
            <div className="border border-os-border">
              {queue.map((row) => (
                <QueueRow key={row.id} row={row} now={now} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function QueueRow({ row, now }: { row: RunQueueRow; now: number }) {
  const status = (row.status ?? 'queued') as QueueStatus;
  const tone = STATUS_TONE[status] ?? 'default';
  const canceling = row.cancel_requested === 1 && !TERMINAL_QUEUE_STATUSES.includes(status);

  // One timestamp that reads right for the state: elapsed while running, else "ago".
  const time =
    status === 'running'
      ? duration(row.started_at, new Date(now).toISOString())
      : ago(row.ended_at ?? row.started_at ?? row.enqueued_at, now);

  const runLink = row.adw_id ? `/runs/${row.adw_id}` : null;

  return (
    <div className="flex items-center gap-3 border-t border-os-hairline px-4 py-3 first:border-t-0">
      <span className="w-[64px] shrink-0">
        <Badge tone={tone}>
          {status === 'running' && <span className="dot warn pulse" />}
          {status}
        </Badge>
      </span>

      <span className="w-[68px] shrink-0 font-mono text-[12px] text-os-text">
        {runLink ? (
          <Link href={runLink} className="hover:text-os-accent">
            {row.adw_id}
          </Link>
        ) : (
          <span className="text-os-dim">—</span>
        )}
      </span>

      <span className="hidden w-[104px] shrink-0 font-mono text-[10.5px] text-os-dim sm:block">
        {row.adw_name}
        {row.agent ? <span className="text-os-muted"> · {row.agent}</span> : null}
      </span>

      <span className="min-w-0 flex-1 truncate text-[12.5px] text-os-muted" title={row.request ?? ''}>
        {row.request ?? '—'}
      </span>

      {row.error && (
        <span className="hidden shrink-0 font-mono text-[10.5px] text-os-err md:inline" title={row.error}>
          {row.error}
        </span>
      )}

      <span className="w-[64px] shrink-0 text-right font-mono text-[11px] tabular-nums text-os-dim">
        {time}
      </span>

      <span className="flex w-[64px] shrink-0 justify-end">
        {isActive(status) ? (
          canceling ? (
            <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-os-warn">stopping…</span>
          ) : (
            <CancelButton id={row.id} />
          )
        ) : null}
      </span>
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
