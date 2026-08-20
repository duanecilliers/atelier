# Agents and gates

This doc covers everything that happens between an ADW calling `ph.call(AgentCall(...))` and
the validated envelope that call returns: agent resolution, the three coding-agent backends,
typed envelopes, gates, the write-boundary enforcement, and the deterministic `quality.py`
blocks. It assumes you've read [README.md](README.md) and
[01-architecture.md](01-architecture.md) — the "agents propose, deterministic code disposes"
boundary and the `sssf.db` seam. This doc is the mechanics of that boundary's *propose* half
and the deterministic checks that gate it.

All references are to `engine/adws/adw_modules/{agents,agent_pi,agent_cc,gates,permissions,
quality,data_types}.py`.

## 1. `agents.execute()` — the per-call flow

Every agent call in an ADW goes through `agents.execute(run, phase, call) -> EnvelopeBase`
(`engine/adws/adw_modules/agents.py`). Before any of that, two things happen once per ADW
process:

- `load_config(path)` reads `sssf.config.yaml`, back-fills each agent's `coding_agent`,
  `model`, `thinking`, `color`, `tools`, `writes` from `defaults` (only where the agent doesn't
  already set them), and validates the whole tree as an `SSSFConfig` via Pydantic.
- `validate(cfg, required)` fail-fasts: resolves every agent name the ADW declares it needs,
  checks `coding_agent` is `"pi"` or `"claude_code"`, checks both prompt files exist on disk,
  and — for `pi` agents — checks the model pattern resolves against pi's catalog
  (`agent_pi.resolve_model`). One `SystemExit` bullets every problem found. Nothing spawns
  against a half-valid config.

`execute()` itself:

1. **Resolve the agent.** `agent = resolve(run.cfg, phase.params.owner)` — `phase.params.owner`
   is the agent name from the roster.
2. **Render prompts.** Builds a `variables` dict (`prompt`, `previous_envelope` — the prior
   envelope JSON-dumped or the literal `"(none)"`, `context_handoff_dir`), renders
   `system.md`/`user.md` via `prompts.render(...)`, and persists both under the agent's session
   directory.
3. **Mint or rejoin a session.** `_agent_session_id(run, agent)` looks up `run.agent_map` by
   agent name; if an entry exists **and** its recorded model matches the current config, the
   same `session_id` is reused (rejoining context from an earlier phase in the same run).
   Otherwise it mints `sssf-<adw_id>-<agent_name>-<random>`.
4. **Emit `agent_start`** with the resolved model/thinking/color/tools/coding_agent.
5. **Snapshot the tree.** `tree_before = permissions.snapshot(run)` — taken before the first
   send, the baseline for the write-boundary check (§6).
6. **First send.** `result = send(user_text)` through the `send()` closure (below).
7. **Parse.** `envelope, attempt = _parse_with_retries(...)` turns the raw response into
   `call.output_type` (§4), with bounded same-session retries on malformed JSON.
8. **Gate loop**, up to `phase.params.retries + 1` attempts (§5): every gate in `call.gates`
   runs against the envelope; violations are sent back into the *same session* as a correction
   prompt and re-parsed; once retries are exhausted with violations still outstanding, raises
   `GateFailure`.
9. **Permission enforcement**, after every send is done, before the envelope is accepted:
   `touched = permissions.enforce(run, phase, agent, tree_before)`. A breach re-raises and
   aborts the phase — this is not a gate, see §6.
10. **Persist the envelope** (`_persist_envelope`) — a tracer row plus `envelope.json` on disk.
11. **Trace bookkeeping** — `agent_session_row` (context occupancy from the most recent send),
    `run.save_agent_map(...)` (so a later phase reusing this agent name rejoins the session), a
    `handoff` event (`artifacts` + `summary`), and an `agent_end` event whose `tokens`/`cost`
    are the **phase total** across every send (first prompt + every JSON-fix and gate-correction
    retry) — "a retried phase paid for every attempt."
12. If `envelope.status != "success"`, raises `RuntimeError`. Otherwise returns the validated
    envelope.

### The `send()` closure

Every LLM turn in the phase — the first prompt, JSON-fix retries, gate corrections — goes
through one closure:

- Builds a `PiRequest` (§4) with absolute `session_dir`/`raw_output_path`, `cwd=str(run.repo_root)`.
- Picks the backend: `backend = agent_cc if agent.coding_agent == "claude_code" else agent_pi`.
- Calls `backend.run(request, on_event=..., on_spawn=..., on_exit=...)`.
- Accumulates usage across the whole phase (`spent.merge(result.usage)`, a module-local
  `UsageBreakdown`) and tracks the most recent `PiResult` for later context-occupancy reporting.

### `AgentCall`

```python
class AgentCall(BaseModel):
    output_type: Type[EnvelopeBase]
    prompt: str
    previous: Optional[EnvelopeBase] = None
    gates: list[Callable] = Field(default_factory=list)  # gate(envelope, run) -> GateReport|list[str]
```

`execute()` returns an instance of whatever `call.output_type` names — e.g. `PlanOutput`,
`BuildOutput` — fully validated and past all its gates.

### Internals worth knowing

- `_as_report(result)` normalizes a gate's return value: passthrough if already a `GateReport`,
  otherwise wraps a legacy `list[str]` into one failing `GateCheck` per item.
- `_event_forwarder(run, phase, agent_name)` wraps one `agent_pi.ToolCallTracker()`; completed
  tool calls become `tool_call` `EventRecord`s in the trace.
- `_extract_json(text)` pulls a JSON object from free text — prefers the first fenced
  ` ```json ` block, else the substring between the first `{` and last `}`.
- `_parse_with_retries` loops `JSON_FIX_ATTEMPTS = 2` extra times (3 tries total): extract JSON,
  `call.output_type.model_validate(payload)`; on failure, persists an invalid envelope row and
  sends a correction listing the required field names back into the same session.

## 2. The three backends

`agent_pi.py`, `agent_cc.py`, and `agent_cursor.py` expose the **identical** contract:

```python
def run(request: PiRequest,
        on_event: Optional[Callable[[dict], None]] = None,
        on_spawn: Optional[Callable[[int], None]] = None,
        on_exit: Optional[Callable[[int], None]] = None) -> PiResult
```

`agents.py` picks between them purely on `agent.coding_agent` (routed via config — see
[05-config-and-roster.md](05-config-and-roster.md)). Because all three take the same `PiRequest`
input, return the same `PiResult`, and accept the same three callbacks, `execute()` is entirely
backend-agnostic — it doesn't know or care which one actually ran.

### `agent_pi.py` — the pi CLI backend

- Resolves `request.model` against pi's merged catalog (`resolve_model`, matches by exact
  `model_id` or unambiguous substring) and looks up its context window
  (`context_window(provider, model_id)`, falling back from `PI_MODELS_PATH` to the catalog's
  count column, `0` if neither has it).
- Spawns `pi -p --mode json --provider <p> --model <m> --thinking <t> --session-id <sid>
  --session-dir <dir> --system-prompt <text> [--tools ...] <prompt>` via `Popen(stdin=DEVNULL,
  ...)`. **The `DEVNULL` stdin is deliberate** — inheriting the parent's stdin risks the child
  seeing a non-TTY and blocking forever on piped input that never arrives, observed in practice
  as a run sitting idle at 0% CPU with an empty `raw_output.jsonl`.
- Streams stdout line by line, writing every raw line to `raw_output_path` as it arrives,
  capturing the last assistant `message_end` as `result.text`, and folding usage in via
  `UsageBreakdown.add_turn` — but only updates `context_tokens` when the turn actually had
  tokens and wasn't aborted/errored (an aborted turn's usage can't be trusted).
- `ToolCallTracker` folds pi's `toolCall` block plus the `tool_execution_start/_update/_end`
  triple into one normalized record, emitted at `tool_execution_end`.

### `agent_cc.py` — the Claude Agent SDK backend

- Authenticates via the local `claude` CLI's own login — **no API key** — so Anthropic models
  work here even when pi's own auth doesn't (see the machine gotcha below).
- `TOOL_MAP` translates pi tool names to Claude Code tool names (`read→Read`, `bash→Bash`,
  `edit→Edit`, `write→Write`, `grep→Grep`, `find→Glob`, `ls→Bash`); pi's `subagent_*` extension
  tools have no CC equivalent and are silently dropped.
- A module-level `_SDK_SESSIONS` map ties Atelier's synthetic `session_id` to the SDK's real
  session uuid, so later sends in the same phase (JSON-fix retries, gate corrections) resume
  the same SDK context.
- Calls the SDK with `permission_mode="bypassPermissions"` (headless — no interactive approval
  prompt) and `setting_sources=[]` (no ambient CLAUDE.md/project skills leaking in, for
  determinism). **Bypassing the SDK's own permission prompt does not bypass Atelier's
  write-boundary check** — `permissions.enforce()` still runs after the send, so a bypassed CC
  write outside the allowlist is rolled back and fails the phase exactly like a `pi` breach
  would; the determinism spine is unchanged (§6).
- Re-emits Claude Agent SDK messages (`AssistantMessage`/`ToolUseBlock`,
  `UserMessage`/`ToolResultBlock`, `ResultMessage`) as synthesized `tool_execution_start`/`_end`
  events shaped exactly like pi's, so the same `ToolCallTracker` handles every backend
  unmodified.
- `on_spawn`/`on_exit` are accepted for interface parity but never called — the SDK owns the
  `claude` subprocess and doesn't expose its pid.
- Reuses `agent_pi.context_window("anthropic", model_id)` for the context ceiling, since Claude
  models share pi's model registry.

### `agent_cursor.py` — the Cursor CLI backend

- Authenticates via the local `cursor-agent login` — **no API key** — reaching Cursor's whole
  model surface (Anthropic, OpenAI, Grok, Kimi, Composer) under one subscription. Models use the
  `cursor/` namespace; `_model_id` strips it before passing to `--model`.
- Spawns `cursor-agent -p --output-format stream-json --model <m> --force --sandbox disabled
  --trust --workspace <cwd> [--resume <sid>] <prompt>` via `Popen(stdin=DEVNULL, cwd=repo_root)`,
  like `pi` — so `on_spawn`/`on_exit` **are** wired (a hung cursor agent is a killable pid, unlike
  CC). `--force --sandbox disabled --trust` is the headless posture; `permissions.enforce()` still
  runs after the send, so the write boundary is unchanged (§6).
- **No `--system-prompt` flag**, so `_compose_prompt` carries the agent's system prompt *in* the
  prompt (`# System instructions … # Task …`). The envelope's `_extract_json` still recovers the
  Report JSON from the tail of the response.
- A module-level `_CURSOR_SESSIONS` map ties Atelier's synthetic `session_id` to Cursor's real
  session uuid (captured from the `system/init` and `result` events), so later sends in the same
  phase resume via `--resume`.
- Re-emits Cursor's `tool_call` started/completed events (nested `{<name>ToolCall: {args, result}}`)
  as `tool_execution_start`/`_end` in pi's shape; `_slim_args` drops Cursor's bulky shell parse
  tree so the trace stays readable.
- **Two bounded degradations.** Cursor reports no per-call cost, so `cost` is always `0` (tokens
  are exact, read off the terminal `result.usage`). And because usage arrives *only* on that
  terminal event, there is no mid-run occupancy to measure — `context_kill_threshold` is inert, so
  a cursor builder relies on the cooperative handoff (the same "usage only on the terminal event"
  case `agent_cc.py` documents). `context_window` is `0` (Cursor exposes no catalog).

### Machine gotcha

pi's Anthropic OAuth is expired on this machine, so `pi` can currently only run
`openai-codex/*` models. Routing an `anthropic/*` model through `coding_agent: pi` fails with
pi's own auth error. This is exactly why `agent_cc.py` exists: Claude models are dispatched
through `coding_agent: claude_code` instead, authenticating via the local `claude` CLI login.
Also, pi 0.81.1 ships no `~/.pi/agent/models.json`, so `engine/.env` sets `PI_MODELS_PATH` to a
committed stub. See [05-config-and-roster.md](05-config-and-roster.md) for how `coding_agent`
routing is configured per agent.

## 3. Typed envelopes

Every agent's final response is parsed against one `EnvelopeBase` subclass
(`call.output_type.model_validate(payload)`).

### `EnvelopeBase` — shared by every output type

| field | type | default |
|---|---|---|
| `status` | `Literal["success", "fail"]` | required |
| `summary` | `str` | `""` |
| `artifacts` | `list[str]` | `[]` |
| `notes_for_next_agent` | `str` | `""` |

### Subclasses

| type | extra fields | notes |
|---|---|---|
| `GenericOutput` | — | catch-all |
| `PlanOutput` | `commit_message` | subject is committing the plan spec file, not the implementation it describes |
| `BuildOutput` | `changed_files`, `commit_message` | `commit_message` consumed by the git commit phase |
| `ScoutOutput` | `findings: list[ScoutFinding]` | `ScoutFinding` = `file` (required), `note` |
| `ReviewOutput` | `approved: bool`, `findings: list[ReviewFinding]`, `blocking: list[str]`, `checks_executed: bool`, `checks_note` | `ReviewFinding` = `requirement` (required), `met: bool` (required), `evidence`. `checks_executed` is evidence, not verdict: it says whether this reviewer ran the project's checks, so an ensemble synthesizer can outrank a reviewer that did over one that could not. Default `false` - a reviewer that says nothing has shown no check evidence |
| `DocumentOutput` | `document_path`, `documented_files`, `commit_message` | |
| `ChangesOutput` | `base`, `changed_files`, `insertions`, `deletions`, `stat`, `diff_path` | built by **code**, not an agent |
| `VerifyOutput` | `passed: bool`, `failures: list[str]` | built by **code**, not an agent |

`ChangesOutput` and `VerifyOutput` are never filled by a model — deterministic code (`quality.py`,
change-capture code) constructs them directly, so a deterministic result "flows back into the
builder through exactly the same door an agent's report would" (§7).

### Validation mechanics

Parsing happens in `_parse_with_retries`: extract a JSON object from the raw text
(`_extract_json`), then `call.output_type.model_validate(payload)` — standard Pydantic
validation, so any type mismatch or missing required field raises. There's no partial
acceptance: an envelope either validates cleanly against the declared type, or the phase fails
after `JSON_FIX_ATTEMPTS` (2, so 3 tries total) are exhausted.

## 4. Gates

A gate is `gate(envelope, run) -> GateReport` — one check per item it looked at. Gates check
what's mechanically checkable; plan/code **quality** is a reviewer's job, not a gate's.

| gate | checks |
|---|---|
| `artifacts_exist` | every path in `envelope.artifacts` exists on disk |
| `artifacts_within_handoff` | every declared artifact resolves **inside** the session's `context_handoff/` dir. Wire it **only on read-only phases** (scout, reviewer, `writes: []`): a read-only agent's report belongs in the handoff dir, so an artifact elsewhere means it wrote into the repo — which `permissions.enforce` would roll back and hard-fail (§6). This turns that into a re-promptable correction that tells the agent to write under the handoff dir and remove the stray copy. An edit-capable agent legitimately writes artifacts into the repo, so it is **not** wired there |
| `files_non_empty` | every existing artifact file has nonzero size (skips missing ones — existence is `artifacts_exist`'s job) |
| `json_parses` | every `.json`-suffixed artifact that exists parses via `json.loads` |
| `diff_matches_claims` | every path in `envelope.changed_files` exists (no-op on envelope types without that field, e.g. `PlanOutput`) |
| `verdict_consistent` | for `ReviewOutput`-shaped envelopes: approval must not ship `blocking` items or unmet findings; a rejection must name a problem; and a `checks_executed: true` claim must name what ran in `checks_note`, since that flag is what a synthesizer weighs reviewers on. Checks the envelope's own internal consistency — never reads the diff |
| `tests_pass(command)` | factory — returns a gate that shells out to `command` and checks `returncode == 0`; failure note includes the last 1000 chars of stdout+stderr |

`tests_pass` is the one gate that shells out; it's simpler than the `quality.py` blocks (§7),
which capture full artifacts and run unconditionally as a phase rather than per-envelope.

### How gates plug into `execute()`

Each `call.gates` entry runs as `gate(envelope, run)`; `_as_report()` normalizes the return
value into a `GateReport`. A gate row is recorded **per attempt** in the tracer regardless of
outcome — "a green gate says WHAT it verified instead of only that it passed." Violations across
all gates in a phase are concatenated; if any exist and retries remain, they're sent back into
the *same agent session* as a correction prompt (bounded by `phase.params.retries`); once
exhausted, `GateFailure` is raised and the phase fails.

## 5. Permissions / the write boundary

`tools:` in the roster is a capability list, not a sandbox — `bash` can run `git checkout
adws/` and discard uncommitted work; `write` reaches any path even when an agent was only meant
to write one report file. So permission is verified **after the fact**, by diffing the working
tree.

- `permissions.snapshot(run)` fingerprints every path the tree currently differs on (relative
  to `run.repo_root`): tracked files via `git diff HEAD --numstat` (insertions,deletions as the
  fingerprint, so edits to an already-dirty file still register), untracked files via `git
  ls-files --others --exclude-standard`. Gitignored paths never appear.
- `permissions.enforce(run, phase, agent, before)` re-snapshots, diffs against `before` to get
  `touched`, and checks each touched path against `permitted(path, agent, cfg)`:
  1. Always-writable session runtime (`cfg.defaults.data_dir`) → allowed. Every agent, however
     restricted, can write its own prompts, `raw_output.jsonl`, `envelope.json`, and
     `context_handoff/` — "a read-only agent is read-only with respect to the REPO, never with
     respect to its own report."
  2. Path matches something in `agent.writes` → allowed (naming a path can override
     `protected_files`).
  3. Path matches `cfg.defaults.protected_files` → denied.
  4. Otherwise: allowed iff `agent.writes is None` (`None` = unrestricted; `[]` = no repo writes
     at all; a list = only those paths — trailing `/` is a directory prefix, `*`/`?` glob,
     otherwise exact match).
- **A breach is not a gate.** It cannot be corrected by re-prompting because the write already
  happened. `enforce` rolls back every breaching path via `_roll_back` (reverts a tracked file
  with `git checkout --`, deletes a newly-created untracked file, and — if the path was already
  dirty *before* the agent ran — leaves it as-is or reports
  `"REVERTED-BY-AGENT (uncommitted work lost, cannot restore)"` if the agent reverted the
  operator's own uncommitted work), then raises `PermissionBreach` naming every offending path
  and its rollback outcome. This aborts the phase.
- If no breach, `enforce` returns `touched` — everything the agent legitimately changed — which
  `execute()` records as a `paths_touched` event, "so the trace records what an agent actually
  touched rather than only what it claimed in its envelope."

`git` in `permissions.py` always runs with `cwd=run.repo_root` — consistent with the repo's
git-root anchoring (see [AGENTS.md](../AGENTS.md)). Config keys: `defaults.protected_files` and
`agents[].writes` — see [05-config-and-roster.md](05-config-and-roster.md) for the full roster
schema.

## 6. `quality.py` — deterministic lint/test/typecheck/build

The counterpart to agent judgement: "a known command is not a judgement call... it runs in
milliseconds, costs nothing, and returns the same answer every time." Every block ships as an
`echo` placeholder (`_placeholder(name)`); wiring a real repo means replacing each
`_placeholder(name)` call with the real `argv` list — always a list, never a shell string, to
avoid quoting bugs and shell injection — calling binaries by bare name so `operator_env()`
resolves them the way the operator's own shell would (no hard-coded absolute paths).

- `_run(spec, run)` runs `subprocess.run(spec.argv, cwd=run.repo_root, env=operator_env(),
  capture_output=True, text=True, timeout=spec.timeout_seconds)`. A timeout maps to
  `returncode=124`; a missing binary (`OSError`) maps to `returncode=127` — "no pre-flight probe
  needed, and none wanted." Full output is logged to `command.log` under
  `run.context_handoff_dir/quality/<seq>_<name>/`; a `tool_call` event
  (`quality:<name>`) is recorded either way.
- Four blocks: `test`, `lint`, `typecheck`, `build` — all placeholders as shipped. Note: `test`'s
  event `operation` is literally tagged `"build"` in the code, not `"typecheck"`/`"lint"`.
- `run_tests(run)` runs just `test` — "what replaces a `tester` agent once the command is
  written down."
- `as_envelope(result, what)` adapts a `QualityResult` to `VerifyOutput` (§3):
  `status="success"` iff `result.passed`; on failure, `notes_for_next_agent` tells the builder
  to trust the deterministic result over any summary. This is how a failing quality run "flows
  back into the builder through exactly the same door an agent's report would."
- `run_quality(run)` runs all four blocks unconditionally; a failing block does **not** fail the
  phase by itself — the result is handed to the builder, and the bounded repair loop decides
  the run's fate.

## 7. Extending this subsystem

- **Add a gate** — write `gate(envelope, run) -> GateReport` in `gates.py`, pass it in
  `AgentCall.gates`. It runs per attempt and re-prompts the same session on violation.
- **Add an envelope type** — subclass `EnvelopeBase` in `data_types.py`.
- **Add a coding-agent backend** — mirror the `run(request, on_event, on_spawn, on_exit) ->
  PiResult` contract in `agent_pi.py`/`agent_cc.py`, and re-emit tool calls in pi's event shape
  (`tool_execution_start`/`_end`) so `ToolCallTracker` handles them unmodified.
- **Wire a real quality command** — replace the `_placeholder(name)` argv in `quality.py` with
  the project's actual lint/test/typecheck/build invocation.

Full recipes and worked examples live in [08-extending-the-system.md](08-extending-the-system.md).
