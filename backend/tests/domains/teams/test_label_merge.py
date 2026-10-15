"""Merging one label into another, through the team and workspace label routes.

These pin the merge contract: both labels share a scope, every issue carrying the
merged label carries the kept one once, saved views and templates naming it are
repointed, the merged label is deleted, the history and the audit log record it,
and a retry, a resumed merge and a replay after it finished are all safe.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common import label_merge
from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.team_templates import IssueTemplate, template_key
from app.common.db.dynamo.views import SavedView, new_view_id, personal_view_key, team_view_key
from tests.domains.helpers import ADMIN, MEMBER, OWNER, add_member, make_team, make_workspace, sign_in

WORKSPACE = "01JB00000000000000000000WS"

TEAM = "01JB000000000000000000PRJ1"

OTHER = "01JB000000000000000000PRJ2"

BASE = f"/api/workspaces/{WORKSPACE}"


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client for the teams application, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["teams"])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def teams(repositories: Any, client: TestClient) -> tuple[str, str]:
    """A workspace with an admin and a member, holding two teams, signed in as the owner."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    make_team(repositories, WORKSPACE, TEAM, "APO")
    make_team(repositories, WORKSPACE, OTHER, "GEM")
    sign_in(client, OWNER)
    return TEAM, OTHER


def _team_label(client: TestClient, name: str, team_id: str = TEAM, **extra: Any) -> str:
    """Create one of a team's own labels and return its id."""
    response = client.post(f"{BASE}/teams/{team_id}/labels", json={"name": name, "color": "#eb5757", **extra})
    assert response.status_code == 201, response.text
    return str(response.json()["id"])


def _workspace_label(client: TestClient, name: str, **extra: Any) -> str:
    """Create a workspace label and return its id."""
    response = client.post(f"{BASE}/labels", json={"name": name, "color": "#eb5757", **extra})
    assert response.status_code == 201, response.text
    return str(response.json()["id"])


def _issue(repositories: Any, team_id: str, number: int, label_ids: list[str]) -> Issue:
    """Put one issue carrying `label_ids` in, as the issues domain would have stored it."""
    return repositories.issues.create(
        Issue(
            workspace_id=WORKSPACE,
            team_id=team_id,
            key=f"APO-{number}",
            number=number,
            title=f"Issue {number}",
            status_id="status",
            label_ids=label_ids,
            created_by=OWNER,
        )
    )


def _labels_of(repositories: Any, issue: Issue) -> list[str]:
    """The labels one issue carries now."""
    return list(repositories.issues.get(WORKSPACE, issue.issue_id).label_ids)


def _view(repositories: Any, view_key: str, view_id: str, label_filter: dict[str, Any]) -> SavedView:
    """Store one saved view filtering on labels."""
    return repositories.views.create(
        SavedView(
            workspace_id=WORKSPACE,
            view_key=view_key,
            view_id=view_id,
            name="Bugs",
            filter=label_filter,
            owner_id=OWNER,
            team_id=TEAM if view_key.startswith("team#") else None,
        )
    )


def _merge(client: TestClient, label_id: str, into: str, team_id: str | None = TEAM) -> Any:
    """Merge one label into another through the team route, or the workspace route with no team."""
    path = f"{BASE}/teams/{team_id}/labels/{label_id}/merge" if team_id else f"{BASE}/labels/{label_id}/merge"
    return client.post(path, json={"target_label_id": into})


def test_a_team_merge_moves_issues_and_deletes_the_label(
    client: TestClient, teams: tuple[str, str], repositories: Any
) -> None:
    """Issues carrying the merged label carry the kept one, once, in place, and the merged label is gone."""
    bug = _team_label(client, "Bug")
    defect = _team_label(client, "Defect")
    ui = _team_label(client, "UI")
    only = _issue(repositories, TEAM, 1, [ui, defect])
    both = _issue(repositories, TEAM, 2, [bug, defect])
    neither = _issue(repositories, TEAM, 3, [ui])

    response = _merge(client, defect, bug)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["complete"] is True
    assert body["issues_updated"] == 2
    assert body["source_name"] == "Defect"
    assert body["target"]["id"] == bug
    assert _labels_of(repositories, only) == [ui, bug]
    assert _labels_of(repositories, both) == [bug]
    assert _labels_of(repositories, neither) == [ui]
    listed = {row["id"] for row in client.get(f"{BASE}/teams/{TEAM}/labels").json()["labels"]}
    assert defect not in listed
    assert bug in listed


def test_a_merge_records_history_and_the_audit_log(
    client: TestClient, teams: tuple[str, str], repositories: Any
) -> None:
    """Each moved issue records the label change, and the merge is one audit event."""
    bug = _team_label(client, "Bug")
    defect = _team_label(client, "Defect")
    issue = _issue(repositories, TEAM, 1, [defect])

    assert _merge(client, defect, bug).status_code == 200

    rows = repositories.activity.list_for_issue(WORKSPACE, issue.issue_id).items
    changes = [row for row in rows if row.get("field") == "label_ids"]
    assert [(row["from_value"], row["to_value"]) for row in changes] == [([defect], [bug])]
    events = [row for row in repositories.audit.list_events(WORKSPACE).events if row.action == "label.merged"]
    assert len(events) == 1
    assert events[0].target.id == bug
    assert events[0].before["label_id"] == defect
    assert events[0].after["issues_updated"] == 1


def test_a_merge_repoints_saved_views_and_templates(
    client: TestClient, teams: tuple[str, str], repositories: Any
) -> None:
    """Views filtering on the merged label and templates carrying it name the kept label instead."""
    bug = _team_label(client, "Bug")
    defect = _team_label(client, "Defect")
    personal_id, team_id_view, untouched_id = new_view_id(), new_view_id(), new_view_id()
    _view(repositories, personal_view_key(OWNER, personal_id), personal_id, {"label_id": [defect, bug]})
    _view(repositories, team_view_key(TEAM, team_id_view), team_id_view, {"label_id_not": defect})
    _view(repositories, personal_view_key(OWNER, untouched_id), untouched_id, {"label_id": bug})
    template = repositories.team_config.create_template(
        IssueTemplate(
            workspace_id=WORKSPACE,
            config_key=template_key(TEAM, "tpl1"),
            template_id="tpl1",
            team_id=TEAM,
            name="Bug report",
            label_ids=[defect],
        )
    )

    body = _merge(client, defect, bug).json()

    assert body["views_updated"] == 2
    assert body["templates_updated"] == 1
    assert repositories.views.get(WORKSPACE, personal_view_key(OWNER, personal_id)).filter == {"label_id": [bug]}
    assert repositories.views.get(WORKSPACE, team_view_key(TEAM, team_id_view)).filter == {"label_id_not": bug}
    assert repositories.views.get(WORKSPACE, personal_view_key(OWNER, untouched_id)).filter == {"label_id": bug}
    stored = repositories.team_config.get_template(WORKSPACE, TEAM, template.template_id)
    assert stored.label_ids == [bug]


def test_a_retried_merge_answers_the_finished_result(
    client: TestClient, teams: tuple[str, str], repositories: Any
) -> None:
    """Calling the merge again after it finished answers the same result rather than a 404."""
    bug = _team_label(client, "Bug")
    defect = _team_label(client, "Defect")
    _issue(repositories, TEAM, 1, [defect])
    first = _merge(client, defect, bug).json()

    again = _merge(client, defect, bug)

    assert again.status_code == 200, again.text
    assert again.json() == first
    other = _team_label(client, "Other")
    assert _merge(client, defect, other).status_code == 409


def test_a_merge_out_of_time_resumes_on_the_next_call(
    client: TestClient, teams: tuple[str, str], repositories: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A merge that runs out of time keeps the label, says so, and the next call finishes it."""
    bug = _team_label(client, "Bug")
    defect = _team_label(client, "Defect")
    issues = [_issue(repositories, TEAM, number, [defect]) for number in (1, 2, 3)]
    monkeypatch.setattr(label_merge, "MERGE_BUDGET_SECONDS", 0.0)

    partial = _merge(client, defect, bug).json()

    assert partial["complete"] is False
    assert partial["issues_updated"] == 1
    assert repositories.team_config.get_label(WORKSPACE, TEAM, defect) is not None
    monkeypatch.setattr(label_merge, "MERGE_BUDGET_SECONDS", 20.0)

    finished = _merge(client, defect, bug).json()

    assert finished["complete"] is True
    assert finished["issues_updated"] == 3
    assert all(_labels_of(repositories, issue) == [bug] for issue in issues)
    assert repositories.team_config.get_label(WORKSPACE, TEAM, defect) is None


def test_a_merge_into_a_grouped_label_swaps_its_group_sibling(
    client: TestClient, teams: tuple[str, str], repositories: Any
) -> None:
    """An issue taking a grouped label gives up the other label of that group it carried."""
    group = _team_label(client, "Severity", is_group=True)
    high = _team_label(client, "High", parent_id=group)
    low = _team_label(client, "Low", parent_id=group)
    urgent = _team_label(client, "Urgent")
    issue = _issue(repositories, TEAM, 1, [low, urgent])

    assert _merge(client, urgent, high).status_code == 200

    assert _labels_of(repositories, issue) == [high]


def test_a_merge_is_refused_across_scopes_into_itself_and_for_groups(
    client: TestClient, teams: tuple[str, str]
) -> None:
    """A merge needs two different non-group labels of the same team."""
    bug = _team_label(client, "Bug")
    elsewhere = _team_label(client, "Elsewhere", team_id=OTHER)
    shared = _workspace_label(client, "Shared")
    group = _team_label(client, "Area", is_group=True)

    assert _merge(client, bug, bug).status_code == 422
    assert _merge(client, bug, group).status_code == 422
    assert _merge(client, group, bug).status_code == 422
    assert _merge(client, bug, shared).status_code == 422
    assert _merge(client, bug, elsewhere).status_code == 404
    assert _merge(client, shared, bug).status_code == 409
    assert _merge(client, "missing", bug).status_code == 404


def test_a_member_cannot_merge_team_labels(client: TestClient, teams: tuple[str, str]) -> None:
    """Merging is team admin work, like deleting a label."""
    bug = _team_label(client, "Bug")
    defect = _team_label(client, "Defect")
    sign_in(client, MEMBER)

    assert _merge(client, defect, bug).status_code == 403


def test_a_workspace_merge_reaches_every_team(client: TestClient, teams: tuple[str, str], repositories: Any) -> None:
    """A workspace merge moves every team's issues, drops overrides and deletes the merged label."""
    bug = _workspace_label(client, "Bug")
    defect = _workspace_label(client, "Defect")
    first = _issue(repositories, TEAM, 1, [defect])
    second = _issue(repositories, OTHER, 2, [defect, bug])
    hidden = client.patch(f"{BASE}/teams/{OTHER}/labels/{defect}/override", json={"hidden": True})
    assert hidden.status_code == 200, hidden.text

    response = _merge(client, defect, bug, team_id=None)

    assert response.status_code == 200, response.text
    assert response.json()["issues_updated"] == 2
    assert _labels_of(repositories, first) == [bug]
    assert _labels_of(repositories, second) == [bug]
    assert repositories.team_config.get_workspace_label(WORKSPACE, defect) is None
    assert repositories.team_config.get_override(WORKSPACE, OTHER, "label", defect) is None
    listed = {row["id"] for row in client.get(f"{BASE}/labels").json()["labels"]}
    assert listed == {bug}


def test_a_workspace_merge_needs_two_workspace_labels_and_an_admin(client: TestClient, teams: tuple[str, str]) -> None:
    """A team label is not a workspace merge target, and a member may not merge workspace labels."""
    bug = _workspace_label(client, "Bug")
    defect = _workspace_label(client, "Defect")
    team_only = _team_label(client, "Team only")

    assert _merge(client, defect, team_only, team_id=None).status_code == 404
    sign_in(client, MEMBER)
    assert _merge(client, defect, bug, team_id=None).status_code == 403
