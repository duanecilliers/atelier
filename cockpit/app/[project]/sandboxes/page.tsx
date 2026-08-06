import Link from 'next/link';
import { getDb } from '@/lib/data';
import { Badge, Dot, type BadgeTone } from '@/components/terminal';
import { LiveRefresh } from '@/components/LiveRefresh';
import { NewSandboxButton } from '@/components/sandboxes/NewSandboxButton';
import { ShutdownButton } from '@/components/sandboxes/ShutdownButton';
import { ago } from '@/lib/format';
import { sandboxesSig } from '@/lib/dashboard-signature';
import { projectHref } from '@/lib/project-url';
import { TERMINAL_SANDBOX_STATUSES, type Sandbox, type SandboxStatus } from '@/lib/types';

// A sandbox provisions and tears down as the worker reconciles it, so never cache.
export const dynamic = 'force-dynamic';

const STATUS_TONE: Record<SandboxStatus, BadgeTone> = {
  requested: 'default',
  provisioning: 'warn',
  active: 'ok',
  landing: 'warn',
  shutting_down: 'warn',
  gone: 'default',
  failed: 'err',
};

// Statuses where the worker is mid-flight — a pulsing dot reads "working".
const BUSY: readonly SandboxStatus[] = ['provisioning', 'landing', 'shutting_down'];

function loadSandboxes(projectId: string): { sandboxes: Sandbox[]; error: string | null } {
  try {
    return { sandboxes: getDb(projectId).sandboxes(), error: null };
  } catch (e) {
    return { sandboxes: [], error: e instanceof Error ? e.message : String(e) };
  }
}

export default function SandboxesPage({ params }: { params: { project: string } }) {
  const now = Date.now();
  const { sandboxes, error } = loadSandboxes(params.project);

  return (
    <div className="view">
      <LiveRefresh watch="sandboxes" initialSig={sandboxesSig(sandboxes)} />
      <p className="page-eyebrow mb-2.5 font-mono text-[9.5px] font-bold uppercase tracking-[0.32em] text-os-dim">
        {' '}
        Control plane
      </p>
      <div className="mb-1 flex items-center gap-3">
        <h1 className="text-[28px] font-bold uppercase tracking-[0.06em]">
          Sandboxes<span className="caret-blink" />
        </h1>
        <Badge tone="accent">Phase 5</Badge>
      </div>
      <p className="mb-6 max-w-[74ch] text-[13px] text-os-muted">
        An isolated, persistent workspace — a git worktree on a named branch — that hosts one or
        more runs and stays alive until you shut it down. Parallelism is <em>across</em> sandboxes;
        runs in the <em>same</em> sandbox serialize. The cockpit only requests one — the engine-side
        worker (
        <code className="border border-os-border bg-os-surface2 px-1 text-[11.5px] text-os-text">just worker</code>)
        provisions the worktree and disposes; it never spawns from here.
      </p>

      {error ? (
        <DbError message={error} />
      ) : (
        <>
          <div className="mb-6">
            <NewSandboxButton />
          </div>

          {sandboxes.length === 0 ? (
            <EmptySandboxes />
          ) : (
            <div className="grid gap-px border border-os-border bg-os-border sm:grid-cols-2 xl:grid-cols-3">
              {sandboxes.map((sb) => (
                <SandboxCard key={sb.id} sb={sb} now={now} projectId={params.project} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SandboxCard({ sb, now, projectId }: { sb: Sandbox; now: number; projectId: string }) {
  const status = (sb.status ?? 'requested') as SandboxStatus;
  const tone = STATUS_TONE[status] ?? 'default';
  const terminal = TERMINAL_SANDBOX_STATUSES.includes(status);
  const shuttingDown = sb.shutdown_requested === 1 && !terminal;

  return (
    <div className="flex flex-col gap-2.5 bg-os-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <Badge tone={tone}>
          {BUSY.includes(status) && <span className="dot warn pulse" />}
          {status}
        </Badge>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-os-dim">
          {ago(sb.created_at, now)}
        </span>
      </div>

      <div className="flex items-baseline gap-2 font-mono">
        <span className="text-[13px] text-os-text">{sb.id}</span>
        {sb.level && <span className="text-[10px] uppercase tracking-[0.14em] text-os-dim">{sb.level}</span>}
      </div>

      <dl className="flex flex-col gap-1 font-mono text-[10.5px] text-os-dim">
        <Row term="branch">{sb.branch ?? '—'}</Row>
        <Row term="tip">{sb.tip_sha ?? <span className="text-os-dim">— no runs yet</span>}</Row>
        {sb.worktree_path && (
          <Row term="tree">
            <span className="break-all text-os-muted">{sb.worktree_path}</span>
          </Row>
        )}
      </dl>

      {sb.error && (
        <p className="font-mono text-[10.5px] text-os-err" title={sb.error}>
          {sb.error}
        </p>
      )}

      <div className="mt-1 flex items-center justify-between gap-2">
        {status === 'active' ? (
          <Link
            href={projectHref(projectId, `/queue`)}
            className="font-mono text-[10.5px] text-os-dim hover:text-os-accent"
            title="Launch a run into this sandbox from the Conductor"
          >
            run here →
          </Link>
        ) : (
          <span />
        )}
        {shuttingDown ? (
          <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-os-warn">
            shutting down…
          </span>
        ) : terminal ? (
          <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-os-dim">—</span>
        ) : (
          <ShutdownButton id={sb.id} />
        )}
      </div>
    </div>
  );
}

function Row({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-12 shrink-0 uppercase tracking-[0.14em] text-os-dim">{term}</dt>
      <dd className="min-w-0 flex-1 text-os-muted">{children}</dd>
    </div>
  );
}

function EmptySandboxes() {
  return (
    <div className="border border-dashed border-os-border-strong p-8 text-center font-mono text-[12px] text-os-dim">
      No sandboxes. Request one above, then run{' '}
      <span className="text-os-muted">just worker</span> to provision its worktree.
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
