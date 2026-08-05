'use client';

import { usePathname } from 'next/navigation';

/**
 * The current project id, read from the first path segment (`/[project]/…`).
 *
 * Every page lives under a project segment, so client components that fetch or
 * navigate derive the id from the URL rather than threading it through props.
 * Falls back to 'default' at the bare root (the redirect target before a project
 * is chosen), matching the env-fallback project id in lib/projects.ts.
 */
export function useProjectId(): string {
  const pathname = usePathname();
  return pathname.split('/')[1] || 'default';
}
