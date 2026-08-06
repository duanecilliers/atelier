# Design note — Sandbox / isolated runs

> **Status: DESIGN DECIDED — not yet implemented.** This is the last open Phase 5 item
> ("Sandbox / cloud runs", see [`atelier-plan.html`](../atelier-plan.html)). The design below is
> settled (see [§ Decisions](#chosen-shape--decisions-locked)); nothing is built yet — no
> `SSSF_TRACE_ROOT`, no `sandboxes` table, no `run_queue.sandbox_id`, no sandbox config, no worktree
> wiring. Work happens on the `feat/sandbox-runs` branch. When it lands, fold the relevant parts into
> the numbered guides and drop the status note in [`docs/README.md`](../README.md).
>
> **History.** (1) Originally scoped to L1 ephemeral parallel-write isolation for the "80% junk work."
> (2) Revisited 2026-08-06: the real need is **L2 (env + services) isolation for actual feature
> work**, per project. (3) Refined further: a sandbox is a **persistent** workspace that hosts
> follow-up work until explicitly shut down, and **landing** the work (PR vs direct merge) is a
> per-project workflow. This note reflects (3).

## Goal

Give each unit of work an **isolated, persistent environment** — its own working tree (on a branch),
dependencies, ports, backing services, and env — that **hosts one or more ADW runs** and **stays
alive for follow-up work until explicitly shut down**. Landing the result (open a PR, merge directly,
or leave it) is a **per-project workflow**. Today the worker runs every ADW with `cwd=REPO_ROOT`, so
`--concurrency > 1` shares one tree, one `node_modules`, and one set of ports.

**Not** in scope: security/blast-radius containment (L3) and off-machine offload (L4) — see
[§ The isolation ladder](#the-isolation-ladder). We stop at a **hybrid** sandbox: the ADW *process*
stays local (so the local `claude`/`pi` login and process-group cancel keep working untouched),
while its *tree, deps, ports, services, and env* are isolated per sandbox.

## The isolation ladder

| Level | Buys | Cost | Status |
| --- | --- | --- | --- |
| **L0** shared tree *(today)* | nothing — runs collide at `--concurrency > 1` | none | current |
| **L1** git **worktree** sandbox | write isolation; a persistent branch workspace | tiny | **foundation slice** |
| **L2** sandbox **+ env + services** | above **+** isolated deps, per-sandbox ports, backing services, scoped env | medium | **the target** |
| **L3** container | above **+** OS / blast-radius containment | heavy | out of scope (future) |
| **L4** remote sandbox | off-machine offload | highest | **blocked** — local login can't travel; only viable for API-key-auth projects (future) |

## Chosen shape — decisions locked

| Axis | Decision | Why |
| --- | --- | --- |
| Target level | **L2 hybrid** (worktree + env + services), built on the **L1** worktree foundation | The real cross-project need is running full-stack work in isolation. |
| Unit of isolation | A **persistent sandbox** = a worktree on a **named branch**, a first-class entity with its own lifecycle (create → host runs → land → shut down) | Real feature work is iterative: you run, inspect, run again in the same env. The sandbox outlives any single run. |
| Concurrency | **Across sandboxes, not within one.** Runs in the *same* sandbox **serialize** | Two runs in one tree would re-introduce the write collision we're isolating away. Parallelism = multiple sandboxes. |
| Isolation mechanism | **Local git worktree** + per-sandbox **provisioning** (deps, ports, services, env), all bound to sandbox **create/shutdown** (not per run) | Determinism spine intact (same argv; only `cwd` + env change); follow-up runs are fast (env stays warm); auth trivial. |
| Where configured | **Per-project sandbox profile** in `sssf.config.yaml`, **default + per-run override** | "Projects differ" lives in config: each project declares its level, how to provision, and how to land. |
| Services | **Project-declared `up`/`down` hooks**, engine injects an allocated port block as env | Engine mechanism-agnostic — a hook wraps `docker compose` / testcontainers / anything. **No hard Docker dependency.** |
| Landing | **Per-project `land` workflow** — declared `pr` / `merge` / `manual` hook, invoked explicitly. Sandbox always records its **branch + tip SHA** while alive | Some projects open PRs, others merge directly, others merge by hand. Nothing lands or is destroyed implicitly. |
| Lifecycle | Torn down **only on explicit shutdown** (a control-plane flag); the worker disposes (services down + worktree remove) | The whole point of persistence: no surprise teardown while you may still want the tree. |
| Surface | **Engine + cockpit** | Worker gains sandbox reconciliation; a `sandboxes` table + `run_queue.sandbox_id` carry it across the seam; the cockpit creates / attaches / lands / shuts down and shows sandboxes. |

### Alternatives rejected
- **Ephemeral per-run worktree** (the original L1 shape) — torn down on run completion. Rejected:
  kills follow-up work and forces re-provisioning every run. Superseded by the persistent sandbox.
- **Docker container for the ADW itself (L3)** — real containment, but heavy and process-group
  cancel goes indirect. Distinct from L2 services, which keep the **agent** local and only
  containerize **backing services** via the project's own `up` hook.
- **Remote cloud sandboxes (L4)** — **blocked on this machine**: the local `claude`/`pi` login can't
  travel, so runs couldn't authenticate or be verified by kicking a real ADW. Reopens only for a
  project on **API-key** auth. See the machine gotcha in [Architecture](../01-architecture.md).

### Evaluated: treehouse for worktree orchestration (spike 2026-08-06)

[treehouse](https://github.com/kunchenguid/treehouse) (Go, MIT) manages a pool of reusable,
pre-warmed worktrees with durable leases. Spiked v2.0.0 against this repo's cockpit. Findings:

- **What fits.** Durable lease (`get --lease --lease-holder <id>`) maps cleanly onto a persistent
  sandbox: an outside-repo worktree held with no process, in a small tidy state file. A commit on a
  named branch **survives `return`/destroy** because the worktree shares the **main repo's `.git`**
  (`git-common-dir` → the real `.git`) — validating our named-branch merge-back.
- **The catch.** That branch survival and the correct `show-toplevel` in an outside-repo worktree are
  **inherent to `git worktree`**, not treehouse's value-add. treehouse's actual value-add is *pool +
  warm reuse across churn*, and it's **smaller than advertised** for us: measured `pnpm install` was
  1.7s cold vs 0.24s warm — pnpm's global content-addressed store already makes cold cheap. The pool
  edge is real only for **build caches** (`.next`, native builds) **across sandbox teardown/recreate**
  — but our **persistent sandbox already keeps caches warm within its life**, so the benefit only
  lands under high create/destroy churn.
- **Costs.** A new external binary on every worker host (incl. stamped repos); a second source of
  truth (its `state.json` vs our `sandboxes` table); and young automation flags (`--json`,
  `return --if-lease-id` are newer than the v2.0.0 in use — even latest is v2.1.1).

**Decision (leaning, pending confirm): worktree provider is an internal abstraction.** Slice 1 ships
a native `git worktree` provider (zero deps, fully verifiable); treehouse is an **opt-in** provider
(`sandbox.provider: git | treehouse`) for setups with real sandbox churn. Nothing else in the design
changes — the provider only supplies `acquire(sandbox_id) → path` / `release` / `list`.

## The key architectural insight (the one correctness fix)

If a run's `cwd` becomes a worktree, the codebase splits cleanly into two concerns — and only one
needs a fix:

| Concern | Resolves via | Under a worktree cwd | Action |
| --- | --- | --- | --- |
| **Execution surface** — agent cwd, write-boundary diff, commit, `protected_files` | `repo_root()` = `git rev-parse --show-toplevel`, which **inside a worktree returns the worktree** | Correct — this is exactly the isolation we want | **None** |
| **Observability sink** — the shared `sssf.db`, the JSONL trace, `data_dir`/session dirs | resolved **relative to `cwd`** (relative path strings from config) | Would silently move **into** the worktree → the cockpit sees nothing | **The one correctness fix** |

So: the worker spawns the ADW with `cwd=<sandbox worktree>` **and** tells it the shared trace root;
observability paths absolutize against that root. Non-sandboxed runs (`sandbox_id` null) leave the
signal unset → everything resolves against `cwd` as today → **byte-identical behavior**.

## Multi-project — where the trace root comes from

The distribution track added a **supervisor** (`adw_worker.py::supervise` / `_spawn_worker`): one
**worker** per `workerDesired` project, each spawned with `cwd=entry.root`. That is a new spawn site —
but **not** a second *ADW* spawn site. The supervisor spawns *workers*; each worker still spawns ADWs
through the single `spawn()` (`adw_worker.py:150`, `cwd=REPO_ROOT`), and now also **reconciles its
project's sandboxes**. The worktree/provisioning logic lives in the worker and nowhere else —
`_spawn_worker` needs **no** change.

It composes because `REPO_ROOT = git_helper.repo_root()` is resolved **per worker process at import**
(`adw_worker.py:47`), so a supervised worker already sits at *that project's* root. `SSSF_TRACE_ROOT`
= the worker's own `REPO_ROOT`, uniformly across standalone and supervised modes. Rule for the
implementer: never capture a single global "atelier root."

## The sandbox as a first-class entity

A **sandbox** outlives the runs it hosts. Its lifecycle, and where each step's config comes from:

```
 request ──▶ PROVISIONING ──▶ ACTIVE ⇄ (run, run, run…) ──▶ LANDING ──▶ SHUTTING_DOWN ──▶ gone
             worktree add       host serialized runs        land hook     services.down
             ports + setup      (follow-up work)            (pr|merge)     worktree remove
             services.up
```

- **Create** (control-plane INSERT a `sandboxes` row): worker provisions — `git worktree add` on a
  named branch, allocate ports, run `setup`, `services.up`. Status `active`.
- **Use**: one or more runs execute with `cwd=<worktree>`; runs targeting the same sandbox
  **serialize** (the worker won't spawn a second run into an `active`-but-busy sandbox).
- **Land** (explicit): run the project's `land` hook (open a PR / merge / manual). Does **not**
  destroy the sandbox.
- **Shut down** (explicit control-plane flag): worker runs `services.down`, removes the worktree,
  marks the row `gone`. The **only** thing that tears a sandbox down.

Provisioning and services are **per sandbox** (at create/shutdown), not per run — so follow-up runs
start instantly against a warm env.

## The sandbox profile (per-project config)

Each project declares, in `sssf.config.yaml`, a `sandbox` section: a `default` level, a named profile
per non-trivial level, and a `land` workflow.

```yaml
sandbox:
  default: local                 # byte-identical to today unless a run overrides
  worktree_env:                  # the L2 profile for this project
    branch: adw/${SANDBOX_ID}     # named branch for the worktree (overridable at launch)
    setup: [pnpm install --frozen-lockfile]   # run once at sandbox create
    ports: { WEB: auto, DB: auto }            # engine allocates a free port for each → env vars
    services:
      up:   docker compose -p ${SANDBOX_ID} up -d
      down: docker compose -p ${SANDBOX_ID} down -v
    env:
      DATABASE_URL: postgres://localhost:${DB}/app   # ${DB}, ${WEB}, ${SANDBOX_ID} interpolated
    land:
      mode: pr                    # pr | merge | manual
      cmd:  gh pr create --fill --head ${BRANCH}   # for mode: merge → e.g. a merge-to-main hook
```

- **Level vocabulary is bounded** (`local` · `worktree` · `worktree_env`; later `container` ·
  `remote`) so `run_queue.target` / the sandbox level stays a fixed seam enum. *Provisioning* and
  *landing* are per-project; the *level name* is shared vocabulary (`roster-constants.ts`).
- **Interpolation** — `${SANDBOX_ID}`, `${BRANCH}`, and each allocated port name (`${WEB}`, `${DB}`)
  are available to `setup`, `services`, `env`, and `land`. Allocated ports + the profile `env` are
  injected into every run's process env, so the agent/app read the same ports the services bound to.

## Seam changes (Recipe E discipline)

Two new pieces, mirrored Python↔TS per
[Extending → Recipe E](../08-extending-the-system.md#recipe-e--add-a-column-to-a-trace-table-or-run_queue):

- **New `sandboxes` table** — `id`, `project_root`, `level`, `worktree_path`, `branch`, `ports` (JSON),
  `status` (`requested|provisioning|active|landing|shutting_down|gone|failed`), `tip_sha`,
  `shutdown_requested`, `created_at`. Mirror in `tracer.py` `SCHEMA`/`MIGRATIONS`, `cockpit/lib/types.ts`,
  `cockpit/lib/schemas.ts` + `TABLE_COLUMNS`, `check-contract.ts`.
- **`run_queue.sandbox_id`** (nullable TEXT) — binds a run to a sandbox; null = today's local run.
  Mirror in `queue.py` DDL, `tracer.py` MIGRATIONS, `control.ts` (DDL + `EnqueueSpecSchema` +
  INSERT/SELECT), `schemas.ts`, `types.ts`, `check-contract.ts` `MIGRATION_COLUMNS`, `db.ts::queue()`.
- **Config seam** — `SSSFConfig.sandbox` in `data_types.py` (Pydantic), mirrored by hand in
  `cockpit/lib/roster.ts` (Zod), with the level vocabulary in `roster-constants.ts`.

**Control-plane invariant preserved.** Create sandbox = INSERT a `sandboxes` row (status
`requested`); land / shut down = set a column (`land_requested` / `shutdown_requested`). The **worker**
reconciles and disposes — the cockpit still **never spawns a process** and never mutates a trace.

## Implementation plan (sliced so the foundation lands first)

### Slice 1 — sandbox lifecycle skeleton (L1)
Persistent worktree sandboxes you can run ADWs in and shut down. No provisioning, no services, no
land hook (branch left for manual merge).
1. **Trace-root fix** (`adw_modules/`): `trace_root()` → `Path(os.environ.get("SSSF_TRACE_ROOT") or
   Path.cwd())` + `resolve_trace_path()` in `utils.py`; wrap the two `Tracer(...)` paths in
   `session.py::ensure` and `session_dir` in `runner.py::Run.__init__`. **No-op when unset.**
2. **Seam**: `sandboxes` table + `run_queue.sandbox_id` (above).
3. **Worker sandbox reconciliation** (`adw_worker.py`): provision `requested` sandboxes (worktree add
   on a named branch); spawn runs with `cwd=<worktree>` + `SSSF_TRACE_ROOT=REPO_ROOT`, absolutizing
   `--config` to the **real** repo config; **serialize** runs per sandbox; tear down on
   `shutdown_requested`; record `tip_sha`. Startup reap of stale worktrees (`git worktree prune`).
4. **Cockpit**: create / attach-run-to / shut-down a sandbox; a sandbox list + per-run sandbox chip.

### Slice 2 — provisioning (deps + ports + env)
5. **Config seam** — the sandbox profile (`SSSFConfig.sandbox`, roster mirror, level vocab).
6. **Provision at create**: allocate ports, run `setup`, inject ports + interpolated `env` into runs.

### Slice 3 — backing services
7. **Service hooks**: `services.up` at create, `services.down` at shutdown; startup orphan reaping
   (the `-p ${SANDBOX_ID}` naming makes `down` targetable).

### Slice 4 — landing workflows
8. **`land` hook**: a control-plane `land_requested` flag → worker runs the project's `land` hook
   (`pr` / `merge` / `manual`); cockpit "Land" action showing the resulting PR/merge. Sandbox stays
   until separately shut down.

## Open questions to settle during build

- **Worktree location** — **outside the repo** (`~/.atelier/worktrees/<project-id>/<sandbox-id>`),
  confirmed: no project `.gitignore` change, `show-toplevel` still resolves inside it. *(settled)*
- **New vs attach** — does a launch default to a fresh sandbox, or attach to an existing active one?
  Propose: explicit — "new sandbox" vs pick an existing one in the launcher.
- **Shutdown safety** — warn / block shutdown when the sandbox has un-landed commits (`tip_sha`
  ahead of base and no land recorded)? Propose: warn, allow force.
- **Serialization** — reject a second run into a busy sandbox, or queue it behind the first? Propose:
  queue (natural for follow-up work).
- **Port allocation** — probe a free port at provision time (simple, mildly TOCTOU-racy) vs a
  reserved range per worker. Probe first.
- **Service-failure handling** — if `services.up` fails, mark the sandbox `failed` and don't spawn
  runs; ensure `services.down` still runs on shutdown.
- **Stale reaping cadence** — worker startup only, or also periodic?

## Verification plan

1. `cd cockpit && pnpm typecheck && pnpm check:contract && pnpm build` (contract covers the new table
   + `sandbox_id`).
2. **Slice 1** — create a sandbox; run two ADWs **into the same sandbox** sequentially, confirm they
   share the tree, **both traces land in the shared `sssf.db`**, `tip_sha` updates, and the worktree
   persists across runs. Create a **second** sandbox and run concurrently — confirm the two don't
   collide. Shut down → worktree removed. A null-`sandbox_id` run is byte-identical to today.
3. **Supervised mode** — a sandbox run under `--supervise` for a *stamped* project: trace lands in
   that project's own `sssf.db`, no stray worktree left behind.
4. **Slice 2/3** — a `worktree_env` sandbox on a real full-stack project: deps install once at create,
   allocated ports don't collide with a second sandbox, `services.up`/`down` bracket the sandbox
   lifecycle (not each run), and the app under the agent reaches its per-sandbox DB via the injected
   `DATABASE_URL`.
5. **Slice 4** — a `land` hook opens a PR (mode `pr`) / merges (mode `merge`); the sandbox survives
   landing and is removed only on explicit shutdown.
6. `/code-review high` on each slice's diff before landing.

## References

- [Architecture](../01-architecture.md) — the determinism spine and the seam this must preserve.
- [Operations](../07-operations.md) — the worker & `run_queue` lifecycle this extends.
- [Config & roster](../05-config-and-roster.md) — where the sandbox profile lives.
- [Extending the system](../08-extending-the-system.md) — Recipe E (the seam-change checklist).
- [`AGENTS.md`](../../AGENTS.md) — the canonical contract.
