/**
 * The config seam — the cockpit's read + write view of the factory roster
 * (engine/adws/adw_sssf_config/sssf.config.yaml).
 *
 * This is the SECOND write surface after the run_queue control plane, and the
 * first that touches a file the engine reads as configuration. It stays inside
 * the determinism spine: config is a plain YAML file, not a run's trace or the
 * sssf.db — writing it spawns no process and mutates no run. The engine remains
 * the authority (agents.py::load_config re-validates via Pydantic at run time);
 * this module mirrors that Pydantic model in Zod, exactly as lib/schemas.ts
 * mirrors the tracer's SCHEMA. Keep the two in lockstep (see AGENTS.md).
 *
 * Writes are SURGICAL. We parse the file into a comment-preserving `yaml`
 * Document, set only the allowlisted scalar fields, re-validate the WHOLE
 * document against the Zod mirror, then write atomically (temp + rename). We
 * never re-serialize from a plain object, so the config's load-bearing comments
 * survive every edit.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { parseDocument, stringify, type Document } from 'yaml';
import { z } from 'zod';
import { CODING_AGENTS, THINKING_LEVELS } from './roster-constants';

export { CODING_AGENTS, THINKING_LEVELS } from './roster-constants';

/** Same shape as resolveDbPath(): SSSF_CONFIG wins, else the sibling engine file. */
const DEFAULT_CONFIG_RELATIVE = '../engine/adws/adw_sssf_config/sssf.config.yaml';

export function resolveConfigPath(): string {
  const raw = process.env.SSSF_CONFIG ?? DEFAULT_CONFIG_RELATIVE;
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

// ── Zod mirror of engine/adws/adw_modules/data_types.py ───────────────────────
// SSSFConfig / AgentConfig / ConfigDefaults / ObservabilityConfig. MUST stay in
// lockstep with the Pydantic models — a field the engine requires but the mirror
// omits would let the cockpit read (or write) a config the engine then rejects.

/** A model id is `provider/id`, e.g. "anthropic/claude-fable-5". */
const MODEL_PATTERN = /^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/i;
/** A lane color is a 3- or 6-digit hex, or "" (fall back to the UI palette). */
const HEX_OR_EMPTY = z.union([z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/), z.literal('')]);

const PromptEngineeringSchema = z.object({
  system: z.string(),
  user: z.string(),
});

const AgentConfigSchema = z.object({
  name: z.string().min(1),
  coding_agent: z.enum(CODING_AGENTS).default('pi'),
  model: z.string().default('google/gemini-3.6-flash'),
  thinking: z.string().default('medium'),
  color: z.string().default(''),
  purpose: z.string().default(''),
  prompt_engineering: PromptEngineeringSchema,
  harness_engineering: z.array(z.string()).default([]),
  // None (absent) = all tools usable; [] = read-only w.r.t. the repo; [...] = allowlist.
  tools: z.array(z.string()).nullable().optional(),
  writes: z.array(z.string()).nullable().optional(),
});

const ConfigDefaultsSchema = z.object({
  coding_agent: z.enum(CODING_AGENTS).default('pi'),
  model: z.string().default('google/gemini-3.6-flash'),
  thinking: z.string().default('medium'),
  color: z.string().default(''),
  harness_engineering: z.array(z.string()).default([]),
  tools: z.array(z.string()).nullable().optional(),
  protected_files: z.array(z.string()).default([]),
  data_dir: z.string().default('adws/adw_data'),
});

const ObservabilitySchema = z.object({
  db: z.string().default('adws/adw_data/sssf.db'),
  poll_ms: z.number().default(500),
});

export const RosterConfigSchema = z.object({
  defaults: ConfigDefaultsSchema.default({}),
  observability: ObservabilitySchema.default({}),
  agents: z.array(AgentConfigSchema).default([]),
});

export type RosterConfig = z.infer<typeof RosterConfigSchema>;
export type RosterAgent = z.infer<typeof AgentConfigSchema>;
export type RosterDefaults = z.infer<typeof ConfigDefaultsSchema>;

// ── The editable surface (this PR) ────────────────────────────────────────────
// Scalars only: model, coding_agent, thinking, color, purpose per agent; model,
// coding_agent, thinking on defaults. The array fields (tools/writes) and the
// prompt/harness paths are the security + wiring boundary — shown read-only in
// the UI and left to a later, more careful write pass. `.strict()` rejects any
// key outside the allowlist before a single value is applied.

const AgentPatchSchema = z
  .object({
    coding_agent: z.enum(CODING_AGENTS),
    model: z.string().regex(MODEL_PATTERN, 'model must look like provider/id'),
    thinking: z.enum(THINKING_LEVELS),
    color: HEX_OR_EMPTY,
    // Collapse any whitespace (incl. newlines from the textarea) to single
    // spaces: purpose is written back as a one-line scalar, so a stray newline
    // must not turn it into a block scalar mid-splice.
    purpose: z
      .string()
      .max(400)
      .transform((s) => s.replace(/\s+/g, ' ').trim()),
  })
  .partial()
  .strict();

const DefaultsPatchSchema = z
  .object({
    coding_agent: z.enum(CODING_AGENTS),
    model: z.string().regex(MODEL_PATTERN, 'model must look like provider/id'),
    thinking: z.enum(THINKING_LEVELS),
  })
  .partial()
  .strict();

export const RosterEditSchema = z
  .object({
    agents: z.record(z.string(), AgentPatchSchema).optional(),
    defaults: DefaultsPatchSchema.optional(),
  })
  .strict()
  .refine((e) => (e.agents && Object.keys(e.agents).length > 0) || e.defaults, 'no edits provided');

export type RosterEdit = z.infer<typeof RosterEditSchema>;
export type AgentPatch = z.infer<typeof AgentPatchSchema>;

/** A bad-input error (unknown agent, unplaceable key) — a 4xx, not a 5xx. */
export class RosterInputError extends Error {}

// ── Read ──────────────────────────────────────────────────────────────────────

function parseFileDoc(path: string): { doc: Document; src: string } {
  if (!existsSync(path)) {
    throw new Error(
      `sssf.config.yaml not found at ${path} — set SSSF_CONFIG, or point the ` +
        `cockpit at the engine's config so the roster can be read.`,
    );
  }
  const src = readFileSync(path, 'utf8');
  const doc = parseDocument(src);
  if (doc.errors.length > 0) {
    throw new Error(`config parse error: ${doc.errors[0]!.message}`);
  }
  return { doc, src };
}

export function readRoster(path = resolveConfigPath()): RosterConfig {
  const { doc } = parseFileDoc(path);
  return RosterConfigSchema.parse(doc.toJS());
}

// ── Write ───────────────────────────────────────────────────────────────────

function agentIndex(doc: Document, name: string): number {
  const seq = doc.get('agents') as { items?: unknown[] } | undefined;
  const items = seq?.items ?? [];
  for (let i = 0; i < items.length; i++) {
    if (doc.getIn(['agents', i, 'name']) === name) return i;
  }
  return -1;
}

/** One byte-range edit to the source text; end === start is a pure insertion. */
interface Splice {
  start: number;
  end: number;
  text: string;
}

/** A scalar value, serialized to its minimal YAML token (quoted only if needed). */
function scalarToken(value: unknown): string {
  return stringify(value, { lineWidth: 0 }).trim();
}

/**
 * Build the edit for one field. If the key already exists we splice ONLY its
 * value token, leaving comments and the rest of the line untouched. If it's
 * absent (an agent inheriting the default) we insert a fresh line right after
 * the map's first entry, at that entry's column indent.
 */
function fieldSplice(doc: Document, src: string, parentPath: (string | number)[], key: string, value: unknown): Splice {
  const node = doc.getIn([...parentPath, key], true) as { range?: [number, number, number] } | undefined;
  if (node?.range) {
    return { start: node.range[0], end: node.range[1], text: scalarToken(value) };
  }
  // Insertion: anchor on the map's first pair (name for an agent, coding_agent
  // for defaults). Indent from the key's COLUMN — not the literal prefix — so a
  // first entry sharing a "- " sequence line still yields the sibling indent.
  const map = doc.getIn(parentPath, true) as { items?: { key?: { range?: number[] }; value?: { range?: number[] } }[] } | undefined;
  const first = map?.items?.[0];
  const keyStart = first?.key?.range?.[0];
  // range[1] is the value's exclusive end (before any trailing comment). Using
  // it — not range[2], which is past nodeEnd — means an anchor whose value is
  // immediately followed by a newline finds THAT newline, so the new key lands
  // right after the anchor's own line rather than one line lower.
  const anchorEnd = first?.value?.range?.[1];
  if (keyStart == null || anchorEnd == null) {
    throw new RosterInputError(`cannot place "${key}" — no anchor field on the target map`);
  }
  const lineStart = src.lastIndexOf('\n', keyStart - 1) + 1;
  const indent = ' '.repeat(keyStart - lineStart);
  let lineEnd = src.indexOf('\n', anchorEnd);
  if (lineEnd < 0) lineEnd = src.length;
  return { start: lineEnd, end: lineEnd, text: `\n${indent}${key}: ${scalarToken(value)}` };
}

/**
 * Apply an allowlisted patch to the roster and persist it. SURGICAL at the byte
 * level: we compute the source span of each edited value and splice only that,
 * so a one-field change is a one-line diff and the config's hand-aligned
 * comments are left exactly as they were. Splices are applied high-offset-first
 * so earlier edits never shift later ranges. The result is re-parsed and
 * re-validated against the whole mirror before it can reach disk, then written
 * atomically (temp + rename). Returns the new roster.
 */
export function writeRoster(edit: RosterEdit, path = resolveConfigPath()): RosterConfig {
  const parsed = RosterEditSchema.parse(edit);
  const { doc, src } = parseFileDoc(path);

  const splices: Splice[] = [];
  if (parsed.defaults) {
    for (const [key, value] of Object.entries(parsed.defaults)) {
      splices.push(fieldSplice(doc, src, ['defaults'], key, value));
    }
  }
  if (parsed.agents) {
    for (const [name, patch] of Object.entries(parsed.agents)) {
      const idx = agentIndex(doc, name);
      if (idx < 0) throw new RosterInputError(`unknown agent "${name}" — not in the roster`);
      for (const [key, value] of Object.entries(patch)) {
        splices.push(fieldSplice(doc, src, ['agents', idx], key, value));
      }
    }
  }

  // Apply high offset first so each splice's ranges stay valid as we mutate.
  splices.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = src;
  for (const s of splices) out = out.slice(0, s.start) + s.text + out.slice(s.end);

  // Belt and suspenders: the rewritten source must still parse and satisfy the
  // whole mirror. A splice that somehow broke the shape fails here, and the file
  // is never touched.
  const reparsed = parseDocument(out);
  if (reparsed.errors.length > 0) {
    throw new Error(`edit produced invalid YAML: ${reparsed.errors[0]!.message}`);
  }
  const next = RosterConfigSchema.parse(reparsed.toJS());

  // Atomic write: same-directory temp then rename, so a crash mid-write never
  // leaves the engine a half-written config to choke on. The random suffix keeps
  // two concurrent writes (same pid) from colliding on the temp path.
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, out, 'utf8');
  renameSync(tmp, path);
  return next;
}

// ── Guardrails (advisory, surfaced in the UI — never a hard block) ────────────

export interface RosterWarning {
  agent: string;
  message: string;
}

/**
 * Non-fatal config smells the operator should see. Today: an `anthropic/*` model
 * routed through `coding_agent: pi` — pi's Anthropic OAuth is expired on this
 * machine, so such a run fails at dispatch. It's an advisory, not a block: the
 * config file is allowed to express it (a re-auth would make it valid), so we
 * surface it and let the operator decide. See AGENTS.md "Machine gotcha".
 */
export function rosterWarnings(cfg: RosterConfig): RosterWarning[] {
  const out: RosterWarning[] = [];
  for (const a of cfg.agents) {
    const backend = a.coding_agent || cfg.defaults.coding_agent;
    const model = a.model || cfg.defaults.model;
    if (backend === 'pi' && model.startsWith('anthropic/')) {
      out.push({
        agent: a.name,
        message: `backend "pi" runs model "${model}" — pi's Anthropic OAuth is expired here; route anthropic/* through claude_code.`,
      });
    }
  }
  return out;
}
