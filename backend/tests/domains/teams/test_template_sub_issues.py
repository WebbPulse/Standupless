"""Template sub-issues: an issue template's list of sub-issues, created under every issue made from it.

Saving holds each sub-issue to the template's scope as a project template's
issues are held. Creating from the template makes the sub-issues it keeps under
the new issue in order, and a failure part way removes everything the create
wrote, so a parent is never left half built.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.common import issue_writes
from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from tests.domains.helpers import OWNER, add_member, add_team_member, make_team, make_workspace, sign_in

WORKSPACE = "01JB00000000000000000000WS"

TEAM = "01JB000000000000000000TEM1"

WRITER = "01JB00000000000000000WRITR"

BASE = f"/api/workspaces/{WORKSPACE}"

TEMPLATES = f"{BASE}/teams/{TEAM}/templates"


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
    """A client for the issues application, where issues are created."""
    yield from _client(repositories, "issues")


@pytest.fixture
def workspace(repositories: Any) -> str:
    """One team with a writer."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    add_member(repositories, WORKSPACE, WRITER, "member")
    make_team(repositories, WORKSPACE, TEAM, "ENG")
    add_team_member(repositories, WORKSPACE, TEAM, WRITER, "member")
    return WORKSPACE


def _release(teams: TestClient, **extra: Any) -> dict[str, Any]:
    """Save a release template with three sub-issues as the writer and answer it."""
    sign_in(teams, WRITER)
    body: dict[str, Any] = {
        "name": "Release",
        "title": "Release 1.0",
        "sub_issues": [
            {"title": "Write notes", "assignee_id": WRITER, "priority": "high"},
            {"key": "tag", "title": "Tag the build"},
            {"title": "Announce it", "body": "Post in the channel"},
        ],
        **extra,
    }
    response = teams.post(TEMPLATES, json=body)
    assert response.status_code == 201, response.text
    return response.json()


def _create(issues: TestClient, **body: Any) -> Any:
    """Create an issue on the team as the writer."""
    sign_in(issues, WRITER)
    return issues.post(f"{BASE}/issues", json={"team_id": TEAM, **body})


def _children(repositories: Any, parent_id: str) -> list[Any]:
    """The sub-issues of one issue, in creation order."""
    return sorted(repositories.issues.iter_children(WORKSPACE, parent_id), key=lambda row: row.number)


def test_sub_issues_are_saved_in_order_with_keys(teams: TestClient, workspace: str) -> None:
    """Each sub-issue keeps its place and gets a key, a sent one kept and the rest s1 onwards."""
    saved = _release(teams)

    assert [item["title"] for item in saved["sub_issues"]] == ["Write notes", "Tag the build", "Announce it"]
    assert [item["key"] for item in saved["sub_issues"]] == ["s1", "tag", "s2"]


def test_saving_holds_sub_issues_to_the_team(teams: TestClient, workspace: str) -> None:
    """A label the team lacks, a milestone or parent key, and sub-issues on another kind are refused."""
    sign_in(teams, WRITER)

    label = teams.post(TEMPLATES, json={"name": "A", "sub_issues": [{"title": "x", "label_ids": ["nope"]}]})
    nested = teams.post(TEMPLATES, json={"name": "B", "sub_issues": [{"title": "x", "parent_key": "s1"}]})
    project = teams.post(TEMPLATES, json={"name": "C", "kind": "project", "sub_issues": [{"title": "x"}]})
    document = teams.post(TEMPLATES, json={"name": "D", "kind": "document", "sub_issues": [{"title": "x"}]})

    assert label.status_code == 422
    assert nested.status_code == 422
    assert project.status_code == 422
    assert "sub_issues is for an issue template" in project.text
    assert document.status_code == 422


def test_a_patch_replaces_the_list_and_null_clears_it(teams: TestClient, workspace: str) -> None:
    """Sending sub_issues replaces the whole list, and null removes every one."""
    template = _release(teams)
    path = f"{TEMPLATES}/{template['id']}"

    replaced = teams.patch(path, json={"sub_issues": [{"title": "Only this"}]})
    renamed = teams.patch(path, json={"name": "Release train"})
    cleared = teams.patch(path, json={"sub_issues": None})

    assert [item["title"] for item in replaced.json()["sub_issues"]] == ["Only this"]
    assert [item["title"] for item in renamed.json()["sub_issues"]] == ["Only this"]
    assert cleared.json()["sub_issues"] == []


def test_creating_from_the_template_makes_its_sub_issues(
    teams: TestClient, issues: TestClient, workspace: str, repositories: Any
) -> None:
    """Every sub-issue lands under the new issue in the template's order with its own fields."""
    template = _release(teams)

    response = _create(issues, template_id=template["id"])

    assert response.status_code == 201, response.text
    parent = response.json()
    children = _children(repositories, parent["id"])
    assert [child.title for child in children] == ["Write notes", "Tag the build", "Announce it"]
    assert children[0].assignee_id == WRITER
    assert children[0].priority == "high"
    assert children[2].body == "Post in the channel"
    assert all(child.team_id == TEAM for child in children)


def test_the_create_keeps_only_the_sub_issues_it_names(
    teams: TestClient, issues: TestClient, workspace: str, repositories: Any
) -> None:
    """template_sub_issue_keys keeps the named ones, an empty list keeps none, and an unknown key writes nothing."""
    template = _release(teams)

    some = _create(issues, template_id=template["id"], template_sub_issue_keys=["s2", "s1"])
    none = _create(issues, template_id=template["id"], template_sub_issue_keys=[])
    unknown = _create(issues, template_id=template["id"], template_sub_issue_keys=["s9"])
    untemplated = _create(issues, title="Plain", template_sub_issue_keys=["s1"])

    assert [child.title for child in _children(repositories, some.json()["id"])] == ["Write notes", "Announce it"]
    assert _children(repositories, none.json()["id"]) == []
    assert unknown.status_code == 422
    assert "no sub-issue s9" in unknown.text
    assert untemplated.status_code == 422
    assert len(repositories.issues.page_for_workspace(WORKSPACE, limit=50)) == 4


def test_a_sub_issue_cannot_add_template_sub_issues(
    teams: TestClient, issues: TestClient, workspace: str, repositories: Any
) -> None:
    """Sub-issues are one level deep, so a create under a parent keeping any is refused before it writes."""
    template = _release(teams)
    parent = _create(issues, title="Parent").json()

    refused = _create(issues, template_id=template["id"], parent_id=parent["id"])
    kept_none = _create(issues, template_id=template["id"], parent_id=parent["id"], template_sub_issue_keys=[])

    assert refused.status_code == 422
    assert "one level deep" in refused.text
    assert kept_none.status_code == 201, kept_none.text
    assert [child.title for child in _children(repositories, parent["id"])] == ["Release 1.0"]


def test_a_failed_sub_issue_removes_everything_the_create_wrote(
    teams: TestClient, issues: TestClient, workspace: str, repositories: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When one sub-issue fails, the parent and the sub-issues before it are removed and the 422 names it."""
    template = _release(teams)
    real = issue_writes._create_one
    calls: list[str] = []

    def failing(repositories: Any, context: Any, payload: Any, fresh: Any, **kwargs: Any) -> Any:
        """Create as usual, failing the third sub-issue."""
        calls.append(payload.title)
        if payload.title == "Announce it":
            raise HTTPException(status_code=422, detail={"error_code": "UNPROCESSABLE", "message": "No room."})
        return real(repositories, context, payload, fresh, **kwargs)

    monkeypatch.setattr(issue_writes, "_create_one", failing)

    response = _create(issues, template_id=template["id"])

    assert response.status_code == 422
    assert "Could not create the sub-issue Announce it: No room. Nothing was created." in response.text
    assert len(calls) == 4
    assert repositories.issues.page_for_workspace(WORKSPACE, limit=50) == []
