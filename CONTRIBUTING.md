# Contributing to Atelier

Thanks for your interest in Atelier. This project is built phase-by-phase, and
contributions that respect its core invariants are very welcome.

Please read **[`AGENTS.md`](AGENTS.md)** first — it's the canonical contract for
the architecture, the engine/cockpit seam, and the invariants to preserve.

## Getting set up

- **Engine** (Python): each ADW is a self-contained PEP 723 `uv` script, so
  `uv run` needs no separate install. Run ADWs **from the repo root**, e.g.
  `just demo` or `uv run engine/adws/adw_prompt.py --config engine/adws/adw_sssf_config/sssf.config.yaml "<prompt>"`.
- **Cockpit** (Next.js): `cd cockpit && pnpm install && pnpm dev` → http://127.0.0.1:4200.

## The gates

There is **no unit-test suite and no linter**. Two automated checks stand in,
and both must pass:

```bash
cd cockpit && pnpm typecheck        # TypeScript
cd cockpit && pnpm check:contract   # the engine↔cockpit seam contract
```

You verify behavior by kicking a real ADW and reading its trace (this calls a
model and costs a few cents). See `docs/` for the long-form guides.

## The #1 rule: the seam contract

The engine's SQLite schema lives in Python (`engine/adws/adw_modules/tracer.py`).
The cockpit mirrors it in **two** files that must stay in lockstep —
`cockpit/lib/types.ts` and `cockpit/lib/schemas.ts`. **Any change to a table in
`tracer.py` must be mirrored in both**, or reader drift silently corrupts the
seam. Run `pnpm check:contract` after any schema change.

## Commits & pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/) — e.g.
  `feat(gates): …`, `fix(prompts): …`, `docs: …`. Keep commits small, focused,
  and each in a working state.
- Open a PR against `main` with a clear description of the change and why.
- Please do **not** include generated-by / `Co-Authored-By` footers in commits
  or PR descriptions.

## Reporting issues

Bugs and ideas are welcome via GitHub Issues. For security concerns, follow
[`SECURITY.md`](SECURITY.md) instead of opening a public issue.
