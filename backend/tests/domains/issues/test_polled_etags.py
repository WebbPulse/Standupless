"""Weak ETags on the stable reads the frontend polls most often.

Each read answers a weak `ETag` over its body, and a poll that sends the tag
back in `If-None-Match` while nothing changed gets a 304 with an empty body, so
a quiet poll moves no payload.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from tests.domains.helpers import MEMBER, sign_in
from tests.domains.issues.conftest import TEAM, WORKSPACE, create_issue

BASE = f"/api/workspaces/{WORKSPACE}"

POLLED_READS = [
    ("teams", f"{BASE}/teams"),
    ("teams", f"{BASE}/teams/{TEAM}/statuses"),
    ("teams", f"{BASE}/teams/{TEAM}/labels"),
    ("teams", f"{BASE}/teams/{TEAM}/members"),
    ("workspaces", f"{BASE}/members"),
    ("views", f"{BASE}/views"),
]
"""The domain serving each polled list read, and the path it answers."""


def _client(repositories: Any, name: str) -> Iterator[TestClient]:
    """A signed in client for one domain's application, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS[name])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        sign_in(test_client, MEMBER)
        yield test_client


@pytest.fixture
def issues_client(repositories: Any) -> Iterator[TestClient]:
    """A signed in client for the issues application."""
    yield from _client(repositories, "issues")


@pytest.mark.parametrize(("domain", "path"), POLLED_READS)
def test_a_quiet_list_poll_answers_304_to_its_own_etag(
    repositories: Any, workspace: str, domain: str, path: str
) -> None:
    """Sending back the tag of an unchanged list answers a 304 with no body."""
    for client in _client(repositories, domain):
        first = client.get(path)
        etag = first.headers["etag"]
        second = client.get(path, headers={"If-None-Match": etag})

        assert first.status_code == 200, first.text
        assert etag.startswith('W/"')
        assert first.headers["cache-control"] == "private, no-cache"
        assert second.status_code == 304
        assert second.content == b""
        assert second.headers["etag"] == etag


@pytest.mark.parametrize(("domain", "path"), POLLED_READS)
def test_a_list_poll_with_a_stale_tag_reads_the_full_body(
    repositories: Any, workspace: str, domain: str, path: str
) -> None:
    """A tag that does not match the current body is answered with the body."""
    for client in _client(repositories, domain):
        response = client.get(path, headers={"If-None-Match": 'W/"stale"'})

        assert response.status_code == 200, response.text
        assert response.json() == client.get(path).json()


def test_a_quiet_issue_poll_answers_304(issues_client: TestClient, workspace: str) -> None:
    """The issue detail read answers 304 to its own tag while the issue is unchanged."""
    issue = create_issue(issues_client, workspace)
    path = f"{BASE}/issues/{issue['id']}"

    first = issues_client.get(path)
    second = issues_client.get(path, headers={"If-None-Match": first.headers["etag"]})

    assert first.status_code == 200, first.text
    assert first.json()["id"] == issue["id"]
    assert second.status_code == 304
    assert second.content == b""


def test_an_edited_issue_answers_a_new_etag(issues_client: TestClient, workspace: str) -> None:
    """Once the issue changes, the old tag is not honoured and the poll reads the edit."""
    issue = create_issue(issues_client, workspace)
    path = f"{BASE}/issues/{issue['id']}"
    stale = issues_client.get(path).headers["etag"]

    edited = issues_client.patch(path, json={"title": "Renamed"})
    response = issues_client.get(path, headers={"If-None-Match": stale})

    assert edited.status_code == 200, edited.text
    assert response.status_code == 200, response.text
    assert response.headers["etag"] != stale
    assert response.json()["title"] == "Renamed"


def test_a_quiet_poll_by_key_answers_304(issues_client: TestClient, workspace: str) -> None:
    """The by-key read the issue page polls answers 304 to its own tag too."""
    issue = create_issue(issues_client, workspace)
    path = f"{BASE}/issues/by-key/{issue['key']}"

    first = issues_client.get(path)
    second = issues_client.get(path, headers={"If-None-Match": first.headers["etag"]})

    assert first.status_code == 200, first.text
    assert second.status_code == 304
