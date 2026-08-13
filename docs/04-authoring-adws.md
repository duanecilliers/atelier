# Authoring ADWs

An ADW ("AI Developer Workflow") is a self-contained [PEP 723](https://peps.python.org/pep-0723/)
`uv` script under `engine/adws/adw_*.py` that composes **phases** via the `Run` API. Every
phase is one of three `kind`s: `engineer` (records human intent — always the first phase,
`request`), `agent` (a model proposes, via `run.phase(...).call(AgentCall(...))`), or `code`
(deterministic disposition — commit, test/lint/build, diff capture). This document catalogs
every hand-written and generated ADW, the shared skeleton they follow, and how to add a new
one — either by generating it from the canonical block catalog or by hand for shapes the
generator can't express.

The phase primitive and `Run` API internals live in [02-engine-runtime.md](02-engine-runtime.md);
agent dispatch and gate mechanics live in [03-agents-and-gates.md](03-agents-and-gates.md).

## 1. The ADW catalog

All scripts live in `engine/adws/`. All take a positional `prompt` (inline text or a path to a
prompt file, resolved by `utils.resolve_prompt`), `--config` (default
`adws/adw_sssf_config/sssf.config.yaml`), and `--adw-id` (join/pin an existing session). None
expose a generic `--agent` flag except `adw_prompt.py`, which is the one ADW whose target agent
is chosen at the CLI rather than hard-coded into the phase chain.

| Script | Purpose | Phases composed (kind) | `--agent`? | Commits/writes? | CLI signature |
|---|---|---|---|---|---|
| `adw_prompt.py` | Smallest ADW: one agent, one prompt, traced end-to-end. | engineer(request) → agent(`<agent>`) | Yes, `--agent builder` (default `builder`) | No git commit; write scope depends on the chosen agent's config | `adw_prompt.py "<prompt>" [--agent builder] [--config …] [--adw-id …]` |
| `adw_scout.py` | Read-only recon — find where things live, change nothing. | engineer(request) → agent(`scout`) | No | Read-only (scout is configured `writes: []` in the roster) | `adw_scout.py "<prompt>" [--config …] [--adw-id …]` |
| `adw_build.py` | One-shot implementation, no plan/test/review loop. | engineer(request) → agent(`build`, owner=`builder`, retries=1) | No | Writes via `builder`'s `writes:`; no commit phase | `adw_build.py "<prompt>" [--config …] [--adw-id …]` |
| `adw_plan.py` | One-shot planning workflow — produces a spec, nothing else. | engineer(request) → agent(`plan`, owner=`planner`) | No | Writes only planning artifacts (e.g. `plan.md`); no commit | `adw_plan.py "<prompt>" [--config …] [--adw-id …]` |
| `adw_quality.py` | Run the deterministic lint/typecheck/build blocks and fail loudly if any fail. | engineer(request) → code(`quality`, owner=`quality`) | No (`REQUIRED_AGENTS = []`) | No agent writes; no commit; runs `quality.run_quality(run)` | `adw_quality.py "<reason>" [--config …] [--adw-id …]` |
| `adw_document.py` | Write up the work just done, from the diff since `--base`. | engineer(request) → code(`changes`, owner=`git`) → agent(`document`, owner=`documenter`, retries=1) | No | Writes only docs (`app_docs/`); no commit phase itself | `adw_document.py "<prompt>" [--base main] [--config …] [--adw-id …]` |
| `adw_plan_build.py` | Two-agent chain: planner → builder → commit. | engineer(request) → agent(`plan`) → agent(`build`) → code(`commit`, owner=`git`) | No | Commits everything unconditionally, using the builder's `commit_message` | `adw_plan_build.py "<prompt>" [--config …] [--adw-id …]` |
| `adw_build_test.py` | Implement, then verify; suite failures loop back into the builder (bounded). | engineer(request) → agent(`build`) → [code(`test_i`) ↔ agent(`fix_i`)] × ≤3 | No | Writes via builder; **no commit phase at all** | `adw_build_test.py "<prompt>" [--config …] [--adw-id …]` |
| `adw_build_review.py` | Implement, then confirm it's what was asked (spec-conformance, not tests). | engineer(request) → agent(`build`) → [agent(`review_i`) ↔ agent(`revise_i`)] × ≤3 | No | Writes via builder/reviewer's `writes:`; **no commit phase** | `adw_build_review.py "<prompt>" [--config …] [--adw-id …]` |
| `adw_ensemble_review.py` | Review-only **ensemble**: three independent reviewers rule **in parallel**, then a synthesizer consolidates. Judges the working tree (`git diff`), no builder. | engineer(request) → **[agent(`review_pr_reviewer_1‖2‖3`)]** (fan-out) → agent(`synthesize`) | No | Read-only (all `writes: []`); **no commit phase** | `adw_ensemble_review.py "<prompt>" [--config …] [--adw-id …]` |
| `adw_build_ensemble_review.py` | The ensemble twin of `adw_build_review`: build, then three reviewers **in parallel** + synthesize, bounded revise loop against the consolidated verdict. | engineer(request) → agent(`build`) → [ **[agent(`review_pr_reviewer_1‖2‖3`)]** (fan-out) → agent(`synthesize_i`) ↔ agent(`revise_i`) ] × ≤3 | No | Writes via builder; reviewers/synthesizer read-only; **no commit phase** | `adw_build_ensemble_review.py "<prompt>" [--config …] [--adw-id …]` |
| `adw_plan_build_test.py` | The "full starter chain": plan → build → bounded test/fix loop → commit only if green. | engineer(request) → agent(`plan`) → agent(`build`) → [code(`test_i`) ↔ agent(`fix_i`)] × ≤3 → code(`commit`, gated on `test.passed`) | No | Commits **only if tests pass**; a red suite leaves the tree uncommitted | `adw_plan_build_test.py "<prompt>" [--config …] [--adw-id …]` |
| `adw_plan_build_test_quality.py` | Plan → build → bounded verify+test loop (lint/typecheck/build/test as one block) → commit if verified. | engineer(request) → agent(`plan`) → agent(`build`) → [code(`verify_i`) ↔ agent(`fix_i`)] × ≤3 → code(`commit`, gated) | No | Commits only when `quality.run_quality` passes fully | `adw_plan_build_test_quality.py "<prompt>" [--config …] [--adw-id …]` |
| `adw_simple_sdlc.py` | The full SDLC: plan → commit_plan → build → bounded test/fix → bounded review/revise → conditional retest → commit_build → changes → document → commit_docs. | engineer(request) → agent(`plan`) → code(`commit_plan`) → agent(`build`) → [code(`test_i`) ↔ agent(`fix_i`)] × ≤3 → [agent(`review_i`) ↔ agent(`revise_i`)] × ≤2 → code(`retest`, conditional) → code(`commit_build`) → code(`changes`) → agent(`document`) → code(`commit_docs`) — all gated on `verified` | No | Three separate commits (plan, build, docs), each carrying its own agent's `commit_message`; gated on suite-green **and** review-approved | `adw_simple_sdlc.py "<prompt>" [--config …] [--adw-id …]` |
| `make_adw.py` (generator, not itself an ADW) | Generates a new `adw_<name>.py` from a validated subsequence of the block catalog (§3). | n/a — it emits source, doesn't run phases | No | Writes `engine/adws/adw_<name>.py` (or `$SSSF_ADWS_DIR`) | see §3 |

`adw_worker.py` (the launch-queue drainer) is out of scope here — see
[07-operations.md](07-operations.md).

Every script (including generated ones) begins with the identical PEP 723 shebang/header:

```python
#!/usr/bin/env -S uv run
# /// script
# dependencies = ["pydantic", "python-dotenv", "pyyaml", "rich", "claude-agent-sdk"]
# ///
```

which is why `uv run engine/adws/adw_*.py …` needs no separate install step.

## 2. The common structure of an ADW

Every hand-written ADW follows the exact same skeleton:

1. **Docstring** — one-line purpose + `Usage:` + a `Phases:` line (`engineer(request) -> …`)
   that the cockpit's `/skills` cookbook parses and renders as phase chips (`cockpit/lib/skills.ts`).
2. **Imports** — `argparse`, `sys`, then `from adw_modules import agents, session, utils` plus
   whichever of `gates`, `git_helper`, `quality`, `changes` the chain needs; typed envelopes
   from `adw_modules.data_types`.
3. **`REQUIRED_AGENTS` module constant** — the list of agent *names* (must resolve in the
   roster config) this ADW needs; `[]` for agent-free ADWs like `adw_quality.py`.
4. **`main(prompt, config=..., adw_id=None) -> int`**:
   - `cfg = agents.load_config(config)` — loads and Pydantic-validates `sssf.config.yaml` into
     an `SSSFConfig`.
   - `agents.validate(cfg, REQUIRED_AGENTS)` — fail-fast: every required agent name must
     resolve, use a supported `coding_agent` (`pi` or `claude_code`), and have its system/user
     prompt files present on disk. Raises `SystemExit` before anything spawns.
   - `run = session.ensure(cfg, adw_id)` — mints or joins an `adw_id`, opens the `Tracer`
     (writes to both JSONL and sqlite), installs SIGTERM/SIGINT handlers that finalize the
     trace on kill, and returns a `Run`.
   - Zero or more `with run.phase(PhaseParams(...)) as ph:` blocks — the one phase primitive.
   - `return run.finish(accepted=..., reason=...)` — exactly once, at the end.
5. **`if __name__ == "__main__":`** — `argparse.ArgumentParser(description=__doc__)`, then
   `prompt` (positional), `--config`, `--adw-id` (and `--agent`/`--base` on the two ADWs that
   need them), calling `main(utils.resolve_prompt(args.prompt), ...)` and `sys.exit`-ing the
   return code.

The `Run.phase()` context manager, `PhaseHandle.log`/`call`, and the description validator are
covered in [02-engine-runtime.md](02-engine-runtime.md).

### Representative simple ADW, in full — `adw_prompt.py`

```python
#!/usr/bin/env -S uv run
# /// script
# dependencies = ["pydantic", "python-dotenv", "pyyaml", "rich", "claude-agent-sdk"]
# ///
"""ADW Prompt — the smallest ADW: one agent, one prompt, traced end-to-end.

Usage:
    uv run adws/adw_prompt.py "<prompt or path/to/prompt.md>" [--agent builder] [--config adws/adw_sssf_config/sssf.config.yaml] [--adw-id a1b2c3d4]

Phases: engineer(request) -> <agent>
"""

import argparse
import sys

from adw_modules import agents, session, utils
from adw_modules.data_types import AgentCall, GenericOutput, PhaseParams


def main(prompt: str, agent: str = "builder",
         config: str = "adws/adw_sssf_config/sssf.config.yaml", adw_id: str | None = None) -> int:
    cfg = agents.load_config(config)
    agents.validate(cfg, [agent])
    run = session.ensure(cfg, adw_id)

    with run.phase(PhaseParams(name="request", kind="engineer", owner=run.engineer,
                               description="Capture the incoming ask")) as ph:
        ph.log(input=prompt)

    with run.phase(PhaseParams(name="prompt", kind="agent", owner=agent,
                               description=f"Send the request straight to {agent} and parse its envelope")) as ph:
        ph.call(AgentCall(output_type=GenericOutput, prompt=prompt))

    return run.finish()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prompt", help="inline text or a path to a prompt file")
    parser.add_argument("--agent", default="builder", help="agent name from the config")
    parser.add_argument("--config", default="adws/adw_sssf_config/sssf.config.yaml")
    parser.add_argument("--adw-id", default=None, help="join or pin an existing session")
    args = parser.parse_args()
    sys.exit(main(utils.resolve_prompt(args.prompt), args.agent, args.config, args.adw_id))
```

`adw_scout.py` (also worth reading for the read-only shape) is identical except
`REQUIRED_AGENTS = ["scout"]` is a module constant (not CLI-selectable), the phase name is
`"scout"`, the output type is `ScoutOutput`, and it passes `gates=[gates.artifacts_exist]` to
`AgentCall` — a **gate**, a deterministic post-check on the agent's claims (see
[03-agents-and-gates.md](03-agents-and-gates.md)).

## 3. The run-outcome contract

`run.finish(accepted=True, reason="")` evaluates two separate criteria together, exactly once:

- `phases_ok` — every phase in `run.phases` has `status == "success"` (and there is at least
  one phase);
- `accepted` — the ADW's own acceptance test, passed in by the caller (e.g.
  `test is not None and test.passed` in `adw_build_test.py`).

`ok = phases_ok and accepted`. A run whose test/fix loop ran cleanly but whose suite stayed red
is `phases_ok=True, accepted=False` — the *phase* that ran the suite succeeded (it did its
job), but the *run* is not accepted; `finish` logs a `not_accepted` error event with `reason`,
closes the session in sqlite with `ok=False`, prints the console banner, and returns exit code
`1`. This is why a failing test/review loop in a chained ADW does not raise — it falls through
to `finish(accepted=False, reason=...)` instead. `finish` internals live in
[02-engine-runtime.md](02-engine-runtime.md).

## 4. Composition patterns

### Single-agent vs multi-agent phase→owner assignment

- **Single-agent ADWs** (`adw_prompt`, `adw_scout`, `adw_build`, `adw_plan`, `adw_document`)
  have exactly one `kind="agent"` phase (or two when `adw_document` counts its `documenter`
  phase) whose `owner=` is a hard-coded agent name matching a roster entry
  (`sssf.config.yaml`'s `agents:` list) — except `adw_prompt.py`, where `owner=agent` is the
  CLI-selected `--agent` value.
- **Multi-agent chains** assign one `owner=` per role, always drawn from a small fixed
  vocabulary that recurs across every script: `planner`, `builder`, `reviewer`, `documenter`,
  `scout`, plus the non-agent owners `quality` (deterministic check phases), `git`
  (commit/diff phases), and `run.engineer` (the `request` phase, resolved from
  `ENGINEER_NAME`/`git config user.name`/`$USER` in `utils.engineer_name()`).
- **Fix/revise loops reuse the SAME owner** (`builder`) across iterations — `fix_i` and
  `revise_i` phases are both `owner="builder"`, so the roster only needs one builder agent even
  in a chain with both a test-fix loop and a review-revise loop (`adw_simple_sdlc.py`).
- **`agents.validate(cfg, REQUIRED_AGENTS)` is the single gate on multi-agent composition**: it
  fails fast if any named agent is missing from the roster, uses an unsupported `coding_agent`,
  or has missing prompt files — before any phase opens.

### Parallel fan-out

Where the patterns above are sequential, `run.fan_out(...)` runs several **agent phases
concurrently** (one OS thread each) and hands back a `BranchResult` per branch - see
[02-engine-runtime.md → `Run.fan_out`](02-engine-runtime.md#runfan_out-concurrent-agent-phases)
for the primitive and its guarantees. The authoring shape:

```python
branches = [(PhaseParams(name=f"review_{name}", kind="agent", owner=name, description=...),
             lambda ph, call=call: ph.call(call))
            for name in ["pr_reviewer_1", "pr_reviewer_2", "pr_reviewer_3"]]
results = run.fan_out(branches)              # each branch in its own thread
reviews = [r.value for r in results if r.ok] # BranchResult: .ok / .value / .error
```

Rules that make it correct:

- **Independence is by identity.** Each branch's `owner` must be a **distinct** roster agent, so
  it gets its own blind coding-agent session and `agent_sessions` row. N copies of one name would
  share (and overwrite) one session.
- **A branch failure is a result, not a teardown**, and branch phases are non-gating - one failing
  reviewer does not fail the run. You rule on `results` and pass your verdict to `run.finish()`
  (e.g. an ensemble declines only when *zero* reviewers survive).
- **Read-only branches only.** Fan out agents with `writes: []` (reviewers, scouts). Repo-writing
  branches would race the git index lock under concurrent write-boundary rollback.
- **Per-identity artifacts.** A prompt shared by parallel identities must write to a per-name file;
  the reviewer prompt uses `review-{{agent_name}}.md` (the `{{agent_name}}` template var is the
  invoking agent's name). The barrier phase after the fan-out (the synthesizer) is a **normal
  sequential `run.phase()`** that consolidates the branch envelopes.

The reusable ensemble leg lives in **`adw_modules/ensemble.py`** (`review_branches`,
`synthesis_prompt`, `ensemble_review`), so `adw_ensemble_review.py` and
`adw_build_ensemble_review.py` stay thin. The operator-skill cookbook
`engine/skills/atelier/cookbooks/create_adw.md` documents the same pattern for agents authoring
ADWs in a stamped repo.

### Bounded loops

Fix/verify/revise loops always use `for i in range(1, MAX_X_LOOPS + 1):` with an explicit
`break`, never unbounded `while`. Phase names inside the loop are `f"test_{i}"` / `f"fix_{i}"`
/ `f"review_{i}"` / `f"revise_{i}"` so each retry is its own row in the trace. A failing
deterministic check does not raise — it's recorded via a local `record(ph, result)` helper
(`ph.log(passed=..., checks="n/m", artifacts=...)`) and the phase still succeeds (the runner
did its job); only an *exhausted* loop feeds `accepted=False` into `run.finish(...)`.

### Envelope chaining and deterministic-result adaptation

Envelopes chain via `previous=`: the next agent's `AgentCall(previous=<prior envelope>)` is how
one agent's output becomes the next agent's context — no ad hoc dict-passing. Deterministic
results are adapted into the same door via `quality.as_envelope(result, what)` or
`changes.as_envelope(changeset, notes)`, so a repair loop looks identical whether the prior
"report" came from an agent or a subprocess.

### Commit messages

Commit messages are always the producing agent's own words: `envelope.commit_message or
f"sssf({run.adw_id}): {envelope.summary}"` — never one agent's message reused for another
agent's diff. This closure (`commit(ph, envelope)`) is repeated identically in
`adw_plan_build.py`, `adw_plan_build_test.py`, `adw_plan_build_test_quality.py`, and
`adw_simple_sdlc.py`.

## 5. Generating an ADW with `make_adw.py`

**File:** `engine/adws/make_adw.py` (546 lines).

`make_adw.py` generates a brand-new, first-class `adw_<name>.py` script by assembling a fixed,
hand-vetted set of code fragments ("blocks") — it **never invents phase logic**; every fragment
is lifted verbatim from a proven hand-written ADW (`scout` from `adw_scout.py`, `plan`/`build`
from `adw_plan_build.py`, the bounded `test` fix-loop from `adw_plan_build_test.py`, `review` /
`document` — with the revise-loop, retest, and verified-gating — from `adw_simple_sdlc.py`).
The emitted script is byte-for-byte a normal ADW: `adw_worker.py` launches it exactly like a
hand-written one, and the cockpit's `/skills` cookbook reads it live from disk.

### The block catalog

Canonical order (a chain must be a **subsequence** — you cannot review before you build):

```
scout -> plan -> build -> test -> review -> commit -> document
```

| Block | kind | owner | output type | requires | blurb |
|---|---|---|---|---|---|
| `scout` | agent | scout | `ScoutOutput` | — | Read-only recon — find where things live, change nothing. |
| `plan` | agent | planner | `PlanOutput` | — | Turn the request into an implementable plan. |
| `build` | agent | builder | `BuildOutput` | — | Implement the plan exactly. |
| `test` | code | quality | (none — deterministic) | `build` | Run the suite (deterministic), with a bounded builder fix-loop. |
| `review` | agent | reviewer | `ReviewOutput` | `build` | Confirm the build matches the plan, with a bounded revise-loop. |
| `commit` | code | git | (none) | — | Land the code in the agent's own words. |
| `document` | agent | documenter | `DocumentOutput` | `build`, `commit` | Write up the completed change; commits the write-up itself. |

Plus one OR-dependency the flat `requires` list can't express (checked separately): `commit`
needs a `plan` **or** a `build` present to commit — otherwise `commit(ph, plan)` would
reference an undefined variable in the generated code.

Validation rules enforced by `parse_steps()`:
- steps must be known blocks, each appearing at most once;
- steps must equal `CANONICAL` filtered down to the chosen set, in that order (canonical order
  or bust);
- at least one `agent`-kind block must be present (a workflow needs a model somewhere);
- each block's `requires` must already be present earlier in the list.

### How it generates a script

- Computes `has_verif = "test" in present or "review" in present` and
  `needs_baseline = has_verif or "document" in present` — a baseline sha (`git_helper.rev("HEAD")`)
  is pinned before any commit phase whenever the chain tests, reviews, or documents.
- Assembles `REQUIRED_AGENTS` from the agent-kind blocks' owners, plus `MAX_FIX_LOOPS = 3` /
  `MAX_REVISION_LOOPS = 2` constants when `test`/`review` are present, and a `DOCUMENT_NOTES`
  constant when `document` is present.
- Builds the body block-by-block from fixed source fragments (`HELPER_COMMIT`, `HELPER_RECORD`,
  `REQUEST`/`REQUEST_BASELINE`, `SCOUT`, `PLAN`, `BUILD_FROM_PLAN`/`BUILD_STANDALONE`,
  `TEST_LOOP`, `REVIEW_LOOP`, `RETEST`, `COMMIT_BUILD_GATED`/`DOCUMENT_GATED` or
  `commit_linear()`/`DOCUMENT_LINEAR` for a chain with no verification step).
- If `has_verif`, the `verified` boolean is built from whichever of `test.passed` /
  `review.approved` are present, ANDed together, and `run.finish(accepted=verified, reason=...)`
  closes the script; otherwise it's a plain `run.finish()`.
- `imports_block()` computes exactly the `adw_modules` imports and `data_types` symbols the
  chosen steps need (e.g. `git_helper` only if `commit`/`document`/`needs_baseline`; `quality`
  only if `test`; `changes` only if `document`).
- `phases_line()` builds the docstring's `Phases: …` line from a `PHASE_TOKEN` map, so a
  generated script's docstring reads the same shape as a hand-written one.

### Where it writes

`adws_dir()` resolves to `$SSSF_ADWS_DIR` if set (the same override the cockpit's reader
honors), else `engine/adws/`. The file is written atomically (write to a `.tmp` sibling, then
`os.replace`). `adw_<name>.py` must not already exist unless `--force` is passed.

### CLI

```
uv run engine/adws/make_adw.py --list-steps [--json]
uv run engine/adws/make_adw.py --name foo --steps plan,build,commit [--json]
uv run engine/adws/make_adw.py --name foo --steps plan,build,test,review,document,commit [--force]
uv run engine/adws/make_adw.py --name foo --steps plan,build,commit --stdout   # print, write nothing
```

`--name` must match `^[a-z][a-z0-9_]*$`, and must not be `worker`/`modules` or already start
with `adw_` (`validate_name`) — `adw_worker.py` is the drainer, not a recipe, so `worker` is
reserved.

### How the cockpit's ADW-builder uses it

`cockpit/lib/adw-builder.ts` wraps the generator via `node:child_process` `execFile`
(promisified `runGenerator()`):

```ts
async function runGenerator(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('uv', ['run', makeAdwPath(), ...args], {
    cwd: repoRoot(), timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  });
  ...
}
```

- `cockpit/app/api/adws/route.ts` — `GET` returns `listSteps()` (the palette the composer UI
  renders); `POST` validates the body (Zod) and calls `buildAdw()`, either for a live preview
  (`--stdout`, nothing written) or a real create (`--json`, file written).
- `cockpit/components/skills/RecipeBuilder.tsx` — the composer UI: `onPreview()` posts
  `{name, steps, preview: true}` and shows `data.source`; `onCreate()` posts without `preview`,
  shows `data.name`, and calls `router.refresh()`. A generator-side validation failure surfaces
  as `AdwBuildError` (the generator's own stderr) → HTTP 400 → `error.message` rendered
  verbatim in the UI; the client also mirrors `parse_steps()`'s rules for instant feedback, but
  `make_adw.py` remains the single source of truth.
- `cockpit/lib/skills.ts` — the **read-only** `/skills` cookbook: `readRecipes()` /
  `readAdwNames()` read every `adw_*.py` under `engine/adws/` (respecting `SSSF_ADWS_DIR`),
  explicitly excluding `adw_worker.py`, and `parseRecipe()` regex-parses each script's module
  docstring (purpose + `Phases:` line) and its `REQUIRED_AGENTS` constant to render a recipe
  card — this is the same docstring/constant shape every hand-written and generated ADW
  follows, which is why the generator can lift fragments verbatim and still have the cookbook
  render them correctly.

See [06-cockpit.md](06-cockpit.md) for the cockpit-side write path and UI conventions.

## 6. Hand-authoring a new ADW

For anything `make_adw.py`'s canonical subsequence can't express (a non-canonical ordering, a
new phase kind, a bespoke gate), write the script by hand. Minimal skeleton:

```python
#!/usr/bin/env -S uv run
# /// script
# dependencies = ["pydantic", "python-dotenv", "pyyaml", "rich", "claude-agent-sdk"]
# ///
"""ADW <Name> — one-line purpose.

Usage:
    uv run adws/adw_<name>.py "<prompt or path/to/prompt.md>" [--config adws/adw_sssf_config/sssf.config.yaml] [--adw-id a1b2c3d4]

Phases: engineer(request) -> ...
"""

import argparse
import sys

from adw_modules import agents, gates, session, utils   # + git_helper/quality/changes as needed
from adw_modules.data_types import AgentCall, PhaseParams, <YourOutputType>

REQUIRED_AGENTS = ["<agent-name-from-roster>"]


def main(prompt: str, config: str = "adws/adw_sssf_config/sssf.config.yaml", adw_id: str | None = None) -> int:
    cfg = agents.load_config(config)
    agents.validate(cfg, REQUIRED_AGENTS)
    run = session.ensure(cfg, adw_id)

    with run.phase(PhaseParams(name="request", kind="engineer", owner=run.engineer,
                               description="Capture the incoming ask")) as ph:
        ph.log(input=prompt)

    with run.phase(PhaseParams(name="<phase>", kind="agent", owner="<agent-name>",
                               description="<what this phase does and why>")) as ph:
        result = ph.call(AgentCall(output_type=<YourOutputType>, prompt=prompt,
                                   gates=[gates.artifacts_exist]))

    return run.finish()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prompt", help="inline text or a path to a prompt file")
    parser.add_argument("--config", default="adws/adw_sssf_config/sssf.config.yaml")
    parser.add_argument("--adw-id", default=None, help="join or pin an existing session")
    args = parser.parse_args()
    sys.exit(main(utils.resolve_prompt(args.prompt), args.config, args.adw_id))
```

### Imports available from `adw_modules/`

| Module | Use it for |
|---|---|
| `agents` | `load_config(path)`, `validate(cfg, required)`, `execute(...)` (called internally by `ph.call`) |
| `session` | `ensure(cfg, adw_id)` — mint/join a run |
| `runner` | `Run`, `PhaseHandle` — imported transitively, not usually named directly |
| `gates` | `artifacts_exist`, `files_non_empty`, `json_parses`, `diff_matches_claims`, `verdict_consistent`, `tests_pass(cmd)` (factory) |
| `quality` | `run_quality(run)`, `run_tests(run)`, `as_envelope(result, what)` — deterministic lint/typecheck/build/test blocks; placeholder commands must be wired up per-repo in `adw_modules/quality.py` before `test`/`quality` phases mean anything |
| `changes` | `capture(run, ChangeCapture(base=...))`, `as_envelope(changeset, notes)` — deterministic git-diff capture for documentation |
| `git_helper` | `commit_all(message)`, `rev(ref)`, `short_sha(ref)`, `repo_root()`, `is_dirty()`, etc. |
| `utils` | `resolve_prompt(arg)`, `new_id(n)`, `now_iso()`, `ensure_dir(path)`, `operator_env()`, `engineer_name()` |
| `data_types` | `PhaseParams`, `AgentCall`, `EnvelopeBase` and its subclasses (`GenericOutput`, `PlanOutput`, `BuildOutput`, `ScoutOutput`, `ReviewOutput`, `DocumentOutput`, `ChangesOutput`, `VerifyOutput`), `GateReport`/`GateCheck`, `SSSFConfig`/`AgentConfig` |

### Conventions to follow (observed uniformly across every script)

- **`REQUIRED_AGENTS` is a module-level constant**, validated via `agents.validate(cfg,
  REQUIRED_AGENTS)` immediately after `load_config` — before `session.ensure` even opens a
  trace. Nothing spawns against a half-valid config.
- **The first phase is always `name="request", kind="engineer", owner=run.engineer`**, logging
  `input=prompt` (and `baseline=git_helper.short_sha(baseline)` when the chain pins a baseline
  for later commit/document phases).
- **Every `PhaseParams.description` is a real sentence**, never an echo of the phase name —
  enforced by a Pydantic validator that raises at construction time.
- **Bounded loops use `for i in range(1, MAX_X_LOOPS + 1):` with an explicit `break`**, never
  unbounded `while` (see §4).
- **A failing deterministic check does not raise** — only an exhausted loop feeds
  `accepted=False` into `run.finish(...)` (see §3).
- **Envelopes chain via `previous=`** rather than ad hoc dict-passing (see §4).
- **Commit messages are always the producing agent's own words** (see §4).
- **Gates are passed as `gates=[...]` on `AgentCall`**, one function `gate(envelope, run) ->
  GateReport`. `agents.execute()` re-prompts the SAME agent session with a correction on
  violation, bounded by `phase.params.retries` (default 0 — no retries unless the phase asks
  for them, e.g. `adw_build.py`'s `build` phase sets `retries=1`). See
  [03-agents-and-gates.md](03-agents-and-gates.md) for the full `agents.execute()` pipeline.
- **`--config`/`--adw-id` flags are always last on the CLI**, and `prompt` is always a
  positional resolved through `utils.resolve_prompt` right at the `sys.exit(main(...))` call
  site, never inside `main()` itself (so `main()` stays testable with a plain string).

## Extending this subsystem

- To add a workflow that fits the canonical `scout -> plan -> build -> test -> review -> commit
  -> document` subsequence, generate it — either through the cockpit's `/skills` ADW builder or
  the `make_adw.py` CLI (§5). Prefer this path; it can't invent phase logic, only recombine
  vetted fragments.
- To add a non-canonical shape (a new phase kind, an ordering the generator can't express, a
  bespoke gate), hand-author it from the skeleton in §6.
- To add a new block to the generator's catalog itself, edit `make_adw.py`'s `BLOCKS`/`CANONICAL`
  and add a verbatim fragment lifted from a proven hand-written ADW — see §5.

For the full end-to-end recipe (author an ADW, verify it, launch it), see
[08-extending-the-system.md](08-extending-the-system.md). For the roster/config an ADW's
`REQUIRED_AGENTS` resolve against, see [05-config-and-roster.md](05-config-and-roster.md). For
the seam contract these ADWs write through, see [AGENTS.md](../AGENTS.md).
