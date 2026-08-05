import { Badge, Label, type BadgeTone } from '@/components/terminal';
import { GatePanel } from '@/components/run/GatePanel';
import { EnvelopePanel } from '@/components/run/EnvelopePanel';
import { ModelBadge } from '@/components/run/ModelBadge';
import { compact, duration, usd4 } from '@/lib/format';
import type { CompiledPrompts } from '@/lib/prompts';
import type {
  AgentEndPayload,
  AgentStartPayload,
  Envelope,
  Event,
  GateResult,
  Phase,
  ToolCallPayload,
  UsageBreakdown,
} from '@/lib/types';

/**
 * The per-phase drill-down. Selecting a block in the Waterfall opens this: the
 * one phase, read in depth — its agent config, the EXACT prompts it was sent, its
 * per-component cost, the gates that judged it, the envelope it produced, and its
 * own event stream (tool calls expandable to args + result). Everything is
 * already loaded on the run page; this is a scoped view of it, server-rendered.
 * The compiled prompts come off disk (lib/prompts.ts) — the db has no copy.
 */

const STATUS_TONE: Record<string, BadgeTone> = { success: 'ok', running: 'warn', fail: 'err', queued: 'default' };
const NUM = new Intl.NumberFormat('en-US');

function parse<T>(json: string | null): T | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

function clockOf(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 8);
}

interface UsageRow {
  label: string;
  tokens: number;
  cost: number;
  kind?: 'total' | 'nested';
}

/** Build the per-component cost rows from an agent_end payload, or null. */
function usageRows(end: Event | undefined): { rows: UsageRow[]; partial: boolean } | null {
  if (!end) return null;
  const payload = parse<AgentEndPayload>(end.payload_json) ?? {};
  const u: UsageBreakdown | undefined = payload.usage;
  if (!u) {
    // Pre-breakdown run: the event's own token count + the lump cost still hold.
    return { partial: true, rows: [{ label: 'total', tokens: end.tokens ?? 0, cost: payload.cost ?? 0, kind: 'total' }] };
  }
  const rows: UsageRow[] = [
    { label: 'input', tokens: u.input_tokens, cost: u.input_cost },
    { label: 'output', tokens: u.output_tokens, cost: u.output_cost },
  ];
  if (u.reasoning_tokens) {
    // Thinking is INSIDE output, billed at the output rate — nest it, don't add it.
    const share = u.output_tokens ? (u.output_cost * u.reasoning_tokens) / u.output_tokens : 0;
    rows.push({ label: 'thinking', tokens: u.reasoning_tokens, cost: share, kind: 'nested' });
  }
  rows.push(
    { label: 'cache read', tokens: u.cache_read_tokens, cost: u.cache_read_cost },
    { label: 'cache write', tokens: u.cache_write_tokens, cost: u.cache_write_cost },
    { label: 'total', tokens: u.total_tokens, cost: u.total_cost, kind: 'total' },
  );
  return { rows, partial: false };
}

export function PhaseDetail({
  phase,
  events,
  envelopes,
  gates,
  prompts,
}: {
  phase: Phase;
  events: Event[];
  envelopes: Envelope[];
  gates: GateResult[];
  prompts: CompiledPrompts | null;
}) {
  const status = phase.status ?? 'queued';
  const phaseEvents = events
    .filter((e) => e.phase_id === phase.phase_id)
    .sort((a, b) => a.rowid - b.rowid);
  const phaseGates = gates.filter((g) => g.phase_id === phase.phase_id);
  const phaseEnvelopes = envelopes.filter((e) => e.phase_id === phase.phase_id);

  const start = phaseEvents.find((e) => e.type === 'agent_start');
  const config = start ? parse<AgentStartPayload>(start.payload_json) : null;
  const cost = usageRows(phaseEvents.find((e) => e.type === 'agent_end'));

  const promptPanels = [
    { id: 'system', title: 'system prompt', text: prompts?.system ?? null },
    { id: 'user', title: 'user prompt', text: prompts?.user ?? null },
  ].filter((p): p is { id: string; title: string; text: string } => p.text != null);

  return (
    <section className="mb-8 border border-os-accent/40 bg-os-bg2">
      {/* header */}
      <div className="flex flex-wrap items-center gap-3 border-b border-os-border px-4 py-3">
        <span className="font-mono text-[15px] font-bold text-os-text">{phase.name}</span>
        <Badge tone={STATUS_TONE[status] ?? 'default'}>{status}</Badge>
        <span className="font-mono text-[10px] text-os-dim">{duration(phase.started_at, phase.ended_at)}</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Tag k="kind" v={phase.kind ?? '—'} />
          <Tag k="owner" v={phase.owner ?? '—'} />
          <Tag k="attempt" v={`${phase.attempt ?? 0}/${phase.retries ?? 0}`} />
        </div>
      </div>

      {phase.error && (
        <pre className="mx-4 mt-4 whitespace-pre-wrap border border-os-err/40 bg-[color-mix(in_oklab,var(--err)_7%,transparent)] p-3 font-mono text-[11px] text-os-err">
          {phase.error}
        </pre>
      )}

      <div className="px-4 py-4">
        {phase.description && <p className="mb-5 max-w-[90ch] text-[12.5px] text-os-muted">{phase.description}</p>}

        {/* agent config + cost, side by side on wide screens */}
        {(config || cost) && (
          <div className="mb-6 grid gap-6 lg:grid-cols-2">
            {config && (
              <div>
                <Label>Agent config</Label>
                <dl className="mt-2 flex flex-col gap-1.5 font-mono text-[11.5px]">
                  {config.coding_agent && <Row k="backend" v={config.coding_agent} />}
                  {config.model && (
                    <div className="flex gap-3">
                      <dt className="w-[92px] shrink-0 text-os-dim">model</dt>
                      <dd className="min-w-0">
                        <ModelBadge model={config.model} className="text-[11.5px]" />
                      </dd>
                    </div>
                  )}
                  {config.thinking && <Row k="thinking" v={config.thinking} />}
                  {config.tools !== undefined && (
                    <Row k="tools" v={config.tools === null ? 'all tools' : (config.tools.join(', ') || 'none')} />
                  )}
                  {config.purpose && <Row k="purpose" v={config.purpose} />}
                  {config.session_id && <Row k="session" v={config.session_id} />}
                </dl>
              </div>
            )}

            {cost && (
              <div>
                <Label>Cost</Label>
                <table className="mt-2 w-full max-w-[360px] border-collapse font-mono text-[11.5px]">
                  <thead>
                    <tr className="text-[8.5px] uppercase tracking-[0.14em] text-os-dim">
                      <th className="py-1 text-left font-normal" />
                      <th className="py-1 text-right font-normal">tokens</th>
                      <th className="py-1 text-right font-normal">cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cost.rows.map((r) => (
                      <tr
                        key={r.label}
                        className={
                          r.kind === 'total'
                            ? 'border-t border-os-border font-bold'
                            : r.kind === 'nested'
                              ? 'text-os-dim'
                              : ''
                        }
                      >
                        <td className={`py-1 ${r.kind === 'nested' ? 'pl-4' : ''} text-os-muted`}>{r.label}</td>
                        <td className="py-1 text-right tabular-nums text-os-muted">{NUM.format(r.tokens)}</td>
                        <td className="py-1 text-right tabular-nums text-os-ok">{usd4(r.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {cost.partial && (
                  <p className="mt-2 font-mono text-[10px] text-os-dim">
                    predates the per-component breakdown — only the total was recorded
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {/* compiled prompts — the exact text sent to the model, off disk */}
        {phase.kind === 'agent' && (
          <div className="mb-6">
            <Label count={promptPanels.length}>Compiled prompts</Label>
            {promptPanels.length === 0 ? (
              <p className="mt-2 font-mono text-[11px] text-os-dim">no compiled prompts recorded for this phase</p>
            ) : (
              <div className="mt-2 flex flex-col gap-2">
                {promptPanels.map((panel) => (
                  <details key={panel.id} className="border border-os-border bg-os-bg">
                    <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 font-mono text-[11.5px] text-os-text marker:text-os-dim">
                      <span className="font-semibold">{panel.title}</span>
                      <span className="text-os-dim">{panel.text.split('\n').length} lines</span>
                    </summary>
                    <pre className="max-h-[50vh] overflow-auto border-t border-os-hairline px-3 py-3 font-mono text-[11px] leading-relaxed text-os-muted">
                      {panel.text}
                    </pre>
                  </details>
                ))}
              </div>
            )}
          </div>
        )}

        {/* gates + outputs, scoped to this phase (reused panels) */}
        {phaseGates.length > 0 && <GatePanel gates={phaseGates} />}
        {phaseEnvelopes.length > 0 && <EnvelopePanel envelopes={phaseEnvelopes} />}

        {/* the phase's own event stream */}
        <div>
          <Label count={phaseEvents.length}>Events</Label>
          <div className="mt-2 border border-os-border">
            {phaseEvents.length === 0 ? (
              <div className="px-4 py-4 font-mono text-[11px] text-os-dim">no events</div>
            ) : (
              phaseEvents.map((e) => <EventLine key={e.event_id} event={e} />)
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function EventLine({ event }: { event: Event }) {
  const call = event.type === 'tool_call' ? parse<ToolCallPayload>(event.payload_json) : null;
  const failed = call?.ok === false;

  const head = (
    <>
      <span
        className={`w-[92px] shrink-0 font-mono text-[9px] uppercase tracking-[0.08em] ${
          failed || event.type === 'gate_fail' || event.type === 'error' ? 'text-os-err' : 'text-os-dim'
        }`}
      >
        {event.type}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-os-muted" title={event.name ?? ''}>
        {event.name}
      </span>
      {call?.duration_ms != null && (
        <span className="shrink-0 font-mono text-[9.5px] tabular-nums text-os-dim">{call.duration_ms}ms</span>
      )}
      <span className="shrink-0 font-mono text-[9.5px] tabular-nums text-os-dim">
        {clockOf(event.started_at ?? event.ended_at)}
      </span>
    </>
  );

  // Tool calls expand to their args + result; other events stay one-liners.
  if (call && (call.args || call.result_snippet)) {
    return (
      <details className="border-t border-os-hairline first:border-t-0">
        <summary className="flex cursor-pointer items-center gap-2.5 px-4 py-1.5 marker:text-os-dim">{head}</summary>
        <div className="border-t border-os-hairline bg-os-bg px-4 py-3">
          {call.args && (
            <>
              <div className="mb-1 font-mono text-[8.5px] uppercase tracking-[0.14em] text-os-dim">args</div>
              <pre className="mb-3 max-h-[32vh] overflow-auto font-mono text-[10.5px] text-os-muted">
                {JSON.stringify(call.args, null, 2)}
              </pre>
            </>
          )}
          {call.result_snippet && (
            <>
              <div className="mb-1 font-mono text-[8.5px] uppercase tracking-[0.14em] text-os-dim">result</div>
              <pre className="max-h-[32vh] overflow-auto font-mono text-[10.5px] text-os-muted">
                {call.result_snippet}
              </pre>
            </>
          )}
        </div>
      </details>
    );
  }

  return <div className="flex items-center gap-2.5 border-t border-os-hairline px-4 py-1.5 first:border-t-0">{head}</div>;
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-3">
      <dt className="w-[92px] shrink-0 text-os-dim">{k}</dt>
      <dd className="min-w-0 break-words text-os-muted">{v}</dd>
    </div>
  );
}

function Tag({ k, v }: { k: string; v: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5 rounded-sm-t border border-os-border-strong px-2 py-[2px] font-mono text-[10px]">
      <span className="text-os-dim">{k}</span>
      <span className="text-os-text">{v}</span>
    </span>
  );
}
