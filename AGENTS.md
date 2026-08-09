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
| **Verify the seam contract** | `cd cockpit && pnpm check:contract` |
| Production build | `cd cockpit && pnpm build` |

There is **no unit-test suite and no linter** - `pnpm typecheck` and `pnpm check:contract` are
the automated gates. You verify behavior by kicking a real ADW and reading its trace (this
calls a model and costs a few cents). Each ADW is a self-contained PEP 723 `uv` script (deps
in the file header), so `uv run` needs no separate install; the cockpit needs `pnpm install`.

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

### Two coding-agent backends (config key `coding_agent:`)

`agents.execute()` treats both identically behind one abstraction:
- `pi` → `agent_pi.py`, drives GPT-5.6 etc. via the `pi` CLI (auth in `~/.pi/agent`).
- `claude_code` → `agent_cc.py`, drives Claude via `claude-agent-sdk` using the local `claude`
  CLI's own login (**no API key**). `agent_cc.run` mirrors `agent_pi.run`'s contract exactly.

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
`anthropic/*` agent is silently corrected to `claude_code` at load. Also, `pi` 0.81.1 has no
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

`engine/skills/atelier/` is the Claude Code **operator skill** for driving the factory (run /
create / update ADWs, tune the roster, observe runs) - one `SKILL.md` router plus cookbooks
and references written for the native `adws/` layout. It is the **single source**: the Atelier
checkout exposes it as `.claude/skills/atelier` (a symlink → `engine/skills/atelier`, so
`/atelier` works here too), and `install.py` **stamps a copy into each target's
`.claude/skills/atelier/`**. It is discovered like any managed code - `managed_files()` /
`target_rel()` in `install.py` now scan `engine/skills/` and map it under `.claude/skills/` -
so it lands in `.atelier/manifest.json` and `update.py` keeps its docs in lockstep with engine
behavior (a hand-edited cookbook is parked as `<file>.atelier-new`, never clobbered). The skill
is **layout-aware**: it detects the source repo (no top-level `adws/`, but `engine/adws/`) and
translates paths. When engine behavior changes in a way the skill documents (backends, gates,
config schema, observability), update `engine/skills/atelier/` in the same change - it is
MANAGED for exactly this reason. Other agent harnesses (codex/cursor/pi) don't scan
`.claude/skills/`; surface the skill to them via their own rules file pointing at
`.claude/skills/atelier/SKILL.md`, **not** by copying it and **not** via `AGENTS.md`/`CLAUDE.md`
(that leaks operator instructions into ADW coding agents through `project_guidance` injection).

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
