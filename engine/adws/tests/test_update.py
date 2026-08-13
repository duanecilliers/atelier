"""update.py — migration to the .agents/skills layout + symlink self-heal.

The risky path is a repo stamped BEFORE the cross-agent change (skill at
`.claude/skills/`, manifest keyed there): update must move it to `.agents/skills/`,
drop the emptied old dirs, and (re)create the vendor symlinks - without clobbering a
managed-skill edit. Uses the live engine payload stamped into a tmp target.
"""
from __future__ import annotations

import shutil
from pathlib import Path

import install
import update


def _downgrade_to_pre_agents(target: Path) -> None:
    """Rewrite a fresh (new-layout) stamp back to the pre-.agents world: skill real
    files under .claude/skills, manifest keyed there, no vendor symlinks, no .agents."""
    for vendor in install.SKILL_VENDOR_DIRS:
        shutil.rmtree(target / vendor, ignore_errors=True)   # drop the per-entry symlinks
    shutil.move(str(target / ".agents" / "skills"), str(target / ".claude" / "skills"))
    (target / ".agents").rmdir()

    manifest = install.read_manifest(target)
    stamped = {}
    for k, v in manifest["stamped"].items():
        if k.startswith(".agents/skills/"):
            k = ".claude/skills/" + k[len(".agents/skills/"):]
        stamped[k] = v
    install.write_manifest(target, {"atelier_version": "old", "stamped": stamped})


def test_migrates_old_claude_skills_layout(tmp_path):
    source = install.source_adws()
    install.install(tmp_path, source)
    _downgrade_to_pre_agents(tmp_path)
    assert (tmp_path / ".claude" / "skills" / "atelier" / "SKILL.md").is_file()  # precondition

    r = update.update(tmp_path, source)

    # Skill moved to the canonical .agents/skills; old real dir cleaned up + re-linked.
    assert (tmp_path / ".agents" / "skills" / "atelier" / "SKILL.md").is_file()
    assert (tmp_path / ".claude" / "skills" / "atelier").is_symlink()
    assert (tmp_path / ".pi" / "skills" / "atelier").is_symlink()
    assert (tmp_path / ".claude" / "skills" / "atelier" / "SKILL.md").is_file()  # resolves

    # Manifest re-keyed under .agents/skills; the per-skill links were reported.
    manifest = install.read_manifest(tmp_path)
    assert any(k.startswith(".agents/skills/atelier/") for k in manifest["stamped"])
    assert not any(k.startswith(".claude/skills/") for k in manifest["stamped"])
    assert set(r["linked"]) == {".claude/skills/atelier", ".pi/skills/atelier"}


def test_update_after_install_is_a_noop(tmp_path):
    source = install.source_adws()
    install.install(tmp_path, source)

    r = update.update(tmp_path, source)

    assert r["updated"] == [] and r["added"] == [] and r["conflicts"] == []
    assert r["linked"] == []                       # per-skill symlinks already present
    assert (tmp_path / ".claude" / "skills" / "atelier").is_symlink()


def test_hand_edited_managed_skill_is_parked_not_clobbered(tmp_path):
    source = install.source_adws()
    install.install(tmp_path, source)
    skill = tmp_path / ".agents" / "skills" / "atelier" / "SKILL.md"
    skill.write_text("HAND EDITED\n")             # diverge from the stamped hash

    r = update.update(tmp_path, source)

    assert any(k.endswith(".agents/skills/atelier/SKILL.md") for k in r["conflicts"])
    assert skill.read_text() == "HAND EDITED\n"    # never clobbered
    assert skill.with_name("SKILL.md.atelier-new").is_file()
