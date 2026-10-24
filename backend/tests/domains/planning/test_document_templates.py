"""Document templates: kept beside issue and project templates, and applied to new documents and updates.

A document template is a template row of a third kind holding only a title and
a Markdown body. A project offers its teams' and the workspace's, an initiative
the workspace's alone, and a team keeps a default for new documents apart from
the one its update composer opens with. A create fills only what it left out.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from tests.domains.helpers import MEMBER, OWNER, sign_in
from tests.domains.planning.conftest import OTHER_TEAM, TEAM, seed_project

UPDATE_BODY = "## What shipped\n\n## What is next\n"


@pytest.fixture
def teams(repositories: Any) -> Iterator[TestClient]:
    """A client for the teams application, where templates are kept."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["teams"])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


def _base(workspace: str) -> str:
    """The workspace's API root."""
    return f"/api/workspaces/{workspace}"


def _save(teams: TestClient, workspace: str, team_id: str | None = TEAM, **payload: Any) -> dict[str, Any]:
    """Save one document template on a team, or on the workspace with no team, failing loudly on a refusal."""
    body: dict[str, Any] = {"kind": "document", "name": "Spec", "title": "Spec: ", "body": "## Goal\n"}
    body.update(payload)
    path = f"{_base(workspace)}/teams/{team_id}/templates" if team_id else f"{_base(workspace)}/templates"
    response = teams.post(path, json=body)
    assert response.status_code == 201, response.text
    return response.json()


def test_a_document_template_is_kept_apart_from_the_other_kinds(teams: TestClient, workspace: str) -> None:
    """It lists under kind document only and refuses issue fields and a project."""
    sign_in(teams, OWNER)
    saved = _save(teams, workspace)
    path = f"{_base(workspace)}/teams/{TEAM}/templates"

    documents = teams.get(path, params={"kind": "document"}).json()["templates"]
    issues = teams.get(path).json()["templates"]
    with_priority = teams.post(path, json={"kind": "document", "name": "Bad", "priority": "high"})
    with_project = teams.post(path, json={"kind": "document", "name": "Bad", "project": {}})
    patched = teams.patch(f"{path}/{saved['id']}", json={"body": "## Goal\n\n## Plan\n"})
    refused = teams.patch(f"{path}/{saved['id']}", json={"priority": "high"})

    assert saved["kind"] == "document"
    assert [row["id"] for row in documents] == [saved["id"]]
    assert issues == []
    assert with_priority.status_code == 422
    assert with_project.status_code == 422
    assert patched.status_code == 200, patched.text
    assert patched.json()["body"] == "## Goal\n\n## Plan\n"
    assert refused.status_code == 422


def test_a_team_keeps_a_document_and_an_update_default(teams: TestClient, workspace: str) -> None:
    """Both defaults name a document template, and setting one keeps the others."""
    sign_in(teams, OWNER)
    issue = teams.post(f"{_base(workspace)}/teams/{TEAM}/templates", json={"name": "Bug"}).json()
    spec = _save(teams, workspace)
    weekly = _save(teams, workspace, name="Weekly", title=None, body=UPDATE_BODY)
    path = f"{_base(workspace)}/teams/{TEAM}/template-settings"
    assert teams.patch(path, json={"default_template_id": issue["id"]}).status_code == 200

    wrong = teams.patch(path, json={"default_document_template_id": issue["id"]})
    response = teams.patch(
        path, json={"default_document_template_id": spec["id"], "default_update_template_id": weekly["id"]}
    )

    assert wrong.status_code == 422
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["default_template_id"] == issue["id"]
    assert body["effective_default_document_template_id"] == spec["id"]
    assert body["effective_default_update_template_id"] == weekly["id"]
    listed = teams.get(f"{_base(workspace)}/teams/{TEAM}/templates", params={"kind": "document"}).json()
    assert listed["default_template_id"] == spec["id"]


def test_a_project_offers_its_teams_and_the_workspaces_templates(
    client: TestClient, teams: TestClient, workspace: str
) -> None:
    """Another team's template is left out, and the project's team's defaults come with the list."""
    sign_in(teams, OWNER)
    own = _save(teams, workspace)
    shared = _save(teams, workspace, None, name="Decision record")
    _save(teams, workspace, OTHER_TEAM, name="Elsewhere")
    teams.patch(
        f"{_base(workspace)}/teams/{TEAM}/template-settings",
        json={"default_document_template_id": own["id"], "default_update_template_id": shared["id"]},
    )
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]

    response = client.get(f"{_base(workspace)}/projects/{project_id}/document-templates")

    assert response.status_code == 200, response.text
    body = response.json()
    assert [row["id"] for row in body["templates"]] == [own["id"], shared["id"]]
    assert body["default_document_template_id"] == own["id"]
    assert body["default_update_template_id"] == shared["id"]


def test_a_document_created_from_a_template_takes_what_it_left_out(
    client: TestClient, teams: TestClient, workspace: str
) -> None:
    """The template fills a missing title and body, a sent title wins, and a name finds it too."""
    sign_in(teams, OWNER)
    template = _save(teams, workspace)
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    path = f"{_base(workspace)}/projects/{project_id}/documents"

    filled = client.post(path, json={"template_id": template["id"]})
    titled = client.post(path, json={"template_id": "spec", "title": "Search spec"})
    untemplated = client.post(path, json={})
    unknown = client.post(path, json={"template_id": "nope"})

    assert filled.status_code == 201, filled.text
    assert (filled.json()["title"], filled.json()["body"]) == ("Spec:", "## Goal\n")
    assert titled.status_code == 201, titled.text
    assert (titled.json()["title"], titled.json()["body"]) == ("Search spec", "## Goal\n")
    assert untemplated.status_code == 422
    assert unknown.status_code == 422


def test_an_untitled_template_starts_an_untitled_document(
    client: TestClient, teams: TestClient, workspace: str
) -> None:
    """A template with only a body names the document Untitled."""
    sign_in(teams, OWNER)
    template = _save(teams, workspace, title=None)
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]

    response = client.post(f"{_base(workspace)}/projects/{project_id}/documents", json={"template_id": template["id"]})

    assert response.status_code == 201, response.text
    assert response.json()["title"] == "Untitled"


def test_another_teams_template_cannot_start_a_projects_document(
    client: TestClient, teams: TestClient, workspace: str
) -> None:
    """A template of a team the project is not on is refused rather than applied."""
    sign_in(teams, OWNER)
    template = _save(teams, workspace, OTHER_TEAM)
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]

    response = client.post(f"{_base(workspace)}/projects/{project_id}/documents", json={"template_id": template["id"]})

    assert response.status_code == 422, response.text


def test_a_project_update_posts_its_templates_body(client: TestClient, teams: TestClient, workspace: str) -> None:
    """A left out body takes the template's, a sent body wins, and an empty template body is refused."""
    sign_in(teams, OWNER)
    weekly = _save(teams, workspace, name="Weekly", title=None, body=UPDATE_BODY)
    empty = _save(teams, workspace, name="Empty", title="Only a title", body=None)
    sign_in(client, MEMBER)
    project_id = seed_project(client, workspace)["project_id"]
    path = f"{_base(workspace)}/projects/{project_id}/updates"

    templated = client.post(path, json={"health": "on_track", "template_id": weekly["id"]})
    written = client.post(path, json={"health": "at_risk", "template_id": weekly["id"], "body": "Slipping"})
    blank = client.post(path, json={"health": "on_track", "template_id": empty["id"]})
    neither = client.post(path, json={"health": "on_track"})

    assert templated.status_code == 201, templated.text
    assert templated.json()["body"] == UPDATE_BODY
    assert written.status_code == 201, written.text
    assert written.json()["body"] == "Slipping"
    assert blank.status_code == 422
    assert neither.status_code == 422


def test_an_initiative_offers_the_workspaces_templates_alone(
    client: TestClient, teams: TestClient, workspace: str
) -> None:
    """A team's template is not offered on an initiative, and a workspace one starts its documents and updates."""
    sign_in(teams, OWNER)
    team_only = _save(teams, workspace)
    shared = _save(teams, workspace, None, name="Quarterly", title="Quarter review", body=UPDATE_BODY)
    sign_in(client, MEMBER)
    created = client.post(f"{_base(workspace)}/initiatives", json={"name": "Grow"})
    assert created.status_code == 201, created.text
    initiative_id = created.json()["initiative_id"]
    base = f"{_base(workspace)}/initiatives/{initiative_id}"

    offered = client.get(f"{base}/document-templates").json()
    document = client.post(f"{base}/documents", json={"template_id": shared["id"]})
    refused = client.post(f"{base}/documents", json={"template_id": team_only["id"]})
    update = client.post(f"{base}/updates", json={"health": "on_track", "template_id": shared["id"]})

    assert [row["id"] for row in offered["templates"]] == [shared["id"]]
    assert offered["default_document_template_id"] is None
    assert document.status_code == 201, document.text
    assert document.json()["title"] == "Quarter review"
    assert refused.status_code == 422
    assert update.status_code == 201, update.text
    assert update.json()["body"] == UPDATE_BODY
