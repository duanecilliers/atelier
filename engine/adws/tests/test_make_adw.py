"""make_adw.py - the ADW generator. Pure, no fixtures.

The generator emits Python source; a bug here is a SyntaxError or NameError in a
generated ADW that would only surface at run time. The load-bearing assertion is
that every chain the spec accepts generates source that parses.
"""
from __future__ import annotations

import ast
import itertools

import pytest

from make_adw import (
    CANONICAL,
    SpecError,
    generate,
    imports_block,
    parse_steps,
    phases_line,
    validate_name,
)


def valid_chains() -> list[list[str]]:
    """Every subsequence of CANONICAL that parse_steps accepts."""
    chains = []
    for r in range(1, len(CANONICAL) + 1):
        for combo in itertools.combinations(CANONICAL, r):
            try:
                chains.append(parse_steps(",".join(combo)))
            except SpecError:
                continue
    return chains


class TestValidateName:
    @pytest.mark.parametrize("ok", ["ship", "plan_build", "x2", "a"])
    def test_accepts(self, ok):
        assert validate_name(ok) == ok

    @pytest.mark.parametrize("bad", ["Ship", "1ship", "ship-it", "ship it", "", "_ship"])
    def test_rejects_bad_charset(self, bad):
        with pytest.raises(SpecError):
            validate_name(bad)

    @pytest.mark.parametrize("bad", ["worker", "modules", "adw_foo"])
    def test_rejects_reserved_or_prefixed(self, bad):
        with pytest.raises(SpecError):
            validate_name(bad)


class TestParseSteps:
    def test_canonical_subsequence_ok(self):
        assert parse_steps("plan,build,commit") == ["plan", "build", "commit"]
        assert parse_steps("scout") == ["scout"]

    def test_whitespace_tolerated(self):
        assert parse_steps(" plan , build ") == ["plan", "build"]

    @pytest.mark.parametrize("raw", ["review,build", "build,plan", "commit,plan"])
    def test_out_of_canonical_order_rejected(self, raw):
        with pytest.raises(SpecError, match="canonical order"):
            parse_steps(raw)

    def test_unknown_step(self):
        with pytest.raises(SpecError, match="unknown step"):
            parse_steps("plan,deploy")

    def test_duplicate(self):
        with pytest.raises(SpecError, match="duplicate"):
            parse_steps("plan,plan")

    @pytest.mark.parametrize("raw", ["", " , "])
    def test_empty(self, raw):
        with pytest.raises(SpecError):
            parse_steps(raw)

    def test_needs_at_least_one_agent(self):
        # test+commit are both code-only -> no agent phase.
        with pytest.raises(SpecError, match="at least one agent"):
            parse_steps("commit")

    def test_test_requires_build(self):
        with pytest.raises(SpecError, match="requires"):
            parse_steps("plan,test")

    def test_review_requires_build(self):
        with pytest.raises(SpecError, match="requires"):
            parse_steps("plan,review")

    def test_document_requires_build_and_commit(self):
        # document requires both build and commit; here commit is absent.
        with pytest.raises(SpecError, match="requires"):
            parse_steps("plan,build,document")

    def test_commit_needs_plan_or_build(self):
        # scout satisfies the agent rule, but commit has nothing to commit.
        with pytest.raises(SpecError, match="commit"):
            parse_steps("scout,commit")

    def test_full_chain_ok(self):
        assert parse_steps("plan,build,test,review,commit,document") == [
            "plan", "build", "test", "review", "commit", "document",
        ]


class TestGenerate:
    def test_every_valid_chain_parses(self):
        chains = valid_chains()
        # Sanity: the catalog admits a healthy spread, not just one or two.
        assert len(chains) >= 15
        for steps in chains:
            src = generate("gen_" + "_".join(steps), steps)
            try:
                ast.parse(src)
            except SyntaxError as e:  # pragma: no cover - failure detail
                raise AssertionError(f"generated ADW for {steps} does not parse: {e}\n{src}")

    def test_scaffold_present(self):
        src = generate("x", ["plan", "build", "commit"])
        assert "REQUIRED_AGENTS = [" in src
        assert "run.finish(" in src
        assert "from adw_modules import" in src
        assert 'if __name__ == "__main__":' in src

    def test_verified_chain_gates_commit(self):
        # a chain with a verify phase must gate the commit behind `verified`.
        src = generate("v", ["plan", "build", "test", "commit"])
        assert "verified = (" in src
        assert "accepted=verified" in src

    def test_linear_chain_has_no_gate(self):
        src = generate("lin", ["plan", "build", "commit"])
        assert "verified" not in src
        assert "run.finish()" in src


class TestImportsBlock:
    def test_verified_chain_pulls_quality_and_git(self):
        imp = imports_block(["plan", "build", "test", "commit"], needs_baseline=True)
        assert "quality" in imp and "git_helper" in imp

    def test_scout_only_stays_minimal(self):
        imp = imports_block(["scout"], needs_baseline=False)
        assert "quality" not in imp
        assert "changes" not in imp
        assert "git_helper" not in imp

    def test_document_pulls_changes(self):
        imp = imports_block(["plan", "build", "commit", "document"], needs_baseline=True)
        assert "changes" in imp
        assert "ChangeCapture" in imp


def test_phases_line_starts_with_engineer():
    line = phases_line(["plan", "build", "commit"])
    assert line.startswith("engineer(request) -> ")
    assert "planner" in line and "builder" in line
