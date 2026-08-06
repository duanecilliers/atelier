"""sandboxes — the persistent-workspace control seam. The cockpit requests; the
worker provisions and disposes.

A **sandbox** is an isolated, persistent workspace — a git worktree on a named
branch — that hosts one or more ADW runs and stays alive until explicitly shut
down. It outlives any single run: real feature work is iterative (run, inspect,
run again in the same tree). Parallelism is ACROSS sandboxes; runs in the *same*
sandbox serialize (two runs in one tree would re-introduce the write collision
we isolate away).

Same determinism spine as run_queue (queue.py): the cockpit only ever INSERTs a
row here (status `requested`) or flips a column (`shutdown_requested`). The
WORKER (adw_worker.py) is the only thing that turns intent into a real worktree —
it provisions (`git worktree add`), spawns runs with cwd=<worktree>, and disposes
(`git worktree remove`). The cockpit never spawns a process and never touches a
run's trace.

The DDL lives here (SANDBOXES_DDL) and is folded into the tracer's SCHEMA — like
RUN_QUEUE_DDL / WORKERS_DDL — so a fresh db has the table from the first ADW run;
the worker also ensures it on startup. The cockpit's write connection mirrors the
same DDL and `pnpm check:contract` guards the columns against drift.
"""

from __future__ import annotations

import sqlite3

from .utils import now_iso

SANDBOXES_DDL = """
CREATE TABLE IF NOT EXISTS sandboxes (
  id                 TEXT PRIMARY KEY,    -- minted at request so the cockpit can deep-link before provisioning
  project_root       TEXT,                -- the repo this sandbox belongs to (display; the worker keys off its own REPO_ROOT)
  level              TEXT,                -- local | worktree | worktree_env | … (bounded vocab; roster-constants.ts)
  worktree_path      TEXT,                -- filled by the worker at provision; NULL until active
  branch             TEXT,                -- the named branch the worktree checks out
  ports              TEXT,                -- JSON name->port (slice 2); NULL until then
  status             TEXT DEFAULT 'requested', -- requested -> provisioning -> active -> shutting_down -> gone | failed
  tip_sha            TEXT,                -- HEAD of the worktree, refreshed after each run
  shutdown_requested INTEGER DEFAULT 0,   -- cooperative teardown flag the worker polls
  error              TEXT,                -- provisioning/teardown failure detail
  created_at         TEXT
);
"""

# Lifecycle. requested -> provisioning are set by the worker as it claims a new
# sandbox; active is the steady state that hosts runs; shutting_down -> gone on
# teardown; failed is terminal-bad (provisioning blew up). A run may target a
# sandbox only while it is `active`.
REQUESTED = "requested"
PROVISIONING = "provisioning"
ACTIVE = "active"
LANDING = "landing"            # slice 4
SHUTTING_DOWN = "shutting_down"
GONE = "gone"
FAILED = "failed"
# A run can never proceed against a sandbox in one of these — used to fail
# orphaned queued runs instead of letting them wait forever.
DEAD = frozenset({GONE, FAILED})

_COLS = ("id, project_root, level, worktree_path, branch, ports, status,"
         " tip_sha, shutdown_requested, error, created_at")


def ensure_schema(conn: sqlite3.Connection) -> None:
    """Create the sandboxes table if absent. Safe on every worker startup."""
    conn.executescript(SANDBOXES_DDL)


def with_status(conn: sqlite3.Connection, status: str) -> list[sqlite3.Row]:
    """Every sandbox currently in `status`, oldest first (creation order)."""
    return conn.execute(
        f"SELECT {_COLS} FROM sandboxes WHERE status=? ORDER BY created_at, rowid",
        (status,),
    ).fetchall()


def shutdown_pending(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    """Sandboxes asked to shut down that aren't already gone — teardown targets."""
    return conn.execute(
        f"SELECT {_COLS} FROM sandboxes WHERE shutdown_requested=1 AND status NOT IN (?, ?)"
        " ORDER BY created_at, rowid",
        (GONE, SHUTTING_DOWN),
    ).fetchall()


def active_ids(conn: sqlite3.Connection) -> set[str]:
    """Ids of sandboxes ready to host a run (a run may target only an active one)."""
    rows = conn.execute("SELECT id FROM sandboxes WHERE status=?", (ACTIVE,)).fetchall()
    return {r["id"] for r in rows}


def dead_ids(conn: sqlite3.Connection) -> set[str]:
    """Ids of sandboxes a run can never run in (gone/failed) — orphan detection."""
    placeholders = ",".join("?" * len(DEAD))
    rows = conn.execute(
        f"SELECT id FROM sandboxes WHERE status IN ({placeholders})", tuple(DEAD)
    ).fetchall()
    return {r["id"] for r in rows}


def get(conn: sqlite3.Connection, sandbox_id: str) -> sqlite3.Row | None:
    return conn.execute(
        f"SELECT {_COLS} FROM sandboxes WHERE id=?", (sandbox_id,)
    ).fetchone()


def set_status(conn: sqlite3.Connection, sandbox_id: str, status: str, *,
               worktree_path: str | None = None, error: str | None = None) -> None:
    """Advance a sandbox's status, optionally recording where it lives or why it
    failed. Only the columns passed are written, so a status flip never clobbers
    a worktree_path set at provision time."""
    sets = ["status=?"]
    params: list[object] = [status]
    if worktree_path is not None:
        sets.append("worktree_path=?")
        params.append(worktree_path)
    if error is not None:
        sets.append("error=?")
        params.append(error)
    params.append(sandbox_id)
    conn.execute(f"UPDATE sandboxes SET {', '.join(sets)} WHERE id=?", params)


def set_tip_sha(conn: sqlite3.Connection, sandbox_id: str, tip_sha: str) -> None:
    """Record the worktree's HEAD — refreshed after each run so the cockpit can
    show (and, in slice 4, land) exactly what the sandbox holds."""
    conn.execute("UPDATE sandboxes SET tip_sha=? WHERE id=?", (tip_sha, sandbox_id))
