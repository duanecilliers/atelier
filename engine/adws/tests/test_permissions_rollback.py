"""permissions.py - the side-effectful half (tmp git repo).

The three rollback branches are the dangerous logic the module exists for
(an agent that ran `git checkout adws/` and discarded uncommitted work):
  introduced-untracked -> delete
  introduced-tracked   -> git checkout
  already-dirty-then-reverted -> REVERTED-BY-AGENT (cannot restore)
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from adw_modules import permissions as perm
from adw_modules.data_types import AgentConfig, ConfigDefaults, PromptEngineering, SSSFConfig


def _run(repo, protected=None):
    cfg = SSSFConfig(defaults=ConfigDefaults(protected_files=protected or [], data_dir="adws/adw_data"))
    return SimpleNamespace(repo_root=str(repo.path), cfg=cfg)


def _readonly_agent():
    return AgentConfig(name="scout", prompt_engineering=PromptEngineering(system="s", user="u"), writes=[])


def test_introduced_untracked_is_deleted(repo):
    run = _run(repo)
    before = perm.snapshot(run)
    repo.write("stray.ts", "sneaky\n")  # a read-only agent created a repo file
    with pytest.raises(perm.PermissionBreach):
        perm.enforce(run, None, _readonly_agent(), before)
    assert not (repo.path / "stray.ts").exists()  # rolled back by deletion


def test_introduced_tracked_change_is_checked_out(repo):
    repo.write("prot.py", "orig\n")
    repo.git("add", "prot.py")
    repo.git("commit", "-q", "-m", "add prot")
    run = _run(repo)
    before = perm.snapshot(run)  # clean
    repo.write("prot.py", "tampered\n")  # read-only agent modified a tracked file
    with pytest.raises(perm.PermissionBreach):
        perm.enforce(run, None, _readonly_agent(), before)
    assert (repo.path / "prot.py").read_text() == "orig\n"  # restored


def test_agent_reverted_engineers_work_is_named_not_restored(repo):
    repo.write("d.py", "orig\n")
    repo.git("add", "d.py")
    repo.git("commit", "-q", "-m", "add d")
    repo.write("d.py", "engineer-wip\n")  # engineer's uncommitted work
    run = _run(repo)
    before = perm.snapshot(run)  # d.py is dirty here
    repo.write("d.py", "orig\n")  # agent reverts it back to HEAD -> now "clean"
    with pytest.raises(perm.PermissionBreach) as ei:
        perm.enforce(run, None, _readonly_agent(), before)
    assert "REVERTED-BY-AGENT" in str(ei.value)  # cannot reconstruct the lost wip


def test_permitted_change_does_not_raise(repo):
    run = _run(repo)
    before = perm.snapshot(run)
    repo.write("specs/plan.md", "a plan\n")
    agent = AgentConfig(name="planner", prompt_engineering=PromptEngineering(system="s", user="u"),
                        writes=["specs/"])
    touched = perm.enforce(run, None, agent, before)
    assert "specs/plan.md" in touched
    assert (repo.path / "specs/plan.md").exists()  # left in place
