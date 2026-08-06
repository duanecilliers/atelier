"""registry — the Python reader for atelier.projects.json.

The cockpit OWNS this file (cockpit/lib/projects.ts reads and writes it); the
supervisor (adw_worker.py --supervise) READS it to learn which projects exist and
which want a worker draining their queue (the `workerDesired` flag the cockpit's
"start worker" button flips). Both sides read the same file — the design's single
home for cross-project state.

Kept in lockstep with `ProjectSchema` in projects.ts by hand: it's a file, not a
db table, so `pnpm check:contract` doesn't cover it (same discipline as the
roster mirror). Relative `root`s resolve against the registry file's own
directory, matching the cockpit which resolves them against its cwd — the dir the
registry file lives in (`cockpit/`).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class ProjectEntry:
    id: str
    name: str
    root: str  # absolute
    adws_subdir: str
    worker_desired: bool


def read_registry(path: str | Path) -> list[ProjectEntry]:
    """Parse + resolve atelier.projects.json into entries with absolute roots.

    Raises on a malformed file rather than silently degrading — a bad registry
    should surface loudly, exactly as it does on the cockpit side.
    """
    path = Path(path)
    base = path.parent
    raw = json.loads(path.read_text())
    if not isinstance(raw, list):
        raise ValueError("atelier.projects.json must be a JSON array")

    entries: list[ProjectEntry] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("each registry entry must be an object")
        proj_id = item["id"]
        if proj_id in seen:
            raise ValueError(f"duplicate project id {proj_id!r} in {path}")
        seen.add(proj_id)
        root_path = Path(item["root"])
        if not root_path.is_absolute():
            root_path = (base / root_path).resolve()
        entries.append(
            ProjectEntry(
                id=proj_id,
                name=item.get("name", proj_id),
                root=str(root_path),
                adws_subdir=item["adwsSubdir"],
                worker_desired=bool(item.get("workerDesired", False)),
            )
        )
    return entries
