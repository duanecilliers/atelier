'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Copy a sandbox's branch name to the clipboard, with a brief "copied"
 * confirmation. Pure client-side convenience - touches no API, no db.
 */
export function CopyBranchButton({ branch }: { branch: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear the pending reset on unmount so we never set state on a dead component.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(branch);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (permissions / non-secure context): do nothing visible.
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={`Copy branch name ${branch}`}
      title="Copy branch name"
      className={`shrink-0 font-mono text-[9.5px] uppercase tracking-[0.14em] transition-colors ${
        copied ? 'text-os-ok' : 'text-os-dim hover:text-os-accent'
      }`}
    >
      {copied ? 'copied' : 'copy'}
    </button>
  );
}
