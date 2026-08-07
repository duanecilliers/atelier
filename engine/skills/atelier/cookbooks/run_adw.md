# Run ADW

Run a workflow and report on it. **You run and observe — you never step into the process or do the work yourself.**

## Step 0 — translate the request

**Read [how_to_prompt_for_the_eng.md](how_to_prompt_for_the_eng.md) before you launch anything.** The prompt you pass is read by every agent in the chain, so it gets written deliberately: same intent, sharper words, verified paths, and a stated "done means". That cookbook is the whole procedure; this one starts once you have the prompt.

## The orchestrator's posture

The ADW is the worker. Your job is to launch it, watch the trace, and tell the engineer what happened. Do not read the agent's target files and "help", do not fix the code an agent was supposed to fix, do not edit an envelope. If a run fails, report the failing phase and its violations — the fix is a config, prompt, or ADW change, made deliberately, and then a re-run.

## Launch

Which chain to launch is decided in `how_to_prompt_for_the_eng.md`, and the short version is: **the ADW the engineer named, or else the most complete composed chain the work justifies — never a single-agent one.** Read `ls adws/adw_*.py` and the `Phases:` line in each docstring to see what this repo has; the names below are shape, not a menu.

There are two ways to start a run, and they land in the same place:

- **Direct CLI** — you invoke the ADW yourself. This is the day-to-day path.
- **Enqueue → worker** — a `run_queue` row is inserted (by the cockpit, or by hand) and `just worker` (`adws/adw_worker.py`) turns it into a live subprocess. The worker builds the exact CLI a human would type, so a queued run is **byte-for-byte identical** to one you launch directly — same trace, same acceptance. The cockpit never spawns a process itself; enqueuing is all it does, and the worker is the only thing that promotes a queued row to a running ADW.

```bash
uv run adws/<end-to-end-chain>.py "add a /health endpoint"
uv run adws/<plan-build-verify-chain>.py requests/health.md
uv run adws/<build-first-chain>.py "implement the plan" --adw-id a1b2c3d4
uv run adws/<recon-chain>.py "where is auth handled" --config path/to/other.config.yaml
```

The prompt is inline text or a file path. Launch in the background so you can poll while it works; the `adw_id` is printed on startup — capture it, everything else keys off it.

To run inside an **isolated worktree** instead of the repo root, enqueue the run bound to a sandbox (`sandbox_id`) — the worker spawns it with `cwd=<worktree>` and the trace still lands in the shared db. See [sandboxes.md](sandboxes.md).

### Listen for the roster

The chain says *what runs*; the config says *who runs it*. **If the engineer references a roster, a config, or a model tier, pass it — do not fall through to the default.**

```bash
ls adws/adw_sssf_config/*.config.yaml    # every roster on disk
head -3 adws/adw_sssf_config/*.config.yaml   # each file's header comment — the names it answers to
```

Read the roster's own agent block to see who runs it and on what model:

```
adws/adw_sssf_config/sssf.config.yaml
    planner     anthropic/claude-sonnet-5
    builder     anthropic/claude-sonnet-5 (inherited)
adws/adw_sssf_config/sssf.frontier.config.yaml
    planner     anthropic/claude-opus-4-8
```

Read those from disk every time. Rosters are the engineer's to add, rename, and retune, so a name you remember from a doc is a guess.

They will rarely say `--config`. Treat any of these as naming a roster, then resolve it to a file:

| What they say | What it means |
|---|---|
| "run it on the frontier config", "use the frontier roster" | the roster file whose name matches |
| "run this with the big models", "use the sota roster" | the non-default roster — confirm which if there is more than one. Each config's header comment lists the names it answers to, so `head -3` on the file settles it |
| "have opus plan this one" | a roster whose planner is that model; if none exists, say so rather than editing the config mid-request |
| nothing about models at all | the default, `adws/adw_sssf_config/sssf.config.yaml` |

`--config` takes the path directly; the justfile recipes read `SSSF_CONFIG` instead:

```bash
uv run adws/<chain>.py "<prompt>" --config adws/adw_sssf_config/sssf.frontier.config.yaml
SSSF_CONFIG=adws/adw_sssf_config/sssf.frontier.config.yaml just <recipe> "<prompt>"
```

Two things that bite:

- **Never swap rosters on your own.** A different roster is a different cost and a different result. If the default's model looks wrong for the work, say so and let the engineer choose.
- **Switching rosters mid-session breaks resumption.** `agent_map.json` records the agent and model each coding-agent session was created with, so a joined run (`--adw-id`) whose config now names a different model starts that agent **fresh** instead of resuming its context window. That is deliberate — a bad resume is worse — but it means "plan on the frontier roster, then build on the default" costs the builder its accumulated context. Say so when you report it.

`--adw-id` is optional on **every** ADW. Given one, the run joins that session if it exists or creates it pinned to exactly that id: same `sessions/{adw_id}/` dirs, same `context_handoff/`, envelopes appended, and each agent resumes its existing coding-agent context window via `agent_map.json`. That is how you chain ADWs — plan under one id, then build under the same id.

## Observe

The trace db is `adws/adw_data/sssf.db`. It is WAL, so reads never block the running writers — poll it as often as you like.

```bash
# where the run stands
sqlite3 adws/adw_data/sssf.db \
  "select seq, name, kind, owner, status, attempt from phases where adw_id='a1b2c3d4' order by seq;"

# the live tail — cursor on rowid, same query the cockpit polls
sqlite3 adws/adw_data/sssf.db \
  "select rowid, type, name, started_at from events where adw_id='a1b2c3d4' and rowid > 0 order by rowid limit 50;"

# why a phase failed
sqlite3 adws/adw_data/sssf.db \
  "select attempt, gate, passed, checks_json from gate_results where adw_id='a1b2c3d4';"

# session-level status
sqlite3 adws/adw_data/sssf.db \
  "select adw_id, request, status, total_tokens from sessions order by started_at desc limit 5;"

# what an agent actually did, slowest tool calls first
sqlite3 adws/adw_data/sssf.db \
  "select name, tokens, started_at, ended_at from events
   where adw_id='a1b2c3d4' and type='tool_call' order by ended_at desc limit 20;"
```

Poll on a cursor: keep the highest `rowid` you have seen and query `where rowid > ?`. Don't re-read the whole table each pass.

The `just` recipes wrap these same queries for a quick terminal peek: `just sessions`, `just phases <adw_id>`, `just tail <adw_id>`, `just procs <adw_id>`, `just queue`.

`tool_call` rows carry a real span, so durations come off the columns — see `references/observability.md` for which fields each event type populates.

The ADW also narrates to stdout, and every line it prints is written to the db as a `log` event — terminal and swim lane tell the same story by construction, so tailing the background process is a valid second view rather than a competing source of truth.

Files are the raw record if you need more than the db shows: `adws/adw_data/sessions/{adw_id}/{agent}/raw_output.jsonl` (full coding-agent stream), `envelope.json` (the parsed final response), `prompts/` (exactly what was sent), and `context_handoff/` (what agents wrote for each other).

## When a run is stuck

A hung coding agent produces no events at all, so the trace goes quiet rather than red. Read it in this order:

```bash
just phases <adw_id>     # which phase is still `running`
just procs <adw_id>      # what that phase is actually running, with pids
```

`processes` rows with `ended_at IS NULL` are the live ones. If `procs` shows a coding-agent child but the phase has produced no `tool_call` events and its `raw_output.jsonl` is empty, the agent never got started properly — check the model resolves and that nothing is blocking the subprocess, rather than waiting it out.

To stop a run: if it came off the queue, the cockpit's cancel sets `cancel_requested` on the `run_queue` row and the worker SIGTERMs the process group. For a run you launched directly, SIGTERM its process group yourself (`kill -TERM -<pgid>`) using the pid from `just procs`. Either way the ADW's own signal handler turns the signal into a clean shutdown: a killed run marks itself `fail` and closes its process rows, so the trace never claims work is in flight that is already dead.

## Report

Tell the engineer, in order: which chain and which roster you launched (name the config whenever it was not the default), which phase is running now (or which failed), phase statuses in sequence, and for a failure the gate violations or the error verbatim. Remember **every phase defaults to `fail`** — a phase showing `fail` may simply never have completed; `queued` means it never started. Don't dress up a partial run as a success.

For a visual live view, register this repo in the central Atelier **cockpit** and watch it there. The cockpit is one Next.js app that observes *many* stamped repos; it reads this same `sssf.db` (rowid-cursor polling, force-dynamic re-query) and renders sessions as cards, runs as swim lanes, phases and tool calls drill-in. To make this repo visible, add an entry to the cockpit's `atelier.projects.json`:

```json
{ "id": "myrepo", "name": "My Repo", "root": "/abs/path/to/this/repo", "adwsSubdir": "adws" }
```

The sqlite queries and `just` recipes above remain the headless equivalent.
