#!/usr/bin/env -S uv run
# /// script
# dependencies = ["pydantic", "python-dotenv", "pyyaml", "rich"]
# ///
"""ADW Worker — drains run_queue by launching real ADW subprocesses.

This is the *only* thing that turns a queued row into a running ADW. The cockpit
enqueues rows and flips cancel flags; it never spawns a process. The worker
builds the exact argv a human would type at the CLI —

    uv run <adws>/<adw_name>.py --config <cfg> --adw-id <id> [--agent <a>] "<request>"

— so a UI-launched run is byte-for-byte identical to a CLI one: same trace, same
acceptance, same process rows. The worker adds nothing to a run except starting
and (on request) stopping it. `<adws>` is this worker's own directory —
engine/adws/ when Atelier self-hosts, adws/ in a stamped repo.

Usage:
    uv run <adws>/adw_worker.py [--config <cfg>] [--concurrency N] [--poll 1.0] [--once]

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

from adw_modules import agents, git_helper, queue, registry, workers
from adw_modules.utils import ensure_dir, now_iso

# The repo (git) root every ADW is launched in, so its relative config paths and
# `writes:` allowlists resolve identically to a CLI invocation. Resolved from cwd
# via `git rev-parse`, NEVER from Path(__file__): when `adws/` is a symlink into a
# shared dir (a git worktree sharing one engine), __file__ resolves through the
# symlink to the TARGET and its parent is the wrong repo — but cwd is the worktree
# the worker was launched in, which is the root its runs must commit to.
REPO_ROOT = git_helper.repo_root()

# Candidate roster locations, repo-root-relative, most-specific first: a stamped
# repo keeps its engine at adws/, Atelier self-hosts at engine/adws/. The default
# is the first that exists — layout-agnostic and, being cwd-relative (not
# __file__), correct inside a symlinked worktree. Only a fallback: a queued row
# usually carries its own config.
CONFIG_CANDIDATES = (
    "adws/adw_sssf_config/sssf.config.yaml",
    "engine/adws/adw_sssf_config/sssf.config.yaml",
)


def default_config() -> str:
    for candidate in CONFIG_CANDIDATES:
        if (REPO_ROOT / candidate).is_file():
            return candidate
    return CONFIG_CANDIDATES[0]


DEFAULT_CONFIG = default_config()


def default_registry() -> str:
    """Where --supervise looks for atelier.projects.json. The cockpit owns the
    file at cockpit/atelier.projects.json; $ATELIER_PROJECTS overrides it.

    A relative override is anchored at cockpit/ — the cockpit resolves
    ATELIER_PROJECTS against its own cwd (which is cockpit/), so anchoring ours
    there too keeps both halves reading the one same file."""
    cockpit = REPO_ROOT / "cockpit"
    env = os.environ.get("ATELIER_PROJECTS")
    if env:
        p = Path(env)
        return str(p if p.is_absolute() else cockpit / p)
    return str(cockpit / "atelier.projects.json")


def script_for(adw_name: str, config: str) -> Path | None:
    """Locate an ADW script from the config path, or None if it isn't a file.

    The scripts live beside the roster's own directory —
    `<adws>/adw_sssf_config/<file>` — so `<adws>` is the config's grandparent and
    every adw_*.py is a sibling of the roster dir. Derived from the config (a
    relative path resolves against the repo root, cwd for the run), never from
    __file__: a symlinked `adws/` then stays in the worktree's namespace instead
    of jumping to the symlink target.
    """
    cfg_path = Path(config)
    if not cfg_path.is_absolute():
        cfg_path = REPO_ROOT / cfg_path
    script = cfg_path.parent.parent / f"{adw_name}.py"
    return script if script.is_file() else None

# An adw_name only ever names a script in the adws dir. Validate hard: the row
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
    config = row["config"] or worker_config
    script = script_for(adw_name, config)
    if script is None:
        return None
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
          once: bool, host: str, pid: int, started_at: str) -> None:
    cfg = agents.load_config(config)
    data_dir = cfg.defaults.data_dir
    jobs: dict[int, Job] = {}
    # Signal state. The handler ONLY sets flags — never does I/O or kills — because
    # it can fire mid-print (and a group SIGTERM under --supervise delivers twice:
    # once direct, once forwarded by uv), and print() from a reentered handler
    # raises "reentrant call inside BufferedWriter". The loop below reads these
    # flags and does the announcing / force-killing where it's safe.
    stop = {"requested": False, "force": False, "signum": 0, "announced": False}

    def request_stop(signum, _frame):
        stop["signum"] = signum
        # Escalate to force ONLY once the graceful stop has been announced. A group
        # SIGTERM (supervisor's killpg) is delivered twice in one burst — directly
        # AND forwarded by uv — both before the loop can announce; gating on
        # `announced` keeps that duplicate from force-killing in-flight runs. A real
        # second signal from an operator lands seconds later, after the announce, so
        # it still forces.
        if stop["requested"] and stop["announced"]:
            stop["force"] = True
        stop["requested"] = True
    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)

    print(f"[worker] draining {conn.execute('PRAGMA database_list').fetchone()['file']} "
          f"· concurrency={concurrency} · poll={poll}s")

    while True:
        now = time.monotonic()
        stopping = stop["requested"]

        # 0. Heartbeat — "a worker is attached to this project", refreshed every
        #    poll into this repo's own db. Written first so even a --once drain of
        #    an empty queue records one beat (and creates the table on a fresh db).
        workers.heartbeat(conn, host, pid, started_at)

        # 0b. Act on a stop request (flags set by the signal handler). Announce the
        #     graceful stop once; a second signal force-kills every live run and
        #     leaves. Done here, not in the handler, so no I/O runs in signal ctx.
        if stop["force"]:
            for job in jobs.values():
                signal_group(job.proc, signal.SIGKILL)
            print(f"\n[worker] signal {stop['signum']} again — force-killed "
                  f"{len(jobs)} run(s), exiting")
            raise SystemExit(130)
        if stopping and not stop["announced"]:
            stop["announced"] = True
            print(f"\n[worker] signal {stop['signum']} — no new claims; "
                  f"waiting for {len(jobs)} run(s) to finish (signal again to force)")

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


# ── supervisor ────────────────────────────────────────────────────────────────
# The one new thing allowed to spawn (besides a worker itself). It reads the
# registry and keeps exactly one worker per workerDesired project draining that
# project's queue, each in the project's own cwd — so every worker resolves its
# REPO_ROOT/config from where it runs, identical to a hand-launched `just worker`
# in that repo. The worker stays a single-repo drainer; supervision is the layer
# above it. Cockpit "start worker" flips workerDesired in the registry; this loop
# disposes — the determinism spine, one level up.


def _spawn_worker(entry: registry.ProjectEntry):
    """Launch a single-repo worker for one project, or (None, None) if its
    adw_worker.py isn't on disk. Logs to <root>/.atelier/worker.log."""
    worker_script = Path(entry.root) / entry.adws_subdir / "adw_worker.py"
    if not worker_script.is_file():
        print(f"[supervisor] no adw_worker.py at {worker_script} — skipping {entry.id!r}")
        return None, None
    log = open(ensure_dir(Path(entry.root) / ".atelier") / "worker.log", "a", buffering=1)
    argv = ["uv", "run", str(worker_script)]
    log.write(f"\n$ (cwd={entry.root}) {' '.join(argv)}\n")
    # start_new_session=True → the worker leads its own process group, so a stop
    # signals the whole worker + its ADW children, not just this uv process.
    proc = subprocess.Popen(
        argv, cwd=entry.root, stdout=log, stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    return proc, log


def supervise(registry_path: str, poll: float) -> None:
    """Keep one worker per workerDesired project alive; stop the rest.

    Re-reads the registry every poll, so toggling workerDesired from the cockpit
    (or editing the file) takes effect within a poll: a newly-desired project
    gets a worker, an undesired or removed one gets a SIGTERM. A crashed worker is
    simply not in `children` next loop, so it's respawned — restart-on-crash for
    free.
    """
    children: dict[str, subprocess.Popen] = {}
    logs: dict[str, object] = {}
    terminating: set[str] = set()  # SIGTERM sent, still draining in-flight runs
    # Flag-only handler, like drain()'s: it must not print or signal in the signal
    # context (a second Ctrl-C could reenter print() mid-write → RuntimeError). The
    # loop below reads the flag and does the stopping where it's safe.
    stop = {"requested": False, "signum": 0, "signaled": False}

    def request_stop(signum, _frame):
        stop["signum"] = signum
        stop["requested"] = True
    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)

    print(f"[supervisor] watching {registry_path} · poll={poll}s")

    while True:
        # Reap workers that have exited (undesired-and-stopped, crashed, or done).
        for proj_id, proc in list(children.items()):
            if proc.poll() is not None:
                print(f"[supervisor] worker for {proj_id!r} exited (code {proc.returncode})")
                logs.pop(proj_id).close()
                terminating.discard(proj_id)
                del children[proj_id]

        if stop["requested"]:
            # SIGTERM every worker once (their own handlers drain in-flight runs),
            # then wait for them to exit. Done here, not in the handler.
            if not stop["signaled"]:
                stop["signaled"] = True
                print(f"\n[supervisor] signal {stop['signum']} — stopping {len(children)} worker(s)")
                for proc in children.values():
                    signal_group(proc, signal.SIGTERM)
            if not children:
                print("[supervisor] all workers stopped — bye")
                return
            time.sleep(poll)
            continue

        try:
            entries = registry.read_registry(registry_path)
        except FileNotFoundError:
            entries = []  # no registry yet — nothing to supervise, keep watching
        except Exception as exc:  # malformed file: report, don't crash the supervisor
            print(f"[supervisor] registry read failed ({registry_path}): {exc}")
            entries = None

        if entries is not None:
            wanted = {e.id: e for e in entries if e.worker_desired}
            # Stop workers no longer wanted (flag flipped off, or project removed).
            # Signal once, then let it drain its in-flight runs and exit.
            for proj_id, proc in children.items():
                if proj_id not in wanted and proj_id not in terminating:
                    print(f"[supervisor] {proj_id!r} no longer desired — SIGTERM")
                    signal_group(proc, signal.SIGTERM)  # reaped on a later loop
                    terminating.add(proj_id)
            # Start a worker for every wanted project that isn't already running.
            for proj_id, entry in wanted.items():
                if proj_id in children:
                    continue
                proc, log = _spawn_worker(entry)
                if proc is None:
                    continue
                children[proj_id] = proc
                logs[proj_id] = log
                print(f"[supervisor] started worker for {proj_id!r} "
                      f"(pid {proc.pid}, cwd {entry.root})")

        time.sleep(poll)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=DEFAULT_CONFIG,
                        help="roster config; also where the db path is read from")
    parser.add_argument("--concurrency", type=int, default=2,
                        help="max runs in flight at once")
    parser.add_argument("--poll", type=float, default=1.0,
                        help="seconds between queue polls (or registry polls under --supervise)")
    parser.add_argument("--once", action="store_true",
                        help="drain the current queue, then exit (no idle loop)")
    parser.add_argument("--supervise", action="store_true",
                        help="cross-project mode: read the registry and keep one worker "
                             "per workerDesired project draining its queue")
    parser.add_argument("--registry", default=None,
                        help="atelier.projects.json path for --supervise "
                             "(default: $ATELIER_PROJECTS or <repo>/cockpit/atelier.projects.json)")
    args = parser.parse_args()

    if args.concurrency < 1:
        parser.error("--concurrency must be >= 1")

    # Line-buffer stdout so progress streams live even when redirected to a file
    # (nohup/background) — block buffering would hide it until the worker exits.
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except (AttributeError, ValueError):
        pass

    # Supervisor: spans repos, spawns one single-repo worker per project. It does
    # not connect to any single db itself — each worker heartbeats its own.
    if args.supervise:
        supervise(args.registry or default_registry(), args.poll)
        return 0

    host, pid = workers.identity()
    cfg = agents.load_config(args.config)
    conn = connect(cfg.observability.db)
    # One try/finally around the whole connection lifetime, so a throw in
    # ensure_schema can't leak the connection (and its WAL handle).
    try:
        queue.ensure_schema(conn)
        workers.ensure_schema(conn)
        # Sweep any row left by a crashed predecessor — one worker per project, so
        # a prior row for this host is stale — then heartbeat cleanly from here.
        workers.clear_host(conn, host)
        started_at = now_iso()
        drain(conn, args.config, args.concurrency, args.poll, args.once,
              host, pid, started_at)
    finally:
        # Drop our heartbeat row so the cockpit shows 'no worker' at once.
        # Best-effort: on an ensure_schema failure the table may not exist.
        try:
            workers.clear(conn, host, pid)
        except sqlite3.Error:
            pass
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
