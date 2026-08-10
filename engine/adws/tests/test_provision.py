"""provision.py - interpolation + env assembly (pure).

`interpolate` is a security-relevant boundary: values splice into shell strings,
so ONLY `${IDENT}` may be substituted and everything else must pass through
verbatim. base_ctx/run_env are pure dict assembly.
"""
from __future__ import annotations

from adw_modules import provision
from adw_modules.data_types import SandboxProfile


class TestInterpolate:
    def test_substitutes_known_identifier(self):
        assert provision.interpolate("port ${WEB}", {"WEB": "5000"}) == "port 5000"

    def test_unknown_identifier_left_verbatim(self):
        assert provision.interpolate("${UNKNOWN}", {"WEB": "5000"}) == "${UNKNOWN}"

    def test_leaves_shell_syntax_untouched(self):
        # $VAR, $(cmd), $$ must all survive so an operator's shell string works.
        raw = "$HOME and $(date) and $$ and ${WEB}"
        assert provision.interpolate(raw, {"WEB": "80"}) == "$HOME and $(date) and $$ and 80"

    def test_multiple_substitutions(self):
        out = provision.interpolate("${A}-${B}-${A}", {"A": "1", "B": "2"})
        assert out == "1-2-1"


class TestBaseCtx:
    def test_carries_id_branch_and_ports(self):
        ctx = provision.base_ctx("abc123", "feat/x", {"WEB": 5000, "DB": 5432})
        assert ctx["SANDBOX_ID"] == "abc123"
        assert ctx["BRANCH"] == "feat/x"
        assert ctx["WEB"] == "5000" and ctx["DB"] == "5432"


class TestRunEnv:
    def test_ports_become_env_plus_interpolated_profile_env(self):
        profile = SandboxProfile(
            ports={"DB": "auto"},
            env={"DATABASE_URL": "postgres://localhost:${DB}/app", "STATIC": "x"},
        )
        env = provision.run_env(profile, {"DB": 5432}, "sid", "feat/x")
        assert env["DB"] == "5432"
        assert env["DATABASE_URL"] == "postgres://localhost:5432/app"
        assert env["STATIC"] == "x"

    def test_empty_profile_just_ports(self):
        env = provision.run_env(SandboxProfile(), {"WEB": 8080}, "sid", "b")
        assert env == {"WEB": "8080"}


class TestAllocatePorts:
    def test_distinct_ports_per_name(self):
        ports = provision.allocate_ports(["A", "B", "C"])
        assert set(ports) == {"A", "B", "C"}
        assert len(set(ports.values())) == 3
        assert all(isinstance(p, int) for p in ports.values())

    def test_empty(self):
        assert provision.allocate_ports([]) == {}
