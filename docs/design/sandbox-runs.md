# Design note — Sandbox / isolated runs

> **Status: PROPOSED — not yet implemented.** This is the last open Phase 5 item
> ("Sandbox / cloud runs — push 80% of junk work to sandboxes", see
> [`atelier-plan.html`](../atelier-plan.html)). This note captures the design decided so far so a
> future session can pick it up without re-deriving it. Nothing here is built; no branch or PR
> exists for it. When it lands, fold the relevant parts into the numbered guides and drop the
> status note in [`docs/README.md`](../README.md).

> **Revisit note (2026-08-06).** Re-verified against the current tree after the distribution
> track landed. The design still stands and nothing is built (`SSSF_TRACE_ROOT`, `run_queue.target`,
> and `.sandboxes/` are all absent). Two refinements from the now multi-project reality are folded
> in below: the supervisor/worker layering — which turns out to *strengthen* the single-spawn-site
> assumption, see [§ Multi-project](#multi-project--where-the-trace-root-comes-from) — and the
> worktree **location** for stamped repos (Implementation § 2 and Open questions).

## Goal

Run each ADW in **write-isolation** so multiple runs can be in flight without clobbering each
other's working tree. Today the worker runs every ADW with `cwd=REPO_ROOT`, so `--concurrency > 1`
means parallel runs share one tree and can collide on writes. The win we're buying is **parallel
isolation**, not security containment and not off-machine offload.

## Chosen shape (decisions locked)

| Axis | Decision | Why |
| --- | --- | --- |
| Isolation mechanism | **Local git worktree** per run (`git worktree add --detach .sandboxes/<adw_id> HEAD`) | Preserves the determinism spine (the worker still builds the same argv; only `cwd` changes), auth is trivial (same machine), and it's fully verifiable by kicking a real run. |
| Primary goal | **Parallel-write isolation** | Each run owns its filesystem, so `--concurrency > 1` becomes genuinely safe. |
| PR scope | **Engine + cockpit surface** | Worker gains the mode; a `run_queue.target` column carries the choice across the seam; the cockpit lets you pick a target at launch and shows it. |

### Alternatives rejected

- **Local Docker containers** — real OS/blast-radius isolation, but heavy (an image with `uv` +
  `claude` + `pi`, mounting the local `claude` login in) and the process-group cancel gets
  indirect. Overkill for the parallel-isolation goal.
- **Remote cloud sandboxes** — largest surface, and **blocked on this machine**: the local
  `claude` CLI login / pi OAuth can't travel to a remote sandbox, so runs couldn't authenticate
  and couldn't be verified by kicking a real ADW (the repo's only acceptance gate). Would ship
  un-verifiable. See the machine gotcha in [Architecture](../01-architecture.md).

## The key architectural insight

If a run's `cwd` becomes a worktree, the codebase splits cleanly into two concerns — and only one
of them needs a fix:

| Concern | Resolves via | Under a worktree cwd | Action |
| --- | --- | --- | --- |
| **Execution surface** — agent cwd, write-boundary diff, commit, `protected_files` | `repo_root()` = `git rev-parse --show-toplevel`, which **inside a worktree returns the worktree** | Correct — this is exactly the isolation we want | **None** |
| **Observability sink** — the shared `sssf.db`, the JSONL trace, `data_dir`/session dirs | resolved **relative to `cwd`** (relative path strings from config) | Would silently move **into** the worktree → the cockpit sees nothing | **The one correctness fix** |

So the design is: the worker creates a worktree, spawns the ADW with `cwd=worktree` **and** tells
it the shared trace root; the observability paths absolutize against that root. Non-sandboxed
runs (CLI, or `target=local`) leave the signal unset → everything resolves against `cwd` as today
→ **byte-identical behavior**.

## Multi-project — where the trace root comes from

The distribution track added a **supervisor** (`adw_worker.py::supervise` / `_spawn_worker`) above
the worker: it keeps one **worker** per `workerDesired` project alive, each spawned with
`cwd=entry.root`. That is a new spawn site — but **not** a second *ADW* spawn site. The supervisor
spawns *workers*; each worker still spawns ADWs through the single `spawn()` (`adw_worker.py:150`,
`cwd=REPO_ROOT`). The worktree logic lives in `spawn()` and nowhere else — `_spawn_worker` needs
**no** change.

The reason it composes cleanly: `REPO_ROOT = git_helper.repo_root()` is resolved **per worker
process at import** (`adw_worker.py:47`), so inside a supervised worker it already equals *that
project's* root (the worker runs in `entry.root`). So the plan below is uniform across standalone
(`just worker`) and supervised modes — `spawn()` sets `cwd=<worktree>` and
`SSSF_TRACE_ROOT=REPO_ROOT`, and `REPO_ROOT` is the correct per-project trace root in both cases,
with no per-mode branching. The one thing an implementer must not do is capture a single global
"atelier root": always use the worker's own `REPO_ROOT`.

## Implementation plan

### 1. Engine — observability resolves against a shared trace root (the correctness fix)
- `adw_modules/utils.py` — add `trace_root()` → `Path(os.environ.get("SSSF_TRACE_ROOT") or Path.cwd())`
  and `resolve_trace_path(p)` (absolutize a relative path against `trace_root()`).
- `session.py::ensure` — wrap the two `Tracer(...)` paths (db + events JSONL) with `resolve_trace_path`.
- `runner.py::Run.__init__` — wrap `session_dir` (the context-handoff dir and `agent_map.json`
  hang off it, so they follow).
- **No-op when `SSSF_TRACE_ROOT` is unset.** `cfg.defaults.data_dir` stays a relative string, so
  the `permissions` write-boundary / `always_writable` derivation is untouched (see
  [Agents & the write boundary](../03-agents-and-gates.md)).

### 2. Engine — worker gains a worktree execution mode (`adw_worker.py`)
- Read `row["target"]` (add `target` to `_CLAIM_COLS` in `queue.py`).
- `target == 'worktree'`: `git worktree add --detach <worktree-path> HEAD` → spawn with
  `cwd=<worktree>`, `env` adding `SSSF_TRACE_ROOT=REPO_ROOT` (the worker's own root — see
  [§ Multi-project](#multi-project--where-the-trace-root-comes-from)), and absolutize `--config` to
  the **real** repo config (so the sandbox reads live roster, not the worktree's HEAD copy). Store
  the path on the `Job`.
- **Worktree location — decide before building (multi-project consequence).** A worktree created
  *inside* the repo (`REPO_ROOT/.sandboxes/<adw_id>`) shows up as an untracked directory, so **every**
  project — including stamped repos — would need `.sandboxes/` in its `.gitignore`, coupling this to
  `install.py` (stamp the ignore) and to `update.py`. Prefer placing worktrees **outside** the project
  tree, keyed by project — e.g. `~/.atelier/worktrees/<project-id>/<adw_id>` (or a temp dir). `git
  rev-parse --show-toplevel` still returns the worktree wherever it lives, so `repo_root()` inside it
  stays correct, and no project's `.gitignore` is touched. (If we *do* keep them in-repo, add
  `.sandboxes/` to `.gitignore` here **and** teach `install.py` to stamp it.)
- Teardown: `git worktree remove --force <path>` on terminal reap **and** on cancel-complete.
  On startup, best-effort reap of stale worktrees from a crashed prior worker (`git worktree prune`
  plus removing the run dirs).
- `target == 'local'` (default): **unchanged** — today's exact behavior.

### 3. Seam — new `run_queue.target` column (this is a seam change — follow the checklist)
Add `target TEXT DEFAULT 'local'` and mirror it everywhere. This is exactly
[Extending → Recipe E](../08-extending-the-system.md#recipe-e--add-a-column-to-a-trace-table-or-run_queue):
- `queue.py` `RUN_QUEUE_DDL`; `tracer.py` `MIGRATIONS` (`("run_queue","target","TEXT DEFAULT 'local'")`).
- `cockpit/lib/control.ts` — DDL mirror, `EnqueueSpecSchema` (`target: z.enum(['local','worktree']).optional()`),
  the `enqueue()` INSERT, the `get()` SELECT.
- `cockpit/lib/schemas.ts` (`RunQueueRowSchema`) + `cockpit/lib/types.ts` (`RunQueueRow.target` + a `RunTarget` union).
- `cockpit/scripts/check-contract.ts` — add `run_queue: new Set(['target'])` to `MIGRATION_COLUMNS`.
- `cockpit/lib/db.ts` `queue()` — select via the existing `optionalColumn('run_queue','target')` helper.

### 4. Cockpit — surface it
- `QueueLauncher.tsx` — a Target selector (Local / Worktree) with a one-line blurb; POST includes `target`.
- `queue/page.tsx` `QueueCard` — a small "worktree" chip when `target === 'worktree'`.
- Run-detail badge — a lightweight readonly `db.queueRowForAdw(adwId)` lookup + chip (adds one
  `AtelierDb` method → **restart `pnpm dev`** afterward, memoized connection).

## Scoped boundary (call this out when it ships)

Sandboxed runs **isolate the working tree; they do not merge committed results back** — the
worktree is torn down on completion, so a commit on its detached HEAD becomes unreachable
(recoverable via reflog until GC). Merge-back is a **future slice**. This matches the goal:
isolation for the "80% junk work" (scout / prompt / read-only), which is exactly what benefits.
Optional cheap safety to consider: record the tip SHA in `run_queue` before teardown so committed
work is at least findable.

## Open questions to settle on revisit

- **Worktree location** *(new — from multi-project)* — outside the repo
  (`~/.atelier/worktrees/<project-id>/<adw_id>`, no `.gitignore` coupling) vs in-repo
  (`REPO_ROOT/.sandboxes/`, needs the ignore stamped into every project via `install.py`). Leaning
  **outside**. Settle this first — it drives whether `install.py`/`update.py` are in scope at all.
- **Env var name** — `SSSF_TRACE_ROOT` is the working name; confirm or pick another.
- **Default target** — row default `'local'` (byte-identical to today), worktree opt-in per run.
  Do we also want a config-level default? Probably not for the first slice.
- **Committed-work recoverability** — record the tip SHA before teardown, or accept reflog-only?
- **Run-detail badge scope** — worth the extra `AtelierDb` method, or keep the badge on the queue
  card only (where `run_queue` data already is)?
- **Stale-worktree reaping** — on worker startup only, or also periodically?

## Verification plan

1. `cd cockpit && pnpm typecheck && pnpm check:contract && pnpm build` (contract now covers `target`).
2. Enqueue two `target=worktree` runs, `just worker --concurrency 2`; confirm each gets its own
   worktree, **both traces land in the shared `sssf.db`**, worktrees are removed on completion, and
   cancel tears down cleanly.
3. Confirm a `target=local` run is byte-identical to today (no `SSSF_TRACE_ROOT`, no worktree).
4. **Supervised mode** — run one `target=worktree` job under `adw_worker.py --supervise` for a
   *stamped* project; confirm its trace lands in that project's own `sssf.db` (i.e. `SSSF_TRACE_ROOT`
   resolved to the worker's `REPO_ROOT`, not the atelier root) and no stray `.sandboxes/` dir is left
   in the project tree.
5. `/code-review high` on the diff before landing.

## References

- [Architecture](../01-architecture.md) — the determinism spine and the seam this must preserve.
- [Operations](../07-operations.md) — the worker & `run_queue` lifecycle this extends.
- [Extending the system](../08-extending-the-system.md) — Recipe E (the seam-change checklist).
- [`AGENTS.md`](../../AGENTS.md) — the canonical contract.
