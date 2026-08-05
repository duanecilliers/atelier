import { Badge, Dot, Label } from '@/components/terminal';
import type { GateCheck, GateResult } from '@/lib/types';

/**
 * The deterministic gates — the "dispose" half. After an agent proposes, code
 * verifies the envelope's CLAIMS against disk & git (does the file it said it
 * wrote exist? is the review self-consistent?). This renders each gate's verdict
 * plus the per-item evidence behind it (checks_json), so a green gate says WHAT
 * it verified, not just that it passed. The UI only renders gates — it never
 * bypasses them; acceptance is decided in the engine.
 */

function parseChecks(json: string | null): GateCheck[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as GateCheck[]) : [];
  } catch {
    return [];
  }
}

function parseViolations(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

export function GatePanel({ gates }: { gates: GateResult[] }) {
  return (
    <div className="mb-8">
      <div className="mb-3">
        <Label count={gates.length} rule>
          Gates
        </Label>
      </div>

      {gates.length === 0 ? (
        <div className="border border-dashed border-os-border-strong px-4 py-5 font-mono text-[11.5px] text-os-dim">
          No claim gates on this run. Gates fire on phases that make verifiable claims —
          a plan&apos;s artifacts, a build&apos;s diff, a review&apos;s verdict.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {gates.map((g) => {
            const passed = g.passed === 1;
            const checks = parseChecks(g.checks_json);
            const violations = parseViolations(g.violations_json);
            return (
              <div key={g.id} className="border border-os-border bg-os-bg2">
                <div className="flex flex-wrap items-center gap-2 border-b border-os-hairline px-4 py-2.5">
                  <Badge tone={passed ? 'ok' : 'err'}>{passed ? 'pass' : 'fail'}</Badge>
                  <span className="font-mono text-[12.5px] text-os-text">{g.gate}</span>
                  {g.attempt != null && g.attempt > 1 && (
                    <span className="font-mono text-[10px] text-os-warn">attempt {g.attempt}</span>
                  )}
                </div>
                <div className="px-4 py-2.5">
                  {checks.length > 0 ? (
                    <ul className="flex flex-col gap-1.5">
                      {checks.map((c, i) => (
                        <li key={i} className="flex items-start gap-2 text-[12px]">
                          <span className="mt-[5px]">
                            <Dot state={c.ok ? 'success' : 'fail'} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="text-os-text">{c.item}</span>
                            {c.note && <span className="text-os-dim"> — {c.note}</span>}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : violations.length > 0 ? (
                    <ul className="flex flex-col gap-1 font-mono text-[11.5px] text-os-err">
                      {violations.map((v, i) => (
                        <li key={i}>✗ {v}</li>
                      ))}
                    </ul>
                  ) : (
                    <span className="font-mono text-[11px] text-os-dim">verdict recorded, no per-item evidence</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
