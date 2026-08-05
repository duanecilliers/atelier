import { getDb } from '@/lib/data';
import { Label, Stat } from '@/components/terminal';
import { compact, usd } from '@/lib/format';
import type { CostRollup } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * /cost — the cross-run spend dashboard. Grand totals over the recent run window
 * plus a per-model breakdown, all derived from agent_end payloads (see
 * AtelierDb.costRollup). "Design for the 1000th run": measure where the money and
 * tokens go, therefore improve it. Read-only, like everything on the read path.
 */
function load(): { data: CostRollup | null; error: string | null } {
  try {
    return { data: getDb().costRollup(), error: null };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export default function CostPage() {
  const { data, error } = load();

  return (
    <div className="view">
      <p className="mb-2.5 font-mono text-[9.5px] font-bold uppercase tracking-[0.32em] text-os-dim">Atelier</p>
      <h1 className="mb-1 text-[28px] font-bold uppercase tracking-[0.06em]">Cost</h1>
      <p className="mb-6 max-w-[64ch] text-[13px] text-os-muted">
        Spend and tokens across the recent run window, summed across retries and grouped by model —
        derived from each run&apos;s trace, never a separate ledger.
      </p>

      {error ? (
        <pre className="whitespace-pre-wrap border border-os-err/40 p-4 font-mono text-[11.5px] text-os-muted">
          {error}
        </pre>
      ) : !data || data.totals.runs === 0 ? (
        <div className="border border-dashed border-os-border-strong px-4 py-5 font-mono text-[11.5px] text-os-dim">
          No spend recorded yet. Cost accrues as agents run — kick one from the queue, then the
          per-model breakdown fills in here.
        </div>
      ) : (
        <>
          <div className="mb-8 grid grid-cols-2 gap-px border border-os-border bg-os-border sm:grid-cols-4">
            <Stat label="Total spend" value={usd(data.totals.cost)} />
            <Stat label="Runs" value={data.totals.runs} />
            <Stat label="Tokens read" value={compact(data.totals.read)} />
            <Stat label="Tokens written" value={compact(data.totals.written)} />
          </div>

          <div className="mb-3">
            <Label count={data.byModel.length} rule>
              By model
            </Label>
          </div>
          <ModelTable rollup={data} />
        </>
      )}
    </div>
  );
}

function ModelTable({ rollup }: { rollup: CostRollup }) {
  return (
    <div className="overflow-x-auto border border-os-border">
      <table className="w-full min-w-[640px] border-collapse font-mono text-[12px]">
        <thead>
          <tr className="border-b border-os-border text-[9px] uppercase tracking-[0.16em] text-os-dim">
            <Th className="text-left">Model</Th>
            <Th className="text-left">Backend</Th>
            <Th className="text-right">Runs</Th>
            <Th className="text-right">Read</Th>
            <Th className="text-right">Written</Th>
            <Th className="text-right">Cost</Th>
            <Th className="text-left">Share</Th>
          </tr>
        </thead>
        <tbody>
          {rollup.byModel.map((m) => (
            <tr key={m.model} className="border-t border-os-hairline first:border-t-0">
              <Td className="text-left text-os-text">{m.model}</Td>
              <Td className="text-left text-os-muted">{m.coding_agent ?? '—'}</Td>
              <Td className="text-right tabular-nums text-os-muted">{m.runs}</Td>
              <Td className="text-right tabular-nums text-os-muted">{compact(m.read)}</Td>
              <Td className="text-right tabular-nums text-os-muted">{compact(m.written)}</Td>
              <Td className="text-right tabular-nums text-os-text">{usd(m.cost)}</Td>
              <Td className="text-left">
                <ShareBar share={m.share} />
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A thin accent bar + percentage — each model's slice of grand-total spend. */
function ShareBar({ share }: { share: number }) {
  const pct = Math.round(share * 100);
  return (
    <span className="flex items-center gap-2">
      <span className="h-1.5 w-24 shrink-0 bg-os-border" aria-hidden>
        <span className="block h-full bg-os-accent" style={{ width: `${Math.max(share * 100, share > 0 ? 2 : 0)}%` }} />
      </span>
      <span className="w-8 shrink-0 text-right tabular-nums text-os-dim">{pct}%</span>
    </span>
  );
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <th className={`px-4 py-2.5 font-bold ${className}`}>{children}</th>;
}

function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-2.5 ${className}`}>{children}</td>;
}
