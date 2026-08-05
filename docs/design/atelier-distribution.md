# Design note — Distribution: stamping, updating, and the multi-project cockpit

> **Status: PROPOSED — not yet implemented.** This note captures the design decided across a
> planning session so a future session can pick it up without re-deriving it. Nothing here is
> built; no branch or PR exists for it. When it lands, fold the relevant parts into the numbered
> guides and drop the status note in [`docs/README.md`](../README.md).

## Goal

Turn Atelier from a self-hosting monorepo into something **stampable into any project repo**, with
three properties that must hold together:

1. **Stamp** — install the engine into a target repo with one command, the way upstream SSSF's
   `install.py` does today.
2. **Update** — once stamped, a repo can pull later Atelier improvements (module fixes, new ADWs,
   the worker/supervisor) **without clobbering the user's own layer** (roster, prompts, custom
   ADWs, custom skills).
3. **Extend** — inside a stamped repo, the user adds their own ADWs, prompts, and skills, and those
   are **invisible to the updater** by construction.

Plus the console-side consequence of stamping into *many* repos: the **cockpit becomes a
multi-project console** that observes and controls N stamped repos, and a **supervisor** keeps a
worker attached to each.

Two update axes exist; only one is in scope here:

| Axis | Direction | Mechanism | In scope? |
| --- | --- | --- | --- |
| **A** | Atelier ← upstream `disler/sssf` | Manual `diff` when desired. Drift is tiny (see below). | No — handled by hand. |
| **B** | **Stamped repo ← Atelier** | **The manifest + hash updater in this note.** | **Yes — this is the ask.** |

## The three layers

```
┌─ upstream disler/sssf ──────────────────┐  Axis A: manual diff (out of scope)
└──────────────┬───────────────────────────┘
┌──────────────▼───────────────────────────┐
│  Atelier — the `atelier` skill            │  Axis B upstream for stamped repos
│  • engine-only stamp payload (templates/) │
│  • claude_code backend (ahead of upstream)│
│  • queue.py · adw_worker · supervisor     │
│  • install.py · update.py                 │
└──────────────┬───────────────────────────┘
   install.py   │  stamps `adws/` into the target repo, writes .atelier/manifest.json
┌──────────────▼───────────────────────────┐
│  target repo (any project)                │  MANAGED  = in the manifest (Atelier owns)
│  adws/ · sssf.config.yaml · sssf.db       │  USER     = not in the manifest (never touched)
│  .atelier/manifest.json                   │  RUNTIME  = gitignored (sessions, sssf.db)
└──────────────┬───────────────────────────┘
   projects json│  each project = one repo root
┌──────────────▼───────────────────────────┐
│  cockpit — multi-project console          │  reads cockpit/atelier.projects.json,
│  /[project]/runs/… (URL segment)          │  one keyed connection per project
└──────────────┬───────────────────────────┘
   writes intent│  (enqueue · cancel · worker_desired)
┌──────────────▼───────────────────────────┐
│  supervisor (always-on)                   │  reads the SAME projects json, ensures one
│  → per-repo workers (correct cwd)         │  worker per project, heartbeats liveness
└───────────────────────────────────────────┘
```

## Chosen shape (decisions locked)

| Axis | Decision | Why |
| --- | --- | --- |
| Stamp scope | **Engine only** | A stamped repo gets `adws/` in SSSF's native layout. The cockpit stays central (one app, many projects); no Next.js app per repo. |
| Layout reconciliation | Project descriptor carries **`adwsSubdir`** | Atelier self-hosts at `engine/adws/`; a stamped repo uses `adws/`. One field reconciles both everywhere. |
| Update model (Axis B) | **Manifest + content-hash**, skip-or-flag on conflict | Zero-dep, matches SSSF's PEP-723 ethos. No merge engine needed once `quality.py` is data-driven. |
| The `quality.py` problem | **Move verify commands into `sssf.config.yaml`** | Converts the one managed-file-users-must-edit into managed code + user data that never collide. Prerequisite for clean updates. |
| Skill distribution | **User scope** (`~/.claude/skills/atelier/`), version-pinned | One Atelier upgrade makes `atelier update` available in every project; each reconciles at its own pace. |
| Cockpit multi-project | **Projects registry file** + **URL-segment routing** (`/[project]/…`) | Explicit, shareable per-project URLs; makes 8-hex `adw_id`s unambiguous across repos. |
| Worker lifecycle | **Always-on supervisor**; cockpit writes intent, supervisor disposes | Preserves the #1 invariant (the cockpit never spawns). Same shape as the existing control plane. |

### Alternatives rejected

- **Stamp engine + cockpit into every repo** — self-contained per repo, but a Next.js app + node
  deps + build in every project is heavy, and a per-repo UI can't give the cross-project view that
  stamping into many repos actually wants.
- **`--force` clobber for updates** (SSSF's only update path today) — overwrites the user's roster,
  prompts, **and** their wired `quality.py` commands. No safe update story; the whole reason this
  note exists.
- **Cookie/header project selection** (instead of URL segment) — a much smaller cockpit diff, but
  implicit state, non-shareable links, and `adw_id` lookups stay ambiguous across repos.
- **Cockpit spawns the worker directly** (bounded exception) — gets the "start worker" button with
  fewest moving parts, but punches a hole in "the web process never spawns"; once it *can* spawn,
  nothing structurally stops it spawning an ADW. The supervisor avoids the hole entirely.
- **Reference `adw_modules/` as a package/submodule** (no copy) — sidesteps merges for managed
  code, but SSSF's ADWs are PEP-723 `uv` scripts importing `from adw_modules import …` relatively;
  a copy-in stamp is the grain of the system. Revisit only if the manifest updater proves painful.

## Key architectural insights (from the investigation)

### 1. `quality.py` is the whole ballgame for updates

`adw_modules/quality.py` is **Atelier-owned code that every user is forced to edit**: the verify
commands are hardcoded Python (`argv=_placeholder("test")`) behind a banner that says "REPLACE THE
PLACEHOLDER COMMANDS BELOW", and `sssf.config.yaml` carries none of them. So the file is
simultaneously managed (we ship fixes to `_run()`, the tracer wiring, `run_quality()`'s block list)
and per-repo user data. Naive skip-or-clobber fails both ways. **Fix the structure, not the merge:**
move the commands into the config (already user-owned, already never-overwritten). Then `quality.py`
is purely managed and the hardest conflict disappears.

### 2. The `engine/` prefix is config, not code

No `adw_modules/*.py` hardcodes `engine/`. `data_types.py` still defaults to `adws/adw_data`,
`adws/adw_modules/`, etc.; Atelier just **overrides those via config values** and by passing
`--config engine/adws/…`. `repo_root()` resolves via `git rev-parse --show-toplevel`. So the module
code is path-agnostic and stampable near byte-for-byte; the `engine/` layout is a config +
invocation concern only. (This is also why Axis A drift is tiny: 3 modified module files —
`agent_cc.py`, `agents.py`, `tracer.py` — plus 2 new files (`queue.py`, `adw_worker.py`) and a
one-line `claude-agent-sdk` dep bump ×12.)

### 3. The worker is the one file that hardcodes Atelier's layout

`adw_worker.py` sets `REPO_ROOT = Path(__file__).parents[2]` and `build_argv()` joins
`REPO_ROOT / "engine" / "adws" / …`. In a stamped repo (`adws/adw_worker.py`, root at `parents[1]`,
no `engine/` segment) **this breaks** — in exactly the repos we want to stamp into. It must resolve
via `git_helper.repo_root()` + the derived adws subdir like everything else.

**Symlinked worktrees make this worse, and `git_helper.repo_root()` is the fix that also survives
them.** A bare-repo-with-worktrees layout (e.g. `repayd.git/`, worktrees checked out as
`repayd.git/<branch>/`) shares one worktree-agnostic `shared/` dir that each worktree symlinks in.
The natural stamp target is `shared/adws/`, symlinked into every worktree as `<worktree>/adws →
../shared/adws`. Under that layout any `Path(__file__)`-relative resolution is poison:
`Path(__file__).resolve()` **follows the symlink**, so from a worktree the worker's `__file__`
becomes `…/shared/adws/adw_worker.py` and `parents[2]` resolves to the **bare repo**, not the
worktree the agent should build in. `git_helper.repo_root()` sidesteps this entirely because it
runs `git rev-parse --show-toplevel` from **cwd**, not from `__file__` — and in a worktree that
returns the worktree path (verified). So a worker launched with `cwd=<worktree>` gets the correct
root even though the script it executes lives behind a symlink in `shared/`. Consequence: **audit
`adw_modules/` for *any* `Path(__file__)`-relative path logic, not just `adw_worker.py`**; all of
it must resolve via `git`/cwd or config for stamping into symlinked worktrees to work.

### 4. A "project" is four resolvers hanging off one root

The cockpit's single-project assumption lives in four env-based resolvers, all defaulting to the
sibling `../engine`:

| Resolver | Env | Points at | File |
| --- | --- | --- | --- |
| `resolveDbPath()` | `SSSF_DB` | `sssf.db` (read + control write) | `lib/db.ts`, `lib/control.ts`, `lib/review.ts` |
| `resolveConfigPath()` | `SSSF_CONFIG` | `sssf.config.yaml` | `lib/roster.ts` |
| `resolvePromptEngineeringDir()` | `SSSF_PE_DIR` | prompt files | `lib/roster.ts` |
| `resolveAdwsDir()` | `SSSF_ADWS_DIR` | ADW scripts | `lib/skills.ts` |

All four derive from **one repo root + adwsSubdir**. So a project descriptor is
`{ id, name, root, adwsSubdir }` and every path is computed from it — no per-project env vars.

## Implementation plan

Ordered so each part leaves the tree working. Parts B and F are **seam changes** — follow
[Extending → Recipe E](../08-extending-the-system.md#recipe-e--add-a-column-to-a-trace-table-or-run_queue).

### Part B (do first) — `quality.py` verify commands move into the config

This is the prerequisite that makes updates clean, and it's a config-schema (not db) change.

- **Config** — add a `quality:` block to `sssf.config.yaml`:
  ```yaml
  quality:
    test:      { argv: ["uv","run","pytest","-q"], timeout: 600 }
    lint:      { argv: ["ruff","check","."] }
    typecheck: { argv: ["pyright"] }
    # omit a block to skip it; order here is run order
  ```
- **`data_types.py`** — a `QualityConfig` Pydantic model on `SSSFConfig` (map of name → `{argv,
  timeout?, area?, operation?}`).
- **`quality.py`** — `run_quality()` / `run_tests()` build their block list from
  `run.config.quality` instead of the hardcoded `[test, lint, typecheck, build]`; delete
  `_placeholder`. A missing/empty `quality:` block → no checks run (and the phase says so), which
  is the honest replacement for today's fake-green echoes.
- **Mirror (by hand — it's a file, not a db table):** `cockpit/lib/roster.ts` Zod mirror gains the
  `quality` shape; `cockpit/lib/roster-constants.ts` if the editor UI surfaces it. `pnpm
  check:contract` does **not** cover the config file, so keep this mirror in lockstep manually.
- **Verify:** an ADW ending in a `quality`/`test` phase runs the config's real commands; an empty
  block runs nothing and reports it.

### Part A — the `atelier` skill (stamp payload + `install.py`)

Mirror upstream SSSF's skill (`.claude/skills/sssf/`) but Atelier-flavored:

- `templates/` — the engine payload: `adws/adw_modules/` (incl. the now-data-driven `quality.py`),
  the starter `adw_*.py`, `adw_worker.py` (git-root-resolved, Part D), `queue.py`, a starter
  `sssf.config.yaml` **without** the `engine/` prefix (native `adws/` layout), `env.sample`,
  `justfile`.
- `scripts/install.py` — recursive idempotent copy into cwd (skip existing), append `.gitignore`
  entries, **and write `.atelier/manifest.json`** (Part C). Stamps `adws/` at repo root, not
  `engine/adws/`.
- `SKILL.md` + `cookbooks/` — routing + playbooks, Atelier's `claude_code`-capable roster reflected
  (upstream's are Pi-only).
- Ship at **user scope** with a `VERSION` (Atelier git sha) baked into the skill.

### Part C — the manifest + `update.py` (the Axis B mechanism)

`.atelier/manifest.json`, written by `install.py`, updated by `update.py`:
```json
{ "atelier_version": "<atelier git sha>",
  "stamped": { "adws/adw_modules/quality.py": "<sha256-at-stamp>", "adws/adw_scout.py": "<sha256>" } }
```

`update.py` walks Atelier's current managed set and, per file:

| Repo state | Manifest hash | Action |
| --- | --- | --- |
| absent | — | new module/ADW → **stamp it**, record hash |
| present | matches (untouched) | **overwrite**, bump hash |
| present | differs (user edited managed code) | **conflict** — write `<file>.atelier-new` beside it, report; never clobber |
| absent from Atelier's set | in manifest | **removed upstream** — report; delete only if untouched |

Three properties fall out:
- **Buckets are explicit.** Managed = in the manifest. User data (`sssf.config.yaml`,
  `prompt_engineering/`, `harness_engineering/`, custom `adws/adw_*.py`) is stamped once and never
  in the update set. Runtime (`sessions/`, `sssf.db`) is gitignored.
- **Extensibility is free.** Anything the user adds is simply not in the manifest → the updater
  never touches it. No forced `custom/` convention.
- **Auto-merge is a later upgrade.** The stamped repo is already git (commit phases require it), so
  `update` can become `git merge-file ours base theirs` once the manifest stores a base ref. Not
  needed day one.

### Part D — de-Atelier-ify the worker

- `adw_worker.py`: replace `REPO_ROOT = parents[2]` with `git_helper.repo_root()`; replace the
  `REPO_ROOT / "engine" / "adws"` literals in `build_argv()`/`spawn()` with a resolved adws dir
  (config-derived or `repo_root / adwsSubdir`). Default `--config` becomes layout-relative.
- **Use `git_helper.repo_root()`, never `Path(__file__)`** — it resolves from cwd, so it stays
  correct when `adws/` is a symlink into a shared dir (see insight #3). Sweep `adw_modules/` for any
  other `__file__`-relative path logic and convert it to `git`/cwd/config resolution.
- Verify a worker launched from a stamped repo root builds correct argv and its runs commit to that
  repo — including from a **symlinked worktree** (`<worktree>/adws → ../shared/adws`), where the
  resolved root must be the worktree, not the symlink target's parent.

### Part E — multi-project cockpit (URL-segment routing)

- **Projects registry** — `cockpit/atelier.projects.json` (cross-project, so it cannot live in any
  single `sssf.db`), a list of `{ id, name, root, adwsSubdir }`. Both the cockpit and the
  supervisor read it.
- **Keyed connections** — `getDb(projectId)` / `getControl(projectId)` memoize a connection **per
  project** (Map on `globalThis`) instead of one global. The SQL underneath is unchanged; the
  resolvers take a descriptor instead of reading env. `SSSF_*` env vars stay as the single-project
  fallback / test escape hatch.
- **Routing** — move the app under `/[project]/…` (`/[project]/runs/[adwId]`, `/cost`, `/gates`,
  `/agents`, `/queue`). `lib/nav.ts` links gain the project prefix. A project switcher dropdown in
  the shell sets the segment.
- **Blast radius** — ~14 `getDb()` call sites across ~11 files (every page + API route +
  `control.ts`/`roster.ts`/`skills.ts`/`review.ts`) thread a `projectId` from the route segment.
  The SSE routes (`dashboard/stream`, `runs/[adwId]/events`, `runs/[adwId]/stream`) carry it too.
- **Verify:** two projects in the json render independently; switching the dropdown swaps db,
  roster, and ADW list; an `adw_id` resolves against the right project only.

### Part F — the supervisor + `workers` heartbeat (seam change)

- **`workers` table** (new, additive → Recipe E) — the worker writes `{ pid, host, started_at,
  last_seen_at }` every poll into its **own repo's** `sssf.db` (heartbeat stays per-project, keeping
  "the db is the seam" true per project). Mirror in `tracer.py` SCHEMA/`MIGRATIONS`, `types.ts`,
  `schemas.ts`, and `check-contract.ts`. Cockpit reads freshness (last_seen within ~3× poll = alive)
  to show **"no worker attached"** honestly.
- **Supervisor** — a small always-on process (the worker gaining a `--supervise` mode, or a thin
  `atelier supervisor`) that reads `atelier.projects.json` and ensures one worker per project is
  draining its queue, spawned with the correct `cwd`. It is the thing allowed to spawn.
- **Cockpit "start worker" = write intent.** The button writes a `worker_desired` flag (per project;
  in the projects json or a small control row), exactly like `enqueue()` / `requestCancel()`; the
  supervisor disposes. **The cockpit still never spawns a process** — this reuses the determinism
  spine rather than bending it.
- **Verify:** kill a project's worker → cockpit shows "no worker" within a poll or two; click start
  → supervisor launches one → heartbeat returns → status flips to attached; a run enqueued from the
  cockpit lands byte-identically to a CLI run.

## Scoped boundaries (call these out when it ships)

- **Merge-back of user-edited managed code is manual.** A `quality.py.atelier-new` conflict file is
  the user's to reconcile. Once Part B lands this should be rare (managed files aren't meant to be
  edited); auto-merge via `git merge-file` is a future slice.
- **The supervisor is one more always-on process.** Accepted — N workers were needed anyway;
  the supervisor manages them and gives the cockpit a safe control surface.
- **Axis A stays manual.** Pulling `disler/sssf` changes into Atelier is a hand `diff`, not
  automated. The carried delta is small enough that this is fine.

## Open questions to settle on revisit

- **Skill scope** — user-scope (`~/.claude/skills/atelier/`) is chosen; do we *also* want a vendored
  per-repo copy for fully self-contained repos, or is user-scope + version pin enough?
- **`worker_desired` home** — a field in `atelier.projects.json`, or a small control row/table in
  each project's `sssf.db`? (The json keeps all cross-project state in one place; a db row keeps it
  next to the queue it governs.)
- **Manifest base content** — store hash only (skip-or-flag, chosen for v1) or also a base ref, to
  unlock `git merge-file` auto-merge sooner?
- **Config `quality:` vs `verify:` naming**, and whether `area`/`operation` stay per-block or move
  to sensible defaults.
- **Projects json location** — `cockpit/` (chosen) vs a user-level path so one cockpit serves repos
  across many checkouts.
- **Supervisor identity** — extend `adw_worker.py` with `--supervise`, or a separate script? (Reuse
  keeps one launch code path; separate keeps the worker simple.)

## Verification plan

1. **Part B first:** an ADW's quality/test phase runs the config's real commands; an empty `quality:`
   block runs nothing and reports it (no fake green). `cockpit` roster mirror still typechecks.
2. **Stamp:** `uv run install.py` into a throwaway git repo → `adws/` lands at root, `.atelier/manifest.json`
   written, `just demo` runs read-only ADWs, trace lands in that repo's `sssf.db`.
3. **Update:** bump an Atelier module, `uv run update.py` in the stamped repo → untouched managed
   files refresh, a deliberately-edited managed file produces a `.atelier-new` conflict (not a
   clobber), user roster/prompts/custom ADWs untouched.
4. **Cockpit multi-project:** two projects in `atelier.projects.json`; `cd cockpit && pnpm typecheck
   && pnpm check:contract && pnpm build`; the dropdown swaps projects; `adw_id` resolves per project.
5. **Supervisor:** kill a worker → "no worker attached" shows; start from the cockpit → heartbeat
   returns → attached; enqueue → run is byte-identical to CLI.
6. `/code-review high` on each part's diff before landing.

## References

- [Architecture](../01-architecture.md) — the determinism spine and the seam this must preserve.
- [Config & roster](../05-config-and-roster.md) — where the `quality:` block and the Python↔TS
  config mirror live.
- [The cockpit](../06-cockpit.md) — the `lib/` resolver layer and read/write surfaces multi-project touches.
- [Operations](../07-operations.md) — the worker & `run_queue` lifecycle the supervisor extends.
- [Extending the system](../08-extending-the-system.md) — Recipe E (the seam-change checklist) for Parts B & F.
- [Sandbox / isolated runs](sandbox-runs.md) — the sibling design note; the worktree work and this
  share the worker and the `run_queue` seam.
- [`AGENTS.md`](../../AGENTS.md) — the canonical contract, incl. the "cockpit never spawns" invariant.
