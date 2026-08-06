# Install

How this repo's engine got here, and how to keep it current. There is no installer inside this skill — Atelier stamps a repo **live** from its own checkout, and the same checkout is where later improvements come from.

## How the stamp works

The engine under `adws/` was stamped into this repo by Atelier's own `install.py`, run **from an Atelier checkout** and pointed at this repo:

```bash
uv run engine/adws/install.py <target>       # from an Atelier checkout, once
```

It reads the engine payload live from that checkout — there are no vendored `templates/` to drift — and records a `.atelier/manifest.json` mapping every **managed** file to its sha256. That manifest is the provenance record `just update` reads later to know what it may touch.

## The three buckets

Everything under this repo falls into exactly one bucket. Only the first is Atelier's to move.

| Bucket | What | In the manifest? |
|---|---|---|
| **MANAGED** | `adws/adw_modules/*.py`, `adws/adw_*.py`, and this `atelier` skill | yes — sha256 recorded |
| **USER** | `adws/adw_sssf_config/sssf.config.yaml`, `adws/adw_data/prompt_engineering/**`, and any ADWs you authored | no — never touched |
| **RUNTIME** | `adws/adw_data/sessions/`, `sssf.db*` | no — gitignored, created as runs execute |

The line that matters: your roster, your prompts, and your own ADW scripts are **never** in the manifest, so an update can never overwrite them. The engine code and the skill are managed, so they *can* be refreshed to Atelier's current version on demand.

## Keeping the engine current

To pull later Atelier improvements into this repo:

```bash
just update <path-to-atelier-checkout>        # runs: uv run <atelier>/engine/adws/update.py .
```

Only the MANAGED set moves. For each managed file, `update` compares the on-disk file against its recorded hash:

- **Unchanged since stamp** → refreshed in place to the checkout's current version.
- **Hand-edited since stamp** → *not* clobbered. The new version is written beside it as `<file>.atelier-new` for you to diff and reconcile by hand.

USER and RUNTIME files are outside the manifest, so `update` never reads or writes them. Your config and prompts are safe across every update.

## Post-stamp checklist

1. **Env** — `cp .env.sample .env`. The default `claude_code` roster needs **no key** (it uses your local `claude` CLI login). Only a pi-backed non-Anthropic agent needs its provider key set in `.env`.
2. **Git repo** — ADWs that end in a commit phase call `git_helper.commit_all`, which raises if the cwd is not a git repository. Run `git init` and make a first commit before using `adw_plan_build.py`, `adw_plan_build_test.py`, or `adw_simple_sdlc.py`. `adw_document.py` needs one too: it measures the change with `git diff` against a base ref (`main` by default, `--base` to override).
3. **Smoke test** — `just demo` runs two cheap read-only workflows back to back, or run the smallest ADW directly:

```bash
just demo                                                    # both, end to end
uv run adws/adw_prompt.py "reply with a one-line summary of this repo"   # the raw form
```

Green means the whole path works: config validated, session minted, the backend ran, envelope parsed, events landed in `adws/adw_data/sssf.db`. Verify the trace exists before trusting anything larger:

```bash
just sessions
sqlite3 adws/adw_data/sssf.db "select adw_id, status from sessions order by started_at desc limit 1;"
```

4. **Watch it in the cockpit** — the UI is the central Atelier cockpit, one Next.js app that observes many stamped repos. To have it watch this repo, register it in the cockpit's `atelier.projects.json`:

```json
{ "id": "myrepo", "name": "My Repo", "root": "/abs/path/to/this/repo", "adwsSubdir": "adws" }
```

If the smoke test fails, fix it before composing chains — every multi-agent ADW rides on this exact path.
