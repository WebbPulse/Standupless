"""Insights route: breakdowns by one dimension, segments, points and scope.

The properties worth holding are that a breakdown counts exactly what the issue
list with the same filter would list, that a saved view narrows rather than
replaces the request's filter, and that visibility is decided the way the list
decides it, so a guest never sees counts from a team they are outside.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from tests.domains.helpers import GUEST, MEMBER, OWNER, sign_in
from tests.domains.views.conftest import OTHER_TEAM, TEAM, seed_issue


def insights(client: TestClient, workspace: str, **params: Any) -> "dict[str, Any]":
    """Read one breakdown, failing loudly on a refusal."""
    response = client.get(f"/api/workspaces/{workspace}/views/insights", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def by_label(payload: "dict[str, Any]") -> "dict[str, int]":
    """Each bar's value keyed by its display name."""
    return {group["label"]: group["value"] for group in payload["groups"]}


def make_label(repositories: Any, workspace: str, name: str, color: str) -> str:
    """One team label written straight into team config."""
    from app.common.db.dynamo.team_config import Label, label_key, new_config_id

    label_id = new_config_id()
    repositories.team_config.create_label(
        Label(
            workspace_id=workspace,
            config_key=label_key(TEAM, label_id),
            team_id=TEAM,
            label_id=label_id,
            name=name,
            color=color,
        )
    )
    return label_id


def test_status_breakdown_counts_each_issue_in_position_order(
    client: TestClient, issues_client: TestClient, workspace: str, statuses: Any
) -> None:
    """The default breakdown is a count per status, in the board's column order."""
    sign_in(issues_client, OWNER)
    seed_issue(issues_client, workspace, title="One")
    seed_issue(issues_client, workspace, title="Two")
    seed_issue(issues_client, workspace, title="Done", status_id=statuses["completed"].status_id)

    sign_in(client, OWNER)
    payload = insights(client, workspace, team_id=TEAM)

    assert payload["group_by"] == "status"
    assert payload["measure"] == "count"
    assert payload["total"] == 3
    assert payload["issue_count"] == 3
    assert payload["truncated"] is False
    keys = [group["key"] for group in payload["groups"]]
    assert keys.index(statuses["completed"].status_id) == len(keys) - 1
    values = {group["key"]: group["value"] for group in payload["groups"]}
    assert values[statuses["completed"].status_id] == 1
    assert sum(values.values()) == 3


def test_assignee_breakdown_puts_unassigned_last_and_resolves_names(
    client: TestClient, issues_client: TestClient, workspace: str, statuses: Any
) -> None:
    """People are named on the server and the unset bucket closes the list."""
    sign_in(issues_client, OWNER)
    seed_issue(issues_client, workspace, title="A", assignee_id=MEMBER)
    seed_issue(issues_client, workspace, title="B", assignee_id=MEMBER)
    seed_issue(issues_client, workspace, title="C", assignee_id=OWNER)
    seed_issue(issues_client, workspace, title="D")

    sign_in(client, OWNER)
    payload = insights(client, workspace, team_id=TEAM, group_by="assignee")

    labels = [group["label"] for group in payload["groups"]]
    assert labels == ["Mo Member", "Olive Owner", "No assignee"]
    assert payload["groups"][-1]["key"] is None
    assert by_label(payload) == {"Mo Member": 2, "Olive Owner": 1, "No assignee": 1}


def test_points_sum_estimates_and_unestimated_issues_weigh_nothing(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """`measure=points` sums estimates while `issue_count` still counts every issue."""
    repositories.teams.update(workspace, TEAM, estimate_scale="fibonacci")
    sign_in(issues_client, OWNER)
    seed_issue(issues_client, workspace, title="Big", estimate="8", priority="high")
    seed_issue(issues_client, workspace, title="Small", estimate="2", priority="high")
    seed_issue(issues_client, workspace, title="Unsized", priority="low")

    sign_in(client, OWNER)
    payload = insights(client, workspace, team_id=TEAM, group_by="priority", measure="points")

    assert payload["total"] == 10
    assert payload["issue_count"] == 3
    groups = {group["key"]: group for group in payload["groups"]}
    assert groups["high"]["value"] == 10
    assert groups["high"]["issue_count"] == 2
    assert groups["low"]["value"] == 0
    assert groups["low"]["issue_count"] == 1
    assert [group["key"] for group in payload["groups"]] == ["high", "low"]


def test_segments_split_each_bar_by_a_second_dimension(
    client: TestClient, issues_client: TestClient, workspace: str, statuses: Any
) -> None:
    """A segment dimension splits every bar, and the segments add up to the bar."""
    sign_in(issues_client, OWNER)
    seed_issue(issues_client, workspace, title="A", assignee_id=MEMBER, priority="urgent")
    seed_issue(issues_client, workspace, title="B", assignee_id=MEMBER, priority="low")
    seed_issue(issues_client, workspace, title="C", assignee_id=MEMBER, priority="low")

    sign_in(client, OWNER)
    payload = insights(client, workspace, team_id=TEAM, group_by="assignee", segment_by="priority")

    (member,) = payload["groups"]
    assert [segment["key"] for segment in member["segments"]] == ["urgent", "low"]
    assert sum(segment["value"] for segment in member["segments"]) == member["value"] == 3


def test_a_label_breakdown_counts_an_issue_under_every_label_it_carries(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """Label bars can sum past the total, which still counts each issue once."""
    bug = make_label(repositories, workspace, "Bug", "#ff0000")
    ui = make_label(repositories, workspace, "UI", "#00ff00")
    sign_in(issues_client, OWNER)
    seed_issue(issues_client, workspace, title="Both", label_ids=[bug, ui])
    seed_issue(issues_client, workspace, title="Bug only", label_ids=[bug])
    seed_issue(issues_client, workspace, title="Bare")

    sign_in(client, OWNER)
    payload = insights(client, workspace, team_id=TEAM, group_by="label")

    assert payload["total"] == 3
    assert by_label(payload) == {"Bug": 2, "UI": 1, "No label": 1}
    assert payload["groups"][0]["color"] == "#ff0000"


def test_filters_narrow_the_breakdown_the_way_they_narrow_the_list(
    client: TestClient, issues_client: TestClient, workspace: str, statuses: Any
) -> None:
    """The list's filters mean the same here, including category exclusion."""
    sign_in(issues_client, OWNER)
    seed_issue(issues_client, workspace, title="Open", priority="high")
    seed_issue(issues_client, workspace, title="Done", priority="high", status_id=statuses["completed"].status_id)
    seed_issue(issues_client, workspace, title="Low", priority="low")

    sign_in(client, OWNER)
    payload = insights(
        client,
        workspace,
        team_id=TEAM,
        group_by="status_category",
        priority="high",
        status_category_not=["completed", "cancelled"],
    )

    assert payload["total"] == 1
    (group,) = payload["groups"]
    assert group["key"] in ("backlog", "unstarted")
    assert group["label"] in ("Backlog", "Unstarted")


def test_a_saved_view_brings_its_team_and_filter_and_narrows_the_request(
    client: TestClient, issues_client: TestClient, workspace: str, statuses: Any
) -> None:
    """A view's filter is ANDed with the request's, not replaced by it."""
    sign_in(issues_client, OWNER)
    seed_issue(issues_client, workspace, title="Mine high", assignee_id=MEMBER, priority="high")
    seed_issue(issues_client, workspace, title="Mine low", assignee_id=MEMBER, priority="low")
    seed_issue(issues_client, workspace, title="Theirs", assignee_id=OWNER, priority="high")

    sign_in(client, MEMBER)
    created = client.post(
        f"/api/workspaces/{workspace}/views",
        json={"name": "Mine", "team_id": TEAM, "filter": {"assignee_id": ["me"]}},
    )
    assert created.status_code == 201, created.text
    view_id = created.json()["view_id"]

    whole = insights(client, workspace, view_id=view_id, group_by="priority")
    assert whole["team_ids"] == [TEAM]
    assert whole["view_id"] == view_id
    assert whole["total"] == 2

    narrowed = insights(client, workspace, view_id=view_id, group_by="priority", priority="high")
    assert narrowed["total"] == 1


def test_a_team_conflicting_with_the_view_is_refused(client: TestClient, workspace: str, statuses: Any) -> None:
    """Naming another team than the view's is a 422, not a silent pick."""
    sign_in(client, OWNER)
    created = client.post(f"/api/workspaces/{workspace}/views", json={"name": "Ours", "team_id": TEAM})
    assert created.status_code == 201, created.text

    response = client.get(
        f"/api/workspaces/{workspace}/views/insights",
        params={"view_id": created.json()["view_id"], "team_id": OTHER_TEAM},
    )

    assert response.status_code == 422


def test_a_guest_counts_only_the_teams_they_can_read(
    client: TestClient, issues_client: TestClient, workspace: str, statuses: Any
) -> None:
    """With no team named, visibility is the list's: a guest sees their own team only."""
    sign_in(issues_client, OWNER)
    seed_issue(issues_client, workspace, title="Ours")
    seed_issue(issues_client, workspace, title="Theirs", team_id=OTHER_TEAM)

    sign_in(client, OWNER)
    assert insights(client, workspace)["total"] == 2

    sign_in(client, GUEST)
    payload = insights(client, workspace)
    assert payload["team_ids"] == [TEAM]
    assert payload["total"] == 1

    response = client.get(f"/api/workspaces/{workspace}/views/insights", params={"team_id": OTHER_TEAM})
    assert response.status_code == 404


def test_an_unknown_dimension_is_refused(client: TestClient, workspace: str) -> None:
    """A misspelt dimension is a 422 rather than an empty chart."""
    sign_in(client, OWNER)

    response = client.get(f"/api/workspaces/{workspace}/views/insights", params={"group_by": "mood"})

    assert response.status_code == 422


def test_a_scope_past_the_cap_answers_truncated(
    client: TestClient, issues_client: TestClient, workspace: str, statuses: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Past the row cap the answer covers the issues read and says so."""
    import app.common.insights as module

    monkeypatch.setattr(module, "INSIGHTS_ROW_CAP", 2)
    sign_in(issues_client, OWNER)
    for title in ("One", "Two", "Three"):
        seed_issue(issues_client, workspace, title=title)

    sign_in(client, OWNER)
    payload = insights(client, workspace, team_id=TEAM)

    assert payload["truncated"] is True
    assert payload["issue_count"] == 2
    assert payload["row_cap"] == 2


def test_a_team_breakdown_names_each_team_and_segments_by_team(
    client: TestClient, issues_client: TestClient, workspace: str, statuses: Any
) -> None:
    """`team` works as both the bar and the segment dimension, named on the server."""
    sign_in(issues_client, OWNER)
    seed_issue(issues_client, workspace, title="One", priority="high")
    seed_issue(issues_client, workspace, title="Two", priority="high")
    seed_issue(issues_client, workspace, title="Three", team_id=OTHER_TEAM, priority="high")

    sign_in(client, OWNER)
    grouped = insights(client, workspace, group_by="team")
    segmented = insights(client, workspace, group_by="priority", segment_by="team")

    assert by_label(grouped) == {"Abc": 2, "Xyz": 1}
    assert [group["key"] for group in grouped["groups"]] == [TEAM, OTHER_TEAM]
    (high,) = segmented["groups"]
    assert {segment["label"]: segment["value"] for segment in high["segments"]} == {"Abc": 2, "Xyz": 1}
