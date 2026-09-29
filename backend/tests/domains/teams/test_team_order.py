"""The caller's own sidebar team order, saved on their workspace membership.

These cover SUP-46: the order persists per person and per workspace, teams it
does not name follow it, and teams that are gone or hidden drop out quietly.
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
    make_workspace,
    sign_in,
)

WORKSPACE = "01JB00000000000000000000WS"

OTHER_WORKSPACE = "01JB00000000000000000000W2"

ALPHA = "01JB000000000000000000PRJ1"

BRAVO = "01JB000000000000000000PRJ2"

CHARLIE = "01JB000000000000000000PRJ3"


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client for the teams application, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["teams"])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def workspace(repositories: Any) -> str:
    """A workspace with three teams, an owner, an admin, a member and a guest."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    add_member(repositories, WORKSPACE, GUEST, "guest")
    make_team(repositories, WORKSPACE, ALPHA, "ALP")
    make_team(repositories, WORKSPACE, BRAVO, "BRA")
    make_team(repositories, WORKSPACE, CHARLIE, "CHA")
    return WORKSPACE


def _listed(client: TestClient, workspace: str) -> list[str]:
    """The team ids the list route answers, in its order."""
    response = client.get(f"/api/workspaces/{workspace}/teams")
    assert response.status_code == 200
    return [team["id"] for team in response.json()["teams"]]


def _put(client: TestClient, workspace: str, team_ids: list[str]) -> Any:
    """Save an order through the route."""
    return client.put(f"/api/workspaces/{workspace}/teams/order", json={"team_ids": team_ids})


def test_the_list_is_oldest_first_before_any_order_is_saved(client: TestClient, workspace: str) -> None:
    """With nothing saved the order is the default one."""
    sign_in(client, MEMBER)
    assert _listed(client, workspace) == [ALPHA, BRAVO, CHARLIE]


def test_a_saved_order_persists_and_is_answered_by_the_list(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """The put answers the reordered list, and a later read keeps it."""
    sign_in(client, MEMBER)
    response = _put(client, workspace, [CHARLIE, ALPHA, BRAVO])

    assert response.status_code == 200
    assert [team["id"] for team in response.json()["teams"]] == [CHARLIE, ALPHA, BRAVO]
    assert _listed(client, workspace) == [CHARLIE, ALPHA, BRAVO]
    membership = repositories.memberships.get(workspace, MEMBER)
    assert membership.team_order == [CHARLIE, ALPHA, BRAVO]
    assert membership.role == "member"


def test_the_order_is_per_person(client: TestClient, workspace: str) -> None:
    """One member's order does not move anyone else's list."""
    sign_in(client, MEMBER)
    _put(client, workspace, [BRAVO, CHARLIE, ALPHA])

    sign_in(client, ADMIN)
    assert _listed(client, workspace) == [ALPHA, BRAVO, CHARLIE]


def test_the_order_is_per_workspace(client: TestClient, workspace: str, repositories: Any) -> None:
    """The same person keeps a separate order in each workspace."""
    make_workspace(repositories, OTHER_WORKSPACE, "other", MEMBER)
    sign_in(client, MEMBER)
    _put(client, workspace, [CHARLIE, BRAVO, ALPHA])

    assert repositories.memberships.get(OTHER_WORKSPACE, MEMBER).team_order == []
    assert _listed(client, workspace) == [CHARLIE, BRAVO, ALPHA]


def test_teams_the_order_does_not_name_follow_it(client: TestClient, workspace: str, repositories: Any) -> None:
    """A team made after the order was saved appends to the end."""
    sign_in(client, MEMBER)
    _put(client, workspace, [BRAVO, ALPHA])

    later = "01JB000000000000000000PRJ4"
    make_team(repositories, workspace, later, "DEL")
    assert _listed(client, workspace) == [BRAVO, ALPHA, CHARLIE, later]


def test_a_deleted_team_drops_out_without_an_error(client: TestClient, workspace: str) -> None:
    """A saved order naming a team that is gone still reads cleanly."""
    sign_in(client, OWNER)
    _put(client, workspace, [CHARLIE, BRAVO, ALPHA])
    assert client.delete(f"/api/workspaces/{workspace}/teams/{BRAVO}").status_code == 204

    assert _listed(client, workspace) == [CHARLIE, ALPHA]


def test_unknown_and_repeated_ids_are_not_stored(client: TestClient, workspace: str, repositories: Any) -> None:
    """Only teams the caller can see are kept, once each."""
    sign_in(client, MEMBER)
    response = _put(client, workspace, [CHARLIE, "01JB000000000000000000GONE", CHARLIE, ALPHA])

    assert response.status_code == 200
    assert repositories.memberships.get(workspace, MEMBER).team_order == [CHARLIE, ALPHA]


def test_a_guest_orders_only_the_teams_they_belong_to(client: TestClient, workspace: str, repositories: Any) -> None:
    """A hidden team named in a guest's order is dropped, and joining one appends it."""
    add_team_member(repositories, workspace, ALPHA, GUEST, "member")
    add_team_member(repositories, workspace, CHARLIE, GUEST, "member")
    sign_in(client, GUEST)
    _put(client, workspace, [CHARLIE, BRAVO, ALPHA])

    assert repositories.memberships.get(workspace, GUEST).team_order == [CHARLIE, ALPHA]
    add_team_member(repositories, workspace, BRAVO, GUEST, "member")
    assert _listed(client, workspace) == [CHARLIE, ALPHA, BRAVO]


def test_leaving_a_team_drops_it_from_a_guests_list(client: TestClient, workspace: str, repositories: Any) -> None:
    """A guest who leaves a team no longer sees it, and the list still reads."""
    add_team_member(repositories, workspace, ALPHA, GUEST, "member")
    add_team_member(repositories, workspace, CHARLIE, GUEST, "member")
    sign_in(client, GUEST)
    _put(client, workspace, [CHARLIE, ALPHA])
    repositories.memberships.delete_team_membership(workspace, CHARLIE, GUEST)

    assert _listed(client, workspace) == [ALPHA]


def test_an_oversized_order_is_refused(client: TestClient, workspace: str) -> None:
    """The body is bounded, so one request cannot write an unbounded attribute."""
    sign_in(client, MEMBER)
    assert _put(client, workspace, [ALPHA] * 501).status_code == 422


def test_a_non_member_cannot_save_an_order(client: TestClient, workspace: str) -> None:
    """Someone outside the workspace gets the same 404 the list gives them."""
    sign_in(client, "01JB000000000000000000OUTS")
    assert _put(client, workspace, [ALPHA]).status_code == 404
