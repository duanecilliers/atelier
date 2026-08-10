"""sandboxes.py - the persistent-workspace control seam (in-memory sqlite).

The correctness traps: set_status must never clobber worktree_path on a plain
status flip, and the land lifecycle (claim_land -> finish_land) must return to
active without destroying anything and must not wipe a prior land_result.
"""
from __future__ import annotations

from adw_modules import sandboxes as sb


def make(conn, sid="s1", status=sb.ACTIVE, **cols):
    row = {"id": sid, "project_root": "/repo", "level": "worktree_env",
           "status": status, "created_at": "2026-01-01T00:00:00Z"}
    row.update(cols)
    keys = ", ".join(row)
    conn.execute(f"INSERT INTO sandboxes ({keys}) VALUES ({', '.join('?' * len(row))})",
                 tuple(row.values()))
    conn.commit()


class TestSetStatusPartialWrite:
    def test_status_flip_preserves_worktree_path(self, conn):
        sb.ensure_schema(conn)
        make(conn)
        sb.set_status(conn, "s1", sb.ACTIVE, worktree_path="/wt/s1")
        # a later plain status flip must NOT null the worktree_path
        sb.set_status(conn, "s1", sb.LANDING)
        assert sb.get(conn, "s1")["worktree_path"] == "/wt/s1"
        assert sb.get(conn, "s1")["status"] == sb.LANDING

    def test_error_only_written_when_given(self, conn):
        sb.ensure_schema(conn)
        make(conn)
        sb.set_status(conn, "s1", sb.FAILED, error="boom")
        assert sb.get(conn, "s1")["error"] == "boom"


class TestLandLifecycle:
    def test_claim_land_flips_to_landing_and_clears_flag(self, conn):
        sb.ensure_schema(conn)
        make(conn, status=sb.ACTIVE, land_requested=1)
        sb.claim_land(conn, "s1")
        row = sb.get(conn, "s1")
        assert row["status"] == sb.LANDING
        assert row["land_requested"] == 0

    def test_finish_land_returns_to_active_and_records_result(self, conn):
        sb.ensure_schema(conn)
        make(conn, status=sb.LANDING)
        sb.finish_land(conn, "s1", land_result="pr: http://x/1")
        row = sb.get(conn, "s1")
        assert row["status"] == sb.ACTIVE
        assert row["land_result"] == "pr: http://x/1"
        assert row["error"] is None

    def test_failed_reland_does_not_wipe_prior_result(self, conn):
        sb.ensure_schema(conn)
        make(conn, status=sb.LANDING)
        sb.finish_land(conn, "s1", land_result="pr: http://x/1")
        sb.claim_land(conn, "s1")  # a second land attempt
        sb.finish_land(conn, "s1", error="hook failed")  # no land_result this time
        row = sb.get(conn, "s1")
        assert row["land_result"] == "pr: http://x/1"  # preserved
        assert row["error"] == "hook failed"


class TestFilters:
    def test_land_pending_is_active_and_flagged_only(self, conn):
        sb.ensure_schema(conn)
        make(conn, sid="a", status=sb.ACTIVE, land_requested=1)
        make(conn, sid="b", status=sb.ACTIVE, land_requested=0)
        make(conn, sid="c", status=sb.PROVISIONING, land_requested=1)  # not active
        ids = [r["id"] for r in sb.land_pending(conn)]
        assert ids == ["a"]

    def test_active_and_dead_ids(self, conn):
        sb.ensure_schema(conn)
        make(conn, sid="a", status=sb.ACTIVE)
        make(conn, sid="g", status=sb.GONE)
        make(conn, sid="f", status=sb.FAILED)
        assert sb.active_ids(conn) == {"a"}
        assert sb.dead_ids(conn) == {"g", "f"}

    def test_ensure_schema_idempotent(self, conn):
        sb.ensure_schema(conn)
        sb.ensure_schema(conn)
        make(conn)
        assert sb.get(conn, "s1") is not None
