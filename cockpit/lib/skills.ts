/**
 * The cookbook — the cockpit's read-only view of the factory's own recipes.
 *
 * A "recipe" is an ADW: one of the `engine/adws/adw_*.py` scripts, each composing
 * a fixed chain of phases (engineer intent · agent proposes · code disposes). They
 * are the capability library the agents draw on, so /skills reads them live from
 * disk and renders one card per recipe.
 *
 * This is a pure READ surface — no db, no config write, no process. It parses the
 * one thing each ADW is guaranteed to carry: its module docstring (title, tagline,
 * the `Phases:` chain, and the prose "why") plus its `REQUIRED_AGENTS` list. We
 * read the source text rather than importing anything Python; the docstring is the
 * contract the scripts already keep for a human reading the file, and we lean on
 * exactly that. `adw_worker.py` is excluded — it is the control-plane drainer, not
 * a recipe the factory composes.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { envProjectPaths } from './projects';

/** The single-project ADW directory: SSSF_ADWS_DIR wins, else the sibling engine
 *  directory. The multi-project dir comes from pathsForProject(); this is the
 *  env-fallback default (and test escape hatch), defined once in projects.ts. */
export function resolveAdwsDir(): string {
  return envProjectPaths().adwsDir;
}

export interface Recipe {
  /** The script stem, e.g. "adw_scout" — stable id. */
  id: string;
  /** Display name from the docstring title, "ADW <name> — …", e.g. "Scout". */
  name: string;
  /** The one-line tagline after the em-dash on the title line. */
  tagline: string;
  /** The `Phases:` chain, newlines collapsed to a single line. */
  phases: string;
  /** The chain tokenized into top-level steps (bounded-loop groups kept intact). */
  steps: string[];
  /** The prose paragraphs after the phase line — the recipe's "why" (may be empty). */
  detail: string[];
  /**
   * REQUIRED_AGENTS, or null when the script declares none. null means the roster
   * is chosen per run (adw_prompt's `--agent`); [] means the recipe is
   * deterministic — no agent proposes (adw_quality is all code phases).
   */
  agents: string[] | null;
  /** The source filename, e.g. "adw_scout.py". */
  file: string;
}

/** Grab the module docstring: the first triple-quoted string in the file. The ADW
 *  scripts open with the shebang + PEP 723 header, then this docstring — there is
 *  no earlier `"""`, so the first match is always the module doc. */
function moduleDocstring(src: string): string {
  return src.match(/"""([\s\S]*?)"""/)?.[1] ?? '';
}

/** Split a phase chain on top-level `->`, keeping any `[…]` bounded-loop group
 *  intact (its inner arrows are part of the group, not step separators). */
function splitSteps(chain: string): string[] {
  const steps: string[] = [];
  let depth = 0;
  let buf = '';
  for (let i = 0; i < chain.length; i++) {
    const c = chain[i]!;
    if (c === '[') depth++;
    else if (c === ']') depth = Math.max(0, depth - 1);
    if (depth === 0 && c === '-' && chain[i + 1] === '>') {
      steps.push(buf.trim());
      buf = '';
      i++; // consume the '>'
      continue;
    }
    buf += c;
  }
  steps.push(buf.trim());
  return steps.filter(Boolean);
}

/** REQUIRED_AGENTS = ["a", "b"] · REQUIRED_AGENTS: list[str] = [] · or absent. */
function parseAgents(src: string): string[] | null {
  const m = src.match(/^REQUIRED_AGENTS(?:\s*:[^=]+)?\s*=\s*\[([^\]]*)\]/m);
  if (!m) return null; // absent → agent chosen per run
  return [...m[1]!.matchAll(/["']([^"']+)["']/g)].map((x) => x[1]!);
}

/** Parse one ADW source into a Recipe. */
export function parseRecipe(file: string, src: string): Recipe {
  const doc = moduleDocstring(src);
  const id = basename(file, '.py');

  const titleLine = doc.split('\n').find((l) => l.trim()) ?? '';
  const title = titleLine.match(/^ADW\s+(.+?)\s+—\s+(.+)$/);
  const name = title ? title[1]!.trim() : id.replace(/^adw_/, '').replace(/_/g, ' ');
  const tagline = title ? title[2]!.trim() : '';

  // The `Phases:` block runs to the next blank line (or the docstring's end); the
  // prose after it is the "why". simple_sdlc wraps its chain over several lines, so
  // collapse interior whitespace to a single line before tokenizing.
  const phasesMatch = doc.match(/Phases:[ \t]*([\s\S]*?)(?:\n[ \t]*\n|$)/);
  const phases = phasesMatch ? phasesMatch[1]!.replace(/\s*\n\s*/g, ' ').trim() : '';
  const after = phasesMatch ? doc.slice(phasesMatch.index! + phasesMatch[0].length) : '';
  const detail = after
    .trim()
    .split(/\n[ \t]*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean);

  return {
    id,
    name,
    tagline,
    phases,
    steps: splitSteps(phases),
    detail,
    agents: parseAgents(src),
    file: basename(file),
  };
}

/**
 * Read every recipe from the ADW directory, smallest pipeline first (so the atoms
 * — prompt, scout — lead and the full SDLC trails). Excludes adw_worker.py.
 */
export function readRecipes(dir = resolveAdwsDir()): Recipe[] {
  if (!existsSync(dir)) {
    throw new Error(
      `ADW directory not found at ${dir} — set SSSF_ADWS_DIR, or point the ` +
        `cockpit at the engine's adws/ so the cookbook can be read.`,
    );
  }
  const files = readdirSync(dir)
    .filter((f) => f.startsWith('adw_') && f.endsWith('.py') && f !== 'adw_worker.py')
    .sort();

  const recipes = files.map((f) => parseRecipe(f, readFileSync(join(dir, f), 'utf8')));
  return recipes.sort((a, b) => a.steps.length - b.steps.length || a.name.localeCompare(b.name));
}

/**
 * The launchable ADW stems on disk, e.g. `adw_scout`. This is the dynamic
 * allowlist: it mirrors the worker's own rule (any `adw_*.py` except the
 * drainer), so an ADW built through the cockpit is enqueueable the moment its
 * file exists — no static catalog to update. `make_adw.py` is excluded for free
 * (it lacks the `adw_` prefix). Returns an empty set if the dir is missing.
 */
export function readAdwNames(dir = resolveAdwsDir()): Set<string> {
  if (!existsSync(dir)) return new Set();
  const names = readdirSync(dir)
    .filter((f) => f.startsWith('adw_') && f.endsWith('.py') && f !== 'adw_worker.py')
    .map((f) => basename(f, '.py'));
  return new Set(names);
}
