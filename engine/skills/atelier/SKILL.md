---
name: atelier
description: >-
  Operate the Atelier software factory (the ADW engine stamped into this repo's adws/).
  Use when the user says /atelier, wants to create / run / update an ADW or workflow,
  manage the agent roster in sssf.config.yaml, keep the engine current, or observe running
  agent workflows. Keywords - atelier, software factory, ADW, AI developer workflow, agent
  pipeline, run the factory, agent roster.
argument-hint: "[run adw | create adw | update config | keep current | observe | ...]"
---

# Atelier — operate the factory

Reusable combination of **agents plus code**: deterministic Python ADW scripts own
sequencing, retries, and acceptance; coding agents work inside bounded phases; typed JSON
envelopes carry context between them; everything streams into SQLite for the cockpit to read.
**Agent proposes, code disposes.**

The engine lives in this repo's `adws/`, stamped there by Atelier and sharing this repo's git
root — so ADWs run as `uv run adws/adw_*.py` from the repo root, and the config, prompts, and
trace all live under `adws/`. The **cockpit** (the trace UI) is Atelier's *central* Next.js
app: one app observes many stamped repos, so nothing Next.js is stamped per repo — you point
the cockpit at this repo instead (see below).

> **Layout.** Every path below uses the stamped layout, `adws/…`. The one exception is the
> **Atelier source repo itself** (where this skill is authored): there the engine sits at
> `engine/adws/…` and ships a repo-root `justfile` with the same recipes, so run
> `uv run engine/adws/adw_*.py` and read `engine/adws/adw_sssf_config/sssf.config.yaml`. If a
> top-level `adws/` is absent but `engine/adws/` is present, you are in the source repo —
> translate `adws/` → `engine/adws/` throughout and carry on.

## Startup

Three steps. Then stop.

1. Read [cookbooks/sssf_overview.md](cookbooks/sssf_overview.md) — the system map.
2. `ls adws/adw_*.py` (or `engine/adws/adw_*.py` in the source repo) and read each file's
   `Phases:` docstring line.
3. Print the ADWs as a table — name, the chain, one line on when to reach for it — and **wait
   for the engineer's request.**

```
| ADW | Chain | Use when |
|---|---|---|
| adw_scout | engineer → scout | read-only recon; nothing changes |
| adw_simple_sdlc | plan → build → test → review → document, 3 commits | the work is real and its shape is not obvious |
```

**Nothing else.** No trace-db queries, no reading the config or the ADW scripts' bodies, no
repo inventory, no last-runs summary, no diagnosing an old failure, no "current state"
dashboard. None of it was asked for, and it is not free:

- **Volunteered state is guessed state.** An orchestrator that improvised a status board
  queried a `runs` table and a `payload` column — neither exists (`sessions`, `payload_json`).
  The spec that would have said so is `references/observability.md`, one lazy read away.
  Probing to look prepared is how you end up confidently wrong in your first message.
- **It spends the context the real task needs**, before you know what the task is.
- **It is stale on arrival.** State printed before the request describes a system that the
  very next run changes.

Everything else — the db schema, the roster, the handoff contract — is lazy-loaded through the
routing table below, when a request actually calls for it. Reading it early defeats the
mechanism.

Two exceptions, both narrow: if the engineer's first message already contains a request, skip
the waiting and route it; and if the factory is plainly not installed (neither
`adws/` nor `engine/adws/`, no config), say that in one line instead of the table.

## Orchestrator rules

You run the system, observe the system, and help the user interact with it. **You do no ADW
work yourself:**

- Never implement, plan, or test in an agent's place — launch the ADW and watch it.
- Never edit files inside `adws/adw_data/sessions/` — that is the run record.
- Observe by querying `adws/adw_data/sssf.db` (WAL — reads never block writers) **when
  observing is the task**. This is a capability, not a startup step: query it to follow a run
  you launched or one the engineer asked about, never to volunteer a status report nobody
  requested. The quick peeks are `just sessions` · `just phases <adw_id>` · `just tail
  <adw_id>` · `just procs <adw_id>` · `just queue`; the full trace UI is the central cockpit.
- Report phase status plainly: name, owner, status, error if any.

## Request routing (lazy-load the cookbook, then follow it)

| Request | Cookbook |
|---|---|
| keep this repo's engine current · how the stamp/update works | [cookbooks/install.md](cookbooks/install.md) |
| create a new ADW / workflow | [cookbooks/create_adw.md](cookbooks/create_adw.md) |
| modify an existing ADW chain | [cookbooks/update_adw.md](cookbooks/update_adw.md) |
| create the config / agent roster | [cookbooks/create_config.md](cookbooks/create_config.md) |
| add or retune an agent (model, thinking, tools, prompts) | [cookbooks/update_config.md](cookbooks/update_config.md) |
| extend adw_modules with new low-level logic | [cookbooks/update_modules.md](cookbooks/update_modules.md) |
| run / monitor an ADW | [cookbooks/how_to_prompt_for_the_eng.md](cookbooks/how_to_prompt_for_the_eng.md) **first**, then [cookbooks/run_adw.md](cookbooks/run_adw.md) |
| turn a request into an ADW prompt | [cookbooks/how_to_prompt_for_the_eng.md](cookbooks/how_to_prompt_for_the_eng.md) |
| create / land / shut down an isolated sandbox workspace, or run an ADW in one | [cookbooks/sandboxes.md](cookbooks/sandboxes.md) |

Deep specs, when needed: [references/config.md](references/config.md) ·
[references/handoff.md](references/handoff.md) ·
[references/observability.md](references/observability.md)

## Hard rules (enforced across everything the factory generates)

1. **Validate before running** — every ADW declares `REQUIRED_AGENTS` and calls
   `agents.validate()` first; a missing/misnamed agent fails before anything spawns.
2. **Typed outputs only** — every agent call pairs with a concrete `EnvelopeBase` subclass in
   `adw_modules/data_types.py`; parse failures re-prompt the same session (context intact),
   never restart.
   **The output contract is a synced triad**: (a) the type in `data_types.py`, (b) the JSON
   example in the agent's `user.md` `## Report` section, (c) `output_type=` at every call
   site. These are ONE contract — change any one, update all three in the same edit (grep the
   type name to find every call site).
3. **Gates validate claims, not guesses** — `gate(envelope, run) -> list[str]` violations;
   failures return to the same session as corrections.
4. **Four-param rule** — any function with more than 4 parameters takes one concrete data type
   instead (`AgentCall`, `PhaseParams` are the pattern).
5. **One agent, one prompt, one purpose** — identity lives in `system.md`; task shape (user
   prompt + output type) lives at the call site.
6. **ADW scripts stay thin** — all low-level logic lives in `adw_modules/`.
7. **Every phase earns a description** — one sentence on what it does and why, never a
   restatement of its name. It is the only intent the trace, the console, and the UI ever
   show; `commit_plan: "Commit the plan"` is rejected at construction, blank is too.
8. **A known command is code, not an agent** — if you can write the invocation down (`bun
   test`, `ruff check`), it belongs in a `kind="code"` phase via `adw_modules/quality.py`.
   Agents are for the parts that need reading and deciding; failures come back to the builder
   as an envelope either way.
9. **`tools:` is a capability list, `writes:` is the boundary** — `bash` runs anything
   (including `git checkout`) and `write` reaches any path, so a tool list can never make
   "this agent changes nothing" true. `writes:` per agent and `protected_files` in defaults
   are enforced in `adw_modules/permissions.py` after every agent call: unauthorized changes
   are rolled back and the phase dies. The session runtime under `adw_data/` is always
   writable — a read-only agent is read-only with respect to the REPO, never mute.
10. **Every ADW ends in `run.finish()`** — phases passing is not the same as the run being
    accepted. A test phase that ran a red suite succeeded at its job. Pass `accepted=` so the
    exit code, the session status, and the banner are decided together and cannot disagree.

## Backends & the cockpit

Three coding-agent backends sit behind one abstraction (`coding_agent:` in the roster);
`agents.execute()` treats them identically:

- **`claude_code` is the default.** It drives Claude via `claude-agent-sdk` using your local
  `claude` CLI login — **no API key**. The starter roster runs on `anthropic/claude-sonnet-5`.
  The SDK runs in isolation (`setting_sources: []`), so the engine injects this repo's
  root-level `AGENTS.md` (else `CLAUDE.md`) into each claude_code agent's system prompt — that
  is how the agent sees *this project's* conventions.
- **`pi`** drives non-Anthropic models (e.g. `openai-codex/*`) via the `pi` CLI. It discovers
  `AGENTS.md`/`CLAUDE.md` from cwd natively.
- **`cursor`** drives Cursor's models via the `cursor-agent` CLI (`cursor-agent login` — **no API
  key**), proxying Anthropic/OpenAI/Grok/Kimi/Composer. Model ids use the `cursor/` namespace
  (`cursor/auto`, `cursor/claude-opus-4-8-thinking-high`). Bounded degradations: cost is always
  `$0` (subscription billing) and the context-window valve is inert (cooperative handoff only);
  `thinking`/`harness_engineering` do not apply.
- **Anthropic is always claude_code.** `agents.py::load_config` forces `coding_agent:
  claude_code` for any `anthropic/*` model, overriding even an explicit `coding_agent: pi` **or
  `cursor`** — pi no longer supports Anthropic. A roster cannot mis-route it; reach Claude through
  Cursor with a `cursor/claude-*` model, not `anthropic/*`.

The UI is the **central Atelier cockpit**, not a per-repo app. To watch this repo, add it to
the cockpit's `atelier.projects.json`:
`{ "id": "<slug>", "name": "<Name>", "root": "<abs path to this repo>", "adwsSubdir": "adws" }`.
Until then, `just sessions/phases/tail/procs` and raw `sqlite3 adws/adw_data/sssf.db` are the
terminal window into any run. To keep the engine itself current, see
[cookbooks/install.md](cookbooks/install.md).
