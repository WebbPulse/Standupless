"""The team display defaults routes, against real tables in moto.

These pin who may read and change what a team's issue list and board open
with, that each page is set and cleared on its own, that the options are held
to a saved view's own choices, and that deleting the team removes the row.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.db.dynamo.team_config import display_defaults_key
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER, add_member, make_team, make_workspace, sign_in

WORKSPACE = "01JB00000000000000000000WS"

TEAM = "01JB000000000000000000PRJ1"

URL = f"/api/workspaces/{WORKSPACE}/teams/{TEAM}/display-defaults"


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client for the teams application, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["teams"])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def team(repositories: Any) -> str:
    """A workspace with every role, holding one team."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    add_member(repositories, WORKSPACE, GUEST, "guest")
    make_team(repositories, WORKSPACE, TEAM, "APO")
    return TEAM


def test_unsaved_defaults_read_as_built_in(client: TestClient, team: str) -> None:
    """Both pages keep their built-in defaults until a team admin saves one."""
    sign_in(client, MEMBER)
    response = client.get(URL)

    assert response.status_code == 200
    assert response.json() == {
        "team_id": team,
        "list_display": None,
        "board_display": None,
        "updated_by": None,
        "updated_at": None,
    }


def test_a_guest_outside_the_team_cannot_read_them(client: TestClient, team: str) -> None:
    """The defaults are as hidden as the team itself."""
    sign_in(client, GUEST)
    assert client.get(URL).status_code == 404


def test_a_plain_member_cannot_change_them(client: TestClient, team: str) -> None:
    """Setting the team default is a team admin decision."""
    sign_in(client, MEMBER)
    assert client.patch(URL, json={"list_display": {"group_by": "status"}}).status_code == 403


def test_an_admin_sets_and_clears_each_page(client: TestClient, team: str) -> None:
    """Each page is replaced whole, a page left out keeps its default, and null clears it."""
    sign_in(client, ADMIN)
    saved = client.patch(
        URL,
        json={
            "list_display": {
                "layout": "list",
                "group_by": "status",
                "sub_group_by": "assignee",
                "ordering": "priority_desc",
                "visible_properties": ["id", "milestone", "links", "id"],
                "completed_window": "past_month",
            },
            "board_display": {"show_empty_groups": True},
        },
    )

    assert saved.status_code == 200, saved.text
    body = saved.json()
    assert body["list_display"]["group_by"] == "status"
    assert body["list_display"]["visible_properties"] == ["id", "milestone", "links"]
    assert body["list_display"]["completed_window"] == "past_month"
    assert body["list_display"]["show_sub_issues"] is None
    assert body["board_display"]["show_empty_groups"] is True
    assert body["updated_by"] == ADMIN
    assert body["updated_at"] is not None

    kept = client.patch(URL, json={"board_display": None})

    assert kept.json()["board_display"] is None
    assert kept.json()["list_display"]["ordering"] == "priority_desc"
    assert client.get(URL).json()["list_display"]["sub_group_by"] == "assignee"


def test_no_grouping_is_kept_apart_from_the_built_in_one(client: TestClient, team: str) -> None:
    """A `none` grouping is stored as no grouping, while a null keeps the page's own."""
    sign_in(client, ADMIN)
    saved = client.patch(URL, json={"list_display": {"group_by": "none", "sub_group_by": "none"}})

    assert saved.status_code == 200, saved.text
    assert saved.json()["list_display"]["group_by"] == "none"
    assert saved.json()["list_display"]["sub_group_by"] == "none"


@pytest.mark.parametrize(
    "options",
    [
        {"group_by": "nonsense"},
        {"visible_properties": ["sparkles"]},
        {"completed_window": "past_year"},
        {"sub_group_by": "status"},
        {"group_by": "status", "sub_group_by": "status"},
        {"group_by": "none", "sub_group_by": "label"},
        {"show_sub_issues": "yes"},
    ],
)
def test_options_outside_the_view_choices_are_refused(client: TestClient, team: str, options: Any) -> None:
    """A team default is always one a saved view could hold."""
    sign_in(client, ADMIN)
    assert client.patch(URL, json={"list_display": options}).status_code == 422


def test_deleting_the_team_removes_the_row(client: TestClient, team: str, repositories: Any) -> None:
    """The team purge takes the display defaults with the rest of the team's config."""
    sign_in(client, OWNER)
    client.patch(URL, json={"list_display": {"group_by": "priority"}})
    assert repositories.team_config.get_display_defaults(WORKSPACE, team) is not None

    assert client.delete(f"/api/workspaces/{WORKSPACE}/teams/{team}").status_code == 204

    assert repositories.team_config.get_display_defaults(WORKSPACE, team) is None
    assert display_defaults_key(team) == f"team#{team}#display"
