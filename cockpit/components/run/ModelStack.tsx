import { Label } from '@/components/terminal';
import { compact, usd } from '@/lib/format';
import type { PhaseCost } from '@/lib/types';

/**
 * The per-run model stack — which model ran each phase, and what it cost. One row
 * per agent phase in seq order, from AtelierDb.runModelStack (agent_end totals,
 * already summed across retries). Answers "cost per tier": read the model column
 * top-to-bottom to see the stack, the cost column to see where the money went.
 * Phases that make no agent call (pure `code`/`engineer`) don't appear here.
 */
export function ModelStack({ stack }: { stack: PhaseCost[] }) {
  if (stack.length === 0) return null;
  const total = stack.reduce((sum, p) => sum + p.cost, 0);

  return (
    <div className="mb-8">
      <div className="mb-3">
        <Label count={stack.length} rule>
          Model stack
        </Label>
      </div>
      <div className="overflow-x-auto border border-os-border">
        <table className="w-full min-w-[620px] border-collapse font-mono text-[12px]">
          <thead>
            <tr className="border-b border-os-border text-[9px] uppercase tracking-[0.16em] text-os-dim">
              <Th className="text-left">Phase</Th>
              <Th className="text-left">Model</Th>
              <Th className="text-left">Backend</Th>
              <Th className="text-right">Try</Th>
              <Th className="text-right">Read</Th>
              <Th className="text-right">Written</Th>
              <Th className="text-right">Cost</Th>
            </tr>
          </thead>
          <tbody>
            {stack.map((p) => (
              <tr key={p.phase_id} className="border-t border-os-hairline first:border-t-0">
                <Td className="text-left">
                  <span className="text-os-text">{p.phase_name}</span>
                  <span className="ml-2 text-os-dim">{p.agent}</span>
                </Td>
                <Td className="text-left text-os-muted">{p.model ?? '—'}</Td>
                <Td className="text-left text-os-dim">{p.coding_agent ?? '—'}</Td>
                <Td className={`text-right tabular-nums ${(p.attempt ?? 1) > 1 ? 'text-os-warn' : 'text-os-dim'}`}>
                  {p.attempt ?? 1}
                </Td>
                <Td className="text-right tabular-nums text-os-muted">{compact(p.read)}</Td>
                <Td className="text-right tabular-nums text-os-muted">{compact(p.written)}</Td>
                <Td className="text-right tabular-nums text-os-text">{usd(p.cost)}</Td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-os-border">
              <Td className="text-left text-[9px] font-bold uppercase tracking-[0.16em] text-os-dim">Total</Td>
              <Td className="text-left" colSpan={5} />
              <Td className="text-right tabular-nums text-os-text">{usd(total)}</Td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <th className={`px-4 py-2.5 font-bold ${className}`}>{children}</th>;
}

function Td({
  children,
  className = '',
  colSpan,
}: {
  children?: React.ReactNode;
  className?: string;
  colSpan?: number;
}) {
  return (
    <td className={`px-4 py-2.5 ${className}`} colSpan={colSpan}>
      {children}
    </td>
  );
}
