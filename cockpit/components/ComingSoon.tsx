import { Badge } from '@/components/terminal';

/**
 * Placeholder for views whose data plane arrives in a later phase. The nav is
 * the real information architecture (see lib/nav.ts) — these keep it navigable
 * without pretending the view works yet.
 */
export function ComingSoon({ title, phase, blurb }: { title: string; phase: string; blurb: string }) {
  return (
    <div className="view">
      <p className="page-eyebrow mb-2.5 font-mono text-[9.5px] font-bold uppercase tracking-[0.32em] text-os-dim">
        {' '}
        Atelier
      </p>
      <div className="mb-3 flex items-center gap-3">
        <h1 className="text-[28px] font-bold uppercase tracking-[0.06em]">{title}</h1>
        <Badge tone="warn">{phase}</Badge>
      </div>
      <p className="max-w-[64ch] text-[13px] text-os-muted">{blurb}</p>
      <div className="mt-6 border border-dashed border-os-border-strong p-6 font-mono text-[12px] text-os-dim">
        Not built yet. This view ships in {phase}.
      </div>
    </div>
  );
}
