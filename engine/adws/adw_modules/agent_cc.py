"""Claude coding agent — drives Claude models through the Claude Agent SDK.

This is D1 from the Atelier plan made real: a second coding-agent backend that
runs Claude models via `claude-agent-sdk`, which shells out to the local Claude
Code binary. That matters because it uses Claude Code's OWN auth — so Anthropic
models work here even when pi's Anthropic OAuth is dead. GPT models stay on pi;
the engine picks the backend per agent via `coding_agent:` in the config.

It mirrors `agent_pi.run` exactly — same PiRequest in, same PiResult out, same
`on_event`/`on_spawn`/`on_exit` callbacks — so `agents.execute()` treats both
backends identically. Tool calls are re-emitted in pi's own event shape so the
existing ToolCallTracker/forwarder records them without a special case.

The SDK is async; `run()` wraps one turn in `asyncio.run`, matching the
synchronous call site in agents.py. Retries/gate-corrections within a phase reuse
the same context by resuming the SDK session captured from the first turn.
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
from pathlib import Path
from typing import Callable, Optional

from . import agent_pi
from .data_types import PiRequest, PiResult, UsageBreakdown
from .utils import operator_env_overrides

# pi tool name -> Claude Code tool name. Claude Code has no separate list tool
# (Bash/Glob cover it); the subagent_* pi extension tools have no CC equivalent
# and are dropped — CC has its own Task mechanism.
TOOL_MAP = {
    "read": "Read",
    "bash": "Bash",
    "edit": "Edit",
    "write": "Write",
    "grep": "Grep",
    "find": "Glob",
    "ls": "Bash",
}

# Our synthetic session_id -> the SDK's real session uuid, so a phase's later
# sends (JSON-fix / gate corrections) resume the same context. Process-local:
# a fresh ADW process starts fresh, which is fine — a phase runs in one process.
_SDK_SESSIONS: dict[str, str] = {}


def _model_id(pattern: str) -> str:
    """`anthropic/claude-haiku-4-5` -> `claude-haiku-4-5`; passthrough if no slash."""
    return pattern.split("/", 1)[1] if "/" in pattern else pattern


def _cc_tools(tools: Optional[list[str]]) -> Optional[list[str]]:
    """Map pi tool names to Claude Code tool names; None stays None (all tools)."""
    if tools is None:
        return None
    mapped: list[str] = []
    for tool in tools:
        cc = TOOL_MAP.get(tool)
        if cc and cc not in mapped:
            mapped.append(cc)
    return mapped


def _text_blocks(content) -> str:
    """Join the text of anything the SDK shapes as a content list."""
    if isinstance(content, str):
        return content
    out = []
    for block in content or []:
        if isinstance(block, dict):
            if block.get("type") == "text":
                out.append(block.get("text", ""))
        elif hasattr(block, "text"):
            out.append(block.text)
    return "".join(out)


def _usage_breakdown(usage: dict, total_cost: float) -> UsageBreakdown:
    """Map the SDK's usage dict onto SSSF's UsageBreakdown.

    The SDK reports only a total cost, not a per-component split, so the token
    counts are exact and total_cost carries the dollars. cache_creation is the
    SDK's name for a cache WRITE (material read for the first time); cache_read is
    a re-read — the same read/written split the cockpit derives downstream.
    """
    inp = usage.get("input_tokens", 0) or 0
    out = usage.get("output_tokens", 0) or 0
    cache_read = usage.get("cache_read_input_tokens", 0) or 0
    cache_write = usage.get("cache_creation_input_tokens", 0) or 0
    return UsageBreakdown(
        input_tokens=inp,
        output_tokens=out,
        cache_read_tokens=cache_read,
        cache_write_tokens=cache_write,
        total_tokens=inp + out + cache_read + cache_write,
        total_cost=total_cost or 0.0,
    )


def _context_tokens(usage: dict) -> int:
    """Window occupancy after the turn — every part counts, cached prompt included."""
    return sum(
        usage.get(part, 0) or 0
        for part in ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")
    )


def run(request: PiRequest, on_event: Optional[Callable[[dict], None]] = None,
        on_spawn: Optional[Callable[[int], None]] = None,
        on_exit: Optional[Callable[[int], None]] = None) -> PiResult:
    """Run one non-interactive Claude turn. Same contract as agent_pi.run.

    on_spawn/on_exit are accepted for interface parity but not called: the SDK
    owns the claude subprocess and does not expose its pid, and reusing this
    process's pid would collide with the ADW's own `processes` row.
    """
    return asyncio.run(_run_async(request, on_event))


async def _run_async(request: PiRequest, on_event: Optional[Callable[[dict], None]]) -> PiResult:
    # Imported lazily so an all-pi roster never pays the SDK import cost.
    from claude_agent_sdk import query, ClaudeAgentOptions

    model_id = _model_id(request.model)
    kwargs = {
        "model": model_id,
        "system_prompt": request.system_prompt,
        "cwd": request.cwd,
        # Headless: no interactive approval. SSSF's permissions.enforce() still
        # does the after-the-fact write-boundary check on the git tree, so a
        # bypassed CC write outside the allowlist is rolled back and fails the
        # phase — the determinism spine is unchanged.
        "permission_mode": "bypassPermissions",
        # Deterministic: no ambient CLAUDE.md / project skills leaking in.
        "setting_sources": [],
        # The operator's own environment, same as every other spawn site: an
        # agent's Bash must resolve the `python3`/`pip`/global CLIs the engineer
        # gets, not the ADW's `uv run` venv. v0.8.0 made this sharper - every
        # agent's system prompt now names the project's check commands, so a
        # claude_code agent runs the verify gate's own argv and must resolve it
        # the way the gate does. Overrides, not a replacement: the SDK merges
        # this over os.environ. See utils.operator_env_overrides.
        "env": operator_env_overrides(),
    }
    tools = _cc_tools(request.tools)
    if tools is not None:
        kwargs["allowed_tools"] = tools
    resume = _SDK_SESSIONS.get(request.session_id)
    if resume:
        kwargs["resume"] = resume

    # Only pass options this SDK version actually accepts — guards against field
    # renames across SDK releases rather than crashing on an unknown kwarg.
    valid = {f.name for f in dataclasses.fields(ClaudeAgentOptions)}
    dropped = [k for k in kwargs if k not in valid]
    options = ClaudeAgentOptions(**{k: v for k, v in kwargs.items() if k in valid})

    result = PiResult(session_id=request.session_id)
    # Known up front so the safety valve has a ceiling to measure occupancy against
    # (0 = unknown -> no valve; the cooperative handoff path still works). Mirrors
    # agent_pi.run. See ContinuationConfig.
    result.context_window = agent_pi.context_window("anthropic", model_id)
    ceiling = (int(request.context_kill_threshold * result.context_window)
               if request.context_kill_threshold and result.context_window else 0)
    raw_path = Path(request.raw_output_path)
    raw_path.parent.mkdir(parents=True, exist_ok=True)

    text_parts: list[str] = []
    last_usage: dict = {}
    valve_fired = False
    raw = raw_path.open("a")
    if dropped:
        raw.write(json.dumps({"type": "note", "dropped_options": dropped}) + "\n")
    try:
        async for message in query(prompt=request.prompt, options=options):
            cls = type(message).__name__
            _write_raw(raw, cls, message)

            if cls == "AssistantMessage":
                for block in getattr(message, "content", None) or []:
                    if hasattr(block, "text"):
                        text_parts.append(block.text)  # last assistant text wins overall
                    elif hasattr(block, "name") and hasattr(block, "input"):  # ToolUseBlock
                        _emit_tool_start(on_event, block)
                usage = getattr(message, "usage", None)
                if usage:
                    last_usage = usage
                    # Safety valve: the SDK owns the agentic loop's turn boundaries,
                    # so the only clean interrupt is to stop consuming it once
                    # occupancy crosses the ceiling. Breaking closes the query
                    # generator (the SDK tears down its claude subprocess); edits
                    # already written to disk survive. The engine reads overflowed
                    # and continues from a synthesized handoff.
                    #
                    # NB: this depends on the SDK attaching per-turn usage to each
                    # AssistantMessage (the same assumption `last_usage` already relies
                    # on for the ResultMessage fallback). If a future SDK reports usage
                    # ONLY on the terminal ResultMessage, `usage` here is None every
                    # turn, this check never runs, and the valve is silently inactive
                    # for claude_code - the cooperative handoff path (the builder
                    # emitting needs_continuation) remains the primary safety for CC,
                    # and the pi backend keeps its own valve either way.
                    if ceiling and _context_tokens(usage) >= ceiling:
                        valve_fired = True
                        break

            elif cls == "UserMessage":
                for block in getattr(message, "content", None) or []:
                    if hasattr(block, "tool_use_id"):  # ToolResultBlock
                        _emit_tool_end(on_event, block)

            elif cls == "ResultMessage":
                sid = getattr(message, "session_id", None)
                if sid:
                    _SDK_SESSIONS[request.session_id] = sid
                cost = getattr(message, "total_cost_usd", None) or 0.0
                usage = getattr(message, "usage", None) or last_usage or {}
                result.usage = _usage_breakdown(usage, cost)
                result.cost = cost
                result.tokens = result.usage.total_tokens
                result.context_tokens = _context_tokens(usage)
                if getattr(message, "subtype", "success") != "success":
                    result.returncode = 1
    finally:
        raw.close()

    # The valve breaks before the ResultMessage, so fold in the last turn's usage by
    # hand - the partial work still needs its occupancy and token counts recorded.
    # Cost is the exception: the SDK reports dollars ONLY on the ResultMessage
    # (total_cost_usd), which the break skips, so a valve-killed CC instance records
    # its exact tokens with cost 0. The tokens are what bound the chain; the missing
    # cents are a known, minor undercount for hard-killed Anthropic instances only.
    if valve_fired:
        result.overflowed = True
        result.returncode = 1
        if last_usage:
            result.usage = _usage_breakdown(last_usage, result.cost)
            result.tokens = result.usage.total_tokens
            result.context_tokens = _context_tokens(last_usage)

    result.text = "".join(text_parts)
    # A valve kill is the salvage path, not a failure - it must not raise even with
    # no assistant text; the engine synthesizes a handoff from git and continues.
    if result.returncode != 0 and not result.text and not result.overflowed:
        raise RuntimeError(
            f"claude-agent-sdk turn did not succeed for model {model_id!r} "
            f"(no assistant text; ResultMessage.subtype != success)")
    return result


def _write_raw(raw, cls: str, message) -> None:
    """Best-effort JSONL record of the SDK stream, beside pi's raw_output.jsonl."""
    record: dict = {"type": cls}
    if cls == "AssistantMessage":
        record["text"] = _text_blocks(getattr(message, "content", None))
    elif cls == "ResultMessage":
        for field in ("session_id", "subtype", "total_cost_usd", "num_turns", "duration_ms"):
            record[field] = getattr(message, field, None)
        record["usage"] = getattr(message, "usage", None)
    raw.write(json.dumps(record, default=str) + "\n")
    raw.flush()


def _emit_tool_start(on_event, block) -> None:
    if on_event is None:
        return
    on_event({
        "type": "tool_execution_start",
        "toolCallId": getattr(block, "id", ""),
        "toolName": getattr(block, "name", ""),
        "args": getattr(block, "input", {}) or {},
    })


def _emit_tool_end(on_event, block) -> None:
    if on_event is None:
        return
    on_event({
        "type": "tool_execution_end",
        "toolCallId": getattr(block, "tool_use_id", ""),
        # toolName/args fall back to the matching start event inside the tracker.
        "isError": bool(getattr(block, "is_error", False)),
        "result": {"content": [{"type": "text", "text": _text_blocks(getattr(block, "content", ""))}]},
    })
