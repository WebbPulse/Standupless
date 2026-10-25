"""Changing a workspace's URL slug, against real tables in moto.

A changed slug keeps the old one as an alias row in `slug-index`, so a lookup
by the old slug still lands on the workspace and no other workspace can take it.
These hold the alias resolution, the refusals of a live or retired slug, taking
back a slug the workspace itself retired, the daily limit and the audit row.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.workspaces import SLUG_CHANGE_LIMIT, SlugChangeLimited, SlugTaken, slug_alias_id
from tests.domains.helpers import ADMIN, MEMBER, OWNER, add_member, make_user, make_workspace, sign_in

WORKSPACE = "01JB00000000000000000000WS"

OTHER_WORKSPACE = "01JB0000000000000000000WS2"

PATH = f"/api/workspaces/{WORKSPACE}"


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client for the workspaces application, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["workspaces"])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def workspaces(repositories: Any) -> None:
    """Two workspaces, `acme` with an admin and a member and `other` beside it."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    make_workspace(repositories, OTHER_WORKSPACE, "other", OWNER)
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")


def test_an_admin_changes_the_slug_and_the_old_one_still_resolves(
    client: TestClient, repositories: Any, workspaces: None
) -> None:
    """The row moves to the new slug, the old slug resolves to it through its alias, and reads name both."""
    sign_in(client, ADMIN)

    response = client.patch(PATH, json={"slug": " Acme-Labs "})

    assert response.status_code == 200, response.text
    assert response.json()["slug"] == "acme-labs"
    assert response.json()["retired_slugs"] == ["acme"]
    assert repositories.workspaces.get_by_slug("acme").id == WORKSPACE
    assert repositories.workspaces.get_by_slug("acme-labs").id == WORKSPACE
    assert repositories.workspaces.get(slug_alias_id("acme")) is None
    listed = client.get("/api/workspaces").json()["workspaces"]
    assert [(row["slug"], row["retired_slugs"]) for row in listed] == [("acme-labs", ["acme"])]


def test_a_slug_another_workspace_holds_or_retired_is_refused(
    client: TestClient, repositories: Any, workspaces: None
) -> None:
    """A live slug and a retired one are both taken for every other workspace, on change and on create."""
    sign_in(client, ADMIN)
    assert client.patch(PATH, json={"slug": "other"}).status_code == 409

    moved = repositories.workspaces.change_slug(OTHER_WORKSPACE, "other-co")
    assert moved is not None and moved.slug == "other-co"

    refused = client.patch(PATH, json={"slug": "other"})
    assert refused.status_code == 409
    assert refused.json()["error_code"] == "CONFLICT"
    assert repositories.workspaces.get(WORKSPACE).slug == "acme"
    with pytest.raises(SlugTaken):
        repositories.workspaces.change_slug(WORKSPACE, "other")

    make_user(repositories, MEMBER, "member@example.com")
    repositories.users.update(MEMBER, email_verified=True)
    sign_in(client, MEMBER)
    assert client.post("/api/workspaces", json={"name": "Other", "slug": "other"}).status_code == 409


def test_a_workspace_takes_back_a_slug_it_retired(client: TestClient, repositories: Any, workspaces: None) -> None:
    """Moving back to an earlier slug drops that alias and keeps the one just left."""
    sign_in(client, ADMIN)
    client.patch(PATH, json={"slug": "acme-labs"})

    back = client.patch(PATH, json={"slug": "acme"})

    assert back.status_code == 200, back.text
    assert back.json()["slug"] == "acme"
    assert back.json()["retired_slugs"] == ["acme-labs"]
    assert repositories.workspaces.get_by_slug("acme-labs").id == WORKSPACE
    assert repositories.workspaces.slug_holder("acme") == WORKSPACE


def test_a_bad_or_reserved_slug_is_refused_and_a_member_cannot_change_it(
    client: TestClient, repositories: Any, workspaces: None
) -> None:
    """The slug follows the same rules as creation, and changing it is admin work."""
    sign_in(client, ADMIN)
    assert client.patch(PATH, json={"slug": "no spaces"}).status_code == 422
    assert client.patch(PATH, json={"slug": "ab"}).status_code == 422
    assert client.patch(PATH, json={"slug": "settings"}).status_code == 422

    sign_in(client, MEMBER)
    assert client.patch(PATH, json={"slug": "acme-labs"}).status_code == 403
    assert repositories.workspaces.get(WORKSPACE).slug == "acme"


def test_slug_changes_are_limited_per_day(client: TestClient, repositories: Any, workspaces: None) -> None:
    """Past the daily limit a change is refused with 429, and the window rolls forward."""
    sign_in(client, ADMIN)
    for index in range(SLUG_CHANGE_LIMIT):
        assert client.patch(PATH, json={"slug": f"acme-{index}"}).status_code == 200

    limited = client.patch(PATH, json={"slug": "acme-more"})

    assert limited.status_code == 429
    assert limited.json()["error_code"] == "RATE_LIMITED"
    assert repositories.workspaces.get(WORKSPACE).slug == f"acme-{SLUG_CHANGE_LIMIT - 1}"
    with pytest.raises(SlugChangeLimited):
        repositories.workspaces.change_slug(WORKSPACE, "acme-more")
    tomorrow = utc_now() + timedelta(days=1, minutes=1)
    later = repositories.workspaces.change_slug(WORKSPACE, "acme-more", now=tomorrow)
    assert later is not None and later.slug == "acme-more"


def test_a_slug_change_is_audit_logged(client: TestClient, repositories: Any, workspaces: None) -> None:
    """The audit log records the slug before and after."""
    sign_in(client, ADMIN)
    client.patch(PATH, json={"slug": "acme-labs"})

    [row] = [
        event
        for event in repositories.audit.list_events(WORKSPACE).events
        if event.action == "workspace.updated" and "slug" in (event.after or {})
    ]
    assert (row.before, row.after) == ({"slug": "acme"}, {"slug": "acme-labs"})


def test_slug_availability_answers_as_an_admin_types(client: TestClient, repositories: Any, workspaces: None) -> None:
    """Each reason a slug is unavailable is named, and a free or own retired slug is available."""
    sign_in(client, ADMIN)
    client.patch(PATH, json={"slug": "acme-labs"})

    def check(slug: str) -> dict[str, Any]:
        """The availability answer for one slug."""
        response = client.get(f"{PATH}/slug-availability", params={"slug": slug})
        assert response.status_code == 200, response.text
        return response.json()

    assert check("fresh-name") == {"slug": "fresh-name", "available": True, "reason": None}
    assert check("acme")["available"] is True
    assert check("acme-labs")["reason"] == "current"
    assert check("other")["reason"] == "taken"
    assert check("a b")["reason"] == "invalid"
    assert check("billing")["reason"] == "reserved"

    sign_in(client, MEMBER)
    assert client.get(f"{PATH}/slug-availability", params={"slug": "x-y-z"}).status_code == 403


def test_alias_rows_never_read_as_workspaces(repositories: Any, workspaces: None) -> None:
    """Scans and id reads skip alias rows, and a purge frees every slug the workspace held."""
    repositories.workspaces.change_slug(WORKSPACE, "acme-labs")

    assert {workspace.id for workspace in repositories.workspaces.list_active()} == {WORKSPACE, OTHER_WORKSPACE}
    assert set(repositories.workspaces.get_many([WORKSPACE, slug_alias_id("acme")])) == {WORKSPACE}

    repositories.workspaces.delete(WORKSPACE)

    assert repositories.workspaces.slug_holder("acme") is None
    assert repositories.workspaces.get_by_slug("acme") is None
