/**
 * Static parity guard for the config mirror - the one AGENTS.md flags as kept in
 * lockstep "BY HAND" and that check:contract does NOT cover (it's a file, not a db
 * table). Catches drift between:
 *   - roster.ts Zod schemas  <->  data_types.py Pydantic models  (field names)
 *   - roster-constants.ts enums  <->  data_types.py Literal[...] unions
 *
 * Pure text parse of both source files - no import of the Python, no live db. The
 * core is exported as `checkRosterMirror(repoRoot)` so scripts/check-parity.test.ts
 * can point it at a fixture with injected drift and prove it still bites; the CLI
 * wrapper at the foot runs it against the real repo. Repo root is derived from this
 * file's own location, not cwd, so it resolves the same sources from anywhere.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argv } from 'node:process';

const DEFAULT_REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const setOf = (xs: Iterable<string>) => new Set(xs);
const diff = (a: Set<string>, b: Set<string>) => [...a].filter((x) => !b.has(x));

/** Field names of a Pydantic `class Cls(BaseModel):` - exactly-4-space `name:` lines. */
function pyFields(py: string, cls: string): string[] {
  const lines = py.split('\n');
  let i = lines.findIndex((l) => new RegExp(`^class ${cls}\\(BaseModel\\):`).test(l));
  if (i < 0) return [];
  const fields: string[] = [];
  for (i++; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^\S/.test(l) && l.trim() !== '') break; // next top-level def/class/assignment
    const m = l.match(/^ {4}([a-z_][a-z0-9_]*):/);
    if (m) fields.push(m[1]!);
  }
  return fields;
}

/** The `{ ... }` body (open+1..close-1) of a `const NameSchema = z.object({ ... })`,
 *  found by brace-depth walk, or null if the schema/object is not present. */
function schemaBody(roster: string, name: string): string | null {
  const at = roster.search(new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*z\\.object\\(`));
  if (at < 0) return null;
  const open = roster.indexOf('{', at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < roster.length; i++) {
    if (roster[i] === '{') depth++;
    else if (roster[i] === '}' && --depth === 0) return roster.slice(open + 1, i);
  }
  return null;
}

/** TOP-LEVEL keys of a `z.object({ ... })`. Splits the body on depth-0 commas so a
 *  nested `z.object({...})`'s own keys are never mistaken for top-level fields; a
 *  leading `//` comment on an entry is skipped, the key taken from its first real line. */
function zodKeys(roster: string, name: string): string[] {
  const body = schemaBody(roster, name);
  if (body == null) return [];
  const keys: string[] = [];
  let depth = 0;
  let buf = '';
  const flush = () => {
    for (const line of buf.split('\n')) {
      const t = line.trim();
      if (t === '' || t.startsWith('//')) continue;
      const k = t.match(/^([a-z_][a-z0-9_]*):/);
      if (k) keys.push(k[1]!);
      break; // only the first meaningful line of a top-level entry holds its key
    }
    buf = '';
  };
  for (const ch of body) {
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) flush();
    else buf += ch;
  }
  flush();
  return keys;
}

/** The values of the FIRST `z.enum([...])` inside a named schema's own braces (bounded,
 *  so it can never bleed into a following schema's enum). */
function tsEnumIn(roster: string, name: string): Set<string> {
  const body = schemaBody(roster, name) ?? '';
  const inner = body.match(/z\.enum\(\[([^\]]*)\]\)/)?.[1] ?? '';
  return setOf([...inner.matchAll(/'([^']+)'/g)].map((m) => m[1]!));
}

// ── field-name parity per model ──────────────────────────────────────────────
const MODELS: Record<string, string> = {
  SSSFConfig: 'RosterConfigSchema',
  ConfigDefaults: 'ConfigDefaultsSchema',
  ObservabilityConfig: 'ObservabilitySchema',
  QualityCheckConfig: 'QualityCheckSchema',
  SandboxConfig: 'SandboxConfigSchema',
  SandboxProfile: 'SandboxProfileSchema',
  SandboxServices: 'SandboxServicesSchema',
  SandboxLand: 'SandboxLandSchema',
  SandboxNamer: 'SandboxNamerSchema',
  AgentConfig: 'AgentConfigSchema',
  PromptEngineering: 'PromptEngineeringSchema',
};

export interface RosterMirrorResult {
  problems: string[];
  models: number;
  enums: number;
}

export function checkRosterMirror(repo: string = DEFAULT_REPO): RosterMirrorResult {
  const read = (rel: string) => readFileSync(resolve(repo, rel), 'utf8');
  const py = read('engine/adws/adw_modules/data_types.py');
  const roster = read('cockpit/lib/roster.ts');
  const constants = read('cockpit/lib/roster-constants.ts');

  const problems: string[] = [];

  for (const [model, schema] of Object.entries(MODELS)) {
    const pf = setOf(pyFields(py, model));
    const zf = setOf(zodKeys(roster, schema));
    if (pf.size === 0) problems.push(`could not parse Pydantic model ${model}`);
    if (zf.size === 0) problems.push(`could not parse Zod schema ${schema}`);
    for (const f of diff(pf, zf)) problems.push(`${model}.${f}: in data_types.py, missing from ${schema}`);
    for (const f of diff(zf, pf)) problems.push(`${schema}.${f}: in roster.ts, missing from ${model}`);
  }

  // ── enum parity ────────────────────────────────────────────────────────────
  const rcArray = (name: string): Set<string> => {
    const body = constants.match(new RegExp(`export const ${name}\\s*=\\s*\\[([^\\]]*)\\]`))?.[1] ?? '';
    return setOf([...body.matchAll(/'([^']+)'/g)].map((m) => m[1]!));
  };
  const pyLiteral = (re: RegExp): Set<string> => {
    const body = py.match(re)?.[1] ?? '';
    return setOf([...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]!));
  };

  const enums: [string, Set<string>, Set<string>][] = [
    ['coding_agent', rcArray('CODING_AGENTS'), pyLiteral(/coding_agent:\s*Literal\[([^\]]*)\]/)],
    ['quality area', rcArray('QUALITY_AREAS'), pyLiteral(/QualityArea\s*=\s*Literal\[([^\]]*)\]/)],
    ['quality operation', rcArray('QUALITY_OPERATIONS'), pyLiteral(/QualityOperation\s*=\s*Literal\[([^\]]*)\]/)],
    ['sandbox land mode', tsEnumIn(roster, 'SandboxLandSchema'), pyLiteral(/mode:\s*Literal\[([^\]]*)\]/)],
  ];
  for (const [label, ts, python] of enums) {
    if (ts.size === 0 || python.size === 0) {
      problems.push(`could not parse the '${label}' enum on one side (ts=${ts.size}, py=${python.size})`);
      continue;
    }
    for (const v of diff(ts, python)) problems.push(`enum ${label}: '${v}' in TS, missing from Python`);
    for (const v of diff(python, ts)) problems.push(`enum ${label}: '${v}' in Python, missing from TS`);
  }

  return { problems, models: Object.keys(MODELS).length, enums: enums.length };
}

// ── CLI (only when run directly, not when imported by the test) ───────────────
const invokedDirectly = !!argv[1] && realpathSync(argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const { problems, models, enums } = checkRosterMirror();
  if (problems.length) {
    console.error('✗ roster mirror parity FAILED:\n' + problems.map((p) => `  - ${p}`).join('\n'));
    process.exit(1);
  }
  console.log(`✓ roster mirror holds (${models} models, ${enums} enums)`);
}
