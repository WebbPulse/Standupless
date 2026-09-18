"""Fixtures the issues route tests share: a client and a seeded two-project tenant.

The tenant is the authorization matrix in table form. Two projects exist so the
guest invariant has something to be outside of and the fan-out list has something
to merge, and the guest holds a membership in exactly one of them.
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
    add_project_member,
    make_project,
    make_workspace,
)

WORKSPACE = "01JB00000000000000000000WS"

PROJECT = "01JB000000000000000000PRJ1"

OTHER_PROJECT = "01JB000000000000000000PRJ2"


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client for the issues application, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["issues"])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def workspace(repositories: Any) -> str:
    """A workspace with two projects and one member of each workspace role.

    The guest is a member of `PROJECT` alone, which is what makes `OTHER_PROJECT`
    the thing a guest must not see in any list or reach by id.
    """
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    add_member(repositories, WORKSPACE, GUEST, "guest")
    make_project(repositories, WORKSPACE, PROJECT, "ABC")
    make_project(repositories, WORKSPACE, OTHER_PROJECT, "XYZ")
    add_project_member(repositories, WORKSPACE, PROJECT, GUEST, "member")
    return WORKSPACE


@pytest.fixture
def statuses(repositories: Any, workspace: str) -> "dict[str, Any]":
    """The seeded statuses of `PROJECT`, keyed by category.

    Named by category rather than id, so a test that moves an issue to a finished
    column reads as what it means instead of as an opaque id.
    """
    rows = repositories.project_config.list_statuses(workspace, PROJECT)
    return {row.category: row for row in rows}


def create_issue(client: TestClient, workspace_id: str, **payload: Any) -> "dict[str, Any]":
    """Create one issue through the route, failing loudly on a refusal.

    Going through the route rather than the repository is deliberate: an issue
    seeded straight into the table would skip the counter, and a key collision
    would then only show up in a later test.
    """
    body = {"project_id": PROJECT, "title": "An issue"}
    body.update(payload)
    response = client.post(f"/api/workspaces/{workspace_id}/issues", json=body)
    assert response.status_code == 201, response.text
    return response.json()
