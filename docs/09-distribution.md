# Distribution — stamping the engine into any repo, and the multi-project cockpit

Atelier started as a self-hosting monorepo: one git root holding the engine, the cockpit, and
its own `sssf.db`. **Distribution** turns that engine into something *stampable into any project
repo*, so a target repo can run ADWs against its own code, pull later Atelier improvements without
losing its own layer, and be observed alongside every other stamped repo from **one central
cockpit**.

This guide assumes you've read [README.md](README.md), [01-architecture.md](01-architecture.md)
(the seam, propose/dispose, the determinism spine), and [07-operations.md](07-operations.md) (the
worker & `run_queue` lifecycle). The long-form design rationale — the decisions, the alternatives
rejected — lives in the [distribution design note](design/atelier-distribution.md); this guide is
how the landed system works.

## 1. The shape

Four mechanisms, each a small script or file, that hold together:

```
┌─ Atelier checkout (the source) ─────────────────────────┐
│  engine/adws/**  ·  engine/skills/atelier/**             │  the live payload
│  engine/adws/install.py  ·  engine/adws/update.py        │  the stampers
└──────────────┬───────────────────────────────────────────┘
   install.py   │  generates adws/ into the target, writes .atelier/manifest.json
┌──────────────▼───────────────────────────────────────────┐
│  target repo (any project)                                │  MANAGED = in the manifest
│  adws/**  ·  adws/adw_sssf_config/sssf.config.yaml        │  USER    = never in the manifest
│  .agents/skills/atelier/**  ·  .atelier/manifest.json     │  RUNTIME = gitignored (sessions, db)
│  (.claude/skills, .pi/skills → ../.agents/skills)         │  cross-agent skill discovery
└──────────────┬───────────────────────────────────────────┘
   registry     │  cockpit/atelier.projects.json lists each project = one repo root
┌──────────────▼───────────────────────────────────────────┐
│  cockpit — one app, many projects                         │  keyed connection per project
│  /[project]/runs/…  (URL segment)                         │  reads that project's sssf.db
└──────────────┬───────────────────────────────────────────┘
   worker intent│  workerDesired flag in the registry (cockpit writes; supervisor disposes)
┌──────────────▼───────────────────────────────────────────┐
│  supervisor — adw_worker.py --supervise                   │  reads the SAME registry, keeps one
│  → per-repo workers, each in its project's cwd            │  worker per desired project alive
└───────────────────────────────────────────────────────────┘
```

Two update axes exist; distribution automates only one:

| Axis | Direction | Mechanism |
| --- | --- | --- |
| **A** | Atelier ← upstream `disler/sssf` | Manual `diff` by hand — the carried delta is small. Out of scope. |
| **B** | **stamped repo ← Atelier** | **`update.py` + `.atelier/manifest.json`** — the subject of §3. |

### The three buckets

Every file in a stamped repo falls into exactly one bucket, and the bucket decides whether the
updater ever touches it:

| Bucket | What | In the manifest? | Updater behavior |
| --- | --- | --- | --- |
| **MANAGED** | Pure engine code — `adws/adw_modules/*.py`, `adws/adw_*.py`, and the operator skill `.agents/skills/atelier/**` | Yes (path → sha256) | Kept current; new files discovered and stamped automatically |
| **USER** | Your layer — `sssf.config.yaml`, `adw_data/prompt_engineering/**`, the `justfile`, `.env.sample`, **and anything you add** (custom ADWs, prompts, your own skills) | No | Never touched — invisible to updates by construction |
| **RUNTIME** | `adw_data/sessions/`, `sssf.db*` | No (gitignored) | Never stamped |

The manifest *is* the MANAGED/USER boundary. There is no forced `custom/` convention: a file you
add is simply not in the manifest, so the updater cannot see it. This is why **extension is free**.

## 2. Stamp — `install.py`

`engine/adws/install.py` (a zero-dependency PEP 723 `uv` script) generates the stamp. Run it from
your Atelier checkout, pointed at a target repo:

```bash
uv run engine/adws/install.py /path/to/target-repo          # target must already be a git repo
uv run engine/adws/install.py /path/to/new-repo --init      # or git-init it first
```

**Generate, don't mirror.** The payload is read *live* from `engine/adws/` and `engine/skills/` —
there is no committed `templates/` copy that could drift from the real engine. What lands, and where:

- **MANAGED code**, copied and hashed into `.atelier/manifest.json`:
  `managed_files()` *discovers* the set by scanning — every `adw_modules/**/*.py`, every top-level
  `adw_*.py` (including `adw_worker.py`), and every file under `engine/skills/`. `target_rel()`
  maps each to its native target path: `engine/adws/adw_modules/x.py → adws/adw_modules/x.py`, and
  `engine/skills/atelier/SKILL.md → .agents/skills/atelier/SKILL.md`. Adding a module, ADW, or skill
  file to the engine adds it to the managed set with no list to edit.
- **Cross-agent skill symlinks** (not in the manifest): after copying, `_ensure_agent_skill_symlinks`
  links `.claude/skills` and `.pi/skills` at `../.agents/skills`, so Claude Code, Codex (which reads
  `.agents/skills` natively), and PI operators all discover the one stamped tree. It only ever links
  where nothing (or an empty dir) is — a skills dir holding your own skills is left untouched. The
  engine keeps this operator skill *out* of ADW coding agents: `agent_cc.py` isolates the Claude SDK
  (`setting_sources: []`) and `agent_pi.py` passes `--no-skills`.
- **USER data, stamped once** (never in the manifest): the live `prompt_engineering/` tree, plus
  the authored starters from `engine/dist/` — `sssf.config.starter.yaml → adws/adw_sssf_config/sssf.config.yaml`
  (native `adws/` layout, no `engine/` prefix), the `justfile`, and `env.sample → .env.sample`.
- **Ignore rules**: a nested `adws/.gitignore` for the adws runtime (`adw_data/sessions/`,
  `sssf.db*`, `__pycache__/`), plus an `.env` line appended to the repo-root `.gitignore`.
- **The manifest** — `.atelier/manifest.json`: `{ atelier_version: <Atelier git sha>, stamped: { <target-rel path>: <sha256 at stamp> } }`.

**Idempotent by refusal.** Install is the *first* stamp. If `.atelier/manifest.json` already
exists, `install.py` stops and points you at `update.py`, so a re-run can never clobber your roster
or silently rewrite the manifest. It also refuses to stamp Atelier into itself, and requires the
target to be a git repo (Atelier commits its work).

Individual file copies are skip-existing, so a partial or interrupted stamp is safe to re-run only
before the manifest lands; after that, use `update.py`.

## 3. Update — `update.py` + the manifest

`engine/adws/update.py` pulls later Atelier engine improvements into a stamped repo — **Axis B**.
Run it from your Atelier checkout against an already-stamped target:

```bash
uv run engine/adws/update.py /path/to/stamped-repo
```

Only the MANAGED set moves. It reuses `install.py`'s discovery and hashing, then reconciles each
managed file by content hash against the manifest:

| Target state | vs. stamp hash | Action |
| --- | --- | --- |
| absent | — | new upstream file → **stamp it**, record hash |
| present | `== stamp` (untouched since stamp) | **overwrite** with new code, bump hash |
| present | `== new` already | already current (or a user edit that matches upstream) → nothing to write, record hash |
| present | `!=` both stamp and upstream | **you edited managed code** → write `<file>.atelier-new` beside it, **never clobber**, keep the old hash so it stays flagged next run |
| in manifest, gone upstream, untouched | `== stamp` | **removed from Atelier** → delete it, drop from manifest |
| in manifest, gone upstream, edited | `!=` stamp | keep it, report as `KEPT` (now unmanaged) |

A conflict is yours to reconcile: `diff <file>` against `<file>.atelier-new`, take what you want,
delete the `.atelier-new`. Managed files aren't meant to be hand-edited — [Part B](#5-what-made-updates-clean--the-qualitypy-move)
moved the one file everyone *had* to edit (the verify commands) out into the config — so conflicts
should be rare. `git merge-file` auto-merge (the stamped repo is already git) is a documented future
upgrade, not built.

Your USER layer — roster, prompts, custom ADWs, your own skills — is not in the manifest, so
`update.py` never lists it. That is the whole safety property.

> **Prompts are USER-bucket, so a prompt fix does *not* reach existing stamps via `update.py`.**
> It reaches Atelier-self runs and *new* stamps only. Propagating a prompt change to an already-stamped
> repo is a manual copy (as was done for the read-only-agent fix into `lunacomet`). Only MANAGED code
> — modules, ADWs, the skill — rides the updater.

## 4. The `/atelier` operator skill — MANAGED, single-source

`engine/skills/atelier/` is the **operator skill** for driving a stamped factory — one `SKILL.md`
router plus cookbooks and references, written for the native `adws/` layout. It is the **single
source**, and it is **agent-agnostic**: Claude Code, Codex, and PI all read the same `SKILL.md`
format (the "Agent Skills spec"); they only differ in which dir they scan, and each follows
symlinks. So the skill lands once at the vendor-neutral **`.agents/skills/atelier/`** and the other
harnesses' dirs are symlinked to it:

- **Canonical location** — `.agents/skills/atelier/`. Codex reads `.agents/skills` natively (a
  first-class repo-scope path in its loader). `install.py::_ensure_agent_skill_symlinks` then links
  **`.claude/skills` → `../.agents/skills`** (Claude Code) and **`.pi/skills` → `../.agents/skills`**
  (PI). One tree, three consumers.
- **The Atelier checkout** mirrors the same scheme — `.agents/skills/atelier` → `engine/skills/atelier`,
  with the two vendor symlinks — so `/atelier` (and its Codex/PI equivalents) works in this repo too,
  with zero drift.
- **`install.py` stamps** the real files into each target's `.agents/skills/atelier/` (it's in the
  managed scan) and creates the symlinks, so a stamped repo can drive itself from any of the three.
- **`update.py` keeps it current** and **self-heals** — it migrates pre-`.agents` stamps (which kept
  the skill at `.claude/skills`), prunes the emptied old dirs, and (re)creates the vendor symlinks. A
  hand-edited cookbook is parked as `<file>.atelier-new`, never clobbered, like any managed file.

The symlink helper is **conservative**: it only ever links where nothing (or an empty dir) is, so a
vendor skills dir you filled with your own skills is left untouched.

The skill is **layout-aware**: if a top-level `adws/` is absent but `engine/adws/` is present, it
detects the Atelier source repo and translates `adws/ → engine/adws/` throughout. So the *same*
`SKILL.md` is correct in both a stamped repo and the source.

**Keep it in lockstep with engine behavior.** Because it documents backends, gates, config schema,
and observability, a change to any of those must update `engine/skills/atelier/` in the same change
— it is MANAGED for exactly this reason (see [AGENTS.md](../AGENTS.md)).

> **The operator skill must stay out of ADW coding agents.** The engine spawns pi/claude_code/cursor
> as coding-agent backends with `cwd` = the repo, and pi auto-discovers `.pi/skills` (and the
> operator's `~/.pi/agent/skills`) unless stopped. Two guards enforce isolation: `agent_cc.py` runs
> the Claude SDK with `setting_sources: []`, and `agent_pi.py` passes `--no-skills`. Also never
> surface the skill via `AGENTS.md`/`CLAUDE.md` — those are injected into `claude_code` agents as
> `project_guidance` (see [03-agents-and-gates.md](03-agents-and-gates.md)), which would leak
> operator instructions into ADW agents. The `.agents/skills` + symlink scheme is the supported route;
> no per-harness rules-file pointer is needed.

## 5. What made updates clean — the `quality.py` move

The prerequisite that makes Axis B safe (design **Part B**). `adw_modules/quality.py` used to be
Atelier-owned code that *every user was forced to edit*: the verify commands were hardcoded Python
behind a "REPLACE THE PLACEHOLDER" banner, so the file was simultaneously managed and per-repo user
data — the hardest possible merge conflict.

The fix was structural, not a merge engine: the verify commands moved into `sssf.config.yaml`, which
the operator already owns and the updater never touches. A `quality:` block maps `name → { argv,
timeout?, area?, operation? }`; `quality.py` builds its block list from `run.cfg.quality` in file
order. An empty or absent block runs nothing and *says so* — the honest replacement for the old
fake-green echoes. With the commands out of it, `quality.py` is purely managed and the conflict
disappears. See [05-config-and-roster.md](05-config-and-roster.md) for the `quality:` block schema
and its cockpit roster mirror.

## 6. The multi-project cockpit

Stamping into *many* repos makes the cockpit a **multi-project console**: one Next.js app that
observes and controls N stamped repos. Three pieces (design **Part E**):

### The projects registry

`cockpit/atelier.projects.json` (override with `ATELIER_PROJECTS`) — a cross-project index that
cannot live in any single `sssf.db`, so it is a file. It is gitignored (its `root`s are
machine-specific), with a committed `atelier.projects.example.json` beside it. Each entry:

```json
{ "id": "lunacomet", "name": "Luna Comet", "root": "/abs/or/relative/repo", "adwsSubdir": "adws", "workerDesired": false }
```

`adwsSubdir` reconciles the two layouts in one field: Atelier self-hosts at `engine/adws`, a stamped
repo uses `adws`. `pathsForProject()` (`lib/projects.ts`) turns an entry into the four filesystem
paths the engine layout defines — the db, the config, the prompt dir, the adws dir — all derived from
`root + adwsSubdir`, no per-project env vars.

**Env fallback keeps single-project simple.** When the registry file is **absent**, the cockpit
falls back to one implicit `default` project resolved from the legacy `SSSF_*` env
(`SSSF_DB`/`SSSF_CONFIG`/`SSSF_PE_DIR`/`SSSF_ADWS_DIR`). So a fresh Atelier checkout — and every test
that sets those vars — works with zero registry config.

### Keyed connections

`getDb(projectId)` / `getControl(projectId)` (`lib/data.ts`) memoize **one connection per resolved
db path** on `globalThis` (a `Map`, not a single global). The SQL underneath is unchanged — the
readonly-by-construction reader, the `run_queue`-only control writer, and the roster/review writers
from [06-cockpit.md](06-cockpit.md) all still hold; they just take a project descriptor instead of
reading env. Two ids pointing at one db share a connection; an env-fallback project and any id
mapping to the same path share too.

### URL-segment routing

Every page lives under `app/[project]/…` — `/[project]/runs/[adwId]`, `/[project]/cost`, `/gates`,
`/agents`, `/queue`, `/skills`. The bare root `/` redirects to `/{defaultProjectId()}`. The
project-scoped `layout.tsx` reads the registry (`force-dynamic`, so a newly-added project appears
without a rebuild), `404`s an unknown project id rather than silently reading the wrong db, and
renders the shell with a project switcher. Only `{ id, name }` crosses to the client — never the
filesystem `root`s. `lib/nav.ts` links and the command palette prefix the current project segment
at navigation time, so nav entries stay project-agnostic.

## 7. The supervisor + `workers` heartbeat

Stamping into many repos means N workers — one draining each project's `run_queue`. The
**supervisor** manages them, and a per-project **heartbeat** lets the cockpit answer, honestly,
whether a worker is attached (design **Part F**).

### The supervisor — `adw_worker.py --supervise`

Not a separate process: the worker gains a cross-project mode.

```bash
uv run engine/adws/adw_worker.py --supervise                  # reads the default registry
uv run engine/adws/adw_worker.py --supervise --registry /path/to/atelier.projects.json
```

`supervise()` re-reads the registry every poll and keeps **exactly one worker per `workerDesired`
project** draining that project's queue — each spawned in the project's own `cwd`, so it resolves
its `REPO_ROOT` and config from where it runs, byte-identically to a hand-launched `just worker` in
that repo. Toggling `workerDesired` takes effect within a poll: a newly-desired project gets a
worker; an undesired or removed one gets a `SIGTERM` and drains its in-flight runs before exiting. A
crashed worker is simply absent next loop, so it is respawned — restart-on-crash for free. The
supervisor connects to no db itself; each worker heartbeats its own.

**The supervisor is the one new thing allowed to spawn** (besides a worker spawning an ADW). This
*preserves* the determinism spine rather than bending it — see below.

### The `workers` table — per-project liveness

`adw_modules/workers.py` defines a `workers` table folded into the tracer's `SCHEMA` (like
`run_queue` from `queue.py`), so a fresh db has it from the first ADW run. Each worker upserts a row
every poll into its **own** repo's `sssf.db`, keeping "the db is the seam" true per project:

| column | meaning |
| --- | --- |
| `host` | machine the worker runs on |
| `pid` | the worker process id (`os.getpid`) |
| `started_at` | when this worker began draining (fixed for its life) |
| `last_seen_at` | refreshed every poll — **freshness = attached** |

`PRIMARY KEY (host, pid)`. On startup a worker sweeps prior rows for its host (a single live worker
per project), and on graceful exit it deletes its row so the cockpit shows "no worker" at once; a
crash leaves the row to age out on its own. The cockpit reads the freshest `last_seen_at` (within
~3× the poll interval = alive) so **"no worker attached" is a real, honest state, not a guess**.

Like every seam table, `workers` is mirrored in `cockpit/lib/types.ts` and `cockpit/lib/schemas.ts`
(its columns all ship in the `CREATE`, so none are `.optional()` — a fresh table is a hard
requirement of `pnpm check:contract`). See the seam contract in [AGENTS.md](../AGENTS.md) and
[02-engine-runtime.md](02-engine-runtime.md) §6.

### "Start worker" = write intent

The cockpit's worker control (`app/api/projects/worker/route.ts`) is the control plane one level up:

- **GET** `→ { attached, desired, registryMode, last_seen_at }` — the footer poll. `attached` comes
  from `getDb(project).workerStatus()`; a missing `sssf.db` reports detached rather than 500-ing.
- **POST** flips `workerDesired` in `atelier.projects.json` via `setWorkerDesired()` — **intent
  only**. The supervisor disposes, exactly like `enqueue()` writes a `run_queue` row and the worker
  disposes. **The cockpit still never spawns a process.**

## 8. Layout & path resolution (why it survives stamping)

Two facts make the engine stampable near byte-for-byte:

- **The `engine/` prefix is config, not code.** No `adw_modules/*.py` hardcodes `engine/`.
  `data_types.py` defaults to `adws/adw_data`, `adws/adw_modules/`, etc.; Atelier just *overrides*
  those via config and by passing `--config engine/adws/…`. `repo_root()` resolves via
  `git rev-parse --show-toplevel`. So the module code is path-agnostic; the `engine/` layout is an
  invocation concern only.
- **The worker resolves from git + config, never from `Path(__file__)`** (design **Part D**).
  `adw_worker.py` sets `REPO_ROOT = git_helper.repo_root()` (git toplevel from **cwd**) and derives
  the adws dir from the config path relative to the root. `Path(__file__)` would break in two ways
  in stamped repos: there is no `engine/` segment to walk, and when `adws/` is a **symlink into a
  shared dir** (a bare-repo-with-worktrees layout where each worktree symlinks in a shared `adws/`),
  `Path(__file__).resolve()` follows the symlink to the *target* and resolves the wrong repo. Git
  toplevel from cwd returns the worktree the worker was launched in — the root its runs must commit
  to. When extending the engine, **audit any new path logic for `Path(__file__)` and resolve via
  git/cwd/config instead**, or you re-break stamping into worktrees.

## 9. Operating it

| Task | Command |
| --- | --- |
| Stamp the engine into a repo | `uv run engine/adws/install.py /path/to/target [--init]` |
| Pull later Atelier code into a stamped repo | `uv run engine/adws/update.py /path/to/stamped-repo` |
| Supervise workers across all desired projects | `uv run engine/adws/adw_worker.py --supervise` |
| Register a project in the cockpit | add an entry to `cockpit/atelier.projects.json` |

Inside a stamped repo the native layout applies: run ADWs as `uv run adws/adw_*.py`, the config is
`adws/adw_sssf_config/sssf.config.yaml`, and the stamped `justfile` carries the same recipes as the
source. The `/atelier` skill drives all of this from inside the repo.

## Extending this subsystem

- **Add a managed engine file** (module, ADW) — just add it under `engine/adws/`; `managed_files()`
  discovers it, so `install.py` stamps it and `update.py` propagates it with no list to edit.
- **Add a cockpit page** — put it under `app/[project]/…` and read `getDb(projectId)` with the
  segment; the bare-route era is gone (see [06-cockpit.md](06-cockpit.md)).
- **Add a seam column to `workers`** (or any table) — follow
  [Recipe E](08-extending-the-system.md#recipe-e--add-a-column-to-a-trace-table-or-run_queue): change
  the DDL, mirror in `types.ts` + `schemas.ts`, run `pnpm check:contract`.
- **Never let the cockpit spawn a process.** New worker/run controls write *intent* (a registry flag
  or a `run_queue` row); the worker or supervisor disposes. That invariant is the point.
