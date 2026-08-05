import { Badge, Label, type BadgeTone } from '@/components/terminal';
import type { Envelope } from '@/lib/types';

/**
 * The typed envelopes agents emitted — the "propose" half of the contract. Every
 * agent returns a Pydantic-validated JSON envelope, not prose; this renders the
 * parsed fields (status, summary, artifacts, notes) plus the raw payload. Only
 * valid envelopes are shown; a run's invalid parse attempts live in the trace.
 */

// Fields common to EnvelopeBase — surfaced explicitly; everything else (subclass
// fields like changed_files, findings, commit_message) prints in the raw block.
const BASE_FIELDS = new Set(['status', 'summary', 'artifacts', 'notes_for_next_agent']);

function parse(payload: string | null): Record<string, unknown> {
  if (!payload) return {};
  try {
    return JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function EnvelopePanel({ envelopes }: { envelopes: Envelope[] }) {
  const valid = envelopes.filter((e) => e.valid === 1);
  if (valid.length === 0) return null;

  return (
    <div className="mb-8">
      <div className="mb-3">
        <Label count={valid.length} rule>
          Envelopes
        </Label>
      </div>
      <div className="flex flex-col gap-3">
        {valid.map((env) => {
          const body = parse(env.payload_json);
          const status = String(body.status ?? '');
          const tone: BadgeTone = status === 'success' ? 'ok' : status === 'fail' ? 'err' : 'default';
          const artifacts = Array.isArray(body.artifacts) ? (body.artifacts as string[]) : [];
          const notes = typeof body.notes_for_next_agent === 'string' ? body.notes_for_next_agent : '';
          const extra = Object.entries(body).filter(([k]) => !BASE_FIELDS.has(k));

          return (
            <div key={env.envelope_id} className="border border-os-border bg-os-bg2">
              <div className="flex flex-wrap items-center gap-2 border-b border-os-hairline px-4 py-2.5">
                <span className="font-mono text-[12.5px] font-semibold text-os-text">{env.agent}</span>
                <Badge tone="accent">{env.output_type}</Badge>
                {status && <Badge tone={tone}>{status}</Badge>}
                {env.attempt != null && env.attempt > 1 && (
                  <span className="font-mono text-[10px] text-os-warn">attempt {env.attempt}</span>
                )}
              </div>
              <div className="px-4 py-3">
                {typeof body.summary === 'string' && body.summary && (
                  <p className="mb-3 text-[12.5px] text-os-text">{body.summary}</p>
                )}
                {artifacts.length > 0 && (
                  <div className="mb-3">
                    <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.16em] text-os-dim">Artifacts</div>
                    <ul className="flex flex-col gap-1">
                      {artifacts.map((a) => (
                        <li key={a} className="truncate font-mono text-[11px] text-os-muted" title={a}>
                          {a}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {notes && (
                  <div className="mb-3">
                    <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.16em] text-os-dim">
                      Notes for next agent
                    </div>
                    <p className="text-[12px] text-os-muted">{notes}</p>
                  </div>
                )}
                {extra.length > 0 && (
                  <details className="group">
                    <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.14em] text-os-dim hover:text-os-text">
                      Full payload ({extra.length} more field{extra.length === 1 ? '' : 's'})
                    </summary>
                    <pre className="mt-2 max-h-72 overflow-auto border border-os-border bg-os-surface2 p-3 font-mono text-[11px] leading-relaxed text-os-muted">
                      {JSON.stringify(body, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
