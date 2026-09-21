"""Fixtures the views route tests share: a client, a tenant and seeded issues.

The tenant is the same authorization matrix the issues tests use, because the
board, search and saved views all decide team visibility for themselves rather
than inheriting it from a path parameter. Two teams exist so a guest has
something to be outside of, which is what makes "not found rather than empty"
testable.

Issues are seeded through the `issues` application rather than written into the
table, so they carry the key, counter and index attributes a real row has. The two
domains are composed into separate applications, which keeps the seeding path
honest without the views image ever importing the issues one.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from tests.domains.helpers import (
    ADMIN,
    GUEST,
    MEMBER,
    OWNER,
    add_member,
    add_team_member,
    make_team,
    make_user,
    make_workspace,
)

WORKSPACE = "01JB00000000000000000000WS"

TEAM = "01JB000000000000000000PRJ1"

OTHER_TEAM = "01JB000000000000000000PRJ2"


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client for the views application, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["views"])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def issues_client(repositories: Any) -> Iterator[TestClient]:
    """A client for the issues application, used only to seed rows.

    Kept apart from the views client so the views application under test is exactly
    the one the image builds, and so a test cannot accidentally assert against a
    route the views function does not serve.
    """
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["issues"])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def workspace(repositories: Any) -> str:
    """A workspace with two teams and one member of each workspace role.

    The guest is a member of `TEAM` alone, so `OTHER_TEAM` is the thing a
    guest must not reach through any of this domain's routes.
    """
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    add_member(repositories, WORKSPACE, GUEST, "guest")
    make_user(repositories, OWNER, "owner@example.com", "Olive Owner")
    make_user(repositories, ADMIN, "admin@example.com", "Adam Admin")
    make_user(repositories, MEMBER, "member@example.com", "Mo Member")
    make_user(repositories, GUEST, "guest@example.com", "Gale Guest")
    make_team(repositories, WORKSPACE, TEAM, "ABC")
    make_team(repositories, WORKSPACE, OTHER_TEAM, "XYZ")
    add_team_member(repositories, WORKSPACE, TEAM, GUEST, "member")
    return WORKSPACE


@pytest.fixture
def statuses(repositories: Any, workspace: str) -> "dict[str, Any]":
    """The seeded statuses of `TEAM`, keyed by category."""
    rows = repositories.team_config.list_statuses(workspace, TEAM)
    return {row.category: row for row in rows}


def seed_issue(issues_client: TestClient, workspace_id: str, **payload: Any) -> "dict[str, Any]":
    """Create one issue through the issues route, failing loudly on a refusal."""
    body: "dict[str, Any]" = {"team_id": TEAM, "title": "An issue"}
    body.update(payload)
    response = issues_client.post(f"/api/workspaces/{workspace_id}/issues", json=body)
    assert response.status_code == 201, response.text
    return response.json()
