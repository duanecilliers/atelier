#!/usr/bin/env -S uv run
# /// script
# dependencies = []
# ///
"""make_adw — generate a new ADW script from a phase-chain spec.

An ADW is a hand-written PEP 723 script that composes phases via the `Run` API
(see adw_plan_build.py, adw_simple_sdlc.py). This tool writes one of those
scripts for you from an ordered list of vetted building blocks, so a new
workflow can be composed without hand-writing Python. The emitted script is a
first-class ADW: the worker launches it byte-for-byte like any other, and the
cockpit's /skills cookbook reads it live from disk.

Every block below is lifted verbatim from a proven ADW — `scout` from
adw_scout, `plan`/`build` from adw_plan_build, the bounded `test` fix-loop from
adw_plan_build_test, and `review`/`document` (with the revise-loop, retest and
verified-gating) from adw_simple_sdlc. The generator only *arranges* them; it
never invents phase logic.

Usage:
    uv run engine/adws/make_adw.py --list-steps [--json]
    uv run engine/adws/make_adw.py --name foo --steps plan,build,commit [--json]
    uv run engine/adws/make_adw.py --name foo --steps plan,build,test,review,document,commit [--force]
    uv run engine/adws/make_adw.py --name foo --steps plan,build,commit --stdout   # print, write nothing

Steps must be a subsequence of the canonical order:
    scout -> plan -> build -> test -> review -> document -> commit
(you cannot review before you build), and must satisfy each block's `requires`.
The write target is engine/adws/adw_<name>.py, honoring SSSF_ADWS_DIR when set
(the same override the cockpit reads) so a run can be isolated to a temp dir.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

NAME_RE = re.compile(r"^[a-z][a-z0-9_]*$")
RESERVED_NAMES = {"worker", "modules"}          # adw_worker is the drainer, not a recipe

# ── the block catalog ────────────────────────────────────────────────────────
# Canonical order: a chain is a subsequence of this list (you cannot test before
# you build). Each block knows its kind/owner, the output_type + gates it emits,
# and the blocks it requires to already be present.
CANONICAL = ["scout", "plan", "build", "test", "review", "commit", "document"]

BLOCKS: dict[str, dict] = {
    "scout": {
        "kind": "agent", "owner": "scout", "output": "ScoutOutput",
        "requires": [], "label": "Scout",
        "blurb": "Read-only recon — find where things live, change nothing.",
    },
    "plan": {
        "kind": "agent", "owner": "planner", "output": "PlanOutput",
        "requires": [], "label": "Plan",
        "blurb": "Turn the request into an implementable plan.",
    },
    "build": {
        "kind": "agent", "owner": "builder", "output": "BuildOutput",
        "requires": [], "label": "Build",
        "blurb": "Implement the plan exactly.",
    },
    "test": {
        "kind": "code", "owner": "quality", "output": None,
        "requires": ["build"], "label": "Test",
        "blurb": "Run the suite (deterministic), with a bounded builder fix-loop.",
    },
    "review": {
        "kind": "agent", "owner": "reviewer", "output": "ReviewOutput",
        "requires": ["build"], "label": "Review",
        "blurb": "Confirm the build matches the plan, with a bounded revise-loop.",
    },
    "document": {
        "kind": "agent", "owner": "documenter", "output": "DocumentOutput",
        "requires": ["build", "commit"], "label": "Document",
        "blurb": "Write up the completed change; commits the write-up itself.",
    },
    "commit": {
        "kind": "code", "owner": "git", "output": None,
        "requires": [], "label": "Commit",
        "blurb": "Land the code in the agent's own words.",
    },
}

AGENT_BLOCKS = [b for b in CANONICAL if BLOCKS[b]["kind"] == "agent"]


class SpecError(ValueError):
    """A bad --name/--steps spec. Printed to stderr; exit 2."""


# ── validation ───────────────────────────────────────────────────────────────
def validate_name(name: str) -> str:
    if not NAME_RE.match(name):
        raise SpecError(
            f"invalid name {name!r} — use lowercase letters, digits and "
            "underscores, starting with a letter (it becomes adw_<name>.py)")
    if name in RESERVED_NAMES or name.startswith("adw_"):
        raise SpecError(
            f"reserved name {name!r} — pass the stem without the adw_ prefix, "
            "and not a reserved word")
    return name


def parse_steps(raw: str) -> list[str]:
    steps = [s.strip() for s in raw.split(",") if s.strip()]
    if not steps:
        raise SpecError("--steps is empty — name at least one block")

    seen: set[str] = set()
    for s in steps:
        if s not in BLOCKS:
            raise SpecError(f"unknown step {s!r} — known blocks: {', '.join(CANONICAL)}")
        if s in seen:
            raise SpecError(f"duplicate step {s!r} — each block may appear once")
        seen.add(s)

    # Must be a subsequence of the canonical order (you cannot review before you
    # build). Compare the given order against the canonical filtered to `seen`.
    canonical_here = [b for b in CANONICAL if b in seen]
    if steps != canonical_here:
        raise SpecError(
            "steps must be in canonical order: "
            f"{', '.join(canonical_here)} (got {', '.join(steps)})")

    if not any(BLOCKS[s]["kind"] == "agent" for s in steps):
        raise SpecError("a workflow needs at least one agent phase "
                        f"(one of: {', '.join(AGENT_BLOCKS)})")

    for s in steps:
        for req in BLOCKS[s]["requires"]:
            if req not in seen:
                raise SpecError(f"step {s!r} requires a {req!r} step before it")

    # `commit` lands the current producing envelope — it needs a plan or a build
    # to commit. (An OR-dependency the flat `requires` list can't express; without
    # it, e.g. `scout,commit` would emit `commit(ph, plan)` with plan undefined.)
    if "commit" in seen and not ({"plan", "build"} & seen):
        raise SpecError("step 'commit' needs a 'plan' or 'build' to commit")
    return steps


# ── code fragments (lifted verbatim from the proven ADWs) ────────────────────
HELPER_COMMIT = '''\
    def commit(ph, envelope) -> None:
        """Commit what the preceding phase produced, in that agent's own words."""
        message = envelope.commit_message or f"sssf({run.adw_id}): {envelope.summary}"
        ph.log(sha=git_helper.commit_all(message), message=message)'''

HELPER_RECORD = '''\
    def record(ph, result) -> None:
        """Log a deterministic block's verdict — the same shape every ADW uses."""
        passed = sum(1 for check in result.checks if check.passed)
        ph.log(passed=result.passed, checks=f"{passed}/{len(result.checks)}",
               artifacts=", ".join(result.artifacts))'''

REQUEST = '''\
    with run.phase(PhaseParams(name="request", kind="engineer", owner=run.engineer,
                               description="Capture the incoming ask")) as ph:
        ph.log(input=prompt)'''

REQUEST_BASELINE = '''\
    with run.phase(PhaseParams(name="request", kind="engineer", owner=run.engineer,
                               description="Capture the incoming ask")) as ph:
        ph.log(input=prompt, baseline=git_helper.short_sha(baseline))'''

SCOUT = '''\
    with run.phase(PhaseParams(name="scout", kind="agent", owner="scout",
                               description="Find and report where things live — change nothing")) as ph:
        ph.call(AgentCall(output_type=ScoutOutput, prompt=prompt,
                          gates=[gates.artifacts_exist]))'''

PLAN = '''\
    with run.phase(PhaseParams(name="plan", kind="agent", owner="planner",
                               description="Turn the request into an implementable plan")) as ph:
        plan = ph.call(AgentCall(output_type=PlanOutput, prompt=prompt,
                                 gates=[gates.artifacts_exist, gates.files_non_empty]))'''

BUILD_FROM_PLAN = '''\
    with run.phase(PhaseParams(name="build", kind="agent", owner="builder",
                               description="Implement the plan exactly")) as ph:
        build = ph.call(AgentCall(output_type=BuildOutput, prompt=prompt, previous=plan,
                                  gates=[gates.diff_matches_claims]))'''

BUILD_STANDALONE = '''\
    with run.phase(PhaseParams(name="build", kind="agent", owner="builder",
                               description="Implement the request directly")) as ph:
        build = ph.call(AgentCall(output_type=BuildOutput, prompt=prompt,
                                  gates=[gates.diff_matches_claims]))'''

TEST_LOOP = '''\
    test = None
    for i in range(1, MAX_FIX_LOOPS + 1):
        with run.phase(PhaseParams(name=f"test_{i}", kind="code", owner="quality",
                                   description="Run the suite — a known command, so code runs "
                                               "it and no agent has to rediscover it")) as ph:
            test = quality.run_tests(run)
            record(ph, test)

        if test.passed:
            break

        with run.phase(PhaseParams(name=f"fix_{i}", kind="agent", owner="builder", retries=1,
                                   description="Repair what the suite reported, from its "
                                               "verbatim output")) as ph:
            build = ph.call(AgentCall(output_type=BuildOutput, prompt=prompt,
                                      previous=quality.as_envelope(test, "tests"),
                                      gates=[gates.diff_matches_claims]))'''

REVIEW_LOOP = '''\
    review = None
    revised = False
    for i in range(1, MAX_REVISION_LOOPS + 1):
        with run.phase(PhaseParams(name=f"review_{i}", kind="agent", owner="reviewer",
                                   description="Confirm the build matches the plan")) as ph:
            review = ph.call(AgentCall(output_type=ReviewOutput, prompt=prompt, previous=build,
                                       gates=[gates.artifacts_exist, gates.verdict_consistent]))

        if review.approved or i == MAX_REVISION_LOOPS:
            break

        with run.phase(PhaseParams(name=f"revise_{i}", kind="agent", owner="builder", retries=1,
                                   description="Close the reviewer's blocking findings")) as ph:
            build = ph.call(AgentCall(output_type=BuildOutput, prompt=prompt, previous=review,
                                      gates=[gates.diff_matches_claims]))
            revised = True'''

RETEST = '''\
    # A revision edited code after the suite last ran, so the green light is
    # stale. Re-run it rather than commit on a result that predates the change.
    if revised and review is not None and review.approved:
        with run.phase(PhaseParams(name="retest", kind="code", owner="quality",
                                   description="Re-run the suite — the revision changed code "
                                               "after the last green result")) as ph:
            test = quality.run_tests(run)
            record(ph, test)'''

# Gated trailing blocks (indented one level, to sit inside `if verified:`).
COMMIT_BUILD_GATED = '''\
        with run.phase(PhaseParams(name="commit_build", kind="code", owner="git",
                                   description="Land the code only now that it is verified")) as ph:
            commit(ph, build)'''

DOCUMENT_GATED = '''\
        with run.phase(PhaseParams(name="changes", kind="code", owner="git",
                                   description="Diff the whole run against its pinned baseline, for the documenter")) as ph:
            changeset = changes.capture(run, ChangeCapture(base=baseline))
            ph.log(base=f"{changeset.base.label} @ {changeset.base.commit[:7]}",
                   reason=changeset.base.reason,
                   files=len(changeset.files) + len(changeset.untracked),
                   lines=f"+{changeset.insertions} -{changeset.deletions}",
                   diff=changeset.diff_path)
            if changeset.empty:
                raise RuntimeError(
                    f"nothing changed since {changeset.base.label} "
                    f"({changeset.base.reason}) — there is nothing to document.")

        with run.phase(PhaseParams(name="document", kind="agent", owner="documenter", retries=1,
                                   description="Write up the completed change")) as ph:
            document = ph.call(AgentCall(output_type=DocumentOutput, prompt=prompt,
                                         previous=changes.as_envelope(changeset, DOCUMENT_NOTES),
                                         gates=[gates.artifacts_exist, gates.files_non_empty]))

        with run.phase(PhaseParams(name="commit_docs", kind="code", owner="git",
                                   description="Ship the write-up in its own commit, beside the code it describes")) as ph:
            commit(ph, document)'''


def commit_linear(env: str) -> str:
    """A single unconditional commit of the current envelope (no verification)."""
    return f'''\
    with run.phase(PhaseParams(name="commit", kind="code", owner="git",
                               description="Land the changes, using the message the agent wrote")) as ph:
        commit(ph, {env})'''


DOCUMENT_LINEAR = '''\
    with run.phase(PhaseParams(name="changes", kind="code", owner="git",
                               description="Diff the whole run against its pinned baseline, for the documenter")) as ph:
        changeset = changes.capture(run, ChangeCapture(base=baseline))
        ph.log(base=f"{changeset.base.label} @ {changeset.base.commit[:7]}",
               reason=changeset.base.reason,
               files=len(changeset.files) + len(changeset.untracked),
               lines=f"+{changeset.insertions} -{changeset.deletions}",
               diff=changeset.diff_path)
        if changeset.empty:
            raise RuntimeError(
                f"nothing changed since {changeset.base.label} "
                f"({changeset.base.reason}) — there is nothing to document.")

    with run.phase(PhaseParams(name="document", kind="agent", owner="documenter", retries=1,
                               description="Write up the completed change")) as ph:
        document = ph.call(AgentCall(output_type=DocumentOutput, prompt=prompt,
                                     previous=changes.as_envelope(changeset, DOCUMENT_NOTES),
                                     gates=[gates.artifacts_exist, gates.files_non_empty]))

    with run.phase(PhaseParams(name="commit_docs", kind="code", owner="git",
                               description="Ship the write-up in its own commit, beside the code it describes")) as ph:
        commit(ph, document)'''


# ── phases-line (the docstring chain /skills renders as chips) ───────────────
PHASE_TOKEN = {
    "scout": "scout",
    "plan": "planner",
    "build": "builder",
    "test": "code(test) [-> builder(fix) -> code(test) ... bounded]",
    "review": "reviewer [-> builder(revise) -> reviewer ... bounded]",
    "document": "documenter -> git(commit_docs)",
    "commit": "git(commit)",
}


def phases_line(steps: list[str]) -> str:
    return " -> ".join(["engineer(request)"] + [PHASE_TOKEN[s] for s in steps])


def imports_block(steps: list[str], needs_baseline: bool) -> str:
    present = set(steps)
    mods = {"agents", "session", "utils"}
    if any(BLOCKS[s]["kind"] == "agent" for s in steps):
        mods.add("gates")
    if "commit" in present or "document" in present or needs_baseline:
        mods.add("git_helper")
    if "test" in present:
        mods.add("quality")
    if "document" in present:
        mods.add("changes")
    mod_line = f"from adw_modules import {', '.join(sorted(mods))}"

    types = {"AgentCall", "PhaseParams"}
    for s in steps:
        if BLOCKS[s]["output"]:
            types.add(BLOCKS[s]["output"])
    if "document" in present:
        types.add("ChangeCapture")
    type_line = f"from adw_modules.data_types import {', '.join(sorted(types))}"
    return f"import argparse\nimport sys\n\n{mod_line}\n{type_line}"


# ── the generator ────────────────────────────────────────────────────────────
def generate(name: str, steps: list[str]) -> str:
    present = set(steps)
    has_verif = "test" in present or "review" in present
    both_verif = "test" in present and "review" in present
    needs_baseline = has_verif or "document" in present

    title = name.replace("_", " ").title()
    tagline = ", ".join(steps)
    required = [BLOCKS[b]["owner"] for b in steps if BLOCKS[b]["kind"] == "agent"]

    # Numeric constants sit on consecutive lines; DOCUMENT_NOTES gets its own
    # blank line above it — the same grouping adw_simple_sdlc uses.
    agents_literal = "[" + ", ".join(f'"{a}"' for a in required) + "]"
    const_lines = [f"REQUIRED_AGENTS = {agents_literal}"]
    if "test" in present:
        const_lines.append("MAX_FIX_LOOPS = 3")
    if "review" in present:
        const_lines.append("MAX_REVISION_LOOPS = 2")
    consts = "\n".join(const_lines)
    if "document" in present:
        consts += (
            '\n\nDOCUMENT_NOTES = ("Read diff_path in full before writing. Document only what the "\n'
            '                  "diff shows, then copy the write-up into app_docs/ as your task "\n'
            '                  "describes.")')

    # ── main() body, block by block, in canonical order ──────────────────────
    # The baseline pin sits tight under the setup (no blank line); everything
    # after is one blank line apart, matching the hand-written ADWs.
    setup = (
        "    cfg = agents.load_config(config)\n"
        "    agents.validate(cfg, REQUIRED_AGENTS)\n"
        "    run = session.ensure(cfg, adw_id)"
    )
    if needs_baseline:
        setup += '\n    baseline = git_helper.rev("HEAD")     # pinned before this run commits anything'

    body: list[str] = []
    if "commit" in present or "document" in present:
        body.append(HELPER_COMMIT)
    if "test" in present:
        body.append(HELPER_RECORD)

    body.append(REQUEST_BASELINE if needs_baseline else REQUEST)

    if "scout" in present:
        body.append(SCOUT)
    if "plan" in present:
        body.append(PLAN)
    if "build" in present:
        body.append(BUILD_FROM_PLAN if "plan" in present else BUILD_STANDALONE)
    if "test" in present:
        body.append(TEST_LOOP)
    if "review" in present:
        body.append(REVIEW_LOOP)
    if both_verif:
        body.append(RETEST)

    if has_verif:
        # verified gate: only a green suite and/or an approved review lets the
        # code commit and the write-up land. Mirrors adw_simple_sdlc.
        clauses = []
        if "test" in present:
            clauses.append("test is not None and test.passed")
        if "review" in present:
            clauses.append("review is not None and review.approved")
        expr = "\n                and ".join(clauses)
        body.append(f"    verified = ({expr})")
        gated = []
        if "commit" in present:
            gated.append(COMMIT_BUILD_GATED)
        if "document" in present:
            gated.append(DOCUMENT_GATED)
        if gated:
            body.append("    if verified:\n" + "\n\n".join(gated))
        finish = ('    return run.finish(accepted=verified,\n'
                  '                      reason="the run\'s verification did not come back clean")')
    else:
        # Linear: land the code first, then (if any) document it — the code is
        # committed before the write-up describes it. No gate; nothing can fail.
        if "commit" in present:
            body.append(commit_linear("build" if "build" in present else "plan"))
        if "document" in present:
            body.append(DOCUMENT_LINEAR)
        finish = "    return run.finish()"
    body.append(finish)

    # ── assemble the file ────────────────────────────────────────────────────
    header = (
        "#!/usr/bin/env -S uv run\n"
        "# /// script\n"
        '# dependencies = ["pydantic", "python-dotenv", "pyyaml", "rich", "claude-agent-sdk"]\n'
        "# ///\n"
    )
    docstring = (
        f'"""ADW {title} — {tagline}.\n\n'
        "Generated by make_adw.py — a composed chain of vetted phase blocks.\n\n"
        "Usage:\n"
        f'    uv run adws/adw_{name}.py "<prompt or path/to/prompt.md>" '
        "[--config adws/adw_sssf_config/sssf.config.yaml] [--adw-id a1b2c3d4]\n\n"
        f"Phases: {phases_line(steps)}\n"
        '"""'
    )
    main_sig = (
        'def main(prompt: str, config: str = "adws/adw_sssf_config/sssf.config.yaml", '
        "adw_id: str | None = None) -> int:"
    )
    entrypoint = (
        'if __name__ == "__main__":\n'
        "    parser = argparse.ArgumentParser(description=__doc__)\n"
        '    parser.add_argument("prompt", help="inline text or a path to a prompt file")\n'
        '    parser.add_argument("--config", default="adws/adw_sssf_config/sssf.config.yaml")\n'
        '    parser.add_argument("--adw-id", default=None, help="join or pin an existing session")\n'
        "    args = parser.parse_args()\n"
        "    sys.exit(main(utils.resolve_prompt(args.prompt), args.config, args.adw_id))"
    )

    main_block = main_sig + "\n" + setup + "\n\n" + "\n\n".join(body)

    # Blank-line grammar, matching the hand-written ADWs: one blank line
    # docstring→imports→consts, two blank lines around the top-level defs.
    return (
        header + docstring + "\n\n"
        + imports_block(steps, needs_baseline) + "\n\n"
        + consts + "\n\n\n"
        + main_block + "\n\n\n"
        + entrypoint + "\n"
    )


# ── dir resolution + atomic write ────────────────────────────────────────────
def adws_dir() -> Path:
    """Where adw_<name>.py is written. SSSF_ADWS_DIR wins (the same override the
    cockpit's reader honors), else this script's own directory."""
    raw = os.environ.get("SSSF_ADWS_DIR")
    return Path(raw).resolve() if raw else Path(__file__).resolve().parent


def write_atomic(path: Path, source: str) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(source)
    os.replace(tmp, path)


# ── CLI ──────────────────────────────────────────────────────────────────────
def list_steps() -> list[dict]:
    return [{"id": b, **{k: BLOCKS[b][k] for k in ("kind", "owner", "requires", "label", "blurb")}}
            for b in CANONICAL]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generate a new ADW from a phase-chain spec.")
    parser.add_argument("--name", help="the ADW stem without the adw_ prefix, e.g. 'ship'")
    parser.add_argument("--steps", help="comma-separated blocks, canonical order (see --list-steps)")
    parser.add_argument("--list-steps", action="store_true", help="print the block catalog and exit")
    parser.add_argument("--stdout", action="store_true", help="print the source, write no file")
    parser.add_argument("--force", action="store_true", help="overwrite an existing adw_<name>.py")
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    args = parser.parse_args(argv)

    if args.list_steps:
        catalog = list_steps()
        if args.json:
            print(json.dumps({"canonical": CANONICAL, "blocks": catalog}))
        else:
            for b in catalog:
                req = f"  (requires {', '.join(b['requires'])})" if b["requires"] else ""
                print(f"{b['id']:<9} {b['kind']:<6} {b['owner']:<10} {b['blurb']}{req}")
        return 0

    if not args.name or not args.steps:
        parser.error("--name and --steps are required (or use --list-steps)")

    try:
        name = validate_name(args.name)
        steps = parse_steps(args.steps)
    except SpecError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2

    source = generate(name, steps)

    if args.stdout:
        sys.stdout.write(source)
        return 0

    path = adws_dir() / f"adw_{name}.py"
    if path.exists() and not args.force:
        print(f"error: {path} already exists — pass --force to overwrite", file=sys.stderr)
        return 2
    write_atomic(path, source)

    if args.json:
        print(json.dumps({"path": str(path), "name": f"adw_{name}", "steps": steps}))
    else:
        print(f"wrote {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
