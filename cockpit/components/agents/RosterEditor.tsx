'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Label } from '@/components/terminal';
import { compact, ago } from '@/lib/format';
import { CODING_AGENTS, THINKING_LEVELS } from '@/lib/roster-constants';
import type { AgentTelemetry } from '@/lib/types';

// The client mirror of lib/roster.ts's editable surface. Type-only so the
// server module (node:fs + yaml) never reaches the client bundle.
import type { RosterConfig, RosterAgent, RosterDefaults, RosterWarning } from '@/lib/roster';

type AgentPatch = Partial<Pick<RosterAgent, 'coding_agent' | 'model' | 'thinking' | 'color' | 'purpose'>>;
type DefaultsPatch = Partial<Pick<RosterDefaults, 'coding_agent' | 'model' | 'thinking'>>;

interface Props {
  roster: RosterConfig;
  telemetry: Record<string, AgentTelemetry>;
  warnings: RosterWarning[];
  now: number;
}

/**
 * The roster view + editor. Reads sssf.config.yaml (server) and edits the
 * allowlisted scalar fields (model, backend, thinking, color, purpose) by
 * POSTing a surgical patch to /api/roster, which rewrites the YAML in place
 * with its comments intact. The array fields (tools/writes) and the prompt/
 * harness wiring are the security + wiring boundary — shown read-only here and
 * left to a later, more careful write pass.
 */
export function RosterEditor({ roster, telemetry, warnings, now }: Props) {
  return (
    <div className="space-y-8">
      {warnings.length > 0 && (
        <div className="border border-os-warn/40 bg-[color-mix(in_oklab,var(--warn)_7%,transparent)] px-4 py-3">
          <div className="mb-1.5 font-mono text-[9.5px] font-bold uppercase tracking-[0.2em] text-os-warn">
            {warnings.length} config warning{warnings.length > 1 ? 's' : ''}
          </div>
          <ul className="space-y-1 font-mono text-[11.5px] text-os-muted">
            {warnings.map((w) => (
              <li key={`${w.agent}:${w.message}`}>
                <span className="text-os-text">{w.agent}</span> — {w.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <section>
        <div className="mb-3">
          <Label rule>Defaults</Label>
        </div>
        <DefaultsCard defaults={roster.defaults} />
      </section>

      <section>
        <div className="mb-3">
          <Label count={roster.agents.length} rule>
            Agents
          </Label>
        </div>
        <div className="grid grid-cols-1 gap-px border border-os-border bg-os-border lg:grid-cols-2">
          {roster.agents.map((agent) => (
            <AgentCard
              key={agent.name}
              agent={agent}
              telemetry={telemetry[agent.name] ?? null}
              inheritedBackend={roster.defaults.coding_agent}
              inheritedModel={roster.defaults.model}
              now={now}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

// ── Defaults ──────────────────────────────────────────────────────────────────

function DefaultsCard({ defaults }: { defaults: RosterDefaults }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DefaultsPatch>({});
  const { busy, error, save } = useSaver();

  const value = <K extends keyof DefaultsPatch>(k: K): DefaultsPatch[K] =>
    (draft[k] ?? defaults[k]) as DefaultsPatch[K];

  async function onSave() {
    const patch = diff(draft, defaults, ['coding_agent', 'model', 'thinking']);
    if (Object.keys(patch).length === 0) {
      setEditing(false);
      return;
    }
    const ok = await save({ defaults: patch });
    if (ok) {
      setEditing(false);
      setDraft({});
      router.refresh();
    }
  }

  return (
    <div className="border border-os-border bg-os-surface p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-[12px] font-bold tracking-[0.04em] text-os-text">
          Roster defaults
        </span>
        <EditToggle
          editing={editing}
          busy={busy}
          onEdit={() => setEditing(true)}
          onCancel={() => {
            setEditing(false);
            setDraft({});
          }}
          onSave={onSave}
        />
      </div>

      {editing ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <SelectField label="Backend" value={value('coding_agent') ?? 'pi'} options={CODING_AGENTS} onChange={(v) => setDraft((d) => ({ ...d, coding_agent: v as RosterDefaults['coding_agent'] }))} />
          <TextField label="Model" value={value('model') ?? ''} placeholder="provider/id" onChange={(v) => setDraft((d) => ({ ...d, model: v }))} />
          <SelectField label="Thinking" value={value('thinking') ?? 'medium'} options={THINKING_LEVELS} onChange={(v) => setDraft((d) => ({ ...d, thinking: v }))} />
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 font-mono text-[12px]">
          <KV k="backend" v={defaults.coding_agent} />
          <KV k="model" v={defaults.model} />
          <KV k="thinking" v={defaults.thinking} />
        </div>
      )}

      {/* Read-only structural fields — not editable from the cockpit (yet). */}
      <div className="mt-4 border-t border-os-hairline pt-3">
        <ReadOnlyChips label="Default tools" values={defaults.tools} nullLabel="all tools" />
        <ReadOnlyChips label="Protected files" values={defaults.protected_files} className="mt-2" />
      </div>

      {error && <ErrorLine>{error}</ErrorLine>}
    </div>
  );
}

// ── One agent ─────────────────────────────────────────────────────────────────

function AgentCard({
  agent,
  telemetry,
  inheritedBackend,
  inheritedModel,
  now,
}: {
  agent: RosterAgent;
  telemetry: AgentTelemetry | null;
  inheritedBackend: string;
  inheritedModel: string;
  now: number;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<AgentPatch>({});
  const { busy, error, save } = useSaver();

  const value = <K extends keyof AgentPatch>(k: K): AgentPatch[K] => (draft[k] ?? agent[k]) as AgentPatch[K];

  // Live guardrail: mirror lib/roster.ts's pi+anthropic smell against the draft
  // so the operator sees it before saving, not after a run fails.
  const draftBackend = (value('coding_agent') || inheritedBackend) as string;
  const draftModel = (value('model') || inheritedModel) as string;
  const piAnthropic = draftBackend === 'pi' && draftModel.startsWith('anthropic/');

  async function onSave() {
    const patch = diff(draft, agent, ['coding_agent', 'model', 'thinking', 'color', 'purpose']);
    if (Object.keys(patch).length === 0) {
      setEditing(false);
      return;
    }
    const ok = await save({ agents: { [agent.name]: patch } });
    if (ok) {
      setEditing(false);
      setDraft({});
      router.refresh();
    }
  }

  return (
    <div className="bg-os-surface p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <Swatch color={agent.color} />
          <div className="min-w-0">
            <div className="truncate font-mono text-[13px] font-bold tracking-[0.02em] text-os-text">
              {agent.name}
            </div>
            <BackendBadge backend={agent.coding_agent} />
          </div>
        </div>
        <EditToggle
          editing={editing}
          busy={busy}
          onEdit={() => setEditing(true)}
          onCancel={() => {
            setEditing(false);
            setDraft({});
          }}
          onSave={onSave}
        />
      </div>

      {editing ? (
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <SelectField label="Backend" value={value('coding_agent') ?? 'pi'} options={CODING_AGENTS} onChange={(v) => setDraft((d) => ({ ...d, coding_agent: v as RosterAgent['coding_agent'] }))} />
            <SelectField label="Thinking" value={value('thinking') ?? 'medium'} options={THINKING_LEVELS} onChange={(v) => setDraft((d) => ({ ...d, thinking: v }))} />
            <TextField label="Model" value={value('model') ?? ''} placeholder="provider/id" onChange={(v) => setDraft((d) => ({ ...d, model: v }))} />
            <TextField label="Color" value={value('color') ?? ''} placeholder="#a78bfa" onChange={(v) => setDraft((d) => ({ ...d, color: v }))} swatch />
          </div>
          <TextArea label="Purpose" value={value('purpose') ?? ''} onChange={(v) => setDraft((d) => ({ ...d, purpose: v }))} />
          {piAnthropic && (
            <p className="font-mono text-[11px] text-os-warn">
              ⚠ backend “pi” + an anthropic/* model — pi&apos;s Anthropic OAuth is expired here; use claude_code.
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-x-5 gap-y-1.5 font-mono text-[11.5px]">
            <KV k="model" v={agent.model} />
            <KV k="thinking" v={agent.thinking} />
          </div>
          {agent.purpose && <p className="mb-3 text-[12px] leading-relaxed text-os-muted">{agent.purpose}</p>}
          <div className="space-y-2">
            <ReadOnlyChips label="Tools" values={agent.tools} nullLabel="all tools" />
            <ReadOnlyChips label="Writes" values={agent.writes} nullLabel="unrestricted" emptyLabel="read-only" />
          </div>
          <TelemetryLine telemetry={telemetry} now={now} />
        </>
      )}

      {error && <ErrorLine>{error}</ErrorLine>}
    </div>
  );
}

// ── Shared save hook ──────────────────────────────────────────────────────────

function useSaver() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(body: unknown): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/roster', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `save failed (${res.status})`);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  return { busy, error, save };
}

/** Keep only keys whose draft value differs from the original. */
function diff<T extends Record<string, unknown>>(
  draft: Partial<T>,
  original: T,
  keys: (keyof T)[],
): Partial<T> {
  const patch: Partial<T> = {};
  for (const k of keys) {
    if (k in draft && draft[k] !== original[k]) patch[k] = draft[k] as T[keyof T];
  }
  return patch;
}

// ── Presentational bits ───────────────────────────────────────────────────────

function EditToggle({
  editing,
  busy,
  onEdit,
  onCancel,
  onSave,
}: {
  editing: boolean;
  busy: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  if (!editing) {
    return (
      <button
        onClick={onEdit}
        className="shrink-0 rounded-sm-t border border-os-border-strong px-2.5 py-[5px] font-mono text-[10px] uppercase tracking-[0.14em] text-os-dim transition-colors hover:border-os-accent hover:text-os-accent"
      >
        Edit
      </button>
    );
  }
  return (
    <div className="flex shrink-0 gap-1.5">
      <button
        onClick={onCancel}
        disabled={busy}
        className="rounded-sm-t border border-os-border-strong px-2.5 py-[5px] font-mono text-[10px] uppercase tracking-[0.14em] text-os-dim transition-colors hover:text-os-text disabled:opacity-40"
      >
        Cancel
      </button>
      <button
        onClick={onSave}
        disabled={busy}
        className="rounded-sm-t border border-[var(--accent-line)] bg-[var(--accent-soft)] px-2.5 py-[5px] font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-os-accent transition-opacity hover:opacity-80 disabled:opacity-40"
      >
        {busy ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <span className="whitespace-nowrap">
      <span className="text-os-dim">{k} </span>
      <span className="text-os-text">{v || '—'}</span>
    </span>
  );
}

function Swatch({ color }: { color: string }) {
  return (
    <span
      className="h-6 w-1.5 shrink-0 rounded-full"
      style={{ background: color || 'var(--os-border-strong, #333)' }}
      aria-hidden
    />
  );
}

function BackendBadge({ backend }: { backend: string }) {
  return <Badge tone={backend === 'claude_code' ? 'accent' : 'default'}>{backend}</Badge>;
}

function ReadOnlyChips({
  label,
  values,
  nullLabel,
  emptyLabel,
  className = '',
}: {
  label: string;
  values: string[] | null | undefined;
  nullLabel?: string;
  emptyLabel?: string;
  className?: string;
}) {
  const isNull = values == null;
  const isEmpty = Array.isArray(values) && values.length === 0;
  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className}`}>
      <span className="mr-1 font-mono text-[8.5px] uppercase tracking-[0.16em] text-os-dim">{label}</span>
      {isNull ? (
        <Badge ghost>{nullLabel ?? 'none'}</Badge>
      ) : isEmpty ? (
        <Badge ghost>{emptyLabel ?? 'none'}</Badge>
      ) : (
        values!.map((v) => (
          <span
            key={v}
            className="rounded-sm-t border border-os-hairline bg-os-bg px-1.5 py-[2px] font-mono text-[10px] text-os-muted"
          >
            {v}
          </span>
        ))
      )}
    </div>
  );
}

function TelemetryLine({ telemetry, now }: { telemetry: AgentTelemetry | null; now: number }) {
  if (!telemetry || telemetry.runs === 0) {
    return (
      <p className="mt-3 border-t border-os-hairline pt-2.5 font-mono text-[10.5px] text-os-dim">
        never run
      </p>
    );
  }
  const pct =
    telemetry.context_tokens != null && telemetry.context_window
      ? Math.round((telemetry.context_tokens / telemetry.context_window) * 100)
      : null;
  return (
    <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-os-hairline pt-2.5 font-mono text-[10.5px] text-os-dim">
      <span>
        last <span className="text-os-muted">{telemetry.last_model ?? '—'}</span>
      </span>
      <span>{telemetry.runs} run{telemetry.runs > 1 ? 's' : ''}</span>
      {telemetry.context_tokens != null && (
        <span>
          ctx <span className="text-os-muted">{compact(telemetry.context_tokens)}</span>
          {pct != null && ` · ${pct}%`}
        </span>
      )}
      <span>{ago(telemetry.last_used_at, now)}</span>
    </p>
  );
}

function ErrorLine({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-3 border border-os-err/40 bg-[color-mix(in_oklab,var(--err)_7%,transparent)] px-3 py-2 font-mono text-[11px] text-os-err">
      {children}
    </p>
  );
}

// ── Inputs ────────────────────────────────────────────────────────────────────

function FieldShell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[8.5px] uppercase tracking-[0.16em] text-os-dim">{label}</span>
      {children}
    </label>
  );
}

const inputCls =
  'w-full border border-os-border bg-os-bg px-2 py-[7px] font-mono text-[12px] text-os-text outline-none focus:border-os-border-strong';

function TextField({
  label,
  value,
  onChange,
  placeholder,
  swatch = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  swatch?: boolean;
}) {
  return (
    <FieldShell label={label}>
      <span className="flex items-center gap-2">
        {swatch && (
          <span
            className="h-[26px] w-[26px] shrink-0 rounded-sm-t border border-os-border"
            style={{ background: value || 'transparent' }}
            aria-hidden
          />
        )}
        <input
          type="text"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={inputCls}
          spellCheck={false}
        />
      </span>
    </FieldShell>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
}) {
  return (
    <FieldShell label={label}>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={inputCls}>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

function TextArea({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <FieldShell label={label}>
      <textarea
        value={value}
        rows={2}
        onChange={(e) => onChange(e.target.value)}
        className={`${inputCls} resize-y leading-relaxed`}
      />
    </FieldShell>
  );
}
