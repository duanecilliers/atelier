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
import json
import os
import re
import signal
import subprocess
import sqlite3
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

from adw_modules import agents, git_helper, provision, queue, registry, sandboxes, workers
from adw_modules.data_types import SandboxConfig, SandboxProfile
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
    sandbox_id: str | None = None   # the sandbox this run is bound to (serializes per sandbox)
    worktree_path: str | None = None  # its worktree, so we can read tip_sha when the run ends
    canceling: bool = False
    kill_deadline: float | None = field(default=None)


# Persistent sandbox worktrees live OUTSIDE the repo (no .gitignore churn, and
# show-toplevel still resolves inside them), namespaced by project + sandbox id.
WORKTREES_ROOT = Path.home() / ".atelier" / "worktrees"


def worktree_path_for(sandbox_id: str) -> Path:
    """Where this worker puts a sandbox's worktree: ~/.atelier/worktrees/<project>/<id>.
    Namespaced by REPO_ROOT's name so two projects' sandboxes never collide."""
    return WORKTREES_ROOT / REPO_ROOT.name / sandbox_id


def provision_log_path(sandbox_id: str) -> Path:
    """The sandbox's provision/services log — beside the worktree, never inside it,
    so setup/services output can't surface as an untracked file in the sandbox's own
    diff. Shared by provisioning, teardown, and startup reaping."""
    return worktree_path_for(sandbox_id).parent / f"{sandbox_id}.provision.log"


def connect(db_path: str) -> sqlite3.Connection:
    """Autocommit connection matching the tracer's pragmas (WAL, busy_timeout)."""
    conn = sqlite3.connect(db_path, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA busy_timeout=5000;")
    return conn


def build_argv(row: sqlite3.Row, config: str) -> list[str] | None:
    """The CLI argv for a queued row, or None if adw_name is not a valid script.
    `config` is the already-resolved roster path (absolute for a sandbox run)."""
    adw_name = (row["adw_name"] or "").strip()
    if not ADW_NAME_RE.match(adw_name):
        return None
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


def spawn(row: sqlite3.Row, worker_config: str, data_dir: str,
          worktree_path: str | None = None,
          run_env: dict[str, str] | None = None) -> Job | None:
    """Launch the ADW in its own process group, logging to the run's session dir.

    A local run (worktree_path None) runs with cwd=REPO_ROOT and inherits the
    worker's env — byte-for-byte identical to today. A SANDBOX run runs with
    cwd=<worktree> (the execution surface repo_root() resolves to) but is told
    SSSF_TRACE_ROOT=REPO_ROOT so its trace still lands in the shared db, and its
    --config is absolutized to the REAL repo so roster/db/quality come from the
    engine, not whatever the sandbox branch happens to carry. `run_env` (a
    worktree_env sandbox's allocated ports + interpolated profile env) is layered
    on top so the agent and the app reach the same per-sandbox ports/services.
    """
    config = row["config"] or worker_config
    cwd = REPO_ROOT
    env = None
    if worktree_path:
        cwd = Path(worktree_path)
        if not Path(config).is_absolute():
            config = str((REPO_ROOT / config).resolve())
        env = os.environ.copy()
        # Profile env first, THEN the engine-owned signal — so a profile can never
        # clobber SSSF_TRACE_ROOT and redirect the trace into the worktree (the one
        # thing this whole design exists to keep anchored at the real repo root).
        if run_env:
            env.update(run_env)
        env["SSSF_TRACE_ROOT"] = str(REPO_ROOT)
    argv = build_argv(row, config)
    if argv is None:
        return None
    session_dir = ensure_dir(REPO_ROOT / data_dir / "sessions" / row["adw_id"])
    log = open(session_dir / "worker.log", "a", buffering=1)
    log.write(f"\n$ (cwd={cwd}) {' '.join(argv)}\n")
    # start_new_session=True → the child leads its own process group, so a cancel
    # signals the whole ADW + its agent children, not just `uv`.
    proc = subprocess.Popen(
        argv, cwd=str(cwd), stdout=log, stderr=subprocess.STDOUT,
        start_new_session=True, env=env,
    )
    return Job(queue_id=row["id"], row=row, proc=proc, log=log,
               sandbox_id=row["sandbox_id"], worktree_path=worktree_path)


def signal_group(proc: subprocess.Popen, sig: int) -> None:
    """Signal the child's whole process group; ignore an already-dead group."""
    try:
        os.killpg(os.getpgid(proc.pid), sig)
    except (ProcessLookupError, PermissionError):
        pass


# ── sandbox reconciliation ──────────────────────────────────────────────────
# The worker is the ONLY thing that turns sandbox intent (a `sandboxes` row) into
# a real worktree, exactly as it is the only thing that turns a run_queue row into
# a process. The cockpit requests (INSERT) and asks for teardown (shutdown_requested);
# the worker disposes. Provisioning is per sandbox (at create), not per run, so
# follow-up runs start instantly against a warm tree.


def _row_ctx(row: sqlite3.Row) -> dict[str, str]:
    """The interpolation ctx for a PERSISTED sandbox row — its id, branch (with the
    default-branch fallback), and allocated ports (JSON on the row). One place maps
    a row to ctx, so teardown and reaping can't drift from each other."""
    ports = json.loads(row["ports"]) if row["ports"] else {}
    return provision.base_ctx(row["id"], row["branch"] or f"adw/{row['id']}", ports)


def _reap_services(sandbox_id: str, cwd: str | Path, ctx: dict[str, str],
                   down: str) -> None:
    """Best-effort `services.down` for a sandbox, streaming to its provision log.
    Used on provision failure, at teardown, and in startup reaping — a failing or
    absent `down` must never wedge the caller or block a worktree removal, so every
    error is swallowed (and printed). The `-p ${SANDBOX_ID}` naming pattern lets
    `down` cleanly target this sandbox's own services even after a worker restart."""
    try:
        log = open(provision_log_path(sandbox_id), "a", buffering=1)
        try:
            provision.run_services(down, cwd, ctx, log)
        finally:
            log.close()
    except Exception as exc:
        print(f"[worker] sandbox {sandbox_id} services.down failed (continuing): {exc}")


def provision_sandbox(conn: sqlite3.Connection, row: sqlite3.Row,
                      profile: SandboxProfile | None) -> None:
    """Turn a `requested` sandbox into an `active` worktree, or mark it `failed`.

    L1 (no profile) is just the worktree. A profile (worktree_env) additionally
    provisions ONCE, here, so follow-up runs start against a warm tree: allocate a
    free port per `ports` entry (persisted as JSON on the row), run the project's
    `setup` commands, then bring its backing `services.up`. Any failure — git, a
    setup command, or `services.up` — marks the sandbox `failed` and spawns no runs
    into it."""
    sid = row["id"]
    branch = row["branch"] or f"adw/{sid}"
    path = worktree_path_for(sid)
    sandboxes.set_status(conn, sid, sandboxes.PROVISIONING)
    ports: dict[str, int] = {}
    services_up_attempted = False
    try:
        ensure_dir(path.parent)
        git_helper.worktree_add(REPO_ROOT, path, branch)
        if profile is not None:
            ports = provision.allocate_ports(profile.ports.keys())
            if ports:
                sandboxes.set_ports(conn, sid, json.dumps(ports))
            ctx = provision.base_ctx(sid, branch, ports)
            if profile.setup or profile.services.up:
                # setup + services.up log beside the worktree (provision_log_path),
                # never inside it — provision artifacts must not surface as untracked
                # files in the sandbox's own diff.
                log = open(provision_log_path(sid), "a", buffering=1)
                try:
                    if profile.setup:
                        provision.run_setup(profile.setup, path, ctx, log)
                    if profile.services.up:
                        # Mark BEFORE running: a partial `up` may already have bound
                        # containers, so the failure path must still bring them down.
                        services_up_attempted = True
                        provision.run_services(profile.services.up, path, ctx, log)
                finally:
                    log.close()
        sandboxes.set_status(conn, sid, sandboxes.ACTIVE, worktree_path=str(path))
        print(f"[worker] sandbox {sid} → active ({path}, branch {branch})")
    except Exception as exc:  # git / setup / services.up: don't host runs on a half-made tree
        # Roll everything back before marking FAILED. A FAILED sandbox can't be torn
        # down later (the cockpit refuses shutdown on a terminal status, and
        # worktree_prune won't reap a dir that still exists), so anything left now
        # leaks forever. If `services.up` ran, bring services down FIRST (targetable
        # via `-p ${SANDBOX_ID}`) — a partial `up` may have started containers —
        # while the tree (and its compose file) still exists, THEN remove the tree.
        # The provision log lives beside the worktree, so it survives for debugging.
        if services_up_attempted and profile is not None and profile.services.down:
            _reap_services(sid, path, provision.base_ctx(sid, branch, ports),
                           profile.services.down)
        try:
            git_helper.worktree_remove(REPO_ROOT, path)
        except Exception:
            pass
        sandboxes.set_status(conn, sid, sandboxes.FAILED, error=str(exc)[:500])
        print(f"[worker] sandbox {sid} → failed to provision: {exc}")


def teardown_sandbox(conn: sqlite3.Connection, row: sqlite3.Row,
                     profile: SandboxProfile | None) -> None:
    """Bring a sandbox's backing services down, remove its worktree, and mark it
    `gone`. `services.down` runs FIRST — while the tree and its compose file still
    exist — but best-effort: a failing hook logs and the teardown continues, so a
    wedged service can never leak the worktree. The named branch and its commits
    survive in the shared .git (that is the whole point of a worktree)."""
    sid = row["id"]
    sandboxes.set_status(conn, sid, sandboxes.SHUTTING_DOWN)
    if profile is not None and profile.services.down and row["worktree_path"]:
        _reap_services(sid, row["worktree_path"], _row_ctx(row), profile.services.down)
    try:
        if row["worktree_path"]:
            git_helper.worktree_remove(REPO_ROOT, row["worktree_path"])
        sandboxes.set_status(conn, sid, sandboxes.GONE)
        print(f"[worker] sandbox {sid} → gone")
    except Exception as exc:
        # Best-effort: record why but still mark gone, so a stuck remove can't
        # wedge the sandbox in shutting_down forever. `worktree prune` at the next
        # startup cleans up git's record of a directory we couldn't delete.
        sandboxes.set_status(conn, sid, sandboxes.GONE, error=str(exc)[:500])
        print(f"[worker] sandbox {sid} → gone (teardown error: {exc})")


def reap_orphan_sandboxes(conn: sqlite3.Connection, sandbox_cfg: SandboxConfig) -> None:
    """Recover sandboxes a crashed worker left mid-lifecycle, at startup. One worker
    owns its project's sandboxes exclusively (supervisor guarantees one per project;
    standalone sweeps its own stale worker row), so any sandbox still in a TRANSIENT
    state — `provisioning` or `shutting_down` — belongs to a predecessor that died,
    and no live run can be using it. Bring its services down (best-effort, targetable
    via `-p ${SANDBOX_ID}` even though the old worker is gone), remove any leftover
    worktree, and resolve the status: one caught mid-provision becomes `failed`, one
    caught mid-teardown becomes `gone`."""
    orphans = (sandboxes.with_status(conn, sandboxes.PROVISIONING)
               + sandboxes.with_status(conn, sandboxes.SHUTTING_DOWN))
    for row in orphans:
        sid = row["id"]
        was = row["status"]
        profile = sandbox_cfg.profile_for(row["level"])
        # The predecessor may have died before persisting worktree_path; fall back to
        # this sandbox's canonical location so a leftover tree is still reaped.
        cwd = row["worktree_path"] or str(worktree_path_for(sid))
        if profile is not None and profile.services.down:
            _reap_services(sid, cwd, _row_ctx(row), profile.services.down)
        try:
            git_helper.worktree_remove(REPO_ROOT, cwd)
        except Exception:
            pass
        terminal = sandboxes.GONE if was == sandboxes.SHUTTING_DOWN else sandboxes.FAILED
        detail = ("worker restart during teardown" if was == sandboxes.SHUTTING_DOWN
                  else "worker restart during provisioning")
        sandboxes.set_status(conn, sid, terminal, error=detail)
        print(f"[worker] reaped orphan sandbox {sid} ({was} → {terminal})")


def reconcile_sandboxes(conn: sqlite3.Connection, jobs: dict[int, Job],
                        sandbox_cfg: SandboxConfig) -> None:
    """One reconciliation pass: provision new sandboxes, tear down retired ones,
    and fail runs orphaned by a dead sandbox. Called every poll."""
    for row in sandboxes.with_status(conn, sandboxes.REQUESTED):
        provision_sandbox(conn, row, sandbox_cfg.profile_for(row["level"]))
    # Only tear down a sandbox with no run currently in flight — a live run keeps
    # its tree until it finishes (it is reaped from `jobs` first, below).
    busy = {j.sandbox_id for j in jobs.values() if j.sandbox_id}
    for row in sandboxes.shutdown_pending(conn):
        if row["id"] in busy:
            continue
        teardown_sandbox(conn, row, sandbox_cfg.profile_for(row["level"]))
    for adw_id in queue.fail_orphaned(conn, sandboxes.dead_ids(conn)):
        print(f"[worker] run {adw_id} → failed (its sandbox is gone/failed)")


def sandbox_run_env(sb: sqlite3.Row, sandbox_cfg: SandboxConfig) -> dict[str, str] | None:
    """The extra process env for a run bound to sandbox `sb` — its allocated ports
    plus the profile's interpolated `env` — or None when the level provisions no
    env (an L1 worktree). Recomputed from the persisted ports each run."""
    profile = sandbox_cfg.profile_for(sb["level"])
    if profile is None:
        return None
    ports = json.loads(sb["ports"]) if sb["ports"] else {}
    branch = sb["branch"] or f"adw/{sb['id']}"
    return provision.run_env(profile, ports, sb["id"], branch)


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
            # A sandbox run just committed (or not) into its worktree — record the
            # tip so the cockpit shows exactly what the sandbox now holds. Best
            # effort: a missing worktree (mid-teardown) simply leaves tip_sha as-is.
            if job.sandbox_id and job.worktree_path:
                try:
                    sandboxes.set_tip_sha(conn, job.sandbox_id,
                                          git_helper.head_sha(job.worktree_path))
                except Exception:
                    pass
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

        # 2b. Reconcile sandboxes: provision requested, tear down retired, fail
        #     runs orphaned by a dead sandbox. Before the fill so a run enqueued
        #     alongside a fresh sandbox can claim it the moment it goes active.
        reconcile_sandboxes(conn, jobs, cfg.sandbox)

        # 3. Fill free slots with fresh work (unless shutting down).
        if not stopping:
            # A run bound to a sandbox may only start when that sandbox is active
            # AND not already hosting a run (runs in one sandbox serialize). Track
            # `busy` across this fill loop so two queued rows for the same sandbox
            # can't both launch in one poll — the second waits for the next.
            active = sandboxes.active_ids(conn)
            busy = {j.sandbox_id for j in jobs.values() if j.sandbox_id}
            while len(jobs) < concurrency:
                row = queue.claim_next(conn, active - busy)
                if row is None:
                    break
                worktree_path = None
                run_env = None
                if row["sandbox_id"]:
                    sb = sandboxes.get(conn, row["sandbox_id"])
                    worktree_path = sb["worktree_path"] if sb else None
                    if not worktree_path:
                        # active_ids() said runnable, but the row lost its worktree
                        # between reconcile and now — fail rather than run rootless.
                        queue.mark_terminal(conn, row["id"], queue.FAILED,
                                            error="sandbox has no active worktree")
                        print(f"[worker] rejected queue #{row['id']}: "
                              f"sandbox {row['sandbox_id']} not runnable")
                        continue
                    # The sandbox's provisioned ports + interpolated env ride every
                    # run in it (None for an L1 worktree with no profile).
                    run_env = sandbox_run_env(sb, cfg.sandbox)
                job = spawn(row, config, data_dir, worktree_path, run_env)
                if job is None:
                    queue.mark_terminal(conn, row["id"], queue.FAILED,
                                        error=f"unknown adw_name {row['adw_name']!r}")
                    print(f"[worker] rejected queue #{row['id']}: bad adw_name "
                          f"{row['adw_name']!r}")
                    continue
                queue.mark_running(conn, row["id"], job.proc.pid)
                jobs[job.queue_id] = job
                if job.sandbox_id:
                    busy.add(job.sandbox_id)
                where = f" in sandbox {job.sandbox_id}" if job.sandbox_id else ""
                print(f"[worker] run {row['adw_id']} ← {row['adw_name']}{where} "
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
        sandboxes.ensure_schema(conn)
        # Reap git's records of any worktrees a crashed predecessor left behind,
        # so a stale <id> dir can't block a fresh `worktree add` on the same path.
        try:
            git_helper.worktree_prune(REPO_ROOT)
        except Exception as exc:
            print(f"[worker] worktree prune skipped: {exc}")
        # Then recover sandboxes a predecessor left mid-lifecycle — bring their
        # orphaned services down and resolve their transient status. Best-effort:
        # a failure here must not stop the worker from draining its queue.
        try:
            reap_orphan_sandboxes(conn, cfg.sandbox)
        except Exception as exc:
            print(f"[worker] orphan sandbox reap skipped: {exc}")
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
