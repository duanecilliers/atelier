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
  branch             TEXT,                -- the named branch the worktree checks out; NULL when the worker names it from `purpose` at provision
  purpose            TEXT,                -- optional human intent; the worker turns it into a readable branch (branch_namer.py) when `branch` is NULL
  ports              TEXT,                -- JSON name->port (slice 2); NULL until then
  status             TEXT DEFAULT 'requested', -- requested -> provisioning -> active -> shutting_down -> gone | failed
  tip_sha            TEXT,                -- HEAD of the worktree, refreshed after each run
  shutdown_requested INTEGER DEFAULT 0,   -- cooperative teardown flag the worker polls
  land_requested     INTEGER DEFAULT 0,   -- cooperative land flag the worker polls (slice 4)
  land_result        TEXT,                -- captured land-hook output (PR URL / merge summary) for display
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
LANDING = "landing"            # slice 4 — transient in-flight window; returns to active
SHUTTING_DOWN = "shutting_down"
GONE = "gone"
FAILED = "failed"
# A run can never proceed against a sandbox in one of these — used to fail
# orphaned queued runs instead of letting them wait forever.
DEAD = frozenset({GONE, FAILED})

_COLS = ("id, project_root, level, worktree_path, branch, purpose, ports, status,"
         " tip_sha, shutdown_requested, land_requested, land_result, error, created_at")


def ensure_schema(conn: sqlite3.Connection) -> None:
    """Create the sandboxes table if absent, and self-heal the additive columns
    added after it shipped — the slice-4 land_* flags and `purpose`. The base table
    predates them, so CREATE IF NOT EXISTS won't add them to an existing db — an
    explicit ALTER does, the same additive-migration discipline queue.py and the
    tracer use. Done here so the worker (which polls land_requested, writes
    land_result, and reads purpose to name a branch) is correct even on an older db."""
    conn.executescript(SANDBOXES_DDL)
    columns = {row[1] for row in conn.execute("PRAGMA table_info(sandboxes)")}
    if "land_requested" not in columns:
        conn.execute("ALTER TABLE sandboxes ADD COLUMN land_requested INTEGER DEFAULT 0")
    if "land_result" not in columns:
        conn.execute("ALTER TABLE sandboxes ADD COLUMN land_result TEXT")
    if "purpose" not in columns:
        conn.execute("ALTER TABLE sandboxes ADD COLUMN purpose TEXT")


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


def land_pending(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    """Active sandboxes asked to land (slice 4). Only an `active` sandbox can land —
    a run may only target an active tree, and the worktree must exist for the hook —
    so a land flag set on any other status is inert until (if ever) it goes active."""
    return conn.execute(
        f"SELECT {_COLS} FROM sandboxes WHERE land_requested=1 AND status=?"
        " ORDER BY created_at, rowid",
        (ACTIVE,),
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


def set_branch(conn: sqlite3.Connection, sandbox_id: str, branch: str) -> None:
    """Record the branch the worktree checks out. Written at provision — the row's
    `branch` is NULL when the worker names it from `purpose` (branch_namer), so this
    persists the resolved name for the cockpit and for later reads (_row_ctx,
    sandbox_run_env) that re-query the row."""
    conn.execute("UPDATE sandboxes SET branch=? WHERE id=?", (branch, sandbox_id))


def set_ports(conn: sqlite3.Connection, sandbox_id: str, ports_json: str) -> None:
    """Record the allocated ports (JSON name->port) chosen at provision time, so
    every run in the sandbox reads the same block the services bound to."""
    conn.execute("UPDATE sandboxes SET ports=? WHERE id=?", (ports_json, sandbox_id))


def set_tip_sha(conn: sqlite3.Connection, sandbox_id: str, tip_sha: str) -> None:
    """Record the worktree's HEAD — refreshed after each run so the cockpit can
    show (and, in slice 4, land) exactly what the sandbox holds."""
    conn.execute("UPDATE sandboxes SET tip_sha=? WHERE id=?", (tip_sha, sandbox_id))


def claim_land(conn: sqlite3.Connection, sandbox_id: str) -> None:
    """Claim a land request (slice 4): flip `active` -> `landing` and clear the
    flag in one write. Clearing at claim time means a retry needs a fresh request,
    and a worker that dies mid-land is reaped back to `active` (not re-run) — the
    same claim-then-clear discipline as provisioning a `requested` sandbox."""
    conn.execute(
        "UPDATE sandboxes SET status=?, land_requested=0 WHERE id=?",
        (LANDING, sandbox_id),
    )


def finish_land(conn: sqlite3.Connection, sandbox_id: str, *,
                land_result: str | None = None, error: str | None = None) -> None:
    """Return a sandbox to `active` after a land attempt — landing NEVER destroys a
    sandbox. `error` is always written (so a clean land clears a prior failure);
    `land_result` only when given, so a later failed re-land can't wipe the PR URL
    a prior success recorded."""
    sets = ["status=?"]
    params: list[object] = [ACTIVE]
    if land_result is not None:
        sets.append("land_result=?")
        params.append(land_result)
    sets.append("error=?")
    params.append(error)
    params.append(sandbox_id)
    conn.execute(f"UPDATE sandboxes SET {', '.join(sets)} WHERE id=?", params)
