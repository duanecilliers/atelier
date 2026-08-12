"""Cursor coding agent — drives Cursor's models through the `cursor-agent` CLI.

A third coding-agent backend alongside `pi` (agent_pi.py) and `claude_code`
(agent_cc.py). Cursor's headless CLI is shaped like pi's: own the subprocess,
tail NDJSON, forward each event as it happens. So this mirrors agent_pi.run's
mechanics (Popen + line loop + on_spawn/on_exit) and agent_cc's event-translation
(re-emit Cursor's tool_call events in pi's shape so the existing ToolCallTracker
records them without a special case). Same PiRequest in, same PiResult out.

Cursor reaches its models through Cursor's own account (`cursor-agent login`, no
API key — like claude_code, unlike pi), and proxies Anthropic, OpenAI, Grok,
Kimi, and Cursor's own Composer. The engine selects it per agent via
`coding_agent: cursor` and a `cursor/<model>` pattern.

Two deliberate degradations vs pi/CC, both known and bounded:
  * No dollar cost. Cursor bills by subscription, not per call, and reports no
    cost in its stream — `total_cost` is always 0 (tokens are exact).
  * No live context-window safety valve. Cursor reports usage ONLY on the
    terminal `result` event, never per turn, so there is no mid-run occupancy to
    hard-kill against. `context_kill_threshold` is therefore inert here; the
    cooperative handoff path (a builder emitting needs_continuation) remains the
    chaining safety for cursor, exactly as agent_cc.py documents for the same
    "usage only on the terminal event" case.

There is also no `--system-prompt` flag: Cursor steers via workspace `.cursor/`
rules files, which would leak into the deterministic isolation model. So the
agent's system prompt is carried IN the prompt (_compose_prompt) — the engine's
envelope contract ("emit ONLY your Report JSON") survives this intact.
"""

from __future__ import annotations

import json
import os
import subprocess
import threading
from pathlib import Path
from typing import Callable, Optional

from .data_types import PiRequest, PiResult, UsageBreakdown
from .utils import now_iso, operator_env

CURSOR_PATH = os.environ.get("CURSOR_AGENT_PATH", "cursor-agent")

# Our synthetic session_id -> Cursor's real session uuid, so a phase's later
# sends (JSON-fix / gate corrections) resume the same context via --resume.
# Process-local, matching agent_cc._SDK_SESSIONS: a phase runs in one process.
_CURSOR_SESSIONS: dict[str, str] = {}

# Cursor's shell tool args carry a whole bash parse tree; keep only small scalar
# fields so the trace records a clean call, not a page of AST. The primary label
# fields (command/path/…) that ToolCallTracker reads survive this filter.
_ARG_DROP = {"parsingResult", "simpleCommands", "executableCommands", "redirects",
             "adminCommandDenylist", "hookAdditionalContexts"}
_ARG_VALUE_CHARS = 20_000


def _model_id(pattern: str) -> str:
    """`cursor/claude-opus-4-8-thinking-high` -> `claude-opus-4-8-thinking-high`;
    passthrough if there is no slash."""
    return pattern.split("/", 1)[1] if "/" in pattern else pattern


def _compose_prompt(system_prompt: str, prompt: str) -> str:
    """cursor-agent has no --system-prompt flag, so the agent's system prompt
    rides in the prompt. Tested clean: the engine's `_extract_json` still recovers
    the Report envelope from the tail of the response."""
    if system_prompt and system_prompt.strip():
        return f"# System instructions\n\n{system_prompt.strip()}\n\n# Task\n\n{prompt}"
    return prompt


def _usage_breakdown(usage: dict) -> UsageBreakdown:
    """Map Cursor's `result.usage` onto SSSF's UsageBreakdown. Tokens are exact;
    cost is always 0 (Cursor reports none — subscription billing)."""
    inp = usage.get("inputTokens", 0) or 0
    out = usage.get("outputTokens", 0) or 0
    cache_read = usage.get("cacheReadTokens", 0) or 0
    cache_write = usage.get("cacheWriteTokens", 0) or 0
    return UsageBreakdown(
        input_tokens=inp,
        output_tokens=out,
        cache_read_tokens=cache_read,
        cache_write_tokens=cache_write,
        total_tokens=inp + out + cache_read + cache_write,
        total_cost=0.0,
    )


def _context_tokens(usage: dict) -> int:
    """Window occupancy after the run — cached prompt counts, as everywhere."""
    return sum(usage.get(part, 0) or 0
               for part in ("inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"))


def _tool_of(tool_call: dict) -> tuple[str, dict]:
    """Cursor nests the call under a `<name>ToolCall` key (editToolCall,
    shellToolCall, readToolCall, …) beside bookkeeping fields. Return
    (`edit`/`shell`/`read`/…, the call dict with args+result)."""
    for key, value in tool_call.items():
        if key.endswith("ToolCall") and isinstance(value, dict):
            return key[: -len("ToolCall")], value
    return "tool", {}


def _slim_args(args: dict) -> dict:
    """Keep only small scalar args — drops Cursor's bulky shell parse tree so the
    trace stays readable and the label picker still finds command/path."""
    slim: dict = {}
    for key, value in (args or {}).items():
        if key in _ARG_DROP:
            continue
        if isinstance(value, str):
            slim[key] = value if len(value) <= _ARG_VALUE_CHARS else value[:_ARG_VALUE_CHARS] + "…"
        elif isinstance(value, (int, float, bool)):
            slim[key] = value
    return slim


def _result_text(result: dict) -> tuple[bool, str]:
    """(is_error, snippet) from a completed tool_call's result — {success:{…}} or
    {failure:{…}}. Prefer human-facing fields over the whole blob."""
    if not isinstance(result, dict):
        return False, ""
    failure = result.get("failure")
    if isinstance(failure, dict):
        text = failure.get("stderr") or failure.get("message") or failure.get("command") or ""
        return True, str(text)
    success = result.get("success")
    if isinstance(success, dict):
        for field in ("content", "message", "stdout", "afterFullFileContent"):
            if success.get(field):
                return False, str(success[field])
        return False, ""
    return False, ""


def run(request: PiRequest, on_event: Optional[Callable[[dict], None]] = None,
        on_spawn: Optional[Callable[[int], None]] = None,
        on_exit: Optional[Callable[[int], None]] = None) -> PiResult:
    """Run one non-interactive cursor-agent turn. Same contract as agent_pi.run.

    on_spawn/on_exit bracket the child so a hung agent is a killable pid (Cursor
    is our own subprocess, unlike the claude_code SDK). context_kill_threshold is
    accepted for interface parity but inert — see the module docstring.
    """
    model_id = _model_id(request.model)
    cmd = [
        CURSOR_PATH, "-p",
        "--output-format", "stream-json",
        "--model", model_id,
        # Headless posture identical to claude_code's bypassPermissions: no
        # interactive approval. SSSF's permissions.enforce() still does the
        # after-the-fact write-boundary check on the git tree, so the determinism
        # spine is unchanged.
        "--force", "--sandbox", "disabled", "--trust",
        "--workspace", request.cwd,
    ]
    resume = _CURSOR_SESSIONS.get(request.session_id)
    if resume:
        # A JSON-fix / gate-correction send resumes the session, which ALREADY
        # carries the system instructions from the first send - so send only the
        # new task text. Re-embedding the whole system prompt each correction
        # would just re-bill it (cursor has no separate system-prompt channel).
        cmd += ["--resume", resume]
        prompt = request.prompt
    else:
        prompt = _compose_prompt(request.system_prompt, request.prompt)
    cmd.append(prompt)

    raw_path = Path(request.raw_output_path)
    raw_path.parent.mkdir(parents=True, exist_ok=True)

    result = PiResult(session_id=request.session_id)  # context_window unknown -> 0

    # stdin=DEVNULL for the same reason agent_pi documents: the prompt travels in
    # argv, and an inherited non-TTY stdin can make the child block forever.
    process = subprocess.Popen(cmd, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, bufsize=1, cwd=request.cwd,
                               env=operator_env())
    if on_spawn:
        on_spawn(process.pid)

    # Drain stderr concurrently. cursor-agent narrates on stderr as it works (e.g.
    # a "Shell cwd was reset to …" line per shell tool call), so on a long,
    # shell-heavy build its stderr can exceed the OS pipe buffer (~64KB). If we
    # only read stdout in the loop below and left stderr unread until after EOF,
    # a full stderr pipe would block the child's writes - stalling its stdout too -
    # and the stdout loop would hang forever waiting on bytes that never come. A
    # daemon thread reads stderr to EOF in lockstep, so neither pipe ever fills.
    # This is exactly the deadlock agent_pi's valve path documents avoiding.
    stderr_chunks: list[str] = []

    def _drain_stderr() -> None:
        assert process.stderr is not None
        for err_line in process.stderr:
            stderr_chunks.append(err_line)

    stderr_thread = threading.Thread(target=_drain_stderr, daemon=True)
    stderr_thread.start()

    text_parts: list[str] = []
    with raw_path.open("a") as raw:
        assert process.stdout is not None
        for line in process.stdout:
            raw.write(line)
            raw.flush()                      # events land on disk as they happen
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            etype = event.get("type")

            if etype == "system" and event.get("subtype") == "init":
                sid = event.get("session_id")
                if sid:
                    _CURSOR_SESSIONS[request.session_id] = sid

            elif etype == "assistant":
                for block in event.get("message", {}).get("content", []) or []:
                    if isinstance(block, dict) and block.get("type") == "text":
                        text_parts.append(block.get("text", ""))

            elif etype == "tool_call":
                subtype = event.get("subtype")
                if subtype == "started":
                    _emit_tool_start(on_event, event)
                elif subtype == "completed":
                    _emit_tool_end(on_event, event)

            elif etype == "result":
                sid = event.get("session_id")
                if sid:
                    _CURSOR_SESSIONS[request.session_id] = sid
                usage = event.get("usage", {}) or {}
                result.usage = _usage_breakdown(usage)
                result.tokens = result.usage.total_tokens
                result.context_tokens = _context_tokens(usage)
                result.cost = 0.0
                # `result.result` is Cursor's aggregated assistant text — cleaner
                # than the streamed deltas, and what the envelope parser reads.
                if event.get("result"):
                    result.text = str(event["result"])
                if event.get("is_error"):
                    result.returncode = 1

    rc = process.wait()
    stderr_thread.join(timeout=5)         # stderr hits EOF once the child exits
    stderr = "".join(stderr_chunks)
    if result.returncode == 0 and rc != 0:
        result.returncode = rc            # a crash with no result event still fails
    if on_exit:
        on_exit(process.pid)

    if not result.text and text_parts:
        result.text = "".join(text_parts)  # fallback if no result event carried text
    if result.returncode != 0 and not result.text:
        raise RuntimeError(f"cursor-agent exited {result.returncode} for model "
                           f"{model_id!r}: {stderr.strip()[-800:]}")
    return result


def _emit_tool_start(on_event, event) -> None:
    if on_event is None:
        return
    name, call = _tool_of(event.get("tool_call", {}) or {})
    on_event({
        "type": "tool_execution_start",
        "toolCallId": str(event.get("call_id") or ""),
        "toolName": name,
        "args": _slim_args(call.get("args", {}) or {}),
    })


def _emit_tool_end(on_event, event) -> None:
    if on_event is None:
        return
    name, call = _tool_of(event.get("tool_call", {}) or {})
    is_error, snippet = _result_text(call.get("result", {}) or {})
    on_event({
        "type": "tool_execution_end",
        "toolCallId": str(event.get("call_id") or ""),
        "toolName": name,
        "args": _slim_args(call.get("args", {}) or {}),
        "isError": is_error,
        "result": {"content": [{"type": "text", "text": snippet}]},
    })
