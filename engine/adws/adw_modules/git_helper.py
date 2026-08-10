"""Low-level git operations for code phases. All low-level logic lives in adw_modules."""

from __future__ import annotations

import subprocess
from pathlib import Path


def _git(*args: str) -> str:
    result = subprocess.run(["git", *args], capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def _git_at(cwd: str | Path, *args: str) -> str:
    """`git -C <cwd> …` — run against a specific tree (a worktree, not the cwd)."""
    return _git("-C", str(cwd), *args)


def current_branch() -> str:
    return _git("rev-parse", "--abbrev-ref", "HEAD")


def create_branch(name: str) -> str:
    _git("checkout", "-b", name)
    return name


def is_repo() -> bool:
    result = subprocess.run(["git", "rev-parse", "--git-dir"],
                            capture_output=True, text=True)
    return result.returncode == 0


def repo_root() -> Path:
    """Absolute root of the codebase — where agents are spawned to work.

    The git toplevel when there is one, else the process cwd (ADWs run fine in a
    non-git dir; only a commit phase requires a repo). Always absolute, so it is
    safe to hand to a subprocess regardless of where the ADW was launched from.
    """
    if is_repo():
        return Path(_git("rev-parse", "--show-toplevel")).resolve()
    return Path.cwd().resolve()


def git_common_dir() -> Path:
    """Absolute path to the git common dir - the ONE shared `.git` all worktrees
    point at. For a normal checkout this is `<root>/.git`; for a linked worktree
    (including a bare-repo worktree layout) it is the shared git dir, e.g.
    `…/acme.git`. Resolved absolute so callers can derive a stable per-repo identity
    from it regardless of which working tree they run in."""
    raw = Path(_git("rev-parse", "--git-common-dir"))
    return raw.resolve() if raw.is_absolute() else (Path.cwd() / raw).resolve()


def commit_all(message: str) -> str:
    """Stage the working tree and commit it. Returns the new short sha."""
    if not is_repo():
        raise RuntimeError(
            "not a git repository — a commit phase needs one. Run `git init` in the "
            "repo root (and make a first commit) before running an ADW that commits.")
    _git("add", "-A")
    if not _git("status", "--porcelain"):
        raise RuntimeError("nothing to commit — the preceding phases changed no files")
    _git("commit", "-m", message)
    return _git("rev-parse", "--short", "HEAD")


def changed_files() -> list[str]:
    out = _git("status", "--porcelain")
    return [line[3:] for line in out.splitlines() if line]


# ── diff plumbing (composed into a ChangeSet by documentation.py) ────────────

def ref_exists(ref: str) -> bool:
    """True when `ref` resolves to a commit. Never raises — this is a question."""
    result = subprocess.run(["git", "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"],
                            capture_output=True, text=True)
    return result.returncode == 0


def rev(ref: str = "HEAD") -> str:
    return _git("rev-parse", ref)


def short_sha(ref: str = "HEAD") -> str:
    return _git("rev-parse", "--short", ref)


def merge_base(ref: str, other: str = "HEAD") -> str:
    """The commit where `ref` and `other` diverged — the honest base of a branch.

    On the base branch itself this returns HEAD, which makes the diff exactly
    "what is not committed yet". Off it, the diff is the whole branch plus the
    working tree. One command covers both cases, so no ADW has to branch on it.
    """
    return _git("merge-base", ref, other)


def is_dirty() -> bool:
    return bool(_git("status", "--porcelain"))


def untracked_files() -> list[str]:
    out = _git("ls-files", "--others", "--exclude-standard")
    return [line for line in out.splitlines() if line]


def diff_files(base: str) -> list[str]:
    """Tracked files that differ between `base` and the working tree."""
    out = _git("diff", "--name-only", base)
    return [line for line in out.splitlines() if line]


def diff_stat(base: str) -> str:
    return _git("diff", "--stat", base)


def diff_counts(base: str) -> tuple[int, int]:
    """(insertions, deletions) across the diff. Binary files count as neither."""
    insertions = deletions = 0
    for line in _git("diff", "--numstat", base).splitlines():
        added, removed, *_ = line.split("\t")
        if added.isdigit():
            insertions += int(added)
        if removed.isdigit():
            deletions += int(removed)
    return insertions, deletions


def diff_text(base: str) -> str:
    return _git("diff", base)


# ── worktrees (the sandbox isolation mechanism) ──────────────────────────────
# The native "git" sandbox provider. A worktree is a second checkout that SHARES
# the main repo's .git, so a commit on its named branch survives `worktree remove`
# — which is exactly what a persistent sandbox needs (see docs/design/sandbox-runs.md).

def branch_exists(root: str | Path, branch: str) -> bool:
    """True when `branch` already resolves in `root`'s repo. Never raises."""
    result = subprocess.run(
        ["git", "-C", str(root), "rev-parse", "--verify", "--quiet", f"refs/heads/{branch}"],
        capture_output=True, text=True)
    return result.returncode == 0


def worktree_add(root: str | Path, path: str | Path, branch: str) -> None:
    """Add a worktree at `path` on `branch`, forking a new branch off HEAD when it
    doesn't exist yet, or checking out the existing one (re-provision). The tree is
    created OUTSIDE the repo, so no .gitignore change is needed and show-toplevel
    resolves inside it."""
    if branch_exists(root, branch):
        _git_at(root, "worktree", "add", str(path), branch)
    else:
        _git_at(root, "worktree", "add", "-b", branch, str(path), "HEAD")


def worktree_remove(root: str | Path, path: str | Path) -> None:
    """Remove a worktree. `--force` so a dirty/modified sandbox still tears down
    (explicit shutdown is a decision, not an accident). The branch and its commits
    survive in the shared .git."""
    _git_at(root, "worktree", "remove", "--force", str(path))


def worktree_prune(root: str | Path) -> None:
    """Drop git's records of worktrees whose directories are gone — startup reap of
    anything a crashed worker left behind."""
    _git_at(root, "worktree", "prune")


def head_sha(cwd: str | Path) -> str:
    """Short HEAD sha of the tree at `cwd` (a worktree) — recorded as a sandbox's tip."""
    return _git_at(cwd, "rev-parse", "--short", "HEAD")
