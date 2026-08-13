"""The ensemble review leg: N independent reviewers in parallel, then synthesis.

Shared by adw_ensemble_review.py (review-only) and adw_build_ensemble_review.py
(build + review + revise). Three DISTINCT reviewer identities rule on the same
change concurrently via run.fan_out - each gets its own blind coding-agent session
(independence by identity) and writes a per-name artifact (review-<name>.md) so
concurrent writers never clobber. A synthesizer then consolidates the surviving
reviews into one ReviewOutput verdict.

Degraded fan-out is by design: a reviewer branch that errors is isolated (fan_out
never tears the run down), the synthesizer consolidates whatever survived, and the
caller declines only when ZERO reviewers came back.
"""

from __future__ import annotations

from typing import Callable, Optional

from . import gates
from .data_types import AgentCall, PhaseParams, ReviewOutput

REVIEWERS = ["pr_reviewer_1", "pr_reviewer_2", "pr_reviewer_3"]
SYNTHESIZER = "synthesizer"

# A reviewer's write target is its per-name review file under the handoff dir;
# the verdict must be self-consistent. The synthesizer is gated the same way -
# artifacts_exist included, so a synthesis that claims a synthesis.md must produce it.
REVIEW_GATES = [gates.artifacts_exist, gates.artifacts_within_handoff, gates.verdict_consistent]
SYNTH_GATES = [gates.artifacts_exist, gates.artifacts_within_handoff, gates.verdict_consistent]


def review_branches(prompt: str, previous) -> list[tuple[PhaseParams, Callable]]:
    """One fan_out branch per reviewer identity: open its agent phase, run one
    ReviewOutput call. The owner IS the identity, so each branch gets its own
    blind session + agent_sessions row."""
    branches: list[tuple[PhaseParams, Callable]] = []
    for name in REVIEWERS:
        params = PhaseParams(
            name=f"review_{name}", kind="agent", owner=name,
            description="Rule on every requirement in the spec, against the code on disk")
        call = AgentCall(output_type=ReviewOutput, prompt=prompt, previous=previous,
                         gates=REVIEW_GATES)
        branches.append((params, lambda ph, call=call: ph.call(call)))
    return branches


def synthesis_prompt(request: str, reviews) -> str:
    """The original ask followed by each surviving reviewer's full ReviewOutput -
    the synthesizer consolidates from these envelopes (in memory), not the files."""
    parts = [request, "", "## Independent reviews to consolidate", ""]
    for result in reviews:
        parts += [f"### {result.phase.params.owner}", "", "```json",
                  result.value.model_dump_json(indent=2), "```", ""]
    return "\n".join(parts)


def ensemble_review(run, request: str, previous, synth_phase: str = "synthesize") -> Optional[ReviewOutput]:
    """One review round: fan the reviewers out (concurrent), then synthesize.

    Returns the consolidated ReviewOutput, or None when NO reviewer completed
    (the caller declines). A reviewer branch that failed is isolated and simply
    absent from the synthesis; its phase is non-gating, so it does not itself
    fail the run (see Run.fan_out / Run.finish).
    """
    results = run.fan_out(review_branches(request, previous))
    reviews = [r for r in results if r.ok]
    for failed in (r for r in results if not r.ok):
        run.console.note(f"{failed.phase.params.owner} did not complete: {failed.phase.error}")
    if not reviews:
        return None
    with run.phase(PhaseParams(
            name=synth_phase, kind="agent", owner=SYNTHESIZER,
            description="Consolidate the independent reviews into one verdict")) as ph:
        return ph.call(AgentCall(output_type=ReviewOutput,
                                 prompt=synthesis_prompt(request, reviews),
                                 gates=SYNTH_GATES))
