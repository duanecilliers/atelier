# Extending the system

This is the cookbook. Each recipe is a concrete, end-to-end change — the files you touch, in
order, and how to verify it. It assumes you've read [Architecture](01-architecture.md) and know
the subsystem the change lives in. The last section, [Using Atelier to extend
itself](#using-atelier-to-extend-itself), is the payoff: pointing the factory at its own repo.

## The one rule that outranks every recipe: mirror the seam

The seam (`sssf.db`) is defined in Python and read in TypeScript. **Any change to a trace table
in `engine/adws/adw_modules/tracer.py` must be mirrored in the cockpit, or Python↔TS drift
silently corrupts the reader.** Before you touch a schema, internalize the checklist in
[Recipe E](#recipe-e--add-a-column-to-a-trace-table-or-run_queue). `pnpm check:contract` is the
gate that catches most (not all) drift — run it after any schema change.

The roster config has a second mirror with the same discipline but **no machine check**:
`cockpit/lib/roster.ts` mirrors `data_types.py`. Keep it in lockstep by hand.

---

## Recipe A — Add a new ADW

An ADW is a phase chain. You have two paths.

### A1. Generate one (canonical shapes)

If your chain is a subsequence of `scout → plan → build → test → review → commit → document`,
generate it — no code, no drift.

- **From the cockpit:** the `/skills` page → **Recipe Builder**. Pick blocks, preview the
  generated source, create. It writes `engine/adws/adw_<name>.py` and appears in the launcher
  immediately (the launch allowlist is the live on-disk set).
- **From the CLI:**
  ```bash
  uv run engine/adws/make_adw.py --list-steps                 # see the palette
  uv run engine/adws/make_adw.py --name my_flow --steps plan,build,commit --stdout   # preview
  uv run engine/adws/make_adw.py --name my_flow --steps plan,build,commit            # write it
  ```

**Verify:** `just prompt` won't run it (it's not `adw_prompt`), so kick it directly:
`uv run engine/adws/adw_my_flow.py --config engine/adws/adw_sssf_config/sssf.config.yaml "<ask>"`
(costs a few cents), then read the trace: `just phases <adw_id>`.

### A2. Hand-author one (non-canonical shapes)

For a bespoke ordering, a new gate, or logic the generator can't express, write the script by
hand. Copy the skeleton in [Authoring ADWs → Hand-authoring](04-authoring-adws.md), then:

1. Set `REQUIRED_AGENTS` to the roster agent names you call.
2. First phase is always `name="request", kind="engineer"`, logging `ph.log(input=prompt)`.
3. Compose `agent` phases (`ph.call(AgentCall(output_type=…, gates=[…]))`) and `code` phases
   (git commit, `quality.run_quality(run)`, `changes.capture(...)`).
4. End with `return run.finish(accepted=…, reason=…)`.

**Files touched:** just the new `engine/adws/adw_<name>.py`. No seam change — an ADW writes the
trace through the standard `tracer.py` path.

**Verify:** kick it directly as above; confirm `/skills` renders its card (the cookbook parses
the docstring's `Phases:` line and `REQUIRED_AGENTS`), and that it's launchable from the
`/queue` Conductor.

---

## Recipe B — Add a new agent to the roster

An agent is a roster entry in `sssf.config.yaml` plus two prompt files. See
[Config & roster](05-config-and-roster.md) for field semantics.

### B1. From the cockpit
`/agents` → add an agent. This bootstraps `system.md`/`user.md` templates under
`engine/adws/adw_data/prompt_engineering/<name>/`, starts the agent at `writes: []` (read-only
until you grant writes), validates the whole rewritten YAML, and writes it atomically.

### B2. By hand
1. Append an entry under `agents:` in `engine/adws/adw_sssf_config/sssf.config.yaml`. Minimum:
   `name`, `prompt_engineering.system`, `prompt_engineering.user`. Everything else falls back to
   `defaults:`.
2. Create the two prompt files at the paths you referenced.
3. Choose the backend: `coding_agent: pi` (needs an `openai-codex/*` model on this machine) or
   `coding_agent: claude_code` (for `anthropic/*` models). Getting this wrong is the most common
   failure — see the machine gotcha in [Architecture](01-architecture.md).
4. Set `writes:` deliberately (`[]` read-only, `[dir/]` scoped, absent = unrestricted-except-
   `protected_files`) and `tools:` (name any harness-extension tools explicitly or they're
   filtered out).

**Verify:** `agents.validate()` runs at the top of any ADW that requires the agent — kick an ADW
that uses it, or point `adw_prompt` at it: `uv run engine/adws/adw_prompt.py --config … --agent <name> "hello"`.
A missing prompt file or unresolvable model fails fast before anything spawns.

---

## Recipe C — Add a new gate

A gate is a deterministic post-check on an envelope: `gate(envelope, run) -> GateReport`. See
[Agents & gates](03-agents-and-gates.md).

1. Add a function to `engine/adws/adw_modules/gates.py` returning a `GateReport` (one
   `GateCheck` per item you looked at — pass or fail with a `note`). Use `getattr(envelope, …,
   default)` so it degrades gracefully on envelope types that lack a field.
2. Pass it in an ADW's `AgentCall(gates=[gates.your_gate])`. Set the phase's `retries` if you
   want the agent to get correction attempts (violations are re-prompted into the same session).

**Files touched:** `gates.py` + the ADW that uses it. No seam change (gate results already have a
`gate_results` table and `checks_json` column).

**Verify:** kick an ADW whose agent will trip the gate; confirm `just phases <adw_id>` shows the
phase and the trace records a `gate_fail`/`gate_pass` with your checks. In the cockpit, the run
detail's Gate panel renders them.

---

## Recipe D — Add a new envelope type

An envelope is the typed contract for an agent's output. See
[Agents & gates](03-agents-and-gates.md).

1. Subclass `EnvelopeBase` in `engine/adws/adw_modules/data_types.py` with your extra fields
   (keep `status`/`summary`/`artifacts`/`notes_for_next_agent` from the base).
2. Use it as `AgentCall(output_type=YourOutput, …)` in a phase.
3. If deterministic code should also produce it (like `VerifyOutput`/`ChangesOutput`), add an
   `as_envelope(...)` adapter so a code phase can hand it back through the same door.

**Files touched:** `data_types.py` + the ADW. The envelope is persisted as JSON in the existing
`envelopes` table — **no seam column change**. (The cockpit reads `payload_json` generically.)

**Verify:** kick the ADW; confirm the run detail's Envelope panel shows your fields.

---

## Recipe E — Add a column to a trace table (or `run_queue`)

**This is the seam-change checklist. Miss a step and the reader drifts.** Suppose you add a
column `foo` to table `bar`.

1. **Engine DDL.** In `engine/adws/adw_modules/tracer.py`:
   - Add the column to the `CREATE TABLE bar (...)` in `SCHEMA` (so fresh dbs have it), **and**
   - Add `("bar", "foo", "<TYPE> [DEFAULT …]")` to `MIGRATIONS` (so existing dbs `ALTER` on next
     open — `CREATE TABLE IF NOT EXISTS` never revisits an existing table).
   - If `bar` is `run_queue`, the DDL is owned by `engine/adws/adw_modules/queue.py`
     (`RUN_QUEUE_DDL`) instead — edit it there; it's folded into `SCHEMA`. Also update
     `queue.py`'s `_CLAIM_COLS` if the worker needs to read `foo`, and the write helpers if it
     sets it.
2. **Engine writers.** Set the column wherever it's produced (a `tracer.py` write method, or the
   worker for `run_queue`).
3. **TS interface.** Add `foo` to the row interface in `cockpit/lib/types.ts`.
4. **TS validator.** Add `foo` to the matching Zod schema in `cockpit/lib/schemas.ts`. If it's a
   migration-added column that older dbs may lack, mark it `.optional()`. `TABLE_COLUMNS` derives
   from the schema automatically.
5. **Contract check.** If `foo` is migration-added (optional on old dbs), add it to
   `MIGRATION_COLUMNS` in `cockpit/scripts/check-contract.ts` so an older db validates with a
   warning instead of a hard failure. A brand-new *table* is a hard requirement (no migration
   grace).
6. **Readers.** If a page needs `foo`, add it to the relevant `SELECT` in `cockpit/lib/db.ts`.
   For a possibly-absent column, use the `optionalColumn('bar','foo')` helper (as `queue()` does
   for `target`/`adw_name`) so an old db returns `NULL` instead of erroring.
7. **Cockpit write (only for `run_queue`).** If the cockpit sets `foo` at enqueue, update
   `cockpit/lib/control.ts` — the hand-kept `RUN_QUEUE_DDL` mirror, `EnqueueSpecSchema`, the
   `enqueue()` INSERT, and the `get()` SELECT.

**Verify:**
```bash
cd cockpit && pnpm typecheck && pnpm check:contract && pnpm build
```
`check:contract` opens the live db and asserts every expected column exists. Then kick a real run
and confirm the value lands: `just <peek>` or the run/queue view. After adding any new
`AtelierDb` **method**, restart `pnpm dev` — the connection is memoized on `globalThis`, so HMR
keeps a stale one ("X is not a function").

### The sandbox feature is the worked example

The **sandbox / isolated runs** feature is this recipe applied end-to-end — a whole new control
table *plus* migration-added columns — and is the canonical reference when you're unsure which
sites a change touches:

- **New table.** `sandboxes` is defined once in `engine/adws/adw_modules/sandboxes.py`
  (`SANDBOXES_DDL`), folded into the tracer's `SCHEMA` (like `RUN_QUEUE_DDL`), and mirrored in
  `types.ts` (`Sandbox`), `schemas.ts` (`SandboxRowSchema` + `TABLE_COLUMNS`), `check-contract.ts`,
  and `control.ts` (`AtelierControl` owns its write side — create + shutdown + land). A brand-new
  *table* is a **hard** contract requirement (no migration grace).
- **New `run_queue` column.** `sandbox_id` (nullable) binds a run to a sandbox; it rides the
  `run_queue` DDL in `queue.py`, `tracer.py` `MIGRATIONS`, `EnqueueSpecSchema` + the INSERT in
  `control.ts`, `check-contract.ts`'s `MIGRATION_COLUMNS`, and `db.ts::queue()` (via
  `optionalColumn` so an old db returns NULL).
- **Migration-added columns.** The landing slice added `land_requested` + `land_result` to the
  *existing* `sandboxes` table — so they appear in `SANDBOXES_DDL` **and** `MIGRATIONS`, with an
  `ALTER`-self-heal in both `sandboxes.py::ensure_schema` (engine) and `control.ts`'s constructor
  (cockpit write side), `.optional()` in Zod, listed in `MIGRATION_COLUMNS`, and read via
  `optionalColumn` — the exact "existing dbs must still validate" path steps 4–6 describe.

The lesson: a control-plane table lives in its own engine module (not `tracer.py`) but still folds
into `SCHEMA`, and the cockpit's **write** mirror (`control.ts`) needs the same DDL + ALTER
discipline as the engine, because both connections may be the first to open an older db.

---

## Recipe F — Add a cockpit view or query

See [The cockpit](06-cockpit.md).

- **A new read query:** add a method to `AtelierDb` in `cockpit/lib/db.ts` (a `SELECT`,
  Zod-validated at the boundary). **Restart `pnpm dev`** afterward (memoized connection).
- **A new page:** a `force-dynamic` server component under `cockpit/app/<route>/page.tsx` that
  calls `getDb()`. Add it to `cockpit/lib/nav.ts` so the sidebar and command palette pick it up
  (they derive from that single source).
- **A new API route:** a `route.ts`; declare `export const runtime = 'nodejs'` if it touches
  `better-sqlite3` (it's synchronous, incompatible with edge). **Restart `pnpm dev`** — HMR
  misses brand-new routes.
- **A live view:** reuse the signature pattern — compute a signature in
  `cockpit/lib/dashboard-signature.ts`, emit it from `/api/dashboard/stream`, and mount
  `<LiveRefresh>` seeded with the server-rendered signature. No client row state.

**Verify:** `pnpm typecheck && pnpm build` (catches client/server `node:fs` boundary leaks), then
load the page against the real db.

---

## Recipe G — Wire a real quality command

`engine/adws/adw_modules/quality.py` ships its lint/test/typecheck/build blocks as `_placeholder`
echoes. Replace each with the repo's real command as an **argv list** (never a shell string —
argv avoids quoting/injection), calling binaries by bare name so `operator_env()` resolves them
like the operator's shell. Then `test`/`quality` phases (and the `adw_quality` ADW) actually mean
something. See [Agents & gates → quality](03-agents-and-gates.md).

**Verify:** `uv run engine/adws/adw_quality.py --config … "smoke"` and read the phase's logged
command output under the session's `context_handoff/quality/` dir.

---

## Using Atelier to extend itself

The factory self-hosts: `repo_root()` is the atelier root, so an ADW run from the repo root can
propose changes to Atelier's own code. This is the intended way to grow the system.

**How to do it safely:**

1. **Kick a planning/build ADW against the repo**, from the repo root, describing the change —
   e.g.
   ```bash
   uv run engine/adws/adw_plan_build.py --config engine/adws/adw_sssf_config/sssf.config.yaml \
     "Add a --dry-run flag to adw_worker.py that logs the argv it would spawn without spawning."
   ```
   or enqueue it from the cockpit `/queue` Conductor and let `just worker` drain it.

2. **The guardrails that keep a self-build honest:**
   - `defaults.protected_files` (`engine/adws/adw_modules/`, `adw_sssf_config/`, `adw_*.py`) is
     off-limits to every agent **unless that agent's `writes:` names the path**. So a run that
     needs to modify the factory's own machinery requires you to *deliberately* widen the
     builder's `writes:` for that work — the default builder cannot touch the graders. The
     write-boundary check rolls back and fails the phase on any unauthorized write (a **breach**,
     not a re-promptable gate). See [Agents & the write boundary](03-agents-and-gates.md).
   - Commits are the agent's own words, and (in chains that gate on `test`/`review`) only land
     when the deterministic checks pass — so a self-modification that breaks the suite doesn't
     get committed.

3. **The observability loop:** watch the run live in the cockpit (`/runs/<adw_id>`), or from the
   CLI with `just tail <adw_id>` / `just phases <adw_id>`. The trace is the same whether the run
   was CLI- or cockpit-launched.

**A concrete self-extension pattern** — say you want to add a trace column via the factory rather
than by hand:

1. Point a `plan` or `plan_build` ADW at the change, describing [Recipe E](#recipe-e--add-a-column-to-a-trace-table-or-run_queue)'s checklist in the prompt.
2. Because `tracer.py` and the config dir are in `protected_files`, either widen the builder's
   `writes:` to include `engine/adws/adw_modules/tracer.py` for that run, or take the engine-side
   edit by hand and let the ADW do the cockpit-side mirror (which isn't protected).
3. Run `pnpm check:contract` (or a `quality` phase wired to it) as the acceptance gate.

The meta-point: extending Atelier is itself an ADW-shaped task. The same propose/dispose
discipline that governs any change governs changes to the factory — which is exactly why the
factory is allowed to touch its own source.

## See also

- The change you're making probably has a subsystem guide: [Engine runtime](02-engine-runtime.md),
  [Agents & gates](03-agents-and-gates.md), [Authoring ADWs](04-authoring-adws.md),
  [Config & roster](05-config-and-roster.md), [The cockpit](06-cockpit.md),
  [Operations](07-operations.md).
- The terse canonical rules: [`AGENTS.md`](../AGENTS.md).
- The locked roadmap: [`docs/atelier-plan.html`](atelier-plan.html).
