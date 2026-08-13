"""console.py - the current-phase context is thread-local.

Every _emit() log event attaches to the emitting thread's phase. Under fan-out
two branches are inside a phase_scope at once; a barrier forces that overlap, so
a regression to a single shared attribute (last writer wins) would misattribute
one branch's line and fail here.
"""
from __future__ import annotations

import json
import threading

from adw_modules.console import Console
from adw_modules.data_types import Phase, PhaseParams
from adw_modules.tracer import Tracer


def _phase(seq: int, name: str) -> Phase:
    return Phase(phase_id=f"adw00001_{seq:02d}_{name}", adw_id="adw00001", seq=seq,
                 params=PhaseParams(name=name, kind="agent", owner=name,
                                    description=f"work the {name} lane"),
                 status="running")


def test_phase_context_is_thread_local(tmp_path):
    tracer = Tracer(tmp_path / "sssf.db", tmp_path / "events.jsonl")
    tracer.session_start("adw00001", "tester")
    console = Console(tracer, "adw00001")

    ready = threading.Barrier(2)

    def worker(seq: int, name: str) -> None:
        with console.phase_scope(_phase(seq, name)):
            ready.wait()                    # both threads now inside a scope at once
            console.note(f"marker-{name}")

    threads = [threading.Thread(target=worker, args=(1, "alpha")),
               threading.Thread(target=worker, args=(2, "beta"))]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    marked = {}
    for payload, phase_id in tracer.conn.execute(
            "SELECT payload_json, phase_id FROM events WHERE type='log'"):
        message = json.loads(payload).get("message", "")
        for name in ("alpha", "beta"):
            if f"marker-{name}" in message:
                marked[name] = phase_id
    assert marked == {"alpha": "adw00001_01_alpha", "beta": "adw00001_02_beta"}
    tracer.conn.close()


def test_sequential_phase_context_still_works_on_the_main_thread(tmp_path):
    tracer = Tracer(tmp_path / "sssf.db", tmp_path / "events.jsonl")
    tracer.session_start("adw00001", "tester")
    console = Console(tracer, "adw00001")

    with console.phase_scope(_phase(1, "solo")):
        console.note("hello")
    # Scope exited: a later emit has no phase (falls back to "console").
    console.note("after")

    rows = {json.loads(p).get("message", ""): pid for p, pid in tracer.conn.execute(
        "SELECT payload_json, phase_id FROM events WHERE type='log'")}
    inside = next(pid for msg, pid in rows.items() if "hello" in msg)
    after = next(pid for msg, pid in rows.items() if "after" in msg)
    assert inside == "adw00001_01_solo"
    assert after == ""
    tracer.conn.close()
