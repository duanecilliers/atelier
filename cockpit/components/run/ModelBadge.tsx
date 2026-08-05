import { modelIdentity } from '@/lib/model';

/**
 * A model, shown as a monochrome provider letter-tile + short name. The tile is
 * the "icon" — deliberately not a colored vendor logo, because in this design
 * language color means status, never brand. Server-friendly (no state).
 */
export function ModelBadge({ model, className = '' }: { model: string | null; className?: string }) {
  const id = modelIdentity(model);
  if (!id) return <span className={`text-os-dim ${className}`}>—</span>;
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 ${className}`} title={model ?? ''}>
      <span
        className="grid h-3.5 w-3.5 shrink-0 place-items-center border border-os-border-strong font-mono text-[8px] font-bold uppercase leading-none text-os-dim"
        aria-hidden
      >
        {id.provider[0]}
      </span>
      <span className="truncate font-mono text-os-muted">{id.short}</span>
    </span>
  );
}
