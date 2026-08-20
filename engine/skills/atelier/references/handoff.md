# Handoff Reference

The envelope schema, the two-channel output contract, and the session directory layout — how context transfers in code, not in conversation.

## Two output channels, exactly

An agent may produce output in two ways and no others:

1. **Reference files** written into `context_handoff/` — plans, notes, artifacts for the agents that follow.
2. **A final valid-JSON response** — the envelope, its direct response and nothing else.

Code does the rest: parse the response against the output type the call declared, persist it as `envelope.json`, and inject it into the next agent's user prompt.

## Envelope schema

Every output type extends `EnvelopeBase`:

```python
class EnvelopeBase(BaseModel):
    status: Literal["success", "fail"]  # the only required field
    summary: str = ""                   # one sentence: what happened
    artifacts: list[str] = []           # paths written, usually inside context_handoff/
    notes_for_next_agent: str = ""      # what the next agent must know
```

`status` is load-bearing: an envelope that parses but reports `status="fail"` raises, failing the phase. An agent declaring its own failure is not a successful phase.

The starter types in `adw_modules/data_types.py`:

```python
class GenericOutput(EnvelopeBase):
    """Fallback for an agent with no sharper contract yet."""

class PlanOutput(EnvelopeBase):
    commit_message: str = ""            # full message (subject in the repo's convention + body) for the PLAN FILE itself

class BuildOutput(EnvelopeBase):
    changed_files: list[str] = []
    commit_message: str = ""            # full message (subject + body); feeds the commit phase and a landed PR's title/description

class ScoutOutput(EnvelopeBase):
    findings: list[ScoutFinding] = []   # ScoutFinding: {file: str, note: str}

class ReviewOutput(EnvelopeBase):
    approved: bool = False              # the verdict; status is only "did the review run"
    findings: list[ReviewFinding] = []  # ReviewFinding: {requirement, met: bool, evidence}
    blocking: list[str] = []            # what must change before approval

class DocumentOutput(EnvelopeBase):
    document_path: str = ""             # the write-up's home in the repo
    documented_files: list[str] = []
    commit_message: str = ""
```

`commit_message` defaults to empty, so a git phase consuming it always needs a fallback — see `cookbooks/create_adw.md`.

**Each `commit_message` describes its own agent's work product, never the next one's**: `PlanOutput`'s covers the spec file, `BuildOutput`'s the code, `DocumentOutput`'s the write-up. A chain that commits once can use whichever fits; a chain that commits per step (`adw_simple_sdlc.py`) needs all three, and reusing one agent's sentence for another's diff is how a commit log starts lying.

**It is a full message, not a bare subject.** The agent writes a subject line in the *repository's* commit convention (from the injected project guidance — Conventional Commits where the project uses them) plus a blank line and a short body. `git commit -m` keeps the newlines, so when a sandbox lands via `gh pr create --fill`, the subject becomes the PR title and the body its description. A one-line `commit_message` therefore lands a PR with a non-conventional title and no description — the fix is the message, not the land hook.

There is no test output type: running the suite is a `kind="code"` phase, and its `QualityResult` reaches the next agent through `quality.as_envelope`.

Two of these are adapters rather than agent reports — code shaped as an envelope so an agent can be handed a deterministic result through the same door: `VerifyOutput` (a lint/test block's result) and `ChangesOutput` (a captured `git diff`, from `changes.as_envelope`). The consuming agent cannot tell the difference, which is the point.

The envelope is a **manifest of claims**. Gates verify those claims after the fact — declared artifacts exist and are non-empty, declared changes appear in the diff, declared tests actually pass. See `cookbooks/update_modules.md`.

## The typed-output rule

**Every agent call passes a concrete output type**, and the agent's final JSON is parsed against exactly that type. No untyped handoffs.

```python
plan = ph.call(AgentCall(output_type=PlanOutput, prompt=prompt,
                         gates=[gates.artifacts_exist]))
```

The user prompt asks for the shape; the type enforces it. They always travel as a pair, which is what lets one agent serve many calls — same system prompt, different user prompt + output type per call site. Output types live in code, never in `sssf.config.yaml`.

**Parse failure is not a restart.** If the response doesn't parse or doesn't validate, the harness re-prompts the **same session** with a correction naming the required fields — bounded by `JSON_FIX_ATTEMPTS` in `agents.py` (2). Gate violations use the identical mechanism, bounded instead by the phase's `retries`. A cold restart would throw away the context that produced the near-miss.

Re-prompting is backend-neutral: an agent call re-prompts within the agent's **live session**, so running an agent and continuing it are the same call with the same id. Each backend keeps its own session state internally — `agent_cc.run` mirrors `agent_pi.run`'s contract exactly — so the harness never distinguishes create from continue. Before parsing, it also tolerates a fenced `json` code block or prose wrapped around the object — but the prompt still asks for bare JSON, and every failed attempt is persisted as an invalid envelope row.

## Injecting the previous envelope

`prompts.py` renders the agent's `user.md`, substituting:

| Placeholder | Value |
|---|---|
| `{{prompt}}` | the engineer's ask (or the ADW's per-call prompt) |
| `{{previous_envelope}}` | the upstream envelope JSON, from `AgentCall(previous=...)` |
| `{{context_handoff_dir}}` | absolute path to this session's `context_handoff/` — the **trace** root (`SSSF_TRACE_ROOT`, the shared main repo under a sandbox run) |
| `{{repo_root}}` | absolute path to the codebase being worked in — the **execution** root (cwd; the worktree under a sandbox run). Repo copies (`specs/`, `app_docs/`) must anchor here, not at `context_handoff_dir`, or a sandboxed run writes them into the wrong tree |

**The execution root is also stated outright, in every agent's system prompt.** `agents.py`
appends an "# Execution root" block (`execution_root_notice`, off `run.repo_root`) last, after the
project guidance - so it applies to every agent and every ADW whether or not a prompt template
references `{{repo_root}}`. Without it the only absolute path an agent held was
`context_handoff_dir`, and agents generalised from it: a sandboxed planner did its whole recon in
the main repo, reading the base branch instead of the worktree's. `cwd` does not save you - an
agent that writes an absolute path never consults it. The notice carves out `context_handoff_dir`
by name - it may sit outside the execution root and stays the agent's write target, used verbatim -
so it does not fight the read-only agents' "handoff dir is your only write target" rule. Prompt
authors still need the two-roots rule above for anything they anchor themselves.

A `user.md` declares one h3 per incoming datum, then the task, then the output contract:

````markdown
# Scout Task

## Variables

### prompt

{{prompt}}

### previous_envelope

{{previous_envelope}}

### context_handoff_dir

{{context_handoff_dir}}

## Task

Find what `prompt` asks about. Write findings into `context_handoff_dir`, then emit your `Report` JSON.

## Report

Respond with ONLY valid JSON matching `ScoutOutput` — no prose before or after:

```json
{
  "status": "success",
  "summary": "<one sentence on what you found>",
  "findings": [
    { "file": "src/server.ts", "note": "<why this file matters>" }
  ],
  "artifacts": ["<context_handoff_dir>/scout_findings.md"]
}
```
````

The `## Report` section shows the exact JSON shape of the declared output type — that is the agent's output contract, and it lives in `user.md` because the shape belongs to the *use*, not the identity. The matching `system.md` stays static: Purpose + Instructions only.

## Session directory layout

```
adws/adw_data/sessions/{adw_id}/
├── agent_map.json          agent name → coding-agent session_id + model
├── context_handoff/        the ONE place agents write files for the agents that follow
└── {agent_name}/
    ├── prompts/            exact prompts sent (system.md + user.md), saved before execution
    ├── {backend}_sessions/ the backend's own session state for this agent (pi writes pi_sessions/)
    ├── raw_output.jsonl    full JSONL stream from the coding agent, appended live
    └── envelope.json       the final valid-JSON response — captured, validated, persisted by code
```

`session.ensure(cfg, adw_id)` mints or joins the id and creates these dirs. One `context_handoff/` per session, shared by every agent — the single location for cross-agent files. Each backend keeps its own per-agent session state under this directory; the exact folder is the backend's business (a `pi`-backed agent writes `pi_sessions/`, a `claude_code`-backed agent keeps its own equivalent).

## agent_map.json and resuming

```json
{
  "planner": {"session_id": "sssf-a1b2c3d4-planner-9f2e",
              "model": "anthropic/claude-sonnet-5", "coding_agent": "claude_code"},
  "builder": {"session_id": "sssf-a1b2c3d4-builder-71ac",
              "model": "anthropic/claude-sonnet-5", "coding_agent": "claude_code"}
}
```

This map is the key that lets a later ADW rejoin each agent's **existing context window**. Run `adw_build.py --adw-id a1b2c3d4` after `adw_plan.py` and the builder resumes its own session rather than starting cold.

The map records the model each session was created with. If config drift changes an agent's model, that agent starts a **fresh** session and the map is updated — never a bad resume. `agent_sessions` in `sssf.db` is the queryable mirror of this file.

**Files are the raw record; the db is the queryable mirror.** Losing `sssf.db` loses nothing that can't be rebuilt from `raw_output.jsonl`, `envelope.json`, and `agent_map.json`.
