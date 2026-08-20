"""agent_cc.py - the environment the Claude Agent SDK hands its CLI.

The backend's model call cannot be tested offline, but the options it builds
can: the one thing that silently changes what an agent's Bash resolves is the
`env` it spawns under. These pin that the claude_code backend spawns with the
operator's environment like every other spawn site, and that it survives the
SDK's merge (which cannot express a delete) rather than half-applying.
"""
from __future__ import annotations

import os

import pytest

from adw_modules import agent_cc, agent_pi
from adw_modules.data_types import PiRequest


def _request(tmp_path) -> PiRequest:
    return PiRequest(
        prompt="hi", system_prompt="be a scout", model="anthropic/claude-haiku-4-5",
        session_id="s1", session_dir=str(tmp_path),
        raw_output_path=str(tmp_path / "raw_output.jsonl"), cwd=str(tmp_path),
    )


@pytest.fixture
def captured_options(monkeypatch, tmp_path):
    """Run one turn against a stubbed SDK; hand back the ClaudeAgentOptions built."""
    import claude_agent_sdk

    seen = {}

    async def fake_query(prompt, options):        # an empty stream: no messages
        seen["options"] = options
        return
        yield                                     # noqa: unreachable - makes it a generator

    monkeypatch.setattr(claude_agent_sdk, "query", fake_query)
    monkeypatch.setattr(agent_pi, "context_window", lambda *a, **k: 0)
    monkeypatch.setattr(agent_cc, "_SDK_SESSIONS", {})

    def run(env: dict[str, str]):
        for key in ("VIRTUAL_ENV", "PATH"):
            monkeypatch.delenv(key, raising=False)
        for key, value in env.items():
            monkeypatch.setenv(key, value)
        agent_cc.run(_request(tmp_path))
        return seen["options"]

    return run


def test_spawns_with_the_operator_path_not_the_adw_venv(captured_options):
    options = captured_options({
        "VIRTUAL_ENV": "/tmp/adw/.venv",
        "PATH": os.pathsep.join(["/tmp/adw/.venv/bin", "/usr/local/bin", "/usr/bin"]),
    })
    assert options.env["PATH"] == os.pathsep.join(["/usr/local/bin", "/usr/bin"])


def test_blanks_virtual_env_because_the_sdk_merges(captured_options):
    """A merge over os.environ restores anything merely absent from the override,
    so the popped VIRTUAL_ENV must come back as an explicit blank instead."""
    options = captured_options({
        "VIRTUAL_ENV": "/tmp/adw/.venv",
        "PATH": os.pathsep.join(["/tmp/adw/.venv/bin", "/usr/bin"]),
    })
    assert options.env["VIRTUAL_ENV"] == ""       # present, so the merge overrides it


def test_env_is_a_full_environment_not_a_delta(captured_options):
    options = captured_options({
        "VIRTUAL_ENV": "/tmp/adw/.venv",
        "PATH": "/tmp/adw/.venv/bin:/usr/bin",
        "HOME": "/Users/operator",
    })
    assert options.env["HOME"] == "/Users/operator"


def test_no_venv_leaves_the_environment_untouched(captured_options):
    options = captured_options({"PATH": "/usr/local/bin:/usr/bin"})
    assert options.env["PATH"] == "/usr/local/bin:/usr/bin"
    assert "VIRTUAL_ENV" not in options.env       # nothing was dropped, nothing to blank
