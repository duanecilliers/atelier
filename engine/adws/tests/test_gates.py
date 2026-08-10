"""gates.py - claim gates (pure verdict + tmp-file artifact checks).

verdict_consistent checks a review envelope against itself (no I/O). The artifact
gates verify declared paths on disk.
"""
from __future__ import annotations

from types import SimpleNamespace

from adw_modules import gates
from adw_modules.data_types import GenericOutput, ReviewFinding, ReviewOutput


def _review(approved, blocking=None, findings=None) -> ReviewOutput:
    return ReviewOutput(status="success", approved=approved,
                        blocking=blocking or [], findings=findings or [])


class TestVerdictConsistent:
    def test_clean_approval_passes(self):
        r = gates.verdict_consistent(_review(True), run=None)
        assert r.passed

    def test_approved_with_blocking_fails(self):
        r = gates.verdict_consistent(_review(True, blocking=["ship blocker"]), run=None)
        assert not r.passed

    def test_approved_with_unmet_finding_fails(self):
        finding = ReviewFinding(requirement="add endpoint", met=False, evidence="missing")
        r = gates.verdict_consistent(_review(True, findings=[finding]), run=None)
        assert not r.passed

    def test_rejection_without_a_named_problem_fails(self):
        r = gates.verdict_consistent(_review(False), run=None)
        assert not r.passed  # approved=false but nothing named

    def test_supported_rejection_passes(self):
        r = gates.verdict_consistent(_review(False, blocking=["needs tests"]), run=None)
        assert r.passed


class TestArtifactsExist:
    def test_missing_artifact_flagged(self, tmp_path):
        present = tmp_path / "there.md"
        present.write_text("x")
        env = GenericOutput(status="success", artifacts=[str(present), str(tmp_path / "gone.md")])
        r = gates.artifacts_exist(env, run=None)
        assert not r.passed
        assert any("does not exist" in v for v in r.violations)


class TestArtifactsWithinHandoff:
    def test_inside_handoff_ok_outside_flagged(self, tmp_path):
        (tmp_path / "handoff").mkdir()
        (tmp_path / "handoff" / "report.md").write_text("x")
        run = SimpleNamespace(repo_root=str(tmp_path), context_handoff_dir="handoff")
        env = GenericOutput(status="success", artifacts=["handoff/report.md", "src/x.md"])
        r = gates.artifacts_within_handoff(env, run)
        assert not r.passed  # src/x.md is outside the handoff dir
        assert any("src/x.md" in v for v in r.violations)
