# Review Task

## Variables

### prompt

{{prompt}}

### previous_envelope

{{previous_envelope}}

### context_handoff_dir

{{context_handoff_dir}}

### agent_name

{{agent_name}}

## Task

Confirm that the work reported in `previous_envelope` is what was asked for.

1. Establish the spec: read `<context_handoff_dir>/plan.md` if it exists, else use `prompt`.
2. Read the code that was actually written, starting from `previous_envelope.changed_files`.
3. Rule on every requirement in the spec — one `findings` entry each, with evidence.
4. Say what check evidence your verdict rests on. `checks_executed` is true only if you actually ran one of this project's checks; `checks_note` says which and what it returned. If you ran none - not needed, or you tried and the command was unavailable or a service it needs was unreachable - set it false and say which of those it was. Never leave this silent: a reviewer whose checks did not run rests on less evidence than one whose did, and a synthesizer weighs the two differently. If your instructions carry no "Project checks" section, this project has not written its checks down: say that in `checks_note` rather than guessing an invocation.
5. Write the review to `<context_handoff_dir>/review-{{agent_name}}.md` - `context_handoff_dir` is an absolute path and your only write target; use it verbatim, never a repo directory (even one that looks like a handoff or notes folder). The `{{agent_name}}` suffix keeps parallel reviewers from clobbering one shared file. Then emit your `Report` JSON.

## Report

Respond with ONLY valid JSON matching `ReviewOutput` — no prose before or after:

```json
{
  "status": "success",
  "approved": false,
  "summary": "<one sentence: N of M requirements met>",
  "findings": [
    { "requirement": "<the ask, in the requester's words>", "met": true, "evidence": "src/server.ts:42 — handler registered" }
  ],
  "blocking": ["<what must change before this can be approved>"],
  "checks_executed": false,
  "checks_note": "<which checks you ran and what they returned, or why they could not run>",
  "artifacts": ["<context_handoff_dir>/review-{{agent_name}}.md"],
  "notes_for_next_agent": "<what the builder must fix, or how to verify if approved>"
}
```

`status` is `success` when the review itself completed — it is not the verdict. The verdict is `approved`, and it is true only when `findings` has no unmet entry and `blocking` is empty.

`checks_executed` is evidence, not a verdict: a review that ran no checks can still be a good review, and one that ran them can still reject. Say plainly which it was.
