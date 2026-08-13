"""install.py — the stamper's skill layout + cross-agent symlink contract.

These cover the parts that silently break cross-agent discovery: that the operator
skill lands at the vendor-neutral `.agents/skills/` (not `.claude/skills/`), and that
`_ensure_agent_skill_symlinks` links `.claude/skills` + `.pi/skills` at it *without*
ever clobbering a dir you filled with your own skills. Uses the LIVE engine payload
(the real `engine/skills/`), stamped into a tmp target - no model, no network.
"""
from __future__ import annotations

from pathlib import Path

import install


def test_target_rel_maps_skill_to_agents():
    source = install.source_adws()
    skill = install.source_skills(source) / "atelier" / "SKILL.md"
    assert install.target_rel(source, skill) == ".agents/skills/atelier/SKILL.md"


def test_target_rel_maps_engine_code_under_adws():
    source = install.source_adws()
    mod = source / "adw_modules" / "tracer.py"
    assert install.target_rel(source, mod) == "adws/adw_modules/tracer.py"


def test_stamp_lands_agents_skills_with_vendor_symlinks(tmp_path):
    install.install(tmp_path, install.source_adws())

    # Canonical: real files under .agents/skills (Codex reads this natively).
    canonical = tmp_path / ".agents" / "skills" / "atelier" / "SKILL.md"
    assert canonical.is_file() and not canonical.is_symlink()

    # Vendor dirs are relative symlinks → ../.agents/skills, and resolve through.
    for rel in install.SKILL_SYMLINKS:
        link = tmp_path / rel
        assert link.is_symlink(), f"{rel} should be a symlink"
        assert Path(link.readlink()).as_posix() == install.SKILL_SYMLINK_TARGET
        assert (link / "atelier" / "SKILL.md").is_file()   # resolves to the real file

    # The manifest keys the skill under .agents/skills (the managed contract moved).
    manifest = install.read_manifest(tmp_path)
    assert any(k.startswith(".agents/skills/atelier/") for k in manifest["stamped"])
    assert not any(k.startswith(".claude/skills/") for k in manifest["stamped"])


def test_symlink_helper_replaces_empty_dir(tmp_path):
    (tmp_path / ".claude" / "skills").mkdir(parents=True)   # empty real dir
    created = install._ensure_agent_skill_symlinks(tmp_path)
    assert ".claude/skills" in created
    assert (tmp_path / ".claude" / "skills").is_symlink()


def test_symlink_helper_leaves_your_own_skills_untouched(tmp_path):
    mine = tmp_path / ".claude" / "skills" / "myskill" / "SKILL.md"
    mine.parent.mkdir(parents=True)
    mine.write_text("---\nname: myskill\ndescription: mine\n---\n")

    created = install._ensure_agent_skill_symlinks(tmp_path)

    # .claude/skills stays a real dir (never clobbered); .pi/skills still gets linked.
    assert ".claude/skills" not in created
    assert not (tmp_path / ".claude" / "skills").is_symlink()
    assert mine.is_file()
    assert ".pi/skills" in created and (tmp_path / ".pi" / "skills").is_symlink()


def test_symlink_helper_is_idempotent(tmp_path):
    first = install._ensure_agent_skill_symlinks(tmp_path)
    assert set(first) == set(install.SKILL_SYMLINKS)
    assert install._ensure_agent_skill_symlinks(tmp_path) == []   # second run: nothing to do
