import Link from 'next/link';
import { getDb } from '@/lib/data';
import { Badge, Label } from '@/components/terminal';
import type { GateRollup } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * /gates — cross-run gate health. The deterministic "dispose" half, viewed across
 * runs: which gates fire, how often they pass, how many results came on a retry,
 * and the latest failures (each linking to its run's per-check evidence). The UI
 * only observes gates — acceptance is decided in the engine. See
 * AtelierDb.gateRollup; per-run evidence lives on the run-detail GatePanel.
 */
function load(): { data: GateRollup | null; error: string | null } {
  try {
    return { data: getDb().gateRollup(), error: null };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export default function GatesPage() {
  const { data, error } = load();
  const empty = !data || data.byGate.length === 0;

  return (
    <div className="view">
      <p className="mb-2.5 font-mono text-[9.5px] font-bold uppercase tracking-[0.32em] text-os-dim">Atelier</p>
      <h1 className="mb-1 text-[28px] font-bold uppercase tracking-[0.06em]">Gates</h1>
      <p className="mb-6 max-w-[64ch] text-[13px] text-os-muted">
        Deterministic acceptance checks across the recent run window — pass rate and retries per
        gate, with the latest failures. Gates fire on phases that make verifiable claims.
      </p>

      {error ? (
        <pre className="whitespace-pre-wrap border border-os-err/40 p-4 font-mono text-[11.5px] text-os-muted">
          {error}
        </pre>
      ) : empty ? (
        <div className="border border-dashed border-os-border-strong px-4 py-5 font-mono text-[11.5px] text-os-dim">
          No gate results yet. A gate records here when a phase&apos;s claims are checked against
          disk &amp; git — a plan&apos;s artifacts, a build&apos;s diff, a review&apos;s verdict.
        </div>
      ) : (
        <>
          <div className="mb-3">
            <Label count={data.byGate.length} rule>
              By gate
            </Label>
          </div>
          <GateTable rollup={data} />

          {data.recentFailures.length > 0 && (
            <div className="mt-8">
              <div className="mb-3">
                <Label count={data.recentFailures.length} rule>
                  Recent failures
                </Label>
              </div>
              <div className="border border-os-border">
                {data.recentFailures.map((f, i) => (
                  <Link
                    key={`${f.adw_id}-${f.phase_id}-${i}`}
                    href={`/runs/${f.adw_id}`}
                    className="flex items-center gap-3 border-t border-os-hairline px-4 py-2.5 transition-colors first:border-t-0 hover:bg-os-bg2"
                  >
                    <Badge tone="err">fail</Badge>
                    <span className="w-[150px] shrink-0 font-mono text-[12px] text-os-text">{f.gate}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-os-muted">{f.adw_id}</span>
                    {(f.attempt ?? 1) > 1 && (
                      <span className="shrink-0 font-mono text-[10px] text-os-warn">attempt {f.attempt}</span>
                    )}
                    <span className="shrink-0 font-mono text-[11px] text-os-dim">→</span>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function GateTable({ rollup }: { rollup: GateRollup }) {
  return (
    <div className="overflow-x-auto border border-os-border">
      <table className="w-full min-w-[560px] border-collapse font-mono text-[12px]">
        <thead>
          <tr className="border-b border-os-border text-[9px] uppercase tracking-[0.16em] text-os-dim">
            <Th className="text-left">Gate</Th>
            <Th className="text-right">Runs</Th>
            <Th className="text-right">Pass</Th>
            <Th className="text-right">Fail</Th>
            <Th className="text-right">Retries</Th>
            <Th className="text-left">Pass rate</Th>
          </tr>
        </thead>
        <tbody>
          {rollup.byGate.map((g) => {
            const pct = Math.round(g.passRate * 100);
            const tone = g.failed === 0 ? 'text-os-ok' : g.passed === 0 ? 'text-os-err' : 'text-os-warn';
            return (
              <tr key={g.gate} className="border-t border-os-hairline first:border-t-0">
                <Td className="text-left text-os-text">{g.gate}</Td>
                <Td className="text-right tabular-nums text-os-muted">{g.runs}</Td>
                <Td className="text-right tabular-nums text-os-muted">{g.passed}</Td>
                <Td className={`text-right tabular-nums ${g.failed > 0 ? 'text-os-err' : 'text-os-dim'}`}>
                  {g.failed}
                </Td>
                <Td className={`text-right tabular-nums ${g.retries > 0 ? 'text-os-warn' : 'text-os-dim'}`}>
                  {g.retries}
                </Td>
                <Td className={`text-left tabular-nums ${tone}`}>{pct}%</Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <th className={`px-4 py-2.5 font-bold ${className}`}>{children}</th>;
}

function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-2.5 ${className}`}>{children}</td>;
}
