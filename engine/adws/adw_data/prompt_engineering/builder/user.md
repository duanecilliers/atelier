# Build Task

## Variables

### prompt

{{prompt}}

### previous_envelope

{{previous_envelope}}

### context_handoff_dir

{{context_handoff_dir}}

## Task

Implement the work described in `prompt`, guided by `previous_envelope` if present, then emit your `Report` JSON.

## Report

Respond with ONLY valid JSON matching `BuildOutput` — no prose before or after:

```json
{
  "status": "success",
  "summary": "<one sentence describing what you built>",
  "changed_files": ["src/server.ts"],
  "artifacts": [],
  "commit_message": "<the full git commit message for the code you changed, as one JSON string with newlines: a subject line that follows the repository's commit convention (stated in the project guidance in your instructions — e.g. Conventional Commits like `feat(scope): summary` when the project uses them), then a blank line, then a short body of what changed and why. This IS the commit; when a sandbox lands as a PR its title and description are taken from this subject and body, so a bare subject leaves the PR with no description>",
  "notes_for_next_agent": "<how to verify this work>"
}
```
