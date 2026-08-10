'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AGENT_ROSTER, inferAdw, type AdwSpec } from '@/lib/adws';
import { useProjectId } from '@/lib/use-project';
import { projectHref, withProject } from '@/lib/project-url';
import type { SandboxLaunchOption, ProvisionableSandboxLevel } from '@/lib/roster';

// The Sandbox dropdown's sentinel for "spin up a fresh sandbox and run inside it".
// Distinct from '' (local run) and from any real sandbox id (8 hex chars).
const NEW_SANDBOX = '__new__';

/**
 * The Conductor dock — the cockpit's launcher. Describe the work; Atelier infers
 * the ADW from the text (light NL), and you can override the pick. Submitting
 * POSTs a launch spec to /api/queue — it enqueues a run_queue row, it never
 * spawns anything. The worker (just worker) drains the row into a real run.
 *
 * `catalog` is built live from the ADWs on disk (see app/queue/page.tsx), so an
 * ADW composed in /skills shows up here without a code change. `sandboxes` are the
 * project's ACTIVE sandboxes — pick one to run the ADW inside its isolated worktree
 * (a serialized follow-up run); the default is a local run at REPO_ROOT. Picking
 * "＋ New sandbox" spins up a fresh sandbox AND runs inside it in one launch — the
 * run's request also names its branch (worker-side), so there's nothing extra to type.
 */
export type SandboxOption = { id: string; branch: string | null };

export function QueueLauncher({
  catalog,
  sandboxes = [],
  sandboxLevels = [],
  defaultSandboxLevel = 'worktree',
}: {
  catalog: AdwSpec[];
  sandboxes?: SandboxOption[];
  /** The provisionable levels the "＋ New sandbox" option may create (from config). */
  sandboxLevels?: SandboxLaunchOption[];
  defaultSandboxLevel?: ProvisionableSandboxLevel;
}) {
  const router = useRouter();
  const projectId = useProjectId();
  const [request, setRequest] = useState('');
  const [manualAdw, setManualAdw] = useState<string | null>(null);
  const [agent, setAgent] = useState<string>('scout');
  // '' = local run · NEW_SANDBOX = create+run · else an existing sandbox id.
  const [sandboxId, setSandboxId] = useState<string>('');
  const [newLevel, setNewLevel] = useState<ProvisionableSandboxLevel>(defaultSandboxLevel);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [launched, setLaunched] = useState<{ id: number; adw_id: string; sandbox_id?: string } | null>(null);

  const creatingSandbox = sandboxId === NEW_SANDBOX;

  // The inferred ADW follows the text until the operator overrides it. Fall back
  // to the first catalog entry if inference names an ADW not on disk.
  const inferred = useMemo(() => inferAdw(request), [request]);
  const adwName = manualAdw ?? inferred;
  const spec = catalog.find((a) => a.name === adwName) ?? catalog[0];

  async function launch() {
    const trimmed = request.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    setLaunched(null);
    try {
      const res = await fetch(withProject('/api/queue', projectId), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          adw_name: adwName,
          request: trimmed,
          agent: spec?.usesAgent ? agent : null,
          // Create+run a fresh sandbox, attach to an existing one, or a local run.
          new_sandbox: creatingSandbox ? { level: newLevel } : null,
          sandbox_id: creatingSandbox ? null : sandboxId || null,
          requested_by: 'cockpit',
        }),
      });
      const data = (await res.json()) as {
        id?: number;
        adw_id?: string;
        sandbox_id?: string;
        error?: string;
      };
      if (!res.ok || data.id == null || !data.adw_id) {
        throw new Error(data.error ?? `enqueue failed (${res.status})`);
      }
      setLaunched({ id: data.id, adw_id: data.adw_id, sandbox_id: data.sandbox_id });
      setRequest('');
      setManualAdw(null);
      // A just-created sandbox is one-shot: fall back to local so a second launch
      // doesn't silently spin up another. Attaching to an existing one persists (a
      // deliberate follow-up run in the same worktree).
      if (creatingSandbox) setSandboxId('');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border border-os-border bg-os-surface">
      <div className="flex items-center gap-2 border-b border-os-hairline px-4 py-2.5">
        <span className="dot ok pulse" />
        <span className="font-mono text-[10px] font-bold uppercase tracking-[0.24em] text-os-dim">
          Conductor
        </span>
        <span className="ml-auto font-mono text-[10px] text-os-dim">
          picks an ADW from your ask · override anytime
        </span>
      </div>

      <div className="p-4">
        <textarea
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') launch();
          }}
          rows={3}
          placeholder="Describe the work — e.g. “plan + build a /health endpoint”, or “scout where auth is handled”"
          className="w-full resize-y border border-os-border bg-os-bg px-3 py-2.5 font-mono text-[13px] leading-relaxed text-os-text outline-none placeholder:text-os-dim focus:border-os-border-strong"
        />

        <div className="mt-3 flex flex-wrap items-end gap-3">
          <Field label="ADW">
            <select
              value={adwName}
              onChange={(e) => setManualAdw(e.target.value)}
              className="min-w-[150px] border border-os-border bg-os-bg px-2 py-[7px] font-mono text-[12px] text-os-text outline-none focus:border-os-border-strong"
            >
              {catalog.map((a) => (
                <option key={a.name} value={a.name}>
                  {a.label}
                </option>
              ))}
            </select>
          </Field>

          {spec?.usesAgent && (
            <Field label="Agent">
              <select
                value={agent}
                onChange={(e) => setAgent(e.target.value)}
                className="min-w-[120px] border border-os-border bg-os-bg px-2 py-[7px] font-mono text-[12px] text-os-text outline-none focus:border-os-border-strong"
              >
                {AGENT_ROSTER.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <Field label="Sandbox">
            <select
              value={sandboxId}
              onChange={(e) => setSandboxId(e.target.value)}
              className="min-w-[150px] border border-os-border bg-os-bg px-2 py-[7px] font-mono text-[12px] text-os-text outline-none focus:border-os-border-strong"
              title="Run inside an isolated worktree (serialized), spin up a fresh one, or locally at the repo root"
            >
              <option value="">local (repo root)</option>
              <option value={NEW_SANDBOX}>＋ new sandbox</option>
              {sandboxes.length > 0 && (
                <optgroup label="attach to active">
                  {sandboxes.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.id}
                      {s.branch ? ` · ${s.branch}` : ''}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </Field>

          {creatingSandbox && sandboxLevels.length > 1 && (
            <Field label="Level">
              <div className="flex items-center gap-px rounded-sm-t border border-os-border bg-os-border">
                {sandboxLevels.map((l) => {
                  const on = l.level === newLevel;
                  return (
                    <button
                      key={l.level}
                      type="button"
                      onClick={() => setNewLevel(l.level)}
                      aria-pressed={on}
                      title={
                        l.level === 'worktree'
                          ? 'L1 — write isolation: a persistent branch workspace'
                          : 'L2 — worktree + isolated deps, ports, services, env'
                      }
                      className={`px-2.5 py-[6px] font-mono text-[10.5px] font-bold uppercase tracking-[0.12em] transition-colors ${
                        on
                          ? 'bg-[var(--accent-soft)] text-os-accent'
                          : 'bg-os-surface text-os-dim hover:text-os-muted'
                      }`}
                    >
                      {l.level}
                    </button>
                  );
                })}
              </div>
            </Field>
          )}

          <div className="min-w-0 flex-1 self-center pt-4 font-mono text-[11px] text-os-dim">
            {creatingSandbox ? (
              <span>
                runs in a fresh sandbox · its branch is named from your request (e.g.{' '}
                <span className="text-os-muted">feat/…</span>)
              </span>
            ) : (
              <>
                {spec?.blurb}
                {!manualAdw && request.trim() && (
                  <span className="ml-1.5 text-os-muted">· inferred</span>
                )}
              </>
            )}
          </div>

          <button
            onClick={launch}
            aria-label="Launch: enqueue this run for the worker to pick up"
            disabled={busy || !request.trim() || !spec}
            className="rounded-sm-t border border-[var(--accent-line)] bg-[var(--accent-soft)] px-4 py-[7px] font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-os-accent transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? 'Launching…' : 'Launch ⌘⏎'}
          </button>
        </div>

        {error && (
          <p className="mt-3 border border-os-err/40 bg-[color-mix(in_oklab,var(--err)_7%,transparent)] px-3 py-2 font-mono text-[11.5px] text-os-err">
            {error}
          </p>
        )}
        {launched && (
          <p className="mt-3 border border-[color-mix(in_oklab,var(--ok)_30%,transparent)] bg-[color-mix(in_oklab,var(--ok)_7%,transparent)] px-3 py-2 font-mono text-[11.5px] text-os-ok">
            Queued run{' '}
            <Link href={projectHref(projectId, `/runs/${launched.adw_id}`)} className="underline underline-offset-2">
              {launched.adw_id}
            </Link>
            {launched.sandbox_id && (
              <>
                {' '}
                in new sandbox{' '}
                <Link href={projectHref(projectId, '/sandboxes')} className="underline underline-offset-2">
                  ⬡ {launched.sandbox_id}
                </Link>
              </>
            )}{' '}
            — the worker picks it up next. Start it with{' '}
            <code className="text-os-muted">just worker</code> if it isn&apos;t running.
          </p>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[8.5px] uppercase tracking-[0.16em] text-os-dim">{label}</span>
      {children}
    </label>
  );
}
