/**
 * Atelier mark — a terminal caret inside a workshop bracket. Grey structure
 * only (Monolith rule: no color unless it's status). Server-safe.
 */
export function AtelierMark({ size = 34, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 34 34"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <rect x="1" y="1" width="32" height="32" stroke="var(--border-strong)" strokeWidth="1" />
      {/* the prompt caret ›_ — agent proposes, code disposes */}
      <path d="M11 12l5 5-5 5" stroke="var(--accent)" strokeWidth="1.6" strokeLinecap="square" />
      <path d="M19 22h5" stroke="var(--text-3)" strokeWidth="1.6" strokeLinecap="square" />
    </svg>
  );
}
