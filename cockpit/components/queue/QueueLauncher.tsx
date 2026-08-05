'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AGENT_ROSTER, inferAdw, type AdwSpec } from '@/lib/adws';
import { useProjectId } from '@/lib/use-project';
import { projectHref, withProject } from '@/lib/project-url';

/**
 * The Conductor dock — the cockpit's launcher. Describe the work; Atelier infers
 * the ADW from the text (light NL), and you can override the pick. Submitting
 * POSTs a launch spec to /api/queue — it enqueues a run_queue row, it never
 * spawns anything. The worker (just worker) drains the row into a real run.
 *
 * `catalog` is built live from the ADWs on disk (see app/queue/page.tsx), so an
 * ADW composed in /skills shows up here without a code change.
 */
export function QueueLauncher({ catalog }: { catalog: AdwSpec[] }) {
  const router = useRouter();
  const projectId = useProjectId();
  const [request, setRequest] = useState('');
  const [manualAdw, setManualAdw] = useState<string | null>(null);
  const [agent, setAgent] = useState<string>('scout');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [launched, setLaunched] = useState<{ id: number; adw_id: string } | null>(null);

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
          requested_by: 'cockpit',
        }),
      });
      const data = (await res.json()) as { id?: number; adw_id?: string; error?: string };
      if (!res.ok || data.id == null || !data.adw_id) {
        throw new Error(data.error ?? `enqueue failed (${res.status})`);
      }
      setLaunched({ id: data.id, adw_id: data.adw_id });
      setRequest('');
      setManualAdw(null);
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

          <div className="min-w-0 flex-1 self-center pt-4 font-mono text-[11px] text-os-dim">
            {spec?.blurb}
            {!manualAdw && request.trim() && (
              <span className="ml-1.5 text-os-muted">· inferred</span>
            )}
          </div>

          <button
            onClick={launch}
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
            </Link>{' '}
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
