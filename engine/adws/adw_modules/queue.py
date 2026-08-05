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
_CLAIM_COLS = "id, adw_id, adw_name, agent, request, config, requested_by"


def ensure_schema(conn: sqlite3.Connection) -> None:
    """Create run_queue if absent. Safe to call on every worker startup."""
    conn.executescript(RUN_QUEUE_DDL)


def claim_next(conn: sqlite3.Connection) -> sqlite3.Row | None:
    """Atomically take the oldest queued row, flipping it to 'claimed'.

    A single worker process drains serially in its loop, so there is no race
    within one worker; the `AND status='queued'` guard on the UPDATE is cheap
    insurance against a second `just worker` racing for the same row — if the
    UPDATE changes nothing, someone else won it, so we report nothing claimed.
    """
    row = conn.execute(
        f"SELECT {_CLAIM_COLS} FROM run_queue WHERE status=? ORDER BY id LIMIT 1",
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


def cancel_requested(conn: sqlite3.Connection, queue_id: int) -> bool:
    """True once the cockpit has asked to stop this run."""
    row = conn.execute(
        "SELECT cancel_requested FROM run_queue WHERE id=?", (queue_id,)
    ).fetchone()
    return bool(row and row["cancel_requested"])
