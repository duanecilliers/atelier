"""Validation gates: verify the envelope's CLAIMS, never guesses.

A gate is `gate(envelope, run) -> GateReport` — one check per item it looked at.
Violations are derived from the failed checks and sent back to the SAME agent
session as a correction. Every check is recorded either way, so a green gate
says WHAT it verified instead of only that it passed.

Gates check what is mechanically checkable; plan quality is a reviewer's job.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from .data_types import EnvelopeBase, GateReport

TAIL_CHARS = 1000        # command output kept as evidence on a failure


def _size(path: Path) -> str:
    n = path.stat().st_size
    return f"{n}B" if n < 1024 else f"{n / 1024:.1f}KB"


def artifacts_exist(envelope: EnvelopeBase, run) -> GateReport:
    report = GateReport()
    for a in envelope.artifacts:
        p = Path(a)
        report.check(a, p.exists(),
                     f"exists, {_size(p)}" if p.exists() else "declared artifact does not exist")
    return report


def artifacts_within_handoff(envelope: EnvelopeBase, run) -> GateReport:
    """A read-only agent's declared artifacts must live under `context_handoff/`.

    Scout and the reviewer are `writes: []` — read-only with respect to the repo,
    but always free to write their own report under the session's
    `context_handoff/` (see `permissions.always_writable`). An artifact declared
    anywhere else means the agent wrote into the repo instead; `permissions.enforce`
    then rolls that back and hard-fails the run with no feedback to the agent.
    Catching the mis-declared path HERE, as a claim gate, hands the agent a
    targeted correction in the same session — telling it to write under the
    handoff dir and remove the stray copy, so `enforce` (which still runs after)
    sees a clean tree.

    Wire this ONLY on read-only phases: an edit-capable agent (builder,
    documenter) legitimately declares artifacts inside the repo.
    """
    report = GateReport()
    root = Path(run.repo_root)

    def _abs(x) -> Path:
        # Anchor BOTH sides to repo_root: `context_handoff_dir` is often relative
        # (data_dir is `engine/adws/adw_data` in the config), and artifacts are
        # declared relative too — resolving them against cwd instead would only
        # work by coincidence when cwd == repo_root. An already-absolute path
        # (e.g. a stamped repo with an absolute data_dir) is left as-is.
        p = Path(x)
        return (p if p.is_absolute() else root / p).resolve()

    handoff = _abs(run.context_handoff_dir)
    for a in envelope.artifacts:
        inside = _abs(a).is_relative_to(handoff)
        report.check(a, inside,
                     "under context_handoff/" if inside else
                     f"a read-only agent must write its artifacts under the session "
                     f"handoff dir ({handoff}) — write it there and remove any copy "
                     f"elsewhere in the repo")
    return report


def files_non_empty(envelope: EnvelopeBase, run) -> GateReport:
    report = GateReport()
    for a in envelope.artifacts:
        p = Path(a)
        if not (p.exists() and p.is_file()):
            continue                       # existence is artifacts_exist's job
        empty = p.stat().st_size == 0
        report.check(a, not empty, "declared artifact is empty" if empty else _size(p))
    return report


def json_parses(envelope: EnvelopeBase, run) -> GateReport:
    report = GateReport()
    for a in envelope.artifacts:
        p = Path(a)
        if p.suffix != ".json" or not p.exists():
            continue
        try:
            parsed = json.loads(p.read_text())
            report.check(a, True, f"parses, {type(parsed).__name__}")
        except json.JSONDecodeError as e:
            report.check(a, False, f"declared JSON artifact does not parse: {e}")
    return report


def diff_matches_claims(envelope: EnvelopeBase, run) -> GateReport:
    """Every file claimed changed must exist on disk."""
    report = GateReport()
    for f in getattr(envelope, "changed_files", []):
        p = Path(f)
        report.check(f, p.exists(),
                     f"exists, {_size(p)}" if p.exists() else "claimed changed file does not exist")
    return report


def verdict_consistent(envelope: EnvelopeBase, run) -> GateReport:
    """A review's verdict must agree with the findings it just wrote down.

    Nothing here judges the code — that is the reviewer's job. This checks the
    envelope against itself: an approval that ships blocking items, or a
    rejection that names no problem, is a claim the harness can refute without
    reading a line of the diff.
    """
    report = GateReport()
    approved = bool(getattr(envelope, "approved", False))
    blocking = list(getattr(envelope, "blocking", []))
    unmet = [f.requirement for f in getattr(envelope, "findings", []) if not f.met]

    report.check("approved vs blocking", not (approved and blocking),
                 "no blocking items" if not blocking
                 else f"{len(blocking)} blocking item(s) while approved=true"
                 if approved else f"{len(blocking)} blocking item(s), not approved")
    report.check("approved vs findings", not (approved and unmet),
                 "every requirement met" if not unmet
                 else f"{len(unmet)} unmet requirement(s) while approved=true"
                 if approved else f"{len(unmet)} unmet requirement(s), not approved")
    report.check("rejection names a problem", approved or bool(blocking or unmet),
                 "verdict is supported" if approved or blocking or unmet
                 else "approved=false but no blocking item or unmet requirement was given")
    return report


def tests_pass(command: str):
    """Gate factory: the given shell command must exit 0."""
    def gate(envelope: EnvelopeBase, run) -> GateReport:
        result = subprocess.run(command, shell=True, capture_output=True, text=True)
        ok = result.returncode == 0
        note = f"exit {result.returncode}"
        if not ok:
            note += "\n" + (result.stdout + result.stderr)[-TAIL_CHARS:]
        return GateReport().check(command, ok, note)
    gate.__name__ = f"tests_pass({command})"
    return gate
