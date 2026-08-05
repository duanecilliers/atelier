---
name: atelier
description: >-
  Stamp the Atelier software factory (the ADW engine) into any git repo, and pull
  later Atelier improvements into a stamped repo without clobbering your own roster,
  prompts, or custom ADWs. Use when the user wants to install Atelier into a project,
  "stamp" or "add the engine" to a repo, or update a stamped repo's engine.
---

# Atelier — stamp & update

Atelier is a software factory: agents propose, deterministic code disposes. This
skill installs its **engine** (the `adws/` ADW machinery) into a target repo and
keeps it current. The **cockpit** (the trace UI) stays central — one app observes
many stamped repos — so nothing Next.js is stamped per repo.

This skill is a **thin router**: the real logic lives in your Atelier checkout and
reads the engine payload **live** from `engine/adws/`, so there is no vendored copy
to drift. Set `ATELIER` to your checkout once:

```sh
ATELIER=/path/to/atelier        # your Atelier repo
```

## Stamp the engine into a repo

```sh
uv run "$ATELIER/engine/adws/install.py" /path/to/target-repo   # add --init for a fresh dir
```

Generates the engine into `target/adws/` at the native layout, writes a starter
`adws/adw_sssf_config/sssf.config.yaml` (roster runs on `claude_code` — the local
`claude` CLI login, **no API key**), a `justfile`, `.env.sample`, and
`.atelier/manifest.json`. Then:

```sh
cd /path/to/target-repo && cp .env.sample .env && just demo
```

## Update a stamped repo

```sh
uv run "$ATELIER/engine/adws/update.py" /path/to/target-repo
```

Refreshes only the **managed** set (the code in the manifest). Your roster, prompts,
and any ADWs/skills you added are **not** in the manifest, so they are never touched.
A managed file you edited by hand is reported and written beside as `<file>.atelier-new`
rather than clobbered.

## The buckets (why updates are safe)

- **MANAGED** — `adws/adw_modules/*.py`, `adws/adw_*.py`. In the manifest; the updater
  keeps them current. New engine modules/ADWs are **discovered by scanning**, so they
  stamp automatically — no registry to edit.
- **USER** — `sssf.config.yaml`, `adws/adw_data/prompt_engineering/**`, your own ADWs,
  prompts, skills. Stamped once (or added by you) and never in the manifest → invisible
  to updates. This is how you extend a stamped repo: add new things; they are yours.
- **RUNTIME** — `adws/adw_data/sessions/`, `sssf.db*`. Gitignored, never stamped.

## Version

The stamp records the Atelier checkout's git sha (`atelier_version` in the manifest).
For the live version of your checkout: `git -C "$ATELIER" rev-parse --short HEAD`.
