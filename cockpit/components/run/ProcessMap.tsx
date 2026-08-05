import { Label } from '@/components/terminal';
import { duration } from '@/lib/format';
import type { AgentSession, Phase } from '@/lib/types';

/**
 * The Process Map — a horizontal phase pipeline, one step per phase, in the ADW
 * lane vocabulary (engineer proposes the ask · agent proposes work · code
 * disposes). FounderOS's WorkflowMap re-skinned to ADW phases. Per-step status
 * comes straight off phases.status, so a router.refresh() (driven by LiveTail)
 * re-paints it live as the run advances.
 */

const STEP_BORDER: Record<string, string> = {
  success: 'border-[color-mix(in_oklab,var(--ok)_45%,var(--border))]',
  running: 'border-[color-mix(in_oklab,var(--warn)_55%,var(--border))] bg-[color-mix(in_oklab,var(--warn)_10%,transparent)]',
  fail: 'border-[color-mix(in_oklab,var(--err)_55%,var(--border))] bg-[color-mix(in_oklab,var(--err)_9%,transparent)]',
  queued: 'border-os-border-strong',
};

function statusDetail(p: Phase): { text: string; cls: string } {
  switch (p.status) {
    case 'success':
      return { text: `✓ ${duration(p.started_at, p.ended_at)}`, cls: 'text-os-ok' };
    case 'running':
      return { text: 'running…', cls: 'text-os-warn' };
    case 'fail':
      return { text: '✗ failed', cls: 'text-os-err' };
    default:
      return { text: '—', cls: 'text-os-dim' };
  }
}

export function ProcessMap({ phases, agents }: { phases: Phase[]; agents: AgentSession[] }) {
  const colorFor = (owner: string | null) => agents.find((a) => a.agent === owner)?.color ?? null;

  return (
    <div className="mb-8">
      <div className="mb-3">
        <Label count={phases.length} rule>
          Process Map
        </Label>
      </div>
      <div className="flex items-stretch gap-1.5 overflow-x-auto border border-os-border bg-os-bg2 p-3.5">
        {phases.map((p, i) => {
          const detail = statusDetail(p);
          const isAgent = p.kind === 'agent';
          const dot = isAgent ? colorFor(p.owner) : null;
          return (
            <div key={p.phase_id} className="flex items-stretch gap-1.5">
              <div className={`min-w-[116px] border ${STEP_BORDER[p.status ?? 'queued']} px-2.5 py-2`}>
                <div className="flex items-center gap-1.5">
                  {dot && <span className="h-1.5 w-1.5 shrink-0" style={{ background: dot }} aria-hidden />}
                  <span className="font-mono text-[8px] font-bold uppercase tracking-[0.12em] text-os-dim">
                    {p.kind}
                  </span>
                </div>
                <div className="mt-1 truncate text-[12px] font-semibold text-os-text" title={p.name ?? ''}>
                  {p.name}
                </div>
                {isAgent && p.owner && (
                  <div className="truncate font-mono text-[9.5px] text-os-dim" title={p.owner}>
                    {p.owner}
                  </div>
                )}
                <div className={`mt-1.5 font-mono text-[9.5px] ${detail.cls}`}>
                  {detail.text}
                  {p.retries != null && p.attempt != null && p.attempt > 0 && (
                    <span className="ml-1 text-os-warn">↻{p.attempt}</span>
                  )}
                </div>
              </div>
              {i < phases.length - 1 && (
                <span className="flex items-center self-center px-0.5 text-os-dim" aria-hidden>
                  ›
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
