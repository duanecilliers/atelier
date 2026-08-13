#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Stamp the Atelier engine into a target repo — generate, don't mirror.

Run from your Atelier checkout; the payload is read LIVE from engine/adws/, so
there is no committed `templates/` copy to drift. The stamp is generated into the
target at the native `adws/` layout (no `engine/` prefix):

    uv run engine/adws/install.py /path/to/target-repo [--init]

What lands, and why the buckets matter for updates (see update.py):

  MANAGED  — adws/adw_modules/*.py and adws/adw_*.py (pure engine code), plus the
             operator skill .agents/skills/atelier/** (its docs must track engine
             behavior). Recorded in .atelier/manifest.json (path -> sha256). The
             updater keeps these current; a new module, ADW, or skill file is
             DISCOVERED by scanning engine/adws/ and engine/skills/, so it stamps
             automatically with no registry to edit. The skill lands at the
             vendor-neutral .agents/skills/** (Codex reads it natively), and each skill
             entry is symlinked into .claude/skills/ and .pi/skills/ so Claude Code and
             PI operators discover the same tree — see _ensure_agent_skill_symlinks.
  USER     — adws/adw_sssf_config/sssf.config.yaml, adws/adw_data/prompt_engineering/**,
             the justfile, .env.sample. Stamped ONCE and never in the manifest,
             so the updater never touches them — and anything YOU add later
             (custom ADWs, prompts, your own skills) is simply not in the manifest
             either, so it is invisible to updates by construction.
  RUNTIME  — adws/adw_data/sessions/, sssf.db*. Gitignored, never stamped.

Idempotent by refusal: install is the FIRST stamp. If .atelier/manifest.json
already exists, it stops and points you at update.py, so a re-run can never
clobber your roster or silently rewrite the manifest.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

MANIFEST_PATH = ".atelier/manifest.json"

# The runtime ignores that belong INSIDE adws/ (git honors a nested .gitignore
# relative to its own dir). Mirrors engine/.gitignore, minus the root `.env`,
# which is appended to the repo-root .gitignore instead (it lives at the root).
ADWS_GITIGNORE = """\
# Atelier engine runtime — do not commit
adw_data/sessions/
adw_data/sssf.db*
__pycache__/
*.pyc
"""

ROOT_GITIGNORE_BLOCK = "# Atelier — engine env (see adws/.gitignore for adws runtime)\n.env\n"
ROOT_GITIGNORE_MARKER = "# Atelier — engine env"


# ── discovery + hashing (shared with update.py) ───────────────────────────────

def source_adws() -> Path:
    """The live engine payload: the directory this script sits in (engine/adws)."""
    return Path(__file__).resolve().parent


def source_skills(source: Path) -> Path:
    """The live operator-skill payload: engine/skills, sibling to engine/adws.
    Stamped into the target's .agents/skills/ (with per-skill symlinks from
    .claude/skills/ and .pi/skills/) and kept current like any managed code."""
    return source.parent / "skills"


def atelier_version(source: Path) -> str:
    """The Atelier checkout's git sha at stamp time — the manifest's provenance."""
    out = subprocess.run(["git", "-C", str(source), "rev-parse", "HEAD"],
                         capture_output=True, text=True)
    return out.stdout.strip() or "unknown"


def managed_files(source: Path) -> list[Path]:
    """The managed set, DISCOVERED by scanning (never a hardcoded list): every
    adw_modules/*.py plus every top-level adw_*.py (incl. adw_worker.py), plus every
    file in the operator skill under engine/skills/. Adding a module, ADW, or skill
    file to the engine adds it here automatically."""
    files: list[Path] = []
    modules = source / "adw_modules"
    if modules.is_dir():
        files += [p for p in modules.rglob("*.py") if "__pycache__" not in p.parts]
    files += list(source.glob("adw_*.py"))
    skills = source_skills(source)
    if skills.is_dir():
        files += [p for p in skills.rglob("*")
                  if p.is_file() and "__pycache__" not in p.parts]
    # Stable order → stable manifest diffs. Key on the TARGET path since skill files
    # live outside `source` and can't be made relative to it.
    return sorted(files, key=lambda p: target_rel(source, p))


def target_rel(source: Path, f: Path) -> str:
    """Map a live payload file to its target-relative path (native layout):
      engine/adws/adw_modules/x.py    -> adws/adw_modules/x.py
      engine/skills/atelier/SKILL.md  -> .agents/skills/atelier/SKILL.md

    Skills land at the vendor-neutral .agents/skills/ (a first-class path for both
    Codex and the emerging cross-agent standard); _ensure_agent_skill_symlinks then
    links each entry into .claude/skills/ and .pi/skills/ so every harness finds it."""
    skills = source_skills(source)
    try:
        return (Path(".agents/skills") / f.relative_to(skills)).as_posix()
    except ValueError:
        return (Path("adws") / f.relative_to(source)).as_posix()


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_manifest(target: Path) -> dict | None:
    path = target / MANIFEST_PATH
    if not path.is_file():
        return None
    return json.loads(path.read_text())


def write_manifest(target: Path, manifest: dict) -> None:
    path = target / MANIFEST_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")


# ── copy (skip-existing) ──────────────────────────────────────────────────────

def _copy_new(src: Path, dst: Path, wrote: list[str], skipped: list[str], target: Path) -> None:
    """Copy src->dst unless dst exists (idempotent). Records the target-relative
    path for the summary."""
    rel = dst.relative_to(target).as_posix()
    if dst.exists():
        skipped.append(rel)
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    wrote.append(rel)


# The canonical skills dir and the vendor dirs that mirror it so every harness finds
# the same skills: Claude Code scans .claude/skills, PI scans .pi/skills. Codex reads
# .agents/skills natively, so it needs no link. All three follow symlinks. We link per
# skill ENTRY (not the whole dir), so the links drop in *alongside* any skills a target
# already keeps in .claude/skills / .pi/skills instead of colliding with that dir.
CANONICAL_SKILLS = ".agents/skills"
SKILL_VENDOR_DIRS = (".claude/skills", ".pi/skills")


def _ensure_agent_skill_symlinks(target: Path) -> list[str]:
    """For each skill stamped under .agents/skills, drop a *relative* symlink into each
    vendor dir (.claude/skills/<skill>, .pi/skills/<skill>) → the canonical entry, so
    Claude Code and PI operators discover it. Per-entry by design: the links sit beside
    whatever skills a target already keeps there; a name already taken (its own skill,
    or a prior link) is left untouched, and only entries that actually exist under
    .agents/skills are linked (never a dangling link). Returns the links it created."""
    canonical = target / CANONICAL_SKILLS
    if not canonical.is_dir():
        return []
    created: list[str] = []
    for entry in sorted(canonical.iterdir()):
        if not entry.is_dir():
            continue                                # a skill is a dir (holds SKILL.md)
        for vendor in SKILL_VENDOR_DIRS:
            link = target / vendor / entry.name
            if link.is_symlink() or link.exists():
                continue                            # name taken (link or your own skill) - leave it
            link.parent.mkdir(parents=True, exist_ok=True)
            link.symlink_to(Path("../..", CANONICAL_SKILLS, entry.name), target_is_directory=True)
            created.append(f"{vendor}/{entry.name}")
    return created


def _append_root_gitignore(target: Path, wrote: list[str]) -> None:
    gi = target / ".gitignore"
    existing = gi.read_text() if gi.is_file() else ""
    if ROOT_GITIGNORE_MARKER in existing:
        return
    sep = "" if existing.endswith("\n") or not existing else "\n"
    gi.write_text(existing + sep + ("\n" if existing else "") + ROOT_GITIGNORE_BLOCK)
    wrote.append(".gitignore (+.env)")


# ── install ───────────────────────────────────────────────────────────────────

def is_git_repo(path: Path) -> bool:
    out = subprocess.run(["git", "-C", str(path), "rev-parse", "--is-inside-work-tree"],
                         capture_output=True, text=True)
    return out.returncode == 0 and out.stdout.strip() == "true"


def install(target: Path, source: Path) -> dict:
    """Generate the stamp. Returns a summary dict (wrote/skipped/manifest)."""
    wrote: list[str] = []
    skipped: list[str] = []
    dist = source.parent / "dist"          # engine/dist — the authored starters

    # 1. MANAGED code (recorded in the manifest).
    stamped: dict[str, str] = {}
    for f in managed_files(source):
        rel = target_rel(source, f)
        _copy_new(f, target / rel, wrote, skipped, target)
        stamped[rel] = sha256_file(f)      # fresh install: stamped == source content

    # 1b. Cross-agent discovery: link each stamped skill into .claude/skills + .pi/skills.
    wrote += _ensure_agent_skill_symlinks(target)

    # 2. USER data stamped ONCE (never in the manifest): prompts (live) + starters.
    pe = source / "adw_data" / "prompt_engineering"
    for p in sorted(pe.rglob("*")):
        if p.is_file() and "__pycache__" not in p.parts:
            rel = (Path("adws") / p.relative_to(source)).as_posix()
            _copy_new(p, target / rel, wrote, skipped, target)
    _copy_new(dist / "sssf.config.starter.yaml",
              target / "adws" / "adw_sssf_config" / "sssf.config.yaml", wrote, skipped, target)
    _copy_new(dist / "justfile", target / "justfile", wrote, skipped, target)
    _copy_new(dist / "env.sample", target / ".env.sample", wrote, skipped, target)

    # 3. Ignore rules: a nested adws/.gitignore for adws runtime, plus .env at root.
    adws_gi = target / "adws" / ".gitignore"
    if not adws_gi.exists():
        adws_gi.parent.mkdir(parents=True, exist_ok=True)
        adws_gi.write_text(ADWS_GITIGNORE)
        wrote.append("adws/.gitignore")
    else:
        skipped.append("adws/.gitignore")
    _append_root_gitignore(target, wrote)

    # 4. The manifest — provenance + the managed set's stamp hashes.
    manifest = {"atelier_version": atelier_version(source), "stamped": stamped}
    write_manifest(target, manifest)
    wrote.append(MANIFEST_PATH)

    return {"wrote": wrote, "skipped": skipped, "manifest": manifest}


def main() -> int:
    parser = argparse.ArgumentParser(description="Stamp the Atelier engine into a target repo.")
    parser.add_argument("target", help="path to the target repo (its git root)")
    parser.add_argument("--init", action="store_true",
                        help="git-init the target first if it is not already a repo")
    args = parser.parse_args()

    source = source_adws()
    atelier_root = Path(subprocess.run(
        ["git", "-C", str(source), "rev-parse", "--show-toplevel"],
        capture_output=True, text=True).stdout.strip() or source.parents[1])

    target = Path(args.target).resolve()
    if args.init:
        target.mkdir(parents=True, exist_ok=True)
        if not is_git_repo(target):
            subprocess.run(["git", "init", "-q", str(target)], check=True)
    if not target.is_dir():
        parser.error(f"target {target} does not exist (use --init to create + git-init it)")
    if not is_git_repo(target):
        parser.error(f"target {target} is not a git repo — Atelier commits its work, "
                     f"so it needs one (use --init, or run `git init` there)")
    if target == atelier_root:
        parser.error("refusing to stamp Atelier into itself — the source is not a target")
    if read_manifest(target) is not None:
        parser.error(f"{target} is already stamped ({MANIFEST_PATH} exists) — "
                     f"use update.py to pull newer Atelier code")

    result = install(target, source)
    n_managed = len(result["manifest"]["stamped"])
    print(f"stamped Atelier @ {result['manifest']['atelier_version'][:8]} into {target}")
    print(f"  wrote {len(result['wrote'])} file(s) ({n_managed} managed) · "
          f"skipped {len(result['skipped'])} existing")
    print(f"\nnext:\n  cd {target}\n  cp .env.sample .env    # claude_code needs no key\n"
          f"  just demo")
    return 0


if __name__ == "__main__":
    sys.exit(main())
