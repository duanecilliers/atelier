# Atelier

A workshop where **agents propose and deterministic code disposes**. Atelier marries
the determinism of the [Super-Simple Software Factory](https://github.com/) (the ADW
engine) with an operator-console cockpit lifted from FounderOS's "Monolith Signal"
design system. Agents run inside bounded phases; deterministic Python decides
sequencing and acceptance; every event streams to a UI you can watch.

The whole thing rests on one seam: **both halves treat SQLite as the single source
of truth.** The engine writes the live trace; the cockpit reads it back.

```
┌──────────┐   writes    ┌─────────────────────────────┐   reads (readonly, WAL)   ┌──────────┐
│  engine  │ ──────────▶ │  engine/adws/adw_data/sssf.db │ ◀──────────────────────── │ cockpit  │
│ (Python) │             │   7 tables · the contract     │                           │ (Next.js)│
└──────────┘             └─────────────────────────────┘                           └──────────┘
```

## Layout

| Path        | What it is                                                              |
| ----------- | ----------------------------------------------------------------------- |
| `engine/`   | SSSF stamped in via its `install.py`. Runs ADWs, writes `sssf.db`.      |
| `cockpit/`  | Fresh Next.js 14 app. Reads `sssf.db` through a Zod-validated repo layer. |
| `docs/`     | The build plan (`atelier-plan.html`) and usage guide.                   |

> **Note on git:** `engine/` shares this repo's single git root (no nested `.git`).
> SSSF anchors on the git root — `pi`'s `-e` paths, the write-boundary diff, and
> commit phases all resolve there — so every engine config path is `engine/`-prefixed
> and ADWs are run from the repo root. `repo_root()` is therefore the atelier root:
> the factory self-hosts (it can build Atelier itself), guarded by `protected_files`.

## The seam contract

`cockpit/lib/types.ts` is the frozen TypeScript mirror of the engine's schema
(`engine/adws/adw_modules/tracer.py`), and `cockpit/lib/schemas.ts` is the Zod
enforcement of it. Python↔TS drift is the architecture's #1 risk, so it's made
machine-checkable:

```bash
cd cockpit && pnpm check:contract   # asserts every expected column exists in the live db
```

## Running it

**Engine — kick a run (writes to the shared db). Run from the repo root:**

```bash
just demo                      # two cheap read-only runs, end to end
# or a single one:
uv run engine/adws/adw_prompt.py --config engine/adws/adw_sssf_config/sssf.config.yaml \
  --agent scout "reply with a one-line summary of this repo"
```

**Cockpit — watch runs land (reads the shared db):**

```bash
cd cockpit
pnpm install
pnpm dev                       # http://127.0.0.1:4200
```

The cockpit finds the db via `SSSF_DB` in `cockpit/.env.local` (an absolute path to
`engine/adws/adw_data/sssf.db`).

## Two coding-agent backends

The engine picks a backend per agent via `coding_agent:` in the config (D1 in the plan):

| Backend       | `coding_agent` | Drives                        | Auth |
| ------------- | -------------- | ----------------------------- | ---- |
| **pi**        | `pi`           | GPT-5.6 (Sol/Terra/Luna), etc | pi's own (`~/.pi/agent`) |
| **Claude SDK**| `claude_code`  | Claude (Haiku/Sonnet/Opus)    | Claude Code's own login (`claude`) |

`agent_cc.py` implements the Claude backend against `claude-agent-sdk`; it mirrors
`agent_pi.run`'s contract exactly (streamed tool events, envelope text, cost/usage,
session resume) so `agents.execute()` treats both identically.

**Current roster:** scout → `anthropic/claude-haiku-4-5` (Claude SDK); builder →
`openai-codex/gpt-5.6-sol` (pi); planner → `anthropic/claude-fable-5`.

> ⚠️ **pi's Anthropic OAuth is expired on this machine** ("OAuth refresh failed for
> anthropic"), so pi can only run `openai-codex/*` models. That's *why* Claude agents
> go through the SDK — it uses the `claude` CLI's own working login, no API key needed.
> The **planner** (`anthropic/claude-fable-5`) still uses `coding_agent: pi`, so
> plan/build chains need either pi Anthropic re-auth **or** switching the planner to
> `coding_agent: claude_code`. Also: `pi` 0.81.1 has no `~/.pi/agent/models.json`, so
> `engine/.env` points `PI_MODELS_PATH` at a local stub.

## Build status

- **Phase 0 — Foundations & the seam** ✅ Monorepo up; engine runs; schema frozen +
  contract-checked; design system lifted; cockpit renders real runs from the shared db.
- **Phase 1 — Observe** (next): the three views on real data — Runs log · live Process
  Map · Run detail (phases + envelope + gates).
- Phases 2–5: control plane · observability/cost · authoring · real-time. See
  `docs/atelier-plan.html`.
