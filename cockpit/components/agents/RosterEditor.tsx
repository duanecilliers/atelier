'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Label } from '@/components/terminal';
import { compact, ago } from '@/lib/format';
import { useProjectId } from '@/lib/use-project';
import { withProject } from '@/lib/project-url';
import {
  BUILTIN_TOOLS,
  CODING_AGENTS,
  THINKING_LEVELS,
  validateAgentName,
  validateToolName,
  validateWritePattern,
} from '@/lib/roster-constants';
import type { AgentTelemetry } from '@/lib/types';

// The client mirror of lib/roster.ts's editable surface. Type-only so the
// server module (node:fs + yaml) never reaches the client bundle.
import type { RosterConfig, RosterAgent, RosterDefaults, RosterWarning } from '@/lib/roster';

type AgentPatch = Partial<
  Pick<RosterAgent, 'coding_agent' | 'model' | 'thinking' | 'color' | 'purpose' | 'tools' | 'writes'>
>;
type DefaultsPatch = Partial<Pick<RosterDefaults, 'coding_agent' | 'model' | 'thinking' | 'tools'>>;

/** A list field's value: an explicit list, or null = the key is absent —
 *  `writes: null` is unrestricted, `tools: null` inherits defaults / all tools. */
type List = string[] | null;
const normList = (v: string[] | null | undefined): List => v ?? null;
function listEq(a: List, b: List): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

interface Props {
  roster: RosterConfig;
  telemetry: Record<string, AgentTelemetry>;
  warnings: RosterWarning[];
  now: number;
}

/**
 * The roster view + editor. Reads sssf.config.yaml (server) and edits the
 * allowlisted fields by POSTing a surgical patch to /api/roster, which rewrites
 * the YAML in place with its comments intact. Editable: the scalars (model,
 * backend, thinking, color, purpose) plus the security arrays — `tools` (per
 * agent + defaults) and `writes` (per agent, the permission allowlist enforced
 * in permissions.py). The prompt/harness paths and defaults.protected_files stay
 * read-only — a later pass.
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
              // The engine needs at least one agent; the last one can't be removed.
              canRemove={roster.agents.length > 1}
              now={now}
            />
          ))}
        </div>
        <AddAgentCard existingNames={roster.agents.map((a) => a.name)} />
      </section>
    </div>
  );
}

// ── Add an agent ──────────────────────────────────────────────────────────────

/**
 * The create surface — deliberately minimal: identity + the scalars. A new agent
 * is bootstrapped with starter prompt files and starts read-only (`writes: []`);
 * its tools, writes and prompts are then refined through the per-agent editor
 * above. Kept small on purpose so "add" and "configure" stay separate steps.
 */
function AddAgentCard({ existingNames }: { existingNames: string[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [backend, setBackend] = useState<(typeof CODING_AGENTS)[number]>('pi');
  const [model, setModel] = useState('');
  const [thinking, setThinking] = useState('medium');
  const [color, setColor] = useState('');
  const [purpose, setPurpose] = useState('');
  const { busy, error, request } = useSaver();

  // Live name validation: the slug rule, plus a collision check the server also
  // enforces — surfaced here so the operator sees it before submitting.
  const trimmed = name.trim();
  const nameErr = trimmed
    ? existingNames.includes(trimmed)
      ? `"${trimmed}" already exists`
      : validateAgentName(trimmed)
    : null;
  const canSave = trimmed.length > 0 && !nameErr && !busy;

  function reset() {
    setOpen(false);
    setName('');
    setBackend('pi');
    setModel('');
    setThinking('medium');
    setColor('');
    setPurpose('');
  }

  async function onSave() {
    if (!canSave) return;
    // Send only the fields the operator actually set; the rest inherit defaults.
    const body: Record<string, unknown> = { name: trimmed };
    if (backend !== 'pi') body.coding_agent = backend;
    if (model.trim()) body.model = model.trim();
    if (thinking !== 'medium') body.thinking = thinking;
    if (color.trim()) body.color = color.trim();
    if (purpose.trim()) body.purpose = purpose;
    const ok = await request('/api/roster', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (ok) {
      reset();
      router.refresh();
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-px flex w-full items-center justify-center gap-2 border border-dashed border-os-border-strong bg-os-surface py-3 font-mono text-[11px] uppercase tracking-[0.14em] text-os-dim transition-colors hover:border-os-accent hover:text-os-accent"
      >
        <span className="text-[14px] leading-none">+</span> Add agent
      </button>
    );
  }

  return (
    <div className="mt-px border border-os-border bg-os-surface p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-[12px] font-bold tracking-[0.04em] text-os-text">New agent</span>
        <div className="flex shrink-0 gap-1.5">
          <button
            onClick={reset}
            disabled={busy}
            className="rounded-sm-t border border-os-border-strong px-2.5 py-[5px] font-mono text-[10px] uppercase tracking-[0.14em] text-os-dim transition-colors hover:text-os-text disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={onSave}
            disabled={!canSave}
            className="rounded-sm-t border border-[var(--accent-line)] bg-[var(--accent-soft)] px-2.5 py-[5px] font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-os-accent transition-opacity hover:opacity-80 disabled:opacity-40"
          >
            {busy ? 'Adding…' : 'Add agent'}
          </button>
        </div>
      </div>

      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FieldShell label="Name">
            <input
              type="text"
              value={name}
              placeholder="e.g. critic"
              spellCheck={false}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSave) onSave();
              }}
              className={inputCls}
            />
          </FieldShell>
          <SelectField label="Backend" value={backend} options={CODING_AGENTS} onChange={(v) => setBackend(v as (typeof CODING_AGENTS)[number])} />
          <TextField label="Model" value={model} placeholder="provider/id — blank inherits defaults" onChange={setModel} />
          <SelectField label="Thinking" value={thinking} options={THINKING_LEVELS} onChange={setThinking} />
          <TextField label="Color" value={color} placeholder="#34d399" onChange={setColor} swatch />
        </div>
        <TextArea label="Purpose" value={purpose} onChange={setPurpose} />
        {nameErr && <p className="font-mono text-[10.5px] text-os-err">{nameErr}</p>}
        <p className="font-mono text-[10.5px] leading-snug text-os-dim">
          Bootstraps <code>prompt_engineering/{trimmed || '<name>'}/system.md</code> + <code>user.md</code> and
          starts <span className="text-os-muted">read-only</span> (writes: []). Set its tools, writes and prompts
          from the card above once added.
        </p>
      </div>

      {error && <ErrorLine>{error}</ErrorLine>}
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

  const curTools: List = 'tools' in draft ? (draft.tools as List) : normList(defaults.tools);

  async function onSave() {
    const patch = diff(draft, defaults, ['coding_agent', 'model', 'thinking']);
    if (!listEq(curTools, normList(defaults.tools))) patch.tools = curTools;
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
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <SelectField label="Backend" value={value('coding_agent') ?? 'pi'} options={CODING_AGENTS} onChange={(v) => setDraft((d) => ({ ...d, coding_agent: v as RosterDefaults['coding_agent'] }))} />
            <TextField label="Model" value={value('model') ?? ''} placeholder="provider/id" onChange={(v) => setDraft((d) => ({ ...d, model: v }))} />
            <SelectField label="Thinking" value={value('thinking') ?? 'medium'} options={THINKING_LEVELS} onChange={(v) => setDraft((d) => ({ ...d, thinking: v }))} />
          </div>
          <EditorGroup label="Default tools" hint="the roster-wide allowlist; any agent may override with its own list">
            <ToolsEditor
              value={curTools}
              onChange={(v) => setDraft((d) => ({ ...d, tools: v }))}
              fallback={defaults.tools ?? []}
              allLabel="all tools"
            />
          </EditorGroup>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 font-mono text-[12px]">
          <KV k="backend" v={defaults.coding_agent} />
          <KV k="model" v={defaults.model} />
          <KV k="thinking" v={defaults.thinking} />
        </div>
      )}

      {/* Tools is edited above in edit mode; shown read-only otherwise.
          protected_files stays read-only — a later pass. */}
      <div className="mt-4 border-t border-os-hairline pt-3">
        {!editing && <ReadOnlyChips label="Default tools" values={defaults.tools} nullLabel="all tools" />}
        <ReadOnlyChips label="Protected files" values={defaults.protected_files} className={editing ? '' : 'mt-2'} />
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
  canRemove,
  now,
}: {
  agent: RosterAgent;
  telemetry: AgentTelemetry | null;
  inheritedBackend: string;
  inheritedModel: string;
  canRemove: boolean;
  now: number;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<AgentPatch>({});
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const { busy, error, save, request } = useSaver();

  async function onRemove() {
    const ok = await request(`/api/roster?name=${encodeURIComponent(agent.name)}`, { method: 'DELETE' });
    if (ok) router.refresh();
  }

  const value = <K extends 'coding_agent' | 'model' | 'thinking' | 'color' | 'purpose'>(
    k: K,
  ): AgentPatch[K] => (draft[k] ?? agent[k]) as AgentPatch[K];

  const curTools: List = 'tools' in draft ? (draft.tools as List) : normList(agent.tools);
  const curWrites: List = 'writes' in draft ? (draft.writes as List) : normList(agent.writes);

  // Live guardrails: mirror lib/roster.ts's smells against the draft so the
  // operator sees them before saving, not after a run fails.
  const draftBackend = (value('coding_agent') || inheritedBackend) as string;
  const draftModel = (value('model') || inheritedModel) as string;
  const piAnthropic = draftBackend === 'pi' && draftModel.startsWith('anthropic/');
  // A harness extension whose tools are not named in an explicit list gets
  // filtered out (the agent inherits defaults.tools instead).
  const harnessNeedsTools = (agent.harness_engineering?.length ?? 0) > 0 && curTools === null;

  async function onSave() {
    const patch = diff(draft, agent, ['coding_agent', 'model', 'thinking', 'color', 'purpose']);
    if (!listEq(curTools, normList(agent.tools))) patch.tools = curTools;
    if (!listEq(curWrites, normList(agent.writes))) patch.writes = curWrites;
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
            setConfirmingRemove(false);
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

          <EditorGroup label="Writes" hint="what this agent may modify in the repo — enforced after every run in permissions.py">
            <WritesEditor
              value={curWrites}
              onChange={(v) => setDraft((d) => ({ ...d, writes: v }))}
              fallback={agent.writes ?? []}
            />
          </EditorGroup>

          <EditorGroup label="Tools" hint="capabilities for this agent; extension tools must be named here or they are filtered out">
            <ToolsEditor
              value={curTools}
              onChange={(v) => setDraft((d) => ({ ...d, tools: v }))}
              fallback={agent.tools ?? []}
              allLabel="inherit defaults"
            />
          </EditorGroup>

          {piAnthropic && (
            <p className="font-mono text-[11px] text-os-warn">
              ⚠ backend “pi” + an anthropic/* model — pi&apos;s Anthropic OAuth is expired here; use claude_code.
            </p>
          )}
          {harnessNeedsTools && (
            <p className="font-mono text-[11px] text-os-warn">
              ⚠ this agent loads a harness extension — with tools set to “inherit defaults”, its extension tools
              (e.g. subagent_*) are filtered out. Choose “specific tools” and name them.
            </p>
          )}

          <RemoveAgentControl
            name={agent.name}
            canRemove={canRemove}
            confirming={confirmingRemove}
            busy={busy}
            onAsk={() => setConfirmingRemove(true)}
            onCancel={() => setConfirmingRemove(false)}
            onConfirm={onRemove}
          />
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
  const projectId = useProjectId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // All roster writes scope to the current project — every url gets ?project=.
  async function request(url: string, init: RequestInit): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(withProject(url, projectId), init);
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** POST an allowlisted patch to /api/roster. */
  const save = (body: unknown): Promise<boolean> =>
    request('/api/roster', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  return { busy, error, save, request };
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

/**
 * Remove-agent affordance, lives at the foot of the edit panel. Two-step inline
 * confirm (no window.confirm — a browser modal would block automation and clash
 * with the terminal aesthetic). Disabled with a note when this is the last agent.
 */
function RemoveAgentControl({
  name,
  canRemove,
  confirming,
  busy,
  onAsk,
  onCancel,
  onConfirm,
}: {
  name: string;
  canRemove: boolean;
  confirming: boolean;
  busy: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!canRemove) {
    return (
      <div className="mt-1 border-t border-os-hairline pt-3">
        <p className="font-mono text-[10.5px] text-os-dim">
          the roster&apos;s last agent — can&apos;t be removed
        </p>
      </div>
    );
  }
  if (!confirming) {
    return (
      <div className="mt-1 border-t border-os-hairline pt-3">
        <button
          type="button"
          onClick={onAsk}
          className="font-mono text-[10px] uppercase tracking-[0.14em] text-os-dim transition-colors hover:text-os-err"
        >
          Remove agent
        </button>
      </div>
    );
  }
  return (
    <div className="mt-1 border-t border-os-hairline pt-3">
      <div className="border border-os-err/40 bg-[color-mix(in_oklab,var(--err)_6%,transparent)] px-3 py-2.5">
        <p className="mb-2 font-mono text-[11px] leading-snug text-os-muted">
          Remove <span className="font-bold text-os-text">{name}</span> from the roster? Its prompt files stay on
          disk (delete them by hand if you want them gone).
        </p>
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-sm-t border border-os-border-strong px-2.5 py-[5px] font-mono text-[10px] uppercase tracking-[0.14em] text-os-dim transition-colors hover:text-os-text disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="rounded-sm-t border border-os-err/60 bg-[color-mix(in_oklab,var(--err)_12%,transparent)] px-2.5 py-[5px] font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-os-err transition-opacity hover:opacity-80 disabled:opacity-40"
          >
            {busy ? 'Removing…' : 'Confirm remove'}
          </button>
        </div>
      </div>
    </div>
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

// ── List editors (the security arrays) ────────────────────────────────────────

/** A labelled block wrapping a non-<label> editor (buttons/inputs), with a hint. */
function EditorGroup({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-mono text-[8.5px] uppercase tracking-[0.16em] text-os-dim">{label}</span>
        {hint && <span className="font-mono text-[10px] leading-snug text-os-dim">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function Chip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-sm-t border border-os-hairline bg-os-bg px-1.5 py-[2px] font-mono text-[10.5px] text-os-muted">
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`remove ${label}`}
        className="text-os-dim transition-colors hover:text-os-err"
      >
        ×
      </button>
    </span>
  );
}

/** A segmented pill group — one active value out of a small fixed set. */
function Segmented({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="inline-flex rounded-sm-t border border-os-border">
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={
            'px-2.5 py-[5px] font-mono text-[10px] uppercase tracking-[0.12em] transition-colors ' +
            (i > 0 ? 'border-l border-os-border ' : '') +
            (value === o.value
              ? 'bg-[var(--accent-soft)] text-os-accent'
              : 'text-os-dim hover:text-os-muted')
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Edit a list of strings: removable chips for the current values, an add input
 * with per-entry validation, and — when given `suggestions` — a row of toggle
 * pills for a known vocabulary (the builtin tools). Suggestion members render as
 * toggles; anything else (extension tools, write patterns) renders as a chip.
 */
function StringListEditor({
  values,
  onChange,
  validate,
  suggestions = [],
  placeholder,
  addLabel = 'Add',
  emptyHint,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  validate?: (s: string) => string | null;
  suggestions?: readonly string[];
  placeholder?: string;
  addLabel?: string;
  emptyHint?: string;
}) {
  const [entry, setEntry] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const has = (v: string) => values.includes(v);
  const extras = values.filter((v) => !suggestions.includes(v));

  function commit(raw: string) {
    const v = raw.trim();
    if (!v) return;
    const e = validate?.(v) ?? null;
    if (e) {
      setErr(e);
      return;
    }
    if (!has(v)) onChange([...values, v]);
    setEntry('');
    setErr(null);
  }
  const remove = (v: string) => onChange(values.filter((x) => x !== v));

  return (
    <div className="space-y-2">
      {suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => (has(s) ? remove(s) : onChange([...values, s]))}
              className={
                has(s)
                  ? 'rounded-sm-t border border-[var(--accent-line)] bg-[var(--accent-soft)] px-2 py-[3px] font-mono text-[10.5px] text-os-accent'
                  : 'rounded-sm-t border border-os-border px-2 py-[3px] font-mono text-[10.5px] text-os-dim transition-colors hover:border-os-border-strong hover:text-os-muted'
              }
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {extras.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {extras.map((v) => (
            <Chip key={v} label={v} onRemove={() => remove(v)} />
          ))}
        </div>
      )}

      <div className="flex gap-1.5">
        <input
          type="text"
          value={entry}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(e) => {
            setEntry(e.target.value);
            if (err) setErr(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit(entry);
            }
          }}
          className={inputCls}
        />
        <button
          type="button"
          onClick={() => commit(entry)}
          className="shrink-0 rounded-sm-t border border-os-border-strong px-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-os-dim transition-colors hover:border-os-accent hover:text-os-accent"
        >
          {addLabel}
        </button>
      </div>

      {err && <p className="font-mono text-[10.5px] text-os-err">{err}</p>}
      {values.length === 0 && emptyHint && <p className="font-mono text-[10.5px] text-os-dim">{emptyHint}</p>}
    </div>
  );
}

/**
 * The `tools` editor: a specific allowlist, or the key removed. Removing it means
 * "all tools" on defaults and "inherit defaults" on an agent (agents.py merges
 * defaults.tools into an agent that omits its own). `fallback` seeds the list
 * when toggling back to specific so the original isn't lost.
 */
function ToolsEditor({
  value,
  onChange,
  fallback,
  allLabel,
}: {
  value: List;
  onChange: (v: List) => void;
  fallback: string[];
  allLabel: string;
}) {
  const specific = value !== null;
  return (
    <div className="space-y-2.5">
      <Segmented
        value={specific ? 'specific' : 'all'}
        onChange={(m) => onChange(m === 'all' ? null : (value ?? (fallback.length ? fallback : [])))}
        options={[
          { value: 'specific', label: 'Specific tools' },
          { value: 'all', label: allLabel },
        ]}
      />
      {specific && (
        <StringListEditor
          values={value ?? []}
          onChange={onChange}
          suggestions={BUILTIN_TOOLS}
          validate={validateToolName}
          placeholder="extension tool, e.g. subagent_create"
          emptyHint="no tools — this agent could do nothing; pick some above or add one"
        />
      )}
    </div>
  );
}

/**
 * The `writes` tri-state: unrestricted (key removed), read-only (`[]`), or an
 * allowlist of repo-relative patterns. `mode` is held locally so an allowlist
 * that momentarily empties stays in allowlist rather than snapping to read-only.
 */
function WritesEditor({
  value,
  onChange,
  fallback,
}: {
  value: List;
  onChange: (v: List) => void;
  fallback: string[];
}) {
  const [mode, setMode] = useState<'unrestricted' | 'readonly' | 'allowlist'>(
    value === null ? 'unrestricted' : value.length === 0 ? 'readonly' : 'allowlist',
  );
  function pick(m: string) {
    const mm = m as 'unrestricted' | 'readonly' | 'allowlist';
    setMode(mm);
    if (mm === 'unrestricted') onChange(null);
    else if (mm === 'readonly') onChange([]);
    else onChange(value && value.length ? value : fallback.length ? fallback : []);
  }
  return (
    <div className="space-y-2.5">
      <Segmented
        value={mode}
        onChange={pick}
        options={[
          { value: 'unrestricted', label: 'Unrestricted' },
          { value: 'readonly', label: 'Read-only' },
          { value: 'allowlist', label: 'Allowlist' },
        ]}
      />
      {mode === 'allowlist' && (
        <StringListEditor
          values={value ?? []}
          onChange={onChange}
          validate={validateWritePattern}
          placeholder="path or glob, e.g. specs/ or **/*.md"
          emptyHint="no paths yet — read-only until you add one"
        />
      )}
      {mode === 'unrestricted' && (
        <p className="font-mono text-[10.5px] text-os-warn">
          may modify any repo path except defaults.protected_files — grant sparingly.
        </p>
      )}
      {mode === 'readonly' && (
        <p className="font-mono text-[10.5px] text-os-dim">
          may modify nothing in the repo (it can still write its own report under data_dir).
        </p>
      )}
    </div>
  );
}
