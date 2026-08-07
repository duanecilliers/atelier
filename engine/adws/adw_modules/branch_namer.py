"""Human-readable sandbox branch names from a one-shot cheap-model call.

When a sandbox is created with a `purpose` (and no explicit branch), the worker
asks a cheap model — once, at provision time — to turn that intent into a readable
git branch (`feat/api-rate-limiting` rather than `adw/3f2a…`). The model output is
slugified to a git-ref- AND shell-safe charset, deduped against existing branches,
and — on empty output, an unsafe name, a model error, or no auth — falls back to
the deterministic `adw/<id>`. Naming is a legibility nicety layered on top of the
existing branch resolution; it is NEVER a provisioning dependency.

Backend selection mirrors the coding agents (agents.py::load_config): an
`anthropic/*` model runs through the local `claude` CLI (its own login — no API
key, and pi can't do Anthropic), anything else through the `pi` backend. Both are
plain subprocesses, so this adds no dependency to the worker. The call is
tool-less (a naming turn must answer, not act — an agentic `claude -p` without
`--allowedTools ""` tries to DO the task) and terse (~50 output tokens).
"""

from __future__ import annotations

import os
import re
import subprocess

from . import agent_pi, git_helper
from .data_types import PiRequest, SandboxNamer

# The local Claude Code binary — its own login authenticates the call. Overridable
# like agent_pi's PI_PATH so a non-standard install still resolves.
CLAUDE_PATH = os.environ.get("CLAUDE_PATH", "claude")

_SYSTEM = (
    "You name git branches. Reply with ONLY a branch name on one line: kebab-case, "
    "a feat/ fix/ chore/ or docs/ prefix, max 40 chars, ASCII letters digits and -/ "
    "only. No quotes, no explanation."
)


def _user_prompt(purpose: str) -> str:
    # The purpose is DATA to be named, not an instruction to act on — quote it so a
    # model doesn't read "Add rate limiting" as a task to implement.
    return f'Suggest a git branch name for the task below.\n\nTask: "{purpose}"'


def _model_id(pattern: str) -> str:
    """`anthropic/claude-haiku-4-5` -> `claude-haiku-4-5`; passthrough if no slash."""
    return pattern.split("/", 1)[1] if "/" in pattern else pattern


def _pick_line(raw: str) -> str:
    """The last non-empty line — robust to a stray preface before the branch name."""
    lines = [ln.strip() for ln in (raw or "").splitlines() if ln.strip()]
    return lines[-1] if lines else ""


def _slugify(raw: str) -> str:
    """Normalize model output to a git-ref- AND shell-safe branch slug, or "".

    Charset matches the cockpit's validateBranchName (roster-constants.ts): letters,
    digits, and - _ . / — no shell metacharacters (the branch interpolates into
    ${BRANCH} in setup/land hooks) and no git-illegal shapes."""
    s = _pick_line(raw).strip().strip("`\"'").lower()
    s = re.sub(r"[^a-z0-9._/-]+", "-", s)   # anything else -> a single dash
    s = re.sub(r"-{2,}", "-", s)            # collapse dash runs
    s = re.sub(r"/{2,}", "/", s)            # collapse slash runs
    s = re.sub(r"\.{2,}", ".", s)           # kill `..` (git rejects it)
    s = re.sub(r"/\.+", "/", s)             # no dot at a segment start (git rejects it)
    s = re.sub(r"\.+/", "/", s)             # no dot at a segment end
    s = s.strip("-/.")                      # no leading/trailing separators or dots
    if len(s) > 60:
        s = s[:60].strip("-/.")
    return s


def _is_valid(branch: str) -> bool:
    """A last-line defense mirroring validateBranchName — the slug should already
    satisfy this, but a dedupe suffix or an odd model reply could break it."""
    if not branch or len(branch) > 200:
        return False
    if ".." in branch or branch.startswith(("-", "/")) or branch.endswith(("/", ".lock")):
        return False
    if any(seg == "" or seg.startswith(".") for seg in branch.split("/")):
        return False  # git forbids an empty or dot-leading path component
    return re.fullmatch(r"[A-Za-z0-9._/-]+", branch) is not None


def _suggest_claude(purpose: str, model_id: str, cwd: str) -> str:
    """One tool-less Claude turn via the local CLI. Returns raw stdout (or "")."""
    proc = subprocess.run(
        [CLAUDE_PATH, "-p", _user_prompt(purpose), "--model", model_id,
         "--allowedTools", "", "--append-system-prompt", _SYSTEM],
        capture_output=True, text=True, timeout=90, cwd=cwd,
    )
    return proc.stdout if proc.returncode == 0 else ""


def _suggest_pi(purpose: str, model: str, cwd: str) -> str:
    """One pi turn for a non-anthropic namer model (e.g. an openai-codex model — the
    Codex alternative). Reuses agent_pi.run (a subprocess, no extra dependency); the
    terse system prompt keeps the turn to a bare answer."""
    import tempfile
    from pathlib import Path

    with tempfile.TemporaryDirectory(prefix="sbnamer-") as td:
        request = PiRequest(
            prompt=_user_prompt(purpose),
            system_prompt=_SYSTEM,
            model=model,
            thinking="off",
            session_id="namer-" + os.urandom(4).hex(),
            session_dir=str(Path(td) / "sessions"),
            raw_output_path=str(Path(td) / "raw.jsonl"),
            tools=[],
            cwd=cwd,
        )
        return agent_pi.run(request).text


def _suggest(purpose: str, namer: SandboxNamer, cwd: str) -> str:
    if namer.model.startswith("anthropic/"):
        return _suggest_claude(purpose, _model_id(namer.model), cwd)
    return _suggest_pi(purpose, namer.model, cwd)


def _purpose_of(row) -> str:
    """The row's purpose if present (the column is additive — an older row/db may
    lack it), else ""."""
    try:
        return (row["purpose"] or "").strip()
    except (IndexError, KeyError):
        return ""


def resolve_branch(row, namer: SandboxNamer, repo_root: str) -> str:
    """The branch a sandbox's worktree checks out.

    Precedence: an explicit `branch` on the row (an operator override or a
    profile-template value the cockpit already interpolated) always wins. Otherwise,
    when the namer is enabled and the row carries a `purpose`, generate a readable
    slug and dedupe it against existing branches (a same-named branch would make
    `git worktree add` fail). Every other case — naming disabled, no purpose, an
    unusable model reply, or any exception — resolves to the deterministic
    `adw/<id>`, so provisioning never depends on the model being reachable."""
    sid = row["id"]
    existing = row["branch"]
    if existing:
        return existing
    purpose = _purpose_of(row)
    if not (namer.enabled and purpose):
        return f"adw/{sid}"
    try:
        slug = _slugify(_suggest(purpose, namer, repo_root))
        if not slug:
            return f"adw/{sid}"
        # A collision would fail `git worktree add` (the branch is already checked
        # out elsewhere); the id suffix is unique, so one pass guarantees a free name.
        if git_helper.branch_exists(repo_root, slug):
            slug = f"{slug}-{sid[:4]}"
        return slug if _is_valid(slug) else f"adw/{sid}"
    except Exception:
        return f"adw/{sid}"
