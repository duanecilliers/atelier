"""permissions.py - the access-control decision core (pure half).

`permitted()` is the security decision function; `_glob`/`_matches` back it. The
load-bearing invariant is that `*` must NOT cross `/` (fnmatch would widen every
pattern). The side-effectful half (snapshot/enforce/_roll_back) is in
test_permissions_rollback.py (needs a git repo).
"""
from __future__ import annotations

import pytest

from adw_modules import permissions as perm
from adw_modules.data_types import AgentConfig, ConfigDefaults, PromptEngineering, SSSFConfig


def _agent(name: str = "a", writes=None) -> AgentConfig:
    return AgentConfig(
        name=name, prompt_engineering=PromptEngineering(system="s", user="u"), writes=writes
    )


def _cfg(protected=None, data_dir: str = "adws/adw_data") -> SSSFConfig:
    return SSSFConfig(defaults=ConfigDefaults(protected_files=protected or [], data_dir=data_dir))


class TestMatches:
    def test_star_does_not_cross_slash(self):
        # the exact widening bug the module's docstring calls out
        assert perm._matches("adws/adw_scout.py", "adws/adw_*.py")
        assert not perm._matches("adws/adw_data/sessions/x/y.py", "adws/adw_*.py")

    def test_double_star_crosses(self):
        assert perm._matches("src/x/y.ts", "src/**")
        assert not perm._matches("src/x/y.ts", "src/*")

    def test_question_is_single_non_slash(self):
        assert perm._matches("ab", "a?")
        assert not perm._matches("a/b", "a?b")

    def test_trailing_slash_is_dir_prefix(self):
        assert perm._matches("adws/adw_data/x", "adws/adw_data/")
        assert not perm._matches("adws/other/x", "adws/adw_data/")

    def test_exact_match(self):
        assert perm._matches("specs/x.md", "specs/x.md")
        assert not perm._matches("specs/y.md", "specs/x.md")


class TestChangedPaths:
    def test_value_change_registers(self):
        assert perm.changed_paths({"a": "1,2"}, {"a": "3,4"}) == ["a"]

    def test_identical_is_empty(self):
        assert perm.changed_paths({"a": "1,1"}, {"a": "1,1"}) == []

    def test_appeared_and_vanished(self):
        # b appeared, c vanished (revert counts as a change)
        assert perm.changed_paths({"c": "1,0"}, {"b": "untracked"}) == ["b", "c"]


class TestPermitted:
    def test_data_dir_always_writable_even_read_only(self):
        cfg = _cfg(data_dir="adws/adw_data")
        assert perm.permitted("adws/adw_data/sessions/x/env.json", _agent(writes=[]), cfg)

    def test_naming_a_path_unlocks_a_protected_one(self):
        cfg = _cfg(protected=["adws/adw_modules/"])
        agent = _agent(writes=["adws/adw_modules/"])
        assert perm.permitted("adws/adw_modules/x.py", agent, cfg)

    def test_protected_denies_unrestricted_agent(self):
        cfg = _cfg(protected=["adws/adw_modules/"])
        assert not perm.permitted("adws/adw_modules/x.py", _agent(writes=None), cfg)

    def test_unrestricted_allows_unprotected(self):
        cfg = _cfg(protected=["adws/adw_modules/"])
        assert perm.permitted("cockpit/lib/x.ts", _agent(writes=None), cfg)

    def test_read_only_blocks_unprotected(self):
        cfg = _cfg()
        assert not perm.permitted("cockpit/lib/x.ts", _agent(writes=[]), cfg)

    def test_allowlist_permits_only_its_paths(self):
        cfg = _cfg()
        agent = _agent(writes=["specs/"])
        assert perm.permitted("specs/plan.md", agent, cfg)
        assert not perm.permitted("docs/other.md", agent, cfg)

    def test_glob_writes_entry(self):
        cfg = _cfg()
        agent = _agent(writes=["**/*.md"])
        assert perm.permitted("docs/deep/x.md", agent, cfg)
        assert not perm.permitted("docs/deep/x.ts", agent, cfg)
