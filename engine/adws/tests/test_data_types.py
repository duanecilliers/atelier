"""data_types.py - the Pydantic validators + small pure model logic.

These are construction-time invariants (a bad config/phase fails before anything
runs) and pure accessors. We do NOT test that pydantic validates - only our own
rules layered on top.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from adw_modules.data_types import (
    BaseRef,
    GateReport,
    PhaseParams,
    QualityCheckConfig,
    SandboxConfig,
    SandboxProfile,
    UsageBreakdown,
)


class TestPhaseDescription:
    def test_good_description_ok(self):
        p = PhaseParams(name="commit_plan", kind="code", owner="git",
                        description="Land the plan artifact so the builder can start clean")
        assert p.description.startswith("Land the plan")

    def test_blank_rejected(self):
        with pytest.raises(ValidationError):
            PhaseParams(name="x", kind="code", owner="git", description="   ")

    def test_name_restatement_rejected(self):
        # description that only restates the name (underscores -> spaces) is out.
        with pytest.raises(ValidationError):
            PhaseParams(name="build", kind="agent", owner="builder", description="Build")
        with pytest.raises(ValidationError):
            PhaseParams(name="commit_plan", kind="code", owner="git", description="commit plan")


class TestQualityArgv:
    def test_good_argv_ok(self):
        c = QualityCheckConfig(argv=["pnpm", "typecheck"])
        assert c.argv[0] == "pnpm"

    def test_empty_argv_rejected(self):
        with pytest.raises(ValidationError):
            QualityCheckConfig(argv=[])

    def test_blank_first_element_rejected(self):
        with pytest.raises(ValidationError):
            QualityCheckConfig(argv=["   "])


class TestUsageBreakdown:
    def test_add_turn_folds_and_accumulates(self):
        u = UsageBreakdown()
        u.add_turn({"input": 10, "output": 5, "cacheRead": 2, "cacheWrite": 1,
                    "reasoning": 3, "cost": {"input": 0.1, "output": 0.2, "total": 0.3}}, 18)
        u.add_turn({"input": 4, "cost": {"total": 0.05}}, 4)
        assert u.input_tokens == 14
        assert u.output_tokens == 5
        assert u.cache_read_tokens == 2
        assert u.total_tokens == 22
        assert u.total_cost == pytest.approx(0.35)

    def test_add_turn_is_none_safe(self):
        u = UsageBreakdown()
        u.add_turn({}, 0)  # missing keys / no cost -> no crash, all zero
        assert u.total_tokens == 0 and u.total_cost == 0.0

    def test_merge_sums_every_field(self):
        # distinct value per field so a merge that drops or mis-maps any one field
        # is caught (the point of "sums EVERY field").
        fields = list(UsageBreakdown().model_dump())
        a = UsageBreakdown(**{f: i + 1 for i, f in enumerate(fields)})
        b = UsageBreakdown(**{f: 100 + i for i, f in enumerate(fields)})
        a.merge(b)
        for i, f in enumerate(fields):
            assert getattr(a, f) == pytest.approx((i + 1) + (100 + i)), f


class TestBaseRefLabel:
    def test_full_sha_shortened(self):
        sha = "0" * 40
        assert BaseRef(ref=sha, commit=sha).label == "0000000"

    def test_named_ref_verbatim(self):
        assert BaseRef(ref="main", commit="deadbeef").label == "main"

    def test_non_hex_40_is_not_a_sha(self):
        ref = "z" * 40
        assert BaseRef(ref=ref, commit="x").label == ref


class TestSandboxProfileFor:
    def test_levels_map_to_profiles(self):
        cfg = SandboxConfig(worktree=SandboxProfile(), worktree_env=SandboxProfile(branch="feat/x"))
        assert cfg.profile_for("worktree") is cfg.worktree
        assert cfg.profile_for("worktree_env") is cfg.worktree_env

    def test_local_and_unknown_are_none(self):
        cfg = SandboxConfig()
        assert cfg.profile_for("local") is None
        assert cfg.profile_for(None) is None
        assert cfg.profile_for("container") is None


class TestGateReport:
    def test_check_chains_and_reports_violations(self):
        r = GateReport().check("a", True).check("b", False, "missing x")
        assert not r.passed
        assert r.violations == ["b: missing x"]

    def test_all_ok_passes(self):
        r = GateReport().check("a", True)
        assert r.passed
        assert r.violations == []
