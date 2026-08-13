"""tracer.py - the seam source of truth (tmp sqlite db).

_migrate must be idempotent on a fresh db and must heal an older one; session
adw_name chaining and max_phase_seq carry a joined run's state in SQL. The one
connection is also shared across fan-out worker threads, so writes must serialize
without raising.
"""
from __future__ import annotations

import sqlite3
import threading

from adw_modules.data_types import EventRecord
from adw_modules.tracer import MIGRATIONS, Tracer


def _tracer(tmp_path) -> Tracer:
    return Tracer(tmp_path / "sssf.db", tmp_path / "events.jsonl")


def test_fresh_db_has_all_migrated_columns(tmp_path):
    t = _tracer(tmp_path)
    for table, column, _decl in MIGRATIONS:
        cols = {r[1] for r in t.conn.execute(f"PRAGMA table_info({table})")}
        assert column in cols, f"{table}.{column} missing on a fresh db"
    t.conn.close()


def test_reopen_is_idempotent(tmp_path):
    _tracer(tmp_path).conn.close()
    _tracer(tmp_path).conn.close()  # second open must not raise


def test_heals_an_old_db(tmp_path):
    # A pre-land sandboxes table, missing the slice-4 columns.
    c = sqlite3.connect(tmp_path / "sssf.db")
    c.execute("CREATE TABLE sandboxes (id TEXT PRIMARY KEY, status TEXT)")
    c.commit()
    c.close()
    t = _tracer(tmp_path)
    cols = {r[1] for r in t.conn.execute("PRAGMA table_info(sandboxes)")}
    assert {"land_requested", "land_result", "purpose"} <= cols
    t.conn.close()


def test_session_start_chains_and_dedupes_adw_names(tmp_path):
    t = _tracer(tmp_path)
    t.session_start("a", "eng", "adw_plan")
    t.session_start("a", "eng", "adw_build")
    t.session_start("a", "eng", "adw_plan")  # already present -> no dup
    name = t.conn.execute("SELECT adw_name FROM sessions WHERE adw_id='a'").fetchone()[0]
    assert name == "adw_plan + adw_build"
    t.conn.close()


def test_max_phase_seq_continues_a_joined_run(tmp_path):
    t = _tracer(tmp_path)
    assert t.max_phase_seq("a") == 0
    for seq in (1, 2, 3):
        t.conn.execute(
            "INSERT INTO phases (phase_id, adw_id, seq, name, kind, owner, description, status)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (f"p{seq}", "a", seq, "n", "code", "git", "d", "success"),
        )
    assert t.max_phase_seq("a") == 3
    t.conn.close()


def test_concurrent_writers_serialize_and_all_land(tmp_path):
    """Fan-out drives one Tracer from many threads. With check_same_thread=False +
    the write lock, cross-thread writes must neither raise ProgrammingError nor
    lose rows."""
    t = _tracer(tmp_path)
    t.session_start("adw00001", "tester")
    n_threads, per_thread = 8, 25
    errors: list[Exception] = []

    def writer(k: int) -> None:
        try:
            for i in range(per_thread):
                t.event(EventRecord(adw_id="adw00001", phase_id=f"p{k}",
                                    type="log", name="x", payload={"k": k, "i": i}))
        except Exception as exc:            # a ProgrammingError would land here
            errors.append(exc)

    threads = [threading.Thread(target=writer, args=(k,)) for k in range(n_threads)]
    for th in threads:
        th.start()
    for th in threads:
        th.join()

    assert not errors, errors
    (count,) = t.conn.execute("SELECT COUNT(*) FROM events WHERE type='log'").fetchone()
    assert count == n_threads * per_thread
    t.conn.close()
