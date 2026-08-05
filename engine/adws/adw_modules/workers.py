"""workers — the per-project liveness heartbeat.

Each ADW worker (adw_worker.py) upserts a row here every poll into its OWN
repo's sssf.db, so the heartbeat stays per-project — keeping "the db is the
seam" true for each project. The cockpit reads the freshest last_seen_at to
answer, honestly, whether a worker is attached to this project or not ("no
worker attached" is a real state, not a guess).

Engine-owned: the worker writes it, the cockpit only reads it — analogous to the
`processes` table. The DDL lives here and is folded into the tracer's SCHEMA (like
RUN_QUEUE_DDL from queue.py), so a fresh db has the table from the first ADW run;
the worker also ensures it on startup, so a worker on a never-run db still has it.
"""

from __future__ import annotations

import os
import socket
import sqlite3

from .utils import now_iso

WORKERS_DDL = """
CREATE TABLE IF NOT EXISTS workers (
  host          TEXT,                -- machine the worker runs on
  pid           INTEGER,             -- the worker process id (os.getpid)
  started_at    TEXT,                -- when this worker process began draining
  last_seen_at  TEXT,                -- refreshed every poll; freshness = attached
  PRIMARY KEY (host, pid)
);
"""


def ensure_schema(conn: sqlite3.Connection) -> None:
    """Create the workers table if absent. Safe on every worker startup."""
    conn.executescript(WORKERS_DDL)


def identity() -> tuple[str, int]:
    """(host, pid) — the composite key for this worker process's heartbeat row."""
    return socket.gethostname(), os.getpid()


def heartbeat(conn: sqlite3.Connection, host: str, pid: int, started_at: str) -> None:
    """Upsert this worker's row, refreshing last_seen_at to now.

    Called every poll. started_at is fixed for the process's life; last_seen_at
    is what the cockpit measures freshness against.
    """
    conn.execute(
        "INSERT INTO workers (host, pid, started_at, last_seen_at) VALUES (?,?,?,?)"
        " ON CONFLICT(host, pid) DO UPDATE SET last_seen_at=excluded.last_seen_at",
        (host, pid, started_at, now_iso()),
    )


def clear(conn: sqlite3.Connection, host: str, pid: int) -> None:
    """Drop this worker's row on a graceful exit, so the cockpit shows 'no worker'
    at once rather than waiting for the heartbeat to age out. A crash leaves the
    row behind, which is correct — it goes stale on its own."""
    conn.execute("DELETE FROM workers WHERE host=? AND pid=?", (host, pid))


def clear_host(conn: sqlite3.Connection, host: str) -> None:
    """Drop every row for this host at startup. One worker drains a project at a
    time, so any row already here is a crashed predecessor's — sweeping it keeps
    the table to a single live row instead of accumulating one dead row per crash
    (and avoids a reused pid inheriting a stale started_at)."""
    conn.execute("DELETE FROM workers WHERE host=?", (host,))
