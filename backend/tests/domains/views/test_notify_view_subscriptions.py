"""The notify consumer's view subscription notice: an issue entering a followed view.

These pin the transition rule, that a follower hears of an issue only when a
write makes it match a view it did not match before, and the guards around it:
the follower's own change says nothing, an issue they cannot see says nothing, a
view they can no longer read says nothing, and unfollowing stops the notices.
"""

from __future__ import annotations

import json
from decimal import Decimal
from typing import Any, Optional

from boto3.dynamodb.types import TypeSerializer
from fastapi.testclient import TestClient
from webbpulse.dynamodb import table_name

from app.common.core.config import settings
from app.common.db.dynamo.issues import as_issue_item
from app.domains.views.consumers.notify import handle_record
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER, sign_in
from tests.domains.views.conftest import OTHER_TEAM, TEAM, seed_issue
from tests.domains.views.test_saved_views import create_view

ISSUES_ARN = f"arn:aws:dynamodb:us-west-2:1234:table/{table_name('issues', settings.dynamodb_table_prefix)}/stream/x"

SERIALIZER = TypeSerializer()


def _image(repositories: Any, workspace: str, issue_id: str) -> "dict[str, Any]":
    """The stored issue as a stream image in DynamoDB's wire encoding, whole as the table holds it."""
    issue = repositories.issues.get(workspace, issue_id)
    assert issue is not None
    item = json.loads(json.dumps(as_issue_item(issue)), parse_float=Decimal)
    return {name: SERIALIZER.serialize(value) for name, value in item.items()}


def _record(new: "dict[str, Any]", old: Optional["dict[str, Any]"] = None) -> "dict[str, Any]":
    """One issues stream record shaped the way Lambda delivers it, a modify when `old` is given."""
    dynamodb: "dict[str, Any]" = {"NewImage": new}
    if old is not None:
        dynamodb["OldImage"] = old
    event = "MODIFY" if old is not None else "INSERT"
    return {"eventName": event, "eventID": "1", "eventSourceARN": ISSUES_ARN, "dynamodb": dynamodb}


def _view_rows(repositories: Any, workspace: str, user_id: str) -> "list[dict[str, Any]]":
    """Every view subscription notice one member holds."""
    rows = repositories.inbox.list(workspace, user_id, limit=50).items
    return [row for row in rows if row["kind"] == "view_issue_added"]


def _follow(client: TestClient, workspace: str, user_id: str, **payload: Any) -> "dict[str, Any]":
    """Save a view as one member and follow it, answering the view."""
    sign_in(client, user_id)
    view = create_view(client, workspace, **payload)
    response = client.put(f"/api/workspaces/{workspace}/views/{view['view_id']}/subscription")
    assert response.status_code == 200, response.text
    return view


def _raise_priority(
    issues_client: TestClient, repositories: Any, workspace: str, issue_id: str, actor: str
) -> "dict[str, Any]":
    """Raise one issue to high priority as `actor`, answering the modify record the write streams."""
    before = _image(repositories, workspace, issue_id)
    sign_in(issues_client, actor)
    response = issues_client.patch(f"/api/workspaces/{workspace}/issues/{issue_id}", json={"priority": "high"})
    assert response.status_code == 200, response.text
    return _record(_image(repositories, workspace, issue_id), before)


def test_an_issue_changed_into_a_followed_view_notifies_once_naming_the_view(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any
) -> None:
    """The follower hears of the issue that now matches, with the view named and the issue linked."""
    _follow(client, workspace, MEMBER, name="Hot", shared=True, filter={"priority": "high"})
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, priority="low")

    handle_record(repositories, _raise_priority(issues_client, repositories, workspace, issue["id"], OWNER))

    rows = _view_rows(repositories, workspace, MEMBER)
    assert len(rows) == 1
    assert rows[0]["new_value"] == "Hot"
    assert rows[0]["issue_key"] == issue["key"]


def test_an_issue_created_into_a_followed_view_notifies(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any
) -> None:
    """A created issue matched nothing before, so landing in the view is an entry."""
    _follow(client, workspace, MEMBER, name="Hot", shared=True, filter={"priority": "high"})
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, priority="high")

    handle_record(repositories, _record(_image(repositories, workspace, issue["id"])))

    assert len(_view_rows(repositories, workspace, MEMBER)) == 1


def test_an_issue_already_in_the_view_stays_quiet(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any
) -> None:
    """A change to an issue that matched before and after is no transition."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, priority="low")
    _follow(client, workspace, MEMBER, name="Team issues", shared=True, filter={"team_id": TEAM})

    handle_record(repositories, _raise_priority(issues_client, repositories, workspace, issue["id"], OWNER))

    assert _view_rows(repositories, workspace, MEMBER) == []


def test_an_issue_that_never_matches_stays_quiet(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any
) -> None:
    """An issue outside the view before and after the write says nothing."""
    _follow(client, workspace, MEMBER, name="Urgent", shared=True, filter={"priority": "urgent"})
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, priority="low")

    handle_record(repositories, _raise_priority(issues_client, repositories, workspace, issue["id"], OWNER))

    assert _view_rows(repositories, workspace, MEMBER) == []


def test_the_followers_own_change_stays_quiet(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any
) -> None:
    """The member who moved the issue into the view already knows."""
    _follow(client, workspace, MEMBER, name="Hot", shared=True, filter={"priority": "high"})
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, priority="low")

    handle_record(repositories, _raise_priority(issues_client, repositories, workspace, issue["id"], MEMBER))

    assert _view_rows(repositories, workspace, MEMBER) == []


def test_an_issue_the_follower_cannot_see_stays_quiet(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any
) -> None:
    """The guest follows a view of their own, and an issue on a team they are not on never reaches them."""
    _follow(client, workspace, GUEST, name="Hot", filter={"priority": "high"})
    sign_in(issues_client, OWNER)
    hidden = seed_issue(issues_client, workspace, team_id=OTHER_TEAM, priority="low")
    shown = seed_issue(issues_client, workspace, team_id=TEAM, priority="low")

    handle_record(repositories, _raise_priority(issues_client, repositories, workspace, hidden["id"], OWNER))
    handle_record(repositories, _raise_priority(issues_client, repositories, workspace, shown["id"], OWNER))

    rows = _view_rows(repositories, workspace, GUEST)
    assert [row["issue_key"] for row in rows] == [shown["key"]]


def test_a_view_the_follower_can_no_longer_read_stays_quiet(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any
) -> None:
    """A follow left on another member's personal view never tells the follower what it holds."""
    view = _follow(client, workspace, MEMBER, name="Hot", filter={"priority": "high"})
    stored = next(row for row in repositories.views.list_subscriptions(workspace) if row.view_id == view["view_id"])
    saved = repositories.views.get(workspace, stored.saved_view_key)
    repositories.views.subscribe(workspace, saved, ADMIN)
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, priority="low")

    handle_record(repositories, _raise_priority(issues_client, repositories, workspace, issue["id"], OWNER))

    assert len(_view_rows(repositories, workspace, MEMBER)) == 1
    assert _view_rows(repositories, workspace, ADMIN) == []


def test_unfollowing_stops_the_notices(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any
) -> None:
    """Once unfollowed, an issue entering the view tells the former follower nothing."""
    view = _follow(client, workspace, MEMBER, name="Hot", shared=True, filter={"priority": "high"})
    response = client.delete(f"/api/workspaces/{workspace}/views/{view['view_id']}/subscription")
    assert response.status_code == 200, response.text
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, priority="low")

    handle_record(repositories, _raise_priority(issues_client, repositories, workspace, issue["id"], OWNER))

    assert _view_rows(repositories, workspace, MEMBER) == []
