/**
 * Context-window occupancy as a thin bar — how full the model's window was when
 * the agent last stopped (context_tokens / context_window). This is OCCUPANCY,
 * not spend: it can shrink after a compaction while billed tokens only grow.
 *
 * Renders nothing unless both numbers are real — a bar against an unknown ceiling
 * would be decoration, not data. The fill is the neutral accent (a meter, not a
 * status): occupancy isn't good or bad, it's just how much room is left.
 */
const NUM = new Intl.NumberFormat('en-US');

export function ContextBar({
  used,
  window,
  className = '',
}: {
  used: number | null;
  window: number | null;
  className?: string;
}) {
  if (!used || !window) return null;
  const pct = Math.min(100, (used / window) * 100);
  const label = pct < 1 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`;

  return (
    <div
      className={`flex flex-col gap-1 ${className}`}
      title={`${NUM.format(used)} / ${NUM.format(window)} tokens · ${NUM.format(window - used)} free`}
    >
      <div className="flex items-baseline justify-between gap-2 font-mono text-[8.5px] uppercase tracking-[0.14em] text-os-dim">
        <span>Context</span>
        <span className="tabular-nums text-os-muted">{label}</span>
      </div>
      <div className="h-1 w-full overflow-hidden bg-os-bg2">
        {/* Floor the visible fill so sub-1% occupancy still reads as non-empty. */}
        <div className="h-full bg-os-accent" style={{ width: `${Math.max(pct, 2)}%` }} />
      </div>
    </div>
  );
}
