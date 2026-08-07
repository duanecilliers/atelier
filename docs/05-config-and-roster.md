# Configuration & the Roster

`engine/adws/adw_sssf_config/sssf.config.yaml` is the factory's configuration: which
agents exist, what model and backend each runs, what it may read/write, and the
observability sink. The engine reads and validates it via Pydantic at run time
(`agents.py::load_config` + `validate`); the cockpit can also read and, since Phase 4,
surgically write it. It is a **file**, not the db — editing it spawns no process and
touches no run's trace, unlike the control plane described in
[01-architecture.md](01-architecture.md).

---

## 1. Annotated structure of `sssf.config.yaml`

Path: `engine/adws/adw_sssf_config/sssf.config.yaml` (156 lines). Its header comment
restates the layout invariant from [AGENTS.md](../AGENTS.md): `engine/` is not a nested
repo, so every path in the file is `engine/`-prefixed and ADWs run from the repo root.

### `defaults:` — roster-wide fallback values

| Key | Live value | What it does |
|---|---|---|
| `coding_agent` | `pi` | Default backend for any agent that doesn't override it |
| `model` | `openai-codex/gpt-5.6-sol` | Default model — chosen because pi's Anthropic OAuth is expired on this machine |
| `thinking` | `medium` | One of `off\|minimal\|low\|medium\|high\|xhigh\|max` |
| `harness_engineering` | `[]` | pi extensions loaded into the harness (`-e` flags) |
| `tools` | `[read, bash, edit, write, grep, find, ls]` | Roster-wide tool allowlist; any agent may override with its own `tools:`. `--tools` filters extension/custom tools too — an extension's tools must be named explicitly in `tools` or they're silently filtered |
| `protected_files` | `[engine/adws/adw_modules/, engine/adws/adw_sssf_config/, engine/adws/adw_*.py]` | Off-limits to every agent that hasn't named the same path in its own `writes`. Enforced in `adw_modules/permissions.py`, not by `tools`. `writes:` governs the **repo**, never the session runtime under `data_dir` |
| `data_dir` | `engine/adws/adw_data` | Runtime home: `{data_dir}/sessions/{adw_id}/{agent_name}/` |

### `observability:`

| Key | Live value | What it does |
|---|---|---|
| `db` | `engine/adws/adw_data/sssf.db` | Where the tracer writes directly; the cockpit polls it |
| `poll_ms` | `500` | Visualizer live-poll cadence |

### `agents:` — the live roster, 5 agents

| Agent | `coding_agent` | `model` | `writes` | Purpose |
|---|---|---|---|---|
| `planner` | `claude_code` | `anthropic/claude-fable-5` | `[specs/]` | Turn a request into a plan the builder can implement without asking questions |
| `builder` | `pi` (inherited) | `openai-codex/gpt-5.6-sol` | *(no key — unrestricted)* | Implement the plan exactly; report every changed file in the envelope |
| `scout` | `claude_code` | `anthropic/claude-haiku-4-5` | `[]` | Find and report where things live; change nothing |
| `reviewer` | `pi` (inherited) | `openai-codex/gpt-5.6-terra` | `[]` | Confirm that what was built is what was asked for; change nothing |
| `documenter` | `pi` (inherited) | `openai-codex/gpt-5.6-luna` | `[app_docs/, docs/, "**/*.md", "*.md"]` | Write up the change from the diff; document only |

Notes:
- **`builder` is the only unrestricted, edit-capable agent** — no `writes` key means
  unrestricted, and it's the only agent whose `tools` list includes `edit`. It still
  cannot touch `defaults.protected_files` — the builder doesn't get to edit its own
  grader.
- `planner` and `scout` run `claude_code` specifically to reach `anthropic/*` models;
  `reviewer` and `documenter` inherit the default `pi` backend. See §5 for why.
- `planner` and `scout` both load `harness_engineering:
  [.../harness_engineering/subagents.ts]`, which registers the four `subagent_*` tools
  — those tool names must also appear in the agent's own `tools` list (§6).
- **There is no tester agent.** Running the test suite is a known deterministic
  command, so it's a `kind="code"` phase over `adw_modules/quality.py`, not an agent
  call. The commands it runs come from the `quality:` block below. See
  [03-agents-and-gates.md](03-agents-and-gates.md).

### `quality:` — the deterministic verify commands

The verify/test commands a quality phase runs, as **data the operator owns**, not code. Each
entry maps a name to `{ argv, timeout?, area?, operation? }`; `quality.py` builds its block list
from this map in file order. Omitting a block skips it; an **empty or absent `quality:` runs
nothing and says so** — the honest replacement for hardcoded fake-green echoes. The map key `test`
is the one the deterministic test phase runs alone.

```yaml
quality:
  typecheck: { argv: ["pnpm", "--dir", "cockpit", "typecheck"], area: frontend, operation: typecheck }
  contract:  { argv: ["pnpm", "--dir", "cockpit", "check:contract"], area: frontend }
  # test:    { argv: ["uv", "run", "pytest", "-q"], timeout: 600 }   # Atelier has no unit suite
```

This is the change that made stamped-repo updates clean (distribution **Part B**): moving the
per-repo commands out of the managed `quality.py` and into the config the updater never touches, so
`quality.py` is purely managed code. See [09-distribution.md](09-distribution.md) §5.

---

## 2. The config models — `engine/adws/adw_modules/data_types.py`

There is **no separate `PermissionsConfig` model.** Permission behavior is expressed
entirely through `ConfigDefaults.protected_files` + `AgentConfig.writes`, enforced
procedurally in `adw_modules/permissions.py` (§6) — not through a distinct Pydantic
config class.

### `AgentConfig`

| Field | Type | Default |
|---|---|---|
| `name` | `str` | — |
| `coding_agent` | `Literal["pi", "claude_code"]` | `"pi"` |
| `model` | `str` | `"google/gemini-3.6-flash"` |
| `thinking` | `str` | `"medium"` |
| `color` | `str` | `""` |
| `purpose` | `str` | `""` |
| `prompt_engineering` | `PromptEngineering` (`system`, `user` paths) | — |
| `harness_engineering` | `list[str]` | `[]` |
| `tools` | `Optional[list[str]]` | `None` (all tools usable) |
| `writes` | `Optional[list[str]]` | `None` |

`writes` semantics — enforced in code, not expressible via `tools` alone (`bash` runs
anything, `write` reaches any path):
- `None` → unrestricted, except roster-wide `protected_files`
- `[]` → read-only: may modify nothing tracked
- `[...]` → only these; trailing `"/"` = directory prefix, `"*"` = glob, else exact path

### `ConfigDefaults`

| Field | Type | Default |
|---|---|---|
| `coding_agent` | `Literal["pi", "claude_code"]` | `"pi"` |
| `model` | `str` | `"google/gemini-3.6-flash"` |
| `thinking` | `str` | `"medium"` |
| `color` | `str` | `""` |
| `harness_engineering` | `list[str]` | `[]` |
| `tools` | `Optional[list[str]]` | `None` |
| `protected_files` | `list[str]` | `["adws/adw_modules/", "adws/adw_sssf_config/", "adws/adw_*.py"]` |
| `data_dir` | `str` | `"adws/adw_data"` |

The Pydantic code default for `protected_files`/`data_dir` is `adws/`-prefixed (no
`engine/`), while the live YAML always sets `engine/adws/`-prefixed values explicitly —
the YAML overrides these defaults, so the discrepancy is latent.

### `ObservabilityConfig`

| Field | Type | Default |
|---|---|---|
| `db` | `str` | `"adws/adw_data/sssf.db"` |
| `poll_ms` | `int` | `500` |

### `QualityCheckConfig`

One entry in the `quality:` map (the map key is the check's name).

| Field | Type | Default |
|---|---|---|
| `argv` | `list[str]` | — (validated non-empty — a check with no command is a config typo) |
| `timeout` | `int` (seconds) | `120` |
| `area` | `QualityArea` | `"backend"` (trace classifier) |
| `operation` | `QualityOperation` | `"build"` (trace classifier) |

`to_spec(name)` adapts one entry into the `QualityCheckSpec` that `quality._run()` executes.

### `SSSFConfig` — the root model

| Field | Type | Default |
|---|---|---|
| `defaults` | `ConfigDefaults` | `ConfigDefaults()` |
| `observability` | `ObservabilityConfig` | `ObservabilityConfig()` |
| `quality` | `dict[str, QualityCheckConfig]` | `{}` (empty = no checks run) |
| `agents` | `list[AgentConfig]` | `[]` |

---

## 3. How `load_config` works

File: `engine/adws/adw_modules/agents.py`.

```python
def load_config(path: str = "adws/adw_sssf_config/sssf.config.yaml") -> SSSFConfig:
    raw = yaml.safe_load(Path(path).read_text()) or {}
    defaults = raw.get("defaults", {}) or {}
    for agent in raw.get("agents", []) or []:
        for key in ("coding_agent", "model", "thinking", "color", "tools", "writes"):
            if key in defaults:
                agent.setdefault(key, defaults[key])
        agent.setdefault("harness_engineering", defaults.get("harness_engineering", []))
    return SSSFConfig(**raw)
```

This is a **pre-Pydantic manual defaulting pass** over the raw dict: for each of
`coding_agent, model, thinking, color, tools, writes`, if the key is present on
`defaults:` and absent on the individual agent, it's copied onto the agent dict via
`setdefault`. `harness_engineering` gets the same treatment unconditionally. Only then
is the whole raw dict validated against `SSSFConfig` — a malformed value anywhere fails
construction here, before any run starts.

Separately, `validate(cfg, required)` — called by each ADW's `main()` after
`load_config` — fail-fast checks the agent names the ADW actually needs:
- Resolves each name (`resolve()`) — `SystemExit` listing available names if missing.
- Checks `coding_agent in ("pi", "claude_code")`.
- Checks both `prompt_engineering.system` and `.user` paths exist on disk.
- If `coding_agent == "pi"`: calls `agent_pi.resolve_model(agent.model)` — the live
  check against pi's `--list-models` catalog (§4).
- If `coding_agent == "claude_code"` and the model contains `/` but doesn't start with
  `anthropic/`: flagged as a problem.
- All problems accumulate; any of them raises `SystemExit` — nothing runs.

**`load_config`'s `path` argument is CWD-relative, never resolved against
`repo_root()`.** `repo_root()` is only computed later, when a `Run` is built in
`runner.py`; `load_config` runs earlier, in each ADW script's `main()`. In practice the
root `justfile` always passes an explicit `--config engine/adws/adw_sssf_config/sssf.config.yaml`
from the repo root, so this only bites a script invoked directly without `--config`.
`SSSF_CONFIG` is a `just`-level env var, not something the Python engine reads
directly — `adw_worker.py` re-passes `--config` verbatim to every child ADW process it
spawns.

---

## 4. `coding_agent` routing — pi vs claude_code

`AgentConfig.coding_agent: Literal["pi", "claude_code"] = "pi"` is the single switch.
Dispatch happens inside `agents.py::execute()`'s inner `send()` closure:

```python
backend = agent_cc if agent.coding_agent == "claude_code" else agent_pi
result = backend.run(request, on_event=..., on_spawn=..., on_exit=...)
```

| Backend | Module | Auth | Model validation |
|---|---|---|---|
| `pi` (default) | `agent_pi.py` | pi's own auth in `~/.pi/agent` | `resolve_model()` — live check against `pi --list-models` at `validate()` time |
| `claude_code` | `agent_cc.py` | local `claude` CLI login (no API key) via `claude-agent-sdk` | Light: expects an `anthropic/` prefix; real validation happens at SDK call time |

Both backends return the identical `PiResult` shape (`agent_cc` re-emits tool calls in
pi's event shape), so the rest of `execute()` — parsing, gating, permission
enforcement, tracing — is backend-agnostic. See
[03-agents-and-gates.md](03-agents-and-gates.md) for the gate/envelope contract both
backends feed into.

**The machine gotcha:** pi's Anthropic OAuth is expired here, so pi can currently only
authenticate `openai-codex/*` models. `planner` and `scout` need `anthropic/*` models,
so they run `coding_agent: claude_code` instead. `builder`, `reviewer`, `documenter`
run the default `pi` backend with `openai-codex/*` models.

`PI_MODELS_PATH` (`engine/.env`, pointing at the stub `engine/pi-models.json` =
`{"providers":{}}`) has **no bearing on model validation** — that's entirely
`resolve_model()` against the live `pi --list-models` catalog. The stub exists only so
`agent_pi.context_window()` (a separate lookup, for context-window ceilings) doesn't
crash with `FileNotFoundError`; every lookup against the empty stub misses by design
and falls back to the live catalog.

`agent_cc.py`'s `TOOL_MAP` translates pi-style tool names to the Claude Code SDK's:
`read→Read, bash→Bash, edit→Edit, write→Write, grep→Grep, find→Glob, ls→Bash`. A pi
tool name with no mapping (e.g. `subagent_*` extension tools) is silently dropped
rather than erroring; `ls` and `bash` collapse to one deduplicated `Bash` entry.

---

## 5. The write/tool boundary from a config POV

`writes` and `protected_files` are enforced in `adw_modules/permissions.py`, after the
fact, by diffing the real git working tree — `tools:` alone is not a sandbox (`bash`
can run anything, `write` reaches any path). The allow/deny order, checked per touched
path:

1. Always allow session-runtime paths under `defaults.data_dir` — where every agent's
   own reports/handoff files legitimately live, regardless of `writes`.
2. Allow if the path matches an entry in `agent.writes` — naming a path unlocks it even
   over `protected_files`.
3. Deny if the path matches `defaults.protected_files`.
4. Otherwise fall back to `agent.writes is None` (unrestricted) vs `[]` (read-only) vs a
   populated list (only those paths).

Pattern matching: a trailing `/` is a directory prefix, `*`/`**` are globs, anything
else is an exact path. A breach rolls back the offending path (`git checkout --` for a
tracked file, `unlink()` for an untracked one — unless it was already dirty before the
agent ran, in which case it's left as-is) and aborts the phase; it is not a
re-promptable gate failure since the write already physically happened. Full
enforcement mechanics — `snapshot`, `enforce`, `PermissionBreach` — are covered in
[03-agents-and-gates.md](03-agents-and-gates.md).

---

## 6. The cockpit roster mirror

`cockpit/lib/roster.ts` is the second write surface after the `run_queue` control plane
described in [01-architecture.md](01-architecture.md) — and the first that touches a
file the engine reads as configuration, rather than the trace or `sssf.db`. It stays
inside the determinism spine: writing it spawns no process and mutates no run's trace.
**The engine remains the authority** — `agents.py::load_config` re-validates via
Pydantic at run time regardless of what the cockpit wrote.

- `RosterConfigSchema` (Zod) mirrors `SSSFConfig`/`ConfigDefaults`/
  `ObservabilityConfig`/`AgentConfig`/`QualityCheckConfig` field-for-field, plus two extra checks
  the Pydantic side doesn't enforce: a `model` must look like `provider/id`, and `color`
  must be 3/6-digit hex or empty. `coding_agent`/`thinking` are constrained to enums
  from `roster-constants.ts` rather than bare strings. This mirror is kept in lockstep **by hand**
  — `pnpm check:contract` covers db tables, not the config file, so a `quality:` schema change must
  be mirrored in `roster.ts` (and `roster-constants.ts` for its `area`/`operation` vocabularies)
  manually.
- **The editable surface is narrower than the full mirror**: scalars (`model`,
  `coding_agent`, `thinking`, `color`, `purpose` per agent; `model`, `coding_agent`,
  `thinking` on defaults) plus the two security-boundary arrays (`tools` per
  agent+defaults, `writes` per agent). Prompt/harness paths and
  `defaults.protected_files` are read-only. Writing `null` for `tools`/`writes` removes
  the key — matching `Optional[...] = None` / `load_config`'s `setdefault` fold.
- The **surgical byte-range writer**: parses into a comment-preserving `yaml` `Document`
  and splices only the allowlisted field's exact source byte-range (or inserts a fresh
  line if the key is absent), re-validates the whole rewritten document against the Zod
  mirror, then writes via same-directory temp file + `renameSync`. It never
  re-serializes from a plain JS object, so every hand-aligned comment in the live file
  survives — a one-field change is a one-line diff.
- `rosterWarnings()` surfaces two advisories in the UI, never a hard block: a
  `pi`-backed agent routed to an `anthropic/*` model (OAuth expired locally), and an
  agent with a `harness_engineering` extension but `tools == null` (its extension tools
  get silently filtered out — name them explicitly).

`cockpit/lib/roster-constants.ts` holds the client-safe enum vocabularies
(`CODING_AGENTS`, `THINKING_LEVELS`, `BUILTIN_TOOLS`, plus `validateAgentName` /
`validateToolName` / `validateWritePattern`) — it has **zero node imports**, unlike
`roster.ts` which pulls in `node:fs` and the `yaml` package, so a client component can
import just the vocabularies without dragging filesystem code into the bundle.

**This mirror is not covered by `pnpm check:contract`** — that script asserts the db
schema mirror only; `sssf.config.yaml` is a file, so `roster.ts` must be kept in
lockstep with `data_types.py` by hand, same discipline as the schema mirror described in
[AGENTS.md](../AGENTS.md). See [06-cockpit.md](06-cockpit.md) for the roster editor UI.

---

## 7. Editing the roster

### Via the file directly

1. Edit `engine/adws/adw_sssf_config/sssf.config.yaml` by hand — it's a normal YAML
   file with comments; nothing enforces surgical edits for a human.
2. **Add an agent**: append a `- name: ...` block under `agents:`, at minimum supplying
   `name` and `prompt_engineering.{system,user}` (both must exist on disk — `validate()`
   checks `Path(ref).is_file()`), and create those two prompt files. Everything else
   falls back to `defaults:` via `load_config`'s `setdefault` fold.
3. **Change a model**: edit the agent's (or `defaults.`) `model:` — `provider/id`. For
   `coding_agent: pi` it must resolve against `pi --list-models` (§4); for
   `claude_code` it should start with `anthropic/`.
4. **Edit a prompt**: edit `system.md`/`user.md` at
   `engine/adws/adw_data/prompt_engineering/{agent}/{system,user}.md`. `prompts.render`
   templates in `{{prompt}}`, `{{previous_envelope}}`, `{{context_handoff_dir}}`.
5. **Adjust `tools`/`writes`**: edit the list under the agent (or `defaults.tools`).
   `protected_files` always wins for repo-root safety paths unless the agent's own
   `writes` names them; an extension's tools must be named in the agent's own `tools`
   list or they're filtered out even though the extension loaded.
6. Changes take effect the next time an ADW runs `load_config()` + `validate()` — there
   is no reload step; config is read fresh from disk per process.
7. `SSSF_CONFIG` (read by the **justfile**, not Python directly) can swap the whole
   roster file for one invocation: `SSSF_CONFIG=path/to/alt.yaml just scout "..."`.

### Via the cockpit roster editor (`/api/roster`)

1. Scalar and array edits go through `writeRoster()` — validated against
   `RosterEditSchema`, spliced surgically, written atomically. A `tools`/`writes`
   value of `null` clears the key.
2. **Adding an agent** goes through `addAgent()` — minimal identity+scalar form,
   always starts `writes: []` (read-only until an operator grants writes — matching
   the factory's self-hosting safety posture), auto-bootstraps `system.md`/`user.md`
   templates under `engine/adws/adw_data/prompt_engineering/{name}/` without
   clobbering pre-existing files.
3. **Removing an agent** goes through `removeAgent()` — refuses to remove the last
   agent, leaves prompt files on disk (git-tracked, deleted by hand if desired).
4. Every write reparses the whole file and re-validates against the Zod mirror before
   any bytes hit disk, applied via temp-file + rename.
5. `SSSF_CONFIG` swaps the roster the cockpit resolves against too — same env var,
   read directly by the TS side this time (`resolveConfigPath()`), unlike the Python
   engine where it's purely a `justfile` concept.
6. The cockpit never spawns a process and never touches `sssf.db` for these writes —
   only `sssf.config.yaml` changes; the engine re-validates it independently the next
   time an ADW runs.

---

## 8. The `sandbox:` block — isolated workspaces

An optional top-level `sandbox:` block declares **how this project provisions and lands an
isolated, persistent workspace** — a git worktree on a named branch that hosts one or more runs.
It is per-project config the **worker** reads (not the cockpit roster editor); the operating model
— create / attach a run / land / shut down, and the worker's reconcile + reap loop — lives in
[07-operations.md](07-operations.md#5-sandboxes--isolated-persistent-workspaces). Absent the block,
every run is `local`: the repo root, byte-identical to today.

```yaml
sandbox:
  default: local                 # level a launch uses when it doesn't override
  worktree_env:                  # a profile, keyed by LEVEL NAME (L2 here)
    branch: adw/${SANDBOX_ID}    # named branch the worktree checks out (survives teardown)
    setup:                       # shell commands, run ONCE at create (cwd = the worktree)
      - pnpm install --frozen-lockfile
    ports:
      WEB: auto                  # engine probes a free port → ${WEB}, injected into every run's env
      DB:  auto
    services:                    # backing services — mechanism-agnostic shell hooks
      up:   docker compose -p ${SANDBOX_ID} up -d     # once at create, after setup
      down: docker compose -p ${SANDBOX_ID} down -v   # at shutdown, before the tree is removed
    env:
      DATABASE_URL: postgres://localhost:${DB}/app    # injected into every run in the sandbox
    land:
      mode: pr                   # pr | merge | manual
      cmd:  gh pr create --fill --head ${BRANCH}
```

| Field | Meaning |
|---|---|
| `default` | The level a launch uses when it doesn't pick one. Vocabulary is **bounded** (`local` · `worktree` · `worktree_env`; later `container` · `remote`) — a fixed seam enum shared with the cockpit (`roster-constants.ts`). `local` = no worktree, no sandbox row. *(Note: the create UI currently hardcodes `worktree` and doesn't yet read `default` — see the launcher caveat at the end of this section.)* |
| `<level>:` | A profile block **keyed by level name** (`worktree_env` above). Declare one per non-`local` level the project uses. |
| `branch` | The named branch the worktree checks out. It — and its commits — survive teardown in the shared `.git`; shutdown reclaims the working tree, not the work. Charset-validated (git-ref **and** shell-safe) because it interpolates into shell hooks. |
| `setup` | Shell commands run once at create, `cwd` = the worktree. Warms deps so follow-up runs start instantly against the same tree. |
| `ports` | `NAME: auto` → the engine probes a free port and exposes `${NAME}` to `setup`/`services`/`env`/`land` **and** injects it into every run's process env, so the app reads the same port its services bound to. Persisted as JSON on the sandbox row. |
| `services.up` / `.down` | Bring backing services up at create / down at shutdown (and best-effort during orphan reaping). Shell strings — the engine is **mechanism-agnostic** (compose, testcontainers, anything); **no hard Docker dependency**. `-p ${SANDBOX_ID}` makes `down` targetable even after a worker restart. |
| `env` | Extra process env injected into every run in the sandbox, after interpolation. |
| `land.mode` | `pr` \| `merge` \| `manual`. `manual` (also the default when `land` is absent) runs nothing — the branch is left for a human. |
| `land.cmd` | The shell hook for `pr`/`merge`. Its captured stdout (a PR URL / merge summary) is surfaced as the sandbox's `land_result`. A `pr`/`merge` mode with an **empty** `cmd` is a misconfiguration — recorded plainly, not reported as a clean manual land. |

**Interpolation.** `${SANDBOX_ID}`, `${BRANCH}`, and each allocated port name (`${WEB}`, `${DB}`)
are the only substitutions, available to `setup`, `services`, `env`, and `land`.

**The mirror.** `SSSFConfig.sandbox` (`data_types.py`, Pydantic — `SandboxConfig` / `SandboxProfile`
/ `SandboxLand`) is mirrored **by hand** in `cockpit/lib/roster.ts` (Zod), with the level vocabulary
in `roster-constants.ts` (`SANDBOX_LEVELS`). Same discipline as the rest of the config mirror:
`pnpm check:contract` covers db tables, not this file. Provisioning/landing are per-project; only
the *level name* is shared seam vocabulary. Determinism is intact — provisioning changes only a
run's `cwd` and env, so the argv the worker spawns is byte-identical to a `local` run.

> **Launcher caveat (deferred).** `sandbox.default` and `profile.branch` are defined and validated
> but **not yet consulted by the create path**: the cockpit's "+ New sandbox" hardcodes level
> `worktree` (L1) and the engine mints `adw/<id>` as the branch. Reading `default`, a level picker,
> and branch templating belong with the **new-vs-attach launcher** (a future slice). The
> `worktree_env` engine path is complete — a sandbox whose `level` is set to it (a direct control
> INSERT, or the future launcher) provisions the full profile.

---

## Extending this subsystem

- **Add an agent** — via the file (§7) or the cockpit editor's `addAgent()`. Either
  way it needs a unique name, `system.md`/`user.md` prompt files, and a deliberate
  `writes` value (the cockpit path defaults to `[]`; a hand-edited file inherits
  `defaults.writes` if the roster ever sets one).
- **Change a model** — mind the pi/claude_code routing and validation split in §4: a
  `pi` agent's model must resolve against `pi --list-models`; a `claude_code` agent's
  model should carry the `anthropic/` prefix.
- **Add a config field** — update `data_types.py` first, then mirror it in
  `cockpit/lib/roster.ts` (and `roster-constants.ts` if it's a client-facing enum) by
  hand; there is no automated check for this mirror, unlike the db schema contract.

Full step-by-step recipes for each of these live in
[08-extending-the-system.md](08-extending-the-system.md).
