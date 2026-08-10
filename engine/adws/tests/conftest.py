"""Shared fixtures for the engine test suite.

Deliberately small: an in-memory sqlite connection for the control-plane seam
tests, and a throwaway git repo for the permissions/git tests. Nothing here
calls a model or the network.
"""
from __future__ import annotations

import sqlite3
import subprocess
from pathlib import Path

import pytest


@pytest.fixture
def conn():
    """An in-memory sqlite connection with row-name access (matches the engine's
    own `conn.row_factory = sqlite3.Row`)."""
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    try:
        yield c
    finally:
        c.close()


class Repo:
    """A throwaway git repo with helpers for the permissions/git tests."""

    def __init__(self, path: Path):
        self.path = path

    def git(self, *args: str) -> str:
        return subprocess.run(
            ["git", *args], cwd=self.path, check=True, capture_output=True, text=True
        ).stdout

    def write(self, rel: str, content: str = "x\n") -> Path:
        p = self.path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
        return p


@pytest.fixture
def repo(tmp_path) -> Repo:
    r = Repo(tmp_path)
    r.git("init", "-q", "-b", "main")
    r.git("config", "user.email", "t@example.com")
    r.git("config", "user.name", "Test")
    r.git("commit", "-q", "--allow-empty", "-m", "init")
    return r
