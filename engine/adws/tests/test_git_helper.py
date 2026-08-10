"""git_helper.py - the bits with real logic (tmp git repo).

Skips the thin `git` shims; pins git_common_dir, merge_base's HEAD-on-base
behavior, diff_counts numstat parsing, and worktree_add's fork.
"""
from __future__ import annotations

from adw_modules import git_helper as gh


def test_git_common_dir_resolves_to_dotgit(repo, monkeypatch):
    monkeypatch.chdir(repo.path)
    assert gh.git_common_dir() == (repo.path / ".git").resolve()


def test_merge_base_on_base_branch_is_head(repo, monkeypatch):
    monkeypatch.chdir(repo.path)
    assert gh.merge_base("HEAD") == gh.rev("HEAD")


def test_diff_counts_parses_numstat(repo, monkeypatch):
    monkeypatch.chdir(repo.path)
    repo.write("f.txt", "a\nb\n")
    repo.git("add", "f.txt")
    repo.git("commit", "-q", "-m", "add f")
    repo.write("f.txt", "a\nb\nc\n")  # +1 line vs HEAD, unstaged tracked change
    assert gh.diff_counts("HEAD") == (1, 0)


def test_worktree_add_forks_a_new_branch(repo, monkeypatch, tmp_path):
    monkeypatch.chdir(repo.path)
    wt = tmp_path.parent / f"{tmp_path.name}_wt"  # outside the repo
    assert not gh.branch_exists(repo.path, "feat/x")
    gh.worktree_add(repo.path, wt, "feat/x")
    try:
        assert gh.branch_exists(repo.path, "feat/x")
        assert (wt / ".git").exists()  # a worktree has a .git file
    finally:
        gh.worktree_remove(repo.path, wt)
