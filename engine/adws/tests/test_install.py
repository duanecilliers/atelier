"""install.py — the stamper's skill layout + cross-agent symlink contract.

These cover the parts that silently break cross-agent discovery: that the operator
skill lands at the vendor-neutral `.agents/skills/` (not `.claude/skills/`), and that
`_ensure_agent_skill_symlinks` links each skill ENTRY into `.claude/skills` + `.pi/skills`
*alongside* any skills a target already keeps there - never colliding with that dir.
Uses the LIVE engine payload (the real `engine/skills/`) stamped into a tmp target - no
model, no network.
"""
from __future__ import annotations

from pathlib import Path

import pytest

import install


def _fake_canonical(target: Path, *names: str) -> None:
    """Lay down .agents/skills/<name>/SKILL.md so the helper has entries to link."""
    for name in names:
        d = target / install.CANONICAL_SKILLS / name
        d.mkdir(parents=True)
        (d / "SKILL.md").write_text(f"---\nname: {name}\ndescription: {name}\n---\n")


def test_target_rel_maps_skill_to_agents():
    source = install.source_adws()
    skill = install.source_skills(source) / "atelier" / "SKILL.md"
    assert install.target_rel(source, skill) == ".agents/skills/atelier/SKILL.md"


def test_target_rel_maps_engine_code_under_adws():
    source = install.source_adws()
    mod = source / "adw_modules" / "tracer.py"
    assert install.target_rel(source, mod) == "adws/adw_modules/tracer.py"


def test_stamp_lands_agents_skills_with_per_entry_symlinks(tmp_path):
    install.install(tmp_path, install.source_adws())

    # Canonical: real files under .agents/skills (Codex reads this natively).
    canonical = tmp_path / ".agents" / "skills" / "atelier" / "SKILL.md"
    assert canonical.is_file() and not canonical.is_symlink()

    # Each vendor dir gets a per-skill relative symlink → the canonical entry.
    for vendor in install.SKILL_VENDOR_DIRS:
        link = tmp_path / vendor / "atelier"
        assert link.is_symlink(), f"{vendor}/atelier should be a symlink"
        assert Path(link.readlink()).as_posix() == "../../.agents/skills/atelier"
        assert (link / "SKILL.md").is_file()               # resolves to the real file

    # The manifest keys the skill under .agents/skills (the managed contract moved).
    manifest = install.read_manifest(tmp_path)
    assert any(k.startswith(".agents/skills/atelier/") for k in manifest["stamped"])
    assert not any(k.startswith(".claude/skills/") for k in manifest["stamped"])


def test_links_sit_alongside_a_targets_own_skills(tmp_path):
    # The #1 case: a target that already keeps its own skill in .claude/skills.
    mine = tmp_path / ".claude" / "skills" / "myskill" / "SKILL.md"
    mine.parent.mkdir(parents=True)
    mine.write_text("---\nname: myskill\ndescription: mine\n---\n")
    _fake_canonical(tmp_path, "atelier")

    created = install._ensure_agent_skill_symlinks(tmp_path)

    # atelier is linked into .claude/skills BESIDE myskill; neither is disturbed.
    assert ".claude/skills/atelier" in created
    assert (tmp_path / ".claude" / "skills" / "atelier").is_symlink()
    assert (tmp_path / ".claude" / "skills" / "atelier" / "SKILL.md").is_file()
    assert mine.is_file() and not (tmp_path / ".claude" / "skills" / "myskill").is_symlink()


def test_links_only_entries_that_exist_no_dangling(tmp_path):
    # No canonical dir at all → nothing to link, and no dangling symlinks created.
    assert install._ensure_agent_skill_symlinks(tmp_path) == []
    assert not (tmp_path / ".claude" / "skills").exists()


def test_a_taken_name_is_left_untouched(tmp_path):
    # A target already has its OWN skill named "atelier" — don't clobber it.
    theirs = tmp_path / ".claude" / "skills" / "atelier" / "SKILL.md"
    theirs.parent.mkdir(parents=True)
    theirs.write_text("MINE\n")
    _fake_canonical(tmp_path, "atelier")

    created = install._ensure_agent_skill_symlinks(tmp_path)

    assert ".claude/skills/atelier" not in created                 # name taken → skipped
    assert not (tmp_path / ".claude" / "skills" / "atelier").is_symlink()
    assert theirs.read_text() == "MINE\n"
    assert ".pi/skills/atelier" in created                          # .pi was free → linked


def test_symlink_helper_is_idempotent(tmp_path):
    _fake_canonical(tmp_path, "atelier")
    first = install._ensure_agent_skill_symlinks(tmp_path)
    assert set(first) == {".claude/skills/atelier", ".pi/skills/atelier"}
    assert install._ensure_agent_skill_symlinks(tmp_path) == []     # second run: nothing to do
