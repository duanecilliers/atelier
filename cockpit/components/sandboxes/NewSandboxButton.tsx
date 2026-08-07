'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useProjectId } from '@/lib/use-project';
import { withProject } from '@/lib/project-url';
import type { SandboxLaunchOption, ProvisionableSandboxLevel } from '@/lib/roster';

/**
 * Request a new sandbox. POSTs to /api/sandboxes, which INSERTs a `requested`
 * `sandboxes` row — it never spawns anything. The worker (just worker) provisions
 * a git worktree and flips it to `active`. Optimistic; the real row arrives on the
 * next live refresh.
 *
 * Two operator inputs beyond the level picker:
 *  - purpose (optional) — a human description. When set, the branch is left unset
 *    at create and the worker names it from the purpose via a cheap model
 *    (branch_namer.py) → e.g. `feat/api-rate-limiting`, falling back to `adw/<id>`.
 *  - level — worktree (L1) or worktree_env (L2), preselected from `sandbox.default`.
 * The branch itself is minted server-/worker-side; the button sends only intent.
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

  const selected = levels.find((l) => l.level === level) ?? levels[0];
  const trimmedPurpose = purpose.trim();
  // The branch hint: a purpose defers naming to the worker; otherwise preview the
  // level's template (id filled in at create). Only shown when it says something —
  // a purpose, a picker, or a non-default template.
  const branchPreview = selected?.branchTemplate.replaceAll('${SANDBOX_ID}', '…');
  const showTemplateHint =
    !trimmedPurpose &&
    (levels.length > 1 || (selected != null && selected.branchTemplate !== 'adw/${SANDBOX_ID}'));

  async function create() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(withProject('/api/sandboxes', projectId), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ level, purpose: trimmedPurpose || undefined }),
      });
      const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!res.ok || !data.id) throw new Error(data.error ?? `create failed (${res.status})`);
      setPurpose('');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

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
          className="min-w-[16rem] flex-1 rounded-sm-t border border-os-border bg-os-surface2 px-3 py-[7px] font-mono text-[11.5px] text-os-text placeholder:text-os-dim focus:border-[var(--accent-line)] focus:outline-none disabled:opacity-40"
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
          disabled={busy}
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
      {trimmedPurpose ? (
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
