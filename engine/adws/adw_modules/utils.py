"""Small shared helpers. Anything bigger belongs in its own module."""

from __future__ import annotations

import os
import secrets
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()


def operator_env() -> dict[str, str]:
    """The engineer's own environment, as their shell would hand it over.

    Agents and quality blocks are meant to see exactly what the operator sees:
    their PATH, their toolchains, their globally installed packages. Copying
    os.environ gets almost all the way there — but ADWs launch under `uv run`,
    which prepends its ephemeral venv's bin to PATH and sets VIRTUAL_ENV. That
    venv holds the ADW's OWN dependencies (pydantic, pyyaml), not the
    operator's, so anything a subprocess resolves through it — `python3`,
    `pip`, every globally pip-installed CLI — silently becomes the wrong one.

    Stripping the venv restores parity: `python3` in an agent's bash is the
    same `python3` the engineer gets in their terminal. The ADW's own imports
    are unaffected; this env is only ever handed to child processes.
    """
    env = os.environ.copy()
    venv = env.pop("VIRTUAL_ENV", "")
    if not venv:
        return env
    venv_bin = str(Path(venv) / "bin")
    parts = [p for p in env.get("PATH", "").split(os.pathsep) if p and p != venv_bin]
    env["PATH"] = os.pathsep.join(parts)
    return env


def operator_env_overrides() -> dict[str, str]:
    """operator_env(), shaped for a transport that MERGES instead of replacing.

    Most spawn sites hand operator_env() straight to `env=` and get exactly the
    dict they built. The Claude Agent SDK does not: it merges `options.env` over
    a copy of os.environ, so a key operator_env() *removed* is not removed at all
    - the inherited value simply survives, because no override mentions the key.
    That half-applies the fix: PATH is corrected (the key is present) while
    VIRTUAL_ENV comes back, a combination no other backend produces.

    A merge cannot express a delete, so express the nearest thing it can: an
    explicit blank for every key operator_env() dropped. Empty and unset are
    equivalent to the tools that read VIRTUAL_ENV (uv, activate scripts, pip);
    both mean "no active venv". Derived from the diff rather than named
    literally, so this stays correct if operator_env() ever drops another key.
    """
    env = operator_env()
    for key in os.environ:
        if key not in env:
            env[key] = ""
    return env


def trace_root() -> Path:
    """Where the observability sink (sssf.db, session dirs, JSONL) anchors.

    A sandboxed run executes with cwd = its worktree, so a relative db/data_dir
    path from the config would otherwise resolve INTO the worktree — the cockpit
    would then see nothing. The worker sets SSSF_TRACE_ROOT to the real repo root
    so the trace lands where the reader is. Unset (every CLI run today) → cwd, so
    paths resolve exactly as before: byte-identical behaviour.
    """
    return Path(os.environ.get("SSSF_TRACE_ROOT") or Path.cwd())


def resolve_trace_path(path: str | Path) -> Path:
    """Absolutize an observability path against trace_root().

    An already-absolute path is returned untouched; a relative one (the config's
    `db:`/`data_dir:`) is anchored at trace_root(). This is the ONE fix the
    sandbox design needs — the execution surface (agent cwd, diff, commit) is
    correctly the worktree via repo_root(); only the sink must stay anchored.
    """
    p = Path(path)
    return p if p.is_absolute() else trace_root() / p


def new_id(length: int = 8) -> str:
    return secrets.token_hex(length // 2)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def ensure_dir(path: str | Path) -> Path:
    p = Path(path)
    p.mkdir(parents=True, exist_ok=True)
    return p


def resolve_prompt(arg: str) -> str:
    """CLI prompt arg: a file path resolves to its contents, else inline text."""
    try:
        p = Path(arg)
        if p.is_file():
            return p.read_text()
    except OSError:
        pass
    return arg


def engineer_name() -> str:
    name = os.environ.get("ENGINEER_NAME", "").strip()
    if name:
        return name
    try:
        out = subprocess.run(["git", "config", "user.name"],
                             capture_output=True, text=True, timeout=5)
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
    except OSError:
        pass
    return os.environ.get("USER", "engineer")
