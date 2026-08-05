# Atelier engine recipes — run from the repo (git) root.
#
# The engine lives in engine/ but shares this repo's git root, so ADWs run as
# `uv run engine/adws/...` from here and every config path is engine/-prefixed.
# The cockpit (the trace UI) is a separate Next.js app: `cd cockpit && pnpm dev`.

set dotenv-path := "engine/.env"
set positional-arguments

# SSSF_CONFIG swaps the whole roster for one run.
config := env_var_or_default("SSSF_CONFIG", "engine/adws/adw_sssf_config/sssf.config.yaml")
db     := "engine/adws/adw_data/sssf.db"

# list every recipe
default:
    @just --list

# ── first run ───────────────────────────────────────────────────────────────

# start here: two cheap read-only runs, end to end
demo:
    @echo "1/2  adw_prompt: one agent, one prompt"
    uv run engine/adws/adw_prompt.py --config {{config}} --agent scout "reply with a one-line summary of this repo"
    @echo "\n2/2  adw_scout: read-only recon"
    uv run engine/adws/adw_scout.py --config {{config}} "list the top-level directories in this repo and what each is for. change nothing."
    @echo "\nboth done. now run:  just sessions    (or: cd cockpit && pnpm dev)"

# ── run a workflow ──────────────────────────────────────────────────────────
# Args pass straight through: "<prompt or path/to/prompt.md>" [--adw-id X]

# one agent, one prompt: just prompt "summarize this repo"
prompt *ARGS:
    uv run engine/adws/adw_prompt.py --config {{config}} "$@"

# read-only recon: just scout "where is auth handled"
scout *ARGS:
    uv run engine/adws/adw_scout.py --config {{config}} "$@"

# plan only: just plan "add a /health endpoint"
plan *ARGS:
    uv run engine/adws/adw_plan.py --config {{config}} "$@"

# planner, builder, commit: just plan-build "add a /health endpoint"
plan-build *ARGS:
    uv run engine/adws/adw_plan_build.py --config {{config}} "$@"

# plan, build, test, commit: just sdlc "add a /health endpoint"
sdlc *ARGS:
    uv run engine/adws/adw_plan_build_test.py --config {{config}} "$@"

# the full chain, plus review and docs: just simple-sdlc "add a /health endpoint"
simple-sdlc *ARGS:
    uv run engine/adws/adw_simple_sdlc.py --config {{config}} "$@"

# ── watch it ────────────────────────────────────────────────────────────────
# The cockpit (cd cockpit && pnpm dev) is the real UI; these are quick sqlite peeks.

# the last 10 runs
sessions:
    @sqlite3 {{db}} "select adw_id, status, substr(request,1,50), total_tokens, round(total_cost,4) from sessions order by started_at desc limit 10;"

# phase status in sequence: just phases <adw_id>
phases ADW_ID:
    @sqlite3 {{db}} "select seq, name, kind, owner, status, attempt from phases where adw_id='{{ADW_ID}}' order by seq;"

# the live event tail: just tail <adw_id>
tail ADW_ID:
    @sqlite3 {{db}} "select rowid, type, name, started_at from events where adw_id='{{ADW_ID}}' order by rowid desc limit 25;"

# what a run has alive right now, with pids: just procs <adw_id>
procs ADW_ID:
    @sqlite3 {{db}} "select kind, name, pid, command, started_at from processes where adw_id='{{ADW_ID}}' and ended_at is null order by id;"
