"""The notify consumer's team subscriptions: a team's new, triaged, completed and cancelled issues.

These pin the fan-out, that each subscriber hears of the events they turned on
and nothing else, and the guards around it: the actor never hears of their own
write, a bulk import notifies nobody, a private team reaches only its members,
and a person already told of the same write by an assignment, a subscription or
a followed view gets that one notification alone.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.domains.views.consumers.notify import handle_record
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER, add_team_member, sign_in
from tests.domains.views.conftest import OTHER_TEAM, TEAM, seed_issue
from tests.domains.views.test_notify_consumer import ISSUES_ARN, _image, _record, inbox_of
from tests.domains.views.test_notify_issue_changes import kinds, move_record
from tests.domains.views.test_notify_view_subscriptions import _image as stored_image
from tests.domains.views.test_notify_view_subscriptions import _record as stream_record
from tests.domains.views.test_saved_views import create_view


def subscribe(repositories: Any, workspace: str, user_id: str, team_id: str = TEAM, **events: bool) -> None:
    """Turn the named team events on for one member, straight into the store."""
    repositories.views.set_team_subscription(workspace, team_id, user_id, events)


def created_record(workspace: str, issue_id: str, actor: str, **extra: Any) -> "dict[str, Any]":
    """The insert record one new issue produces, created by `actor`."""
    encoded = _image(
        workspace_id=workspace,
        issue_id=issue_id,
        created_by=actor,
        created_at="2026-10-24T10:00:00+00:00",
        **extra,
    )
    return _record(ISSUES_ARN, "INSERT", new=encoded)


def triaged_record(workspace: str, issue_id: str, actor: str) -> "dict[str, Any]":
    """The insert record of an issue created straight into triage."""
    record = created_record(workspace, issue_id, actor)
    record["dynamodb"]["NewImage"]["in_triage"] = {"BOOL": True}
    return record


def test_a_new_issue_tells_each_subscriber_who_turned_it_on(
    issues_client: TestClient, workspace: str, repositories: Any
) -> None:
    """Issue created reaches its subscribers as `team_issue_created`; anyone subscribed only to closes hears nothing."""
    subscribe(repositories, workspace, MEMBER, issue_created=True)
    subscribe(repositories, workspace, ADMIN, completed=True, cancelled=True)
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Fresh")

    handle_record(repositories, created_record(workspace, issue["id"], OWNER))

    rows = inbox_of(repositories, workspace, MEMBER)
    assert [row["kind"] for row in rows] == ["team_issue_created"]
    assert rows[0]["issue_key"] == issue["key"]
    assert kinds(repositories, workspace, ADMIN) == []


def test_the_actor_never_hears_of_their_own_new_issue(
    issues_client: TestClient, workspace: str, repositories: Any
) -> None:
    """A subscriber who created the issue already knows."""
    subscribe(repositories, workspace, OWNER, issue_created=True)
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace)

    handle_record(repositories, created_record(workspace, issue["id"], OWNER))

    assert kinds(repositories, workspace, OWNER) == []


def test_an_issue_on_another_team_stays_quiet(issues_client: TestClient, workspace: str, repositories: Any) -> None:
    """A subscription follows one team, never the workspace."""
    subscribe(repositories, workspace, MEMBER, issue_created=True)
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, team_id=OTHER_TEAM)

    handle_record(repositories, created_record(workspace, issue["id"], OWNER))

    assert kinds(repositories, workspace, MEMBER) == []


def test_an_issue_created_in_triage_notifies_once_per_subscriber(
    issues_client: TestClient, workspace: str, repositories: Any
) -> None:
    """Triage subscribers get `triage_new`, created-only ones `team_issue_created`, and both gets one row."""
    subscribe(repositories, workspace, MEMBER, triage=True)
    subscribe(repositories, workspace, ADMIN, issue_created=True)
    subscribe(repositories, workspace, GUEST, issue_created=True, triage=True)
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace)

    handle_record(repositories, triaged_record(workspace, issue["id"], OWNER))

    assert kinds(repositories, workspace, MEMBER) == ["triage_new"]
    assert kinds(repositories, workspace, ADMIN) == ["team_issue_created"]
    assert kinds(repositories, workspace, GUEST) == ["triage_new"]


def test_completing_and_cancelling_reach_their_subscribers(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """A move into completed reaches completed subscribers, a move into cancelled the cancelled ones."""
    subscribe(repositories, workspace, MEMBER, completed=True)
    subscribe(repositories, workspace, ADMIN, cancelled=True)
    sign_in(issues_client, OWNER)
    done = seed_issue(issues_client, workspace, title="Done")
    dropped = seed_issue(issues_client, workspace, title="Dropped")
    started = statuses["started"].status_id

    handle_record(repositories, move_record(workspace, done["id"], OWNER, started, statuses["completed"].status_id))
    handle_record(repositories, move_record(workspace, dropped["id"], OWNER, started, statuses["cancelled"].status_id))

    member_rows = inbox_of(repositories, workspace, MEMBER)
    assert [(row["kind"], row["issue_key"]) for row in member_rows] == [("issue_completed", done["key"])]
    assert member_rows[0]["new_value"] == statuses["completed"].name
    admin_rows = inbox_of(repositories, workspace, ADMIN)
    assert [(row["kind"], row["issue_key"]) for row in admin_rows] == [("issue_cancelled", dropped["key"])]


def test_a_move_that_is_not_a_close_stays_quiet(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """Moving to started is not a close to report."""
    subscribe(repositories, workspace, MEMBER, completed=True, cancelled=True)
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace)

    handle_record(
        repositories,
        move_record(workspace, issue["id"], OWNER, statuses["unstarted"].status_id, statuses["started"].status_id),
    )

    assert kinds(repositories, workspace, MEMBER) == []


def test_an_assignee_who_also_subscribes_hears_once(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """The assignment already tells them of the close, so the team subscription adds nothing."""
    subscribe(repositories, workspace, MEMBER, completed=True)
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, assignee_id=MEMBER)

    handle_record(
        repositories,
        move_record(
            workspace,
            issue["id"],
            OWNER,
            statuses["started"].status_id,
            statuses["completed"].status_id,
            assignee=MEMBER,
        ),
    )

    assert kinds(repositories, workspace, MEMBER) == ["issue_completed"]


def test_a_view_follower_who_also_subscribes_hears_once(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any
) -> None:
    """The view notice wins for a new issue entering a followed view, and the team notice is not added."""
    sign_in(client, MEMBER)
    view = create_view(client, workspace, name="Hot", shared=True, filter={"priority": "high"})
    assert client.put(f"/api/workspaces/{workspace}/views/{view['view_id']}/subscription").status_code == 200
    subscribe(repositories, workspace, MEMBER, issue_created=True)
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, priority="high")

    handle_record(repositories, stream_record(stored_image(repositories, workspace, issue["id"])))

    assert kinds(repositories, workspace, MEMBER) == ["view_issue_added"]


def test_a_bulk_import_notifies_no_subscriber(issues_client: TestClient, workspace: str, repositories: Any) -> None:
    """A row an import wrote carries its batch id, and the consumer stays quiet for it."""
    subscribe(repositories, workspace, MEMBER, issue_created=True, triage=True)
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace)

    handle_record(repositories, created_record(workspace, issue["id"], OWNER, import_batch_id="IMP1"))

    assert kinds(repositories, workspace, MEMBER) == []


def test_a_private_team_reaches_only_its_members(issues_client: TestClient, workspace: str, repositories: Any) -> None:
    """A subscriber who lost sight of the team when it went private hears nothing; a team member still does."""
    subscribe(repositories, workspace, ADMIN, issue_created=True)
    subscribe(repositories, workspace, MEMBER, issue_created=True)
    add_team_member(repositories, workspace, TEAM, MEMBER, "member")
    repositories.memberships.set_team_private(workspace, TEAM, True)
    sign_in(issues_client, MEMBER)
    issue = seed_issue(issues_client, workspace)

    handle_record(repositories, created_record(workspace, issue["id"], GUEST))

    assert kinds(repositories, workspace, ADMIN) == []
    assert kinds(repositories, workspace, MEMBER) == ["team_issue_created"]
