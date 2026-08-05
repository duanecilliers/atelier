/**
 * The ADW builder seam — the cockpit's wrapper around the engine's make_adw.py.
 *
 * UNLIKE every other write surface in the cockpit, this one **spawns a process**:
 * it shells out to `uv run engine/adws/make_adw.py` to generate a new ADW script.
 * That is a deliberate, narrow exception, and it does NOT touch the determinism
 * spine:
 *   • make_adw.py is a pure code generator — no model, no db, no run trace.
 *   • the script it writes is reviewed (preview) before it can ever be launched.
 *   • turning a queued row into a running ADW is still adw_worker.py's sole job.
 * make_adw.py is the single source of truth for the block catalog AND for
 * validating a chain (canonical order, per-block requirements); this module only
 * marshals arguments and surfaces the generator's own stderr on a bad spec.
 *
 * It writes into engine/adws/ (honoring SSSF_ADWS_DIR exactly like lib/skills.ts,
 * so a test can isolate the dir), which is where the worker and the /skills
 * cookbook already read ADWs from — so a freshly-built recipe needs no further
 * registration.
 */
import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

/**
 * The REAL engine/adws directory — the sibling of cockpit/, same default path
 * lib/skills.ts uses. This deliberately IGNORES SSSF_ADWS_DIR: that override
 * relocates where make_adw.py *writes* (make_adw reads the env itself), but the
 * generator script always lives in the real tree. Resolving it from the override
 * would send us looking for make_adw.py in the temp dir during isolation tests.
 */
const ENGINE_ADWS_DIR = resolve(process.cwd(), '../engine/adws');

/** A generator run exited non-zero — carries its stderr for a 400 to the client. */
export class AdwBuildError extends Error {}

/** Mirrors make_adw.py::NAME_RE for a fast, clear client error; make_adw is the
 *  authority (it also rejects reserved names, bad order, unmet requirements). */
const NAME_RE = /^[a-z][a-z0-9_]*$/;

export const AdwCreateSchema = z.object({
  name: z.string().trim().regex(NAME_RE, 'name must be lowercase letters, digits and underscores, starting with a letter'),
  steps: z.array(z.string().trim().min(1)).min(1, 'name at least one phase block'),
  preview: z.boolean().optional(),
});
export type AdwCreateSpec = z.infer<typeof AdwCreateSchema>;

export interface BlockSpec {
  id: string;
  kind: 'agent' | 'code';
  owner: string;
  requires: string[];
  label: string;
  blurb: string;
}
export interface StepCatalog {
  canonical: string[];
  blocks: BlockSpec[];
}

function makeAdwPath(): string {
  return join(ENGINE_ADWS_DIR, 'make_adw.py');
}

/** The engine repo root — where the ADWs run, so `uv run` resolves adw_modules. */
function repoRoot(): string {
  return resolve(ENGINE_ADWS_DIR, '..', '..');
}

/** `uv run make_adw.py <args>`, resolving stdout or throwing AdwBuildError with
 *  the generator's own message. A non-zero exit puts stderr on `err.stderr`. */
async function runGenerator(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('uv', ['run', makeAdwPath(), ...args], {
      cwd: repoRoot(),
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === 'ENOENT') {
      throw new Error('`uv` was not found on PATH — the cockpit needs uv to run the ADW generator.');
    }
    const detail = (err.stderr ?? '').trim() || err.message;
    throw new AdwBuildError(detail.replace(/^error:\s*/, ''));
  }
}

/** The block catalog make_adw.py exposes — the builder palette. */
export async function listSteps(): Promise<StepCatalog> {
  const out = await runGenerator(['--list-steps', '--json']);
  return JSON.parse(out) as StepCatalog;
}

/** Generate a script. `preview` returns the source without writing; otherwise the
 *  file is written to engine/adws/ and its path is returned. */
export async function buildAdw(
  spec: AdwCreateSpec,
): Promise<{ preview: true; source: string } | { preview: false; path: string; name: string }> {
  const { name, steps, preview } = AdwCreateSchema.parse(spec);
  const base = ['--name', name, '--steps', steps.join(',')];

  if (preview) {
    const source = await runGenerator([...base, '--stdout']);
    return { preview: true, source };
  }
  const out = await runGenerator([...base, '--json']);
  const { path } = JSON.parse(out) as { path: string; name: string };
  return { preview: false, path, name: `adw_${name}` };
}
