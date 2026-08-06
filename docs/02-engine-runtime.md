# Engine runtime & trace layer

This doc covers the Python runtime that every ADW runs on top of: how a session is minted
and torn down, the phase primitive an ADW author composes, the `Tracer` that writes every
event to the seam (`engine/adws/adw_data/sssf.db`), the trace schema itself, and the small
helper modules (`git_helper.py`, `utils.py`) those pieces lean on. Read this if you're
writing or debugging an ADW, extending the trace schema, or tracking down why a killed run
left the db in a given state.

## 1. The lifecycle of a run

Every ADW's `main()` starts by calling `session.ensure(cfg, adw_id)`
(`engine/adws/adw_modules/session.py:38-50`) — the one public function in `session.py`.

```python
def ensure(cfg: SSSFConfig, adw_id: str | None = None) -> Run:
    adw_id = adw_id or new_id(8)
    tracer = Tracer(cfg.observability.db,
                    f"{cfg.defaults.data_dir}/sessions/{adw_id}/events.jsonl")
    run = Run(cfg=cfg, adw_id=adw_id, tracer=tracer, engineer=engineer_name())
    tracer.session_start(adw_id, run.engineer, adw_name=Path(sys.argv[0]).stem)
    tracer.process_start(adw_id, "adw", "", os.getpid(),
                         " ".join([Path(sys.argv[0]).name, *sys.argv[1:]]))
    _finalize_when_killed(run)
    run.console.session_started(adw_id, run.engineer)
    return run
```

In order:

1. **Mint or pin the id.** `adw_id = adw_id or new_id(8)` — if the caller passed one (an
   ADW's `--adw-id` CLI flag), that session is *joined*; otherwise `utils.new_id(8)` mints a
   fresh 8-hex-char id (`secrets.token_hex(4)`).
2. **Build the `Tracer`**, pointed at `cfg.observability.db` (default
   `adws/adw_data/sssf.db`) and a per-session JSONL file at
   `{data_dir}/sessions/{adw_id}/events.jsonl`.
3. **Build the `Run`** — this is where `repo_root()`, the session directory, and the agent
   map get set up (§3).
4. **`tracer.session_start(...)`** upserts the `sessions` row to `status='running'` and
   appends the script's own filename stem (e.g. `adw_scout`) to a `" + "`-joined
   `adw_name` list, so a chained/joined run's `adw_name` column shows every ADW script that
   touched it (e.g. `"adw_plan + adw_build_test"`).
5. **`tracer.process_start(adw_id, "adw", "", pid, argv)`** records *this process* as a
   `processes` row before any phase opens, so a run that hangs inside its very first agent
   call is still discoverable/killable by `adw_id`.
6. **`_finalize_when_killed(run)`** installs the SIGTERM/SIGINT handlers (§11).
7. **`run.console.session_started(...)`** prints/traces the session-start banner.

A joined run (same `adw_id` passed again) doesn't restart the timeline — it continues it:
`_seq` is seeded from the existing max phase sequence, and `session_start`'s `ON CONFLICT`
just flips `status` back to `'running'` and appends the new `adw_name`.

## 2. The `Run` object

`Run` (`engine/adws/adw_modules/runner.py:42-69`) is the object an ADW's `main()` holds for
its whole lifetime:

```python
class Run:
    def __init__(self, cfg, adw_id: str, tracer, engineer: str):
        self.cfg = cfg
        self.adw_id = adw_id
        self.tracer = tracer
        self.console = Console(tracer, adw_id)
        self.engineer = engineer
        self.phases: list[Phase] = []
        self.tokens = 0
        self.cost = 0.0
        self._seq = tracer.max_phase_seq(adw_id)   # a joined run continues the sequence
        self.repo_root = git_helper.repo_root()    # where every agent is spawned to work
        self.session_dir = ensure_dir(Path(cfg.defaults.data_dir) / "sessions" / adw_id)
        self.context_handoff_dir = ensure_dir(self.session_dir / "context_handoff")
        self._agent_map_path = self.session_dir / "agent_map.json"
        self.agent_map: dict = (json.loads(self._agent_map_path.read_text())
                                if self._agent_map_path.exists() else {})
```

| field | purpose |
| --- | --- |
| `cfg` | the loaded, Pydantic-validated `SSSFConfig` |
| `adw_id` | the session id (hex string, e.g. `a1b2c3d4`) |
| `tracer` | the shared sqlite+JSONL writer (§6) |
| `console` | bound to `(tracer, adw_id)`; every printed line also becomes a `log` event |
| `engineer` | resolved via `utils.engineer_name()` |
| `phases` | every phase opened so far, in order; `finish()` checks all of them succeeded |
| `tokens`, `cost` | running totals, mirrored into `sessions` via `add_usage` |
| `_seq` | phase sequence counter, seeded from `tracer.max_phase_seq(adw_id)` |
| `repo_root` | `git_helper.repo_root()`, resolved once — where every agent is spawned to work |
| `session_dir` | `{data_dir}/sessions/{adw_id}` |
| `context_handoff_dir` | `{session_dir}/context_handoff`, created eagerly |
| `agent_map` | `{session_dir}/agent_map.json` — agent name -> per-agent coding-agent session info, so a joined run resumes each agent's own pi/Claude session |

`Run` methods:

| method | signature | behavior |
| --- | --- | --- |
| `save_agent_map` | `(agent: str, entry: dict) -> None` | sets `agent_map[agent] = entry` and rewrites `agent_map.json` in full |
| `add_usage` | `(tokens: int, cost: float) -> None` | increments `self.tokens`/`self.cost`, calls `tracer.session_add_usage(...)` |
| `phase` | `(params: PhaseParams)` | the phase context manager — see §4 |
| `finish` | `(accepted: bool = True, reason: str = "") -> int` | the run's single finalization call — see §5 |

The API surface a phase author works with inside `with run.phase(...) as ph:` is
`PhaseHandle`, not `Run` — see §4.

## 3. Phases

### The three kinds

`PhaseKind = Literal["engineer", "agent", "code"]` (`engine/adws/adw_modules/data_types.py:16`):

| kind | meaning | console color |
| --- | --- | --- |
| `engineer` | human intent captured into the trace (e.g. the incoming prompt) | cyan |
| `agent` | a model call via `ph.call(AgentCall(...))` — only this kind may call it | magenta |
| `code` | deterministic disposition (a gate, a git commit, a quality check) | yellow |

### `PhaseParams` — what a phase author constructs

`data_types.py:22-53`:

```python
class PhaseParams(BaseModel):
    name: str            # short id, unique within the run: "plan", "build"
    kind: PhaseKind       # which lane the block renders in
    owner: str            # engineer's name, "git", or an agent name from config
    description: str      # REQUIRED: one sentence on what/why
    retries: int = 0      # agent phases: gate-failure retries via continue
```

A `field_validator` on `description` (`data_types.py:31-53`) rejects, at construction time
(before the phase ever opens or traces), both an empty description and one that merely
echoes the phase name (e.g. `commit_plan: "Commit the plan"` fails). The description is the
only sentence the trace/console/UI ever show about a phase's intent, so an echo is treated
the same as blank.

### `Phase` — the persisted record

`data_types.py:56-67`:

```python
class Phase(BaseModel):
    phase_id: str
    adw_id: str
    seq: int
    params: PhaseParams
    status: PhaseStatus = "fail"   # success must be earned
    attempt: int = 0
    error: Optional[str] = None
    started_at: Optional[str] = None
    ended_at: Optional[str] = None
```

`PhaseStatus = Literal["queued", "running", "success", "fail"]` (`data_types.py:17`). Note
the default `status="fail"` — success must be *earned* by a clean exit from the context
manager, not assumed.

### `Run.phase(params: PhaseParams)` — the one phase primitive

A `@contextmanager` (`runner.py:72-111`). On entry:

```python
self._seq += 1
phase = Phase(phase_id=f"{self.adw_id}_{self._seq:02d}_{params.name}",
              adw_id=self.adw_id, seq=self._seq, params=params,
              status="running", started_at=now_iso())
self.phases.append(phase)
self.tracer.phase_upsert(phase)
self.tracer.event(EventRecord(..., type="phase_start", name=params.name,
                              payload={"kind": ..., "owner": ..., "description": ...}))
self.console.phase_started(phase)
```

`phase_id` format: `{adw_id}_{seq:02d}_{name}` — e.g. `a1b2c3d4_01_scout`.

It yields a `PhaseHandle(self, phase)` (the `ph` in `with run.phase(...) as ph:`).

- **Clean exit** (`runner.py:104-111`): `phase.status = "success"`, `ended_at` stamped, a
  `phase_end`/`status=success` event traced, `phase_upsert` called again (its `ON CONFLICT`
  updates the same row in place), and `console.phase_ended(...)`.
- **Any exception** (`except BaseException`, `runner.py:88-103`): `phase.status = "fail"`,
  `phase.error = str(error)[:1000]`, `ended_at` stamped; traces an `error` event then a
  `phase_end`/`status=fail` event, upserts the phase, **also calls
  `tracer.session_finish(adw_id, ok=False)`** — an unhandled exception in one phase
  immediately marks the whole session failed in the db, not just that phase — prints
  `console.phase_ended` and `console.session_finished(False, ...)`, then **re-raises**. The
  exception still propagates to the caller.

Wall time inside the `with` block is measured via `time.monotonic()` and passed to
`console.phase_ended(phase, seconds)`.

### `PhaseHandle` — the API surface a phase author uses

`runner.py:22-39`:

```python
class PhaseHandle:
    def log(self, **payload) -> None: ...
    def call(self, call: AgentCall) -> EnvelopeBase: ...
```

| method | behavior |
| --- | --- |
| `ph.log(**payload)` | traces a `type="log"` event and prints via `console.note`; free-form, valid in any phase kind. Inside an `engineer`-kind phase, if the payload includes `input`, it's *also* written to `sessions.request` via `tracer.session_request` — this is how the incoming prompt lands in the `sessions` table (`adw_scout.py:27-29`, `ph.log(input=prompt)` inside a `kind="engineer"` phase) |
| `ph.call(call: AgentCall)` | the only way to invoke a model. **Guarded**: raises `RuntimeError` if the enclosing phase's `kind != "agent"`. Delegates to `agents.execute(run, phase, call)`, which renders prompts (saved under `session_dir/{agent}/prompts/`), dispatches to the configured coding-agent backend, parses the typed envelope, and runs the call's `gates` |

`AgentCall` (`data_types.py:286-294`) is the input to `ph.call`:

```python
class AgentCall(BaseModel):
    model_config = {"arbitrary_types_allowed": True}
    output_type: Type[EnvelopeBase]
    prompt: str
    previous: Optional[EnvelopeBase] = None
    gates: list[Callable] = Field(default_factory=list)   # gate(envelope, run) -> list[str]
```

`output_type` is the concrete `EnvelopeBase` subclass the agent's final JSON response must
parse against (e.g. `ScoutOutput`, `PlanOutput`, `BuildOutput`, `ReviewOutput`,
`DocumentOutput` — `data_types.py:81-129`). `previous` threads the prior phase's envelope in
as context. `gates` is a list of deterministic acceptance-check callables from
`adw_modules/gates.py` — see [03-agents-and-gates.md](03-agents-and-gates.md) for how gates
and envelopes fit together.

### End-to-end example

`engine/adws/adw_scout.py`, in full:

```python
def main(prompt, config="adws/adw_sssf_config/sssf.config.yaml", adw_id=None) -> int:
    cfg = agents.load_config(config)
    agents.validate(cfg, REQUIRED_AGENTS)
    run = session.ensure(cfg, adw_id)

    with run.phase(PhaseParams(name="request", kind="engineer", owner=run.engineer,
                               description="Capture the incoming ask")) as ph:
        ph.log(input=prompt)

    with run.phase(PhaseParams(name="scout", kind="agent", owner="scout",
                               description="Find and report where things live — change nothing")) as ph:
        ph.call(AgentCall(output_type=ScoutOutput, prompt=prompt,
                          gates=[gates.artifacts_exist]))

    return run.finish()
```

Two phases: an `engineer` phase that just logs the incoming prompt, then an `agent` phase
(`owner="scout"`, resolved against the roster config) that calls the scout agent and gates
its `ScoutOutput` envelope on `gates.artifacts_exist`. See
[04-authoring-adws.md](04-authoring-adws.md) for the full recipe for composing an ADW out of
phases like this.

## 4. `Run.finish()` — the run's single finalization call

`runner.py:114-142`, called exactly once at the very end of an ADW's `main()` (e.g. `return
run.finish()` in `adw_scout.py:36`):

```python
phases_ok = bool(self.phases) and all(p.status == "success" for p in self.phases)
ok = phases_ok and accepted
```

Two independent criteria:

- **`phases_ok`** — every phase that ran must have ended `status == "success"`, and there
  must be at least one phase.
- **`accepted`** — a separate boolean the ADW passes in: its own domain-level acceptance
  test (e.g. "did the test suite pass"), independent of whether phases mechanically
  completed.

If `phases_ok` is true but `accepted` is false, an `error`/`not_accepted` event is traced
with `reason` (or a default message), and `console.note(...)` prints it. `finish()` always
calls `tracer.session_finish(adw_id, ok=ok)` and `console.session_finished(ok, tokens, cost,
cfg.observability.db)`, then returns `0 if ok else 1` — the intended process exit code.

This replaced an earlier `succeeded` property (per the docstring at `runner.py:115-129`): a
property with side effects, evaluated eagerly, could record success in the db/banner
*before* the caller's `and test.passed` was even checked — a run whose test suite failed
could show green in the trace and the UI while exiting 1. Bundling the db row, the console
banner, and the process exit code into one call means they can't disagree.

## 5. The Tracer

`engine/adws/adw_modules/tracer.py`. Per its module docstring (`tracer.py:1-6`): every event
lands in **JSONL and SQLite as it happens**; the JSONL files are the raw record, `sssf.db`
is the queryable mirror the cockpit polls; there is no push transport — the flow is always
agents -> sqlite -> web UI. **WAL mode** lets the cockpit read while ADW processes write.

`Tracer.__init__(db_path, events_jsonl)` (`tracer.py:104-114`):

```python
self.conn = sqlite3.connect(self.db_path, isolation_level=None)
self.conn.execute("PRAGMA journal_mode=WAL;")
self.conn.execute("PRAGMA synchronous=NORMAL;")
self.conn.execute("PRAGMA busy_timeout=5000;")
self.conn.executescript(SCHEMA)
self._migrate()
```

`isolation_level=None` is autocommit mode — every `execute` commits immediately, no explicit
transactions — consistent with "as it happens" writing. Directories for both the db and the
JSONL file are created via `ensure_dir` first.

### Write methods

All of these execute directly against `self.conn` in autocommit mode. None are async, and
there's no batching — every call is an individual autocommit `execute`.

| method | signature | behavior |
| --- | --- | --- |
| `event` | `(record: EventRecord) -> str` | mints `event_id = f"evt_{new_id(12)}"`, stamps `ts = now_iso()`, appends a JSON line to `events_jsonl`, then `INSERT`s into `events`. Returns the minted `event_id`. **The only method that writes to both JSONL and sqlite** — every other write below is sqlite-only |
| `session_start` | `(adw_id, engineer, adw_name=None) -> None` | `INSERT ... ON CONFLICT(adw_id) DO UPDATE SET status='running'`; if `adw_name` given, splits the existing column on `" + "`, appends the new name if not already present, rejoins |
| `session_request` | `(adw_id, request) -> None` | `UPDATE sessions SET request=?` with `request[:500]` (truncated) |
| `session_finish` | `(adw_id, ok: bool) -> None` | sets `status = 'success' if ok else 'fail'`, `ended_at=now_iso()`, then calls `processes_end_all(adw_id)` — closing every open process row is bundled into finishing the session |
| `session_add_usage` | `(adw_id, tokens, cost) -> None` | `UPDATE sessions SET total_tokens=total_tokens+?, total_cost=total_cost+?` |
| `process_start` | `(adw_id, kind, name, pid, command) -> None` | `INSERT INTO processes`, truncating `command` to 500 chars; lets a hung coding agent (which produces no events at all) still be found and killed by `adw_id` |
| `process_end` | `(adw_id, pid) -> None` | updates the newest still-open (`ended_at IS NULL`) row for that `(adw_id, pid)` pair, so a recycled pid within the same run doesn't clobber an older closed row |
| `processes_end_all` | `(adw_id) -> None` | closes every open row for the run — called from `session_finish` |
| `max_phase_seq` | `(adw_id) -> int` | `SELECT MAX(seq) FROM phases WHERE adw_id=?`, `0` if none; seeds `Run._seq` |
| `phase_upsert` | `(phase: Phase) -> None` | `INSERT ... ON CONFLICT(phase_id) DO UPDATE SET status=excluded.status, attempt=excluded.attempt, error=excluded.error, ended_at=excluded.ended_at` — called on phase open and again on close |
| `envelope_row` | `(phase, agent, output_type, payload_json, valid: bool, attempt) -> None` | `INSERT INTO envelopes`, id minted as `f"env_{new_id(12)}"` |
| `gate_row` | `(phase, gate: str, report: GateReport, attempt) -> None` | `INSERT INTO gate_results`, storing `report.violations` as `violations_json` and every `GateCheck` as `checks_json` — the report carries both the verdict and the evidence |
| `agent_session_row` | `(adw_id, agent: AgentConfig, session_id, context_tokens=0, context_window=0) -> None` | `INSERT ... ON CONFLICT(adw_id, agent) DO UPDATE ...` — one row per `(adw_id, agent)`; re-running the same agent within a session overwrites model/session_id/context numbers with the latest |

## 6. The trace schema

Eight tables total: six defined in `tracer.py`'s `SCHEMA` (`tracer.py:18-91`) plus
`run_queue`, appended from `queue.py`, and `workers`, appended from `workers.py`
(`SCHEMA = """...""" + RUN_QUEUE_DDL + WORKERS_DDL`).

**`sessions`**

| column | type |
| --- | --- |
| `adw_id` | TEXT PRIMARY KEY |
| `adw_name` | TEXT — ADW script(s) run, e.g. `"adw_plan + adw_build_test"` |
| `request` | TEXT |
| `status` | TEXT |
| `engineer` | TEXT |
| `started_at`, `ended_at` | TEXT |
| `total_tokens` | INTEGER DEFAULT 0 |
| `total_cost` | REAL DEFAULT 0 |
| `archived` | INTEGER DEFAULT 0 — review triage flag set by the cockpit, never by a run |

**`phases`**

| column | type |
| --- | --- |
| `phase_id` | TEXT PRIMARY KEY |
| `adw_id` | TEXT REFERENCES sessions |
| `seq` | INTEGER |
| `name`, `kind`, `owner`, `description` | TEXT |
| `status` | TEXT DEFAULT 'fail' |
| `attempt` | INTEGER DEFAULT 0 |
| `retries` | INTEGER DEFAULT 0 |
| `error` | TEXT |
| `started_at`, `ended_at` | TEXT |

**`events`**

| column | type |
| --- | --- |
| `event_id` | TEXT PRIMARY KEY |
| `adw_id` | TEXT REFERENCES sessions |
| `phase_id` | TEXT REFERENCES phases |
| `parent_id` | TEXT |
| `type`, `name` | TEXT |
| `payload_json` | TEXT |
| `tokens` | INTEGER |
| `started_at`, `ended_at` | TEXT |

**`envelopes`**

| column | type |
| --- | --- |
| `envelope_id` | TEXT PRIMARY KEY |
| `adw_id` | TEXT REFERENCES sessions |
| `phase_id` | TEXT REFERENCES phases |
| `agent`, `output_type` | TEXT |
| `payload_json` | TEXT |
| `valid` | INTEGER |
| `attempt` | INTEGER |
| `created_at` | TEXT |

**`gate_results`**

| column | type |
| --- | --- |
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT |
| `adw_id` | TEXT REFERENCES sessions |
| `phase_id` | TEXT REFERENCES phases |
| `attempt` | INTEGER |
| `gate` | TEXT |
| `passed` | INTEGER |
| `violations_json` | TEXT |
| `checks_json` | TEXT — `[{item, ok, note}]`, what the gate verified |
| `created_at` | TEXT |

**`processes`**

| column | type |
| --- | --- |
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT |
| `adw_id` | TEXT REFERENCES sessions |
| `kind` | TEXT — `'adw'` (the workflow process) or `'agent'` (a coding-agent child) |
| `name` | TEXT — `''` for the adw, the agent name for a child |
| `pid` | INTEGER |
| `command` | TEXT — what the pid was, so a recycled pid isn't killed by mistake |
| `started_at`, `ended_at` | TEXT — `ended_at NULL` means believed alive |

**`agent_sessions`**

| column | type |
| --- | --- |
| `adw_id` | TEXT REFERENCES sessions |
| `agent` | TEXT |
| `coding_agent`, `model`, `color` | TEXT |
| `session_id` | TEXT |
| `context_tokens` | INTEGER — window occupancy after the agent's last turn |
| `context_window` | INTEGER — the model's ceiling; 0/NULL = unknown |
| `created_at`, `last_used_at` | TEXT |
| PRIMARY KEY | `(adw_id, agent)` |

**`run_queue`** (DDL owned by `queue.py`, appended: `SCHEMA = """...""" + RUN_QUEUE_DDL`)

| column | type |
| --- | --- |
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT |
| `adw_id` | TEXT — minted at enqueue so the cockpit can deep-link before the run starts |
| `adw_name` | TEXT — the ADW script to run, e.g. `'adw_scout'` |
| `agent` | TEXT — `adw_prompt`'s `--agent`; NULL for multi-agent ADWs |
| `request` | TEXT — the prompt/ask |
| `config` | TEXT — roster config path; NULL = the worker's default |
| `status` | TEXT DEFAULT `'queued'` — `queued -> claimed -> running -> done \| failed \| canceled` |
| `requested_by` | TEXT — operator who enqueued it |
| `cancel_requested` | INTEGER DEFAULT 0 — cooperative cancel flag the worker polls |
| `pid` | INTEGER — the worker-spawned adw pid (also tracked in `processes`) |
| `exit_code` | INTEGER |
| `error` | TEXT |
| `enqueued_at`, `claimed_at`, `started_at`, `ended_at` | TEXT |

`queue.py` also defines status constants (`QUEUED`, `CLAIMED`, `RUNNING`, `DONE`, `FAILED`,
`CANCELED`, `TERMINAL = frozenset({DONE, FAILED, CANCELED})`) and the worker-facing helpers
`ensure_schema`, `claim_next` (atomic claim via a guarded `UPDATE ... WHERE status='queued'`),
`mark_running`, `mark_terminal`, `cancel_requested` — not part of the `Tracer` class itself
but part of the same seam.

**`workers`** (DDL owned by `workers.py`, appended after `run_queue`) — the per-project worker
liveness heartbeat. Each `adw_worker.py` upserts a row every poll into its **own** repo's
`sssf.db`, so the heartbeat stays per-project; the cockpit reads the freshest `last_seen_at` to say,
honestly, whether a worker is attached ("no worker attached" is a real state, not a guess). Written
by the worker, read by the cockpit — engine-owned, like `processes`. See
[09-distribution.md](09-distribution.md) §7 for the supervisor that drives it.

| column | type |
| --- | --- |
| `host` | TEXT — machine the worker runs on |
| `pid` | INTEGER — the worker process id (`os.getpid`) |
| `started_at` | TEXT — when this worker began draining (fixed for its life) |
| `last_seen_at` | TEXT — refreshed every poll; freshness = attached |
| PRIMARY KEY | `(host, pid)` |

`workers.py` also exposes the worker-side helpers `ensure_schema`, `identity` (`(host, pid)`),
`heartbeat` (the per-poll upsert), `clear` (drop this row on graceful exit), and `clear_host` (sweep
a crashed predecessor's rows at startup) — part of the same seam, not the `Tracer` class.

Per [AGENTS.md](../AGENTS.md), this schema is mirrored in the cockpit at
`cockpit/lib/types.ts` (row interfaces) and `cockpit/lib/schemas.ts` (Zod validators +
`TABLE_COLUMNS`) — any change here must be mirrored in both, or Python/TS drift silently
corrupts the reader. See [06-cockpit.md](06-cockpit.md) for how the cockpit reads this schema
and [08-extending-the-system.md](08-extending-the-system.md) for the step-by-step recipe for
changing it.

## 7. `MIGRATIONS`

`tracer.py:95-100`:

```python
MIGRATIONS = [("agent_sessions", "color", "TEXT"),
              ("gate_results", "checks_json", "TEXT"),
              ("sessions", "adw_name", "TEXT"),
              ("agent_sessions", "context_tokens", "INTEGER"),
              ("agent_sessions", "context_window", "INTEGER"),
              ("sessions", "archived", "INTEGER DEFAULT 0")]
```

Each tuple is `(table, column, type_decl)`. `_migrate()` (`tracer.py:116-121`) reads `PRAGMA
table_info({table})` for existing columns and issues `ALTER TABLE {table} ADD COLUMN
{column} {decl}` for anything missing — additive-only, since `CREATE TABLE IF NOT EXISTS`
never revisits an existing table. It runs on every `Tracer.__init__`, so an older `sssf.db`
self-upgrades on next open. The cockpit mirrors this list as `MIGRATION_COLUMNS` in
`scripts/check-contract.ts` — keep both lists in sync when adding a migration.

## 8. `git_helper.py` — low-level git ops for code phases

Internal helper `_git(*args: str) -> str` (`git_helper.py:9-13`) runs `subprocess.run(["git",
*args], capture_output=True, text=True)` **against the process's current working
directory** — no explicit `cwd=` is passed anywhere in this module — raising
`RuntimeError(f"git {' '.join(args)} failed: {stderr}")` on nonzero exit, returning stripped
stdout on success. **Every function in this module inherits this cwd behavior.** A caller
that needs git run against a specific directory must `os.chdir` or otherwise arrange the cwd
itself before calling into this module — this matters for anyone changing where the engine's
processes execute from.

| function | signature | behavior |
| --- | --- | --- |
| `current_branch` | `() -> str` | `git rev-parse --abbrev-ref HEAD` |
| `create_branch` | `(name: str) -> str` | `git checkout -b <name>`, returns `name` |
| `is_repo` | `() -> bool` | `git rev-parse --git-dir`, returncode-checked directly (does **not** go through `_git`, so it never raises — a plain boolean probe) |
| `repo_root` | `() -> Path` | the git toplevel (`git rev-parse --show-toplevel`, resolved absolute) when `is_repo()` is true, else `Path.cwd().resolve()`. This is what `Run.__init__` calls to set `self.repo_root` — per [AGENTS.md](../AGENTS.md), this is why `engine/` is not a nested repo: `repo_root()` resolves to the atelier git root, so agent write-boundary checks (`writes:` allowlists) are repo-root-relative |
| `commit_all` | `(message: str) -> str` | raises if not a repo (with an actionable message to `git init`); `git add -A`; raises `"nothing to commit"` if `git status --porcelain` is empty after staging; `git commit -m <message>`; returns the new short sha |
| `changed_files` | `() -> list[str]` | parses `git status --porcelain`, strips the status-code prefix |
| `ref_exists` | `(ref: str) -> bool` | `git rev-parse --verify --quiet {ref}^{commit}`, returncode-checked directly — "this is a question," per its docstring, so it never raises |
| `rev` | `(ref: str = "HEAD") -> str` | `git rev-parse <ref>` |
| `short_sha` | `(ref: str = "HEAD") -> str` | `git rev-parse --short <ref>` |
| `merge_base` | `(ref: str, other: str = "HEAD") -> str` | `git merge-base <ref> <other>` — the commit where the two diverged. On the base branch itself this returns HEAD (so the diff becomes "what is not committed yet"); off it, the diff covers the whole branch plus the working tree — one command covers both cases |
| `is_dirty` | `() -> bool` | `bool(git status --porcelain)` |
| `untracked_files` | `() -> list[str]` | `git ls-files --others --exclude-standard` |
| `diff_files` | `(base: str) -> list[str]` | `git diff --name-only <base>` |
| `diff_stat` | `(base: str) -> str` | `git diff --stat <base>` |
| `diff_counts` | `(base: str) -> tuple[int, int]` | parses `git diff --numstat <base>`, summing insertions/deletions; a `-` (binary marker) counts toward neither |
| `diff_text` | `(base: str) -> str` | `git diff <base>`, full text |

The "diff plumbing" functions (`ref_exists` through `diff_text`) are composed by
`adw_modules/changes.py` into a `ChangeSet`/`BaseRef` (`data_types.py:177-219`) for
documentation phases.

## 9. `utils.py` — small shared helpers

The module loads `.env` at import time via `load_dotenv()` (`utils.py:13`).

| function | signature | behavior |
| --- | --- | --- |
| `operator_env` | `() -> dict[str, str]` | returns a copy of `os.environ` with the `uv run` venv stripped back out: pops `VIRTUAL_ENV`, and if it was set, removes `{VIRTUAL_ENV}/bin` from `PATH`. ADWs launch under `uv run`, whose ephemeral venv (holding the ADW's own deps) gets prepended to `PATH`; without stripping it, any subprocess an agent spawns would silently resolve inside that venv instead of the operator's real environment. Only ever handed to **child processes** — never mutates the ADW's own `os.environ` |
| `new_id` | `(length: int = 8) -> str` | `secrets.token_hex(length // 2)`. Default produces an 8-hex-char id from 4 random bytes. Used for `adw_id` (length 8), `event_id` (`new_id(12)`), `envelope_id` (`new_id(12)`) |
| `now_iso` | `() -> str` | `datetime.now(timezone.utc).isoformat(timespec="milliseconds")` — always UTC, millisecond precision, used as the timestamp for every trace write |
| `ensure_dir` | `(path: str \| Path) -> Path` | `Path(path).mkdir(parents=True, exist_ok=True)`, returns the `Path` |
| `resolve_prompt` | `(arg: str) -> str` | CLI convenience: if `arg` is a path to an existing file, returns its contents; otherwise (or on `OSError`) returns `arg` verbatim as inline prompt text. Used by every ADW's `__main__` block |
| `engineer_name` | `() -> str` | resolution order: (1) `$ENGINEER_NAME` env var if set and non-blank; (2) `git config user.name` (5s timeout, swallows `OSError`); (3) fallback to `$USER` or the literal string `"engineer"` |

## 10. Killed-run trace finalization

Python's default SIGTERM handling just exits the process without unwinding any
`try/finally` or context-manager stack, so `kill <pid>` against a running ADW would leave
its `sessions.status` reading `'running'` forever, and its `processes` rows would stay open
(`ended_at IS NULL`) — the trace would claim work is in flight that's actually dead
(`session.py:23-29`).

`_finalize_when_killed(run)`, installed at the end of `session.ensure` (so it's active for
the whole life of the run, before any phase opens):

```python
def _finalize_when_killed(run: Run) -> None:
    def handler(signum, _frame):
        run.tracer.session_finish(run.adw_id, ok=False)   # also closes process rows
        raise SystemExit(128 + signum)

    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, handler)
```

- Registered for both `SIGTERM` and `SIGINT`.
- The handler calls `tracer.session_finish(adw_id, ok=False)` synchronously, inside the
  signal handler — which sets `sessions.status='fail'`, `ended_at=now_iso()`, and calls
  `processes_end_all(adw_id)` to close every open `processes` row for the run.
- It then `raise SystemExit(128 + signum)` — the conventional shell exit-code encoding for
  "killed by signal N" (143 for SIGTERM, 130 for SIGINT). Raising `SystemExit` lets normal
  Python exception propagation continue: if the process was inside an open `with
  run.phase(...)` block at the moment of the signal, that context manager's `except
  BaseException` branch still fires, marking that specific phase `status="fail"` with an
  error message and tracing `error`/`phase_end` events for it — a kill mid-phase leaves both
  the phase-level and session-level trace rows honestly closed out, not just the session row.

`Run.phase`'s exception handling and `session.py`'s signal handling are two halves of the
same "success must be earned, and failure must always be recorded" story — the former ends
phase-level state on unwind, the latter ensures a SIGTERM/SIGINT actually triggers an unwind
at all instead of a silent kill.

This is distinct from `adw_worker.py`'s cooperative cancel (`run_queue.cancel_requested`,
per [AGENTS.md](../AGENTS.md)'s "Cancel = SIGTERM the process group") — the worker sends the
SIGTERM; it's *this* handler in the ADW subprocess itself that turns that signal into an
honest trace close-out. See [07-operations.md](07-operations.md) for the worker/queue side
of this.

## Extending this subsystem

- **Adding a trace column or table.** The seam must be mirrored in three places at once:
  `tracer.py` (`SCHEMA` and/or `MIGRATIONS` for an additive column on an existing table),
  `cockpit/lib/types.ts`, and `cockpit/lib/schemas.ts` (plus `MIGRATION_COLUMNS` in
  `scripts/check-contract.ts` if it's a migration). Run `pnpm check:contract` after. The
  full step-by-step recipe lives in [08-extending-the-system.md](08-extending-the-system.md).
- **Adding a `Tracer` write method.** Follow the pattern in §6: mint any id via `new_id`,
  stamp timestamps via `now_iso`, execute directly against `self.conn` (autocommit, no
  explicit transaction), and decide upfront whether it needs to also append to
  `events_jsonl` (only `event()` does today).
- **Adding a phase kind.** `PhaseKind` in `data_types.py:16` is a closed `Literal` — extending
  it means updating the literal, `Console.KIND_COLOR`, and any code that branches on kind
  (e.g. `PhaseHandle.call`'s `kind != "agent"` guard). See
  [08-extending-the-system.md](08-extending-the-system.md) before doing this — it's a wider
  change than a schema column.
