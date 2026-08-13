"""runner.py fan-out - concurrent agent phases without tearing the run down.

fan_out() allocates contiguous seqs under a lock, runs each branch in its own
thread, and turns a branch exception into a per-branch RESULT (never a
session_finish). These tests drive it with pure-Python branch fns (no model call)
against a real tmp Tracer, so they stay in `just test`.
"""
from __future__ import annotations

import json

from adw_modules.data_types import PhaseParams, SSSFConfig
from adw_modules.runner import Run
from adw_modules.tracer import Tracer


def _run(tmp_path, monkeypatch) -> Run:
    # Anchor the sink under tmp so session_dir/agent_map land there, not in the repo.
    monkeypatch.setenv("SSSF_TRACE_ROOT", str(tmp_path))
    tracer = Tracer(tmp_path / "sssf.db", tmp_path / "events.jsonl")
    tracer.session_start("adw00001", "tester", adw_name="test")
    return Run(cfg=SSSFConfig(), adw_id="adw00001", tracer=tracer, engineer="tester")


def _params(name: str) -> PhaseParams:
    return PhaseParams(name=name, kind="agent", owner=name,
                       description=f"run the {name} branch of the fan-out")


def _session_status(run: Run) -> str:
    (status,) = run.tracer.conn.execute(
        "SELECT status FROM sessions WHERE adw_id=?", ("adw00001",)).fetchone()
    return status


def test_allocates_distinct_contiguous_seqs(tmp_path, monkeypatch):
    run = _run(tmp_path, monkeypatch)
    results = run.fan_out([(_params(f"b{i}"), lambda ph, i=i: f"value-{i}")
                           for i in range(4)])

    assert [r.value for r in results] == ["value-0", "value-1", "value-2", "value-3"]
    assert all(r.ok for r in results)
    seqs = sorted(r.phase.seq for r in results)
    assert seqs == [1, 2, 3, 4]                      # distinct, contiguous, no blanks
    assert len({r.phase.phase_id for r in results}) == 4


def test_branch_failure_is_isolated_and_never_finalizes_the_run(tmp_path, monkeypatch):
    run = _run(tmp_path, monkeypatch)

    def boom(ph):
        raise RuntimeError("branch two blew up")

    results = run.fan_out([
        (_params("ok_a"), lambda ph: "a"),
        (_params("bad"), boom),
        (_params("ok_c"), lambda ph: "c"),
    ])

    ok_a, bad, ok_c = results
    assert ok_a.ok and ok_a.value == "a"
    assert ok_c.ok and ok_c.value == "c"
    assert not bad.ok
    assert isinstance(bad.error, RuntimeError)
    assert bad.phase.status == "fail"
    assert "branch two blew up" in (bad.phase.error or "")
    # The whole point: a branch failure does NOT tear the session down. The run is
    # still 'running' - the ADW rules on the results at finish(), not fan_out.
    assert _session_status(run) == "running"
    # Siblings recorded success in the trace.
    rows = dict(run.tracer.conn.execute("SELECT name, status FROM phases"))
    assert rows == {"ok_a": "success", "bad": "fail", "ok_c": "success"}


def test_seq_is_continuous_across_sequential_and_fanout(tmp_path, monkeypatch):
    run = _run(tmp_path, monkeypatch)

    with run.phase(_params("first")):
        pass
    run.fan_out([(_params("f1"), lambda ph: 1), (_params("f2"), lambda ph: 2)])
    with run.phase(_params("last")):
        pass

    seqs = sorted(seq for (seq,) in
                  run.tracer.conn.execute("SELECT seq FROM phases WHERE adw_id=?", ("adw00001",)))
    assert seqs == [1, 2, 3, 4]                      # monotonic, gap-free


def test_branch_log_events_attribute_to_their_own_phase(tmp_path, monkeypatch):
    """Console phase context is thread-local, so a branch's log lines carry ITS
    phase_id even while a sibling is mid-flight."""
    run = _run(tmp_path, monkeypatch)

    def note(ph):
        run.console.note(f"marker-{ph.phase.params.name}")
        return ph.phase.phase_id

    results = run.fan_out([(_params("alpha"), note), (_params("beta"), note)])
    by_name = {r.phase.params.name: r.phase.phase_id for r in results}

    logs = run.tracer.conn.execute("SELECT payload_json, phase_id FROM events WHERE type='log'")
    marked = {}
    for payload, phase_id in logs:
        message = json.loads(payload).get("message", "")
        for name in ("alpha", "beta"):
            if f"marker-{name}" in message:
                marked[name] = phase_id
    assert marked == {"alpha": by_name["alpha"], "beta": by_name["beta"]}


def test_failed_fanout_branch_is_non_gating_so_the_run_can_still_pass(tmp_path, monkeypatch):
    """A reviewer branch that errors must NOT by itself fail the run: the ADW rules
    via BranchResult + accepted (synthesize-from-survivors). fan_out marks branch
    phases non-gating, so finish() ignores their status."""
    run = _run(tmp_path, monkeypatch)
    with run.phase(_params("setup")):          # a gating sequential phase, succeeds
        pass

    def boom(ph):
        raise RuntimeError("pr_reviewer_2 backend error")

    run.fan_out([(_params("r1"), lambda ph: "ok"),
                 (_params("r2"), boom),
                 (_params("r3"), lambda ph: "ok")])

    code = run.finish(accepted=True)
    assert code == 0                            # green despite the failed branch
    assert _session_status(run) == "success"
    # ...but the failed branch is still recorded HONESTLY as a failed phase.
    rows = dict(run.tracer.conn.execute("SELECT name, status FROM phases"))
    assert rows["r2"] == "fail"
    assert rows["r1"] == "success" and rows["r3"] == "success"


def test_a_failed_gating_phase_still_fails_the_run(tmp_path, monkeypatch):
    """The non-gating carve-out is ONLY for fan_out branches: an ordinary
    sequential phase that fails must still fail the run."""
    run = _run(tmp_path, monkeypatch)
    run.fan_out([(_params("r1"), lambda ph: "ok")])   # a passing branch
    # A sequential (gating) phase that fails.
    try:
        with run.phase(_params("build")):
            raise RuntimeError("build broke")
    except RuntimeError:
        pass
    assert run.finish(accepted=True) == 1


def test_lifecycle_exception_yields_a_result_not_a_dropped_branch(tmp_path, monkeypatch):
    """An exception in the phase lifecycle (not fn) - e.g. a console/tracer failure -
    must still produce a BranchResult, never a silently missing entry."""
    run = _run(tmp_path, monkeypatch)
    original = run.console.phase_started

    def flaky(phase):
        if phase.params.name == "b1":
            raise RuntimeError("console boom in the lifecycle")
        return original(phase)

    monkeypatch.setattr(run.console, "phase_started", flaky)
    results = run.fan_out([(_params("b0"), lambda ph: "a"),
                           (_params("b1"), lambda ph: "b"),
                           (_params("b2"), lambda ph: "c")])

    assert len(results) == 3                    # nothing dropped
    by_name = {r.phase.params.name: r for r in results}
    assert not by_name["b1"].ok and isinstance(by_name["b1"].error, RuntimeError)
    assert by_name["b0"].ok and by_name["b2"].ok
