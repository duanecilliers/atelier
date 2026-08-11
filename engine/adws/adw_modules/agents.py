"""Config loading/validation and agent execution.

Every ADW validates its agents before running (fail fast, nothing spawns
against a half-valid config). Every agent call parses against a concrete
output type; parse failures and gate violations re-prompt the SAME session
with a correction — context intact, bounded retries. Agent proposes, code
disposes.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

import yaml

from . import agent_cc, agent_pi, git_helper, permissions, prompts
from .data_types import (AgentCall, AgentConfig, BuildOutput, EnvelopeBase,
                         EventRecord, GateCheck, GateReport, Phase, PiRequest,
                         SSSFConfig, UsageBreakdown)
from .utils import new_id, resolve_trace_path

JSON_FIX_ATTEMPTS = 2      # continue-with-correction attempts for malformed JSON
_SYNTH_DIFF_CHARS = 12_000  # cap on the git-diff backstop handoff (agents.execute)


class GateFailure(RuntimeError):
    pass


class _ContextOverflow(Exception):
    """Raised inside an instance the moment the safety valve hard-kills a send -
    on the first send OR any JSON-fix/gate-correction send. Caught in
    _run_instance, which hands the caller a None envelope so the chain synthesizes
    a handoff and continues with a fresh instance. Only raised when chaining is
    active; a non-chaining overflow falls through to the normal parse."""


# ── config ───────────────────────────────────────────────────────────────────

def load_config(path: str = "adws/adw_sssf_config/sssf.config.yaml") -> SSSFConfig:
    raw = yaml.safe_load(Path(path).read_text()) or {}
    defaults = raw.get("defaults", {}) or {}
    for agent in raw.get("agents", []) or []:
        for key in ("coding_agent", "model", "thinking", "color", "tools", "writes"):
            if key in defaults:
                agent.setdefault(key, defaults[key])
        agent.setdefault("harness_engineering", defaults.get("harness_engineering", []))
        # pi no longer supports Anthropic, so an anthropic/* model can ONLY run
        # through the Claude Agent SDK (claude_code, which uses the local `claude`
        # CLI's own login — no key). Enforce it here, after the defaults merge so it
        # also catches agents that inherit an anthropic model: no roster — not even
        # a stale `coding_agent: pi` — can mis-route Anthropic to a backend that
        # would fail at dispatch.
        if str(agent.get("model", "")).startswith("anthropic/"):
            agent["coding_agent"] = "claude_code"
    return SSSFConfig(**raw)


# Project guidance injected into a claude_code agent's system prompt, so an agent
# working in a STAMPED repo sees that project's own conventions. The Claude SDK
# runs in isolation mode (agent_cc.py sets setting_sources: [] — no ambient
# CLAUDE.md/skills), so this is the single, engine-controlled channel: it's
# deterministic and leaks nothing but the one file we pick. AGENTS.md is the
# canonical cross-tool file; CLAUDE.md is the fallback (it usually just @imports
# AGENTS.md, so reading AGENTS.md directly beats injecting an unresolved import).
# pi discovers these natively from cwd, so its agents need no injection.
_GUIDANCE_FILES = ("AGENTS.md", "CLAUDE.md")


def project_guidance(repo_root: str | Path) -> str | None:
    """The repo-root guidance file's content under a header, or None when neither
    AGENTS.md nor CLAUDE.md is present or readable (or it's empty)."""
    for name in _GUIDANCE_FILES:
        path = Path(repo_root) / name
        if path.is_file():
            try:
                text = path.read_text().strip()
            except OSError:
                return None
            return f"# Project guidance — {name}\n\n{text}" if text else None
    return None


def resolve(cfg: SSSFConfig, name: str) -> AgentConfig:
    for agent in cfg.agents:
        if agent.name == name:
            return agent
    raise SystemExit(f"agent {name!r} is not defined in the config — "
                     f"available: {[a.name for a in cfg.agents]}")


def validate(cfg: SSSFConfig, required: list[str]) -> None:
    """Fail fast: every required name must resolve to a usable agent."""
    problems = []
    for name in required:
        try:
            agent = resolve(cfg, name)
        except SystemExit as e:
            problems.append(str(e))
            continue
        if agent.coding_agent not in ("pi", "claude_code"):
            problems.append(f"agent {name!r}: coding_agent {agent.coding_agent!r} "
                            f"is not supported (use 'pi' or 'claude_code')")
        # Prompt files are config assets in the adws/adw_data tree, not the
        # execution surface - under a sandbox run cwd is the worktree (which need
        # not even contain adws/), so anchor them at trace_root() like the sink,
        # NOT at cwd. Unset SSSF_TRACE_ROOT (every CLI run) → cwd, unchanged.
        for label, ref in (("system", agent.prompt_engineering.system),
                           ("user", agent.prompt_engineering.user)):
            resolved = resolve_trace_path(ref)
            if not resolved.is_file():
                # Show the resolved path too: under a sandbox run it is anchored at
                # SSSF_TRACE_ROOT, so a bare `ref` looks present in the repo and hides
                # where we actually looked.
                extra = "" if str(resolved) == ref else f" (looked at {resolved})"
                problems.append(f"agent {name!r}: {label} prompt not found: {ref}{extra}")
        # pi models must resolve against pi's catalog now; claude_code models are
        # validated by the SDK at call time, so we only sanity-check the provider.
        if agent.coding_agent == "pi":
            try:
                agent_pi.resolve_model(agent.model)
            except ValueError as e:
                problems.append(f"agent {name!r}: {e}")
        elif agent.coding_agent == "claude_code" and "/" in agent.model \
                and not agent.model.startswith("anthropic/"):
            problems.append(f"agent {name!r}: claude_code expects an anthropic/ model, "
                            f"got {agent.model!r}")
    if problems:
        raise SystemExit("config validation failed:\n- " + "\n- ".join(problems))


# ── execution ────────────────────────────────────────────────────────────────

def execute(run, phase: Phase, call: AgentCall) -> EnvelopeBase:
    """One agent phase: render prompts -> run -> typed parse -> gates -> envelope.

    For BuildOutput phases this drives the CHAINED BUILDER (the context-window
    handoff). If a builder cannot finish inside one context window - it either
    cooperatively asks to continue (status success + continuation=needs_continuation
    + a handoff doc), or the safety valve hard-kills it at the occupancy threshold -
    a FRESH instance of the SAME model continues from a handoff, with the prior
    instance's edits already applied on disk. Bounded by continuation.max_instances,
    then the phase fails loudly. Every other agent phase runs exactly one instance,
    byte-for-byte as before. ADWs need no changes: the whole feature hangs off the
    call's output_type being BuildOutput.
    """
    agent = resolve(run.cfg, phase.params.owner)
    agent_dir = run.session_dir / agent.name
    agent_dir.mkdir(parents=True, exist_ok=True)

    # The write boundary measures cumulative writes against the tree as it was
    # before the phase opened, so snapshot ONCE here. Enforcement runs inside each
    # completing instance (before it persists a valid envelope or saves its session),
    # exactly as it did pre-refactor: an agent must not record success on a phase in
    # which it wrote out of bounds. Passing the phase baseline down keeps the check
    # cumulative across a chain while restoring the enforce-before-accept ordering.
    tree_before = permissions.snapshot(run)

    cont = run.cfg.continuation
    is_build = isinstance(call.output_type, type) and issubclass(call.output_type, BuildOutput)
    # Chaining (and its valve) only make sense when a NEXT instance can continue -
    # so enabled, a build phase, and a cap of at least 2. `max_instances: 1` is the
    # documented "off" switch and behaves exactly like the pre-continuation engine.
    chaining = cont.enabled and is_build and cont.max_instances >= 2

    if chaining:
        def run_instance(prompt_text: str, instance: int):
            session_id = _instance_session_id(run, agent, instance)
            return _run_instance(run, phase, agent, call, agent_dir, prompt_text,
                                 session_id, cont.occupancy_threshold, instance, tree_before)
        envelope = _chain(run, phase, cont, call.prompt, run_instance,
                          lambda: _synthesize_handoff(run))
    else:
        envelope, _ = _run_instance(run, phase, agent, call, agent_dir, call.prompt,
                                    _agent_session_id(run, agent), None, 1, tree_before)

    if envelope.status != "success":
        raise RuntimeError(f"{agent.name} reported status={envelope.status!r}: {envelope.summary}")
    return envelope


# ── the chained builder (context-window handoff) ─────────────────────────────

_CONTINUATION_NOTE = (
    "Your predecessor's changes are ALREADY APPLIED in this worktree. Run "
    "`git diff` and `git status` to see exactly what is on disk, then CONTINUE "
    "from there - do not restart, and do not redo work that is already done.")


def _continuation_seed(original_task: str, handoff: str) -> str:
    """The prompt a fresh continuation instance receives: the original task, the
    predecessor's handoff (agent-authored or diff-synthesized), and the standing
    note that the prior work is already on disk."""
    return (f"{original_task}\n\n"
            f"## Continuation handoff from the previous builder instance\n\n"
            f"{handoff}\n\n"
            f"## How to continue\n\n{_CONTINUATION_NOTE}")


def _synthesize_handoff(run) -> str:
    """The backstop handoff when no agent-authored one exists (the safety-valve
    hard-kill, or a builder that errored out): git diff IS the record of what
    changed. Anchored at run.repo_root - the EXECUTION root where the builder wrote
    code (the worktree under a sandbox), not the process cwd - the same tree the
    continuation instance will itself inspect."""
    root = run.repo_root
    parts = [
        "(No agent-authored handoff - the previous instance was interrupted at the "
        "context-window safety valve, or exited without one. This handoff is "
        "synthesized from git; read the working tree to see the real state.)",
    ]
    try:
        diff = git_helper._git_at(root, "diff", "HEAD")
    except Exception:
        diff = ""
    try:
        untracked = [ln for ln in git_helper._git_at(
            root, "ls-files", "--others", "--exclude-standard").splitlines() if ln]
    except Exception:
        untracked = []
    if untracked:
        parts.append("### New (untracked) files\n\n" + "\n".join(f"- {p}" for p in untracked))
    if diff:
        clipped = (diff if len(diff) <= _SYNTH_DIFF_CHARS
                   else diff[:_SYNTH_DIFF_CHARS] + "\n… (diff truncated)")
        parts.append("### Uncommitted changes so far (`git diff HEAD`)\n\n```diff\n"
                     + clipped + "\n```")
    if not diff and not untracked:
        parts.append("git shows no changes yet - begin the task from scratch.")
    return "\n\n".join(parts)


def _instance_session_id(run, agent: AgentConfig, instance: int) -> str:
    """Instance 1 reuses the agent's cross-phase session (rejoin context - e.g. a
    revise phase continuing its build); every later instance in a chain gets a
    FRESH id, because a new session is an empty window, which is the whole point."""
    if instance == 1:
        return _agent_session_id(run, agent)
    return f"sssf-{run.adw_id}-{agent.name}-{new_id(4)}"


def _chain(run, phase: Phase, cont, original_task: str, run_instance, synth_handoff) -> EnvelopeBase:
    """Drive up to cont.max_instances builder instances, chaining a fresh one each
    time the last cannot finish inside its window. `run_instance(prompt, n)` returns
    (envelope, result); a valve-killed instance returns (None, result) with
    result.overflowed set. Returns the final envelope; raises loudly at the cap."""
    max_n = max(1, cont.max_instances)
    prompt_text = original_task
    envelope: EnvelopeBase | None = None
    for instance in range(1, max_n + 1):
        envelope, result = run_instance(prompt_text, instance)
        overflow = bool(getattr(result, "overflowed", False))
        cooperative = (envelope is not None
                       and getattr(envelope, "continuation", "complete") == "needs_continuation")
        # A real, complete (or failed) envelope that is not asking to continue is
        # the end of the chain - execute() then rules on its status.
        if envelope is not None and not overflow and not cooperative:
            return envelope
        source = "cooperative" if cooperative else "context-valve"
        if instance >= max_n:
            raise RuntimeError(
                f"builder still needs to continue after {max_n} instance(s) "
                f"({source} handoff) - failing loudly rather than chaining "
                f"unbounded. Split the task or raise continuation.max_instances.")
        authored = bool(cooperative and envelope is not None and envelope.handoff.strip())
        handoff = envelope.handoff.strip() if authored else synth_handoff()
        prompt_text = _continuation_seed(original_task, handoff)
        run.console.note(f"builder instance {instance} did not finish ({source}); "
                         f"continuing with a fresh instance {instance + 1}")
        run.tracer.event(EventRecord(adw_id=run.adw_id, phase_id=phase.phase_id,
                                     type="log", name="continuation",
                                     payload={"from_instance": instance,
                                              "to_instance": instance + 1,
                                              "source": source,
                                              "handoff_synthesized": not authored,
                                              "handoff_chars": len(handoff)}))
    return envelope  # unreachable: the loop returns or raises


def _run_instance(run, phase: Phase, agent: AgentConfig, call: AgentCall,
                  agent_dir, prompt_text: str, session_id: str,
                  context_threshold: Optional[float], instance: int, tree_before):
    """One agent instance: render prompts -> run -> typed parse -> gates. Returns
    (envelope, latest_result). A valve-killed instance was terminated mid-work and
    has no cooperative Report JSON to parse (and no live session to re-prompt), so
    it returns (None, result) with result.overflowed set - the caller synthesizes a
    handoff and continues with a fresh instance. `tree_before` is the phase's write
    baseline; enforcement runs here, before this instance records success."""
    variables = {
        "prompt": prompt_text,
        "previous_envelope": call.previous.model_dump_json(indent=2) if call.previous else "(none)",
        "context_handoff_dir": str(run.context_handoff_dir),
        # Two roots, deliberately distinct. `context_handoff_dir` anchors at the
        # TRACE root (SSSF_TRACE_ROOT, the shared main repo) - it is observability.
        # `repo_root` is the EXECUTION root (cwd; the worktree under a sandbox run) -
        # it is where agents write code. A repo copy (specs/, app_docs/) declared
        # relative would resolve against cwd for the gate but against whatever root
        # the agent inferred from the one absolute path it was handed - and being
        # handed only the main-repo handoff path, a sandboxed agent wrote the copy
        # into the main repo while the gate looked in the worktree. Hand it the
        # worktree root explicitly so the copy lands where the gate checks.
        "repo_root": str(run.repo_root),
    }
    # Anchor prompt reads at trace_root() (SSSF_TRACE_ROOT or cwd) - see validate():
    # a sandbox run's cwd is the worktree, but the roster's prompt assets live in the
    # real repo's adws/adw_data tree, exactly where the trace sink is.
    system_text = prompts.render(resolve_trace_path(agent.prompt_engineering.system), variables)
    user_text = prompts.render(resolve_trace_path(agent.prompt_engineering.user), variables)
    # Hand the stamped repo's guidance (AGENTS.md, else CLAUDE.md) to EVERY backend.
    # claude_code runs in SDK isolation (no ambient CLAUDE.md); pi discovers these
    # from cwd natively, but that native discovery is NOT guaranteed under a sandbox
    # worktree, so inject unconditionally rather than trust it. Appended (not
    # prepended): the agent's own system.md leads, the project's conventions follow.
    guidance = project_guidance(run.repo_root)
    if guidance:
        system_text = f"{system_text}\n\n{guidance}"
    prompts.save(agent_dir / "prompts", "system.md", system_text)
    prompts.save(agent_dir / "prompts", "user.md", user_text)

    run.tracer.event(EventRecord(adw_id=run.adw_id, phase_id=phase.phase_id,
                                 type="agent_start", name=agent.name,
                                 payload={"model": agent.model, "thinking": agent.thinking,
                                          "color": agent.color,
                                          "session_id": session_id,
                                          "coding_agent": agent.coding_agent,
                                          "purpose": agent.purpose,
                                          "tools": agent.tools,  # None = all tools
                                          "harness_engineering": agent.harness_engineering,
                                          "instance": instance}))
    run.console.agent_started(agent.name, agent.model, session_id)

    # Parse retries and gate corrections re-enter the SAME session, so the last send
    # is the one whose context occupancy is current - while spend is the opposite:
    # every send costs, so usage accumulates across all of them within this instance.
    latest: agent_pi.PiResult | None = None
    spent = UsageBreakdown()

    def send(text: str) -> agent_pi.PiResult:
        nonlocal latest
        request = PiRequest(
            prompt=text,
            system_prompt=system_text,
            model=agent.model,
            thinking=agent.thinking,
            session_id=session_id,
            # absolute: these are read by the pi subprocess, which runs in repo_root
            session_dir=str((agent_dir / "pi_sessions").resolve()),
            raw_output_path=str((agent_dir / "raw_output.jsonl").resolve()),
            tools=agent.tools,
            extensions=agent.harness_engineering,
            cwd=str(run.repo_root),
            context_kill_threshold=context_threshold,
        )
        # Agent proposes, code disposes — through whichever backend the config
        # names. Both expose the same run() contract and return the same PiResult;
        # agent_cc re-emits tool calls in pi's event shape so the forwarder below
        # records them identically.
        backend = agent_cc if agent.coding_agent == "claude_code" else agent_pi
        result = backend.run(
            request,
            on_event=_event_forwarder(run, phase, agent.name),
            on_spawn=lambda pid: run.tracer.process_start(
                run.adw_id, "agent", agent.name, pid,
                f"{agent.coding_agent} {agent.name} {agent.model}"),
            on_exit=lambda pid: run.tracer.process_end(run.adw_id, pid))
        run.add_usage(result.tokens, result.cost)
        spent.merge(result.usage)
        latest = result
        # A valve kill can land on ANY send - the first, or a later JSON-fix / gate
        # correction whose cumulative occupancy tips the same session over the
        # ceiling. Signal it uniformly so it is salvaged wherever it happens, instead
        # of only the first send. Guarded on chaining being active: a non-chaining
        # (context_threshold is None) aborted/errored turn falls through to the
        # normal parse, which raises cleanly as before. Usage is already recorded.
        if result.overflowed and context_threshold is not None:
            raise _ContextOverflow()
        return result

    # A valve-killed instance was terminated mid-work: no cooperative Report JSON,
    # no live session to re-prompt. Record it and hand the caller a None envelope so
    # it can synthesize a handoff and chain a fresh instance.
    try:
        result = send(user_text)
        envelope, attempt = _parse_with_retries(run, phase, call, result, send)

        # claim gates - violations flow back into the SAME session as corrections
        for gate_attempt in range(1, max(1, phase.params.retries + 1) + 1):
            violations = []
            for gate in call.gates:
                report = _as_report(gate(envelope, run))
                found = report.violations
                run.tracer.gate_row(phase, gate.__name__, report, gate_attempt)
                run.tracer.event(EventRecord(
                    adw_id=run.adw_id, phase_id=phase.phase_id,
                    type="gate_fail" if found else "gate_pass", name=gate.__name__,
                    payload={"attempt": gate_attempt, "violations": found,
                             "checks": [c.model_dump() for c in report.checks]}))
                run.console.gate_result(gate.__name__, report)
                violations.extend(found)
            if not violations:
                break
            if gate_attempt > phase.params.retries:
                raise GateFailure(f"{agent.name} failed gates after {gate_attempt} attempt(s):\n- "
                                  + "\n- ".join(violations))
            phase.attempt = gate_attempt
            run.console.retry(agent.name, gate_attempt, phase.params.retries,
                              f"{len(violations)} gate violation(s)")
            correction = ("Your previous response failed validation:\n- "
                          + "\n- ".join(violations)
                          + "\n\nFix these problems, then re-emit ONLY your Report JSON.")
            result = send(correction)
            envelope, attempt = _parse_with_retries(run, phase, call, result, send)
    except _ContextOverflow:
        _emit_agent_end(run, phase, agent, session_id, spent, latest, instance,
                        overflowed=True)
        return None, latest

    # Permission is enforced BEFORE this instance records success: an agent does not
    # get to persist a valid envelope or save a reusable session for a phase in which
    # it (or any earlier instance in the chain) wrote out of bounds. Cumulative vs
    # the phase baseline, so a breach in any instance rolls back and fails here.
    try:
        touched = permissions.enforce(run, phase, agent, tree_before)
    except permissions.PermissionBreach as breach:
        run.tracer.event(EventRecord(adw_id=run.adw_id, phase_id=phase.phase_id,
                                     type="error", name="permission_breach",
                                     payload={"agent": agent.name, "error": str(breach),
                                              "writes": agent.writes,
                                              "protected_files": run.cfg.defaults.protected_files}))
        raise
    if touched:
        run.tracer.event(EventRecord(adw_id=run.adw_id, phase_id=phase.phase_id,
                                     type="log", name="paths_touched",
                                     payload={"agent": agent.name, "paths": touched}))

    _persist_envelope(run, phase, agent.name, call, envelope, attempt, valid=True)
    run.console.envelope_summary(envelope)
    context = latest or result
    run.save_agent_map(agent.name, {"session_id": session_id, "model": agent.model,
                                    "coding_agent": agent.coding_agent})
    run.tracer.event(EventRecord(adw_id=run.adw_id, phase_id=phase.phase_id,
                                 type="handoff", name=agent.name,
                                 payload={"artifacts": envelope.artifacts,
                                          "summary": envelope.summary}))
    _emit_agent_end(run, phase, agent, session_id, spent, context, instance)
    return envelope, latest


def _emit_agent_end(run, phase: Phase, agent: AgentConfig, session_id: str,
                    spent: UsageBreakdown, context, instance: int,
                    overflowed: bool = False) -> None:
    """Close one instance: its session-occupancy row, the agent_end event (usage is
    this INSTANCE's spend, never cumulative across the chain - the sum over
    instances is the phase total), and the console line."""
    run.tracer.agent_session_row(run.adw_id, agent, session_id,
                                 context_tokens=context.context_tokens,
                                 context_window=context.context_window)
    payload = {"cost": spent.total_cost, "usage": spent.model_dump(),
               "context_tokens": context.context_tokens,
               "context_window": context.context_window, "instance": instance}
    if overflowed:
        payload["overflowed"] = True
    run.tracer.event(EventRecord(adw_id=run.adw_id, phase_id=phase.phase_id,
                                 type="agent_end", name=agent.name,
                                 tokens=spent.total_tokens, payload=payload))
    run.console.agent_finished(agent.name, spent.total_tokens, spent.total_cost)


# ── internals ────────────────────────────────────────────────────────────────

def _as_report(result) -> GateReport:
    """Accept a GateReport, or a legacy gate that returned a violations list."""
    if isinstance(result, GateReport):
        return result
    return GateReport(checks=[GateCheck(item=str(v), ok=False) for v in (result or [])])


def _agent_session_id(run, agent: AgentConfig) -> str:
    entry = run.agent_map.get(agent.name)
    if entry and entry.get("model") == agent.model:
        return entry["session_id"]           # rejoin the existing context window
    return f"sssf-{run.adw_id}-{agent.name}-{new_id(4)}"


def _event_forwarder(run, phase: Phase, agent_name: str):
    """One tool_call event per real tool call, with its exact args and result."""
    tracker = agent_pi.ToolCallTracker()

    def forward(event: dict) -> None:
        record = tracker.observe(event)
        if record is None:
            return
        # The call's span rides the columns; duration_ms stays in the payload as
        # pi's own authoritative number.
        run.tracer.event(EventRecord(adw_id=run.adw_id, phase_id=phase.phase_id,
                                     type="tool_call", name=record.pop("label"),
                                     started_at=record.pop("started_at", None),
                                     ended_at=record.pop("ended_at", None),
                                     payload={**record, "agent": agent_name}))
    return forward


def _extract_json(text: str) -> dict:
    candidate = text
    if "```" in text:
        for block in text.split("```")[1::2]:
            block = block.removeprefix("json").strip()
            if block.startswith("{"):
                candidate = block
                break
    start, end = candidate.find("{"), candidate.rfind("}")
    if start == -1 or end <= start:
        raise ValueError("no JSON object found in the response")
    return json.loads(candidate[start:end + 1])


def _parse_with_retries(run, phase: Phase, call: AgentCall, result, send):
    """Parse the final response against the declared output type; on failure,
    continue the SAME session with a correction (bounded)."""
    for attempt in range(1, JSON_FIX_ATTEMPTS + 2):
        try:
            payload = _extract_json(result.text)
            return call.output_type.model_validate(payload), attempt
        except Exception as error:
            _persist_envelope(run, phase, phase.params.owner, call, None, attempt,
                              valid=False, raw=result.text)
            if attempt > JSON_FIX_ATTEMPTS:
                raise RuntimeError(
                    f"{phase.params.owner} never produced valid "
                    f"{call.output_type.__name__} JSON: {error}") from error
            run.console.retry(phase.params.owner, attempt, JSON_FIX_ATTEMPTS,
                              f"invalid {call.output_type.__name__} JSON: {error}")
            fields = ", ".join(call.output_type.model_fields.keys())
            result = send(
                f"Your response was not valid JSON for the required structure "
                f"({error}). Respond again with ONLY a JSON object with these "
                f"fields: {fields}. No prose, no code fences.")


def _persist_envelope(run, phase: Phase, agent_name: str, call: AgentCall,
                      envelope: Optional[EnvelopeBase], attempt: int,
                      valid: bool, raw: str = "") -> None:
    payload_json = envelope.model_dump_json(indent=2) if envelope else json.dumps({"raw": raw[-2000:]})
    run.tracer.envelope_row(phase, agent_name, call.output_type.__name__,
                            payload_json, valid, attempt)
    if envelope:
        record = {"agent_name": agent_name, "purpose": resolve(run.cfg, agent_name).purpose,
                  "output_type": call.output_type.__name__, "attempt": attempt,
                  **envelope.model_dump()}
        (run.session_dir / agent_name / "envelope.json").write_text(json.dumps(record, indent=2))
