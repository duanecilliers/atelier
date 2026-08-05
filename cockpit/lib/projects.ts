/**
 * The projects registry — how one cockpit observes many stamped repos at once.
 *
 * Atelier used to be a single self-hosting repo: the cockpit read exactly one
 * `sssf.db`, resolved from `SSSF_*` env (or the sibling `../engine`). Once the
 * engine is *stampable* into any repo (Parts A–C), one cockpit should front
 * several checkouts. This module is the cross-project index that makes that
 * possible: a small JSON file listing `{ id, name, root, adwsSubdir }`, plus the
 * one function every reader/writer goes through to turn a project id into the
 * four filesystem paths the engine layout defines.
 *
 * It cannot live in any single `sssf.db` (it spans projects), so it is a file:
 * `cockpit/atelier.projects.json` (override with `ATELIER_PROJECTS`). The file is
 * gitignored — its `root`s are machine-specific — with a committed
 * `.example.json` beside it. When the file is ABSENT the cockpit falls back to a
 * single implicit "default" project resolved from the legacy `SSSF_*` env, so a
 * fresh checkout (and every test that sets `SSSF_DB`/`SSSF_CONFIG`/…) works with
 * zero registry config. That env fallback is also the single home of the default
 * path shapes: the `resolve*` functions in db.ts / roster.ts / skills.ts delegate
 * here (see `envProjectPaths`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

/** One registry entry. `root` may be relative (resolved from the cockpit cwd) or
 *  absolute; `adwsSubdir` reconciles Atelier's `engine/adws` with a stamped
 *  repo's root-level `adws`. */
export const ProjectSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, 'id must be a url-safe slug (a-z, 0-9, -, _)'),
  name: z.string().trim().min(1).max(120),
  root: z.string().trim().min(1),
  adwsSubdir: z.string().trim().min(1),
});
export type Project = z.infer<typeof ProjectSchema>;

export const ProjectsFileSchema = z.array(ProjectSchema);

/** The four filesystem paths every reader/writer needs, derived from one project
 *  (or from the legacy env in fallback mode). Matches the engine's on-disk layout
 *  under `{adwsDir}`: `adw_data/sssf.db`, `adw_sssf_config/sssf.config.yaml`,
 *  `adw_data/prompt_engineering`. */
export interface ProjectPaths {
  /** The project's repo root (absolute) — where `uv run` resolves adw_modules. */
  root: string;
  adwsDir: string;
  dbPath: string;
  configPath: string;
  promptEngineeringDir: string;
  /** The repo-root-relative prompt_engineering prefix written INTO the config
   *  (forward-slashed, `{adwsSubdir}/adw_data/prompt_engineering`). Stamped repos
   *  use `adws/…`, Atelier uses `engine/adws/…`. */
  promptEngineeringConfigPrefix: string;
}

// ── The engine layout, relative to a project's adws/ directory ─────────────────
const DB_UNDER_ADWS = ['adw_data', 'sssf.db'] as const;
const CONFIG_UNDER_ADWS = ['adw_sssf_config', 'sssf.config.yaml'] as const;
const PE_UNDER_ADWS = ['adw_data', 'prompt_engineering'] as const;

// ── The env-fallback (single-project) defaults ────────────────────────────────
// The cockpit runs from cockpit/, so the sibling engine tree is one level up.
// These are the ONE definition of the legacy path shapes; the resolve* helpers
// in db.ts / roster.ts / skills.ts return the matching field of envProjectPaths().
const DEFAULT_ADWS_RELATIVE = '../engine/adws';
const DEFAULT_DB_RELATIVE = '../engine/adws/adw_data/sssf.db';
const DEFAULT_CONFIG_RELATIVE = '../engine/adws/adw_sssf_config/sssf.config.yaml';
const DEFAULT_PE_RELATIVE = '../engine/adws/adw_data/prompt_engineering';
/** Env-mode config prefix — Atelier's native, engine/-prefixed layout. */
const DEFAULT_PE_CONFIG_PREFIX = 'engine/adws/adw_data/prompt_engineering';

const DEFAULT_PROJECT_ID = 'default';

function fromCwd(raw: string): string {
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

/** The single-project paths from `SSSF_*` env (or the sibling `../engine`). Used
 *  when no registry file exists, and as the escape hatch every test relies on. */
export function envProjectPaths(): ProjectPaths {
  return {
    root: resolve(process.cwd(), '..'),
    adwsDir: fromCwd(process.env.SSSF_ADWS_DIR ?? DEFAULT_ADWS_RELATIVE),
    dbPath: fromCwd(process.env.SSSF_DB ?? DEFAULT_DB_RELATIVE),
    configPath: fromCwd(process.env.SSSF_CONFIG ?? DEFAULT_CONFIG_RELATIVE),
    promptEngineeringDir: fromCwd(process.env.SSSF_PE_DIR ?? DEFAULT_PE_RELATIVE),
    promptEngineeringConfigPrefix: DEFAULT_PE_CONFIG_PREFIX,
  };
}

/** Compose a project's four paths from its `root` + `adwsSubdir`. */
export function composeProjectPaths(project: Project): ProjectPaths {
  const root = fromCwd(project.root);
  const adwsDir = resolve(root, project.adwsSubdir);
  return {
    root,
    adwsDir,
    dbPath: join(adwsDir, ...DB_UNDER_ADWS),
    configPath: join(adwsDir, ...CONFIG_UNDER_ADWS),
    promptEngineeringDir: join(adwsDir, ...PE_UNDER_ADWS),
    // Config-relative, forward-slashed (it's written into YAML, not the FS).
    promptEngineeringConfigPrefix: [project.adwsSubdir.replace(/\\/g, '/').replace(/\/+$/, ''), ...PE_UNDER_ADWS].join('/'),
  };
}

/** The implicit single project used when no registry file is present. Its paths
 *  come from `envProjectPaths()`, never from `composeProjectPaths()`. */
const ENV_FALLBACK_PROJECT: Project = {
  id: DEFAULT_PROJECT_ID,
  name: 'Atelier',
  root: '',
  adwsSubdir: '',
};

function registryPath(): string {
  return fromCwd(process.env.ATELIER_PROJECTS ?? 'atelier.projects.json');
}

/** Read + validate the registry file. Returns [] when the file is absent (the
 *  signal to fall back to the single env project). A present-but-invalid file
 *  throws loudly rather than silently degrading to a wrong project. */
function readRegistry(): Project[] {
  const path = registryPath();
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`atelier.projects.json is not valid JSON (${path}): ${(e as Error).message}`);
  }
  const projects = ProjectsFileSchema.parse(raw);
  const ids = new Set<string>();
  for (const p of projects) {
    if (ids.has(p.id)) throw new Error(`duplicate project id '${p.id}' in ${path}`);
    ids.add(p.id);
  }
  return projects;
}

/** True when a registry file is present — the signal that paths compose from
 *  `root`/`adwsSubdir` rather than the legacy env. Surfaces (e.g. the ADW builder)
 *  that must preserve exact env-mode behavior branch on this. */
export function isRegistryMode(): boolean {
  return readRegistry().length > 0;
}

/** The registry as the cockpit sees it: the file's projects, or the single env
 *  fallback when no file exists. Never empty — there is always at least one. */
export function getProjects(): Project[] {
  const reg = readRegistry();
  return reg.length > 0 ? reg : [ENV_FALLBACK_PROJECT];
}

/** Look up one project by id, or null if unknown. */
export function getProject(id: string): Project | null {
  return getProjects().find((p) => p.id === id) ?? null;
}

/** The default project id — the first listed, used for the bare-root redirect. */
export function defaultProjectId(): string {
  return getProjects()[0]!.id;
}

/**
 * Turn a project id into its four filesystem paths — the one resolver every
 * keyed connection (getDb/getControl/getReview) and config/skills reader goes
 * through. In env-fallback mode (no registry file) any id resolves to the single
 * env project. With a registry, an unknown id throws so a bad URL surfaces
 * honestly rather than silently reading the wrong repo. `undefined` selects the
 * default (first) project.
 */
export function pathsForProject(projectId?: string): ProjectPaths {
  const reg = readRegistry();
  if (reg.length === 0) return envProjectPaths();
  const project = projectId ? reg.find((p) => p.id === projectId) : reg[0];
  if (!project) throw new Error(`unknown project '${projectId}'`);
  return composeProjectPaths(project);
}
