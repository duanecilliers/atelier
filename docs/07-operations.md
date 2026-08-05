# Operations & commands

This is the day-to-day operator's reference: how to run, observe, and control the factory once
you already have the mental model from [README.md](../README.md) and
[01-architecture.md](01-architecture.md) — agents propose, deterministic code disposes, and the
seam is `engine/adws/adw_data/sssf.db`. The golden rule that trips people up: run **engine**
commands from the repo root (`/Users/duane/Dev/atelier`); run **cockpit** commands from
`cockpit/`. Every path below assumes you're standing in the right one.

## 1. Command reference

### 1a. Engine — from the repo root

All recipes live in the repo-root `justfile`. `just` loads `engine/.env` first
(`set dotenv-path := "engine/.env"`), and two computed vars back every recipe: `config` (defaults
to `engine/adws/adw_sssf_config/sssf.config.yaml`, overridable via `SSSF_CONFIG`) and `db`
(hardcoded to `engine/adws/adw_data/sssf.db` — the sqlite peeks below always target this path
regardless of `SSSF_DB`).

| Task | Command | What it runs |
|---|---|---|
| List all recipes | `just` | `just --list` |
| Demo (first run) | `just demo` | `adw_prompt` (agent `scout`, one-line repo summary) then `adw_scout` (read-only recon), both against `{{config}}` |
| One agent, one prompt | `just prompt "<text or path>"` | `uv run engine/adws/adw_prompt.py --config {{config}} "$@"` |
| Read-only recon | `just scout "<question>"` | `uv run engine/adws/adw_scout.py --config {{config}} "$@"` |
| Plan only | `just plan "<ask>"` | `uv run engine/adws/adw_plan.py --config {{config}} "$@"` |
| Plan + build + commit | `just plan-build "<ask>"` | `uv run engine/adws/adw_plan_build.py --config {{config}} "$@"` |
| Plan + build + test + commit | `just sdlc "<ask>"` | `uv run engine/adws/adw_plan_build_test.py --config {{config}} "$@"` |
| Full chain + review + docs | `just simple-sdlc "<ask>"` | `uv run engine/adws/adw_simple_sdlc.py --config {{config}} "$@"` |
| Drain the launch queue | `just worker` (or `just worker --concurrency N`) | `uv run engine/adws/adw_worker.py --config {{config}} "$@"` — the **only** thing that turns a queued `run_queue` row into a live ADW subprocess |
| Peek: what's queued/running | `just queue` | `select id, status, adw_name, agent, request, adw_id from run_queue order by id desc limit 15;` |
| Peek: last 10 runs | `just sessions` | `select adw_id, status, request, total_tokens, total_cost from sessions order by started_at desc limit 10;` |
| Peek: phase status for a run | `just phases <adw_id>` | `select seq, name, kind, owner, status, attempt from phases where adw_id='<adw_id>' order by seq;` |
| Peek: live event tail | `just tail <adw_id>` | `select rowid, type, name, started_at from events where adw_id='<adw_id>' order by rowid desc limit 25;` |
| Peek: live processes for a run | `just procs <adw_id>` | `select kind, name, pid, command, started_at from processes where adw_id='<adw_id>' and ended_at is null order by id;` |

You can also skip `just` entirely and kick an ADW directly:

```
uv run engine/adws/adw_prompt.py --config engine/adws/adw_sssf_config/sssf.config.yaml "<prompt>"
```

The general CLI contract (spelled out fully in §3):

```
uv run engine/adws/adw_prompt.py "<prompt or path/to/prompt.md>" [--agent builder]
    [--config engine/adws/adw_sssf_config/sssf.config.yaml] [--adw-id a1b2c3d4]
```

- The positional prompt is either inline text or a path — `resolve_prompt()` reads the file if it
  exists.
- `--agent` defaults to `builder` and is only meaningful for `adw_prompt` (one agent, one
  prompt); the multi-agent ADWs (`scout`, `plan`, `plan_build`, …) own their own roster sequence
  and don't take it.
- `--adw-id` joins an existing session instead of minting a new one.
- Each ADW is a self-contained PEP 723 `uv` script (deps declared in its own header), so `uv run`
  needs no separate install step. See [04-authoring-adws.md](04-authoring-adws.md) for the ADW
  catalog and how to author a new one.

### 1b. Cockpit — from `cockpit/`

| Task | Command | What it does |
|---|---|---|
| Install deps | `pnpm install` | Installs `cockpit/` node_modules |
| Dev server | `pnpm dev` | `next dev -H 127.0.0.1 -p 4200` → http://127.0.0.1:4200 |
| Typecheck | `pnpm typecheck` | `tsc --noEmit` |
| Verify the seam contract | `pnpm check:contract` | `tsx scripts/check-contract.ts` — asserts every column the cockpit's Zod schemas expect exists in the **live** db at `SSSF_DB` |
| Production build | `pnpm build` | `next build` |
| Production start | `pnpm start` | `next start -p 4200` |

There is **no unit-test suite and no linter** in this repo — `pnpm typecheck` and
`pnpm check:contract` are the only automated gates. Beyond those, you verify behavior by kicking
a real ADW and reading its trace (this calls a model and costs a few cents). See
[06-cockpit.md](06-cockpit.md) for the cockpit's read/write surfaces in depth.

## 2. Kicking a run

There are two ways to start an ADW, and they end up byte-identical on the wire (§4).

### Directly

```
uv run engine/adws/adw_prompt.py --config engine/adws/adw_sssf_config/sssf.config.yaml "<prompt>"
```

Runs synchronously in your terminal. Good for iterating on a single ADW or prompt.

### Via the queue (cockpit → worker)

This is the only way the cockpit ever causes an ADW to run — it never spawns a process itself.

1. **Enqueue** — `POST /api/queue` with a body matching `EnqueueSpecSchema`:

   ```jsonc
   { "adw_name": "adw_scout", "request": "…", "agent": null, "config": null, "requested_by": null }
   ```

   `adw_name` must name a script that actually exists on disk (checked against the same dynamic
   allowlist the worker re-validates). The handler inserts one `run_queue` row with
   `status='queued'` and returns `{ id, adw_id }` (201) — the `adw_id` is minted at enqueue time,
   so the cockpit can deep-link to the run before it has even started. `GET /api/queue` lists the
   whole table.

2. **Drain** — a separately running `just worker` (or `uv run engine/adws/adw_worker.py …`)
   process claims the row, builds the CLI argv, and spawns the ADW subprocess. See §3 for the
   full drain loop.

3. **Cancel** — `POST /api/queue/[id]/cancel` unconditionally sets `cancel_requested=1` (the
   durable backstop the worker polls). If the row is still `queued` (never claimed), it also
   flips straight to `canceled` so the worker's claim query — which only selects
   `status='queued'` — never picks it up, and no process is ever spawned for it. Returns 409 if
   the row is unknown or already terminal (`done`/`failed`/`canceled`).

See [06-cockpit.md](06-cockpit.md) for the full HTTP face and [04-authoring-adws.md](04-authoring-adws.md)
for the catalog of ADWs you can name in `adw_name`.

## 3. The worker & `run_queue` lifecycle

`run_queue` states: `queued` → `claimed` → `running` → one of `done` / `failed` / `canceled`. A
row is `claimed` only for the instant between winning it off the queue and `Popen` succeeding —
a crash there is visible rather than silently losing the row.

Invocation: `uv run engine/adws/adw_worker.py [--config <cfg>] [--concurrency N] [--poll 1.0]
[--once]`. Defaults: `--concurrency 2`, `--poll 1.0`s, `--config
engine/adws/adw_sssf_config/sssf.config.yaml`. Must be run from the repo root — same cwd every
ADW expects.

`drain()` loops:

1. **Reap** finished runs — poll each live job's `Popen`. If it exited while `canceling` was set
   → mark `CANCELED`; `rc==0` → `DONE`; else `FAILED` with `error = "exit {rc}"` or
   `"signal {-rc}"` for a negative rc.
2. **Cancel handling** — for each live job not already canceling, if
   `cancel_requested(conn, queue_id)` is true, set `canceling=True`, start a 12s grace window, and
   `SIGTERM` the **whole process group** (`os.killpg`). If already canceling and the grace
   deadline has elapsed, `SIGKILL` the group instead. This works because every job is spawned with
   `start_new_session=True`, making the child (`uv run …`) the leader of its own process group —
   so the signal reaches the ADW **and its agent subprocesses**, not just the `uv` wrapper. The
   ADW's own signal handler closes its trace cooperatively (see
   [02-engine-runtime.md](02-engine-runtime.md) for `session.py::_finalize_when_killed`), which is
   why SIGTERM is tried first, with the grace window before the hard kill.
3. **Fill free slots** — while fewer jobs than `--concurrency` are live, claim the next queued row
   and spawn it. If `build_argv` can't resolve the `adw_name` to a script on disk, the row is
   marked `FAILED` immediately with no process spawned.
4. **Exit conditions** — if stopping and no jobs remain, shut down cleanly. If `--once` and the
   queue is drained, exit without idling (it won't loop re-claiming, which would strand a row).
   Otherwise sleep `--poll` seconds and loop again.

Signals to the worker process itself: `SIGINT`/`SIGTERM` first set `stopping=True` (no new
claims, wait for in-flight jobs); a **second** signal force-`SIGKILL`s every still-live job's
process group and exits with code 130.

**The determinism guarantee:** `build_argv` constructs the exact CLI a human would type:

```python
argv = ["uv", "run", str(script), "--config", config, "--adw-id", row["adw_id"]]
if adw_name == "adw_prompt" and row["agent"]:
    argv += ["--agent", row["agent"]]
argv += ["--", row["request"] or ""]
```

So a UI-launched run is byte-for-byte identical to a CLI one — same trace, same acceptance. Keep
this invariant when extending either side.

## 4. Environment variables

### Engine

Loaded via `python-dotenv`'s `load_dotenv()`, which picks up `.env` in the process cwd —
`engine/.env` when run from the repo root per the justfile's `dotenv-path`.

| Variable | Purpose | Default if unset |
|---|---|---|
| `PI_PATH` | Path to the `pi` CLI binary | `"pi"` (resolved via `PATH`) |
| `PI_MODELS_PATH` | Path to pi's `models.json`; read unconditionally before falling back to `pi --list-models`. Set in `engine/.env` to the committed stub `engine/pi-models.json`, since pi 0.81.1 ships no `~/.pi/agent/models.json` | `~/.pi/agent/models.json` |
| `ENGINEER_NAME` | Label for the "engineer" lane/actor in the trace | `git config user.name`, then `$USER`, then literal `"engineer"` |
| `SSSF_ADWS_DIR` | Overrides where a newly authored `adw_<name>.py` is written | `engine/adws/` |
| `OPENROUTER_API_KEY`, `FIREWORKS_API_KEY`, `OPENAI_API_KEY` | Provider auth `pi` itself reads per `~/.pi/agent/models.json` — which one you need depends on the `provider/model-id` strings named in the roster's `model:` fields | none (set by hand if that provider is used) |
| `VIRTUAL_ENV` / `PATH` | `operator_env()` **pops** `VIRTUAL_ENV` and strips its `bin/` from `PATH` so subprocesses (bash tool calls, git, etc.) see the operator's real global CLIs, not `uv run`'s ephemeral dependency venv | n/a |

No API key env var is required for the `claude_code` coding-agent backend — it authenticates via
the local `claude` CLI's own login, not an API key.

### Cockpit

Read via `process.env.*`; only `cockpit/.env.local` exists (no example file).

| Variable | Purpose | Default if unset |
|---|---|---|
| `SSSF_DB` | Absolute path to the shared `sssf.db` — readonly for the data reads, read-write for the control connection's `run_queue` writes | `<cwd>/../engine/adws/adw_data/sssf.db`, relative to `cockpit/` |
| `SSSF_CONFIG` | Path to `sssf.config.yaml` the roster editor UI reads/writes | the sibling engine file |
| `SSSF_ADWS_DIR` | Directory the Skills Cookbook / ADW-builder page reads `adw_*.py` scripts from (ignored when writing a *new* ADW) | `engine/adws/` (relative default) |
| `SSSF_PE_DIR` | Prompt-engineering directory override, paired with the roster config | matching relative default |

`cockpit/.env.local` (gitignored, present locally) currently sets only:

```
SSSF_DB=/Users/duane/Dev/atelier/engine/adws/adw_data/sssf.db
```

### `.env` file inventory

| File | Tracked? | Contents |
|---|---|---|
| `engine/.env` | No | `PI_MODELS_PATH=...`; a comment noting the roster runs on pi's own authed providers, so no provider keys are needed there |
| `engine/.env.sample` | Yes | Documents `OPENROUTER_API_KEY`, `FIREWORKS_API_KEY`, `OPENAI_API_KEY`, plus optional `PI_PATH` / `PI_MODELS_PATH` / `ENGINEER_NAME` overrides |
| `cockpit/.env.local` | No | `SSSF_DB=<absolute path>` |
| `cockpit/.env.example` | Does not exist | — |
| `engine/.env.example` | Does not exist (only `.env.sample`) | — |

## 5. Self-build guardrails & git/path layout

Atelier has one git root — `engine/` is not a nested repo. `repo_root()` resolves to the atelier
root regardless of where an ADW script physically lives, which is what lets the factory build
itself. Consequences:

- Run ADWs **from the repo root**: `uv run engine/adws/adw_prompt.py --config
  engine/adws/adw_sssf_config/sssf.config.yaml "…"` — every path inside `sssf.config.yaml` is
  `engine/`-prefixed to match.
- `adw_worker.py` explicitly launches subprocesses with `cwd=REPO_ROOT` — the same cwd contract
  as a human typing the command from the root.
- The one exception: `writes:` allowlists in `sssf.config.yaml` are **repo-root-relative**, not
  engine-relative (e.g. `specs/`, `docs/`) — they match where agents actually write, since
  `cwd = repo_root()` when an agent's bash/write tools resolve a relative path. Every other config
  path is `engine/`-prefixed.

`protected_files` (`sssf.config.yaml`) lists `engine/adws/adw_modules/`,
`engine/adws/adw_sssf_config/`, and `engine/adws/adw_*.py` — off-limits to any agent unless that
agent's own `writes:` list names them explicitly. The rationale: an agent must not be able to
edit the machinery that decides whether its own work passed. Enforcement is deterministic and
after-the-fact (snapshot the tree before a phase, diff it after, roll back and raise on any
unpermitted change) — see [03-agents-and-gates.md](03-agents-and-gates.md) for how gates and
permission enforcement fit together.

**Machine gotcha:** pi's Anthropic OAuth is expired on this machine, so `pi` can currently only
drive `openai-codex/*` models here — routing an `anthropic/*` model through `coding_agent: pi`
fails. That's why `claude_code`-backed agents (via `claude-agent-sdk`) exist as the second
backend, using the local `claude` CLI's own login instead of an API key.

## 6. What's ephemeral vs. tracked

Gitignored (never commit):
- `engine/adws/adw_data/sessions/` — per-run session directories.
- `engine/adws/adw_data/sssf.db*` — the live trace database and its `-wal`/`-shm` sidecars.
- `engine/.env` — real secrets/overrides.
- `cockpit/.env.local` — the real `SSSF_DB` override.
- `specs/` (root-level) — the planner agent's `writes:` target, so planner output never lands in
  git by default.

Tracked source worth knowing about:
- `engine/adws/adw_sssf_config/sssf.config.yaml` — the roster config itself.
- `engine/.env.sample` — the committed template for `engine/.env`.
- `engine/pi-models.json` — the committed stub `PI_MODELS_PATH` points at.
- `engine/adws/adw_modules/*.py`, `engine/adws/adw_*.py` — the schema-defining and ADW source,
  itself inside a `protected_files` entry.

**Never commit `sssf.db`.**

## 7. Testing writes in isolation

To exercise config or ADW-authoring writes without touching your live tree: copy the `adw_*.py`
scripts you're testing into a temp directory, then run the cockpit against that copy with env
overrides on an alternate port:

```
SSSF_ADWS_DIR=/tmp/adws-scratch SSSF_DB=/tmp/adws-scratch/sssf.db pnpm dev -p 4201
```

This points the ADW-builder/skills surfaces and the db connection at the scratch directory
instead of `engine/adws/`, so nothing you do in the UI touches the real roster, real trace, or
real `adw_*.py` files.

## Extending this subsystem

Most day-to-day operational changes are covered above: a new `just` recipe is a new stanza in the
repo-root `justfile` following the existing `uv run engine/adws/adw_*.py --config {{config}} "$@"`
pattern; a new environment variable just needs a read site plus an entry in the tables above (and,
for cockpit-side vars, a mention in `cockpit/.env.local`). For adding a new ADW, a new agent, a new
gate, or a new cockpit page, see [08-extending-the-system.md](08-extending-the-system.md).
