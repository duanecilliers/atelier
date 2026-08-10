"""queue.py - the control seam (in-memory sqlite).

claim_next is the control-plane heart: the three-branch sandbox filter, the
atomic claim guard, and oldest-first ordering. fail_orphaned keeps a dead
sandbox from stranding queued work.
"""
from __future__ import annotations

from adw_modules import queue


def enq(conn, adw_id="a", sandbox_id=None, status=queue.QUEUED):
    conn.execute(
        "INSERT INTO run_queue (adw_id, adw_name, request, sandbox_id, status, enqueued_at)"
        " VALUES (?,?,?,?,?,?)",
        (adw_id, "adw_scout", "x", sandbox_id, status, "2026-01-01T00:00:00Z"),
    )
    conn.commit()


class TestClaimNext:
    def test_oldest_first_and_flips_to_claimed(self, conn):
        queue.ensure_schema(conn)
        enq(conn, "first")
        enq(conn, "second")
        row = queue.claim_next(conn)
        assert row["adw_id"] == "first"
        assert conn.execute("SELECT status FROM run_queue WHERE adw_id='first'").fetchone()[0] == "claimed"

    def test_already_claimed_is_skipped(self, conn):
        queue.ensure_schema(conn)
        enq(conn, "one")
        assert queue.claim_next(conn) is not None
        assert queue.claim_next(conn) is None  # nothing queued remains

    def test_none_filter_claims_sandboxed_and_local(self, conn):
        queue.ensure_schema(conn)
        enq(conn, "sbx", sandbox_id="s1")
        assert queue.claim_next(conn, None)["adw_id"] == "sbx"

    def test_empty_runnable_set_claims_only_local(self, conn):
        queue.ensure_schema(conn)
        enq(conn, "sbx", sandbox_id="s1")
        enq(conn, "local", sandbox_id=None)
        row = queue.claim_next(conn, set())
        assert row["adw_id"] == "local"  # the sandboxed row is not eligible
        assert queue.claim_next(conn, set()) is None

    def test_runnable_set_gates_by_sandbox(self, conn):
        queue.ensure_schema(conn)
        enq(conn, "s2run", sandbox_id="s2")
        enq(conn, "s1run", sandbox_id="s1")
        row = queue.claim_next(conn, {"s1"})
        assert row["adw_id"] == "s1run"  # s2 not runnable this poll
        assert queue.claim_next(conn, {"s1"}) is None


class TestFailOrphaned:
    def test_fails_only_dead_sandbox_rows(self, conn):
        queue.ensure_schema(conn)
        enq(conn, "dead", sandbox_id="gone")
        enq(conn, "alive", sandbox_id="ok")
        enq(conn, "local", sandbox_id=None)
        failed = queue.fail_orphaned(conn, {"gone"})
        assert failed == ["dead"]
        statuses = dict(conn.execute("SELECT adw_id, status FROM run_queue").fetchall())
        assert statuses["dead"] == "failed"
        assert statuses["alive"] == "queued"
        assert statuses["local"] == "queued"

    def test_empty_dead_set_is_noop(self, conn):
        queue.ensure_schema(conn)
        enq(conn, "x", sandbox_id="s1")
        assert queue.fail_orphaned(conn, set()) == []


class TestEnsureSchema:
    def test_idempotent(self, conn):
        queue.ensure_schema(conn)
        queue.ensure_schema(conn)  # must not raise
        enq(conn, "x")
        assert queue.claim_next(conn) is not None

    def test_heals_missing_sandbox_id_column(self, conn):
        # a pre-sandbox db: run_queue without sandbox_id
        conn.execute(
            "CREATE TABLE run_queue (id INTEGER PRIMARY KEY AUTOINCREMENT,"
            " adw_id TEXT, status TEXT DEFAULT 'queued')"
        )
        queue.ensure_schema(conn)
        cols = {r[1] for r in conn.execute("PRAGMA table_info(run_queue)")}
        assert "sandbox_id" in cols
