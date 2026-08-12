"""agent_cursor.py — the Cursor backend: pure mappers + the NDJSON run loop.

The backend has no live model call to test, so these cover the two things that
can silently corrupt the seam: the Cursor→SSSF field mapping (usage, tool shape,
session capture) and the run() loop that reads a `result` event for usage/text
and re-emits tool_call events in pi's shape.
"""
from __future__ import annotations

import json

import pytest

from adw_modules import agent_cursor
from adw_modules.data_types import PiRequest


# ── pure mappers ──────────────────────────────────────────────────────────────

def test_model_id_strips_cursor_namespace():
    assert agent_cursor._model_id("cursor/auto") == "auto"
    assert agent_cursor._model_id("cursor/claude-opus-4-8-thinking-high") == "claude-opus-4-8-thinking-high"
    assert agent_cursor._model_id("auto") == "auto"          # passthrough, no slash


def test_compose_prompt_carries_system_prompt_in_the_prompt():
    out = agent_cursor._compose_prompt("BE A SCOUT. Emit ONLY JSON.", "find the thing")
    assert "BE A SCOUT" in out and "find the thing" in out
    assert out.index("BE A SCOUT") < out.index("find the thing")   # system leads


def test_compose_prompt_no_system_is_passthrough():
    assert agent_cursor._compose_prompt("", "just the task") == "just the task"
    assert agent_cursor._compose_prompt("   ", "just the task") == "just the task"


def test_usage_breakdown_maps_cursor_keys_and_zeroes_cost():
    usage = {"inputTokens": 100, "outputTokens": 20, "cacheReadTokens": 300, "cacheWriteTokens": 5}
    ub = agent_cursor._usage_breakdown(usage)
    assert ub.input_tokens == 100 and ub.output_tokens == 20
    assert ub.cache_read_tokens == 300 and ub.cache_write_tokens == 5
    assert ub.total_tokens == 425
    assert ub.total_cost == 0.0        # Cursor reports no cost — always 0


def test_context_tokens_sums_every_part():
    usage = {"inputTokens": 100, "outputTokens": 20, "cacheReadTokens": 300, "cacheWriteTokens": 5}
    assert agent_cursor._context_tokens(usage) == 425
    assert agent_cursor._context_tokens({}) == 0


def test_tool_of_extracts_name_and_call():
    name, call = agent_cursor._tool_of({"editToolCall": {"args": {"path": "x"}}, "toolCallId": "z"})
    assert name == "edit" and call == {"args": {"path": "x"}}
    name, call = agent_cursor._tool_of({"shellToolCall": {"args": {"command": "ls"}}})
    assert name == "shell"
    assert agent_cursor._tool_of({"nope": 1}) == ("tool", {})


def test_slim_args_drops_the_bulky_shell_parse_tree():
    args = {"command": "ls -la", "parsingResult": {"huge": "tree"},
            "simpleCommands": ["ls"], "timeout": 30000, "isBackground": False}
    slim = agent_cursor._slim_args(args)
    assert slim == {"command": "ls -la", "timeout": 30000, "isBackground": False}
    assert "parsingResult" not in slim and "simpleCommands" not in slim


def test_slim_args_clips_long_strings():
    slim = agent_cursor._slim_args({"streamContent": "x" * (agent_cursor._ARG_VALUE_CHARS + 50)})
    assert slim["streamContent"].endswith("…")
    assert len(slim["streamContent"]) == agent_cursor._ARG_VALUE_CHARS + 1


def test_result_text_reads_success_and_failure():
    assert agent_cursor._result_text({"success": {"content": "file body"}}) == (False, "file body")
    assert agent_cursor._result_text({"success": {"stdout": "out"}}) == (False, "out")
    is_error, text = agent_cursor._result_text({"failure": {"stderr": "boom"}})
    assert is_error is True and text == "boom"
    assert agent_cursor._result_text({}) == (False, "")


def test_emit_tool_start_end_translate_to_pi_shape():
    events = []
    started = {"type": "tool_call", "subtype": "started", "call_id": "c1",
               "tool_call": {"editToolCall": {"args": {"path": "f.txt", "streamContent": "hi"}}}}
    completed = {"type": "tool_call", "subtype": "completed", "call_id": "c1",
                 "tool_call": {"editToolCall": {"args": {"path": "f.txt"},
                                                "result": {"success": {"message": "wrote"}}}}}
    agent_cursor._emit_tool_start(events.append, started)
    agent_cursor._emit_tool_end(events.append, completed)
    assert events[0] == {"type": "tool_execution_start", "toolCallId": "c1",
                         "toolName": "edit", "args": {"path": "f.txt", "streamContent": "hi"}}
    assert events[1]["type"] == "tool_execution_end"
    assert events[1]["toolCallId"] == "c1" and events[1]["isError"] is False
    assert events[1]["result"]["content"][0]["text"] == "wrote"


# ── the run() loop over a scripted NDJSON stream ──────────────────────────────

class _FakeProc:
    """Minimal subprocess.Popen stand-in: yields the scripted stdout lines, and an
    ITERABLE stderr (the backend drains it line by line in a thread)."""
    def __init__(self, lines, rc=0, stderr_lines=()):
        self.pid = 4242
        self.stdout = iter(lines)
        self.stderr = iter(stderr_lines)
        self._rc = rc

    def wait(self):
        return self._rc


def _request(tmp_path):
    return PiRequest(
        prompt="do it", system_prompt="SYS", model="cursor/auto",
        session_id="sssf-abc-scout", session_dir=str(tmp_path),
        raw_output_path=str(tmp_path / "raw.jsonl"), cwd=str(tmp_path))


def _stream(session="uuid-1"):
    return [json.dumps(e) + "\n" for e in [
        {"type": "system", "subtype": "init", "session_id": session, "model": "Auto"},
        {"type": "assistant", "message": {"content": [{"type": "text", "text": "working"}]}},
        {"type": "tool_call", "subtype": "started", "call_id": "t1",
         "tool_call": {"readToolCall": {"args": {"path": "README.md"}}}},
        {"type": "tool_call", "subtype": "completed", "call_id": "t1",
         "tool_call": {"readToolCall": {"args": {"path": "README.md"},
                                        "result": {"success": {"content": "hi"}}}}},
        {"type": "result", "subtype": "success", "is_error": False,
         "result": '{"status": "success"}', "session_id": session,
         "usage": {"inputTokens": 10, "outputTokens": 2, "cacheReadTokens": 8, "cacheWriteTokens": 0}},
    ]]


def test_run_maps_result_and_forwards_tool_events(tmp_path, monkeypatch):
    agent_cursor._CURSOR_SESSIONS.clear()
    monkeypatch.setattr(agent_cursor.subprocess, "Popen",
                        lambda *a, **k: _FakeProc(_stream()))
    forwarded, spawned, exited = [], [], []
    result = agent_cursor.run(_request(tmp_path), on_event=forwarded.append,
                              on_spawn=spawned.append, on_exit=exited.append)

    assert result.text == '{"status": "success"}'      # from the result event
    assert result.tokens == 20 and result.context_tokens == 20
    assert result.cost == 0.0 and result.returncode == 0
    assert result.usage.cache_read_tokens == 8
    # session captured for --resume on the next send in this phase
    assert agent_cursor._CURSOR_SESSIONS["sssf-abc-scout"] == "uuid-1"
    # subprocess bracketed as a killable pid
    assert spawned == [4242] and exited == [4242]
    # tool_call translated to pi's start/end shape
    kinds = [e["type"] for e in forwarded]
    assert kinds == ["tool_execution_start", "tool_execution_end"]
    assert forwarded[0]["toolName"] == "read"


def test_run_resumes_a_captured_session(tmp_path, monkeypatch):
    agent_cursor._CURSOR_SESSIONS.clear()
    agent_cursor._CURSOR_SESSIONS["sssf-abc-scout"] = "prior-uuid"
    cmds = []
    monkeypatch.setattr(agent_cursor.subprocess, "Popen",
                        lambda cmd, *a, **k: cmds.append(cmd) or _FakeProc(_stream()))
    agent_cursor.run(_request(tmp_path))
    assert "--resume" in cmds[0]
    assert cmds[0][cmds[0].index("--resume") + 1] == "prior-uuid"


def test_system_prompt_composed_only_on_first_send(tmp_path, monkeypatch):
    # Fix for the "system prompt re-embedded on every correction" finding: the first
    # send (no resume) carries the composed system prompt; a resumed correction send
    # in the same phase sends ONLY the new task text (the session already has it).
    agent_cursor._CURSOR_SESSIONS.clear()
    cmds = []
    monkeypatch.setattr(agent_cursor.subprocess, "Popen",
                        lambda cmd, *a, **k: cmds.append(cmd) or _FakeProc(_stream()))

    agent_cursor.run(_request(tmp_path))              # session captured -> "uuid-1"
    first_prompt = cmds[0][-1]
    assert "--resume" not in cmds[0]
    assert "SYS" in first_prompt and "do it" in first_prompt   # system prompt embedded

    correction = PiRequest(prompt="fix your JSON", system_prompt="SYS", model="cursor/auto",
                           session_id="sssf-abc-scout", session_dir=str(tmp_path),
                           raw_output_path=str(tmp_path / "raw.jsonl"), cwd=str(tmp_path))
    agent_cursor.run(correction)                      # same session -> resumes
    second_prompt = cmds[1][-1]
    assert "--resume" in cmds[1]
    assert second_prompt == "fix your JSON"           # bare: system prompt NOT re-embedded
    assert "SYS" not in second_prompt


def test_run_drains_a_large_stderr_without_deadlock(tmp_path, monkeypatch):
    # Regression guard for the stderr-pipe-deadlock fix: a child that emits far more
    # stderr than a pipe buffer would hold must still complete, and its stderr is
    # captured for diagnostics. (The real deadlock needs OS pipes; here we assert the
    # drain-thread path consumes all of it and the run returns.)
    agent_cursor._CURSOR_SESSIONS.clear()
    noisy = [f"Shell cwd was reset to /x/{i}\n" for i in range(5000)]   # ~100KB+
    monkeypatch.setattr(agent_cursor.subprocess, "Popen",
                        lambda *a, **k: _FakeProc(_stream(), stderr_lines=noisy))
    result = agent_cursor.run(_request(tmp_path))
    assert result.text == '{"status": "success"}'    # completed, did not hang


def test_run_raises_on_error_with_no_text(tmp_path, monkeypatch):
    stream = [json.dumps({"type": "result", "is_error": True, "result": "",
                          "usage": {}}) + "\n"]
    monkeypatch.setattr(agent_cursor.subprocess, "Popen",
                        lambda *a, **k: _FakeProc(stream, rc=1, stderr_lines=["cursor blew up\n"]))
    with pytest.raises(RuntimeError, match="cursor blew up"):
        agent_cursor.run(_request(tmp_path))
