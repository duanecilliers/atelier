# Update Config

Add or retune agents in `sssf.config.yaml` — by hand, or through the cockpit's roster editor (surgical, comment-preserving writes).

## Retune model or thinking

Edit the agent's entry in place:

```yaml
  - name: builder
    model: anthropic/claude-sonnet-5   # ALWAYS provider/model-id
    thinking: high                     # was medium
```

Write the model as `provider/model-id`, never a bare id. The same model is usually carried by several providers, and an ambiguous pattern raises in `agents.validate()` — grounding every agent that inherits it. See `references/config.md`.

Thinking levels are a neutral thinking-budget ladder: `off | minimal | low | medium | high | xhigh | max`. Both backends honor it — `claude_code` maps it to Claude's thinking budget, `pi` to its reasoning-effort control (there it only bites when the model is registered with `reasoning: true`; on a non-reasoning model the setting is inert).

**A model change means a fresh session.** `agent_map.json` records the model each coding-agent session was created with. When a joined run (`--adw-id`) finds the config's model no longer matches the recorded one, that agent starts a **new** session rather than resuming — the map is updated, never a bad resume. Thinking changes do not invalidate a session; model changes do. Expect the agent to lose its accumulated context window on the first run after the change.

Note: any `anthropic/*` model is always run through `claude_code`. `agents.py::load_config` forces `coding_agent: claude_code` for Anthropic models regardless of what the entry says, so you never need to set `coding_agent` when picking a Claude model.

## Recolor an agent's lane

```yaml
  - name: builder
    color: "#22d3ee"      # hex; the starter roster ships violet/cyan/amber/green
```

Purely cosmetic and safe to change mid-project: the color rides the `agent_start` event and the `agent_sessions` row, so the cockpit picks it up on the next run without touching past sessions. Omit the key to let the cockpit's fallback palette choose.

## Retune tools

The core tool names are `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`. Under the `pi` backend the last three (`grep`, `find`, `ls`) are **off by default**, so a pi-backed agent that doesn't name them will shell out through `bash` to search and list; naming them makes those calls cheaper and more legible in the trace.

Set the roster-wide floor in `defaults`, then narrow per agent:

```yaml
defaults:
  tools: [read, bash, edit, write, grep, find, ls]

agents:
  - name: reviewer
    tools:                # explicit list wins over defaults
      - read
      - grep
      - find
      - ls
      - bash
      - write
```

**Resolution:** the agent's own list wins → else it inherits `defaults.tools` → else `None`, meaning all tools. An empty list is not "all tools"; it is a tool-less agent, and it will stall.

Narrow by role, not by reflex:

- Any agent that must produce a `context_handoff/` artifact needs **`write`** — without it, it falls back to a `bash` heredoc to create the file the gate checks for.
- Withhold `edit`/`write` only where the restriction *is* the guarantee. The reviewer's contract is "change nothing", so withholding `edit` makes that structural instead of merely prompted.
- Recon agents should get the full read surface (`read`, `grep`, `find`, `ls`) — cheaper and more legible in the trace than the equivalent `bash` calls.

## Add harness extensions (pi only)

```yaml
    harness_engineering:
      - .pi/extensions/json_guard.ts    # a pi extension FILE PATH
```

Harness extensions are a **pi-backend** mechanism: entries are pi extension **file paths**, passed through as `pi -e <path>`, applied to that agent only. Reach for an output-tightening extension when a pi agent keeps wrapping its envelope in prose and burning correction retries. The starter roster ships with none — this is an escape hatch, not a default. `claude_code` agents need no harness extension for this; leave `harness_engineering` empty for them.

**Adding a tool-registering pi extension is a two-part edit.** The extension path goes in `harness_engineering`, *and* the tool name it registers goes in that agent's `tools` list:

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
      - ast_query                       # REQUIRED — or the extension loads and its tool is filtered out
```

Skip the second half and it fails silently: extension loaded, run green, tool never available to the model. Extensions that only shape output or register flags — no new tool — need no `tools` change.

## Add a new agent

Three steps, all required — skipping any one fails `agents.validate()` at ADW startup, before anything spawns:

1. **Prompts.** Create `adws/adw_data/prompt_engineering/{name}/system.md` (Purpose + Instructions — the agent's static identity, nothing else) and `user.md` (an h3 per incoming datum: `{{prompt}}`, `{{previous_envelope}}`, `{{context_handoff_dir}}`, then the task, then a `## Report` section showing the exact output JSON). Copy an existing pair as the shape.
2. **Config entry.** Name, purpose, prompt refs, plus anything that differs from `defaults`.
3. **An output type.** Every agent call parses against a concrete Pydantic model in `adw_modules/data_types.py`. If none of `PlanOutput`, `BuildOutput`, `ScoutOutput`, `ReviewOutput`, `DocumentOutput` fits the new agent's report, add one — see `update_modules.md`. The user prompt's `Report` section must show exactly that JSON shape.

Then name the agent in an ADW's `REQUIRED_AGENTS` and call it.

## Rules that do not bend

- ADW scripts name **agents**, never models. Swapping a model is a config edit and touches no Python.
- One agent, one prompt, one purpose. If an entry needs two purposes, it is two agents.
- Output types never appear in config — they live at the call site, paired with the user prompt.

Full spec: `references/config.md`.
