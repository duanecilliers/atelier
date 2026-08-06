"""run_queue — the control seam. The cockpit enqueues; the worker drains.

The determinism spine: a web process must never spawn an agent subprocess
itself. So the cockpit only ever INSERTs a row here and, to stop a run, flips
`cancel_requested`. `adw_worker.py` is the *only* thing that turns a queued row
into a real ADW subprocess, and it launches the exact argv a human would type
at the CLI — so a UI-launched run is byte-for-byte identical to a CLI one, with
the same trace and the same acceptance.

The DDL lives here (RUN_QUEUE_DDL) and is folded into the tracer's SCHEMA, so
every engine run creates the table; the worker also ensures it on startup, and
the cockpit's write connection mirrors the same DDL (drift is caught by the
cockpit's check:contract).
"""

from __future__ import annotations

import sqlite3

from .utils import now_iso

RUN_QUEUE_DDL = """
CREATE TABLE IF NOT EXISTS run_queue (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  adw_id        TEXT,                -- minted at enqueue so the cockpit can deep-link before the run starts
  adw_name      TEXT,                -- the ADW script to run, e.g. 'adw_scout'
  agent         TEXT,                -- adw_prompt's --agent; NULL for multi-agent ADWs
  request       TEXT,                -- the prompt / ask
  config        TEXT,                -- roster config path; NULL = the worker's default
  sandbox_id    TEXT,                -- the sandbox to run in (sandboxes.id); NULL = a local run at REPO_ROOT
  status        TEXT DEFAULT 'queued', -- queued -> claimed -> running -> done | failed | canceled
  requested_by  TEXT,                -- operator who enqueued it
  cancel_requested INTEGER DEFAULT 0, -- cooperative cancel flag the worker polls
  pid           INTEGER,             -- the worker-spawned adw pid (also tracked in processes)
  exit_code     INTEGER,
  error         TEXT,
  enqueued_at   TEXT,
  claimed_at    TEXT,
  started_at    TEXT,
  ended_at      TEXT
);
"""

# Lifecycle. queued -> claimed -> running are set by the worker as it drains;
# done/failed/canceled are terminal. A row is 'claimed' only for the instant
# between winning it and Popen succeeding, so a crash there is visible.
QUEUED = "queued"
CLAIMED = "claimed"
RUNNING = "running"
DONE = "done"
FAILED = "failed"
CANCELED = "canceled"
TERMINAL = frozenset({DONE, FAILED, CANCELED})

# Columns the worker selects when it claims a row — the launch spec.
_CLAIM_COLS = "id, adw_id, adw_name, agent, request, config, sandbox_id, requested_by"


def ensure_schema(conn: sqlite3.Connection) -> None:
    """Create run_queue if absent, and self-heal the additive sandbox_id column.

    CREATE TABLE IF NOT EXISTS never revisits an existing table, so a db created
    before sandbox_id needs an explicit ALTER — the same additive-migration
    discipline the tracer uses. Done here so a worker (which claims on sandbox_id)
    is correct even on an old db no new-schema ADW has migrated yet."""
    conn.executescript(RUN_QUEUE_DDL)
    columns = {row[1] for row in conn.execute("PRAGMA table_info(run_queue)")}
    if "sandbox_id" not in columns:
        conn.execute("ALTER TABLE run_queue ADD COLUMN sandbox_id TEXT")


def claim_next(conn: sqlite3.Connection,
               runnable_sandbox_ids: set[str] | None = None) -> sqlite3.Row | None:
    """Atomically take the oldest claimable queued row, flipping it to 'claimed'.

    A single worker process drains serially in its loop, so there is no race
    within one worker; the `AND status='queued'` guard on the UPDATE is cheap
    insurance against a second `just worker` racing for the same row — if the
    UPDATE changes nothing, someone else won it, so we report nothing claimed.

    Sandbox serialization: a run bound to a sandbox is claimable only while that
    sandbox is runnable (active AND not already hosting a run). The worker passes
    the runnable set each poll; a row targeting a busy/not-yet-provisioned sandbox
    simply stays queued and is picked up on a later poll — follow-up work queues
    behind the run ahead of it. A NULL sandbox_id (a local run) is always
    claimable. `None` = no sandbox filtering (legacy behaviour, all rows eligible).
    """
    if runnable_sandbox_ids is None:
        row = conn.execute(
            f"SELECT {_CLAIM_COLS} FROM run_queue WHERE status=? ORDER BY id LIMIT 1",
            (QUEUED,),
        ).fetchone()
    elif runnable_sandbox_ids:
        placeholders = ",".join("?" * len(runnable_sandbox_ids))
        row = conn.execute(
            f"SELECT {_CLAIM_COLS} FROM run_queue WHERE status=?"
            f" AND (sandbox_id IS NULL OR sandbox_id IN ({placeholders}))"
            " ORDER BY id LIMIT 1",
            (QUEUED, *runnable_sandbox_ids),
        ).fetchone()
    else:
        # No runnable sandbox this poll — only local (NULL sandbox_id) runs eligible.
        row = conn.execute(
            f"SELECT {_CLAIM_COLS} FROM run_queue WHERE status=? AND sandbox_id IS NULL"
            " ORDER BY id LIMIT 1",
            (QUEUED,),
        ).fetchone()
    if row is None:
        return None
    cur = conn.execute(
        "UPDATE run_queue SET status=?, claimed_at=? WHERE id=? AND status=?",
        (CLAIMED, now_iso(), row["id"], QUEUED),
    )
    return row if cur.rowcount == 1 else None


def mark_running(conn: sqlite3.Connection, queue_id: int, pid: int) -> None:
    conn.execute(
        "UPDATE run_queue SET status=?, pid=?, started_at=? WHERE id=?",
        (RUNNING, pid, now_iso(), queue_id),
    )


def mark_terminal(
    conn: sqlite3.Connection,
    queue_id: int,
    status: str,
    *,
    exit_code: int | None = None,
    error: str | None = None,
) -> None:
    """Close a row out. status must be one of DONE / FAILED / CANCELED."""
    conn.execute(
        "UPDATE run_queue SET status=?, exit_code=?, error=?, ended_at=? WHERE id=?",
        (status, exit_code, error, now_iso(), queue_id),
    )


def fail_orphaned(conn: sqlite3.Connection, dead_sandbox_ids: set[str]) -> list[str]:
    """Fail every queued run bound to a sandbox that can never host it (gone or
    failed), so a dead sandbox doesn't strand its follow-up work in `queued`
    forever. Returns the adw_ids failed, for the worker to log."""
    if not dead_sandbox_ids:
        return []
    placeholders = ",".join("?" * len(dead_sandbox_ids))
    rows = conn.execute(
        f"SELECT id, adw_id FROM run_queue WHERE status=? AND sandbox_id IN ({placeholders})",
        (QUEUED, *dead_sandbox_ids),
    ).fetchall()
    for row in rows:
        mark_terminal(conn, row["id"], FAILED, error="sandbox is gone or failed")
    return [row["adw_id"] for row in rows]


def cancel_requested(conn: sqlite3.Connection, queue_id: int) -> bool:
    """True once the cockpit has asked to stop this run."""
    row = conn.execute(
        "SELECT cancel_requested FROM run_queue WHERE id=?", (queue_id,)
    ).fetchone()
    return bool(row and row["cancel_requested"])
