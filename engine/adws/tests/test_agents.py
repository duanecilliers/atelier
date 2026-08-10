"""agents.py - config loading (tmp yaml) + JSON extraction (pure).

The load-bearing invariant is the anthropic force-routing: any anthropic/* model
must run through claude_code, applied AFTER the defaults merge so an inherited
model is caught too. A mis-route fails only at dispatch, so pin it here.
"""
from __future__ import annotations

import textwrap

import pytest

from adw_modules import agents


def _cfg(tmp_path, text: str) -> str:
    p = tmp_path / "c.yaml"
    p.write_text(textwrap.dedent(text))
    return str(p)


def _by_name(cfg, name):
    return next(a for a in cfg.agents if a.name == name)


def test_explicit_anthropic_pi_is_forced_to_claude_code(tmp_path):
    cfg = agents.load_config(_cfg(tmp_path, """
        defaults: {coding_agent: pi, model: openai-codex/x}
        agents:
          - name: planner
            coding_agent: pi
            model: anthropic/claude-fable-5
            prompt_engineering: {system: s.md, user: u.md}
    """))
    assert _by_name(cfg, "planner").coding_agent == "claude_code"


def test_inherited_anthropic_model_also_forced(tmp_path):
    cfg = agents.load_config(_cfg(tmp_path, """
        defaults: {coding_agent: pi, model: anthropic/claude-sonnet-5}
        agents:
          - name: scout
            prompt_engineering: {system: s.md, user: u.md}
    """))
    scout = _by_name(cfg, "scout")
    assert scout.model == "anthropic/claude-sonnet-5"  # inherited from defaults
    assert scout.coding_agent == "claude_code"         # forced despite defaults: pi


def test_non_anthropic_stays_pi(tmp_path):
    cfg = agents.load_config(_cfg(tmp_path, """
        defaults: {coding_agent: pi, model: openai-codex/x}
        agents:
          - name: builder
            model: openai-codex/gpt-5.6
            prompt_engineering: {system: s.md, user: u.md}
    """))
    assert _by_name(cfg, "builder").coding_agent == "pi"


class TestExtractJson:
    def test_fenced_block(self):
        assert agents._extract_json('pre\n```json\n{"a": 1}\n```\npost') == {"a": 1}

    def test_bare_object(self):
        assert agents._extract_json('{"x": 2}') == {"x": 2}

    def test_brace_span_in_prose(self):
        assert agents._extract_json('here it is {"y": 3} thanks') == {"y": 3}

    def test_no_json_raises(self):
        with pytest.raises(ValueError):
            agents._extract_json("no json at all")
