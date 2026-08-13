"""agent_pi.py — the pi backend argv contract.

The one thing here that silently corrupts determinism if it regresses: the ADW pi
coding agent must run with `--no-skills` so it never inhales ambient skills (the
stamped `.agents/skills` operator skill, or the operator's own `~/.pi/agent/skills`).
That is pi's parallel to agent_cc.py's `setting_sources: []`.
"""
from __future__ import annotations

from adw_modules import agent_pi
from adw_modules.data_types import PiRequest


def _request(**over) -> PiRequest:
    base = dict(
        prompt="do the thing", system_prompt="BE AN AGENT", model="openai-codex/gpt-5.6",
        session_id="sess-1", session_dir="/tmp/s", raw_output_path="/tmp/s/raw.jsonl",
    )
    base.update(over)
    return PiRequest(**base)


def test_command_includes_no_skills_isolation_flag():
    cmd = agent_pi.build_pi_command(_request(), "openai-codex", "gpt-5.6")
    assert "--no-skills" in cmd
    # Context files stay ON - that is pi's intended project-guidance channel.
    assert "--no-context-files" not in cmd and "-nc" not in cmd


def test_command_carries_prompt_last_and_core_flags():
    cmd = agent_pi.build_pi_command(_request(), "openai-codex", "gpt-5.6")
    assert cmd[-1] == "do the thing"
    assert cmd[:4] == [agent_pi.PI_PATH, "-p", "--mode", "json"]
    assert "--system-prompt" in cmd and "BE AN AGENT" in cmd


def test_command_threads_tools_and_extensions():
    cmd = agent_pi.build_pi_command(
        _request(tools=["read", "bash"], extensions=["/x/ext.js"]),
        "openai-codex", "gpt-5.6")
    assert "--tools" in cmd and "read,bash" in cmd
    assert cmd[cmd.index("-e") + 1] == "/x/ext.js"
