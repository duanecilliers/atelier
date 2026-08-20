# AGENTS.md

Guidance for AI coding agents working in this repository. (Claude Code reads this via
`CLAUDE.md`, which imports this file.)

## What this is

Atelier is a software factory: **agents propose, deterministic code disposes.** A Python
ADW ("AI Developer Workflow") engine runs coding agents inside bounded phases and decides
sequencing + acceptance; a Next.js "cockpit" observes and controls it. Both halves meet at
**one SQLite file, `engine/adws/adw_data/sssf.db`** - the engine writes the live trace, the
cockpit reads it. That file *is* the seam; treat it as the single source of truth.

It's built phase-by-phase from the locked roadmap in `docs/atelier-plan.html`. Phases 0-2 are
done (foundations/seam · observe · control plane); Phase 3+ (observability/cost, authoring,
real-time) are next.

This file is the terse canonical contract. The long-form guides - architecture, engine runtime,
agents/gates, ADW authoring, config/roster, cockpit, operations, and end-to-end extension
recipes - live in **`docs/README.md`** and the numbered guides beside it. Read those to
understand a subsystem in depth or to extend the factory.

## Commands

Run **engine** commands from the repo root; run **cockpit** commands from `cockpit/`.

| Task | Command |
| --- | --- |
| Kick a demo run (two cheap read-only ADWs) | `just demo` |
| Run one ADW directly | `uv run engine/adws/adw_scout.py --config engine/adws/adw_sssf_config/sssf.config.yaml "<prompt>"` |
| Drain the launch queue (Phase 2 worker) | `just worker` (add `--concurrency N`) |
| Peek at the db | `just sessions` · `just phases <adw_id>` · `just tail <adw_id>` · `just procs <adw_id>` · `just queue` |
| Cockpit dev server | `cd cockpit && pnpm dev` → http://127.0.0.1:4200 |
| Typecheck the cockpit | `cd cockpit && pnpm typecheck` |
| **Run the deterministic test suites + parity checks** | `just test` |
| **Verify the seam contract** (live db) | `cd cockpit && pnpm check:contract` |
| Production build | `cd cockpit && pnpm build` |

The automated gates are: **`cd cockpit && pnpm typecheck`**, **`just test`** (engine `pytest` over
`adw_modules/` + `make_adw`, cockpit `vitest` over the reader/control/roster logic, and the two
static seam-mirror parity checks `check:mirror` + `check:types`), and the live-db **`pnpm
check:contract`**. `just test` is fast, offline, and cost-free, so it runs in CI
(`.github/workflows/ci.yml`) on every push/PR; `check:contract` needs a real `sssf.db` and stays a
local gate (its static counterpart `check:types` runs in CI instead). There is **no linter**. Tests
cover only the deterministic "code disposes" half - `agent`-authored behavior is still verified by
kicking a real ADW and reading its trace (this calls a model and costs a few cents). Engine tests
run under a dev-only `engine/adws/pyproject.toml` (`uv run --project engine/adws pytest`); the ADWs
themselves stay PEP 723 `uv` scripts (deps in the file header) - `uv run` needs no separate install;
the cockpit needs `pnpm install`. The `quality:` block in `sssf.config.yaml` runs the same suites +
parity checks, so every ADW verify phase (and every self-build sandbox run) is gated by them too.

## The seam contract - the #1 rule

The engine's schema is defined in Python (`engine/adws/adw_modules/tracer.py`, the `SCHEMA`
string + `MIGRATIONS`). The cockpit mirrors it in **two** places that must stay in lockstep:
- `cockpit/lib/types.ts` - the frozen TypeScript row interfaces
- `cockpit/lib/schemas.ts` - the Zod validators + `TABLE_COLUMNS` (the column contract)

**Any change to a table in `tracer.py` MUST be mirrored in both TS files**, or Python↔TS drift
silently corrupts the reader. `scripts/check-contract.ts` (`pnpm check:contract`) asserts every
column the cockpit expects exists in the live db - run it after any schema change. Columns the
tracer adds via additive `MIGRATIONS` are marked `.optional()` in Zod and listed in the check's
`MIGRATION_COLUMNS` so an older db still validates; a brand-new table is a hard requirement.

There is a **second** Python↔TS mirror with the same discipline: `cockpit/lib/roster.ts` mirrors
the config models in `data_types.py` (`SSSFConfig`/`AgentConfig`/`ConfigDefaults`) as Zod so the
cockpit can read **and** validate `sssf.config.yaml` before writing it (`pnpm check:contract` does
not cover it - it's a file, not a db table, so keep the mirror in lockstep by hand). Enum
vocabularies shared with the editor UI live in `lib/roster-constants.ts` (no node imports, so a
client component can import them without dragging `node:fs` into the bundle).

## Architecture

### Engine (`engine/`) - the ADW machinery

- ADWs are the `engine/adws/adw_*.py` scripts (e.g. `adw_prompt`, `adw_scout`,
  `adw_plan_build`, `adw_simple_sdlc`). Each composes **phases**; a phase is `engineer`
  (human intent), `agent` (a model proposes, via `run.phase(...).call(AgentCall(...))`), or
  `code` (deterministic disposition).
- `adw_modules/` is the shared library: `session.py` (mints the `adw_id`, builds the `Run`),
  `runner.py` (`Run` + phase context managers), `tracer.py` (writes every event to JSONL **and**
  sqlite as it happens - WAL mode so the cockpit reads through live writes), `agents.py`
  (loads config, dispatches per-agent), `gates.py` (deterministic acceptance checks),
  `data_types.py` (Pydantic models incl. `SSSFConfig`).
- **Agent output is a typed "envelope"** parsed against a `data_types` model; a **gate** then
  deterministically accepts or rejects it. Agents never decide their own acceptance - that
  boundary is the whole point.

### Three coding-agent backends (config key `coding_agent:`)

`agents.execute()` treats all three identically behind one abstraction (each exposes the same
`run(request, on_event, on_spawn, on_exit) -> PiResult` contract):
- `pi` → `agent_pi.py`, drives GPT-5.6 etc. via the `pi` CLI (auth in `~/.pi/agent`).
- `claude_code` → `agent_cc.py`, drives Claude via `claude-agent-sdk` using the local `claude`
  CLI's own login (**no API key**). `agent_cc.run` mirrors `agent_pi.run`'s contract exactly.
- `cursor` → `agent_cursor.py`, drives Cursor's models via the `cursor-agent` CLI (`cursor-agent
  login`, **no API key**), proxying Anthropic/OpenAI/Grok/Kimi/Composer. Own subprocess + tailed
  NDJSON like `pi`; tool events re-emitted in pi's shape like `agent_cc`. Model ids use the
  **`cursor/` namespace** (`cursor/auto`, `cursor/claude-opus-4-8-thinking-high`). Two bounded
  degradations, both documented in the module: **no dollar cost** (Cursor bills by subscription -
  `cost` is always 0; tokens are exact), and the **chained-builder occupancy valve is inert**
  (Cursor reports usage only on the terminal event, so there is no mid-run occupancy to hard-kill
  against - the cooperative handoff remains the chaining safety, exactly as `agent_cc.py` notes for
  the same case). There is no `--system-prompt` flag, so the agent's system prompt rides *in* the
  prompt; `thinking` is baked into the model id, and `harness_engineering` (pi `-e` extensions) /
  `--tools` filtering do not apply.

**Project guidance reaches every agent.** So an agent working in a *stamped* repo sees that
project's conventions: `pi` discovers `AGENTS.md`/`CLAUDE.md` from cwd natively, and because the
Claude SDK runs in isolation mode (`agent_cc.py` sets `setting_sources: []` - no ambient
CLAUDE.md/skills leaking in), `agents.py::execute` injects the repo-root guidance
(`agents.project_guidance` - `AGENTS.md`, else `CLAUDE.md`) into a `claude_code` agent's system
prompt explicitly. Deterministic and leak-free: exactly one engine-chosen file, nothing else.

**Anthropic is always routed through the SDK.** pi no longer supports Anthropic, so
`agents.py::load_config` **forces `coding_agent: claude_code` for any `anthropic/*` model**,
overriding whatever the roster says - pi only ever runs non-Anthropic models (e.g.
`openai-codex/*`). A roster can't mis-route Anthropic: a stray `coding_agent: pi` on an
`anthropic/*` agent is silently corrected to `claude_code` at load - this beats an explicit
`coding_agent: cursor` too, so to reach Claude *through* Cursor you name a `cursor/claude-*` model,
never `anthropic/*`. Also, `pi` 0.81.1 has no
`~/.pi/agent/models.json`, so `engine/.env` sets `PI_MODELS_PATH` to a committed stub (and
`agent_pi.context_window()` degrades to 0/unknown when even that is absent, e.g. a stamped repo).

### Cockpit (`cockpit/`) - Next.js 14 App Router, observe + control

- **Read path is readonly by construction.** `lib/db.ts` (`AtelierDb`) opens `sssf.db`
  `readonly:true`; `lib/data.ts` memoizes one connection. Rows are Zod-validated at the
  boundary. The live tail uses **rowid-cursor polling** (`/api/runs/[id]/events` +
  `components/run/LiveTail.tsx`); force-dynamic server components re-query sqlite on refresh.
- **Write path is deliberately tiny.** Two surfaces, both outside the trace:
  - *Control plane (Phase 2, + sandboxes Phase 5).* `lib/control.ts` (`AtelierControl`) is a
    *separate* read-write sqlite connection that touches **only** the two control tables,
    `run_queue` and `sandboxes` - it enqueues a launch spec + flips `cancel_requested`, and creates
    a sandbox + flips its `land_requested` / `shutdown_requested`. Every write is an INSERT or a
    flag flip; the worker disposes.
  - *Roster config (Phase 4).* `lib/roster.ts` reads and writes the **file**
    `sssf.config.yaml` (not the db) via `/api/roster`. Edits are **surgical**: it splices only the
    changed value's byte-range in the parsed `yaml` Document (missing keys are inserted as one
    line), so a one-field change is a one-line diff with every hand-aligned comment intact, then
    writes atomically (temp + rename). It never spawns a process and never touches a run's trace -
    the config is data the engine reads, and `agents.py::load_config` re-validates it via Pydantic
    at run time.
- Design system: the "Monolith Signal" tokens (terminal aesthetic) via `components/terminal.tsx`
  and Tailwind `os-*` classes. Navigation is centralized in `lib/nav.ts`.

### The control plane - the determinism spine (do not break)

The cockpit **must never spawn a process** and must never mutate a run's trace or acceptance.
To launch a run it only INSERTs a `run_queue` row; to stop one it only sets `cancel_requested`.
`engine/adws/adw_worker.py` (`just worker`) is the **only** thing that turns a queued row into a
running ADW - and it builds the exact CLI argv a human would type, so a UI-launched run is
byte-for-byte identical to a CLI one (same trace, same acceptance). Cancel = SIGTERM the
process group; the ADW's own signal handler (`session.py::_finalize_when_killed`) closes its
trace. Keep this invariant when extending either side.

**Sandboxes (Phase 5) obey the same spine.** A sandbox is an isolated, persistent git worktree
(on a named branch) that hosts one or more runs; the cockpit only INSERTs a `sandboxes` row or
flips a flag (`land_requested` / `shutdown_requested`), and the **worker** provisions the worktree,
runs the project's `land` hook, and disposes - it never spawns from the cockpit. A sandboxed run is
still spawned through the one `spawn()`, byte-identical argv, with `cwd=<worktree>` and
`SSSF_TRACE_ROOT=REPO_ROOT` so its trace still lands in the shared `sssf.db`. Config lives in the
`sandbox:` block (`SSSFConfig.sandbox`, mirrored in `roster.ts`); details in
[`docs/07-operations.md`](docs/07-operations.md) §5 and [`docs/05-config-and-roster.md`](docs/05-config-and-roster.md) §8.

### The operator skill (`engine/skills/atelier/`) - stamped, MANAGED

`engine/skills/atelier/` is the **operator skill** for driving the factory (run /
create / update ADWs, tune the roster, observe runs) - one `SKILL.md` router plus cookbooks
and references written for the native `adws/` layout. It is the **single source**, and it is
**agent-agnostic**: Claude Code, Codex, and PI all read the same `SKILL.md` format (the "Agent
Skills spec"), they just look in different dirs and each follows symlinks. So the stamp lands
the real files at the vendor-neutral **`.agents/skills/atelier/`** (a first-class path Codex
scans natively) and symlinks that **skill entry** into the other two harnesses' dirs -
**`.claude/skills/atelier` → `../../.agents/skills/atelier`** (Claude Code) and the same into
**`.pi/skills/`** (PI). One tree, three consumers. The links are *per skill entry*, not the whole
dir, so they drop in alongside whatever skills a target already keeps in `.claude/skills` /
`.pi/skills`. `install.py::_ensure_agent_skill_symlinks` creates them idempotently and
conservatively (only links a name that is free, and only for entries that exist under
`.agents/skills`); `update.py` self-heals them and migrates pre-`.agents` stamps (which kept the
skill at `.claude/skills`).
The Atelier checkout mirrors the same scheme (`.agents/skills/atelier` → `engine/skills/atelier`,
with the two vendor symlinks), so `/atelier` and its Codex/PI equivalents work here too.

It is discovered like any managed code - `managed_files()` / `target_rel()` in `install.py` scan
`engine/skills/` and map it under `.agents/skills/` - so it lands in `.atelier/manifest.json` and
`update.py` keeps its docs in lockstep with engine behavior (a hand-edited cookbook is parked as
`<file>.atelier-new`, never clobbered). The skill is **layout-aware**: it detects the source repo
(no top-level `adws/`, but `engine/adws/`) and translates paths. When engine behavior changes in
a way the skill documents (backends, gates, config schema, observability), update
`engine/skills/atelier/` in the same change - it is MANAGED for exactly this reason.

**Keeping the operator skill out of ADW coding agents.** The operator skill is for a human
driving the factory - it must never reach the coding agents the engine spawns. Two guards enforce
this: `agent_cc.py` runs the Claude SDK in isolation (`setting_sources: []`), and `agent_pi.py`
passes **`--no-skills`** (pi otherwise auto-discovers `.pi/skills` from cwd *and* the operator's
`~/.pi/agent/skills`, inhaling the stamped skill into every build). Codex is never a backend, so
it needs no engine-side guard. And **never** surface the skill via `AGENTS.md`/`CLAUDE.md` - that
leaks operator instructions into ADW coding agents through `project_guidance` injection; the
`.agents/skills` + symlink scheme is the supported route, no rules-file pointer needed.

## Writing conventions

- **Dashes:** Never use em dashes (U+2014) or en dashes (U+2013) in code, copy, docs, or commit
  messages. Use a plain hyphen `-` instead.

## Pull requests

- Use the **`gh` CLI** for all GitHub operations - open (`gh pr create`), inspect
  (`gh pr view`), and merge (`gh pr merge`) PRs, rather than the web UI or raw git pushes to a
  protected branch.
- Do **not** include the `🤖 Generated with [Claude Code](https://claude.com/claude-code)`
  line (or similar generated-by footers) in PR descriptions.
- **This repo is squash-only.** Merge commits and rebase merges are **disabled** on GitHub, so
  `gh pr merge --merge` / `--rebase` fail - always `gh pr merge --squash --delete-branch`. The
  branch's per-commit history collapses into **one** commit on `main`, so the **PR title + body
  become that commit's message** - write them as the durable record (the individual branch
  commits do not survive on `main`). Confirm before merging; it is outward-facing.

## Versioning & releases

- **The single version-of-record is `cockpit/package.json`** (`"version"`, SemVer). The engine's
  `engine/adws/pyproject.toml` is a dev-only shim pinned at `version = "0"` and is **not** a release
  version - never bump it. There is **no** top-level `VERSION` file and no `CHANGELOG`.
- **A release is an annotated git tag `vX.Y.Z` on `main`** (`git tag -a`), matching the
  `cockpit/package.json` version. Tags are **repo-wide**, not cockpit-only: a tag legitimately marks
  an engine- or config-only change (e.g. `v0.3.0` carried an engine prompt-path fix), even when no
  cockpit code moved.
- **Not every PR bumps.** Docs-only and dev-infra PRs ship **untagged** (e.g. the test-gates PR).
  Bump + tag when a PR changes **user-facing or functional behavior** - a shipped feature or a fix to
  one. It is a deliberate per-PR call, never automation.
- **Choosing the number** (pre-1.0, so both stay in `0.x`): **patch** (`0.3.0 -> 0.3.1`) for a bug
  fix to shipped behavior; **minor** (`0.3.x -> 0.4.0`) for a new feature. When a PR is bugfix-led
  with a small additive feature riding along, patch is fine - frame by the headline change.
- **Mechanics under squash-only:** bump `cockpit/package.json` **in the same PR** (a
  `chore(release): bump to X.Y.Z` commit) so the version lands in the squash commit; `gh pr merge
  --squash --delete-branch`; then annotate-tag the resulting `main` commit
  (`git tag -a vX.Y.Z -m "<one-line release summary>"`) and `git push origin vX.Y.Z`. Tagging is
  outward-facing - confirm first, same as merging.
- **Every tag also gets a GitHub release** (`gh release create vX.Y.Z --title "vX.Y.Z"
  --notes-file -`), published, never a draft. The notes are written for a reader who was not in
  the conversation - what changed and why it matters, not a commit list - and close with the
  `compare/v<prev>...vX.Y.Z` link. An untagged PR (docs-only, dev-infra) gets no release.

## Commit guidelines

When asked to commit, propose a commit strategy:

1. Run `git diff` to review all unstaged changes
2. Group related changes into logical, atomic commits - each commit should represent a single coherent unit of work
3. For each commit, provide:
   - The conventional commit message (type, optional scope, description) e.g. `feat(payments): add currency validation`
   - The specific files to stage, listed on a single line separated by spaces
   - A one-line rationale for why these changes belong together
4. Order the commits so that each one leaves the codebase in a working state
5. Prefer smaller, focused commits over large ones - split when changes serve different purposes even if they touch the same file

Conventional commit types: `feat`, `fix`, `refactor`, `test`, `docs`, `style`, `chore`, `perf`, `ci`, `build`

Do NOT include any `Co-Authored-By` footer.

Atomic per-commit history serves **review on the PR** - it is squashed away on merge (see Pull
requests above), so `main` keeps only the squash commit built from the PR title + body.

## Git & path layout (easy to get wrong)

`engine/` is **not** a nested repo - it shares this single git root. SSSF anchors on the git
root (pi's `-e` paths, the write-boundary diff, and commit phases resolve there), so
`repo_root()` is the atelier root and **the factory can build itself** (guarded by
`protected_files` in the config). Consequences:
- **Run ADWs from the repo root**, e.g. `uv run engine/adws/adw_prompt.py --config engine/adws/…`.
- Every engine config path is `engine/`-prefixed **except `writes:` allowlists**, which are
  **repo-root-relative** (they match where agents actually write: `specs/`, `docs/`, etc.).

## Config & environment

- Roster/models/prompts/tool+write boundaries live in
  `engine/adws/adw_sssf_config/sssf.config.yaml`. `SSSF_CONFIG` swaps the whole roster for a run.
- `engine/.env` (gitignored) - engine env incl. `PI_MODELS_PATH`.
- `cockpit/.env.local` (gitignored) - `SSSF_DB`, an absolute path to the shared `sssf.db`.
- `sssf.db` itself is gitignored; never commit it.
