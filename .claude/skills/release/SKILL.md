---
name: release
description: >-
  Cut an Atelier release end to end - decide the version bump, branch, commit, open the PR,
  wait for CI, squash-merge, tag, and publish the GitHub release. Use when the user says
  "create a release", "finalise the release", "cut a release", "ship this", "tag a release",
  or "bump the version". Keywords - release, cut a release, tag, version bump, publish,
  gh release, squash merge, ship it.
argument-hint: "[patch | minor | no-bump | resume]"
---

# Release

The policy lives in `AGENTS.md` ("Versioning & releases", "Pull requests", "Commit
guidelines") and stays the source of truth. This is the procedure that applies it.

**The two rules that shape everything below:** this repo is **squash-only**, so the PR title
and body become the durable commit message on `main` and the branch's own commits do not
survive. And **merging and tagging are outward-facing** - confirm each with the user before
running it, unless they already said to finalise the release.

## 0. Read the state before doing anything

```bash
git status --short && git log --oneline -3
grep '"version"' cockpit/package.json          # the single version-of-record
git tag -l | sort -V | tail -3
gh pr list --state open
```

Do not assume you are starting at step 1. Work may already be committed, pushed, or merged.
Pick up at the first step that has not happened yet, and never redo a completed one - a
second `gh release create` on the same tag fails, a second tag needs a delete first.

## 1. Decide the bump

Pre-1.0, so both halves stay in `0.x`. Frame by the headline change:

| Change | Bump |
| --- | --- |
| Bug fix to shipped behavior | patch (`0.8.0` -> `0.8.1`) |
| New feature | minor (`0.8.x` -> `0.9.0`) |
| Bugfix-led with a small additive feature riding along | patch is fine |
| Docs-only, dev-infra, CI, test-only | **no bump, no tag** - ship the PR untagged |

Never bump `engine/adws/pyproject.toml`; it is a dev-only shim pinned at `version = "0"`.
There is no top-level `VERSION` file and no `CHANGELOG`. If the bump is not obvious, state
your call and why in one line rather than asking.

## 2. Branch and commit

```bash
git checkout -b <type>/<short-slug>
```

Group the work into atomic commits (see `AGENTS.md` "Commit guidelines"), each leaving the
tree working. Then the bump as its **own final commit, in the same PR**, so the version lands
in the squash commit:

```bash
cd cockpit && npm pkg set version=X.Y.Z && cd ..
git add cockpit/package.json && git commit -m "chore(release): bump to X.Y.Z"
git show --stat HEAD          # confirm it is a one-line diff, not a reformat
```

No `Co-Authored-By` footer. No em dashes anywhere - plain hyphens.

## 3. Gates

Both must be green before the PR goes up:

```bash
just test                     # engine pytest + cockpit vitest + check:mirror + check:types
cd cockpit && pnpm typecheck
```

`pnpm check:contract` needs a live `sssf.db` and is local-only; run it if the change touched
the schema in `tracer.py`. If the change touched agent-authored behavior rather than the
deterministic half, kick a real ADW and read its trace - the suites do not cover that.

## 4. Open the PR

```bash
git push -u origin <branch>
gh pr create --title "<type>(<scope>): <description> (vX.Y.Z)" --body-file - <<'BODY'
...
BODY
```

Write the body as the **durable record**, because that is exactly what it becomes on `main`.
What earns its place: what the defect or feature actually is, why the fix takes the shape it
does (especially any constraint that ruled out the obvious approach), and the evidence -
tests, gate output, a live run. No `Generated with Claude Code` footer.

## 5. Wait for CI, then confirm the merge

Watch the checks rather than polling by hand:

```bash
gh pr checks <N>
```

Report the result. Then **confirm with the user**, and only then:

```bash
gh pr merge <N> --squash --delete-branch
git checkout main && git pull --ff-only
git log --oneline -1 && grep '"version"' cockpit/package.json
```

`--merge` and `--rebase` are disabled on this repo and will fail.

## 6. Tag, and publish the release

A release is an **annotated** tag on `main` matching `cockpit/package.json`. Confirm with the
user first, same as the merge:

```bash
git tag -a vX.Y.Z -m "<one-line release summary>"
git push origin vX.Y.Z
gh release create vX.Y.Z --title "vX.Y.Z" --notes-file - <<'BODY'
...
BODY
```

The release notes are for a reader who was not in the conversation: what changed and why it
matters, not a commit list. Close with the compare link:
`https://github.com/duanecilliers/atelier/compare/v<prev>...vX.Y.Z`.

Tags are **repo-wide**, not cockpit-only - an engine-only or config-only change is a
legitimate tag even when no cockpit code moved.

## 7. Verify and report

```bash
git status --short && git log --oneline -1
gh release view vX.Y.Z --json tagName,isDraft,publishedAt
```

Report the release URL, the squash commit sha, and anything deliberately left out of scope.

## When a stamped repo needs the change

`adw_modules/*.py` and `engine/skills/atelier/` are MANAGED: stamped repos (repayd, tmu) pick
changes up on their next `update`, with no re-stamp. If a release changes managed engine
behavior, say so in the report - the re-stamp is the operator's call, not part of this flow.
