# Guide — Stamping Atelier into `repayd` (bare-repo + worktrees)

> **Status: PLANNING companion to [`atelier-distribution.md`](atelier-distribution.md).** This
> maps that (still-PROPOSED) design onto the *specific* shape of `~/Projects/tmg/repayd.git`.
> Nothing here is built yet either; it exists so the first real stamp into repayd doesn't
> re-derive the layout decisions. Read the parent note first — this only covers what's different
> about repayd.

## The target, in one paragraph

`repayd.git` is a **bare repo with sibling worktrees**, not a normal checkout:

```
/Users/duane/Projects/tmg/repayd.git/         ← bare repo (HEAD, objects, worktrees/, packed-refs)
├── shared/                                    ← worktree-AGNOSTIC files, symlinked into each worktree
│   ├── .claude/  .agents/  .mcp.json          ← agent config already lives here
│   ├── .env  .env.testing                     ← shared Laravel env
│   ├── AGENTS.md  CLAUDE.md→AGENTS.md          ← shared agent guide
│   └── private-docs/
├── scripts/init-worktree.sh                   ← wires a new worktree to shared/ (symlinks + Sail)
├── master/                                    ← a worktree (branch master)
├── master-feature-REP-528-…/                  ← a worktree (one per active branch)
└── …                                          ← ~9 live worktrees
```

It's a **Laravel/PHP app run through Sail (Docker)**. Quality is `composer test` (`artisan test`)
and `composer lint` (rector · php-cs-fixer · phpstan · phpmd · phpcpd), all executed **inside the
Sail container**. Remote is **Bitbucket**, not GitHub.

Two facts drive everything below:

1. **`git rev-parse --show-toplevel` inside a worktree returns the worktree path, not the bare
   repo.** Verified: from `…/repayd.git/master` it returns `…/repayd.git/master`. Atelier's
   `repo_root()` (`git_helper.py:39`) is exactly this call, so **each worktree is its own repo
   root** to the engine — agents spawn there, writes-allowlists resolve there, commit phases
   commit to that branch. That's *good*: it's what worktrees are for.
2. **`shared/` is already the "one place worktree-agnostic machinery lives, symlinked in."** That
   is precisely the seam the distribution design needs. Atelier should stamp into `shared/`, and
   the seam DB should live there too — so runs from any branch land in one trace.

## The recommended shape: one project, DB in `shared/`

```
repayd.git/
├── shared/
│   ├── adws/                        ← STAMP TARGET (native SSSF layout, no engine/ prefix)
│   │   ├── adw_modules/              MANAGED (in the manifest)
│   │   ├── adw_*.py                 MANAGED starters + your custom ADWs (USER, not in manifest)
│   │   ├── adw_sssf_config/
│   │   │   └── sssf.config.yaml      USER (roster + the repayd `quality:` block)
│   │   └── adw_data/                RUNTIME (gitignored)
│   │       └── sssf.db               ← THE SEAM — one DB for all worktrees
│   └── .atelier/manifest.json       written by install.py; drives updates
├── master/
│   └── adws → ../shared/adws        ← symlinked in by init-worktree.sh (like .claude, AGENTS.md)
└── master-feature-…/
    └── adws → ../shared/adws
```

- **One cockpit project = `repayd`**, pointed at `shared/adws/adw_data/sssf.db`. Every run, on
  every branch, in every worktree, writes to this one DB. The trace already records which branch
  the run committed to, so you keep cross-branch visibility in a single timeline instead of nine
  near-identical projects.
- **Agents still work in the worktree** (their `repo_root()` = the worktree via cwd), so a run
  kicked in `master-feature-REP-528` edits and commits *that* branch, while its trace flows to the
  shared DB. Worktree isolation for the work, shared seam for the observation. This is the whole
  point of the layout, and it composes perfectly with Atelier.

> **Alternative — per-worktree DBs (N projects).** If you ever want a branch's trace fully
> isolated (e.g. throwaway experiments), stamp `adws/adw_data/` as a *real* dir in that worktree
> instead of symlinking, and register it as its own cockpit project. Costs you the unified
> timeline and adds a project row per branch. Only reach for it if shared-DB contention or
> per-branch cleanup actually bites. Default to the shared DB.

## What must be built before repayd can run (status check)

I checked the atelier tree. Here's the real state, not the design note's aspiration:

| Part | Design note | **Actual status in atelier** | Needed for repayd? |
| --- | --- | --- | --- |
| **B — `quality:` in config** | "do first" | ✅ **Built** (uncommitted: `quality.py` + `data_types.py` are `QualityCheckConfig`-driven; `_placeholder` gone) | Yes — you'll fill the block with Sail commands |
| **D — worker resolves git-root** | proposed | ❌ **Not done.** `adw_worker.py:43` still `Path(__file__).resolve().parents[2]` and `:82` joins `"engine"/"adws"` | **Yes, and it's worse here** (see below) |
| **A — `atelier` skill + `install.py`** | proposed | ❌ Not built (no `install.py`, no `~/.claude/skills/atelier/`) | Yes, to stamp cleanly (or do the first stamp by hand) |
| **C — manifest + `update.py`** | proposed | ❌ Not built | Only when you want to *pull* later atelier fixes |
| **E — multi-project cockpit** | proposed | ❌ Not built (four env resolvers, single-project) | Only to *observe* repayd in the cockpit |
| **F — supervisor + heartbeat** | proposed | ❌ Not built | Only for always-on workers / the "start" button |

### The Part D hazard is sharper under `shared/adws` symlinks

The design note flags that `adw_worker.py` hardcodes `parents[2]` and `engine/adws`. In repayd it
fails **two** ways at once:

1. **No `engine/` segment** — stamped layout is `adws/`, so `parents[2]` and the `"engine"/"adws"`
   join are both wrong (same as any stamped repo).
2. **Symlink resolution** — because each worktree's `adws` is a *symlink* to `../shared/adws`,
   `Path(__file__).resolve()` follows the link. `__file__` becomes
   `…/repayd.git/shared/adws/adw_worker.py`, so `parents[2]` = `…/repayd.git` (the **bare repo**),
   not the worktree the agent should build in. Any `__file__`-relative path logic is poison here.

**The fix is the one the note already prescribes, and it's symlink-safe for free:** resolve the
root via `git_helper.repo_root()` (which runs `git rev-parse --show-toplevel` from **cwd**, not
`__file__`) and derive the adws dir from `repo_root / adwsSubdir` (or the config). Because it's
cwd-based, a worker launched with `cwd=<worktree>` correctly gets the worktree as root even though
the script it's executing lives behind a symlink in `shared/`. Do **not** try to patch `parents[N]`
— audit for *any* `Path(__file__)`-relative resolution in the modules and confirm it's all
git-/cwd-based before running the worker here.

## Step-by-step: the first stamp (by hand, before `install.py` exists)

You can stamp today without waiting for Part A — `install.py` just automates this.

```bash
BARE=/Users/duane/Projects/tmg/repayd.git

# 1. Lay the engine into shared/ in native SSSF layout (no engine/ prefix).
#    Source is atelier's engine, minus its self-hosting engine/ nesting.
mkdir -p "$BARE/shared/adws"
cp -R /Users/duane/Dev/atelier/engine/adws/adw_modules "$BARE/shared/adws/"
cp /Users/duane/Dev/atelier/engine/adws/adw_*.py       "$BARE/shared/adws/"
mkdir -p "$BARE/shared/adws/adw_sssf_config"
# start the config from atelier's, then strip every `engine/` path prefix (see next section)
cp /Users/duane/Dev/atelier/engine/adws/adw_sssf_config/sssf.config.yaml \
   "$BARE/shared/adws/adw_sssf_config/sssf.config.yaml"

# 2. Keep the runtime + DB out of git. shared/ files are symlinked into worktrees where
#    .gitignore already ignores them, but be explicit in each worktree's ignore too.
echo "adws/adw_data/" >> "$BARE/shared/adws/.gitignore"   # or the worktree .gitignore

# 3. Symlink adws into every worktree (matches how .claude / AGENTS.md are wired).
for wt in "$BARE"/master "$BARE"/master-*; do
  ln -sfn ../shared/adws "$wt/adws"
done
```

Then **teach `init-worktree.sh` to do step 3 for future worktrees.** It already symlinks
`private-docs`, `CLAUDE.md`, `AGENTS.md` and auto-links anything gitignored in `shared/`. Add
`adws` to the always-linked list (the `for item in "private-docs" "CLAUDE.md" "AGENTS.md"` loop),
or — cleaner — just make sure `adws/` is gitignored in the worktree so its existing
"symlink anything gitignored in shared/" loop picks it up automatically. The latter needs no script
edit.

## The repayd `quality:` block (Part B is built — just fill it)

Quality runs with **cwd = repo_root = the worktree**, and repayd's checks live inside Sail, so
call `./vendor/bin/sail`. `argv` is a list, never a shell string:

```yaml
# shared/adws/adw_sssf_config/sssf.config.yaml
quality:
  test:      { argv: ["./vendor/bin/sail", "artisan", "test"], area: backend, operation: test, timeout: 900 }
  cs:        { argv: ["./vendor/bin/sail", "composer", "cs"],       area: backend, operation: lint }
  phpstan:   { argv: ["./vendor/bin/sail", "composer", "phpstan"],  area: backend, operation: typecheck }
  # rector/phpmd/phpcpd available via `composer lint`; add blocks as you want them gated.
  # Omit a block to skip it. An empty/absent quality: block runs NOTHING and says so — no fake green.
```

Two caveats specific to Sail-in-worktrees:

- **Each worktree runs its own Sail stack** with offset ports (`init-worktree.sh` assigns
  `HTTP_PORT`, `DB_PORT`, etc. per worktree). Because quality runs with cwd = the worktree,
  `./vendor/bin/sail` targets *that* worktree's containers — correct by construction, but the
  containers for the branch under test must be **up** (`sail up -d`) or the check errors rather
  than fails. Decide whether the ADW/worker should `sail up` first, or whether you require the
  stack running before a run.
- **`vendor/bin/sail` is per-worktree** (not shared), and `init-worktree.sh` runs `composer
  install` on setup, so it exists. But a brand-new worktree that hasn't been initialized has no
  `vendor/` — don't point a run at an un-initialized worktree.

## Also strip the `engine/` prefix from the stamped config

Atelier's own config is `engine/`-prefixed because it self-hosts under `engine/`. The stamped
repayd config uses the **native `adws/` layout**, so every path loses `engine/`:

```yaml
# atelier (self-hosting)                → repayd (stamped)
protected_files: [engine/adws/adw_modules/, …]  →  [adws/adw_modules/, adws/adw_sssf_config/, adws/adw_*.py]
data_dir: engine/adws/adw_data                  →  adws/adw_data
observability.db: engine/adws/adw_data/sssf.db  →  adws/adw_data/sssf.db
prompt_engineering.system: engine/adws/adw_data/prompt_engineering/…  →  adws/adw_data/prompt_engineering/…
```

`writes:` allowlists are **already repo-root-relative** (they don't carry `engine/`), so those map
straight over — except the *values* change to repayd's tree: `specs/`, `docs/`, `app/`, `domain/`,
`tests/`, etc. instead of atelier's.

Also set the backend for this machine:

```yaml
defaults:
  coding_agent: claude_code   # pi's Anthropic OAuth is expired here; Claude rides the Agent SDK.
                              # (openai-codex/* still works through pi if you want a pi agent.)
```

## Running a run (once B + D are in place)

From inside any worktree — the cwd *is* the project root the agents build in:

```bash
cd /Users/duane/Projects/tmg/repayd.git/master-feature-REP-528-redis-merchant-channel-cache
uv run adws/adw_scout.py --config adws/adw_sssf_config/sssf.config.yaml "map the redis cache layer"
```

- `repo_root()` → this worktree. Agents read/edit/commit **this branch**.
- Trace → `shared/adws/adw_data/sssf.db` (via the `adws` symlink) → the one shared timeline.
- A read-only scout works **today** with just the by-hand stamp (no worker, no Part D). The worker
  loop (`just worker`) and any gated build needs Part D landed first.

## Cockpit wiring (Part E — when you want to watch it)

Until multi-project lands, point the single-project cockpit at repayd via env and it just works as
"the repayd cockpit":

```bash
# cockpit/.env.local
SSSF_DB=/Users/duane/Projects/tmg/repayd.git/shared/adws/adw_data/sssf.db
SSSF_CONFIG=/Users/duane/Projects/tmg/repayd.git/shared/adws/adw_sssf_config/sssf.config.yaml
SSSF_ADWS_DIR=/Users/duane/Projects/tmg/repayd.git/shared/adws
SSSF_PE_DIR=/Users/duane/Projects/tmg/repayd.git/shared/adws/adw_data/prompt_engineering
```

When Part E ships, this becomes one row in `cockpit/atelier.projects.json`:

```json
{ "id": "repayd", "name": "Repayd",
  "root": "/Users/duane/Projects/tmg/repayd.git/shared",
  "adwsSubdir": "adws" }
```

Note `root` is **`shared/`**, not a worktree and not the bare repo — because that's where the
stamped `adws/` and the seam DB live. `adwsSubdir: "adws"` reconciles it with atelier's own
`engine/adws`. If you later go per-worktree (the rejected alternative), you'd add one row per
worktree with its own `root`.

## repayd-specific gotchas (call these out)

- **Bitbucket, not GitHub.** Any ADW phase that opens a PR via `gh` won't work — repayd pushes to
  `git@bitbucket.org:quboticlabs/repayd.git`. Commit phases (plain `git commit` in the worktree)
  are fine; PR-open phases need a Bitbucket path or should stop at "pushed the branch." repayd
  already has its own `shared/.agents/skills/pr-*` skills — lean on those for the PR step rather
  than teaching an ADW to open Bitbucket PRs.
- **`__file__`-relative anything is unsafe** under the `shared/adws` symlink — see Part D above.
  Audit the modules; everything must resolve via `git rev-parse` (cwd) or config, never
  `Path(__file__).parents[...]`.
- **Sail must be up** for the worktree under test, and `vendor/`/`node_modules` must be installed
  (they are, if `init-worktree.sh` ran). Don't run against an un-initialized worktree.
- **`sssf.db` is gitignored and lives in `shared/`** (a gitignored-symlink area) — it will never be
  committed to any branch, which is what you want. Double-check no worktree's `.gitignore` tracks
  `adws/` as real content.
- **Skill scope.** The design ships the `atelier` skill at user scope
  (`~/.claude/skills/atelier/`). repayd *also* has a vendored `shared/.claude/skills` +
  `shared/.agents/skills` convention — you could drop a copy there for a self-contained checkout.
  Either works; user-scope means one `atelier update` reaches every repo.

## Minimal path to "it runs in repayd"

1. **Commit atelier's Part B** (it's sitting uncommitted in your tree) so the stamped `quality.py`
   is the data-driven one.
2. **Do Part D** — make `adw_worker.py` (and any `__file__`-relative module logic) resolve via
   `git_helper.repo_root()`. This is the one true blocker for the worktree layout.
3. **Hand-stamp** `shared/adws/` per the steps above; strip `engine/` from the config; write the
   Sail `quality:` block; set `coding_agent: claude_code`.
4. **Symlink `adws` into a worktree** and run a read-only `adw_scout` from it — confirm the trace
   lands in `shared/adws/adw_data/sssf.db`.
5. **Point the cockpit** at that DB via env and watch the run.
6. Everything else (install.py/update.py, multi-project routing, supervisor) is convenience layered
   on top — build it when the by-hand version gets annoying.
