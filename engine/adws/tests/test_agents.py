"""agents.py - config loading (tmp yaml) + JSON extraction (pure).

The load-bearing invariant is the anthropic force-routing: any anthropic/* model
must run through claude_code, applied AFTER the defaults merge so an inherited
model is caught too. A mis-route fails only at dispatch, so pin it here.
"""
from __future__ import annotations

import textwrap
from types import SimpleNamespace

import pytest

from adw_modules import agents
from adw_modules.data_types import (AgentConfig, BuildOutput, ContinuationConfig,
                                    PromptEngineering)


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


def test_cursor_backend_is_not_forced(tmp_path):
    # cursor owns its own namespace, so the anthropic/* -> claude_code forcing must
    # leave a cursor agent alone (a cursor/ model never trips the anthropic check).
    cfg = agents.load_config(_cfg(tmp_path, """
        defaults: {coding_agent: pi, model: openai-codex/x}
        agents:
          - name: scout
            coding_agent: cursor
            model: cursor/auto
            prompt_engineering: {system: s.md, user: u.md}
    """))
    scout = _by_name(cfg, "scout")
    assert scout.coding_agent == "cursor" and scout.model == "cursor/auto"


def test_validate_rejects_non_cursor_model_on_cursor_backend(tmp_path):
    # Symmetry with the claude_code -> anthropic/ check: a cursor agent must name a
    # cursor/ model, or the namespace guarantee is meaningless. A NON-anthropic
    # model is used on purpose: anthropic/* is force-rerouted to claude_code at
    # load (test_anthropic_beats_cursor covers that), so it never reaches this guard.
    prompts = tmp_path / "s.md"; prompts.write_text("x")
    cfg = agents.load_config(_cfg(tmp_path, f"""
        defaults: {{coding_agent: pi, model: openai-codex/x}}
        agents:
          - name: scout
            coding_agent: cursor
            model: openai/gpt-5
            prompt_engineering: {{system: {prompts}, user: {prompts}}}
    """))
    with pytest.raises(SystemExit, match="cursor expects a cursor/ model"):
        agents.validate(cfg, ["scout"])


def test_anthropic_beats_cursor(tmp_path):
    # "Anthropic is always claude_code" wins even over an explicit coding_agent:
    # cursor — to reach Claude through Cursor, name a cursor/ model, not anthropic/*.
    cfg = agents.load_config(_cfg(tmp_path, """
        defaults: {coding_agent: pi, model: openai-codex/x}
        agents:
          - name: scout
            coding_agent: cursor
            model: anthropic/claude-haiku-4-5
            prompt_engineering: {system: s.md, user: u.md}
    """))
    assert _by_name(cfg, "scout").coding_agent == "claude_code"


# ── the chained builder (context-window handoff) ─────────────────────────────

def _fake_run(agent_map=None):
    """A run stub with only what _chain / _instance_session_id / _synthesize touch."""
    return SimpleNamespace(
        adw_id="abc12345",
        agent_map=agent_map or {},
        repo_root="/tmp/repo",
        console=SimpleNamespace(note=lambda *a, **k: None),
        tracer=SimpleNamespace(event=lambda *a, **k: None),
    )


_PHASE = SimpleNamespace(phase_id="abc12345_02_build")


class _Instances:
    """Scripted run_instance: yields (envelope, result) per instance, in order,
    and records the (prompt, instance) it was called with each time."""

    def __init__(self, script):
        self.script = script            # list of (envelope_or_None, overflowed_bool)
        self.calls: list[tuple[str, int]] = []

    def __call__(self, prompt, instance):
        self.calls.append((prompt, instance))
        envelope, overflowed = self.script[instance - 1]
        return envelope, SimpleNamespace(overflowed=overflowed)


def _build(**kw):
    return BuildOutput(status=kw.pop("status", "success"), **kw)


class TestChain:
    def test_completes_first_instance_no_chaining(self):
        env = _build(continuation="complete")
        inst = _Instances([(env, False)])
        synth = SimpleNamespace(n=0)
        out = agents._chain(_fake_run(), _PHASE, ContinuationConfig(),
                            "do the thing", inst, lambda: (synth.__setattr__("n", synth.n + 1), "S")[1])
        assert out is env
        assert len(inst.calls) == 1          # never chained
        assert synth.n == 0                  # never synthesized

    def test_cooperative_handoff_threads_into_next_prompt(self):
        inst = _Instances([
            (_build(continuation="needs_continuation", handoff="DID_A_NEED_B"), False),
            (_build(continuation="complete"), False),
        ])
        out = agents._chain(_fake_run(), _PHASE, ContinuationConfig(),
                            "ORIGINAL_TASK", inst, lambda: "SHOULD_NOT_BE_USED")
        assert out.continuation == "complete"
        assert len(inst.calls) == 2
        second_prompt = inst.calls[1][0]
        assert "DID_A_NEED_B" in second_prompt          # the agent's handoff
        assert "ORIGINAL_TASK" in second_prompt         # plus the original task
        assert "already applied" in second_prompt.lower()  # the standing continue note

    def test_valve_overflow_synthesizes_a_handoff(self):
        # A valve-killed instance returns (None, overflowed=True) - no cooperative
        # envelope - so the backstop (git-diff) handoff must be synthesized instead.
        inst = _Instances([(None, True), (_build(continuation="complete"), False)])
        calls = {"n": 0}

        def synth():
            calls["n"] += 1
            return "SYNTHESIZED_FROM_GIT"

        out = agents._chain(_fake_run(), _PHASE, ContinuationConfig(),
                            "ORIGINAL_TASK", inst, synth)
        assert out.continuation == "complete"
        assert calls["n"] == 1
        assert "SYNTHESIZED_FROM_GIT" in inst.calls[1][0]

    def test_empty_cooperative_handoff_falls_back_to_synth(self):
        inst = _Instances([
            (_build(continuation="needs_continuation", handoff="   "), False),
            (_build(continuation="complete"), False),
        ])
        out = agents._chain(_fake_run(), _PHASE, ContinuationConfig(),
                            "T", inst, lambda: "SYNTH_FALLBACK")
        assert "SYNTH_FALLBACK" in inst.calls[1][0]
        assert out.continuation == "complete"

    def test_cap_enforced_fails_loudly(self):
        never_done = [(_build(continuation="needs_continuation", handoff="h"), False)] * 3
        inst = _Instances(never_done)
        with pytest.raises(RuntimeError, match="after 3 instance"):
            agents._chain(_fake_run(), _PHASE, ContinuationConfig(max_instances=3),
                          "T", inst, lambda: "S")
        assert len(inst.calls) == 3          # exactly the cap, no fourth instance

    def test_fail_status_ends_chain_immediately(self):
        # A genuine failure (status=fail, not asking to continue) is terminal -
        # _chain returns it and execute() rules on the status.
        env = _build(status="fail", continuation="complete")
        inst = _Instances([(env, False)])
        out = agents._chain(_fake_run(), _PHASE, ContinuationConfig(), "T", inst, lambda: "S")
        assert out is env
        assert len(inst.calls) == 1


class TestInstanceSessionId:
    def _agent(self):
        return AgentConfig(name="builder", model="anthropic/claude-x",
                           prompt_engineering=PromptEngineering(system="s.md", user="u.md"))

    def test_instance_one_reuses_the_cross_phase_session(self):
        agent = self._agent()
        run = _fake_run(agent_map={"builder": {"session_id": "SESS-REUSE",
                                               "model": "anthropic/claude-x"}})
        assert agents._instance_session_id(run, agent, 1) == "SESS-REUSE"

    def test_later_instances_get_fresh_windows(self):
        agent = self._agent()
        run = _fake_run(agent_map={"builder": {"session_id": "SESS-REUSE",
                                               "model": "anthropic/claude-x"}})
        s2 = agents._instance_session_id(run, agent, 2)
        s3 = agents._instance_session_id(run, agent, 3)
        # a fresh session is an empty window - the whole point - so never the reused one
        assert s2 != "SESS-REUSE" and s3 != "SESS-REUSE"
        assert s2 != s3
        assert s2.startswith("sssf-abc12345-builder-")


class TestContinuationSeed:
    def test_seed_carries_task_handoff_and_note(self):
        seed = agents._continuation_seed("ORIGINAL", "HANDOFF_BODY")
        assert "ORIGINAL" in seed
        assert "HANDOFF_BODY" in seed
        assert "git diff" in seed              # the standing continue instruction


class TestSynthesizeHandoff:
    def _fake_git(self, diff="", untracked=""):
        # _synthesize_handoff calls git_helper._git_at(root, "diff"|"ls-files", ...).
        def _git_at(root, *args):
            return diff if args[0] == "diff" else untracked
        return _git_at

    def test_reports_diff_and_untracked(self, monkeypatch):
        monkeypatch.setattr(agents.git_helper, "_git_at",
                            self._fake_git(diff="@@ -1 +1 @@\n-a\n+b", untracked="new_file.py"))
        out = agents._synthesize_handoff(_fake_run())
        assert "new_file.py" in out
        assert "+b" in out
        assert "git diff HEAD" in out

    def test_no_changes_says_so(self, monkeypatch):
        monkeypatch.setattr(agents.git_helper, "_git_at", self._fake_git())
        out = agents._synthesize_handoff(_fake_run())
        assert "no changes" in out.lower()


class TestRunInstanceOverflow:
    """The safety valve can fire on ANY send within an instance, not just the
    first: a gate correction re-enters the same session and can tip it over the
    ceiling. _run_instance must salvage that (return a None envelope) rather than
    let the overflowed, unparseable turn hard-fail the phase."""

    def _stub_run(self, tmp_path):
        from unittest.mock import MagicMock
        run = MagicMock()
        run.adw_id = "abc12345"
        run.repo_root = str(tmp_path)
        run.context_handoff_dir = tmp_path
        run.session_dir = tmp_path
        return run

    def _agent(self):
        return AgentConfig(name="builder", coding_agent="pi", model="openai-codex/x",
                           prompt_engineering=PromptEngineering(system="s.md", user="u.md"))

    def test_overflow_on_gate_correction_send_is_salvaged(self, tmp_path, monkeypatch):
        from adw_modules.data_types import AgentCall, GateReport, PiResult

        # Render/persist/guidance are irrelevant to the control flow under test.
        monkeypatch.setattr(agents.prompts, "render", lambda *a, **k: "")
        monkeypatch.setattr(agents.prompts, "save", lambda *a, **k: None)
        monkeypatch.setattr(agents, "project_guidance", lambda root: None)

        # Two backend turns: (1) valid JSON that a gate will reject, forcing a
        # correction send; (2) the correction turn gets valve-killed (overflowed).
        turns = iter([
            PiResult(text='{"status": "success", "changed_files": []}', overflowed=False),
            PiResult(text="", overflowed=True, context_tokens=5000, context_window=272000),
        ])
        monkeypatch.setattr(agents.agent_pi, "run",
                            lambda request, **kw: next(turns))

        failing_gate = lambda envelope, run: GateReport().check("x", False, "nope")
        call = AgentCall(output_type=BuildOutput, prompt="task", gates=[failing_gate])
        phase = SimpleNamespace(phase_id="p", params=SimpleNamespace(retries=1), attempt=0)

        envelope, result = agents._run_instance(
            self._stub_run(tmp_path), phase, self._agent(), call, tmp_path,
            "task", "sess-1", 0.8, 1, tree_before=object())

        # Salvaged: None envelope + the overflowed result, so the chain continues
        # instead of the phase hard-failing on an unparseable correction turn.
        assert envelope is None
        assert result.overflowed is True

    def test_backend_dispatch_selects_by_coding_agent(self, tmp_path, monkeypatch):
        # send() routes to the backend named by agent.coding_agent:
        #   {"claude_code": agent_cc, "cursor": agent_cursor}.get(x, agent_pi)
        # Prove a `cursor` agent reaches agent_cursor.run (and NOT agent_pi/agent_cc),
        # and that the default falls through to agent_pi - the seam this whole feature
        # hangs on, otherwise covered only by a live run.
        from adw_modules.data_types import AgentCall, GenericOutput, PiResult

        monkeypatch.setattr(agents.prompts, "render", lambda *a, **k: "")
        monkeypatch.setattr(agents.prompts, "save", lambda *a, **k: None)
        monkeypatch.setattr(agents, "project_guidance", lambda root: None)
        monkeypatch.setattr(agents.permissions, "enforce", lambda *a, **k: [])
        monkeypatch.setattr(agents, "_persist_envelope", lambda *a, **k: None)

        called: list[str] = []
        ok = PiResult(text='{"status": "success"}')
        monkeypatch.setattr(agents.agent_cursor, "run", lambda request, **kw: called.append("cursor") or ok)
        monkeypatch.setattr(agents.agent_cc, "run", lambda request, **kw: called.append("cc") or ok)
        monkeypatch.setattr(agents.agent_pi, "run", lambda request, **kw: called.append("pi") or ok)

        call = AgentCall(output_type=GenericOutput, prompt="task")
        phase = SimpleNamespace(phase_id="p", params=SimpleNamespace(retries=1), attempt=0)

        def run_once(coding_agent: str, model: str) -> None:
            called.clear()
            agent = AgentConfig(name="a", coding_agent=coding_agent, model=model,
                                prompt_engineering=PromptEngineering(system="s.md", user="u.md"))
            agents._run_instance(self._stub_run(tmp_path), phase, agent, call, tmp_path,
                                 "task", "sess-1", None, 1, tree_before=object())

        run_once("cursor", "cursor/auto")
        assert called == ["cursor"]
        run_once("pi", "openai-codex/x")        # default fall-through
        assert called == ["pi"]
        run_once("claude_code", "anthropic/claude-haiku-4-5")
        assert called == ["cc"]


class TestRenderVariables:
    """Prompts a fan-out's parallel identities share must be able to write to a
    per-name artifact, so the invoking agent's name reaches the template."""

    def test_agent_name_is_a_render_variable(self, tmp_path, monkeypatch):
        from adw_modules.data_types import AgentCall, GenericOutput, PiResult

        seen: dict = {}
        # Capture the variables dict handed to render (system is rendered first).
        monkeypatch.setattr(agents.prompts, "render",
                            lambda path, variables: seen.update(variables) or "")
        monkeypatch.setattr(agents.prompts, "save", lambda *a, **k: None)
        monkeypatch.setattr(agents, "project_guidance", lambda root: None)
        monkeypatch.setattr(agents.permissions, "enforce", lambda *a, **k: [])
        monkeypatch.setattr(agents, "_persist_envelope", lambda *a, **k: None)
        monkeypatch.setattr(agents.agent_pi, "run",
                            lambda request, **kw: PiResult(text='{"status": "success"}'))

        run = TestRunInstanceOverflow._stub_run(self, tmp_path)
        agent = AgentConfig(name="pr_reviewer_2", coding_agent="pi", model="openai-codex/x",
                            prompt_engineering=PromptEngineering(system="s.md", user="u.md"))
        call = AgentCall(output_type=GenericOutput, prompt="task")
        phase = SimpleNamespace(phase_id="p", params=SimpleNamespace(retries=1), attempt=0)
        agents._run_instance(run, phase, agent, call, tmp_path, "task", "sess-1",
                             None, 1, tree_before=object())

        assert seen.get("agent_name") == "pr_reviewer_2"


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
