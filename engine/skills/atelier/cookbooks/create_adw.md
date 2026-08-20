# Create ADW

Compose a new ADW script — a thin, deterministic Python workflow over agents already in the config. Design the chain first, then hand-write it from the skeleton.

## Step 1 — Design the chain

Answer four questions, in order:

1. **What agents, in what order?** Pick from the roster (`adws/adw_sssf_config/sssf.config.yaml`). The starter six cover most chains:

| Agent | Use when | Output type | Typical gates |
|---|---|---|---|
| `scout` | you need to FIND something first — read-only recon | `ScoutOutput` | `artifacts_exist` |
| `planner` | the work needs a plan before code changes | `PlanOutput` | `artifacts_exist`, `files_non_empty` |
| `builder` | code must change | `BuildOutput` | `diff_matches_claims` |
| `reviewer` | the change must be confirmed to BE what was asked for | `ReviewOutput` | `artifacts_exist`, `verdict_consistent` |
| *(no tester)* | verifying that it RUNS is a `kind="code"` phase over `quality.py`, not an agent | `QualityResult` → `as_envelope` | the exit code is the check |
| `documenter` | finished work needs a write-up (runs after a build, off the diff) | `DocumentOutput` | `artifacts_exist`, `files_non_empty` |
| any agent, generic ask | one-off prompt, no special shape | `GenericOutput` | as needed |

   A new kind of agent needs a config entry + prompt pair + output type first — see `update_config.md`.

   **The suite and the reviewer answer different questions.** "Does it run" is a test, and code can ask that. "Is this the thing that was asked for" is a review, and only an agent can. A green suite over a feature nobody requested is still a failed request, and neither one covers for the other.

2. **Where does code act?** Git branch/commit, migrations, deploys each get their own `kind="code"` phase — never buried inside an agent phase.

   **Running the suite is one of these — there is no tester agent.** The command is written down in `quality.py`, so a `kind="code"` phase runs it (`quality.run_tests(run)` → `quality.as_envelope(result, "tests")` back into the builder) and the bounded repair loop is unchanged. An agent rediscovering the test command on every run buys nothing the subprocess does not already know from config - and it no longer has to: the `quality:` argv is rendered into every agent's system prompt as a `# Project checks` section, so an agent that needs one check to settle a claim uses the gate's own entrypoint rather than inventing one. Capturing what changed is one of these: `changes.capture(run, ChangeCapture(base="main"))` diffs the working tree against a resolved base, writes `context_handoff/changes.diff`, and `changes.as_envelope(...)` hands it to the next agent. A diff is two git commands, not a judgement call.

3. **Does anything loop?** Test-fix cycles are bounded fix loops (see `update_adw.md`), not phase retries.

4. **What does each call need to prove?** Pick gates per call from `gates.py`: `artifacts_exist`, `files_non_empty`, `json_parses`, `diff_matches_claims`, `tests_pass("cmd")` — or an inline one-off.

## Step 2 — Ownership rules (the swim lanes depend on these)

- `kind="agent"` → `owner` MUST be an agent name from the config — it selects the harness (model, thinking, tools, prompts) AND the lane. `ph.call()` runs whoever owns the phase.
- `kind="engineer"` → `owner=run.engineer`. Every ADW opens with the engineer request phase — it is the system input record.
- `kind="code"` → `owner` is a short actor label (`"git"`, `"db"`); all code phases share the code lane.
- Phase `name` must be unique within the run (`plan`, `build`, `test_1`, `fix_1`, …) — the UI keys blocks on it.
- **`description` is required and must earn its place.** The name identifies the phase; the description explains it — what this phase does and why, in one sentence. It rides the `phase_start` event and is the only line of intent the trace, the console, and the phase block ever show. `PhaseParams` raises at construction on a blank description *or* one that merely restates the name (`commit_plan: "Commit the plan"`), so the rule fails before the phase opens rather than leaving an unreadable run in the db. Write `"Put the spec on record before any code exists to blur it"` instead.
- `retries=N` on an **agent** phase = extra gate-correction rounds re-sent into the same session (the agent re-prompts within its live session, so its context stays intact).

## Step 3 — Write it

There is no generator script. Author `adws/adw_<name>.py` by hand from the canonical skeleton below: one agent phase per name, chained by `previous=`, starter agents mapped to their output types and anything one-off to `GenericOutput`. Create the config entries and prompt files first (`update_config.md`), or `agents.validate()` will stop the run at startup and tell you what's missing. `SSSF_ADWS_DIR` overrides where a new ADW is written. The cockpit also offers an ADW-builder surface and a read-only Skills-Cookbook page (a grid of the repo's `adw_*.py` recipes) if you'd rather scaffold through the UI, but the by-hand path is primary.

## The canonical skeleton

Every `adw_*.py` is a `uv` single-file script with this shape:

```python
#!/usr/bin/env -S uv run
# /// script
# dependencies = ["pydantic", "python-dotenv", "pyyaml", "rich"]
# ///
"""ADW Plan Build — plan the request, then implement the plan."""

import argparse
import sys

from adw_modules import agents, gates, git_helper, session, utils
from adw_modules.data_types import AgentCall, BuildOutput, PhaseParams, PlanOutput

REQUIRED_AGENTS = ["planner", "builder"]        # names, never models


def main(prompt: str, config: str = "adws/adw_sssf_config/sssf.config.yaml", adw_id: str | None = None) -> int:
    cfg = agents.load_config(config)            # 1. point to config
    agents.validate(cfg, REQUIRED_AGENTS)       # 2. fail fast — nothing spawns on a half-valid config
    run = session.ensure(cfg, adw_id)           # 3. pin-or-create the session → the Run object

    with run.phase(PhaseParams(name="request", kind="engineer", owner=run.engineer,
                               description="Capture the incoming ask")) as ph:
        ph.log(input=prompt)

    with run.phase(PhaseParams(name="plan", kind="agent", owner="planner",
                               description="Turn the request into an implementable plan")) as ph:
        plan = ph.call(AgentCall(output_type=PlanOutput, prompt=prompt,
                                 gates=[gates.artifacts_exist, gates.files_non_empty]))

    with run.phase(PhaseParams(name="build", kind="agent", owner="builder", retries=1,
                               description="Implement the plan exactly")) as ph:
        build = ph.call(AgentCall(output_type=BuildOutput, prompt=prompt, previous=plan,
                                  gates=[gates.diff_matches_claims]))

    with run.phase(PhaseParams(name="commit", kind="code", owner="git",
                               description="Commit the working tree")) as ph:
        message = build.commit_message or f"sssf({run.adw_id}): {build.summary}"
        ph.log(sha=git_helper.commit_all(message), message=message)

    return run.finish()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prompt", help="inline text or a path to a prompt file")
    parser.add_argument("--config", default="adws/adw_sssf_config/sssf.config.yaml")
    parser.add_argument("--adw-id", default=None, help="join or pin an existing session")
    args = parser.parse_args()
    sys.exit(main(utils.resolve_prompt(args.prompt), args.config, args.adw_id))
```

## Non-negotiables

- **`REQUIRED_AGENTS` + `agents.validate()`** — declare every agent name the script uses and validate before the first phase.
- **Every agent call declares a concrete output type** from `data_types.py`. No untyped handoffs.
- **`previous=` carries the chain** — the upstream envelope lands in the next agent's `user.md` as `{{previous_envelope}}`; bulky context moves through `context_handoff/` files the envelope references.
- **The engineer request phase comes first**, always.
- **Four-param rule** — `run.phase()` and `ph.call()` each take exactly one object; new helpers with >4 params get a data type.
- **Stay thin** — sequencing and acceptance only; real logic goes in `adw_modules/` (`update_modules.md`).
- **Committing is a code phase, and it needs a fallback.** `PlanOutput`, `BuildOutput`, and `DocumentOutput` each carry a `commit_message` the agent writes **for its own work product** — the spec, the code, the write-up. It defaults to empty, so always `envelope.commit_message or <fallback>`, and commit each product with the message of the agent that made it (`adw_simple_sdlc.py` commits three times and never crosses them). `git_helper.commit_all(message)` stages everything, commits, and returns the short sha; it raises a clear error when the cwd isn't a git repo or nothing changed, and that raise fails the phase.

## Concurrent phases - `run.fan_out()`

The default is sequential: `run.phase()` runs one phase, and any exception inside
it finalizes the WHOLE run (right for a linear chain). When you need N **independent**
agent phases at once - an ensemble of blind reviewers, parallel scouts - use
`run.fan_out()` instead:

```python
branches = [
    (PhaseParams(name=f"review_{name}", kind="agent", owner=name,
                 description="Rule on every requirement against the code on disk"),
     lambda ph, name=name: ph.call(AgentCall(output_type=ReviewOutput, prompt=prompt,
                                              previous=previous, gates=REVIEW_GATES)))
    for name in ["pr_reviewer_1", "pr_reviewer_2", "pr_reviewer_3"]
]
results = run.fan_out(branches)                 # each branch in its own thread
reviews = [r.value for r in results if r.ok]    # BranchResult: .ok / .value / .error
```

Rules that make it correct:
- **Threads, not asyncio** - the Claude SDK runs `asyncio.run()` inside each call,
  so each branch needs its own event loop (an OS thread). `fan_out` handles that.
- **A branch failure is a RESULT, not a teardown.** A raising branch becomes a
  failed phase + `BranchResult(error=…)`; it does **not** call `session_finish` or
  abort its siblings. **You** rule on the collected results at `run.finish()`
  (e.g. decline only when zero survived).
- **Independence is by identity.** Give each branch a **distinct** `owner` (agent
  name) so it gets its own blind coding-agent session + `agent_sessions` row. N
  copies of one name would share (and overwrite) one session.
- **Per-identity artifacts.** Prompts several parallel identities share must write
  to a per-name file - the reviewer prompt uses `review-{{agent_name}}.md`
  (the `{{agent_name}}` template var is the invoking agent's name) so concurrent
  writers never clobber one shared path.
- The synthesizer/barrier phase after the fan-out is a **normal sequential
  `run.phase()`** - hand it the branch envelopes (packed into its prompt) and let
  it consolidate.

Exemplars: `adw_ensemble_review.py` (review-only) and `adw_build_ensemble_review.py`
(build → fan-out review → synthesize → bounded revise).

## Before you ship it

1. `uv run adws/adw_<name>.py "a tiny real request"` — watch it go green end to end.
2. Check the trace: `sqlite3 adws/adw_data/sssf.db "select seq,name,kind,owner,status from phases where adw_id='<id>' order by seq;"`
3. Read the final `envelope.json` — is the output type earning its fields, or should it be sharper?
