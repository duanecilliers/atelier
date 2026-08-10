# Dogfood runbook - Atelier building Atelier (self-hosting via ADWs + sandboxes)

> **Status:** hand-run validation that the factory can **extend and fix itself** through its own
> machinery - the `/atelier` operator skill drives ADW runs, each run works inside an isolated
> **sandbox** worktree, and the result lands as a PR you review and merge. This is the ultimate
> self-hosting test: Atelier is both the tool and the target.
>
> This is different from the sandbox dogfoods against external projects
> (a [Laravel app](../docs/design/sandbox-runs.md), lunacomet): those proved the sandbox **feature** works on
> someone else's repo. This proves the **whole workflow** - orchestrate → run in a sandbox → observe
> → land → merge - works when the repo under the knife is Atelier.
>
> Companion references (all in this repo): the operator skill
> [`engine/skills/atelier/SKILL.md`](../engine/skills/atelier/SKILL.md) and its cookbooks
> ([`run_adw.md`](../engine/skills/atelier/cookbooks/run_adw.md),
> [`how_to_prompt_for_the_eng.md`](../engine/skills/atelier/cookbooks/how_to_prompt_for_the_eng.md),
> [`sandboxes.md`](../engine/skills/atelier/cookbooks/sandboxes.md)); the guides
> [`docs/05-config-and-roster.md`](05-config-and-roster.md) §8 and
> [`docs/07-operations.md`](07-operations.md) §5; design rationale
> [`docs/design/sandbox-runs.md`](design/sandbox-runs.md).

---

## 0. The two mental models to hold

1. **The cockpit only writes intent; the worker does everything real.** Creating a sandbox or
   enqueuing a run INSERTs a row. Nothing happens until `just worker` (running **at the Atelier repo
   root**) picks it up. This is the determinism spine.
2. **The factory cannot edit its own grader.** `defaults.protected_files` in
   `engine/adws/adw_sssf_config/sssf.config.yaml` puts the **engine machinery and the config itself**
   off-limits to every agent - so a self-build run can improve the **cockpit, docs, and specs** but
   **not** the ADW engine or the roster. An agent that tries is rolled back and the phase dies
   (`permissions.py`). This is what makes "the factory builds itself" safe.

And one posture, from the operator skill: **you orchestrate; you never do the ADW's work yourself.**
You translate the request, launch the chain, watch the trace, and report. The agents inside the ADW
do the coding.

---

## What the factory may and may not change on itself

`protected_files` (current config):

```
engine/adws/adw_modules/        # the engine library
engine/adws/adw_sssf_config/    # the roster + this config
engine/adws/adw_*.py            # the ADW scripts
```

| Target | Buildable by an ADW? | Why |
| --- | --- | --- |
| `cockpit/**` (the observer/control plane) | **Yes** | The headline self-build surface. Real Next.js features + bugfixes. |
| `docs/**`, `app_docs/**`, `*.md` | Yes | The documenter's `writes`, and general docs. |
| `specs/**` | Yes | The planner's `writes` (plan artifacts). |
| `engine/adws/adw_modules/**`, `adw_*.py`, `adw_sssf_config/**` | **No** | `protected_files` - the machinery that grades the run. A human edits these directly (that is what this whole session did for the sandbox engine). |

So: **feature/bugfix work on the cockpit is the sweet spot** for self-hosting. Engine changes stay a
human job (see [§E](#e-when-the-task-touches-the-engine-protected_files)).

**Gate reality:** Atelier has **no unit-test suite**. Its real gates are the cockpit **typecheck** and
the **seam contract**, declared in the config's `quality:` block (not `test:`). So pick a chain whose
**quality** phase runs them (e.g. `adw_plan_build_test_quality`), not one that only has a `test` phase
(which honestly reports "nothing run" here). Confirm the chains on disk - they are the only authority:
`head -20 engine/adws/adw_*.py`.

**Roster / machine caveat:** the default rides `openai-codex/*` via `pi` (builder/reviewer/documenter);
planner + scout are `anthropic/*` via `claude_code` (local `claude` CLI login). pi's **Anthropic** OAuth
is dead on this machine, but its openai-codex auth works and Anthropic is force-routed to `claude_code`,
so the **full roster is functional**. Do not "fix" this by pointing an agent's `anthropic/*` model at pi.

---

## Prerequisites (once)

Atelier is **already registered** in `cockpit/atelier.projects.json` as `atelier` (root `..`,
adwsSubdir `engine/adws`), and the `sandbox:` block already declares a `worktree_env` profile
(warms `pnpm --dir cockpit install`, allocates a `WEB` port, injects `ATELIER_SANDBOX_WEB`). So:

**P1 - Worker at the Atelier repo root.** The only thing that turns intent into a running ADW /
provisioned sandbox. Watch it throughout.
```bash
cd /Users/duane/Dev/atelier
just worker            # add --concurrency 2 to run two sandboxes at once
```

**P2 - Cockpit (the stable observer).** Run the **main checkout's** cockpit on :4200 - this is what
you orchestrate and watch in; it observes every run, including sandboxed ones (traces route to the
shared `sssf.db` via `SSSF_TRACE_ROOT`).
```bash
cd /Users/duane/Dev/atelier/cockpit && pnpm dev     # http://127.0.0.1:4200/atelier
```

**P3 - Auth sanity.** `claude -p "say hi"` returns text (planner/scout). `pi` has working
openai-codex auth (builder/reviewer/documenter). The namer (`anthropic/claude-haiku-4-5`) uses the
local `claude` login too.

**P4 (optional) - Configure landing as a real PR.** Atelier is on GitHub and `gh` is authed, so unlike
the Bitbucket dogfood you can land a sandbox as a real PR. `sandbox:` is in `protected_files`, so this
is a **human edit** to `engine/adws/adw_sssf_config/sssf.config.yaml` - add under `worktree_env:`:
```yaml
    land:
      mode: pr
      cmd: git push -u origin ${BRANCH} && gh pr create --fill --head ${BRANCH} --base main
```
Restart the worker after any config edit (config is read once at startup). Leave `land` unset to keep
manual landing (branch left for a human) while you build confidence.

---

## The self-hosting loop (what every track below follows)

1. **Engineer states the ask** in plain words.
2. **`/atelier` translates it** to the four-line prompt (ask · Where · Done means · Out of scope) per
   [`how_to_prompt_for_the_eng.md`](../engine/skills/atelier/cookbooks/how_to_prompt_for_the_eng.md),
   and **picks the chain** from the files on disk - the fullest chain the work justifies.
3. **Run it in a sandbox** so the work is isolated on its own branch/worktree, never the main checkout.
4. **Observe** the trace (cockpit swim lanes, or `just phases/tail/procs <adw_id>`).
5. **The quality phase runs typecheck + contract** in the worktree; a red gate returns to the builder.
6. **Land** (PR if configured, else manual) and **shut down** the sandbox when done.
7. **You review the diff and merge** - acceptance is always yours; the factory proposes.

Two ways to bind a run to a sandbox (both end in the same place - see
[`sandboxes.md`](../engine/skills/atelier/cookbooks/sandboxes.md)):
- **Create-and-run from the Conductor** (`/atelier/queue`): the Sandbox dropdown's **＋ new sandbox**
  creates a sandbox and enqueues the run into it in one step; the run's request doubles as the sandbox
  purpose, so the branch auto-names (`feat/…`).
- **Create then attach**: make the sandbox on `/atelier/sandbox` (optionally with an explicit branch),
  then **run here →** on its card, or enqueue with its `sandbox_id`.

---

## A. Build a new cockpit feature (end-to-end, in a sandbox)

Illustrative task (swap in your own): *a "copy branch" button on each sandbox card.* It is
cockpit-only, touches no seam table, and is easy to eyeball - a good first self-build.

**A1 - Translate + choose the chain.** Via `/atelier`, the prompt becomes something like:
```
Add a "copy" button beside the branch name on each sandbox card that copies the
branch to the clipboard, with a brief "copied" confirmation.
Where: cockpit/components/sandboxes/ (the sandbox card), cockpit/components/terminal.tsx (shared UI)
Done means: clicking copy puts the branch on the clipboard and shows a transient "copied" state.
Out of scope: copying anything else; changing the sandbox schema or API.
```
Chain: the fullest that runs the gates - **`adw_plan_build_test_quality`** (plan → build → test →
quality → review → document, per its `Phases:` line; confirm on disk). It plans, builds, runs
typecheck + contract, reviews against the ask, and documents.

**A2 - Launch into a fresh sandbox.** On `/atelier/queue`, pick **＋ new sandbox** (level
`worktree_env`), choose `adw_plan_build_test_quality`, paste the prompt, Launch. Or by hand:
```bash
# enqueue-in-new-sandbox is the cockpit path; the CLI equivalent binds an existing sandbox:
just worker    # already running; it provisions the worktree (pnpm install warms) then spawns the run
```
The worker provisions `~/.atelier/worktrees/atelier/<id>` (branch `feat/…`), warms cockpit deps, then
spawns the chain with `cwd=<worktree>` and `SSSF_TRACE_ROOT=<repo root>`.

**A3 - Observe.** Watch the swim lanes at `/atelier` (or `just phases <adw_id>` / `just tail
<adw_id>`). The **quality** phase is the one that matters here - it runs `pnpm --dir cockpit typecheck`
and `check:contract` in the worktree. A failure returns to the builder as an envelope and re-prompts.

**A4 - See it running (optional, the self-hosting flourish).** The sandbox worktree holds the
*modified* cockpit. Run **that** cockpit on the sandbox's own port, pointed at the shared db, without
disturbing your :4200 observer:
```bash
cd ~/.atelier/worktrees/atelier/<id>/cockpit
# point it at the shared trace db (SSSF_DB); the sandbox exports its port as ATELIER_SANDBOX_WEB
echo "SSSF_DB=/Users/duane/Dev/atelier/engine/adws/adw_data/sssf.db" > .env.local
pnpm dev --port "$ATELIER_SANDBOX_WEB"     # visit http://127.0.0.1:$ATELIER_SANDBOX_WEB/atelier
```
Now you have two cockpits: :4200 (stable observer) and the sandbox's built version (the feature under
test). This is Atelier observing a change to Atelier.

**A5 - Land + review.** With PR landing configured (P4), click **Land** on the card - the worker
pushes the branch and opens a real PR; the URL is captured in the card's `land_result`. Then review
the diff and `gh pr merge --squash --delete-branch` (Atelier is squash-only). Shut the sandbox down
when merged.

---

## B. Fix a cockpit bug (in a sandbox)

Illustrative real bug (from this repo's own code review): **the sandbox create form silently drops the
`purpose` when both a branch and a purpose are typed** (`NewSandboxButton.tsx`). Cockpit-only, writable.

**B1 - Prompt + chain.**
```
When both a branch and a purpose are entered on the New Sandbox form, the typed
purpose is silently dropped. Preserve it: send the purpose alongside the branch so
the sandbox row records it, or make the discard explicit in the UI.
Where: cockpit/components/sandboxes/NewSandboxButton.tsx
Done means: creating a sandbox with both a branch and a purpose records the purpose on the row.
Out of scope: changing branch-vs-purpose precedence; any API/schema change.
```
Chain: a bug with a known, small shape → **`adw_plan_build_test`** (or `adw_plan_build_test_quality`
to force the typecheck+contract gate). For a truly obvious one-liner, `adw_build_test`.

**B2–B5** are the same loop as Track A: launch into a `worktree_env` sandbox, watch the quality phase
run the gates, land, review, merge. The point of B is to prove the factory closes its own review
findings, not just adds features.

---

## C. Recon first (when the shape is not obvious)

For a change you cannot describe in one sentence, run a **read-only scout** first to map the code, then
feed its findings into a build chain under the **same `--adw-id`** (so context carries):
```bash
uv run engine/adws/adw_scout.py "where does the cockpit resolve which project's sssf.db to read" --adw-id <id>
# then, same id, a build chain once you know the shape
```
Scout writes only to `context_handoff/` (read-only wrt the repo). This is the one case where a
single-agent chain is right; never use one for work that changes code.

---

## D. Run two self-builds at once (isolation across sandboxes)

With `just worker --concurrency 2`, launch two features into two sandboxes. Confirm they do not
collide: two worktrees under `~/.atelier/worktrees/atelier/`, two branches, two independent traces,
two `WEB` ports. Runs in the **same** sandbox serialize by design; parallelism is across sandboxes.
This is the everyday value: several improvements to Atelier in flight, each isolated.

---

## E. When the task touches the engine (`protected_files`)

If the ask changes `engine/adws/adw_modules/**`, an `adw_*.py`, or the config, the builder's write is
**rolled back** and the phase dies with a permissions violation - by design. Options, in order of
preference:

1. **Do it by hand.** Engine/roster changes are a human job (exactly how the sandbox engine itself was
   built). Use `/code-review high` + `pnpm check:contract` before landing, as usual.
2. **Split the work.** Often the engine part is small and the cockpit/docs part is large - hand-do the
   engine change, then let the factory build the cockpit/docs half in a sandbox.
3. **Deliberately, temporarily scope `protected_files`** for a specific engine task - only with eyes
   open: you are letting an agent edit the machinery that grades it, so keep the change tiny, review
   every line, and restore the guard immediately. Not recommended as a habit.

Trying to self-build the engine and watching the rollback fire is itself a worthwhile test - it proves
the guard holds.

---

## Gotchas specific to self-hosting

- **`protected_files` rollback is expected**, not a bug - it is the factory refusing to edit its own
  grader. Pick cockpit/docs/specs tasks, or do engine work by hand (§E).
- **Pick the chain whose gates actually run.** Atelier's gates live in `quality:` (typecheck +
  contract), not `test:`. A `*_test`-only chain reports "nothing run"; use a `*_quality` chain.
- **Two cockpits.** Keep the stable observer on :4200 (main checkout); run a sandbox's built cockpit on
  `$ATELIER_SANDBOX_WEB` to eyeball a change. Point the sandbox cockpit's `SSSF_DB` at the shared db.
- **The orchestrator does no work.** `/atelier` translates, launches, observes, reports. If you catch
  yourself editing the target files "to help", stop - that is the ADW's job.
- **Config edits need a worker restart** (config read once at startup).
- **Squash-only merges** (`gh pr merge --squash --delete-branch`); the PR title+body become the commit.
- **Shut sandboxes down** when merged so worktrees/branches do not accumulate under
  `~/.atelier/worktrees/atelier/`. The branch survives in the shared `.git` after teardown.

---

## Results (fill in as you go)

| Track | Result | Evidence (adw_id / sandbox id / branch / PR) |
| --- | --- | --- |
| A. cockpit feature end-to-end (sandbox → gates → PR) | **PASS** | adw `224a74f0` / sandbox `5953668e` / `feat/copy-branch-button` / PR #29 **merged** (`bca857f`). 9/9 phases green; spec landed in the worktree. |
| B. cockpit bugfix (closes a review finding) | **PASS** | adw `85838b5b` / sandbox `f5b0c68b` / `fix/sandbox-purpose-with-branch` / PR #32 (open). Fixed `NewSandboxButton` purpose-drop + added `control.test.ts` coverage. |
| C. scout recon → build under same adw_id | **PASS** (direct CLI) | adw `082564d4` - **one session** holds scout (recon) + plan/build/verify/commit; context carried via the shared `--adw-id` (builder reused the "existing no-runs empty state" the scout mapped). Branch `dogfood/track-c` / commit `a10d714` (typed missing-db signal → friendly empty state). |
| D. two concurrent self-builds, isolated | **PASS** | Two sandboxed `*_quality` runs launched back-to-back, executed **simultaneously** under `--concurrency 2` (both `running` in the same trace snapshot). **D1:** adw `38c817d2` / sandbox `8a83bf57` / `feat/nav-tooltips` / port **53497** / commit `05fd6f0` (9/9 green) / **PR #33**. **D2:** adw `a4cfdd2c` / sandbox `82ace5ea` / `chore/conductor-launch-aria-label` / port **53528** / commit `8902210` (9/9 green) / **PR #34**. Isolation confirmed: two worktrees under `~/.atelier/worktrees/atelier/`, two branches, two `WEB` ports, two independent traces, zero collision. Both landed via the sandbox `land: pr` hook, then both sandboxes shut down (branches survive in `.git`). |
| E. engine task hits protected_files rollback (guard holds) | **PASS** (run failing IS the success) | adw `69cbeeb5` / sandbox `24e1e4f6` / branch `docs/gate-violation-comment`. Task asked the builder to add a one-line comment to `engine/adws/adw_modules/gates.py`. `plan` succeeded; `build` **failed** on a `permission_breach`: *"builder is barred from ['engine/adws/adw_modules/', 'engine/adws/adw_sssf_config/', 'engine/adws/adw_*.py'] but modified 1 path(s): engine/adws/adw_modules/gates.py - rolled back"*. Worktree diff empty afterward (rollback clean), no commit landed. |
| Landing: real GitHub PR opened + merged | **PASS** | Sandbox **Land** hook (`land: pr`) exercised end-to-end: the worker pushes the branch + runs `gh pr create --fill` in the worktree → PR #29 (merged), PR #32, and the two Track D PRs #33/#34 - all opened by the hook, none by hand. PR title **and** body populate correctly (the commit-message/PR-description fix landed). |

### Findings from this run

- **Engine bug found + fixed via the dogfood (the headline result).** The first sandboxed *planning*
  chain failed at the plan phase: the planner wrote its `specs/` copy into the **main repo**, not the
  worktree, so the `artifacts_exist` gate rejected it (adw `bc4e07a2`, then `95db4214` with no residue
  - reproduced). Root cause: a two-roots collision - `cwd`/`repo_root` = the worktree but
  `context_handoff_dir` was anchored at `SSSF_TRACE_ROOT` = the main repo, and the planner was handed
  only that one absolute path. Fixed by giving agents an explicit `{{repo_root}}` (execution root)
  template var, distinct from `{{context_handoff_dir}}` (trace root); planner + documenter now anchor
  repo copies at `<repo_root>/…`. Shipped as PR #28 (`c1c1bbb`), released v0.3.1. This is exactly a §E
  case - an engine change, done by hand because the engine is `protected_files`.
- **Known gotcha confirmed:** a direct CLI launch (`uv run adws/adw_*.py`) does **not** run in a
  sandbox - it executes at the repo root and commits to the current branch. Sandbox binding happens
  only through the queue + worker (cockpit "＋ new sandbox" or an enqueue with a `sandbox_id`).
- **Limitation surfaced by Track C:** the enqueue spec has no `adw_id` field and the worker mints a
  fresh id per run, so **sandbox binding and `--adw-id` context-carry are mutually exclusive today** -
  a scout→build chain that shares a session (Track C) can only run direct-CLI. Track C was therefore
  run on a throwaway `dogfood/track-c` branch (scout is read-only; only the build commits). A future
  enhancement could let an enqueue attach to an existing session/sandbox for context carry.
- **The `protected_files` guard holds under a real self-build (Track E).** Asked to add a one-line
  comment to `engine/adws/adw_modules/gates.py`, the builder made the edit and `permissions.py::enforce`
  caught it *after* the agent call: the write was **rolled back** and the `build` phase hard-failed with
  a `permission_breach` naming the barred globs. The worktree diff was empty afterward - the factory
  refuses to edit its own grader, and the "failing" run is the proof. No feedback loops back to the agent
  for a protected-path breach (unlike a gate rejection); it is a terminal hard-fail by design.
- **Concurrency is real and isolation is clean (Track D).** Two `*_quality` self-builds launched
  back-to-back ran **simultaneously** under `--concurrency 2` - both `running` in the same trace snapshot,
  in two separate worktrees on two branches (`feat/nav-tooltips`, `chore/conductor-launch-aria-label`)
  with two distinct `WEB` ports (53497, 53528) and two independent traces. Both passed the full `quality:`
  gate (typecheck + contract + vitest + pytest) 9/9 and committed to their own branch - zero collision.
  This is the everyday value: several isolated improvements to Atelier in flight at once.
