#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Pull later Atelier engine improvements into a stamped repo — safely.

Run from your Atelier checkout, against a repo already stamped by install.py:

    uv run engine/adws/update.py /path/to/stamped-repo

Only the MANAGED set moves — the code recorded in .atelier/manifest.json. Your
roster (sssf.config.yaml), prompts, and anything you added yourself are not in the
manifest, so they are never in the update set: extension is free, by construction.

Per managed file, reconciled by content hash against the manifest:

  target absent            → new upstream file        → stamp it, record hash
  present, == stamped hash → untouched since stamp     → overwrite, bump hash
  present, != stamped hash → YOU edited managed code   → write <file>.atelier-new
                                                          beside it, never clobber
  in manifest, gone upstream → removed from Atelier     → delete if untouched, else
                                                          keep + report; drop from manifest

A conflict is yours to reconcile (diff <file> against <file>.atelier-new, take what
you want, delete the .atelier-new). Managed files aren't meant to be hand-edited —
Part B moved the one file everyone had to edit (verify commands) into the config —
so conflicts should be rare. `git merge-file` auto-merge is a later upgrade.
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

import install  # sibling in the checkout; reuse the discovery + hashing contract


def _prune_empty_tree(path: Path) -> None:
    """Remove path and its empty descendant dirs, bottom-up. No-op if path is absent,
    a symlink, or non-empty (only empty dirs are removed) — so a vendor skills dir you
    filled with your own skills is never touched."""
    if path.is_symlink() or not path.is_dir():
        return
    for child in sorted(path.iterdir(), reverse=True):
        _prune_empty_tree(child)
    if not any(path.iterdir()):
        path.rmdir()


def update(target: Path, source: Path) -> dict:
    manifest = install.read_manifest(target)
    if manifest is None:
        raise SystemExit(f"{target} is not stamped ({install.MANIFEST_PATH} missing) — "
                         f"run install.py first")
    old = dict(manifest.get("stamped", {}))

    # The current managed set, discovered live: target-rel -> source Path.
    current = {install.target_rel(source, f): f for f in install.managed_files(source)}

    new_stamped: dict[str, str] = {}
    added, updated, conflicts, removed, kept = [], [], [], [], []

    for rel, src in current.items():
        dst = target / rel
        src_sha = install.sha256_file(src)
        if not dst.exists():
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
            new_stamped[rel] = src_sha
            added.append(rel)
            continue
        cur_sha = install.sha256_file(dst)
        old_sha = old.get(rel)
        if cur_sha == src_sha:
            # Already the new content (untouched-and-unchanged, or a user edit that
            # happens to match upstream). Nothing to write; record the current hash.
            new_stamped[rel] = src_sha
        elif old_sha is not None and cur_sha == old_sha:
            # Untouched since the last stamp → safe to overwrite with the new code.
            shutil.copy2(src, dst)
            new_stamped[rel] = src_sha
            updated.append(rel)
        else:
            # Differs from BOTH the stamp and upstream → a hand edit to managed code
            # (or a file we didn't manage before). Never clobber: park the new
            # version beside it and keep the old hash so it stays flagged next run.
            side = dst.with_name(dst.name + ".atelier-new")
            shutil.copy2(src, side)
            new_stamped[rel] = old_sha if old_sha is not None else cur_sha
            conflicts.append(rel)

    # Files Atelier no longer ships but the manifest still lists.
    for rel in old.keys() - current.keys():
        dst = target / rel
        if not dst.exists():
            removed.append(rel)                     # already gone; just drop it
        elif install.sha256_file(dst) == old[rel]:
            dst.unlink()                            # untouched → safe to remove
            removed.append(rel)
        else:
            kept.append(rel)                        # you edited it → keep, unmanage

    # Migration + self-heal: pre-.agents stamps kept the skill at .claude/skills; the
    # removal pass above unlinked those files, so drop the empty dirs they left, then
    # (re)establish the per-skill vendor symlinks → .agents/skills. Safe for repos that
    # already have the links (no-op) and for ones carrying your own skills (untouched).
    for rel in install.SKILL_VENDOR_DIRS:
        _prune_empty_tree(target / rel)
    linked = install._ensure_agent_skill_symlinks(target)

    manifest = {"atelier_version": install.atelier_version(source), "stamped": new_stamped}
    install.write_manifest(target, manifest)
    return {"added": added, "updated": updated, "conflicts": conflicts,
            "removed": removed, "kept": kept, "linked": linked,
            "version": manifest["atelier_version"]}


def main() -> int:
    parser = argparse.ArgumentParser(description="Update a stamped repo's Atelier engine.")
    parser.add_argument("target", help="path to the stamped repo")
    args = parser.parse_args()

    source = install.source_adws()
    target = Path(args.target).resolve()
    if not target.is_dir():
        parser.error(f"target {target} does not exist")

    r = update(target, source)
    print(f"updated {target} to Atelier @ {r['version'][:8]}")
    print(f"  {len(r['updated'])} refreshed · {len(r['added'])} new · "
          f"{len(r['removed'])} removed · {len(r['conflicts'])} conflict(s) · "
          f"{len(r['kept'])} kept (edited, now unmanaged)")
    for rel in r["conflicts"]:
        print(f"  CONFLICT  {rel} — you edited it; new version at {rel}.atelier-new")
    for rel in r["kept"]:
        print(f"  KEPT      {rel} — removed upstream but you edited it")
    for rel in r["linked"]:
        print(f"  LINKED    {rel} → .agents/skills (cross-agent skill discovery)")
    if not any((r["updated"], r["added"], r["removed"], r["conflicts"],
                r["kept"], r["linked"])):
        print("  already current — nothing to do")
    return 0


if __name__ == "__main__":
    sys.exit(main())
