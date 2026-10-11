"""A private sub-team stays private inside its parent's roll-up.

A parent team's list with `include_sub_teams` reads only the sub-teams the caller
may see, so an owner, an admin or a member outside a private sub-team gets none
of its issues on any read the list serves: the full page, a delta poll, a title
search, a person filter that reads its own index, and the subscribed list. A
member of the private sub-team reads it rolled up as usual.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common import team_writes
from app.common.db.dynamo.base import utc_now
from tests.domains.helpers import ADMIN, MEMBER, OWNER, add_member, add_team_member, sign_in
from tests.domains.issues.conftest import OTHER_TEAM, TEAM, WORKSPACE, create_issue

BASE = f"/api/workspaces/{WORKSPACE}/issues"

INSIDER = "01JB00000000000000000INSDR"

SECRET_TITLE = "Vault rotation plan"


def _read(client: TestClient, **params: Any) -> dict[str, Any]:
    """One read of the issue list, as JSON."""
    response = client.get(BASE, params=params)
    assert response.status_code == 200, response.text
    return response.json()


def _ids(client: TestClient, **params: Any) -> set[str]:
    """The issue ids one read of the list answers."""
    return {row["id"] for row in _read(client, **params)["issues"]}


@pytest.fixture
def seeded(client: TestClient, workspace: str, repositories: Any) -> dict[str, str]:
    """`OTHER_TEAM` as a private sub-team of `TEAM`, an issue in each, and one insider on the sub-team."""
    team_writes.set_parent(repositories, WORKSPACE, OTHER_TEAM, TEAM)
    sign_in(client, OWNER)
    own = create_issue(client, workspace, team_id=TEAM, title="Parent work")["id"]
    secret = create_issue(client, workspace, team_id=OTHER_TEAM, title=SECRET_TITLE, assignee_id=OWNER)["id"]
    add_member(repositories, WORKSPACE, INSIDER, "member")
    add_team_member(repositories, WORKSPACE, OTHER_TEAM, INSIDER, "member")
    repositories.memberships.set_team_private(WORKSPACE, OTHER_TEAM, True)
    return {"own": own, "secret": secret}


@pytest.mark.parametrize("reader", [OWNER, ADMIN, MEMBER])
def test_the_roll_up_hides_a_private_sub_team_from_outsiders(
    client: TestClient, seeded: dict[str, str], reader: str
) -> None:
    """Every read the roll-up serves leaves the private sub-team's issue out, whatever the reader's workspace role."""
    sign_in(client, reader)
    rolled = {"team_id": TEAM, "include_sub_teams": "true"}

    assert _ids(client, **rolled) == {seeded["own"]}
    assert _ids(client, **rolled, q="Vault") == set()
    assert _ids(client, **rolled, assignee_id=OWNER) == set()
    assert _ids(client, **rolled, team_id_in=OTHER_TEAM) == set()
    assert seeded["secret"] not in _ids(client, **rolled, subscriber_id="me")
    assert seeded["secret"] not in _ids(client, **rolled, include_archived="true")

    since = (utc_now() - timedelta(minutes=5)).isoformat()
    delta = _read(client, **rolled, updated_since=since)
    assert seeded["secret"] not in {row["id"] for row in delta["issues"]}
    assert seeded["secret"] not in delta["removed_ids"]


def test_the_roll_up_never_names_the_private_sub_team_issue(client: TestClient, seeded: dict[str, str]) -> None:
    """No body the roll-up answers an outsider carries the sub-team's id, key or title."""
    sign_in(client, MEMBER)
    response = client.get(BASE, params={"team_id": TEAM, "include_sub_teams": "true", "include_archived": "true"})
    assert response.status_code == 200
    assert OTHER_TEAM not in response.text
    assert SECRET_TITLE not in response.text
    assert seeded["secret"] not in response.text


def test_the_private_sub_team_itself_is_a_404_to_outsiders(client: TestClient, seeded: dict[str, str]) -> None:
    """Naming the private sub-team directly, rolled up or not, answers as for a team that does not exist."""
    sign_in(client, MEMBER)
    assert client.get(BASE, params={"team_id": OTHER_TEAM}).status_code == 404
    assert client.get(BASE, params={"team_id": OTHER_TEAM, "include_sub_teams": "true"}).status_code == 404


def test_a_member_of_the_private_sub_team_reads_it_rolled_up(client: TestClient, seeded: dict[str, str]) -> None:
    """The insider sees the parent's issue and the sub-team's together."""
    sign_in(client, INSIDER)
    assert _ids(client, team_id=TEAM, include_sub_teams="true") == {seeded["own"], seeded["secret"]}
    assert _ids(client, team_id=TEAM, include_sub_teams="true", q="Vault") == {seeded["secret"]}
