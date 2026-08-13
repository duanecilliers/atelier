#!/usr/bin/env -S uv run
# /// script
# dependencies = ["pydantic", "python-dotenv", "pyyaml", "rich", "claude-agent-sdk"]
# ///
"""ADW Ensemble Review - N independent reviewers rule in parallel, then synthesize.

Usage:
    uv run adws/adw_ensemble_review.py "<prompt or path/to/prompt.md>" [--config adws/adw_sssf_config/sssf.config.yaml] [--adw-id a1b2c3d4]

Phases: engineer(request) -> [review_1 || review_2 || review_3] -> synthesize

Three reviewers with distinct identities (pr_reviewer_1/2/3) rule on the same
change CONCURRENTLY via run.fan_out - each in its own blind coding-agent session,
so independence is preserved. A synthesizer then consolidates their verdicts into
one decision. This is review-only: it judges the code already on disk (`git diff`),
so there is no builder and no revise loop - pair it after a build, or run it to
audit a working tree.

Like the single-reviewer ADW, a rejection does not fail a phase; it fails the RUN,
decided at finish() from the synthesizer's consolidated verdict. A reviewer branch
that errors is isolated (fan_out never tears the run down, and a branch phase is
non-gating); the synthesizer consolidates whatever reviews survived, and the run
only declines outright when zero reviewers came back.
"""

import argparse
import sys

from adw_modules import agents, ensemble, session, utils
from adw_modules.data_types import PhaseParams

REQUIRED_AGENTS = [*ensemble.REVIEWERS, ensemble.SYNTHESIZER]


def main(prompt: str, config: str = "adws/adw_sssf_config/sssf.config.yaml",
         adw_id: str | None = None) -> int:
    cfg = agents.load_config(config)
    agents.validate(cfg, REQUIRED_AGENTS)
    run = session.ensure(cfg, adw_id)

    with run.phase(PhaseParams(name="request", kind="engineer", owner=run.engineer,
                               description="Capture the incoming ask")) as ph:
        ph.log(input=prompt)

    synthesis = ensemble.ensemble_review(run, prompt, previous=None)
    if synthesis is None:
        return run.finish(accepted=False,
                          reason="no reviewer completed - nothing to synthesize")
    return run.finish(accepted=synthesis.approved,
                      reason="the synthesized verdict withheld approval")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prompt", help="inline text or a path to a prompt file")
    parser.add_argument("--config", default="adws/adw_sssf_config/sssf.config.yaml")
    parser.add_argument("--adw-id", default=None, help="join or pin an existing session")
    args = parser.parse_args()
    sys.exit(main(utils.resolve_prompt(args.prompt), args.config, args.adw_id))
