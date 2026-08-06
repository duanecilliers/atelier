# Create Config

Author `sssf.config.yaml` — the agent roster for this repo.

## Write it

There is no generator script. Create `adws/adw_sssf_config/sssf.config.yaml` by hand from the schema below, **or** use the **cockpit's roster editor** (surgical, comment-preserving writes) to build it through the UI. Either way it lands at the same path.

That path — `adws/adw_sssf_config/sssf.config.yaml` — is the default every ADW and the justfile look for; `--config` overrides it. The starter roster wires the usual agents (planner, builder, scout, reviewer, documenter) to the prompt files under `adws/adw_data/prompt_engineering/`. Retuning an existing roster is a hand edit (or a cockpit edit) — see `update_config.md`.

## The rule

**One agent, one prompt, one purpose.** An entry defines who an agent *is*: its coding agent, model, thinking level, and exactly one system prompt plus one user prompt. How it gets *used* — the output type, a per-call user prompt override — lives at the ADW call site, never here.

## Schema

```yaml
defaults:
  coding_agent: claude_code        # claude_code (default) | pi — see references/config.md
  model: anthropic/claude-sonnet-5 # ALWAYS provider/model-id — a bare id is ambiguous
  thinking: medium                 # off | minimal | low | medium | high | xhigh | max
  harness_engineering: []          # per-agent harness extensions (pi only)
  data_dir: adws/adw_data          # runtime home: {data_dir}/sessions/{adw_id}/{agent_name}/

observability:
  db: adws/adw_data/sssf.db        # tracer writes here; the cockpit reads it
  poll_ms: 500                     # cockpit live-poll cadence

agents:
  - name: planner                  # ADW scripts name agents, never models
    coding_agent: claude_code
    model: anthropic/claude-sonnet-5
    thinking: high
    color: "#a78bfa"               # optional hex — this agent's lane color in the cockpit
    purpose: Turn a request into a plan the builder can implement without asking questions.
    prompt_engineering:
      system: adws/adw_data/prompt_engineering/planner/system.md
      user: adws/adw_data/prompt_engineering/planner/user.md

  - name: scout
    thinking: high                 # unset keys fall through to defaults
    purpose: Find and report where things live; change nothing.
    prompt_engineering:
      system: adws/adw_data/prompt_engineering/scout/system.md
      user: adws/adw_data/prompt_engineering/scout/user.md
    tools:                         # optional allowlist — omit the key entirely for all tools
      - read
      - bash
```

Every agent entry merges over `defaults`, so an entry only states what differs. The core tool names are `read`, `bash`, `edit`, `write` (plus `grep`, `find`, `ls`) — a read-only recon agent gets `[read, bash]`; a builder omits `tools` altogether.

## After writing

1. Each agent needs its prompt pair to exist on disk: `adws/adw_data/prompt_engineering/{name}/system.md` and `user.md`. `agents.validate()` fails the run at startup if either is missing.
2. Write `purpose` as one sentence and make the system prompt say the same thing — the two should not drift.
3. Validate by running the smallest ADW that names your agents; a bad entry fails fast, before anything spawns.

Full field-by-field spec, thinking-level mapping, and model resolution: `references/config.md`. Retuning an existing roster: `update_config.md`.
