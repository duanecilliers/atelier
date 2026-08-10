"""branch_namer.py - slug + validation (pure half).

`_slugify` normalizes model output to a git-ref- AND shell-safe branch; every
rule maps to a git-rejects-this or shell-injection case. `_is_valid` is the
last-line git-ref validator. (resolve_branch's precedence is covered in
test_agents-adjacent fixture tests; here we pin the pure normalizers.)
"""
from __future__ import annotations

import re

from adw_modules import branch_namer as bn

SAFE = re.compile(r"[a-z0-9._/-]*")


class TestSlugify:
    def test_lowercases(self):
        assert bn._slugify("Feat/Foo").startswith("feat/foo")

    def test_spaces_become_dashes(self):
        assert bn._slugify("add rate limiting") == "add-rate-limiting"

    def test_collapses_dash_runs(self):
        assert bn._slugify("a---b") == "a-b"

    def test_strips_shell_metacharacters(self):
        out = bn._slugify("a; rm -rf / && b `whoami`")
        assert SAFE.fullmatch(out), out
        assert ";" not in out and "`" not in out and "&" not in out

    def test_kills_double_dots(self):
        assert ".." not in bn._slugify("a..b")
        assert ".." not in bn._slugify("../../etc")

    def test_strips_leading_trailing_separators(self):
        out = bn._slugify("-/foo/bar/-")
        assert not out.startswith(("-", "/", "."))
        assert not out.endswith(("-", "/", "."))

    def test_truncates_to_60(self):
        assert len(bn._slugify("a" * 200)) <= 60

    def test_underscore_preserved(self):
        # underscore is in the allowed charset (ticket-style keys keep it)
        assert "_" in bn._slugify("feat/foo_bar")

    def test_empty_on_all_junk(self):
        assert bn._slugify("!!!") == ""


class TestIsValid:
    def test_accepts_normal_branches(self):
        assert bn._is_valid("feat/api-rate-limiting")
        assert bn._is_valid("adw/3f2a1b0c")

    def test_rejects(self):
        for bad in ["", "..", "a..b", "-x", "/x", "x/", "x.lock", "a b", "a;b"]:
            assert not bn._is_valid(bad), bad
