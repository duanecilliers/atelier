"""The Run object: config + adw_id + agent_map + tracer + console, bound once.

`run.phase(PhaseParams(...))` is the ONE phase primitive — a context manager
for all three kinds (engineer, agent, code). Success must be earned: every
phase defaults to fail; only a clean exit flips it (agent phases additionally
require a parsed envelope + green gates, enforced inside ph.call).
"""

from __future__ import annotations

import json
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from . import agents, git_helper
from .console import Console
from .data_types import AgentCall, EnvelopeBase, EventRecord, Phase, PhaseParams
from .utils import ensure_dir, now_iso, resolve_trace_path


@dataclass
class BranchResult:
    """One fan-out branch's outcome. `value` is whatever the branch fn returned
    (e.g. a ReviewOutput envelope); `error` is set instead when the branch raised.
    A branch failure is a RESULT the ADW rules on at finish() - never a
    session_finish that would tear the whole run down mid-fan-out."""

    phase: Phase
    value: Any | None
    error: BaseException | None

    @property
    def ok(self) -> bool:
        return self.error is None


class PhaseHandle:
    def __init__(self, run: "Run", phase: Phase):
        self.run = run
        self.phase = phase

    def log(self, **payload) -> None:
        self.run.tracer.event(EventRecord(adw_id=self.run.adw_id,
                                          phase_id=self.phase.phase_id,
                                          type="log", name=self.phase.params.name,
                                          payload=payload))
        self.run.console.note(", ".join(f"{k}: {v}" for k, v in payload.items()))
        if self.phase.params.kind == "engineer" and "input" in payload:
            self.run.tracer.session_request(self.run.adw_id, str(payload["input"]))

    def call(self, call: AgentCall) -> EnvelopeBase:
        if self.phase.params.kind != "agent":
            raise RuntimeError("ph.call() is only valid inside an agent phase")
        return agents.execute(self.run, self.phase, call)


class Run:
    def __init__(self, cfg, adw_id: str, tracer, engineer: str):
        self.cfg = cfg
        self.adw_id = adw_id
        self.tracer = tracer
        self.console = Console(tracer, adw_id)
        self.engineer = engineer
        self.phases: list[Phase] = []
        self.tokens = 0
        self.cost = 0.0
        self._seq = tracer.max_phase_seq(adw_id)   # a joined run continues the sequence
        # Guards the shared counters + agent_map under fan_out's worker threads, and
        # the seq/phases allocation at the top of fan_out(). Sequential phase() runs
        # only on the main thread and never overlaps fan_out (which blocks on join),
        # so its hot-path _seq bump stays unlocked.
        self._lock = threading.Lock()
        self.repo_root = git_helper.repo_root()    # where every agent is spawned to work
        # The session dir is part of the observability sink, so it anchors at
        # trace_root() (SSSF_TRACE_ROOT or cwd), NOT at repo_root — under a sandbox
        # run repo_root is the worktree but the sink must stay by the shared db.
        self.session_dir = ensure_dir(resolve_trace_path(
            Path(cfg.defaults.data_dir) / "sessions" / adw_id))
        self.context_handoff_dir = ensure_dir(self.session_dir / "context_handoff")
        self._agent_map_path = self.session_dir / "agent_map.json"
        self.agent_map: dict = (json.loads(self._agent_map_path.read_text())
                                if self._agent_map_path.exists() else {})

    # ── agent map (adw_id -> per-agent coding-agent session ids) ────────────
    def save_agent_map(self, agent: str, entry: dict) -> None:
        # Locked: fan-out branches save concurrently, and both the dict mutation
        # and the whole-file rewrite must not interleave (a torn write corrupts it).
        with self._lock:
            self.agent_map[agent] = entry
            self._agent_map_path.write_text(json.dumps(self.agent_map, indent=2))

    # ── usage (run totals mirror what the tracer accumulates in sqlite) ─────
    def add_usage(self, tokens: int, cost: float) -> None:
        # Locked: concurrent fan-out branches would otherwise lose updates to the
        # run totals (read-modify-write on self.tokens/self.cost).
        with self._lock:
            self.tokens += tokens
            self.cost += cost
            self.tracer.session_add_usage(self.adw_id, tokens, cost)

    # ── the phase primitive ─────────────────────────────────────────────────
    @contextmanager
    def phase(self, params: PhaseParams):
        self._seq += 1
        phase = Phase(phase_id=f"{self.adw_id}_{self._seq:02d}_{params.name}",
                      adw_id=self.adw_id, seq=self._seq, params=params,
                      status="running", started_at=now_iso())
        self.phases.append(phase)
        self.tracer.phase_upsert(phase)
        self.tracer.event(EventRecord(adw_id=self.adw_id, phase_id=phase.phase_id,
                                      type="phase_start", name=params.name,
                                      payload={"kind": params.kind, "owner": params.owner,
                                               "description": params.description}))
        self.console.phase_started(phase)
        clock = time.monotonic()
        try:
            yield PhaseHandle(self, phase)
        except BaseException as error:
            phase.status = "fail"                      # success must be earned
            phase.error = str(error)[:1000]
            phase.ended_at = now_iso()
            self.tracer.event(EventRecord(adw_id=self.adw_id, phase_id=phase.phase_id,
                                          type="error", name=params.name,
                                          payload={"error": phase.error}))
            self.tracer.event(EventRecord(adw_id=self.adw_id, phase_id=phase.phase_id,
                                          type="phase_end", name=params.name,
                                          payload={"status": "fail"}))
            self.tracer.phase_upsert(phase)
            self.tracer.session_finish(self.adw_id, ok=False)
            self.console.phase_ended(phase, time.monotonic() - clock)
            self.console.session_finished(False, self.tokens, self.cost,
                                          self.cfg.observability.db)
            raise
        else:
            phase.status = "success"
            phase.ended_at = now_iso()
            self.tracer.event(EventRecord(adw_id=self.adw_id, phase_id=phase.phase_id,
                                          type="phase_end", name=params.name,
                                          payload={"status": "success"}))
            self.tracer.phase_upsert(phase)
            self.console.phase_ended(phase, time.monotonic() - clock)

    # ── the fan-out primitive (concurrent agent phases) ──────────────────────
    def fan_out(self, branches: list[tuple[PhaseParams, Callable[["PhaseHandle"], Any]]]
                ) -> list[BranchResult]:
        """Run agent phases CONCURRENTLY, one OS thread each.

        Threads, not asyncio: agents.execute() -> agent_cc.run() drives the Claude
        SDK via asyncio.run() INSIDE each call, so each branch needs its own event
        loop - an OS thread gives it one. Seqs and self.phases are allocated up
        front under self._lock (ordered, race-free); each branch then opens its own
        phase and runs `fn(PhaseHandle)` in its thread.

        A branch that raises becomes a failed PHASE and a BranchResult with `error`
        set - it does NOT call session_finish and does NOT abort its siblings
        (contrast phase(), which finalizes the whole run on any exception; that
        teardown is wrong mid-fan-out). Branch phases are non-gating, so one
        failing does not itself fail the run - the ADW rules on the results at
        finish(). Always returns EXACTLY one BranchResult per branch, in input
        order: any error, including one in the phase lifecycle (tracer/console),
        is captured rather than dropped.

        PRECONDITION: branches must be read-only with respect to the git repo
        (writes: []), like reviewers and scouts. Two branches whose agents write
        out of bounds would run permissions.enforce's `git checkout` rollbacks
        concurrently and race the shared .git/index.lock. Fan out repo-writing
        agents only if you serialize their write-boundary enforcement yourself.
        """
        with self._lock:
            prepared: list[tuple[Phase, Callable]] = []
            for params, fn in branches:
                self._seq += 1
                phase = Phase(phase_id=f"{self.adw_id}_{self._seq:02d}_{params.name}",
                              adw_id=self.adw_id, seq=self._seq, params=params,
                              status="running", started_at=now_iso(), gating=False)
                self.phases.append(phase)
                prepared.append((phase, fn))

        results: list[BranchResult | None] = [None] * len(prepared)

        def branch(index: int, phase: Phase, fn: Callable) -> None:
            clock = time.monotonic()
            # Outer guard: EVERYTHING (phase lifecycle included) is inside a try, so
            # a tracer/console failure records a BranchResult instead of killing the
            # thread and silently dropping the branch from the returned list.
            try:
                self.tracer.phase_upsert(phase)
                self.tracer.event(EventRecord(
                    adw_id=self.adw_id, phase_id=phase.phase_id, type="phase_start",
                    name=phase.params.name,
                    payload={"kind": phase.params.kind, "owner": phase.params.owner,
                             "description": phase.params.description}))
                with self.console.phase_scope(phase):
                    self.console.phase_started(phase)
                    try:
                        value = fn(PhaseHandle(self, phase))
                        phase.status = "success"
                        phase.ended_at = now_iso()
                        self.tracer.event(EventRecord(
                            adw_id=self.adw_id, phase_id=phase.phase_id, type="phase_end",
                            name=phase.params.name, payload={"status": "success"}))
                        self.tracer.phase_upsert(phase)
                        results[index] = BranchResult(phase, value, None)
                    except BaseException as error:   # a branch failure is a RESULT, not a teardown
                        phase.status = "fail"
                        phase.error = str(error)[:1000]
                        phase.ended_at = now_iso()
                        self.tracer.event(EventRecord(
                            adw_id=self.adw_id, phase_id=phase.phase_id, type="error",
                            name=phase.params.name, payload={"error": phase.error}))
                        self.tracer.event(EventRecord(
                            adw_id=self.adw_id, phase_id=phase.phase_id, type="phase_end",
                            name=phase.params.name, payload={"status": "fail"}))
                        self.tracer.phase_upsert(phase)
                        results[index] = BranchResult(phase, None, error)
                    finally:
                        self.console.phase_ended(phase, time.monotonic() - clock)
            except BaseException as error:
                # A lifecycle failure (or a raising finally). Never leave a hole in
                # the results; keep any inner result if one was already recorded.
                if results[index] is None:
                    phase.status = "fail"
                    phase.error = str(error)[:1000]
                    phase.ended_at = now_iso()
                    results[index] = BranchResult(phase, None, error)

        threads = [threading.Thread(target=branch, args=(i, phase, fn),
                                    name=phase.params.name)
                   for i, (phase, fn) in enumerate(prepared)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        # Every index is set by branch()'s guard; the comprehension narrows the type.
        return [r for r in results if r is not None]

    # ── run outcome ─────────────────────────────────────────────────────────
    def finish(self, accepted: bool = True, reason: str = "") -> int:
        """Finalize the run and return its exit code. Call this exactly once.

        Two criteria, not one. Every phase must have passed, AND the ADW's own
        acceptance test must hold. They are different questions on purpose: a
        test phase that ran the suite did its job even when the suite came back
        red, so the PHASE succeeds while the RUN must not.

        This replaces a `succeeded` property that answered only the first
        question - and, being a property with side effects, wrote the session
        status and printed the banner before the caller's `and test.passed` was
        ever evaluated. A run whose suite never passed was recorded green in the
        db, on the terminal, and in the UI while exiting 1. Anyone reading the
        trace saw success; only a CI job checking `$?` saw the truth. One call
        now settles the db, the banner, and the exit code together, so the three
        cannot disagree.

        Only GATING phases count toward phases_ok. A fan_out branch is non-gating
        (Phase.gating is False): a failed reviewer branch is a real, recorded
        failure but the ADW already rules on it via BranchResult + `accepted`
        (synthesize-from-survivors), so it must not independently fail the run.
        """
        gating = [p for p in self.phases if p.gating]
        phases_ok = bool(self.phases) and all(p.status == "success" for p in gating)
        ok = phases_ok and accepted
        if phases_ok and not accepted:
            note = reason or "the run's acceptance criterion was not met"
            self.tracer.event(EventRecord(
                adw_id=self.adw_id,
                phase_id=self.phases[-1].phase_id if self.phases else "",
                type="error", name="not_accepted", payload={"reason": note}))
            self.console.note(f"not accepted: {note}")
        self.tracer.session_finish(self.adw_id, ok=ok)
        self.console.session_finished(ok, self.tokens, self.cost, self.cfg.observability.db)
        return 0 if ok else 1
