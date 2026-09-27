"""Shared fixtures: an isolated config dir, an in-memory keyring and a mocked API.

No test touches the real keyring, the user's config file or the network.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import keyring
import pytest
import respx
from keyring.backend import KeyringBackend
from keyring.errors import PasswordDeleteError
from typer.testing import CliRunner

from standupless_cli.main import app

BASE = "https://api.test"
WS = "ws-1"
TEAM = {
    "id": "team-1",
    "name": "Engineering",
    "key_prefix": "ENG",
    "workspace_id": WS,
    "estimate_scale": "fibonacci",
    "created_at": "2026-09-01T00:00:00Z",
    "updated_at": "2026-09-01T00:00:00Z",
    "member_count": 2,
}
STATUSES = [
    {"id": "st-done", "name": "Done", "category": "completed", "position": 4},
    {"id": "st-todo", "name": "Todo", "category": "unstarted", "position": 1},
    {"id": "st-backlog", "name": "Backlog", "category": "backlog", "position": 0},
    {"id": "st-doing", "name": "In Progress", "category": "started", "position": 2},
    {"id": "st-cancel", "name": "Canceled", "category": "cancelled", "position": 5},
]
LABELS = [{"id": "lb-bug", "name": "Bug", "color": "#f00"}, {"id": "lb-ui", "name": "UI", "color": "#0f0"}]
MEMBERS = [
    {"user_id": "u-me", "email": "me@example.com", "display_name": "Me", "role": "owner", "joined_at": "x"},
    {"user_id": "u-ada", "email": "ada@example.com", "display_name": "Ada", "role": "member", "joined_at": "x"},
]
WORKSPACE = {"id": WS, "name": "Acme", "slug": "acme", "plan": "free", "created_at": "x", "role": "owner"}


def make_issue(**overrides: Any) -> dict[str, Any]:
    """An issue as the API returns it, with overrides."""
    issue = {
        "id": "is-12",
        "key": "ENG-12",
        "number": 12,
        "title": "Fix the login page",
        "status_id": "st-todo",
        "priority": "high",
        "assignee_id": "u-ada",
        "label_ids": ["lb-bug"],
        "team_id": TEAM["id"],
        "workspace_id": WS,
        "created_by": "u-me",
        "created_at": "2026-09-01T00:00:00Z",
        "updated_at": "2026-09-02T00:00:00Z",
        "progress": {},
        "body": "Steps to reproduce.",
    }
    issue.update(overrides)
    return issue


class MemoryKeyring(KeyringBackend):
    """A keyring that forgets everything when the test ends."""

    def __init__(self) -> None:
        super().__init__()
        self.store: dict[tuple[str, str], str] = {}

    def get_password(self, service: str, username: str) -> str | None:
        """Look up a stored secret."""
        return self.store.get((service, username))

    def set_password(self, service: str, username: str, password: str) -> None:
        """Store a secret."""
        self.store[(service, username)] = password

    def delete_password(self, service: str, username: str) -> None:
        """Delete a secret, failing like real backends when there is none."""
        if (service, username) not in self.store:
            raise PasswordDeleteError("missing")
        del self.store[(service, username)]


@pytest.fixture
def memory_keyring() -> Iterator[MemoryKeyring]:
    """Swap the OS keyring for a dictionary."""
    previous = keyring.get_keyring()
    backend = MemoryKeyring()
    keyring.set_keyring(backend)
    yield backend
    keyring.set_keyring(previous)


@pytest.fixture(autouse=True)
def isolated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, memory_keyring: MemoryKeyring) -> Path:
    """Point config at a temp dir and clear every STANDUPLESS_ variable."""
    for name in list(os.environ):
        if name.startswith("STANDUPLESS_"):
            monkeypatch.delenv(name)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    monkeypatch.setenv("COLUMNS", "200")
    return tmp_path


@pytest.fixture
def logged_in(monkeypatch: pytest.MonkeyPatch) -> None:
    """A key and workspace from the environment, the way CI and scripts run the CLI."""
    monkeypatch.setenv("STANDUPLESS_BASE_URL", BASE)
    monkeypatch.setenv("STANDUPLESS_WEB_URL", "https://web.test")
    monkeypatch.setenv("STANDUPLESS_API_KEY", "wpk_test")
    monkeypatch.setenv("STANDUPLESS_WORKSPACE", "acme")


@pytest.fixture
def api() -> Iterator[respx.MockRouter]:
    """A mocked API with the workspace's lookups already answered."""
    with respx.mock(base_url=BASE, assert_all_called=False) as router:
        router.get("/api/workspaces").respond(json={"workspaces": [WORKSPACE]})
        router.get(f"/api/workspaces/{WS}/teams").respond(json={"teams": [TEAM]})
        router.get(f"/api/workspaces/{WS}/teams/team-1/statuses").respond(json={"statuses": STATUSES})
        router.get(f"/api/workspaces/{WS}/teams/team-1/labels").respond(json={"labels": LABELS})
        router.get(f"/api/workspaces/{WS}/members").respond(json={"members": MEMBERS})
        yield router


@pytest.fixture
def runner() -> CliRunner:
    """A CLI runner."""
    return CliRunner()


def invoke(runner: CliRunner, *args: str, input: str | None = None) -> Any:
    """Run the app with arguments."""
    return runner.invoke(app, list(args), input=input)
