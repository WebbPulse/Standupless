"""The link routes: inverses, idempotency and the visibility rule on a target.

A link is two rows sharing one `link_id`, so these hold that both sides see it,
that removing it from either side removes both, and that the asymmetric types
read as their inverse from the far end.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from tests.domains.helpers import GUEST, OWNER, sign_in
from tests.domains.issues.conftest import OTHER_PROJECT, create_issue


@pytest.fixture
def pair(client: TestClient, workspace: str, statuses: Any) -> "tuple[dict[str, Any], dict[str, Any]]":
    """Two issues in the same project, for one link to join."""
    sign_in(client, OWNER)
    return create_issue(client, workspace, title="Source"), create_issue(client, workspace, title="Target")


def _link(client: TestClient, workspace: str, source: Any, target: Any, kind: str = "blocks") -> Any:
    """Create one link through the route, failing loudly on a refusal."""
    response = client.post(
        f"/api/workspaces/{workspace}/issues/{source['id']}/links",
        json={"type": kind, "target_issue_id": target["id"]},
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_a_link_is_readable_from_both_ends(client: TestClient, workspace: str, pair: Any) -> None:
    """One write produces one row per direction, sharing a `link_id`."""
    source, target = pair
    created = _link(client, workspace, source, target)

    forward = client.get(f"/api/workspaces/{workspace}/issues/{source['id']}/links").json()["links"]
    backward = client.get(f"/api/workspaces/{workspace}/issues/{target['id']}/links").json()["links"]

    assert [row["type"] for row in forward] == ["blocks"]
    assert [row["type"] for row in backward] == ["blocked_by"]
    assert forward[0]["link_id"] == backward[0]["link_id"] == created["link_id"]


def test_duplicate_of_reads_as_duplicated_by_from_the_far_side(client: TestClient, workspace: str, pair: Any) -> None:
    """The asymmetric type the contract admits in one direction only."""
    source, target = pair
    _link(client, workspace, source, target, "duplicate_of")

    backward = client.get(f"/api/workspaces/{workspace}/issues/{target['id']}/links").json()["links"]

    assert backward[0]["type"] == "duplicated_by"


def test_relates_to_is_symmetric(client: TestClient, workspace: str, pair: Any) -> None:
    """Both sides read the same type, which is what symmetric means."""
    source, target = pair
    _link(client, workspace, source, target, "relates_to")

    backward = client.get(f"/api/workspaces/{workspace}/issues/{target['id']}/links").json()["links"]

    assert backward[0]["type"] == "relates_to"


def test_linking_the_same_pair_and_type_twice_is_idempotent(client: TestClient, workspace: str, pair: Any) -> None:
    """A retried create answers the original link rather than making a second."""
    source, target = pair
    first = _link(client, workspace, source, target)
    second = _link(client, workspace, source, target)

    assert first["link_id"] == second["link_id"]
    assert first["created_at"] == second["created_at"]

    listed = client.get(f"/api/workspaces/{workspace}/issues/{source['id']}/links").json()["links"]
    assert len(listed) == 1


def test_the_same_pair_may_hold_two_different_types(client: TestClient, workspace: str, pair: Any) -> None:
    """The type is inside the key, so two types on one pair do not collide."""
    source, target = pair
    _link(client, workspace, source, target, "blocks")
    _link(client, workspace, source, target, "relates_to")

    listed = client.get(f"/api/workspaces/{workspace}/issues/{source['id']}/links").json()["links"]

    assert {row["type"] for row in listed} == {"blocks", "relates_to"}


def test_a_link_carries_the_far_side_key_and_title(client: TestClient, workspace: str, pair: Any) -> None:
    """The join is what lets the UI render a link without a second request."""
    source, target = pair
    created = _link(client, workspace, source, target)

    assert created["target_key"] == target["key"]
    assert created["target_title"] == target["title"]


def test_a_self_link_is_refused(client: TestClient, workspace: str, pair: Any) -> None:
    """The contract makes a self link a 422 rather than a silent no-op."""
    source, _ = pair

    response = client.post(
        f"/api/workspaces/{workspace}/issues/{source['id']}/links",
        json={"type": "blocks", "target_issue_id": source["id"]},
    )
    assert response.status_code == 422


def test_a_target_the_caller_cannot_see_is_a_404(client: TestClient, workspace: str, statuses: Any) -> None:
    """An invisible target must not be linkable, or ids become guessable."""
    sign_in(client, OWNER)
    source = create_issue(client, workspace, title="Source")
    hidden = create_issue(client, workspace, project_id=OTHER_PROJECT, title="Hidden")

    sign_in(client, GUEST)
    response = client.post(
        f"/api/workspaces/{workspace}/issues/{source['id']}/links",
        json={"type": "blocks", "target_issue_id": hidden["id"]},
    )
    assert response.status_code == 404


def test_a_target_that_does_not_exist_is_a_404(client: TestClient, workspace: str, pair: Any) -> None:
    """Absent and invisible answer the same way."""
    source, _ = pair

    response = client.post(
        f"/api/workspaces/{workspace}/issues/{source['id']}/links",
        json={"type": "blocks", "target_issue_id": "01JB00000000000000000GONE"},
    )
    assert response.status_code == 404


def test_deleting_a_link_removes_both_directions(client: TestClient, workspace: str, pair: Any) -> None:
    """One delete on either side clears the pair, because they share an id."""
    source, target = pair
    created = _link(client, workspace, source, target)

    response = client.delete(f"/api/workspaces/{workspace}/issues/{source['id']}/links/{created['link_id']}")
    assert response.status_code == 204

    assert client.get(f"/api/workspaces/{workspace}/issues/{source['id']}/links").json()["links"] == []
    assert client.get(f"/api/workspaces/{workspace}/issues/{target['id']}/links").json()["links"] == []


def test_deleting_a_link_that_is_not_there_is_a_404(client: TestClient, workspace: str, pair: Any) -> None:
    """A repeated delete is not found rather than a silent success."""
    source, _ = pair

    response = client.delete(f"/api/workspaces/{workspace}/issues/{source['id']}/links/01JB0000000000000000NOPE")
    assert response.status_code == 404


def test_deleting_an_issue_removes_the_links_that_touch_it(client: TestClient, workspace: str, pair: Any) -> None:
    """Both senses go, so the far side is not left pointing at nothing."""
    source, target = pair
    _link(client, workspace, source, target)

    client.delete(f"/api/workspaces/{workspace}/issues/{source['id']}")

    assert client.get(f"/api/workspaces/{workspace}/issues/{target['id']}/links").json()["links"] == []


def test_a_link_write_records_activity(client: TestClient, workspace: str, pair: Any) -> None:
    """Linking and unlinking are both history the contract names."""
    source, target = pair
    created = _link(client, workspace, source, target)
    client.delete(f"/api/workspaces/{workspace}/issues/{source['id']}/links/{created['link_id']}")

    feed = client.get(f"/api/workspaces/{workspace}/issues/{source['id']}/activity").json()["activity"]
    kinds = [row["kind"] for row in feed]

    assert kinds[0] == "link_removed"
    assert "link_added" in kinds
