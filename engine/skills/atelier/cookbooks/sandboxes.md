# Sandboxes

Run an ADW in an **isolated, persistent workspace** — a git worktree on a named branch — instead
of sharing the repo root. **You request and observe; the worker provisions and disposes.** Same
determinism spine as the launch queue: the cockpit only ever INSERTs a row or flips a flag; the
worker (`just worker`) is the only thing that touches a real worktree.

## What a sandbox is

A **sandbox** is a first-class, persistent entity — not a per-run temp dir. It has its own
lifecycle (create → host runs → land → shut down) and **outlives every run it hosts**, because
real feature work is iterative: run, inspect, run again in the same warm tree. Consequences worth
holding onto:

- **Parallelism is *across* sandboxes.** Runs targeting the *same* sandbox **serialize** — two
  runs in one tree would re-introduce the write collision the isolation exists to remove. To run
  things in parallel, use two sandboxes.
- **Only shutdown destroys a sandbox.** Landing does not; a finished run does not. The tree stays
  until you explicitly shut it down.
- **The ADW *process* stays local.** Only its `cwd` (and, at L2, its env) changes — so the local
  `claude`/`pi` login and the process-group cancel keep working untouched, and a sandboxed run's
  trace is byte-identical in shape to a local one.

### Levels (bounded vocabulary — `roster-constants.ts`)

| Level | Buys | Provisioning |
|---|---|---|
| `local` *(default)* | nothing — the run executes at the repo root, exactly as today | none |
| `worktree` (L1) | write isolation: a persistent branch workspace | `git worktree add` on a named branch |
| `worktree_env` (L2) | above **+** isolated deps, per-sandbox ports, backing services, scoped env | + `setup`, allocated `ports`, `services.up`, injected `env` |

`local` is byte-identical to a normal run — no sandbox row, no worktree. The two provisionable
levels are what the worker acts on. **The cockpit's "+ New sandbox" preselects `sandbox.default`**
(falling back to `worktree` when it is `local` or names an undeclared level) and shows a **level
picker** whenever the project declares a `worktree_env` profile beside the always-available L1
`worktree`; the selected level's branch is minted from its `profile.branch` template
(`${SANDBOX_ID}` interpolated at create). A project with no `worktree_env` profile keeps the
single-button `worktree` UX. The engine fully provisions `worktree_env` when a sandbox's `level` is
set to it and the project declares a `worktree_env` profile — see
[references/config.md](../references/config.md#sandbox).

## Lifecycle

```
 request ─▶ provisioning ─▶ active ⇄ (run, run, run…) ⇄ landing ─▶ shutting_down ─▶ gone
            worktree add     host serialized runs        land hook    services.down
            ports + setup     (follow-up work)           (pr|merge)    worktree remove
            services.up                                                  └ or → failed on a bad provision
```

A run may target a sandbox **only while it is `active`**. `landing` is a transient window that
always returns to `active` — it never destroys anything. `failed` is terminal-bad (a provision
blew up); `gone` is the clean end.

## Operate it (through the cockpit)

The Sandboxes page is per-project (`/<project>/sandboxes`). Everything there is control-plane
intent — no page ever spawns a process.

- **Create** — **+ New sandbox** POSTs `/api/sandboxes`, which INSERTs a `requested` row. The next
  `just worker` poll provisions the worktree and flips it to `active`. (By hand: INSERT a
  `sandboxes` row via `AtelierControl.createSandbox` - same write path.) The create form has two
  optional inputs, in precedence order:
  1. **branch** - an explicit branch name, used verbatim (the worker checks it out if it already
     exists, else forks it off HEAD). Wins over purpose. Use it for conventions the namer can't
     produce (it lowercases and only emits `feat/fix/chore/docs`), e.g. `feature/PROJ-233_...`. The
     field validates inline against the same charset as `validateBranchName`.
  2. **purpose** ("what's this sandbox for?") - with a purpose and **no** branch, the row is created
     with `branch` NULL and the **worker names the branch from the purpose** at provision via a
     cheap model (`sandbox.namer`, default Haiku) → e.g. `feat/api-rate-limiting`, falling back to
     `adw/<id>`. The card shows `naming…` until it lands.

  With neither, the branch comes from the level's `branch` template (default `adw/${SANDBOX_ID}`).
  See `sandbox.namer` in [references/config.md](../references/config.md#sandbox).
- **Attach a run** — from an `active` sandbox card, **run here →** links to the Conductor
  (`/<project>/queue`). Enqueuing with a `sandbox_id` binds the run to that sandbox; the worker
  spawns it with `cwd=<worktree>` and `SSSF_TRACE_ROOT=REPO_ROOT`, so **its trace still lands in
  the shared `sssf.db`** (that env var is the one correctness fix — observability paths absolutize
  against the trace root, execution paths follow `cwd`). A run enqueued against a gone/failed
  sandbox is rejected at enqueue; one whose sandbox dies mid-wait is failed as orphaned.
- **Create-and-run in one step** — the Conductor's **Sandbox** dropdown also offers **＋ new
  sandbox** (beside *local* and the attach list). Picking it shows the level toggle and, on Launch,
  **creates a sandbox and enqueues the run into it** in one transaction (`AtelierControl`
  ::`enqueueInNewSandbox`) — no orphan sandbox if the enqueue is rejected. The run's `request`
  doubles as the sandbox `purpose`, so the **branch is named from the same text** you typed (the
  namer above) with nothing extra to fill in. Mutually exclusive with picking an existing
  `sandbox_id`.
- **Land** — **Land** flips `land_requested`. The worker runs the project's `land` hook **once**,
  in the worktree, then returns the sandbox to `active`. The hook's captured stdout (a PR URL /
  merge summary) shows on the card as `land`. `mode: manual` (or no `land` configured) runs
  nothing and records that the branch was left for a human. A failed hook leaves the sandbox
  `active` with the error recorded — re-request it. Landing is **non-destructive**; the sandbox
  survives until separately shut down.
- **Shut down** — **Shutdown** flips `shutdown_requested`. The worker runs `services.down`, removes
  the worktree, and marks the row `gone`. This is the **only** thing that tears a sandbox down. The
  named branch and its commits **survive in the shared `.git`** (that is the whole point of a
  worktree) — shutdown reclaims the working tree, not the work.

Worktrees live **outside the repo** at `~/.atelier/worktrees/<project>/<sandbox-id>` (no
`.gitignore` churn; `git rev-parse --show-toplevel` still resolves inside them). `<project>` is
`sandbox.project_name` when set, else the repo's git-common-dir identity (so a bare-repo/worktree
layout namespaces by the shared repo name, not the working-tree basename). The provision /
services / land hooks log **beside** the worktree at `<sandbox-id>.provision.log` — never inside
it, so provision artifacts never surface as untracked files in the sandbox's own diff.

## What the worker does (reconcile + reap)

The same `just worker` that drains the launch queue reconciles its project's sandboxes **every
poll** (`reconcile_sandboxes`):

1. **Provision** every `requested` sandbox → `active` (or `failed` if git / `setup` / `services.up`
   throws; a partial `services.up` is brought back down and the tree removed so nothing leaks).
2. **Tear down** every `shutdown_requested` sandbox **that has no run in flight** (a live run keeps
   its tree busy; teardown waits at most one poll).
3. **Land** every `land_requested` `active` sandbox with no run in flight — **after** teardown, so
   a sandbox flagged for both shuts down (the stronger intent) rather than landing a tree that's
   about to vanish.
4. **Fail** any queued run whose sandbox is now `gone`/`failed`, instead of letting it wait forever.

On **startup** the worker reaps orphans a crashed predecessor left mid-lifecycle
(`reap_orphan_sandboxes`) — one worker owns its project's sandboxes exclusively, so a sandbox stuck
in a transient state belongs to a dead worker: `provisioning` → `failed`, `shutting_down` → `gone`
(services down + tree removed), and a `landing` orphan → back to `active` (landing never touched
the tree, so there is nothing to reap — the land just didn't finish and is re-requestable).

Under `--supervise` this all composes for free: each per-project worker sits at its own
`REPO_ROOT`, so `SSSF_TRACE_ROOT` is that project's root and its sandboxes reconcile in its own
`sssf.db`. There is no second ADW spawn site.

## Observe it

The `sandboxes` table is the control seam (mirrored Python↔TS, guarded by `pnpm check:contract`):

```bash
sqlite3 adws/adw_data/sssf.db \
  "select id, level, status, branch, tip_sha, land_result, error from sandboxes order by created_at desc;"

# which runs are bound to a sandbox
sqlite3 adws/adw_data/sssf.db \
  "select adw_id, adw_name, status, sandbox_id from run_queue where sandbox_id is not null order by id desc;"
```

Statuses: `requested → provisioning → active → landing → shutting_down → gone | failed`. A row
with `tip_sha` NULL has hosted no run yet; `land_result` holds the last land hook's output.

## Orchestrator posture

- **Never `git worktree add`/`remove` a sandbox tree yourself, and never edit a sandbox row's
  engine-owned columns.** Request via the cockpit (or `AtelierControl`); the worker disposes. A
  hand-made worktree is invisible to reconciliation and leaks.
- A sandbox with un-landed commits is normal — that is what `land` is for. Shutting it down
  discards the *tree*, not the branch; the commits remain reachable in `.git`.
- To configure a project's provisioning and landing, edit the `sandbox:` block in its config — see
  [references/config.md](../references/config.md#sandbox). The engine re-validates it (Pydantic) at
  run time, same as the rest of the roster.
