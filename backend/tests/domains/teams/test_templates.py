"""Issue templates: who keeps them, who sees them, and what they fill on a create.

A team member keeps the team's templates and a workspace admin the workspace's.
A sub-team offers its parent's templates only while the caller can see the
parent, so a private parent stays private. Applying a template fills only the
fields the create left out and quietly drops a reference the team no longer
accepts, while saving one checks every reference strictly.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common import team_writes
from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from tests.domains.helpers import OWNER, add_member, add_team_member, make_team, make_workspace, sign_in

WORKSPACE = "01JB00000000000000000000WS"

TEAM = "01JB000000000000000000TEM1"

SUB = "01JB000000000000000000TEM2"

TEAM_ADMIN = "01JB00000000000000000TADMN"

WRITER = "01JB00000000000000000WRITR"

SUB_ONLY = "01JB0000000000000000SUBONL"

STRANGER = "01JB0000000000000000STRNGR"

BASE = f"/api/workspaces/{WORKSPACE}"


def _client(repositories: Any, domain: str) -> Iterator[TestClient]:
    """A client for one domain's application, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS[domain])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def teams(repositories: Any) -> Iterator[TestClient]:
    """A client for the teams application, where templates are kept."""
    yield from _client(repositories, "teams")


@pytest.fixture
def issues(repositories: Any) -> Iterator[TestClient]:
    """A client for the issues application, where templates are applied."""
    yield from _client(repositories, "issues")


@pytest.fixture
def workspace(repositories: Any) -> str:
    """A team with an admin and a writer, a sub-team with a member of its own, and a member outside both."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    repositories.workspaces.set_billing(WORKSPACE, plan="business")
    for user in (TEAM_ADMIN, WRITER, SUB_ONLY, STRANGER):
        add_member(repositories, WORKSPACE, user, "member")
    make_team(repositories, WORKSPACE, TEAM, "ENG")
    make_team(repositories, WORKSPACE, SUB, "WEB")
    team_writes.set_parent(repositories, WORKSPACE, SUB, TEAM)
    add_team_member(repositories, WORKSPACE, TEAM, TEAM_ADMIN, "admin")
    add_team_member(repositories, WORKSPACE, TEAM, WRITER, "member")
    add_team_member(repositories, WORKSPACE, SUB, WRITER, "member")
    add_team_member(repositories, WORKSPACE, SUB, SUB_ONLY, "member")
    return WORKSPACE


def _template(client: TestClient, path: str, **fields: Any) -> dict[str, Any]:
    """Save one template at `path` and answer it."""
    response = client.post(path, json=fields)
    assert response.status_code == 201, response.text
    return response.json()


def _label(client: TestClient, name: str) -> str:
    """Create one label on the team as its admin and answer its id."""
    sign_in(client, TEAM_ADMIN)
    response = client.post(f"{BASE}/teams/{TEAM}/labels", json={"name": name, "color": "#5e6ad2"})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _listed(client: TestClient, team_id: str) -> dict[str, Any]:
    """The team's template list as the caller signed in on `client` sees it."""
    response = client.get(f"{BASE}/teams/{team_id}/templates")
    assert response.status_code == 200, response.text
    return response.json()


def test_a_team_list_carries_its_own_and_the_workspace_templates(teams: TestClient, workspace: str) -> None:
    """A member saves a team template and the list tags it beside the workspace's."""
    sign_in(teams, OWNER)
    _template(teams, f"{BASE}/templates", name="Incident", priority="urgent")
    sign_in(teams, WRITER)
    saved = _template(teams, f"{BASE}/teams/{TEAM}/templates", name="Bug report", title="Bug: ", body="## Steps")

    assert saved["scope"] == "team"
    assert saved["team_id"] == TEAM
    listed = _listed(teams, TEAM)
    assert [(row["name"], row["scope"]) for row in listed["templates"]] == [
        ("Bug report", "team"),
        ("Incident", "workspace"),
    ]
    assert listed["default_template_id"] is None


def test_only_team_members_write_team_templates_and_only_admins_workspace_ones(
    teams: TestClient, workspace: str
) -> None:
    """A workspace member outside the team gets a 403, and a member a 403 on the workspace set."""
    sign_in(teams, STRANGER)
    refused = teams.post(f"{BASE}/teams/{TEAM}/templates", json={"name": "Nope"})
    assert refused.status_code == 403, refused.text

    sign_in(teams, WRITER)
    refused = teams.post(f"{BASE}/templates", json={"name": "Nope"})
    assert refused.status_code == 403, refused.text


def test_saving_checks_every_reference(teams: TestClient, workspace: str) -> None:
    """An unknown status or a blank name is a 422 on save, never stored."""
    sign_in(teams, WRITER)
    unknown = teams.post(f"{BASE}/teams/{TEAM}/templates", json={"name": "Bad", "status_id": "nope"})
    assert unknown.status_code == 422, unknown.text
    blank = teams.post(f"{BASE}/teams/{TEAM}/templates", json={"name": "   "})
    assert blank.status_code == 422, blank.text
    assert _listed(teams, TEAM)["templates"] == []


def test_a_template_is_edited_reordered_and_deleted(teams: TestClient, workspace: str) -> None:
    """A patch changes only what it names, a position moves it, and a delete is gone for good."""
    sign_in(teams, WRITER)
    first = _template(teams, f"{BASE}/teams/{TEAM}/templates", name="First", title="One")
    second = _template(teams, f"{BASE}/teams/{TEAM}/templates", name="Second")

    moved = teams.patch(f"{BASE}/teams/{TEAM}/templates/{second['id']}", json={"position": 0, "title": None})
    assert moved.status_code == 200, moved.text
    teams.patch(f"{BASE}/teams/{TEAM}/templates/{first['id']}", json={"position": 1})
    assert [row["name"] for row in _listed(teams, TEAM)["templates"]] == ["Second", "First"]

    renamed = teams.patch(f"{BASE}/teams/{TEAM}/templates/{first['id']}", json={"name": "Renamed"})
    assert renamed.json()["title"] == "One"

    assert teams.delete(f"{BASE}/teams/{TEAM}/templates/{first['id']}").status_code == 204
    assert teams.delete(f"{BASE}/teams/{TEAM}/templates/{first['id']}").status_code == 404


def test_a_sub_team_offers_its_parents_templates(teams: TestClient, workspace: str, repositories: Any) -> None:
    """The parent's templates reach the sub-team tagged `parent`, until the parent turns private."""
    sign_in(teams, WRITER)
    _template(teams, f"{BASE}/teams/{TEAM}/templates", name="Parent bug")

    sign_in(teams, SUB_ONLY)
    assert [(row["name"], row["scope"]) for row in _listed(teams, SUB)["templates"]] == [("Parent bug", "parent")]

    repositories.memberships.set_team_private(WORKSPACE, TEAM, True)
    assert _listed(teams, SUB)["templates"] == []
    sign_in(teams, WRITER)
    assert [row["name"] for row in _listed(teams, SUB)["templates"]] == ["Parent bug"]


def test_a_private_teams_templates_are_hidden_from_outsiders(
    teams: TestClient, workspace: str, repositories: Any
) -> None:
    """A member outside a private team reads its list as a missing team."""
    repositories.memberships.set_team_private(WORKSPACE, TEAM, True)
    sign_in(teams, STRANGER)
    hidden = teams.get(f"{BASE}/teams/{TEAM}/templates")
    assert hidden.status_code == 404, hidden.text
    assert teams.get(f"{BASE}/teams/{TEAM}/template-settings").status_code == 404


def test_the_default_template_is_a_team_admins_call_and_reaches_sub_teams(teams: TestClient, workspace: str) -> None:
    """A member cannot set it, an admin sets one the team offers, and the sub-team falls back to it."""
    sign_in(teams, WRITER)
    saved = _template(teams, f"{BASE}/teams/{TEAM}/templates", name="Bug")
    refused = teams.patch(f"{BASE}/teams/{TEAM}/template-settings", json={"default_template_id": saved["id"]})
    assert refused.status_code == 403, refused.text

    sign_in(teams, TEAM_ADMIN)
    unknown = teams.patch(f"{BASE}/teams/{TEAM}/template-settings", json={"default_template_id": "nope"})
    assert unknown.status_code == 422, unknown.text
    stored = teams.patch(f"{BASE}/teams/{TEAM}/template-settings", json={"default_template_id": saved["id"]})
    assert stored.status_code == 200, stored.text
    assert stored.json()["effective_default_template_id"] == saved["id"]
    assert _listed(teams, TEAM)["default_template_id"] == saved["id"]

    sign_in(teams, SUB_ONLY)
    settings = teams.get(f"{BASE}/teams/{SUB}/template-settings").json()
    assert settings["default_template_id"] is None
    assert settings["effective_default_template_id"] == saved["id"]


def test_creating_from_a_template_fills_only_the_fields_left_out(
    teams: TestClient, issues: TestClient, workspace: str
) -> None:
    """The template's title, body, priority and labels land, and anything the create sends wins."""
    bug = _label(teams, "Bug")
    sign_in(teams, WRITER)
    saved = _template(
        teams,
        f"{BASE}/teams/{TEAM}/templates",
        name="Bug report",
        title="Bug: something broke",
        body="## Steps",
        priority="high",
        label_ids=[bug],
    )

    sign_in(issues, WRITER)
    filled = issues.post(f"{BASE}/issues", json={"team_id": TEAM, "template_id": saved["id"]})
    assert filled.status_code == 201, filled.text
    body = filled.json()
    assert body["title"] == "Bug: something broke"
    assert body["body"] == "## Steps"
    assert body["priority"] == "high"
    assert body["label_ids"] == [bug]

    own = issues.post(
        f"{BASE}/issues", json={"team_id": TEAM, "template_id": saved["id"], "title": "Mine", "priority": "low"}
    )
    assert own.status_code == 201, own.text
    assert own.json()["title"] == "Mine"
    assert own.json()["priority"] == "low"
    assert own.json()["body"] == "## Steps"


def test_a_stale_reference_is_dropped_when_the_template_is_applied(
    teams: TestClient, issues: TestClient, workspace: str
) -> None:
    """A label deleted after the template was saved is left off rather than failing the create."""
    gone = _label(teams, "Gone")
    sign_in(teams, WRITER)
    saved = _template(teams, f"{BASE}/teams/{TEAM}/templates", name="Old", title="Old", label_ids=[gone])
    sign_in(teams, TEAM_ADMIN)
    assert teams.delete(f"{BASE}/teams/{TEAM}/labels/{gone}").status_code == 204

    sign_in(issues, WRITER)
    created = issues.post(f"{BASE}/issues", json={"team_id": TEAM, "template_id": saved["id"]})
    assert created.status_code == 201, created.text
    assert created.json()["label_ids"] == []


def test_a_template_the_team_does_not_offer_is_refused(
    teams: TestClient, issues: TestClient, workspace: str, repositories: Any
) -> None:
    """A private parent's template is unknown to a sub-team member outside it, and no title is a 422."""
    sign_in(teams, WRITER)
    saved = _template(teams, f"{BASE}/teams/{TEAM}/templates", name="Parent", title="From the parent")
    repositories.memberships.set_team_private(WORKSPACE, TEAM, True)

    sign_in(issues, SUB_ONLY)
    refused = issues.post(f"{BASE}/issues", json={"team_id": SUB, "template_id": saved["id"]})
    assert refused.status_code == 422, refused.text
    assert "From the parent" not in refused.text

    untitled = issues.post(f"{BASE}/issues", json={"team_id": SUB})
    assert untitled.status_code == 422, untitled.text

    sign_in(issues, WRITER)
    inherited = issues.post(f"{BASE}/issues", json={"team_id": SUB, "template_id": saved["id"]})
    assert inherited.status_code == 201, inherited.text
    assert inherited.json()["title"] == "From the parent"
