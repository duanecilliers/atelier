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
