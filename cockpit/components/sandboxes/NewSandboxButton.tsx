'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useProjectId } from '@/lib/use-project';
import { withProject } from '@/lib/project-url';
import { validateBranchName } from '@/lib/roster-constants';
import type { SandboxLaunchOption, ProvisionableSandboxLevel } from '@/lib/roster';

/**
 * Request a new sandbox. POSTs to /api/sandboxes, which INSERTs a `requested`
 * `sandboxes` row — it never spawns anything. The worker (just worker) provisions
 * a git worktree and flips it to `active`. Optimistic; the real row arrives on the
 * next live refresh.
 *
 * Three operator inputs beyond the level picker, in precedence order:
 *  - branch (optional) - an EXPLICIT branch name. Wins over everything: the worker
 *    checks it out verbatim if it already exists (fetch it first to base on origin),
 *    else forks it off HEAD. Use this for conventions the auto-namer can't produce
 *    (e.g. `feature/PROJ-233_...` - the namer lowercases and only emits feat/fix/…).
 *  - purpose (optional) - a human description that is always recorded. When set and
 *    no branch is given, the branch is left unset at create and the worker names it
 *    from the purpose via a cheap model (branch_namer.py) → e.g.
 *    `feat/api-rate-limiting`, `adw/<id>` fallback.
 *  - level — worktree (L1) or worktree_env (L2), preselected from `sandbox.default`.
 * The button sends only intent; the branch is resolved server-/worker-side.
 */
export function NewSandboxButton({
  levels,
  defaultLevel,
}: {
  levels: SandboxLaunchOption[];
  defaultLevel: ProvisionableSandboxLevel;
}) {
  const router = useRouter();
  const projectId = useProjectId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState<ProvisionableSandboxLevel>(defaultLevel);
  const [purpose, setPurpose] = useState('');
  const [branch, setBranch] = useState('');

  const selected = levels.find((l) => l.level === level) ?? levels[0];
  const trimmedPurpose = purpose.trim();
  const trimmedBranch = branch.trim();
  // An explicit branch overrides purpose-based naming (server precedence in
  // control.ts::createSandbox); validate it inline so a bad name never round-trips.
  const branchError = trimmedBranch ? validateBranchName(trimmedBranch) : null;
  const branchActive = trimmedBranch.length > 0;
  // The branch hint: a purpose defers naming to the worker; otherwise preview the
  // level's template (id filled in at create). Only shown when it says something —
  // a purpose, a picker, or a non-default template.
  const branchPreview = selected?.branchTemplate.replaceAll('${SANDBOX_ID}', '…');
  const showTemplateHint =
    !trimmedPurpose &&
    (levels.length > 1 || (selected != null && selected.branchTemplate !== 'adw/${SANDBOX_ID}'));

  async function create() {
    if (busy || branchError) return;
    setBusy(true);
    setError(null);
    try {
      // Branch wins naming precedence, but purpose is always recorded when provided.
      const body = {
        level,
        purpose: trimmedPurpose || undefined,
        ...(branchActive ? { branch: trimmedBranch } : {}),
      };
      const res = await fetch(withProject('/api/sandboxes', projectId), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!res.ok || !data.id) throw new Error(data.error ?? `create failed (${res.status})`);
      setPurpose('');
      setBranch('');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const inputClass =
    'rounded-sm-t border border-os-border bg-os-surface2 px-3 py-[7px] font-mono text-[11.5px] text-os-text placeholder:text-os-dim focus:border-[var(--accent-line)] focus:outline-none disabled:opacity-40';

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') create();
          }}
          disabled={busy}
          maxLength={500}
          placeholder="what's this sandbox for? (optional)"
          aria-label="Sandbox purpose"
          className={`min-w-[16rem] flex-1 ${inputClass}`}
        />
        <input
          type="text"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') create();
          }}
          disabled={busy}
          maxLength={200}
          placeholder="branch (optional, overrides naming)"
          aria-label="Sandbox branch (explicit override)"
          spellCheck={false}
          className={`min-w-[15rem] flex-1 ${inputClass} ${
            branchError ? 'border-os-err focus:border-os-err' : ''
          }`}
        />
        {levels.length > 1 && (
          <div className="flex items-center gap-px rounded-sm-t border border-os-border bg-os-border">
            {levels.map((l) => {
              const on = l.level === level;
              return (
                <button
                  key={l.level}
                  onClick={() => setLevel(l.level)}
                  disabled={busy}
                  aria-pressed={on}
                  title={
                    l.level === 'worktree'
                      ? 'L1 — write isolation: a persistent branch workspace'
                      : 'L2 — worktree + isolated deps, ports, services, env'
                  }
                  className={`px-3 py-[6px] font-mono text-[10.5px] font-bold uppercase tracking-[0.14em] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
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
        )}
        <button
          onClick={create}
          disabled={busy || !!branchError}
          className="rounded-sm-t border border-[var(--accent-line)] bg-[var(--accent-soft)] px-4 py-[7px] font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-os-accent transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? 'Requesting…' : '+ New sandbox'}
        </button>
        {error && (
          <span className="font-mono text-[11px] text-os-err" title={error}>
            {error}
          </span>
        )}
      </div>
      {branchActive ? (
        branchError ? (
          <span className="font-mono text-[10.5px] text-os-err">{branchError}</span>
        ) : (
          <span className="font-mono text-[10.5px] text-os-dim">
            uses <span className="text-os-muted">{trimmedBranch}</span> verbatim - checked out if it
            already exists (fetch it first to base on origin), else created off HEAD
            {trimmedPurpose ? '; purpose recorded separately' : ''}
          </span>
        )
      ) : trimmedPurpose ? (
        <span className="font-mono text-[10.5px] text-os-dim">
          branch named from your description at provision (e.g.{' '}
          <span className="text-os-muted">feat/…</span>)
        </span>
      ) : (
        showTemplateHint &&
        branchPreview && (
          <span className="font-mono text-[10.5px] text-os-dim">
            branches from <span className="text-os-muted">{branchPreview}</span>
          </span>
        )
      )}
    </div>
  );
}
