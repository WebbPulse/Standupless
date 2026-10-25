"""The notify consumer's newer kinds: reactions, completions, cancellations, urgent priority and blocking.

Each test hands the consumer the stream record the write would produce and reads
who holds a row afterwards. The actor never does, and reactions on one comment
within an hour fold into one row.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient
from webbpulse.dynamodb import table_name
from webbpulse.identity.email import RecordingEmailSender

from app.common.core.config import settings
from app.common.email import reset_email_sender
from app.domains.views.consumers.notify import handle_record
from tests.domains.helpers import ADMIN, MEMBER, OWNER, sign_in
from tests.domains.views.conftest import TEAM, seed_issue
from tests.domains.views.test_notify_consumer import (
    ISSUES_ARN,
    _image,
    _record,
    flush_digests,
    inbox_of,
    put_comment,
)

REACTIONS_ARN = (
    f"arn:aws:dynamodb:us-west-2:1234:table/{table_name('reactions', settings.dynamodb_table_prefix)}/stream/x"
)

RELATIONS_ARN = (
    f"arn:aws:dynamodb:us-west-2:1234:table/{table_name('relations', settings.dynamodb_table_prefix)}/stream/x"
)

COMMENT = "01JB00000000000000000REACT"


@pytest.fixture
def recorder() -> Iterator[RecordingEmailSender]:
    """A recording sender installed as the process-wide one for one test."""
    sender = RecordingEmailSender()
    reset_email_sender(sender)
    yield sender
    reset_email_sender(None)


def kinds(repositories: Any, workspace: str, user_id: str) -> list[str]:
    """The kinds of every notification one member holds, newest first."""
    return [row["kind"] for row in inbox_of(repositories, workspace, user_id)]


def reaction_record(workspace: str, issue_id: str, user_id: str, emoji: str, at: str) -> "dict[str, Any]":
    """The stream record one new reaction on `COMMENT` produces."""
    return _record(
        REACTIONS_ARN,
        "INSERT",
        new=_image(
            workspace_id=workspace,
            issue_id=issue_id,
            target_id=COMMENT,
            target_kind="comment",
            team_id=TEAM,
            emoji=emoji,
            user_id=user_id,
            created_at=at,
        ),
    )


def move_record(
    workspace: str, issue_id: str, actor: str, old_status: str, new_status: str, assignee: str | None = None
) -> "dict[str, Any]":
    """One issue record that moves the status from `old_status` to `new_status`."""
    return _record(
        ISSUES_ARN,
        "MODIFY",
        new=_image(
            workspace_id=workspace,
            issue_id=issue_id,
            status_id=new_status,
            assignee_id=assignee,
            updated_by=actor,
            updated_at="2026-10-24T10:00:00+00:00",
        ),
        old=_image(workspace_id=workspace, issue_id=issue_id, status_id=old_status, assignee_id=assignee),
    )


def priority_record(workspace: str, issue_id: str, actor: str, old: str, new: str) -> "dict[str, Any]":
    """One issue record that changes the priority and nothing else."""
    return _record(
        ISSUES_ARN,
        "MODIFY",
        new=_image(workspace_id=workspace, issue_id=issue_id, status_id="S", priority=new, updated_by=actor),
        old=_image(workspace_id=workspace, issue_id=issue_id, status_id="S", priority=old),
    )


def link_record(workspace: str, blocker: str, blocked: str, event: str, **extra: Any) -> "dict[str, Any]":
    """The stream record of the `blocks` row of one link, inserted or removed."""
    image = _image(
        workspace_id=workspace,
        relation_key=f"issue#{blocker}#blocks#{blocked}",
        link_id="01JB000000000000000000LINK",
        issue_id=blocker,
        relation_type="blocks",
        target_issue_id=blocked,
        created_at="2026-10-24T10:00:00+00:00",
        **extra,
    )
    if event == "INSERT":
        return _record(RELATIONS_ARN, event, new=image)
    return _record(RELATIONS_ARN, event, old=image)


def by_issue(repositories: Any, workspace: str, user_id: str) -> "dict[str, str]":
    """Each blocking row one member holds, as issue id to `new_value`."""
    return {
        row["issue_id"]: row["new_value"]
        for row in inbox_of(repositories, workspace, user_id)
        if row["kind"] == "blocking_changed"
    }


def test_a_reaction_reaches_the_comment_author_alone(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """Subscribers do not hear about reactions; the author does, with the emoji."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Reacted")
    repositories.subscriptions.subscribe(workspace, issue["id"], TEAM, MEMBER, "manual")
    put_comment(repositories, workspace, issue["id"], COMMENT, author_id=OWNER, body="Shipped it")

    handle_record(repositories, reaction_record(workspace, issue["id"], ADMIN, "🎉", "2026-10-24T10:05:00+00:00"))

    rows = inbox_of(repositories, workspace, OWNER)
    assert [row["kind"] for row in rows] == ["reaction"]
    assert rows[0]["new_value"] == "🎉"
    assert rows[0]["comment_id"] == COMMENT
    assert kinds(repositories, workspace, MEMBER) == []
    assert kinds(repositories, workspace, ADMIN) == []

    sign_in(client, OWNER)
    listed = client.get(f"/api/workspaces/{workspace}/inbox").json()["notifications"]
    assert listed[0]["summary"].endswith(" reacted 🎉 to your comment")


def test_reacting_to_your_own_comment_is_quiet(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """The actor is never notified, even as the comment's author."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Self")
    put_comment(repositories, workspace, issue["id"], COMMENT, author_id=OWNER, body="Mine")

    handle_record(repositories, reaction_record(workspace, issue["id"], OWNER, "👍", "2026-10-24T10:05:00+00:00"))

    assert kinds(repositories, workspace, OWNER) == []


def test_reactions_within_an_hour_fold_into_one_row(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """A burst of reactions is one notification; the next window starts a new one."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Popular")
    put_comment(repositories, workspace, issue["id"], COMMENT, author_id=OWNER, body="Thoughts?")

    handle_record(repositories, reaction_record(workspace, issue["id"], ADMIN, "👍", "2026-10-24T10:05:00+00:00"))
    handle_record(repositories, reaction_record(workspace, issue["id"], MEMBER, "🎉", "2026-10-24T10:40:00+00:00"))
    assert kinds(repositories, workspace, OWNER) == ["reaction"]

    handle_record(repositories, reaction_record(workspace, issue["id"], MEMBER, "❤️", "2026-10-24T11:10:00+00:00"))
    assert kinds(repositories, workspace, OWNER) == ["reaction", "reaction"]


def test_reactions_stay_out_of_email_by_default(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any, recorder: RecordingEmailSender
) -> None:
    """Reactions start inbox only, so nothing is mailed until the author turns email on."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Quiet")
    put_comment(repositories, workspace, issue["id"], COMMENT, author_id=OWNER, body="Hello")

    handle_record(repositories, reaction_record(workspace, issue["id"], ADMIN, "👍", "2026-10-24T10:05:00+00:00"))
    flush_digests(repositories)

    assert kinds(repositories, workspace, OWNER) == ["reaction"]
    assert recorder.sent == []


def test_a_reaction_on_an_issue_rather_than_a_comment_is_ignored(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """Only comment reactions have an author to tell."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Issue reaction")
    record = _record(
        REACTIONS_ARN,
        "INSERT",
        new=_image(
            workspace_id=workspace,
            target_id=issue["id"],
            target_kind="issue",
            team_id=TEAM,
            emoji="👍",
            user_id=ADMIN,
        ),
    )

    handle_record(repositories, record)

    assert kinds(repositories, workspace, OWNER) == []


def test_completing_an_issue_tells_followers_as_completed(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """A move into a completed status is `issue_completed`, not a plain status change."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Finish", assignee_id=MEMBER)
    repositories.subscriptions.subscribe(workspace, issue["id"], TEAM, ADMIN, "manual")
    done = statuses["completed"]

    handle_record(
        repositories,
        move_record(workspace, issue["id"], OWNER, statuses["started"].status_id, done.status_id, assignee=MEMBER),
    )

    assert kinds(repositories, workspace, MEMBER) == ["issue_completed"]
    assert kinds(repositories, workspace, ADMIN) == ["issue_completed"]
    assert kinds(repositories, workspace, OWNER) == []

    sign_in(client, MEMBER)
    listed = client.get(f"/api/workspaces/{workspace}/inbox").json()["notifications"]
    assert listed[0]["summary"].endswith(f" marked as {done.name}")


def test_cancelling_an_issue_tells_followers_as_cancelled(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """A move into a cancelled status is `issue_cancelled`, and the actor stays out."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Drop", assignee_id=MEMBER)
    repositories.subscriptions.subscribe(workspace, issue["id"], TEAM, ADMIN, "manual")

    handle_record(
        repositories,
        move_record(
            workspace,
            issue["id"],
            ADMIN,
            statuses["started"].status_id,
            statuses["cancelled"].status_id,
            assignee=MEMBER,
        ),
    )

    assert kinds(repositories, workspace, MEMBER) == ["issue_cancelled"]
    assert kinds(repositories, workspace, OWNER) == ["issue_cancelled"]
    assert kinds(repositories, workspace, ADMIN) == []


def test_raising_priority_to_urgent_tells_followers(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """The assignee and subscribers hear about a raise to urgent; the actor does not."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Hot", assignee_id=MEMBER)
    repositories.subscriptions.subscribe(workspace, issue["id"], TEAM, ADMIN, "manual")

    handle_record(repositories, priority_record(workspace, issue["id"], ADMIN, "high", "urgent"))

    assert kinds(repositories, workspace, MEMBER) == ["priority_urgent"]
    assert kinds(repositories, workspace, OWNER) == ["priority_urgent"]
    assert kinds(repositories, workspace, ADMIN) == []


def test_priority_changes_other_than_a_raise_to_urgent_are_quiet(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """Staying urgent, or moving to another priority, is not news."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Calm", assignee_id=MEMBER)

    handle_record(repositories, priority_record(workspace, issue["id"], OWNER, "urgent", "urgent"))
    handle_record(repositories, priority_record(workspace, issue["id"], OWNER, "low", "high"))
    handle_record(repositories, priority_record(workspace, issue["id"], OWNER, "urgent", "high"))

    assert kinds(repositories, workspace, MEMBER) == []


def test_adding_a_blocking_link_tells_both_sides(
    client: TestClient, issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """Followers of the blocked issue hear it is blocked; followers of the blocker hear it is blocking."""
    sign_in(issues_client, OWNER)
    blocker = seed_issue(issues_client, workspace, title="Blocker")
    blocked = seed_issue(issues_client, workspace, title="Blocked")
    repositories.subscriptions.subscribe(workspace, blocker["id"], TEAM, ADMIN, "manual")
    repositories.subscriptions.subscribe(workspace, blocked["id"], TEAM, MEMBER, "manual")

    handle_record(repositories, link_record(workspace, blocker["id"], blocked["id"], "INSERT", created_by=OWNER))

    assert by_issue(repositories, workspace, MEMBER) == {blocked["id"]: f"blocked_by:{blocker['key']}"}
    assert by_issue(repositories, workspace, ADMIN) == {blocker["id"]: f"blocking:{blocked['key']}"}
    assert kinds(repositories, workspace, OWNER) == []

    sign_in(client, MEMBER)
    listed = client.get(f"/api/workspaces/{workspace}/inbox").json()["notifications"]
    assert listed[0]["summary"] == f"Blocked by {blocker['key']}"


def test_removing_a_blocking_link_tells_both_sides_but_the_remover(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """The remover stamped on the old image is the actor, so they stay out."""
    sign_in(issues_client, OWNER)
    blocker = seed_issue(issues_client, workspace, title="Blocker")
    blocked = seed_issue(issues_client, workspace, title="Blocked")
    repositories.subscriptions.subscribe(workspace, blocked["id"], TEAM, MEMBER, "manual")
    repositories.subscriptions.subscribe(workspace, blocked["id"], TEAM, ADMIN, "manual")

    handle_record(
        repositories,
        link_record(
            workspace,
            blocker["id"],
            blocked["id"],
            "REMOVE",
            created_by=OWNER,
            removed_by=ADMIN,
            removed_at="2026-10-24T11:00:00+00:00",
        ),
    )

    assert by_issue(repositories, workspace, MEMBER) == {blocked["id"]: f"unblocked_by:{blocker['key']}"}
    assert by_issue(repositories, workspace, OWNER) == {
        blocker["id"]: f"no_longer_blocking:{blocked['key']}",
        blocked["id"]: f"unblocked_by:{blocker['key']}",
    }
    assert kinds(repositories, workspace, ADMIN) == []


def test_links_without_a_person_behind_them_are_quiet(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """A removal with no remover, such as a deleted issue's links, and an imported link notify nobody."""
    sign_in(issues_client, OWNER)
    blocker = seed_issue(issues_client, workspace, title="Blocker")
    blocked = seed_issue(issues_client, workspace, title="Blocked")
    repositories.subscriptions.subscribe(workspace, blocked["id"], TEAM, MEMBER, "manual")

    handle_record(repositories, link_record(workspace, blocker["id"], blocked["id"], "REMOVE", created_by=OWNER))
    handle_record(
        repositories,
        link_record(workspace, blocker["id"], blocked["id"], "INSERT", created_by=ADMIN, import_batch_id="IMP1"),
    )

    assert kinds(repositories, workspace, MEMBER) == []
    assert kinds(repositories, workspace, OWNER) == []


def test_only_the_blocks_row_of_a_link_announces_it(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """The inverse row of the same link is read past, so nobody hears twice."""
    sign_in(issues_client, OWNER)
    blocker = seed_issue(issues_client, workspace, title="Blocker")
    blocked = seed_issue(issues_client, workspace, title="Blocked")
    repositories.subscriptions.subscribe(workspace, blocked["id"], TEAM, MEMBER, "manual")
    inverse = _record(
        RELATIONS_ARN,
        "INSERT",
        new=_image(
            workspace_id=workspace,
            link_id="01JB000000000000000000LINK",
            issue_id=blocked["id"],
            relation_type="blocked_by",
            target_issue_id=blocker["id"],
            created_by=ADMIN,
        ),
    )

    handle_record(repositories, inverse)

    assert kinds(repositories, workspace, MEMBER) == []


def test_resolving_a_blocker_tells_the_blocked_issues_followers(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """Completing a blocker tells whoever follows the issue it was holding up, naming the blocker."""
    sign_in(issues_client, OWNER)
    blocker = seed_issue(issues_client, workspace, title="Blocker")
    blocked = seed_issue(issues_client, workspace, title="Blocked", assignee_id=MEMBER)
    repositories.relations.link(workspace, blocker["id"], "blocks", blocked["id"], OWNER)

    handle_record(
        repositories,
        move_record(workspace, blocker["id"], ADMIN, statuses["started"].status_id, statuses["completed"].status_id),
    )

    assert by_issue(repositories, workspace, MEMBER) == {blocked["id"]: f"blocker_resolved:{blocker['key']}"}
    assert sorted(kinds(repositories, workspace, OWNER)) == ["blocking_changed", "issue_completed"]
    assert kinds(repositories, workspace, ADMIN) == []


def test_a_closed_blocker_moving_between_closed_statuses_is_not_resolved_again(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """Cancelling an already completed blocker changes nothing for the blocked issue."""
    sign_in(issues_client, OWNER)
    blocker = seed_issue(issues_client, workspace, title="Blocker")
    blocked = seed_issue(issues_client, workspace, title="Blocked", assignee_id=MEMBER)
    repositories.relations.link(workspace, blocker["id"], "blocks", blocked["id"], OWNER)

    handle_record(
        repositories,
        move_record(workspace, blocker["id"], ADMIN, statuses["completed"].status_id, statuses["cancelled"].status_id),
    )

    assert by_issue(repositories, workspace, MEMBER) == {}
