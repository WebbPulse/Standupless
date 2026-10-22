"""The advanced list filters: any and all, condition groups, and the newer fields.

Each test seeds a few issues that differ in exactly the property under test and
asserts membership, so a filter that quietly matched everything, or nothing, fails
on the row it should have kept or dropped.
"""

from __future__ import annotations

import json
from typing import Any

from fastapi.testclient import TestClient

from app.common.db.dynamo.team_config import Label, label_key, new_config_id
from tests.domains.helpers import MEMBER, OWNER, sign_in
from tests.domains.issues.conftest import OTHER_TEAM, TEAM, create_issue


def _ids(body: Any) -> "set[str]":
    """The ids of a list response as a set, since these assert membership."""
    return {row["id"] for row in body["issues"]}


def _list(client: TestClient, workspace: str, **params: Any) -> Any:
    """One list call, failing loudly on anything but a 200."""
    response = client.get(f"/api/workspaces/{workspace}/issues", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def _label(repositories: Any, workspace: str, name: str) -> str:
    """One label of `TEAM`, seeded straight in the table, answering its id."""
    label_id = new_config_id()
    repositories.team_config.create_label(
        Label(
            workspace_id=workspace,
            config_key=label_key(TEAM, label_id),
            team_id=TEAM,
            label_id=label_id,
            name=name,
            color="#ff0000",
        )
    )
    return label_id


def test_match_any_keeps_an_issue_meeting_one_condition(client: TestClient, workspace: str, statuses: Any) -> None:
    """Under `any`, urgent or assigned to the member is enough, and neither drops the row."""
    sign_in(client, OWNER)
    urgent = create_issue(client, workspace, title="Urgent", priority="urgent")
    assigned = create_issue(client, workspace, title="Assigned", assignee_id=MEMBER)
    create_issue(client, workspace, title="Neither", priority="low")

    both = _list(client, workspace, priority="urgent", assignee_id=MEMBER)
    either = _list(client, workspace, priority="urgent", assignee_id=MEMBER, match="any")

    assert _ids(both) == set()
    assert _ids(either) == {urgent["id"], assigned["id"]}


def test_a_group_counts_as_one_condition(client: TestClient, workspace: str, statuses: Any) -> None:
    """Team is ABC and (urgent or low) keeps the urgent and low rows of that team only."""
    sign_in(client, OWNER)
    urgent = create_issue(client, workspace, title="Urgent", priority="urgent")
    low = create_issue(client, workspace, title="Low", priority="low")
    create_issue(client, workspace, title="Medium", priority="medium")
    create_issue(client, workspace, team_id=OTHER_TEAM, title="Elsewhere", priority="urgent")

    groups = json.dumps([{"match": "any", "priority": ["urgent", "low"]}])
    listed = _list(client, workspace, team_id_in=TEAM, groups=groups)

    assert _ids(listed) == {urgent["id"], low["id"]}


def test_groups_nest_two_levels_under_a_fixed_scope(client: TestClient, workspace: str, statuses: Any) -> None:
    """A client wraps its own any-conditions in one group so the scope still ANDs."""
    sign_in(client, OWNER)
    urgent = create_issue(client, workspace, title="Urgent", priority="urgent")
    both = create_issue(client, workspace, title="Low and assigned", priority="low", assignee_id=MEMBER)
    create_issue(client, workspace, title="Low only", priority="low")
    create_issue(client, workspace, team_id=OTHER_TEAM, title="Elsewhere", priority="urgent")

    wrapper = {
        "match": "any",
        "priority": "urgent",
        "groups": [{"priority": "low", "assignee_id": MEMBER}],
    }
    listed = _list(client, workspace, team_id_in=TEAM, groups=json.dumps([wrapper]))

    assert _ids(listed) == {urgent["id"], both["id"]}


def test_groups_refuse_a_third_level_and_scope_keys(client: TestClient, workspace: str, statuses: Any) -> None:
    """A group three levels deep, a group carrying a search, or bad JSON is a 422, not a silent match."""
    sign_in(client, OWNER)
    base = f"/api/workspaces/{workspace}/issues"
    deep = [{"groups": [{"groups": [{"priority": "low"}]}]}]

    assert client.get(base, params={"groups": json.dumps(deep)}).status_code == 422
    assert client.get(base, params={"groups": json.dumps([{"q": "x"}])}).status_code == 422
    assert client.get(base, params={"groups": "not json"}).status_code == 422
    assert client.get(base, params={"match": "some"}).status_code == 422


def test_label_all_wants_every_label(client: TestClient, workspace: str, repositories: Any, statuses: Any) -> None:
    """Includes any keeps either label, includes all keeps only the issue carrying both."""
    bug = _label(repositories, workspace, "Bug")
    ui = _label(repositories, workspace, "UI")
    sign_in(client, OWNER)
    both = create_issue(client, workspace, title="Both", label_ids=[bug, ui])
    one = create_issue(client, workspace, title="One", label_ids=[bug])
    create_issue(client, workspace, title="None")

    assert _ids(_list(client, workspace, label_id=[bug, ui])) == {both["id"], one["id"]}
    assert _ids(_list(client, workspace, label_id_all=[bug, ui])) == {both["id"]}


def test_parent_and_sub_issue_filters(client: TestClient, workspace: str, statuses: Any) -> None:
    """Top level only, has sub-issues and not under a parent each keep the right rows."""
    sign_in(client, OWNER)
    parent = create_issue(client, workspace, title="Parent")
    child = create_issue(client, workspace, title="Child", parent_id=parent["id"])
    loose = create_issue(client, workspace, title="Loose")

    assert _ids(_list(client, workspace, parent_id="none")) == {parent["id"], loose["id"]}
    assert _ids(_list(client, workspace, has_sub_issues="true")) == {parent["id"]}
    assert _ids(_list(client, workspace, has_sub_issues="false")) == {child["id"], loose["id"]}
    assert _ids(_list(client, workspace, parent_id_not=parent["id"])) == {parent["id"], loose["id"]}


def test_content_matches_title_and_description(client: TestClient, workspace: str, statuses: Any) -> None:
    """Content is a case insensitive substring of the title or the description, unlike `q`."""
    sign_in(client, OWNER)
    titled = create_issue(client, workspace, title="Cache the token")
    described = create_issue(client, workspace, title="Speed", body="The TOKEN cache misses")
    other = create_issue(client, workspace, title="Unrelated")

    assert _ids(_list(client, workspace, content="token")) == {titled["id"], described["id"]}
    assert _ids(_list(client, workspace, content_not="token")) == {other["id"]}


def test_completed_at_follows_the_status_and_filters_by_day(client: TestClient, workspace: str, statuses: Any) -> None:
    """Landing in a completed status stamps the moment, reopening clears it, and the filter reads it."""
    sign_in(client, OWNER)
    done = create_issue(client, workspace, title="Done", status_id=statuses["completed"].status_id)
    reopened = create_issue(client, workspace, title="Reopened", status_id=statuses["completed"].status_id)
    create_issue(client, workspace, title="Open")
    assert done["completed_at"] is not None
    assert reopened["completed_at"] is not None

    patched = client.patch(
        f"/api/workspaces/{workspace}/issues/{reopened['id']}",
        json={"status_id": statuses["unstarted"].status_id},
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["completed_at"] is None

    assert _ids(_list(client, workspace, completed_after="2000-01-01")) == {done["id"]}
    assert _ids(_list(client, workspace, completed_before="2000-01-01")) == set()


def test_subscriber_filters_name_any_member(client: TestClient, workspace: str, statuses: Any) -> None:
    """Subscribed by the member, and not subscribed by them, split the rows between them."""
    sign_in(client, OWNER)
    followed = create_issue(client, workspace, title="Followed")
    unfollowed = create_issue(client, workspace, title="Unfollowed")
    sign_in(client, MEMBER)
    assert client.put(f"/api/workspaces/{workspace}/issues/{followed['id']}/subscribers/me").status_code == 200

    sign_in(client, OWNER)

    assert _ids(_list(client, workspace, subscriber_id=MEMBER)) == {followed["id"]}
    assert _ids(_list(client, workspace, subscriber_id_not=MEMBER)) == {unfollowed["id"]}
    assert _ids(_list(client, workspace, subscriber_id=[MEMBER, OWNER])) == {followed["id"], unfollowed["id"]}


def test_a_subscriber_condition_inside_a_group(client: TestClient, workspace: str, statuses: Any) -> None:
    """Urgent, or followed by the member, reads the member's subscriptions for the group."""
    sign_in(client, OWNER)
    urgent = create_issue(client, workspace, title="Urgent", priority="urgent")
    followed = create_issue(client, workspace, title="Followed", priority="low")
    create_issue(client, workspace, title="Neither", priority="low")
    sign_in(client, MEMBER)
    assert client.put(f"/api/workspaces/{workspace}/issues/{followed['id']}/subscribers/me").status_code == 200

    sign_in(client, OWNER)
    groups = json.dumps([{"match": "any", "priority": "urgent", "subscriber_id": MEMBER}])

    assert _ids(_list(client, workspace, groups=groups)) == {urgent["id"], followed["id"]}
