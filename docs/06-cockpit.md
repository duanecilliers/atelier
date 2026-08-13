# The cockpit — Next.js 14 App Router, observe + control

This doc covers `cockpit/` — the Next.js 14 App Router app that observes and controls the
engine. It assumes you've read [README.md](README.md) and [01-architecture.md](01-architecture.md):
agents propose, deterministic code disposes; the seam is the shared sqlite file
`engine/adws/adw_data/sssf.db`; the cockpit never spawns a process to run an ADW; the read path
is readonly by construction; the write surfaces are the `run_queue` and `sandboxes` control tables
(via `lib/control.ts`), the roster config file (via `lib/roster.ts`), and the `sessions.archived`
review flag (via `lib/review.ts`). This doc is the mechanics of that half: routes,
the `lib/` layer, the live paths, the design system, and the client/server boundary rules that
keep it that way.

Dev server: `cd cockpit && pnpm dev` → http://127.0.0.1:4200 (`next dev -H 127.0.0.1 -p 4200`).
No linter, no unit tests in the cockpit — `pnpm typecheck` and `pnpm check:contract` are the
only automated gates (see [AGENTS.md](../AGENTS.md)).

## 1. Route inventory

### Pages (`app/**/page.tsx`)

**Every page lives under `app/[project]/…`** (multi-project — §1.5): the routes below carry a
`/[project]` prefix (`/lunacomet/cost`, `/lunacomet/runs/[adwId]`, …), and each page's `getDb()` /
roster read is scoped to that project's segment. The bare root `/` (`app/page.tsx`) is a
`force-dynamic` redirect to `/{defaultProjectId()}`. Reads shown as `getDb()` below are really
`getDb(projectId)`.

| Route | File | Purpose | Reads | Writes |
|---|---|---|---|---|
| `/[project]` | `app/[project]/page.tsx` | Runs list ("Factory floor") — every ADW session newest-first, stat tiles, phase progress dots per row, tokens/cost/elapsed, hover-× to archive a row. `force-dynamic`. | `getDb().sessions()` | archive via POST `/api/runs/[adwId]/archive` |
| `/[project]/agents` | `app/[project]/agents/page.tsx` | Roster view + editor. Reads `sssf.config.yaml` via `readRoster()`, enriches each agent with `getDb().agentTelemetry()`, surfaces `rosterWarnings()`. Renders `<RosterEditor>`. `force-dynamic`. | roster YAML (file) + `agent_sessions` table | via child component, POST/PUT/DELETE `/api/roster` |
| `/[project]/cost` | `app/[project]/cost/page.tsx` | Cross-run spend dashboard — grand totals + per-model breakdown with share bars. `force-dynamic`. | `getDb().costRollup()` | none |
| `/[project]/gates` | `app/[project]/gates/page.tsx` | Cross-run gate health — pass/fail/retry per gate type + recent failures list. `force-dynamic`. | `getDb().gateRollup()` | none |
| `/[project]/queue` | `app/[project]/queue/page.tsx` | Control-plane Kanban board — 6 lanes (queued/claimed/running/done/failed/canceled), `<QueueLauncher>` at top, `<CancelButton>` per active card. Live via `<LiveRefresh watch="queue">`. `force-dynamic`. | `getDb().queue()` + `readRecipes()` (disk) | via child components, POST `/api/queue`, POST `/api/queue/[id]/cancel` |
| `/[project]/runs/[adwId]` | `app/[project]/runs/[adwId]/page.tsx` | Run detail — header (+ archive), stat tiles, `<Waterfall>` (proportional phase timeline; clicking a block sets `?phase=` and opens `<PhaseDetail>`: agent config, compiled prompts off disk, per-component cost, phase-scoped gates/outputs/events), agents list, `<ModelStack>`, `<LiveTail>`. With no phase selected, shows the run-wide `<EnvelopePanel>`/`<GatePanel>` instead. `notFound()` if the session doesn't exist. `force-dynamic`. | `getDb().sessionDetail/events/envelopes/gates/runModelStack()` + prompt files (disk, via `lib/prompts.ts`) | archive via POST `/api/runs/[adwId]/archive` |
| `/[project]/skills` | `app/[project]/skills/page.tsx` | Read-only cookbook — one card per `adw_*.py` recipe, plus `<RecipeBuilder>` composer. `force-dynamic`. | `readRecipes()` (parses `.py` docstrings from disk, not db) | via child component, GET/POST `/api/adws` |
| `/[project]/sandboxes` | `app/[project]/sandboxes/page.tsx` | Control-plane sandbox list — one card per sandbox (status/branch/tip/worktree/land-result), `<NewSandboxButton>`, and per-active-sandbox `<LandButton>` + `<ShutdownButton>`; "run here →" deep-links an active one into the Conductor. Live via `<LiveRefresh watch="sandboxes">`. `force-dynamic`. | `getDb().sandboxes()` | via child components, POST `/api/sandboxes`, `/api/sandboxes/[id]/land`, `/api/sandboxes/[id]/shutdown` |

> **Note - the waterfall renders concurrency (fan-out) honestly.**
> `<Waterfall>` groups phases into one lane per role: `engineer`, `code`, and one per distinct
> `phases.owner`. A single-agent run draws two lanes; a full `adw_simple_sdlc` draws several
> stacked agent lanes; an ensemble review (`run.fan_out`, one lane per `pr_reviewer_*`) draws lanes
> that **overlap in time**. The block geometry lives in **`cockpit/lib/waterfall.ts`**
> (`waterfallLayout`, unit-tested in `waterfall.test.ts`) - the reserved request-zone, the
> min-block floor, and a **per-lane** shift-then-normalize pass. Per-lane (not global) is the key:
> the anti-overlap shift only resolves collisions *within* a lane, so blocks in different lanes may
> share the same x-range and concurrent phases stack at the same start instead of staircasing. A
> sequential run is unchanged - one phase per lane per step, each at its true proportional position.
> Verified against a real ensemble run (three reviewer lanes starting at the same instant, the
> synthesizer lane after the barrier).

### API routes (`app/api/**/route.ts`)

| Route | Method(s) | Purpose | Reads | Writes |
|---|---|---|---|---|
| `/api/adws` | GET, POST | ADW builder HTTP face. GET returns the block catalog; POST generates a script (`preview:true` returns source only). **The one write surface that spawns a process** — shells out to `uv run engine/adws/make_adw.py`. | disk (via generator) | new `.py` file in `engine/adws/` (non-preview only) |
| `/api/dashboard/stream` | GET | List-level SSE. `?watch=runs\|queue\|sandboxes`. Pushes `data: {sig}` only when the structural signature changes. Node runtime. Never auto-closes. | `db.sessions()` / `db.queue()` / `db.sandboxes()` every 300ms tick | none |
| `/api/queue` | GET, POST | Control seam HTTP face. GET lists `run_queue`; POST enqueues a launch spec — with `new_sandbox: {level}` it creates a sandbox and enqueues into it atomically (`enqueueInNewSandbox()`), else a plain `enqueue()`. Never spawns anything. | `getDb().queue()` | INSERT into `run_queue` (+ `sandboxes` for `new_sandbox`) via `getControl()` |
| `/api/queue/[id]/cancel` | POST | Ask a run to stop — cancels an unclaimed row outright, else flips `cancel_requested`. | — | UPDATE `run_queue` via `getControl().requestCancel()` |
| `/api/sandboxes` | POST | Sandbox control seam — INSERT a `requested` sandbox row (`getControl().createSandbox()`); the worker provisions the worktree. Never spawns anything. | — | INSERT into `sandboxes` |
| `/api/sandboxes/[id]/land` | POST | Ask the worker to run the sandbox's `land` hook once — flips `land_requested` (only on an `active` sandbox; else 404). | — | UPDATE `sandboxes.land_requested` via `getControl().requestLand()` |
| `/api/sandboxes/[id]/shutdown` | POST | Ask the worker to tear the sandbox down — flips `shutdown_requested`. | — | UPDATE `sandboxes.shutdown_requested` via `getControl().requestShutdown()` |
| `/api/roster` | GET, POST, PUT, DELETE | Config seam HTTP face. GET returns roster+warnings; POST patches allowlisted fields; PUT adds an agent + bootstraps its prompt files; DELETE removes one. | `sssf.config.yaml` | `sssf.config.yaml` (atomic temp+rename), + new `system.md`/`user.md` on PUT |
| `/api/runs/[adwId]/events` | GET | Non-streaming rowid-cursor poll: `?after=<rowid>&limit=` → `{events, cursor, has_more, status}`. Retained for parity with the engine's own visualizer; superseded by the SSE route for the live tail. | `db.events()` + `db.session()` | none |
| `/api/runs/[adwId]/stream` | GET | Per-run SSE live tail. Resumes from `Last-Event-ID` or `?after=`. Closes when `status !== 'running'`. Node runtime. | `db.events()` + `db.session()` | none |
| `/api/runs/[adwId]/archive` | POST | Review seam HTTP face — sets (or clears, `{archived:false}`) `sessions.archived` via `lib/review.ts`. Never spawns anything, never touches a run's trace. | — | UPDATE `sessions.archived` via `getReview().setArchived()` |
| `/api/projects/worker` | GET, POST | Per-project worker control (§1.5, [09-distribution.md](09-distribution.md) §7). GET → `{ attached, desired, registryMode, last_seen_at }` for the footer poll; POST flips `workerDesired` in the registry — **intent only**, the supervisor disposes. Never spawns anything. | `getDb(project).workerStatus()` (the `workers` heartbeat) | `workerDesired` in `atelier.projects.json` via `setWorkerDesired()` |

Every page catches its own load error and renders an inline error box rather than crashing — the
shell (Sidebar/Topbar/CommandPalette) never depends on the db, so a missing `sssf.db` only 500s
the data views.

## 1.5. Multi-project (the registry)

One cockpit fronts N stamped repos (distribution **Part E**). `cockpit/atelier.projects.json`
(override `ATELIER_PROJECTS`, `.example.json` committed) lists `{ id, name, root, adwsSubdir,
workerDesired? }` per project; `lib/projects.ts::pathsForProject(projectId)` turns the `[project]`
route segment into the four filesystem paths the engine layout needs (db, config, prompt dir, adws
dir), all derived from `root + adwsSubdir`. **When the file is absent**, the cockpit falls back to
one implicit `default` project resolved from the legacy `SSSF_*` env — so a single-project checkout
and every test that sets those vars works with zero registry config. The project-scoped
`app/[project]/layout.tsx` (`force-dynamic`) reads the registry, `404`s an unknown id, and renders
the switcher; only `{ id, name }` crosses to the client, never the filesystem `root`s. Full
mechanics — the supervisor, the `workers` heartbeat, stamping — are in
[09-distribution.md](09-distribution.md).

## 2. The lib layer

### The read path

- `lib/db.ts` — `AtelierDb`, server-only. Opens `sssf.db` `readonly: true` via `better-sqlite3`;
  throws if the file doesn't exist. Tolerates schema drift: `hasColumn()`/`optionalColumn()`
  probe `PRAGMA table_info` (cached, monotonic false→true so a live tracer `ALTER` is picked up)
  and substitute `NULL AS col` when a migration column is absent; `hasTable()` tolerates
  `run_queue` not existing yet. The db path is resolved *per project* by
  `pathsForProject()` (`lib/projects.ts`), not from env directly — the `AtelierDb` constructor takes
  the resolved path. Every query method's result is Zod-validated via
  `lib/schemas.ts`, except the hot `events()` path, which is cast. Methods summarized:
  `sessions()`, `session()`, `phases()`, `agentSessions()`, `sessionDetail()`, `usage()`,
  `runModelStack()`, `costRollup()`, `gateRollup()`, `agentTelemetry()`, `events()` (the
  rowid-cursor primitive shared by the poll route, the SSE route, and run-detail's initial
  load), `envelopes()`, `gates()`, `processes()`, `queue()`, `workerStatus()` (the `workers`
  heartbeat freshness), `sessionCount()`.
- `lib/data.ts` — `getDb(projectId)`: one `AtelierDb` **per resolved db path**, memoized in a `Map`
  on `globalThis.__atelierDbs` so Next's dev HMR reuses connections instead of leaking one per
  reload. Multi-project keys by path, so an env-fallback project and any id mapping to the same db
  share a connection. `getControl(projectId)`/`getReview(projectId)` memoize the same way.

### The seam mirror

- `lib/schemas.ts` — one Zod schema per table (`SessionRowSchema`, `PhaseRowSchema`,
  `EventRowSchema`, `EnvelopeRowSchema`, `GateResultRowSchema`, `ProcessRowSchema`,
  `AgentSessionRowSchema`, `RunQueueRowSchema`, `WorkerRowSchema`), keyed to the exact snake_case
  columns `tracer.py` writes. Migration-added columns are `.optional()`; `workers`' columns all
  ship in the `CREATE`, so none are optional (a fresh table is a hard requirement). `TABLE_COLUMNS`
  is *derived* from the schemas and is what `scripts/check-contract.ts` asserts against the live db.
- `lib/types.ts` — the frozen TS row interfaces, mirroring `engine/adws/adw_modules/tracer.py`'s
  `SCHEMA` one-for-one: `Session`, `Phase`, `Event`, `Envelope`, `GateResult`, `Process`,
  `AgentSession`, `RunQueueRow`, `WorkerRow`, plus enums (`EventType`, `QueueStatus`, ...) and
  composed/derived shapes (`SessionSummary`, `CostRollup`, `GateRollup`, `WorkerStatus`, ...).

Any change to a table in `tracer.py` must be mirrored in both files — see the seam contract in
[AGENTS.md](../AGENTS.md) and the engine side in [02-engine-runtime.md](02-engine-runtime.md).

### The write surfaces

- `lib/control.ts` — `AtelierControl`, server-only, the **only** write path into `sssf.db`. A
  separate read-write `better-sqlite3` connection that touches exactly the two control tables,
  `run_queue` and `sandboxes`: `enqueue()` INSERTs a launch spec (`adw_name` validated against the
  dynamic on-disk allowlist; an optional `sandbox_id` binds the run to a sandbox and is rejected if
  that sandbox can't host it), `requestCancel()` flips `cancel_requested` unconditionally and, for a
  still-`queued` row, finishes it outright so no process is ever spawned; `createSandbox()` INSERTs
  a `requested` sandbox row; `enqueueInNewSandbox()` does both in one transaction — creates a sandbox
  (its `purpose` = the run's `request`, so the worker names the branch from it) **and** enqueues the
  run bound to it, so the Conductor's "＋ new sandbox" launch is one round-trip with no orphan on a
  rejected enqueue; and `requestLand()` / `requestShutdown()` flip a sandbox's
  `land_requested` / `shutdown_requested` flag. Every write is an INSERT or a flag flip — the worker
  disposes. `getControl()` memoizes a singleton the same way `getDb()` does. Never writes
  `sessions/phases/events/envelopes/gates/processes` — only the ADW subprocess itself, via the
  tracer, writes a run's trace.
- `lib/roster.ts` — server-only, the second write surface: reads/writes the **file**
  `sssf.config.yaml`, not the db. Mirrors the Pydantic models in `data_types.py`
  (`SSSFConfig`/`AgentConfig`/`ConfigDefaults`) as Zod. Writes are surgical byte-range splices
  against a comment-preserving parsed `yaml.Document` — only a changed value's own bytes move —
  re-validated in full before ever touching disk, then written atomically (temp+rename).
  `addAgent()` bootstraps the new agent's two prompt files only after the YAML validates.
  `rosterWarnings()` surfaces advisory smells (e.g. `coding_agent: pi` routing an `anthropic/*`
  model) without hard-blocking. Full schema and semantics: [05-config-and-roster.md](05-config-and-roster.md).
- `lib/review.ts` — `AtelierReview`, server-only, the third write surface: a separate read-write
  `better-sqlite3` connection that writes exactly one column, `sessions.archived`, which the engine
  schema reserves for the UI ("review triage, set by the UI; never by a run"). Archiving is *reader*
  state — it drops a triaged run out of the review list (the read path already filters
  `archived = 0`) — so it's isolated from both the readonly reader and `control.ts` (the control
  tables only), and it never touches a run's trace or acceptance. `getReview()` memoizes a
  singleton like `getDb()`/`getControl()`; `canArchive` is false on a pre-migration db so the
  writer fails loudly rather than silently no-op'ing.

### Client-safe helpers

- `lib/nav.ts` — single source of truth for navigation (`NAV_OPERATE`/`NAV_FACTORY`/`NAV_OBSERVE`
  arrays; `NAV_ALL`/`DIGIT_VIEWS` derived from them so Sidebar and CommandPalette can't drift).
- `lib/adws.ts` — `AGENT_ROSTER` (hand-kept mirror of the config roster), `inferAdw(text)` (light
  NL→ADW regex mapping for the queue launcher). Deliberately `node:fs`-free.
- `lib/skills.ts` — server-only cookbook reader: parses `engine/adws/adw_*.py` docstrings
  directly off disk, no db access, no Python import.
- `lib/dashboard-signature.ts` — pure, FNV-1a `hash()` plus `queueSig()`/`runsSig()` — the
  structural-signature functions shared by the SSE route and the pages that seed it.
- `lib/format.ts` — pure display helpers (`compact`, `usd`, `usd4`, `duration`, `ago`, plus the
  waterfall's time-axis primitives `tsMs`, `fmtOffset`, `axisTicks`); durations/relative times are
  always derived at render time, never stored.
- `lib/model.ts` — pure `modelIdentity()` (a model id → provider bucket + short name), behind the
  monochrome provider tile in `ModelBadge`. Node-free, client-safe.
- `lib/adw-builder.ts` — see below.
- `lib/palette.ts` — `filterCommands()` for the command palette's fuzzy search.
- `lib/theme.ts` — `THEMES`, `THEME_INIT_SCRIPT` (pre-paint theme script), storage key.
- `lib/roster-constants.ts` — `CODING_AGENTS`/`THINKING_LEVELS`/`BUILTIN_TOOLS` plus shared
  validators, deliberately node-free so `RosterEditor.tsx` (a client component) can import them
  directly without pulling in `roster.ts`'s `node:fs`/`yaml` deps.

### Server-only vs client-safe

| Module | Server-only | Client-safe |
|---|---|---|
| `db.ts`, `data.ts`, `control.ts`, `review.ts`, `skills.ts`, `adw-builder.ts` | ✅ (`node:fs`, `better-sqlite3`, `node:child_process`) | |
| `roster.ts`, `prompts.ts` | ✅ (`node:fs`, `node:crypto`, `yaml`) | |
| `model.ts` | | ✅ (pure regex; no node imports) |
| `roster-constants.ts` | | ✅ (only its *types* are imported from `roster.ts`) |
| `schemas.ts`, `types.ts` | | ✅ (Zod + plain types; no node imports) |
| `nav.ts`, `adws.ts`, `dashboard-signature.ts`, `format.ts`, `palette.ts`, `theme.ts` | | ✅ |

This split matters because a `'use client'` component that imports a module with a node import —
even transitively — breaks the Next.js build (or silently bloats the client bundle). Keeping
`roster-constants.ts` and `adws.ts` node-free is what lets `RosterEditor.tsx` and `QueueLauncher`
exist as client components at all.

`lib/adw-builder.ts` is the one deliberate exception: it wraps `uv run engine/adws/make_adw.py`
to shell out and generate a new ADW `.py` script. `make_adw.py` is a pure deterministic code
generator — no model call, no db write, no run trace — and its output can be previewed
(`preview:true` → `--stdout`, writes nothing) before it's written to `engine/adws/`. It doesn't
break the determinism spine because `adw_worker.py` remains the sole thing that turns a queued
row into a *running* ADW — generating a recipe is not the same as running one. See
[04-authoring-adws.md](04-authoring-adws.md) for what `make_adw.py` generates.

## 3. The three live paths

### A. Per-run SSE

`app/api/runs/[adwId]/stream/route.ts` + `components/run/LiveTail.tsx`.

Server: `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`. Resumes from the `Last-Event-ID`
header or `?after=` on first connect. A 300ms pump calls `db.events(adwId, cursor, 500)` +
`db.session(adwId)?.status`, sending a frame only when there are new rows or the status changed.
15s heartbeat keeps idle proxies from dropping the connection. **The server closes the stream**
once `status !== null && status !== 'running'` — a terminal run ends the tail.

Client (`LiveTail`): only opens an `EventSource` while `status === 'running'`. Prepends new
events to local state (capped at 300 rows). If any event's `type` is structural
(`phase_start/phase_end/agent_start/agent_end/gate_pass/gate_fail/handoff/error`), it calls
`router.refresh()` so the server-rendered `Waterfall`/`ModelStack`/`EnvelopePanel`/`GatePanel` (and
`PhaseDetail`, when a phase is selected) re-paint; a status change away from `running` also
triggers a final refresh. Non-structural events
(`tool_call`, `log`) update only the local tail list.

### B. List-level SSE

`app/api/dashboard/stream/route.ts` + `components/LiveRefresh.tsx` + `components/LiveElapsed.tsx`.

Server: same Node-runtime/force-dynamic/heartbeat shape, scoped by `?watch=runs|queue`, and
**never auto-closes** (list views are always live). Each tick recomputes the structural
signature (`runsSig()`/`queueSig()` from `lib/dashboard-signature.ts`) and sends `data: {sig}`
only when it changed from the last value sent.

Client (`LiveRefresh`): headless (`return null`), tracks `lastSig` starting from an `initialSig`
prop computed by the page from the rows it just rendered, calls `router.refresh()` whenever an
incoming `sig` differs. Because the pages are `force-dynamic`, `router.refresh()` re-executes the
server component and re-queries sqlite — no client-side row state at all.

`LiveElapsed`: a tiny client leaf mounted only for `running` rows. A run's status doesn't change
while it runs, so the list-level signature never fires mid-run, yet the elapsed clock still needs
to tick. It seeds `useState` from the server's `serverNow` prop (matching first client render —
no hydration mismatch), then a `setInterval(1000)` takes over with real `Date.now()`.

### C. Signature-based smart refresh, end to end

1. A `force-dynamic` server page (`/` or `/queue`) queries sqlite, computes its own signature
   from the rows it's about to render, passes it as `<LiveRefresh initialSig=…>`.
2. `LiveRefresh` opens `/api/dashboard/stream?watch=…`; the route computes the same signature
   function against a fresh sqlite read every 300ms and only emits on change.
3. The client diffs the incoming `sig` against `lastSig` and calls `router.refresh()` only on a
   real change — no refresh storm on load, no refresh for state already on screen.
4. `router.refresh()` re-runs the RSC, which re-queries sqlite (WAL mode lets reads pass through
   the tracer's concurrent writes) — there is no client cache to invalidate.

Because `better-sqlite3` is synchronous and incompatible with the Edge runtime, every route that
touches it — both SSE routes, and implicitly the others via `getDb()`/`getControl()` — declares
`export const runtime = 'nodejs'`.

## 4. The design system — "Monolith Signal"

`components/terminal.tsx` holds the primitives, all server-component-friendly (no state or
handlers): `Dot`/`dotState` (maps engine statuses onto a strict `DotState = 'ok'|'warn'|'err'|'off'`,
`pulse` only on `ok`), `Badge` (`BadgeTone = 'default'|'accent'|'ok'|'warn'|'err'`, `ghost` for
dashed-border pills), `Label` (the `LABEL  count ————` section-header pattern used across nearly
every page), `SectionHead`, `Stat`, `Kbd`, `Spark`.

Two token layers:

1. `app/globals.css` — the CSS custom properties per theme (`--bg`, `--surface`, `--text`,
   `--accent`, `--ok`, `--warn`, `--err`, ...) under three selectors: `:root`/`mono` (default,
   white on black), `mono-light` ("Daylight"), `dark` ("Terminal", phosphor green). **Strict
   traffic-light rule**: `--ok`/`--warn`/`--err` are the only three colors in the system besides
   the mono grey ramp — color means status, nothing else.
2. `tailwind.config.ts` — maps the `os-*` Tailwind namespace onto those CSS vars, plus
   `fontFamily.mono` → JetBrains Mono (`next/font/google`, loaded in `app/layout.tsx`), plus
   zeroed-out `rounded-*` values — sharp corners everywhere, part of the terminal aesthetic.

`globals.css` also defines the motion vocabulary — LED-blink pulse, a `▌` caret-blink suffix on
page `<h1>`s, an 8px translateY route-change entrance, hover border-brighten only — all gated
behind `prefers-reduced-motion`.

Theme switching: `<html data-theme>` is set pre-paint by an inline script
(`THEME_INIT_SCRIPT` from `lib/theme.ts`, injected in `app/layout.tsx`'s `<head>`) reading
`localStorage['atelier-theme']`, and toggled at runtime by `components/ThemeToggle.tsx` (cycles
mono → mono-light → dark → mono).

Shell: `components/Sidebar.tsx` (fixed left rail, three `NavGroup`s built from `lib/nav.ts`),
`components/Topbar.tsx` (breadcrumb, `ThemeToggle`, palette trigger), `components/CommandPalette.tsx`
(`⌘K`, digit keys `1`–`9` jump to `DIGIT_VIEWS[n-1]`, fuzzy filter via `lib/palette.ts`).

## 5. Commands & the client/server boundary rules

| Command | Where | Effect |
|---|---|---|
| `pnpm dev` | `cockpit/` | `next dev -H 127.0.0.1 -p 4200` |
| `pnpm typecheck` | `cockpit/` | `tsc --noEmit` |
| `pnpm check:contract` | `cockpit/` | `tsx scripts/check-contract.ts` — asserts every `TABLE_COLUMNS` entry exists in the live `sssf.db` (hard fail) or is a known migration column (warn) |
| `pnpm build` | `cockpit/` | `next build` |
| `pnpm start` | `cockpit/` | `next start -p 4200` |

Env vars (`.env.local`, gitignored, resolved relative to `cockpit/`'s cwd when relative):

- `ATELIER_PROJECTS` — path to the multi-project registry (default `cockpit/atelier.projects.json`).
  When the registry file is **present** it supplies every project's paths and the `SSSF_*` vars
  below are unused; when **absent**, the cockpit falls back to a single `default` project resolved
  from them (§1.5).
- `SSSF_DB` — path to `sssf.db` (default `../engine/adws/adw_data/sssf.db`) — fallback-mode only.
- `SSSF_CONFIG` — path to `sssf.config.yaml` (default `../engine/adws/adw_sssf_config/sssf.config.yaml`) — fallback-mode only.
- `SSSF_ADWS_DIR` — path to the ADW scripts dir (default `../engine/adws`) — fallback-mode only.
- `SSSF_PE_DIR` — where `addAgent()` bootstraps prompt files; only relocates where the cockpit
  writes, not the fixed repo-root-relative path written into the YAML — fallback-mode only.

What must stay node-free: `lib/roster-constants.ts` and `lib/adws.ts` (so their client
consumers, `RosterEditor.tsx` and `QueueLauncher`, don't drag `node:fs`/`yaml` into the browser
bundle). Every `db.ts`/`data.ts`/`control.ts`/`skills.ts`/`roster.ts`/`adw-builder.ts` module is
imported only from server components or `route.ts` files, never directly from a `'use client'`
component — a node import reaching a client-imported module breaks the build. All routes and
pages touching live data declare `dynamic = 'force-dynamic'`, and every route touching
`better-sqlite3` declares `runtime = 'nodejs'`. Operational context (running the worker, kicking
demo runs, reading the db from the CLI) is in [07-operations.md](07-operations.md).

## Extending this subsystem

- **Add a page/view** — a `force-dynamic` server component reading `getDb()`; catch your own
  load error and render an inline error box rather than letting the page crash.
- **Add a db query method** — add it to `lib/db.ts`, Zod-validate the result via
  `lib/schemas.ts`. After adding a method, **restart `pnpm dev`** — the connection is memoized on
  `globalThis`, so HMR alone won't pick it up.
- **Add an API route** — restart `pnpm dev` too; Next's dev HMR misses newly added routes.
- **Change a table** — keep `lib/schemas.ts`/`lib/types.ts` in lockstep with `tracer.py` and run
  `pnpm check:contract` (see [02-engine-runtime.md](02-engine-runtime.md) and
  [AGENTS.md](../AGENTS.md) for the seam contract).

Full recipes and worked examples live in [08-extending-the-system.md](08-extending-the-system.md).
