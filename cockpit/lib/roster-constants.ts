/**
 * Client-safe roster constants — the enum vocabularies shared between the Zod
 * mirror in lib/roster.ts (server: pulls in node:fs + yaml) and the editor UI
 * (client). Kept in its own module with NO node imports so a client component
 * can import the values without dragging the filesystem code into the bundle.
 *
 * These mirror the Literal/enum options in engine/adws/adw_modules/data_types.py
 * — keep them in lockstep with the Pydantic models (see AGENTS.md).
 */
export const CODING_AGENTS = ['pi', 'claude_code'] as const;
export type CodingAgent = (typeof CODING_AGENTS)[number];

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * The builtin pi tool vocabulary. These are the tools every roster names; the
 * claude_code backend maps them 1:1 via agent_cc.TOOL_MAP (read→Read, etc.).
 * Extension tools registered by a `harness_engineering` extension — e.g. the
 * `subagent_*` tools — are NOT builtins: they're arbitrary snake_case names an
 * operator adds by hand, so the UI offers the builtins as quick-adds and lets
 * anything else be typed in.
 */
export const BUILTIN_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'] as const;
export type BuiltinTool = (typeof BUILTIN_TOOLS)[number];

const TOOL_NAME_RE = /^[a-z][a-z0-9_]*$/;

/** null if the name is a usable tool token, else a human-readable reason. */
export function validateToolName(name: string): string | null {
  const t = name.trim();
  if (!t) return 'tool name is empty';
  if (!TOOL_NAME_RE.test(t)) {
    return `"${t}" — tool names are lowercase letters, digits and underscores (e.g. read, subagent_create)`;
  }
  return null;
}

// A writes entry is a repo-root-relative path or glob, matched in permissions.py
// (`*`/`?` are single-segment globs, a trailing "/" is a directory prefix, and
// anything else is an exact path). We keep validation to what would make a
// pattern dead or dangerous rather than second-guessing the operator's globs.
const WRITE_PATTERN_RE = /^[A-Za-z0-9_./*?-]+$/;

/** null if the pattern is a usable writes entry, else a human-readable reason. */
export function validateWritePattern(pattern: string): string | null {
  const p = pattern.trim();
  if (!p) return 'pattern is empty';
  if (p.length > 200) return 'pattern is too long';
  // Writes are repo-root-relative (see AGENTS.md); an absolute path never
  // matches a repo path, so it would be a silently-dead rule.
  if (p.startsWith('/')) return `"${p}" — writes are repo-root-relative; drop the leading "/"`;
  if (p.split('/').includes('..')) return `"${p}" — ".." is not allowed in a writes pattern`;
  if (!WRITE_PATTERN_RE.test(p)) return `"${p}" — only letters, digits and _ . / * ? - are allowed`;
  return null;
}
