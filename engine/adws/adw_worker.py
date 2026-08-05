#!/usr/bin/env -S uv run
# /// script
# dependencies = ["pydantic", "python-dotenv", "pyyaml", "rich"]
# ///
"""ADW Worker — drains run_queue by launching real ADW subprocesses.

This is the *only* thing that turns a queued row into a running ADW. The cockpit
enqueues rows and flips cancel flags; it never spawns a process. The worker
builds the exact argv a human would type at the CLI —

    uv run engine/adws/<adw_name>.py --config <cfg> --adw-id <id> [--agent <a>] "<request>"

— so a UI-launched run is byte-for-byte identical to a CLI one: same trace, same
acceptance, same process rows. The worker adds nothing to a run except starting
and (on request) stopping it.

Usage:
    uv run engine/adws/adw_worker.py [--config <cfg>] [--concurrency N] [--poll 1.0] [--once]

Run it from the repo (git) root — the same cwd every ADW expects, so config
paths and `writes:` allowlists resolve where agents actually write.
"""

from __future__ import annotations

import argparse
import os
import re
import signal
import subprocess
import sqlite3
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

from adw_modules import agents, queue
from adw_modules.utils import ensure_dir

# The worker file is engine/adws/adw_worker.py; the repo root is two up. Every
# ADW is launched with cwd=REPO_ROOT so its relative paths resolve identically
# to a CLI invocation.
REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = "engine/adws/adw_sssf_config/sssf.config.yaml"

# An adw_name only ever names a script in engine/adws/. Validate hard: the row
# comes from the cockpit, and this string becomes an argv element.
ADW_NAME_RE = re.compile(r"^adw_[a-z0-9_]+$")

# adw_prompt is the only ADW that takes --agent; the rest own their own roster.
AGENT_ARG_ADWS = {"adw_prompt"}

# Grace between SIGTERM (cooperative: the ADW closes its own trace) and SIGKILL.
CANCEL_GRACE_S = 12.0


@dataclass
class Job:
    queue_id: int
    row: sqlite3.Row
    proc: subprocess.Popen
    log: object  # open file handle for the child's stdout/stderr
    canceling: bool = False
    kill_deadline: float | None = field(default=None)


def connect(db_path: str) -> sqlite3.Connection:
    """Autocommit connection matching the tracer's pragmas (WAL, busy_timeout)."""
    conn = sqlite3.connect(db_path, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA busy_timeout=5000;")
    return conn


def build_argv(row: sqlite3.Row, worker_config: str) -> list[str] | None:
    """The CLI argv for a queued row, or None if adw_name is not a valid script."""
    adw_name = (row["adw_name"] or "").strip()
    if not ADW_NAME_RE.match(adw_name):
        return None
    script = REPO_ROOT / "engine" / "adws" / f"{adw_name}.py"
    if not script.is_file():
        return None
    config = row["config"] or worker_config
    argv = ["uv", "run", str(script), "--config", config, "--adw-id", row["adw_id"]]
    if adw_name in AGENT_ARG_ADWS and row["agent"]:
        argv += ["--agent", row["agent"]]
    # `--` ends option parsing, so a request that begins with '-' (e.g. a prompt
    # starting with a dash) is taken as the positional prompt, not a stray flag.
    argv += ["--", row["request"] or ""]
    return argv


def spawn(row: sqlite3.Row, worker_config: str, data_dir: str) -> Job | None:
    """Launch the ADW in its own process group, logging to the run's session dir."""
    argv = build_argv(row, worker_config)
    if argv is None:
        return None
    session_dir = ensure_dir(REPO_ROOT / data_dir / "sessions" / row["adw_id"])
    log = open(session_dir / "worker.log", "a", buffering=1)
    log.write(f"\n$ {' '.join(argv)}\n")
    # start_new_session=True → the child leads its own process group, so a cancel
    # signals the whole ADW + its agent children, not just `uv`.
    proc = subprocess.Popen(
        argv, cwd=str(REPO_ROOT), stdout=log, stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    return Job(queue_id=row["id"], row=row, proc=proc, log=log)


def signal_group(proc: subprocess.Popen, sig: int) -> None:
    """Signal the child's whole process group; ignore an already-dead group."""
    try:
        os.killpg(os.getpgid(proc.pid), sig)
    except (ProcessLookupError, PermissionError):
        pass


def drain(conn: sqlite3.Connection, config: str, concurrency: int, poll: float,
          once: bool) -> None:
    cfg = agents.load_config(config)
    data_dir = cfg.defaults.data_dir
    jobs: dict[int, Job] = {}
    stopping = False

    def request_stop(signum, _frame):
        nonlocal stopping
        if stopping:
            # Second signal — force every live run down and leave.
            for job in jobs.values():
                signal_group(job.proc, signal.SIGKILL)
            print(f"\n[worker] signal {signum} again — force-killed "
                  f"{len(jobs)} run(s), exiting")
            raise SystemExit(130)
        stopping = True
        print(f"\n[worker] signal {signum} — no new claims; "
              f"waiting for {len(jobs)} run(s) to finish (Ctrl-C again to force)")
    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)

    print(f"[worker] draining {conn.execute('PRAGMA database_list').fetchone()['file']} "
          f"· concurrency={concurrency} · poll={poll}s")

    while True:
        now = time.monotonic()

        # 1. Reap finished runs and record their terminal status.
        for qid, job in list(jobs.items()):
            rc = job.proc.poll()
            if rc is None:
                continue
            if job.canceling:
                status, err = queue.CANCELED, None
            elif rc == 0:
                status, err = queue.DONE, None
            else:
                status = queue.FAILED
                err = f"exit {rc}" if rc >= 0 else f"signal {-rc}"
            queue.mark_terminal(conn, qid, status, exit_code=rc, error=err)
            job.log.close()
            print(f"[worker] run {job.row['adw_id']} → {status} (exit {rc})")
            del jobs[qid]

        # 2. Honour cancel requests on live runs; escalate to SIGKILL after grace.
        for job in jobs.values():
            if not job.canceling and queue.cancel_requested(conn, job.queue_id):
                job.canceling = True
                job.kill_deadline = now + CANCEL_GRACE_S
                signal_group(job.proc, signal.SIGTERM)
                print(f"[worker] cancel {job.row['adw_id']} → SIGTERM")
            elif job.canceling and job.kill_deadline and now >= job.kill_deadline:
                job.kill_deadline = None
                signal_group(job.proc, signal.SIGKILL)
                print(f"[worker] cancel {job.row['adw_id']} → SIGKILL (grace elapsed)")

        # 3. Fill free slots with fresh work (unless shutting down).
        if not stopping:
            while len(jobs) < concurrency:
                row = queue.claim_next(conn)
                if row is None:
                    break
                job = spawn(row, config, data_dir)
                if job is None:
                    queue.mark_terminal(conn, row["id"], queue.FAILED,
                                        error=f"unknown adw_name {row['adw_name']!r}")
                    print(f"[worker] rejected queue #{row['id']}: bad adw_name "
                          f"{row['adw_name']!r}")
                    continue
                queue.mark_running(conn, row["id"], job.proc.pid)
                jobs[job.queue_id] = job
                print(f"[worker] run {row['adw_id']} ← {row['adw_name']} "
                      f"(pid {job.proc.pid})")

        # 4. Exit conditions.
        if stopping and not jobs:
            print("[worker] all runs finished — bye")
            return
        # --once: step 3 already tried to fill; an empty slate now means the
        # queue is drained, so leave (don't re-claim, which would strand a row).
        if once and not jobs and not stopping:
            print("[worker] queue drained (--once) — bye")
            return

        time.sleep(poll)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=DEFAULT_CONFIG,
                        help="roster config; also where the db path is read from")
    parser.add_argument("--concurrency", type=int, default=2,
                        help="max runs in flight at once")
    parser.add_argument("--poll", type=float, default=1.0,
                        help="seconds between queue polls")
    parser.add_argument("--once", action="store_true",
                        help="drain the current queue, then exit (no idle loop)")
    args = parser.parse_args()

    if args.concurrency < 1:
        parser.error("--concurrency must be >= 1")

    # Line-buffer stdout so progress streams live even when redirected to a file
    # (nohup/background) — block buffering would hide it until the worker exits.
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except (AttributeError, ValueError):
        pass

    cfg = agents.load_config(args.config)
    conn = connect(cfg.observability.db)
    queue.ensure_schema(conn)
    try:
        drain(conn, args.config, args.concurrency, args.poll, args.once)
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
