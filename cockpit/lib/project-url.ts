/**
 * URL helpers for the multi-project cockpit (Part E). Pure and node-free, so both
 * server components and client components import them.
 *
 * Every page lives under `/[project]/…`; every API call carries `?project=<id>`.
 * These two helpers are the single place that shape is applied, so a link or a
 * fetch never hard-codes the segment.
 */

/** Prefix an in-app path with the project segment: projectHref('atelier', '/queue')
 *  → '/atelier/queue'; projectHref('atelier', '/') → '/atelier'. */
export function projectHref(projectId: string, path: string): string {
  if (!path || path === '/') return `/${projectId}`;
  return `/${projectId}${path.startsWith('/') ? path : `/${path}`}`;
}

/** Append `project=<id>` to an API URL, respecting any existing query string. */
export function withProject(url: string, projectId: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}project=${encodeURIComponent(projectId)}`;
}
