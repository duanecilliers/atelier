# Config Reference

The full `sssf.config.yaml` spec: every field, how defaults merge, and how model / thinking / tools / extensions map onto the coding agent.

It lives at **`adws/adw_sssf_config/sssf.config.yaml`** — the default path every `adw_*.py` and the justfile resolve. Pass `--config <path>` to any ADW (or set `SSSF_CONFIG` for the justfile) to run against a different roster. Author it by hand or through the cockpit's roster editor.

## Shape

```yaml
defaults:
  coding_agent: claude_code
  model: anthropic/claude-sonnet-5      # ALWAYS provider/model-id
  thinking: medium
  harness_engineering: []
  tools: [read, bash, edit, write, grep, find, ls]
  data_dir: adws/adw_data

observability:
  db: adws/adw_data/sssf.db
  poll_ms: 500

agents:
  - name: planner
    coding_agent: claude_code
    model: anthropic/claude-sonnet-5      # ALWAYS provider/model-id
    thinking: high
    color: "#a78bfa"
    purpose: Turn a request into a plan the builder can implement without asking questions.
    prompt_engineering:
      system: adws/adw_data/prompt_engineering/planner/system.md
      user: adws/adw_data/prompt_engineering/planner/user.md
    tools:
      - read
      - bash
```

## Fields

### `defaults`

| Field | Type | Meaning |
|---|---|---|
| `coding_agent` | `claude_code` \| `pi` | Which backend runs the agent. **Both are real.** `claude_code` is the default (drives Claude via the `claude-agent-sdk`); `pi` drives non-Anthropic models via the `pi` CLI. Any `anthropic/*` model is always forced to `claude_code` — see Backends below. |
| `model` | string | Model id, always `provider/model-id`. Default `anthropic/claude-sonnet-5` (run through `claude_code`, no API key). |
| `thinking` | enum | Thinking budget — see below. Default `medium`. |
| `color` | hex string | Lane color for every agent that does not set its own. Default empty — the cockpit falls back to its own palette. |
| `harness_engineering` | list[string] | Per-agent harness extensions. `pi`: extension file paths. `claude_code`: none needed — leave empty. |
| `tools` | list[string] | Roster-wide tool allowlist. Every agent that omits its own `tools` inherits this. Unset = all tools usable. |
| `protected_files` | list[string] | Paths **no** agent may modify unless it names them in its own `writes`. Default: `adws/adw_modules/`, `adws/adw_sssf_config/`, `adws/adw_*.py` — an agent must not be able to edit the machinery that decides whether its work passed. |
| `data_dir` | path | Runtime home. Sessions land at `{data_dir}/sessions/{adw_id}/{agent_name}/`. Default `adws/adw_data`. |

### `observability`

| Field | Type | Meaning |
|---|---|---|
| `db` | path | SQLite trace db. `tracer.py` writes it directly; the cockpit reads it. Default `adws/adw_data/sssf.db`. |
| `poll_ms` | int | Cockpit live-poll cadence in ms. History uses the same queries, lazy-paged. Default `500`. |

### `agents[]`

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | The identifier ADW scripts use. **ADWs name agents, never models.** |
| `purpose` | yes | One sentence: what this agent is for. Should match its `system.md` Purpose. |
| `prompt_engineering.system` | yes | Path to the system prompt — who the agent is, its single purpose, its output contract. |
| `prompt_engineering.user` | yes | Path to the default user prompt — the task template with `{{prompt}}`, `{{previous_envelope}}`, `{{context_handoff_dir}}`. |
| `color` | no | Hex swatch (`"#a78bfa"`) for this agent's lane in the cockpit. Travels config → `agent_sessions.color` → `/api/sessions/:adw_id`, and rides the `agent_start` event so a lane is colored while the agent is still running. Unset = the cockpit's fallback palette. |
| `coding_agent`, `model`, `thinking`, `color`, `harness_engineering` | no | Override the corresponding `defaults` key. |
| `tools` | no | Allowlist. **Omitting the key means all tools usable.** A capability list, not a boundary — see `writes`. |
| `writes` | no | What this agent may modify **in the repo**, enforced after every call. Omitted = unrestricted (still barred from `protected_files`). `[]` = no repo writes at all. A list = only those paths: a trailing `/` is a directory prefix, `*` matches within one path segment, `**` crosses segments, anything else is an exact path. Naming a `protected_files` path here is what unlocks it. **The session runtime under `data_dir` is always writable** — `writes: []` means read-only with respect to the repo, not unable to write its own report. |

Output types are deliberately absent: config defines who an agent *is*; the ADW call site defines how it's *used*. One agent serves many calls — same system prompt, different user prompt + output type per call.

## Backends

Both coding-agent backends are real and interchangeable behind one abstraction (`agent_cc.run` mirrors `agent_pi.run`'s contract):

- **`claude_code`** (default) drives Claude via the `claude-agent-sdk`, authenticating with the local **`claude` CLI login — no API key**. It runs in isolation (`setting_sources: []`), so no ambient CLAUDE.md or skills leak in.
- **`pi`** drives non-Anthropic models (e.g. `openai-codex/*`) via the `pi` CLI, authenticating from `~/.pi/agent`.

Two behaviors are worth pinning down:

- **Anthropic is always `claude_code`.** `agents.py::load_config` forces `coding_agent: claude_code` for any `anthropic/*` model, overriding even an explicit `coding_agent: pi`. pi no longer supports Anthropic at all, so a roster cannot mis-route it — a stray `coding_agent: pi` on an Anthropic agent is silently corrected at load.
- **Repo guidance reaches `claude_code` agents.** Because the SDK runs in isolation, `agents.execute` injects the repo-root guidance file — `AGENTS.md`, else `CLAUDE.md` — into a `claude_code` agent's system prompt, so it sees this project's own conventions. `pi` discovers `AGENTS.md`/`CLAUDE.md` from the working directory natively and is left untouched.

## Defaults merging

`agents.py` merges each entry **over** `defaults`, key by key. An entry states only what differs; anything unset inherits. `agents.validate(cfg, REQUIRED_AGENTS)` then confirms every name an ADW declares exists, resolves to a usable coding agent + model, and has both prompt files present on disk. Any miss fails the run immediately — **no agent is ever spawned against a half-valid config.**

## Thinking levels

The thinking-budget ladder, lowest to highest:

```
off | minimal | low | medium | high | xhigh | max
```

Both backends honor it: `claude_code` maps it to Claude's thinking budget, `pi` to its reasoning-effort control. Under `pi` it only bites when the model is registered with `reasoning: true`; on a non-reasoning model the setting is inert — no error, no effect. Rough guidance: `high`/`xhigh` for planners and reviewers, `medium` for builders, `low` for mechanical read-and-report agents.

## Model resolution

**Always write `model` as `provider/model-id`.** How the string is resolved depends on the backend `agents.py` picks:

- **`claude_code` / Anthropic** (`anthropic/claude-sonnet-5`, `anthropic/claude-haiku-4-5`, …) resolves against the local `claude` CLI login. **No API key** and no model catalog file are involved.
- **`pi` / non-Anthropic** (`openai-codex/*`, `google/...`, etc.) resolves against pi's merged catalog — its built-in providers plus any `~/.pi/agent/models.json`. `pi --list-models` is the catalog the resolver actually reads.

The catalog step is where ambiguity can bite. The same model is often carried by more than one provider (`gemini-3.6-flash` lives under `google` *and* under `openrouter` as `google/gemini-3.6-flash`), and a bare id that matches several **raises at resolution**:

```
agent 'scout': model pattern 'gemini-3.6-flash' is ambiguous:
  [('google', 'gemini-3.6-flash'), ('openrouter', 'google/gemini-3.6-flash'), ...]
```

That is `agents.validate()` doing its job — it fails before anything spawns rather than silently billing the wrong provider — but it means every agent inheriting that default is grounded until the pattern is qualified. Qualifying is the whole fix: `google/gemini-3.6-flash`, `openai/gpt-5.6-terra`, `fireworks/accounts/fireworks/models/kimi-k3`. The leading segment is matched against the provider list first, so the rest of the string can contain slashes.

Other consequences worth knowing:

- A pi-backed model must be in the catalog before any agent can name it. An unknown id fails at resolution, before spawn.
- **Ambiguity can appear without you touching the config.** Registering a new provider that carries a model you already use turns a formerly-fine bare pattern ambiguous. If a roster stops validating and nobody edited it, that is why. (This is a pi-catalog concern; `claude_code`/Anthropic models are not resolved this way.)
- Provider credentials for pi-backed models come from the environment, not the config — the key that matches the provider you named (`GEMINI_API_KEY` for `google/...`, `OPENROUTER_API_KEY` for `openrouter/...`). The default `claude_code` roster needs no such key; only a pi-backed non-Anthropic agent does.
- The resolved model is recorded per session in `agent_map.json` and mirrored into the `agent_sessions` table. **Changing an agent's model invalidates its session**: a joined run starts that agent fresh instead of resuming a context window built by a different model.

## Tools

`tools` is the agent's tool allowlist. The core tool names:

| Tool | Purpose | pi's own default |
|---|---|---|
| `read` | read file contents | on |
| `bash` | execute bash commands | on |
| `edit` | find/replace edits | on |
| `write` | create/overwrite files | on |
| `grep` | search file contents | **off** |
| `find` | find files by glob | **off** |
| `ls` | list directory contents | **off** |

Under the `pi` backend, `grep`, `find`, and `ls` are off by default, so a pi-backed agent that does not name them will shell out through `bash` to do the same work. The starter roster therefore sets `defaults.tools` to all seven and lets each agent narrow from there.

**Resolution order:** an agent's own `tools` list wins; an agent that omits the key inherits `defaults.tools`; if neither is set, `tools` stays `None` and all tools are usable. An empty list is not "all tools" — it is a tool-less agent, and it will stall.

## Write permissions — `writes` and `protected_files`

`tools` cannot express a safety boundary, because two of the tools are general
purpose. `bash` runs anything, including `git checkout`, which discards an
engineer's uncommitted work; `write` reaches any path, not only the one report
file an agent was granted it for. So "this agent changes nothing" is a claim a
tool list can state but never keep.

`adw_modules/permissions.py` keeps it, the same way every other claim in this
system is kept — after the fact, against the repo. Before an agent's first
prompt the working tree's change-set is fingerprinted; after its last send
(including JSON retries and gate corrections) it is fingerprinted again. Any
path that appeared, vanished, or changed is attributed to that agent.

Comparing change-sets rather than watching writes is deliberate: a path that was
modified before the agent ran and is clean afterwards has been **reverted**, and
a reversion is a modification. That is what catches `git checkout`.

A breach is not a gate violation. Gates are for work an agent can be asked to
redo; a write has already happened, so re-prompting fixes nothing. Instead:

1. every unauthorized change the agent **introduced** is rolled back — tracked
   files with `git checkout --`, untracked files by deletion;
2. a path that was **already dirty** before the agent ran is left untouched. The
   operator had uncommitted work there, and discarding it to tidy up would be
   the same harm this module exists to prevent;
3. the phase fails and names every path with what happened to it.

```yaml
defaults:
  protected_files: [adws/adw_modules/, adws/adw_sssf_config/, "adws/adw_*.py"]

agents:
  - name: builder      # no `writes` key -> unrestricted, minus protected_files
  - name: scout
    writes: []         # no repo writes; its findings still land in context_handoff/
  - name: planner
    writes: [specs/]
  - name: documenter
    writes: [app_docs/, docs/, "**/*.md", "*.md"]
```

**The session runtime under `data_dir` is always writable, for every agent.**
`context_handoff/` is how agents hand work to each other, and each agent's
prompts, `raw_output.jsonl`, and `envelope.json` sit beside it. That grant comes
from `data_dir` rather than from `.gitignore`: the runtime is normally ignored,
so it never even appears in a snapshot, but an agent's ability to record its own
work must not depend on a gitignore line someone can delete.

A read-only phase (scout, reviewer) also carries the `artifacts_within_handoff`
gate: every artifact it declares must resolve **inside** `context_handoff/`. An
artifact declared in the repo means the agent wrote there — which the write
boundary rolls back and hard-fails — so the gate catches the mis-declared path
first and re-prompts the agent to write under the handoff dir and remove the
stray copy. It is wired only on read-only phases; an edit-capable agent writes
artifacts into the repo by design.

Narrow by role, not by reflex. Anything that must produce a `context_handoff/` artifact needs `write`, or it will resort to a `bash` heredoc. Withhold `edit`/`write` only where the restriction *is* the guarantee — a reviewer that cannot edit cannot quietly fix what it was asked to report.

### Extension tools must be named explicitly (pi only)

Harness extensions are a `pi`-backend mechanism, and `pi --tools` is an allowlist over **built-in, extension, and custom tools alike** — not just builtins. So the moment a pi-backed agent has a `tools` list at all (its own, or one inherited from `defaults`), any tool registered by its `harness_engineering` extensions is **excluded unless it appears in that list by name**.

This fails quietly. The extension still loads, the run still succeeds, and the tool the extension exists to provide is simply never offered to the model — you find out by noticing the agent never called it.

```yaml
  - name: reviewer
    harness_engineering:
      - .pi/extensions/ast_query.ts     # registers tool: ast_query
    tools:
      - read
      - grep
      - find
      - ls
      - bash
      - ast_query                       # REQUIRED — the extension's tool, named or lost
```

Rule: **every entry in `harness_engineering` that registers a tool must have that tool name added to the agent's `tools` list.** Adding an extension is therefore a two-line change, never one. The alternative is dropping the `tools` key *and* leaving `defaults.tools` unset so the agent resolves to `None` (all tools) — but with a roster-wide `defaults.tools` in place, that escape hatch is closed; naming the tool is the only path.

## Harness engineering

`harness_engineering` is a `pi`-backend mechanism: entries are pi extension **file paths**, passed through as `pi -e <path>`, one flag per entry, scoped to that agent only. This is where per-agent harness changes live — e.g. an output-tightening extension for a pi agent that keeps wrapping its envelope in prose. The starter roster ships with none, and `claude_code` agents need none — leave the field empty for them.

**If the extension registers a tool, name that tool in the agent's `tools` list too** — `--tools` filters extension tools exactly like builtins, so an unnamed extension tool is silently unavailable no matter that the extension loaded fine. See [Extension tools must be named explicitly](#extension-tools-must-be-named-explicitly-pi-only) above. Extensions that only shape output or add flags (no tool registration) need no `tools` change.
