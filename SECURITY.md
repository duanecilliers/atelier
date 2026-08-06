# Security

## Reporting a vulnerability

If you find a security issue, please report it privately by opening a
[GitHub security advisory](https://github.com/duanecilliers/atelier/security/advisories/new)
rather than a public issue. We aim to acknowledge reports within a few days.

## Secrets and credentials

This repository stores **no** API keys, tokens, or credentials. Coding-agent
authentication is delegated to each backend's own local login, outside the repo:

- **`pi` backend** — reads its auth from `~/.pi/agent` (e.g. `~/.pi/agent/models.json`).
- **`claude_code` backend** — uses the local `claude` CLI's own login via the
  Claude Agent SDK. There is **no** Anthropic API key in the repo or its config.

## Environment files

`.env` files are gitignored and must never be committed. Copy the tracked
templates instead:

- `engine/.env.sample` → `engine/.env` (engine env, e.g. `PI_MODELS_PATH` — a
  local file path, not a secret).
- `cockpit/.env.local` — holds `SSSF_DB`, an absolute path to the local
  `sssf.db`. Runtime-only; gitignored.

## Runtime data

The trace database (`engine/adws/adw_data/sssf.db*`) and session artifacts
(`engine/adws/adw_data/sessions/`) contain run traces and are gitignored. Do not
commit or distribute them.
