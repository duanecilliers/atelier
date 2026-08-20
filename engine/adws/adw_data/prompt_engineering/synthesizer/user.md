# Synthesis Task

## Variables

### prompt

{{prompt}}

### context_handoff_dir

{{context_handoff_dir}}

### agent_name

{{agent_name}}

## Task

`prompt` above carries the original ask followed by every independent reviewer's
full `ReviewOutput`. Consolidate them into one verdict.

1. Establish the spec: the ask is at the top of `prompt` (or `<context_handoff_dir>/plan.md` if it exists).
2. Read each reviewer's findings and blocking items. Group findings by requirement.
3. Decide each disputed point on the evidence - read the code (`git diff`, the cited files) to break ties.
4. Weigh each reviewer by the evidence it actually has. `checks_executed` says whether that reviewer ran one of this project's checks, and `checks_note` says which, or why it could not run. On any claim about behavior, a reviewer that ran a check outranks one that did not - a blocker resting only on a check that never ran is not a blocker, and a reviewer whose check failed to start reported nothing about the code. Say so in `summary` when a verdict turned on that. Do not re-run the suite yourself: the run's own verify phase runs it deterministically, and three reviewers plus you racing the same working tree is how checks corrupt each other.
5. Produce one merged `findings` list (one entry per requirement) and one de-duplicated `blocking` list of the REAL gaps.
6. Write the consolidated review to `<context_handoff_dir>/synthesis.md` - an absolute path, your only write target. Then emit your `Report` JSON.

## Report

Respond with ONLY valid JSON matching `ReviewOutput` - no prose before or after:

```json
{
  "status": "success",
  "approved": false,
  "summary": "<one sentence: the consolidated verdict and any reviewer disagreement>",
  "findings": [
    { "requirement": "<the ask, in the requester's words>", "met": true, "evidence": "src/server.ts:42 - confirmed; reviewers 1 and 3 agreed" }
  ],
  "blocking": ["<a real, concrete gap that must change before approval>"],
  "checks_executed": false,
  "checks_note": "<which reviewers' checks ran, and which could not>",
  "artifacts": ["<context_handoff_dir>/synthesis.md"],
  "notes_for_next_agent": "<what the builder must fix, or how to verify if approved>"
}
```

On a synthesis envelope `checks_executed` carries forward, not up: it is true when at
least one reviewer you consolidated actually ran a check, and false when none did. It
never means you ran one - you do not.

`status` is `success` when the synthesis itself completed - it is not the verdict.
The verdict is `approved`, and it is true only when your consolidated `blocking`
is empty and every requirement is met.
