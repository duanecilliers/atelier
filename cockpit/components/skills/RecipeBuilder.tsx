'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * The recipe composer — the write counterpart to the read-only cookbook. Pick a
 * name and an ordered set of vetted phase blocks; Preview renders the Python the
 * engine's make_adw.py would generate; Create writes it to engine/adws/ (via
 * POST /api/adws, which shells out to that generator). A freshly-built recipe is
 * then a first-class ADW — it appears as a card here and is launchable from the
 * queue at once.
 *
 * Blocks are always shown and emitted in the generator's canonical order (you
 * cannot review before you build), so the only choice is which to include. The
 * client mirrors make_adw's rules for instant feedback, but the generator itself
 * is the authority — a rejected spec surfaces its stderr verbatim. Create is
 * gated behind a Preview, so nothing is written unreviewed (and no window.confirm,
 * which would block browser automation).
 */

interface Block {
  id: string;
  kind: 'agent' | 'code';
  owner: string;
  requires: string[];
  label: string;
  blurb: string;
}
interface Catalog {
  canonical: string[];
  blocks: Block[];
}

const NAME_RE = /^[a-z][a-z0-9_]*$/;

export function RecipeBuilder({ existingNames }: { existingNames: string[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  // Load the block catalog once the composer opens (make_adw is its authority).
  useEffect(() => {
    if (!open || catalog) return;
    fetch('/api/adws')
      .then(async (res) => {
        const data = (await res.json()) as Catalog & { error?: string };
        if (!res.ok) throw new Error(data.error ?? `failed to load blocks (${res.status})`);
        setCatalog(data);
      })
      .catch((e) => setCatalogError(e instanceof Error ? e.message : String(e)));
  }, [open, catalog]);

  // Steps in canonical order — the only order the generator accepts.
  const steps = useMemo(
    () => (catalog ? catalog.canonical.filter((id) => selected.has(id)) : []),
    [catalog, selected],
  );

  // Client-side validation, mirroring make_adw for instant feedback.
  const trimmed = name.trim();
  const specError = useMemo(() => {
    if (!catalog) return null;
    if (trimmed && !NAME_RE.test(trimmed)) return 'name: lowercase letters, digits and underscores, starting with a letter';
    if (trimmed && existingNames.includes(`adw_${trimmed}`)) return `adw_${trimmed} already exists`;
    if (steps.length === 0) return null; // nothing selected yet — not an error, just incomplete
    const has = new Set(steps);
    const byId = new Map(catalog.blocks.map((b) => [b.id, b]));
    if (!steps.some((id) => byId.get(id)?.kind === 'agent')) return 'add at least one agent phase';
    for (const id of steps) {
      for (const req of byId.get(id)?.requires ?? []) {
        if (!has.has(req)) return `"${id}" requires "${req}"`;
      }
    }
    // commit needs a plan or build to commit (an OR-dep the flat requires can't
    // express — mirrors make_adw.py, which is the authority).
    if (has.has('commit') && !has.has('plan') && !has.has('build')) return "commit needs a plan or build";
    return null;
  }, [catalog, trimmed, steps, existingNames]);

  const complete = trimmed.length > 0 && steps.length > 0 && !specError;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
    setPreview(null); // any change invalidates the shown source
    setCreated(null);
  }

  function reset() {
    setOpen(false);
    setName('');
    setSelected(new Set());
    setPreview(null);
    setError(null);
    setCreated(null);
  }

  async function post(body: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/adws', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as Record<string, unknown>;
      if (!res.ok) throw new Error((data.error as string) ?? `request failed (${res.status})`);
      return { ok: true, data };
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return { ok: false, data: {} };
    } finally {
      setBusy(false);
    }
  }

  async function onPreview() {
    if (!complete) return;
    const { ok, data } = await post({ name: trimmed, steps, preview: true });
    if (ok) setPreview(data.source as string);
  }

  async function onCreate() {
    if (!complete || !preview) return;
    const { ok, data } = await post({ name: trimmed, steps });
    if (ok) {
      setCreated(data.name as string);
      setSelected(new Set());
      setName('');
      setPreview(null);
      router.refresh(); // the new recipe card appears in the grid
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mb-3 flex w-full items-center justify-center gap-2 border border-dashed border-os-border-strong bg-os-surface py-3 font-mono text-[11px] uppercase tracking-[0.14em] text-os-dim transition-colors hover:border-os-accent hover:text-os-accent"
      >
        <span className="text-[14px] leading-none">+</span> Compose a recipe
      </button>
    );
  }

  return (
    <div className="mb-3 border border-os-border bg-os-surface p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-[12px] font-bold tracking-[0.04em] text-os-text">New recipe</span>
        <div className="flex shrink-0 gap-1.5">
          <button
            onClick={reset}
            disabled={busy}
            className="rounded-sm-t border border-os-border-strong px-2.5 py-[5px] font-mono text-[10px] uppercase tracking-[0.14em] text-os-dim transition-colors hover:text-os-text disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={onPreview}
            disabled={!complete || busy}
            className="rounded-sm-t border border-os-border-strong px-2.5 py-[5px] font-mono text-[10px] uppercase tracking-[0.14em] text-os-text transition-colors hover:border-os-accent hover:text-os-accent disabled:opacity-40"
          >
            {busy && !preview ? 'Rendering…' : 'Preview'}
          </button>
          <button
            onClick={onCreate}
            disabled={!complete || !preview || busy}
            className="rounded-sm-t border border-[var(--accent-line)] bg-[var(--accent-soft)] px-2.5 py-[5px] font-bold uppercase tracking-[0.14em] text-os-accent transition-opacity hover:opacity-80 disabled:opacity-40 font-mono text-[10px]"
            title={!preview ? 'Preview first' : undefined}
          >
            {busy && preview ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>

      {catalogError ? (
        <p className="font-mono text-[11px] text-os-err">{catalogError}</p>
      ) : !catalog ? (
        <p className="font-mono text-[11px] text-os-dim">Loading blocks…</p>
      ) : (
        <div className="space-y-3">
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[8.5px] uppercase tracking-[0.16em] text-os-dim">Name</span>
            <div className="flex items-center border border-os-border bg-os-bg focus-within:border-os-border-strong">
              <span className="pl-2 font-mono text-[12px] text-os-dim">adw_</span>
              <input
                type="text"
                value={name}
                placeholder="e.g. ship"
                spellCheck={false}
                autoFocus
                onChange={(e) => {
                  setName(e.target.value);
                  setPreview(null);
                  setCreated(null);
                }}
                className="w-full bg-transparent px-1 py-[7px] font-mono text-[12px] text-os-text outline-none placeholder:text-os-dim"
              />
            </div>
          </label>

          {/* Block palette — canonical order; toggle to include. */}
          <div>
            <span className="font-mono text-[8.5px] uppercase tracking-[0.16em] text-os-dim">Phases</span>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {catalog.blocks.map((b) => {
                const on = selected.has(b.id);
                return (
                  <button
                    key={b.id}
                    onClick={() => toggle(b.id)}
                    title={`${b.blurb}${b.requires.length ? ` (requires ${b.requires.join(', ')})` : ''}`}
                    className={
                      'rounded-sm-t border px-2 py-[5px] font-mono text-[11px] transition-colors ' +
                      (on
                        ? 'border-[var(--accent-line)] bg-[var(--accent-soft)] text-os-accent'
                        : 'border-os-border text-os-dim hover:border-os-border-strong hover:text-os-text')
                    }
                  >
                    {b.label}
                    <span className={'ml-1.5 text-[9px] ' + (on ? 'text-os-accent/70' : 'text-os-dim')}>
                      {b.kind === 'code' ? 'code' : b.owner}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* The chain as it will be written. */}
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 font-mono text-[11px]">
            <span className="rounded-sm-t border border-os-border-strong px-1.5 py-[3px] text-os-dim">request</span>
            {steps.map((id) => (
              <span key={id} className="flex items-center gap-1.5">
                <span className="text-os-dim">→</span>
                <span className="rounded-sm-t border border-os-border-strong px-1.5 py-[3px] text-os-text">{id}</span>
              </span>
            ))}
          </div>

          {specError && <p className="font-mono text-[10.5px] text-os-err">{specError}</p>}

          {preview && (
            <div>
              <span className="font-mono text-[8.5px] uppercase tracking-[0.16em] text-os-dim">
                Preview — engine/adws/adw_{trimmed}.py
              </span>
              <pre className="mt-1 max-h-[420px] overflow-auto border border-os-border bg-os-bg p-3 font-mono text-[10.5px] leading-relaxed text-os-muted">
                {preview}
              </pre>
            </div>
          )}

          {error && (
            <p className="border border-os-err/40 bg-[color-mix(in_oklab,var(--err)_7%,transparent)] px-3 py-2 font-mono text-[11px] text-os-err">
              {error}
            </p>
          )}
        </div>
      )}

      {created && (
        <p className="mt-3 border border-[color-mix(in_oklab,var(--ok)_30%,transparent)] bg-[color-mix(in_oklab,var(--ok)_7%,transparent)] px-3 py-2 font-mono text-[11px] text-os-ok">
          Created <code>{created}</code> — it&apos;s in the cookbook below and launchable from the queue.
        </p>
      )}
    </div>
  );
}
