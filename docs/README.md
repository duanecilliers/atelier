# Atelier documentation

Atelier is a **software factory**: agents propose, deterministic code disposes. A Python **ADW**
(AI Developer Workflow) engine runs coding agents inside bounded phases and decides sequencing
and acceptance; a Next.js **cockpit** observes and controls it. The two halves meet at one
SQLite file — `engine/adws/adw_data/sssf.db` — which *is* the seam and the single source of
truth.

These guides let you operate and **extend** Atelier without reading the whole codebase first.
They point back into the code for depth. For the terse canonical contract (the rules an AI agent
must not break), see [`AGENTS.md`](../AGENTS.md) at the repo root — this set is the long-form
companion to it, not a replacement.

> **Status.** These guides describe `main` as it currently stands. The factory is built
> phase-by-phase from the locked roadmap in [`atelier-plan.html`](atelier-plan.html).
> **Distribution** has landed — the engine is stampable into any repo, updatable from Atelier, with
> a multi-project cockpit and a worker supervisor — and is documented in
> [09-distribution.md](09-distribution.md). **Sandbox / isolated runs** has also landed: an ADW can
> run in an isolated, **persistent** git worktree on a named branch (its own deps, ports, backing
> services, and env at L2) that hosts follow-up runs and lands via a per-project workflow — folded
> into [05](05-config-and-roster.md) (the `sandbox:` block), [07](07-operations.md) (the worker's
> reconcile/reap lifecycle), and [08](08-extending-the-system.md) (Recipe E is the worked seam
> change). The [design note](design/sandbox-runs.md) records the decisions.

## Start here

New to the system? Read these two, in order — everything else assumes their vocabulary:

1. **[Architecture](01-architecture.md)** — the mental model: the seam, propose/dispose, the
   determinism spine, the three Python↔TS mirrors, the self-hosting git layout.
2. **[Operations](07-operations.md)** — how to run it, kick a run, drain the queue, and read a
   trace.

## The guides

| # | Guide | Covers |
| --- | --- | --- |
| 01 | [Architecture](01-architecture.md) | The whole mental model and the invariants to preserve. |
| 02 | [Engine runtime](02-engine-runtime.md) | The run lifecycle: `session` → `Run` → phases → `finish`; the tracer, the trace schema, `git_helper`, kill-safe finalization. |
| 03 | [Agents & gates](03-agents-and-gates.md) | The propose/dispose boundary: `agents.execute()`, the two backends, typed envelopes, gates, the write boundary, deterministic quality blocks. |
| 04 | [Authoring ADWs](04-authoring-adws.md) | The ADW catalog, the phase-chain skeleton, `make_adw.py`, and hand-authoring a new workflow. |
| 05 | [Config & roster](05-config-and-roster.md) | `sssf.config.yaml`: agents, models, prompts, tool/write boundaries, backend routing, and the cockpit roster editor. |
| 06 | [The cockpit](06-cockpit.md) | The Next.js app: routes, the `lib/` layer, the three live (SSE) paths, the design system, and the read/write surfaces. |
| 07 | [Operations](07-operations.md) | Commands, the worker & `run_queue` lifecycle, sandboxes (isolated persistent workspaces), environment variables, self-build guardrails. |
| 08 | [Extending the system](08-extending-the-system.md) | End-to-end recipes: add an ADW, an agent, a gate, an envelope, a seam column, a cockpit view — and how to point the factory at its own repo. |
| 09 | [Distribution](09-distribution.md) | Stamping the engine into any repo (`install.py`), updating it safely (`update.py` + manifest), the `/atelier` operator skill, the multi-project cockpit, and the `--supervise` worker supervisor + `workers` heartbeat. |

## "I want to…"

| Goal | Go to |
| --- | --- |
| Run a workflow / drain the queue | [Operations](07-operations.md) |
| Run an ADW in an isolated workspace (sandbox) / configure provisioning | [Operations → sandboxes](07-operations.md#5-sandboxes--isolated-persistent-workspaces) · [Config → sandbox](05-config-and-roster.md#8-the-sandbox-block--isolated-workspaces) |
| Understand what happens during a run | [Engine runtime](02-engine-runtime.md) → [Agents & gates](03-agents-and-gates.md) |
| Write a new workflow | [Authoring ADWs](04-authoring-adws.md) |
| Add or change an agent / model / prompt | [Config & roster](05-config-and-roster.md) |
| Add a gate or acceptance check | [Agents & gates](03-agents-and-gates.md) · recipe in [Extending](08-extending-the-system.md#recipe-c--add-a-new-gate) |
| Add a cockpit page or query | [The cockpit](06-cockpit.md) · recipe in [Extending](08-extending-the-system.md#recipe-f--add-a-cockpit-view-or-query) |
| Change the trace schema (the seam) | [Extending → Recipe E](08-extending-the-system.md#recipe-e--add-a-column-to-a-trace-table-or-run_queue) — **read the checklist first** |
| Use the factory to build the factory | [Extending → Using Atelier to extend itself](08-extending-the-system.md#using-atelier-to-extend-itself) |
| Stamp the engine into another repo / update a stamped repo | [Distribution](09-distribution.md) |
| Observe many repos from one cockpit / run the supervisor | [Distribution → multi-project](09-distribution.md#6-the-multi-project-cockpit) |

## Related, non-guide references

- **[`AGENTS.md`](../AGENTS.md)** (repo root) — the terse canonical contract; read it before
  working in the repo. `CLAUDE.md` just imports it.
- **[`docs/atelier-plan.html`](atelier-plan.html)** — the locked roadmap (phases, decisions).
- **[`docs/atelier-usage-guide.html`](atelier-usage-guide.html)** — the visual usage guide.

## Ground rules these docs assume

- **The seam is `sssf.db`.** Any change to a trace table in `tracer.py` must be mirrored in
  `cockpit/lib/types.ts` and `cockpit/lib/schemas.ts`; `pnpm check:contract` is the gate.
- **The cockpit never spawns a run.** It enqueues a `run_queue` row; `just worker` is the only
  thing that turns a queued row into a running ADW.
- **Run engine commands from the repo root, cockpit commands from `cockpit/`.**
- **On this machine, pi's Anthropic OAuth is expired** — `anthropic/*` models must route through
  `coding_agent: claude_code`, not `pi`.
