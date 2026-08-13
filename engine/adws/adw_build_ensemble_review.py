#!/usr/bin/env -S uv run
# /// script
# dependencies = ["pydantic", "python-dotenv", "pyyaml", "rich", "claude-agent-sdk"]
# ///
"""ADW Build + Ensemble Review - build, then N reviewers rule in parallel + synthesize.

Usage:
    uv run adws/adw_build_ensemble_review.py "<prompt or path/to/prompt.md>" [--config adws/adw_sssf_config/sssf.config.yaml] [--adw-id a1b2c3d4]

Phases: engineer(request) -> builder
        -> [review_1 || review_2 || review_3] -> synthesize
        [-> builder(revise) -> reviewers -> synthesize ... bounded]

The ensemble twin of adw_build_review: the single reviewer leg is replaced by
three INDEPENDENT reviewers running CONCURRENTLY (run.fan_out, distinct
identities/sessions) plus a synthesizer that consolidates their verdicts. The
builder then revises against that ONE consolidated verdict, so the bounded
revise loop is unchanged in shape.

Review is not testing. A rejection does not fail a phase; it fails the RUN,
decided at finish() after the revise loop has had its chances. A reviewer branch
that errors is isolated - the synthesizer consolidates whatever survived; only a
round where zero reviewers came back stops the loop with a decline.
"""

import argparse
import sys

from adw_modules import agents, ensemble, gates, session, utils
from adw_modules.data_types import AgentCall, BuildOutput, PhaseParams

REQUIRED_AGENTS = ["builder", *ensemble.REVIEWERS, ensemble.SYNTHESIZER]
MAX_REVISION_LOOPS = 3


def main(prompt: str, config: str = "adws/adw_sssf_config/sssf.config.yaml",
         adw_id: str | None = None) -> int:
    cfg = agents.load_config(config)
    agents.validate(cfg, REQUIRED_AGENTS)
    run = session.ensure(cfg, adw_id)

    with run.phase(PhaseParams(name="request", kind="engineer", owner=run.engineer,
                               description="Capture the incoming ask")) as ph:
        ph.log(input=prompt)

    with run.phase(PhaseParams(name="build", kind="agent", owner="builder",
                               description="Implement the request")) as ph:
        previous = ph.call(AgentCall(output_type=BuildOutput, prompt=prompt,
                                     gates=[gates.diff_matches_claims]))

    verdict = None
    for i in range(1, MAX_REVISION_LOOPS + 1):
        verdict = ensemble.ensemble_review(run, prompt, previous, synth_phase=f"synthesize_{i}")
        if verdict is None:
            return run.finish(accepted=False,
                              reason="no reviewer completed - nothing to synthesize")
        if verdict.approved:
            break
        if i == MAX_REVISION_LOOPS:
            break

        with run.phase(PhaseParams(name=f"revise_{i}", kind="agent", owner="builder", retries=1,
                                   description="Close every blocking finding the synthesis named")) as ph:
            previous = ph.call(AgentCall(output_type=BuildOutput, prompt=prompt, previous=verdict,
                                         gates=[gates.diff_matches_claims]))

    return run.finish(accepted=verdict is not None and verdict.approved,
                      reason=f"the synthesized verdict never approved after {MAX_REVISION_LOOPS} revision(s)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prompt", help="inline text or a path to a prompt file")
    parser.add_argument("--config", default="adws/adw_sssf_config/sssf.config.yaml")
    parser.add_argument("--adw-id", default=None, help="join or pin an existing session")
    args = parser.parse_args()
    sys.exit(main(utils.resolve_prompt(args.prompt), args.config, args.adw_id))
