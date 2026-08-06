"""provision — the pure mechanics of turning a sandbox profile into a warm tree.

A sandbox's LEVEL selects a profile (data_types.SandboxProfile); this module is
the deterministic code that acts on it: probe free ports, interpolate `${NAME}`
tokens, run the project's `setup` commands once at create, and assemble the extra
process env every run in the sandbox inherits. The WORKER (adw_worker.py) is the
only caller — it stays the single thing that provisions, exactly as it is the
single thing that spawns runs. Kept here (not in the worker) so the mechanics are
importable and unit-checkable, and so sandboxes.py stays the thin seam/DDL module.

Interpolation is deliberately narrow: only `${IDENTIFIER}` is substituted, and an
unknown name is left verbatim, so a `$(cmd)` / `$VAR` / `$$` in an operator's
shell string passes through to the shell untouched. Every value we interpolate
(SANDBOX_ID, BRANCH, allocated ports) is engine-minted — a hex id, a validated
branch, an integer port — so splicing it into a shell string carries no injection
the operator didn't already author.
"""

from __future__ import annotations

import re
import socket
import subprocess
from pathlib import Path
from typing import Iterable

from .data_types import SandboxProfile
from .utils import operator_env

_VAR_RE = re.compile(r"\$\{(\w+)\}")


def interpolate(template: str, ctx: dict[str, str]) -> str:
    """Replace every `${NAME}` in `template` with ctx[NAME]; leave `${NAME}` as-is
    when NAME is unknown (and never touch `$VAR`, `$(…)`, or `$$`)."""
    return _VAR_RE.sub(lambda m: ctx.get(m.group(1), m.group(0)), template)


def free_port() -> int:
    """One free TCP port, chosen by binding to :0 and reading it back. Mildly
    TOCTOU-racy (the port is free now, could be taken before a service binds it) —
    the design accepts this over a reserved-range allocator for simplicity."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def allocate_ports(names: Iterable[str]) -> dict[str, int]:
    """A distinct free port per requested name. Bound sequentially against a set of
    already-chosen ports so two names in one call never collide on the same port."""
    ports: dict[str, int] = {}
    taken: set[int] = set()
    for name in names:
        port = free_port()
        while port in taken:
            port = free_port()
        taken.add(port)
        ports[name] = port
    return ports


def base_ctx(sandbox_id: str, branch: str, ports: dict[str, int]) -> dict[str, str]:
    """The interpolation context available to setup/env/services/land: the sandbox
    id, its branch, and every allocated port name (`WEB` -> "51234")."""
    ctx = {"SANDBOX_ID": sandbox_id, "BRANCH": branch}
    ctx.update({name: str(port) for name, port in ports.items()})
    return ctx


def run_setup(commands: list[str], cwd: str | Path, ctx: dict[str, str], log) -> None:
    """Run each `setup` command once, interpolated, in the worktree. Raises on the
    first non-zero exit so the worker marks the sandbox `failed` instead of hosting
    runs against a half-provisioned tree.

    Uses operator_env() (the engineer's own PATH/toolchains, venv stripped) plus the
    ctx values as env, so `pnpm`/`docker`/etc. resolve exactly as in the operator's
    shell and a command can also read `$SANDBOX_ID`/`$WEB` directly. `log` is the
    sandbox provision log (an open file handle); command output streams into it."""
    env = operator_env()
    env.update(ctx)
    for command in commands:
        rendered = interpolate(command, ctx)
        log.write(f"\n$ (cwd={cwd}) {rendered}\n")
        log.flush()
        result = subprocess.run(
            rendered, shell=True, cwd=str(cwd), env=env,
            stdout=log, stderr=subprocess.STDOUT,
        )
        if result.returncode != 0:
            raise RuntimeError(f"setup command failed (exit {result.returncode}): {rendered}")


def run_env(profile: SandboxProfile, ports: dict[str, int],
            sandbox_id: str, branch: str) -> dict[str, str]:
    """The extra process env every run in this sandbox inherits: one var per
    allocated port (`WEB=51234`), plus the profile's own `env` with `${…}`
    interpolated. Recomputed from the persisted ports on each run, so follow-up
    runs read exactly the ports the sandbox was provisioned with."""
    ctx = base_ctx(sandbox_id, branch, ports)
    out: dict[str, str] = {name: str(port) for name, port in ports.items()}
    for key, value in profile.env.items():
        out[key] = interpolate(value, ctx)
    return out
