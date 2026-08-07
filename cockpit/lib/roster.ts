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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument, stringify, type Document } from 'yaml';
import { z } from 'zod';
import { envProjectPaths } from './projects';
import {
  CODING_AGENTS,
  QUALITY_AREAS,
  QUALITY_OPERATIONS,
  THINKING_LEVELS,
  validateAgentName,
  validateToolName,
  validateWritePattern,
} from './roster-constants';

export { CODING_AGENTS, THINKING_LEVELS, BUILTIN_TOOLS } from './roster-constants';

/** The single-project config path: SSSF_CONFIG wins, else the sibling engine file.
 *  The multi-project path comes from pathsForProject(); this is the env-fallback
 *  default (and test escape hatch), defined once in projects.ts. */
export function resolveConfigPath(): string {
  return envProjectPaths().configPath;
}

/** The prefix written INTO the config (repo-root-relative, engine/-prefixed like
 *  every other path there). Matches the existing agents' prompt_engineering paths. */
const PROMPT_ENGINEERING_PREFIX = 'engine/adws/adw_data/prompt_engineering';

/** Where a new agent's prompt files land on disk. Single-project default (SSSF_PE_DIR
 *  or the sibling engine tree) via projects.ts; addAgent() threads a per-project dir. */
export function resolvePromptEngineeringDir(): string {
  return envProjectPaths().promptEngineeringDir;
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

// Mirror of QualityCheckConfig: one deterministic quality command. The map key
// (in the parent record) supplies the name; `timeout` is seconds; area/operation
// are optional trace classifiers that default in the engine. `argv` must be a
// non-empty list — a shell string would be a quoting/injection bug.
const QualityCheckSchema = z.object({
  argv: z.array(z.string()).min(1),
  timeout: z.number().default(120),
  area: z.enum(QUALITY_AREAS).default('backend'),
  operation: z.enum(QUALITY_OPERATIONS).default('build'),
});

// Mirror of the sandbox profile (data_types.py: SandboxConfig/SandboxProfile/
// SandboxServices/SandboxLand). Per-project provisioning: a default level plus a
// named profile per non-trivial level, looked up by the sandbox's level name.
// NOT covered by pnpm check:contract (it's a config file, not a db table), so
// keep this in lockstep with the Pydantic models BY HAND (see AGENTS.md).
const SandboxServicesSchema = z.object({
  up: z.string().default(''),
  down: z.string().default(''),
});

const SandboxLandSchema = z.object({
  mode: z.enum(['pr', 'merge', 'manual']).default('manual'),
  cmd: z.string().default(''),
});

const SandboxProfileSchema = z.object({
  branch: z.string().default('adw/${SANDBOX_ID}'),
  setup: z.array(z.string()).default([]),
  // name → "auto" (the engine probes a free port at provision time).
  ports: z.record(z.string(), z.string()).default({}),
  services: SandboxServicesSchema.default({}),
  env: z.record(z.string(), z.string()).default({}),
  land: SandboxLandSchema.default({}),
});

const SandboxConfigSchema = z.object({
  default: z.string().default('local'),
  worktree: SandboxProfileSchema.optional(),
  worktree_env: SandboxProfileSchema.optional(),
});

export const RosterConfigSchema = z.object({
  defaults: ConfigDefaultsSchema.default({}),
  observability: ObservabilitySchema.default({}),
  // A map of name → command; empty by default. Mirrors SSSFConfig.quality.
  quality: z.record(z.string(), QualityCheckSchema).default({}),
  // Per-project sandbox provisioning; empty (no `sandbox:` block) = every run is
  // a local run at REPO_ROOT. Mirrors SSSFConfig.sandbox.
  sandbox: SandboxConfigSchema.default({}),
  agents: z.array(AgentConfigSchema).default([]),
});

export type RosterConfig = z.infer<typeof RosterConfigSchema>;
export type RosterAgent = z.infer<typeof AgentConfigSchema>;
export type RosterDefaults = z.infer<typeof ConfigDefaultsSchema>;

// ── The editable surface ──────────────────────────────────────────────────────
// Scalars (round 1): model, coding_agent, thinking, color, purpose per agent;
// model, coding_agent, thinking on defaults. Arrays (this round): the security
// boundary — `tools` (per agent + defaults) and `writes` (per agent). Each list
// field is nullable: writing `null` REMOVES the key, which for `writes` means
// "unrestricted" and for `tools` means "inherit defaults / all tools" (see
// agents.py::load_config). The prompt/harness paths and defaults.protected_files
// stay read-only — a later pass. `.strict()` rejects any key outside the
// allowlist before a single value is applied.

/** A validated tool list: each name a usable token, whitespace trimmed, deduped. */
const ToolListSchema = z
  .array(z.string())
  .superRefine((arr, ctx) => {
    arr.forEach((t, i) => {
      const err = validateToolName(t);
      if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, message: err, path: [i] });
    });
  })
  .transform((arr) => {
    const out: string[] = [];
    for (const t of arr) {
      const v = t.trim();
      if (v && !out.includes(v)) out.push(v);
    }
    return out;
  });

/** A validated writes allowlist: each entry a usable repo-relative pattern. `[]`
 *  is legal and meaningful — it is what makes an agent read-only. */
const WritesListSchema = z
  .array(z.string())
  .superRefine((arr, ctx) => {
    arr.forEach((p, i) => {
      const err = validateWritePattern(p);
      if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, message: err, path: [i] });
    });
  })
  .transform((arr) => {
    const out: string[] = [];
    for (const p of arr) {
      const v = p.trim();
      if (v && !out.includes(v)) out.push(v);
    }
    return out;
  });

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
    tools: ToolListSchema.nullable(),
    writes: WritesListSchema.nullable(),
  })
  .partial()
  .strict();

const DefaultsPatchSchema = z
  .object({
    coding_agent: z.enum(CODING_AGENTS),
    model: z.string().regex(MODEL_PATTERN, 'model must look like provider/id'),
    thinking: z.enum(THINKING_LEVELS),
    tools: ToolListSchema.nullable(),
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

// ── Add / remove an agent ─────────────────────────────────────────────────────
// A different KIND of write from a scalar/array patch: adding creates a whole new
// `agents[]` map entry AND bootstraps the two prompt files it requires; removing
// splices the entry out. The create surface is deliberately minimal — identity +
// the scalars — because tools/writes/prompts are then refined through the existing
// per-agent editor. A new agent starts read-only (`writes: []`): a fresh,
// unconfigured agent must not be able to modify the repo until an operator grants
// it (the factory-self-hosts safety posture, matching scout/reviewer).

const agentSlug = z
  .string()
  .superRefine((n, ctx) => {
    const err = validateAgentName(n);
    if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, message: err });
  })
  .transform((n) => n.trim());

export const AgentCreateSchema = z
  .object({
    name: agentSlug,
    coding_agent: z.enum(CODING_AGENTS).optional(),
    model: z.string().regex(MODEL_PATTERN, 'model must look like provider/id').optional(),
    thinking: z.enum(THINKING_LEVELS).optional(),
    color: HEX_OR_EMPTY.optional(),
    purpose: z
      .string()
      .max(400)
      .transform((s) => s.replace(/\s+/g, ' ').trim())
      .optional(),
  })
  .strict();

export type AgentCreate = z.infer<typeof AgentCreateSchema>;

/** The name of the agent to remove (a bare slug, validated like a create name). */
export const AgentNameSchema = agentSlug;

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
/**
 * Where to insert a brand-new key into a map: right after the map's first entry,
 * at that entry's column indent. Anchoring on the first pair (name for an agent,
 * coding_agent for defaults) and indenting from the key's COLUMN — not the
 * literal prefix — means a first entry sharing a "- " sequence line still yields
 * the sibling indent. Shared by the scalar and list splicers.
 */
function anchorInsertPoint(
  doc: Document,
  src: string,
  parentPath: (string | number)[],
  key: string,
): { lineEnd: number; indent: string } {
  const map = doc.getIn(parentPath, true) as { items?: { key?: { range?: number[] }; value?: { range?: number[] } }[] } | undefined;
  const first = map?.items?.[0];
  const keyStart = first?.key?.range?.[0];
  // range[1] is the value's end before any trailing comment, so an anchor whose
  // value is immediately followed by a newline finds THAT newline — the new key
  // lands right after the anchor's own line, not one line lower.
  const anchorEnd = first?.value?.range?.[1];
  if (keyStart == null || anchorEnd == null) {
    throw new RosterInputError(`cannot place "${key}" — no anchor field on the target map`);
  }
  const lineStart = src.lastIndexOf('\n', keyStart - 1) + 1;
  const indent = ' '.repeat(keyStart - lineStart);
  let lineEnd = src.indexOf('\n', anchorEnd);
  if (lineEnd < 0) lineEnd = src.length;
  return { lineEnd, indent };
}

function fieldSplice(doc: Document, src: string, parentPath: (string | number)[], key: string, value: unknown): Splice {
  const node = doc.getIn([...parentPath, key], true) as { range?: [number, number, number] } | undefined;
  if (node?.range) {
    return { start: node.range[0], end: node.range[1], text: scalarToken(value) };
  }
  const { lineEnd, indent } = anchorInsertPoint(doc, src, parentPath, key);
  return { start: lineEnd, end: lineEnd, text: `\n${indent}${key}: ${scalarToken(value)}` };
}

/** The YAML value for a list, sans the `key:` prefix. `[]` inline (a read-only
 *  agent), else a block sequence — one item per line at the key's child indent. */
function listValue(items: string[], keyIndent: string): string {
  if (items.length === 0) return ' []';
  const itemIndent = `${keyIndent}  `;
  return '\n' + items.map((it) => `${itemIndent}- ${scalarToken(it)}`).join('\n');
}

/**
 * Build the edit for a list-or-null field (`tools`, `writes`). Unlike a scalar,
 * a list can be empty, span many lines, or be absent, and its value node carries
 * any inline comments on its items — so we operate on the WHOLE key block rather
 * than a single value token:
 *   - present, value is a list  -> replace `key: …` (key line through the value's
 *     last line) with a freshly serialized `key: <list>`. Item-level comments on
 *     the edited field are not preserved (this is the deliberate cost of editing
 *     the security arrays); the key's own leading comment, and every other line,
 *     are untouched because we start at the key's line, not before it.
 *   - present, value is null    -> remove the key block, plus the comment lines
 *     the CST attributes to this key (the contiguous full-line comments directly
 *     above it) so its documentation leaves with it instead of stranding above
 *     the next key. Bounded by the previous sibling's value end, so a comment
 *     that trails the PREVIOUS field is never swept up by mistake.
 *   - absent, value is a list   -> insert after the map's anchor (as fieldSplice).
 *   - absent, value is null     -> nothing to do.
 * Returns null when there is no edit to make.
 */
function listFieldSplice(
  doc: Document,
  src: string,
  parentPath: (string | number)[],
  key: string,
  value: string[] | null,
): Splice | null {
  const map = doc.getIn(parentPath, true) as { items?: { key?: { value?: unknown; range?: number[] }; value?: { range?: number[] } }[] } | undefined;
  const items = map?.items ?? [];
  const pair = items.find((p) => p?.key?.value === key);

  if (pair?.key?.range && pair.value?.range) {
    const keyStart = pair.key.range[0]!;
    const keyLineStart = src.lastIndexOf('\n', keyStart - 1) + 1;
    const keyIndent = src.slice(keyLineStart, keyStart);
    // range[2] (nodeEnd) reaches past trailing comments on the value; range[1]
    // is the value's own end. Take whichever we have, then make sure the span
    // consumes through the end of its line so the next key stays put — unless it
    // is already at a line boundary (a block seq / commented value ends on \n),
    // where extending would wrongly swallow the following line.
    let end = pair.value.range[2] ?? pair.value.range[1]!;
    if (src[end - 1] !== '\n') {
      const nl = src.indexOf('\n', end);
      end = nl < 0 ? src.length : nl + 1;
    }
    if (value === null) {
      // Walk up over full-line comments that belong to this key, stopping before
      // the previous sibling's value end so its own trailing comment is safe.
      const prev = items[items.indexOf(pair) - 1];
      const prevEnd = prev?.value?.range?.[2] ?? prev?.value?.range?.[1] ?? 0;
      let start = keyLineStart;
      while (start > prevEnd) {
        const aboveEnd = start - 1; // the '\n' terminating the line above
        const aboveStart = src.lastIndexOf('\n', aboveEnd - 1) + 1;
        if (aboveStart < prevEnd || !src.slice(aboveStart, aboveEnd).trim().startsWith('#')) break;
        start = aboveStart;
      }
      return { start, end, text: '' };
    }
    return { start: keyLineStart, end, text: `${keyIndent}${key}:${listValue(value, keyIndent)}\n` };
  }

  // Key absent.
  if (value === null) return null;
  const { lineEnd, indent } = anchorInsertPoint(doc, src, parentPath, key);
  return { start: lineEnd, end: lineEnd, text: `\n${indent}${key}:${listValue(value, indent)}` };
}

/** Route each field in a patch to the scalar or list splicer. A null or array
 *  value is a list field (tools/writes); everything else is a scalar. */
function splicesForMap(
  doc: Document,
  src: string,
  parentPath: (string | number)[],
  patch: Record<string, unknown>,
): Splice[] {
  const out: Splice[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const splice =
      value === null || Array.isArray(value)
        ? listFieldSplice(doc, src, parentPath, key, value as string[] | null)
        : fieldSplice(doc, src, parentPath, key, value);
    if (splice) out.push(splice);
  }
  return out;
}

/** Apply a set of splices to the source, high-offset-first so each splice's
 *  ranges stay valid as earlier text shifts. Pure — returns the new source. */
function applySplices(src: string, splices: Splice[]): string {
  const sorted = [...splices].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = src;
  for (const s of sorted) out = out.slice(0, s.start) + s.text + out.slice(s.end);
  return out;
}

/** Belt and suspenders: the rewritten source must still parse and satisfy the
 *  whole mirror. A splice that somehow broke the shape fails here, before disk. */
function reparseAndValidate(out: string): RosterConfig {
  const reparsed = parseDocument(out);
  if (reparsed.errors.length > 0) {
    throw new Error(`edit produced invalid YAML: ${reparsed.errors[0]!.message}`);
  }
  return RosterConfigSchema.parse(reparsed.toJS());
}

/** Atomic write: same-directory temp then rename, so a crash mid-write never
 *  leaves the engine a half-written config to choke on. The random suffix keeps
 *  two concurrent writes (same pid) from colliding on the temp path. */
function writeAtomic(path: string, out: string): void {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, out, 'utf8');
  renameSync(tmp, path);
}

/** Splice → validate → atomic write. The common tail for a config mutation that
 *  touches only the YAML (patches and removals). */
function applyAndPersist(src: string, splices: Splice[], path: string): RosterConfig {
  const out = applySplices(src, splices);
  const next = reparseAndValidate(out);
  writeAtomic(path, out);
  return next;
}

/**
 * Apply an allowlisted patch to the roster and persist it. SURGICAL at the byte
 * level: we compute the source span of each edited value and splice only that,
 * so a one-field change is a one-line diff and the config's hand-aligned
 * comments are left exactly as they were. The result is re-parsed and
 * re-validated against the whole mirror before it can reach disk, then written
 * atomically (temp + rename). Returns the new roster.
 */
export function writeRoster(edit: RosterEdit, path = resolveConfigPath()): RosterConfig {
  const parsed = RosterEditSchema.parse(edit);
  const { doc, src } = parseFileDoc(path);

  const splices: Splice[] = [];
  if (parsed.defaults) {
    splices.push(...splicesForMap(doc, src, ['defaults'], parsed.defaults));
  }
  if (parsed.agents) {
    for (const [name, patch] of Object.entries(parsed.agents)) {
      const idx = agentIndex(doc, name);
      if (idx < 0) throw new RosterInputError(`unknown agent "${name}" — not in the roster`);
      splices.push(...splicesForMap(doc, src, ['agents', idx], patch));
    }
  }

  return applyAndPersist(src, splices, path);
}

// ── Add an agent ──────────────────────────────────────────────────────────────

/** A YAMLSeq item carries a [start, valueEnd, nodeEnd] range; start is the first
 *  key's offset (after the "- " marker), not the marker itself. */
type SeqItem = { range?: [number, number, number] };

function agentSeqItems(doc: Document): SeqItem[] {
  const seq = doc.get('agents', true) as { items?: SeqItem[] } | undefined;
  return seq?.items ?? [];
}

/** Title-case a slug for the bootstrapped prompt files' headings: "code-critic"
 *  → "Code Critic". */
function titleCase(name: string): string {
  return name.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function systemTemplate(name: string, purpose: string): string {
  return `# ${titleCase(name)} Agent

## Purpose

${purpose || 'TODO: describe what this agent does — and what it must never do.'}

## Instructions

- TODO: write this agent's operating instructions.
- You inherit the operator's shell environment — call tools by bare name (never an absolute /usr/bin path).
- Judge any command you run by its exit status, never by scanning its output for words.
`;
}

function userTemplate(name: string): string {
  return `# ${titleCase(name)} Task

## Variables

### prompt

{{prompt}}

## Task

TODO: use \`prompt\` to do this agent's work, then emit your Report JSON.

## Report

Respond with ONLY valid JSON matching this agent's output model — no prose before or after.
`;
}

/** Bootstrap the two prompt files a new agent's config REQUIRES. Never clobbers:
 *  if a file already exists (e.g. an agent of this name was removed earlier and
 *  its git-tracked files were left in place), its content is preserved. */
function bootstrapPromptFiles(name: string, purpose: string, peDir: string): void {
  const dir = join(peDir, name);
  mkdirSync(dir, { recursive: true });
  const sys = join(dir, 'system.md');
  const usr = join(dir, 'user.md');
  if (!existsSync(sys)) writeFileSync(sys, systemTemplate(name, purpose), 'utf8');
  if (!existsSync(usr)) writeFileSync(usr, userTemplate(name), 'utf8');
}

/** Serialize a new agent as a block-sequence item appended after the last agent,
 *  taking the dash/child indent from the first existing item's key column (so a
 *  non-standard indent is honoured, mirroring anchorInsertPoint's philosophy). */
function newAgentItemSplice(doc: Document, src: string, spec: AgentCreate, pePrefix: string): Splice {
  const items = agentSeqItems(doc);
  const first = items[0]?.range;
  const last = items[items.length - 1]?.range;
  if (!first || !last) {
    throw new RosterInputError(
      'cannot add an agent to an empty roster — seed the first agent in sssf.config.yaml',
    );
  }
  const keyStart = first[0];
  const keyLineStart = src.lastIndexOf('\n', keyStart - 1) + 1;
  const col = keyStart - keyLineStart; // e.g. 4 for "  - name:"
  const marker = `${' '.repeat(Math.max(0, col - 2))}- `;
  const child = ' '.repeat(col);

  // Build the object in a deliberate field order, keeping it minimal: only the
  // scalars the operator set, plus the two required keys. `writes: []` makes it
  // read-only until an operator grants writes through the editor.
  const obj: Record<string, unknown> = { name: spec.name };
  if (spec.coding_agent) obj.coding_agent = spec.coding_agent;
  if (spec.model) obj.model = spec.model;
  if (spec.thinking) obj.thinking = spec.thinking;
  if (spec.color) obj.color = spec.color;
  if (spec.purpose) obj.purpose = spec.purpose;
  obj.prompt_engineering = {
    system: `${pePrefix}/${spec.name}/system.md`,
    user: `${pePrefix}/${spec.name}/user.md`,
  };
  obj.writes = [];

  const lines = stringify(obj, { lineWidth: 0 }).replace(/\n+$/, '').split('\n');
  const block = lines.map((l, i) => (i === 0 ? `${marker}${l}` : `${child}${l}`)).join('\n');

  // Append after the last item's node end. The parser stretches the LAST item's
  // nodeEnd past its terminating newline (to EOF), while a middle item's stops
  // before it — so guard on whether we're already at a line boundary.
  const insertAt = last[2];
  const atLineStart = insertAt === 0 || src[insertAt - 1] === '\n';
  return { start: insertAt, end: insertAt, text: `${atLineStart ? '' : '\n'}${block}\n` };
}

/**
 * Add a new agent to the roster. Validates the whole rewritten config against the
 * mirror BEFORE touching disk, then bootstraps the two required prompt files, then
 * writes the YAML atomically — so a failure never leaves the config referencing a
 * file that isn't there. Like every config write it spawns nothing and touches no
 * run's trace. Returns the new roster.
 */
export function addAgent(
  spec: AgentCreate,
  path = resolveConfigPath(),
  peDir = resolvePromptEngineeringDir(),
  pePrefix = PROMPT_ENGINEERING_PREFIX,
): RosterConfig {
  const parsed = AgentCreateSchema.parse(spec);
  const { doc, src } = parseFileDoc(path);
  if (agentIndex(doc, parsed.name) >= 0) {
    throw new RosterInputError(`agent "${parsed.name}" already exists in the roster`);
  }
  const out = applySplices(src, [newAgentItemSplice(doc, src, parsed, pePrefix)]);
  const next = reparseAndValidate(out);
  // Config is valid — create the files it now references, then commit the YAML.
  bootstrapPromptFiles(parsed.name, parsed.purpose ?? '', peDir);
  writeAtomic(path, out);
  return next;
}

// ── Remove an agent ───────────────────────────────────────────────────────────

/**
 * Splice out one agent's whole block: from the start of its "- " line through its
 * terminating newline. Contiguous full-line comments directly above the item are
 * swept out with it (its own documentation leaves too), bounded by the previous
 * item's node end so a comment trailing the PREVIOUS agent is never taken.
 */
function removeAgentSplice(src: string, items: SeqItem[], idx: number): Splice {
  const item = items[idx]!.range!;
  const keyStart = item[0];
  const dashLineStart = src.lastIndexOf('\n', keyStart - 1) + 1;

  let start = dashLineStart;
  const prevEnd = idx > 0 ? (items[idx - 1]!.range![2] ?? items[idx - 1]!.range![1]) : 0;
  while (start > prevEnd) {
    const aboveEnd = start - 1; // the '\n' terminating the line above
    const aboveStart = src.lastIndexOf('\n', aboveEnd - 1) + 1;
    if (aboveStart < prevEnd || !src.slice(aboveStart, aboveEnd).trim().startsWith('#')) break;
    start = aboveStart;
  }

  // nodeEnd sits before the separating newline for a middle item; consume it so
  // the next agent slides up. The last item's nodeEnd is already at EOF (past its
  // newline), so there is nothing to consume and the previous newline stays.
  let end = item[2];
  if (src[end] === '\n') end += 1;
  return { start, end, text: '' };
}

/**
 * Remove an agent from the roster. Refuses to remove the LAST agent — an empty
 * `agents:` list is both useless and a serialization edge case we decline to
 * handle. NON-DESTRUCTIVE to the filesystem: the agent's prompt files (which are
 * git-tracked) are left in place; an operator can delete them by hand. Returns
 * the new roster.
 */
export function removeAgent(name: string, path = resolveConfigPath()): RosterConfig {
  const parsed = AgentNameSchema.parse(name);
  const { doc, src } = parseFileDoc(path);
  const items = agentSeqItems(doc);
  // Existence before the last-agent guard, so removing a name that isn't there
  // reports "unknown agent" rather than the misleading "last agent" message.
  const idx = agentIndex(doc, parsed);
  if (idx < 0) throw new RosterInputError(`unknown agent "${parsed}" — not in the roster`);
  if (items.length <= 1) {
    throw new RosterInputError('cannot remove the last agent — the roster needs at least one');
  }
  return applyAndPersist(src, [removeAgentSplice(src, items, idx)], path);
}

// ── Guardrails (advisory, surfaced in the UI — never a hard block) ────────────

export interface RosterWarning {
  agent: string;
  message: string;
}

/**
 * Non-fatal config smells the operator should see.
 *
 * There is deliberately NO "anthropic model on coding_agent: pi" warning: pi no
 * longer supports Anthropic, so the engine (agents.py::load_config) now forces
 * every `anthropic/*` model through claude_code regardless of the configured
 * backend. The mis-route it used to warn about can no longer happen, so warning
 * about it would be a false positive.
 */
export function rosterWarnings(cfg: RosterConfig): RosterWarning[] {
  const out: RosterWarning[] = [];
  for (const a of cfg.agents) {
    // An agent that loads a harness extension but has no explicit `tools` list
    // inherits defaults.tools (agents.py::load_config), which never names the
    // extension's tools — so pi filters them out and the extension is dead
    // weight. The remedy is to list the extension's tools in the agent's own
    // `tools`. (null here means the key is absent → inheriting.)
    if (a.harness_engineering.length > 0 && a.tools == null) {
      out.push({
        agent: a.name,
        message: `loads a harness extension but has no explicit tools list — its extension tools are filtered out; name them in tools.`,
      });
    }
  }
  return out;
}
