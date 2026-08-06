# Design note — Sandbox / isolated runs

> **Status: DESIGN DECIDED — not yet implemented.** This is the last open Phase 5 item
> ("Sandbox / cloud runs", see [`atelier-plan.html`](../atelier-plan.html)). The design below is
> settled (see [§ Decisions](#chosen-shape--decisions-locked)); nothing is built yet — no
> `SSSF_TRACE_ROOT`, no `run_queue.target`, no sandbox config, no worktree wiring. Work happens on
> the `feat/sandbox-runs` branch. When it lands, fold the relevant parts into the numbered guides
> and drop the status note in [`docs/README.md`](../README.md).
>
> **History.** Originally scoped to L1 parallel-write isolation for the "80% junk work." Revisited
> 2026-08-06: the real need across projects is **L2 (env + services) isolation for actual feature
> work**, configured **per project**. This note is rewritten around that; the L1 worktree is now the
> *foundation slice*, not the whole feature.

## Goal

Run each ADW in an **isolated environment** — its own working tree, dependencies, ports, backing
services, and env — so multiple runs can be in flight without clobbering each other, and so a run
that actually *builds and runs the app* (dev server, tests hitting a DB) doesn't collide with
another. Today the worker runs every ADW with `cwd=REPO_ROOT`, so `--concurrency > 1` shares one
tree, one `node_modules`, and one set of ports.

**Not** in scope: security/blast-radius containment (L3) and off-machine offload (L4) — see
[§ The isolation ladder](#the-isolation-ladder). We stop at a **hybrid** sandbox: the ADW *process*
stays local (so the local `claude`/`pi` login and process-group cancel keep working untouched),
while its *tree, deps, ports, services, and env* are per-run isolated.

## The isolation ladder

| Level | Buys | Cost | Status |
| --- | --- | --- | --- |
| **L0** shared tree *(today)* | nothing — runs collide at `--concurrency > 1` | none | current |
| **L1** local git **worktree** | parallel-**write** isolation | tiny | **foundation slice** |
| **L2** worktree **+ env + services** | above **+** isolated deps, per-run ports, per-run backing services, scoped env | medium | **the target** |
| **L3** container | above **+** OS / blast-radius containment | heavy | out of scope (future) |
| **L4** remote sandbox | off-machine offload | highest | **blocked** — local login can't travel; only viable for API-key-auth projects (future) |

## Chosen shape — decisions locked

| Axis | Decision | Why |
| --- | --- | --- |
| Target level | **L2 hybrid** (worktree + env + services), built on the **L1** worktree foundation | The real cross-project need is running full-stack work in isolation, not just non-colliding writes. |
| Isolation mechanism | **Local git worktree** per run + per-run **provisioning** (deps, ports, services, env) | Preserves the determinism spine (same argv; only `cwd` + env change); auth trivial (same machine); fully verifiable by kicking a real run. |
| Where configured | **Per-project sandbox profile** in `sssf.config.yaml`, **default + per-run override** | "Projects differ" lives in config: each project declares its level and how to provision; a launch overrides within what the project allows. |
| Services | **Project-declared `up`/`down` hooks**, engine injects an allocated port block as env | Engine stays mechanism-agnostic — a hook wraps `docker compose` / testcontainers / anything. **No hard Docker dependency** in Atelier. |
| Merge-back | **Commit stays local**: record the worktree tip SHA in `run_queue` before teardown; you merge locally | Real feature work must be *findable*; a remote/PR flow is a later, optional slice. No git remote required. |
| Surface | **Engine + cockpit** | Worker gains the mode; `run_queue.target` carries the level across the seam; the cockpit picks a level at launch and shows it. |

### Alternatives rejected
- **Docker container for the ADW itself (L3)** — real containment, but heavy (an image with `uv` +
  `claude` + `pi`, mounting the local login) and process-group cancel gets indirect. Note this is
  *different* from L2 services: L2 keeps the **agent** local and only containerizes **backing
  services** via the project's own `up` hook.
- **Remote cloud sandboxes (L4)** — largest surface, **blocked on this machine**: the local
  `claude`/`pi` login can't travel, so runs couldn't authenticate or be verified by kicking a real
  ADW (the repo's only acceptance gate). Reopens only for a project on **API-key** auth. See the
  machine gotcha in [Architecture](../01-architecture.md).

## The key architectural insight (the one correctness fix)

If a run's `cwd` becomes a worktree, the codebase splits cleanly into two concerns — and only one
needs a fix:

| Concern | Resolves via | Under a worktree cwd | Action |
| --- | --- | --- | --- |
| **Execution surface** — agent cwd, write-boundary diff, commit, `protected_files` | `repo_root()` = `git rev-parse --show-toplevel`, which **inside a worktree returns the worktree** | Correct — this is exactly the isolation we want | **None** |
| **Observability sink** — the shared `sssf.db`, the JSONL trace, `data_dir`/session dirs | resolved **relative to `cwd`** (relative path strings from config) | Would silently move **into** the worktree → the cockpit sees nothing | **The one correctness fix** |

So: the worker creates a worktree, spawns the ADW with `cwd=worktree` **and** tells it the shared
trace root; observability paths absolutize against that root. Non-sandboxed runs (`target=local`)
leave the signal unset → everything resolves against `cwd` as today → **byte-identical behavior**.

## Multi-project — where the trace root comes from

The distribution track added a **supervisor** (`adw_worker.py::supervise` / `_spawn_worker`) above
the worker: one **worker** per `workerDesired` project, each spawned with `cwd=entry.root`. That is a
new spawn site — but **not** a second *ADW* spawn site. The supervisor spawns *workers*; each worker
still spawns ADWs through the single `spawn()` (`adw_worker.py:150`, `cwd=REPO_ROOT`). The worktree +
provisioning logic lives in `spawn()` and nowhere else — `_spawn_worker` needs **no** change.

It composes cleanly because `REPO_ROOT = git_helper.repo_root()` is resolved **per worker process at
import** (`adw_worker.py:47`), so inside a supervised worker it already equals *that project's* root.
`spawn()` sets `cwd=<worktree>` and `SSSF_TRACE_ROOT=REPO_ROOT` uniformly across standalone
(`just worker`) and supervised modes. The one rule for an implementer: never capture a single global
"atelier root" — always use the worker's own `REPO_ROOT`.

## The sandbox profile (per-project config)

Each project declares, in `sssf.config.yaml`, a `sandbox` section: a `default` level and a named
profile per non-trivial level. `target` on a run picks a level name (default = `sandbox.default`);
the engine provisions per that profile.

```yaml
sandbox:
  default: local                 # byte-identical to today unless a run overrides
  worktree_env:                  # the L2 profile for this project
    setup: [pnpm install --frozen-lockfile]   # run in the worktree before the ADW
    ports: { WEB: auto, DB: auto }            # engine allocates a free port for each → env vars
    services:
      up:   docker compose -p ${ADW_ID} up -d
      down: docker compose -p ${ADW_ID} down -v
    env:
      DATABASE_URL: postgres://localhost:${DB}/app   # ${DB}, ${WEB}, ${ADW_ID} interpolated
```

- **Level vocabulary is bounded** (`local` · `worktree` · `worktree_env`; later `container` ·
  `remote`) so `run_queue.target` stays a fixed enum across the seam. *Provisioning* is per-project;
  the *level name* is shared vocabulary (lives in `roster-constants.ts`).
- **Interpolation** — `${ADW_ID}` and each allocated port name (`${WEB}`, `${DB}`) are available to
  `setup`, `services`, and `env`. Allocated ports and the profile's `env` are injected into the ADW
  process environment, so the agent/app read the same ports the services bound to.

## Run lifecycle (worker, `target != local`)

1. **Worktree** — `git worktree add --detach <loc> HEAD` (see location decision below).
2. **Ports** — allocate a free port per `ports:` entry → `{WEB: 51xxx, DB: 51yyy}`.
3. **Setup** — run each `setup` command in the worktree with `{ADW_ID, ...ports}` in env.
4. **Services up** — run `services.up` with the same env.
5. **Spawn ADW** — `cwd=<worktree>`, env `+= SSSF_TRACE_ROOT=REPO_ROOT`, the allocated ports, the
   interpolated profile `env`, and `ADW_ID`. Same argv as a local run.
6. **Reap** (terminal completion **or** cancel-complete) — read worktree `HEAD` → write
   `run_queue.result_sha`; run `services.down`; `git worktree remove --force`.
7. **Startup** — best-effort reap of stale worktrees (`git worktree prune` + remove run dirs) and
   orphaned services from a crashed prior worker (the `-p ${ADW_ID}` naming makes `down` targetable).

Cancel is unchanged in spirit: SIGTERM the ADW's process group (step 5's child), then the reap in
step 6 tears down services + worktree. The determinism spine holds — provisioning wraps the argv, it
doesn't change it.

## Implementation plan (sliced so the foundation lands first)

### Slice 1 — L1 foundation (worktree + trace-root fix + seam + merge-back SHA)
Ships a usable `local | worktree` with no provisioning. Fully verifiable, byte-identical for `local`.

1. **Trace-root fix** (`adw_modules/`): add `trace_root()` → `Path(os.environ.get("SSSF_TRACE_ROOT")
   or Path.cwd())` and `resolve_trace_path(p)` in `utils.py`; wrap the two `Tracer(...)` paths in
   `session.py::ensure` and `session_dir` in `runner.py::Run.__init__`. **No-op when unset** —
   `cfg.defaults.data_dir` stays relative, so the write-boundary derivation is untouched.
2. **Worker worktree mode** (`adw_worker.py::spawn`): read `row["target"]`; on `worktree`, create the
   worktree, spawn with `cwd=<worktree>` + `SSSF_TRACE_ROOT=REPO_ROOT`, absolutize `--config` to the
   **real** repo config (live roster, not the worktree's HEAD copy). Teardown on reap/cancel; record
   `result_sha`. `local` (default) is unchanged.
3. **Seam — `run_queue.target` + `run_queue.result_sha`** (Recipe E). `target TEXT DEFAULT 'local'`,
   `result_sha TEXT`. Mirror in `queue.py` DDL, `tracer.py` MIGRATIONS, `cockpit/lib/control.ts`
   (DDL + `EnqueueSpecSchema` `target: z.enum([...]).optional()` + INSERT/SELECT), `schemas.ts`,
   `types.ts` (`RunTarget` union), `check-contract.ts` `MIGRATION_COLUMNS`, and `db.ts::queue()` via
   `optionalColumn`.
4. **Cockpit surface**: `QueueLauncher` target selector; `QueueCard` chip; run-detail chip + a
   `result_sha` link. (A new `AtelierDb` method → restart `pnpm dev`, memoized connection.)

### Slice 2 — L2 provisioning (deps + ports + env)
5. **Config seam — the sandbox profile.** `SSSFConfig.sandbox` in `data_types.py` (Pydantic),
   mirrored in `cockpit/lib/roster.ts` (Zod) by hand, with the level vocabulary in
   `roster-constants.ts`. `agents.py::load_config` re-validates at run time.
6. **Provisioning in `spawn()`**: add the `worktree_env` level — port allocation, run `setup`, inject
   ports + interpolated `env`. Cockpit level selector gains `worktree_env` where the project defines
   it.

### Slice 3 — L2 backing services (the heavy end)
7. **Service hooks**: run `services.up` after setup and `services.down` in reap; startup orphan
   reaping. This is isolated from slices 1–2 and can land last.

## Merge-back (call this out when it ships)

Sandboxed runs isolate the working tree and **commit locally**: on reap, the worker records the
worktree branch tip SHA in `run_queue.result_sha` before removing the worktree, so the work is
findable and mergeable by hand. Pushing a branch / opening a PR is a **later, optional slice** and
needs a git remote + auth. (Without `result_sha`, a commit on a detached worktree HEAD is reflog-only
until GC — which is why recording it is part of slice 1.)

## Open questions to settle during build

- **Worktree location** — **leaning outside the repo** (`~/.atelier/worktrees/<project-id>/<adw_id>`)
  so no project's `.gitignore` is touched and stamped repos need no `install.py` change; `git
  rev-parse --show-toplevel` still resolves correctly inside it. Alternative: in-repo
  `REPO_ROOT/.sandboxes/` (needs the ignore stamped into every project). Confirm outside.
- **Port allocation** — bind-probe a free port at provision time (TOCTOU-racy but simple), or a
  reserved range per worker slot? Probe is fine for the first cut.
- **`env` interpolation surface** — only `${ADW_ID}` + allocated port names, or also pass through the
  host env / a project secrets file? Start minimal (ID + ports).
- **Setup cost** — reinstall deps every run vs. share a warm `node_modules`/store. `pnpm`/`uv` are
  content-addressed so a cold install is cheap-ish; measure before optimizing.
- **Service-failure handling** — if `services.up` fails, fail the run before spawning the ADW (don't
  run against a half-provisioned env); ensure `services.down` still runs in reap.
- **Env var name** — `SSSF_TRACE_ROOT` is the working name.
- **Stale reaping cadence** — worker startup only, or also periodic?

## Verification plan

1. `cd cockpit && pnpm typecheck && pnpm check:contract && pnpm build` (contract now covers `target`
   + `result_sha`).
2. **Slice 1** — enqueue two `target=worktree` runs, `just worker --concurrency 2`; confirm each gets
   its own worktree, **both traces land in the shared `sssf.db`**, `result_sha` is recorded, worktrees
   are removed on completion, and cancel tears down cleanly. Confirm `target=local` is byte-identical
   to today.
3. **Supervised mode** — one `target=worktree` job under `--supervise` for a *stamped* project; its
   trace lands in that project's own `sssf.db` (`SSSF_TRACE_ROOT` = the worker's `REPO_ROOT`), no
   stray worktree left behind.
4. **Slice 2/3** — a `target=worktree_env` run on a real full-stack project: deps install into the
   worktree, allocated ports don't collide with a concurrent run, `services.up`/`down` bracket the
   run, and the app under the agent reaches its per-run DB via the injected `DATABASE_URL`.
5. `/code-review high` on each slice's diff before landing.

## References

- [Architecture](../01-architecture.md) — the determinism spine and the seam this must preserve.
- [Operations](../07-operations.md) — the worker & `run_queue` lifecycle this extends.
- [Config & roster](../05-config-and-roster.md) — where the sandbox profile lives.
- [Extending the system](../08-extending-the-system.md) — Recipe E (the seam-change checklist).
- [`AGENTS.md`](../../AGENTS.md) — the canonical contract.
