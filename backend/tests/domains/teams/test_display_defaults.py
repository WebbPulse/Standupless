"""The team display defaults routes, against real tables in moto.

These pin who may read and change what a team's issue list, board and projects
page open with, that each page is set and cleared on its own, that the options
are held to a saved view's own choices, that deleting the team removes the row,
and that the projects page falls back from the team default to the workspace
default to the built-in arrangement.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.api.schemas.projects_display import ProjectsDisplay
from app.common.api.schemas.teams import DisplayOptionsBody
from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.db.dynamo.team_config import WORKSPACE_DISPLAY_DEFAULTS_KEY, DisplayOptions, display_defaults_key
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

TEAM = "01JB000000000000000000PRJ1"

URL = f"/api/workspaces/{WORKSPACE}/teams/{TEAM}/display-defaults"

WORKSPACE_URL = f"/api/workspaces/{WORKSPACE}/display-defaults"

BUILT_IN = ProjectsDisplay().model_dump()


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
        "projects_display": None,
        "effective_projects_display": BUILT_IN,
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
            "board_display": {"show_empty_groups": True, "group_header": "estimate"},
        },
    )

    assert saved.status_code == 200, saved.text
    body = saved.json()
    assert body["list_display"]["group_by"] == "status"
    assert body["list_display"]["visible_properties"] == ["id", "milestone", "links"]
    assert body["list_display"]["completed_window"] == "past_month"
    assert body["list_display"]["show_sub_issues"] is None
    assert body["board_display"]["show_empty_groups"] is True
    assert body["board_display"]["group_header"] == "estimate"
    assert body["list_display"]["group_header"] is None
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


def test_a_team_admin_sets_and_clears_the_projects_default(client: TestClient, team: str) -> None:
    """The team projects default is replaced whole, kept when left out and cleared by null."""
    sign_in(client, ADMIN)
    saved = client.patch(URL, json={"projects_display": {"layout": "board", "group": "health"}})

    assert saved.status_code == 200, saved.text
    body = saved.json()
    assert body["projects_display"]["layout"] == "board"
    assert body["projects_display"]["group"] == "health"
    assert body["projects_display"]["order"] == "target"
    assert body["effective_projects_display"] == body["projects_display"]

    kept = client.patch(URL, json={"list_display": {"group_by": "status"}})

    assert kept.json()["projects_display"]["layout"] == "board"

    cleared = client.patch(URL, json={"projects_display": None})

    assert cleared.json()["projects_display"] is None
    assert cleared.json()["effective_projects_display"] == BUILT_IN
    assert cleared.json()["list_display"]["group_by"] == "status"


def test_a_plain_member_cannot_set_the_team_projects_default(client: TestClient, team: str) -> None:
    """Only a team admin decides what the team's projects page opens with."""
    sign_in(client, MEMBER)
    assert client.patch(URL, json={"projects_display": {"layout": "board"}}).status_code == 403


def test_a_projects_default_outside_the_page_choices_is_refused(client: TestClient, team: str) -> None:
    """A projects default is always an arrangement the page can draw."""
    sign_in(client, ADMIN)
    assert client.patch(URL, json={"projects_display": {"layout": "gantt"}}).status_code == 422
    assert client.patch(WORKSPACE_URL, json={"projects_display": {"columns": ["sparkles"]}}).status_code == 422


def test_the_workspace_default_starts_built_in_and_any_member_reads_it(client: TestClient, team: str) -> None:
    """Every member reads what the workspace projects page opens with."""
    sign_in(client, GUEST)
    response = client.get(WORKSPACE_URL)

    assert response.status_code == 200
    assert response.json() == {
        "projects_display": None,
        "effective_projects_display": BUILT_IN,
        "updated_by": None,
        "updated_at": None,
    }


@pytest.mark.parametrize("user", [MEMBER, GUEST])
def test_only_a_workspace_admin_sets_the_workspace_default(client: TestClient, team: str, user: str) -> None:
    """The workspace projects default reaches everyone, so it is a workspace admin decision."""
    sign_in(client, user)
    assert client.patch(WORKSPACE_URL, json={"projects_display": {"layout": "board"}}).status_code == 403


def test_a_team_admin_who_is_a_plain_workspace_member_cannot_set_the_workspace_default(
    client: TestClient, team: str, repositories: Any
) -> None:
    """Administering a team stops at that team's own projects default."""
    add_team_member(repositories, WORKSPACE, team, MEMBER, "admin")
    sign_in(client, MEMBER)

    assert client.patch(URL, json={"projects_display": {"layout": "board"}}).status_code == 200
    assert client.patch(WORKSPACE_URL, json={"projects_display": {"layout": "board"}}).status_code == 403


def test_a_workspace_admin_sets_and_clears_the_workspace_default(
    client: TestClient, team: str, repositories: Any
) -> None:
    """The workspace default is stored on its own row, replaced whole and cleared by null."""
    sign_in(client, ADMIN)
    saved = client.patch(WORKSPACE_URL, json={"projects_display": {"order": "name", "columns": ["lead", "status"]}})

    assert saved.status_code == 200, saved.text
    body = saved.json()
    assert body["projects_display"]["order"] == "name"
    assert body["projects_display"]["columns"] == "status,lead"
    assert body["effective_projects_display"] == body["projects_display"]
    assert body["updated_by"] == ADMIN
    assert repositories.team_config.get_workspace_display_defaults(WORKSPACE) is not None
    assert WORKSPACE_DISPLAY_DEFAULTS_KEY == "workspace#display"

    assert client.patch(WORKSPACE_URL, json={}).json()["projects_display"]["order"] == "name"

    cleared = client.patch(WORKSPACE_URL, json={"projects_display": None})

    assert cleared.json()["projects_display"] is None
    assert cleared.json()["effective_projects_display"] == BUILT_IN


def test_the_team_projects_page_falls_back_team_then_workspace_then_built_in(client: TestClient, team: str) -> None:
    """A team default wins on its own page, the workspace default fills in without one, then the built-in."""
    sign_in(client, ADMIN)
    assert client.get(URL).json()["effective_projects_display"] == BUILT_IN

    client.patch(WORKSPACE_URL, json={"projects_display": {"layout": "timeline"}})
    sign_in(client, MEMBER)
    inherited = client.get(URL).json()

    assert inherited["projects_display"] is None
    assert inherited["effective_projects_display"]["layout"] == "timeline"

    sign_in(client, ADMIN)
    client.patch(URL, json={"projects_display": {"layout": "board"}})
    sign_in(client, MEMBER)

    assert client.get(URL).json()["effective_projects_display"]["layout"] == "board"
    assert client.get(WORKSPACE_URL).json()["effective_projects_display"]["layout"] == "timeline"

    sign_in(client, ADMIN)
    client.patch(URL, json={"projects_display": None})

    assert client.get(URL).json()["effective_projects_display"]["layout"] == "timeline"

    client.patch(WORKSPACE_URL, json={"projects_display": None})

    assert client.get(URL).json()["effective_projects_display"] == BUILT_IN


def test_the_group_header_takes_only_count_or_estimate(client: TestClient, team: str) -> None:
    """A team default group header is one a saved view could hold."""
    sign_in(client, ADMIN)
    assert client.patch(URL, json={"list_display": {"group_header": "points"}}).status_code == 422


def test_the_sla_and_customer_properties_are_team_defaults(client: TestClient, team: str) -> None:
    """A team default may show or hide the SLA badge and show the customer properties."""
    sign_in(client, ADMIN)
    shown = client.patch(
        URL, json={"list_display": {"visible_properties": ["id", "sla", "customers", "customer_revenue"]}}
    )

    assert shown.status_code == 200, shown.text
    assert shown.json()["list_display"]["visible_properties"] == ["id", "sla", "customers", "customer_revenue"]

    hidden = client.patch(URL, json={"list_display": {"visible_properties": ["id"]}})

    assert hidden.json()["list_display"]["visible_properties"] == ["id"]
    assert client.get(URL).json()["list_display"]["visible_properties"] == ["id"]


def test_a_team_default_saved_before_the_sla_property_reads_with_it_on() -> None:
    """A stored default list with neither sla nor the hidden marker predates the property, so sla reads as on."""
    body = DisplayOptionsBody.from_row(DisplayOptions(visible_properties=["id", "labels"]))

    assert body is not None
    assert body.visible_properties == ["id", "labels", "sla"]
    assert DisplayOptionsBody(visible_properties=["id"]).as_row().visible_properties == ["id", "-sla"]
