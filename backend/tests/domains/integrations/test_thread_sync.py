"""Comment threads synced to a linked pull request or GitHub issue.

Syncing goes through the REST routes and the MCP tools, posting through the
dispatch consumer's `handle_record`, and inbound comments through the events
consumer's, so each test runs the routing a deployed function runs. Every GitHub
call is patched at `github_issues`.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from webbpulse.identity.oauth import OAuthLinkRecord

from app.common.db.dynamo.activity import as_activity
from app.common.db.dynamo.base import as_item, utc_now
from app.common.db.dynamo.comments import Comment, CommentAnchor, ThreadResolution, build_comment
from app.common.db.dynamo.github import IssueLink, IssueSync, issue_sync_key, link_key
from app.common.db.dynamo.issues import Issue
from app.domains.integrations import issue_sync, thread_sync
from app.domains.integrations.consumers import dispatch, events, stream
from tests.domains.helpers import MEMBER, sign_in
from tests.domains.integrations.conftest import (
    APP_SLUG,
    INSTALLATION_ID,
    REPOSITORY_FULL_NAME,
    REPOSITORY_ID,
    TEAM,
    WORKSPACE,
    sqs_record,
)
from tests.domains.integrations.test_issue_sync import (
    GITHUB_USER_ID,
    FakeGithub,
    at,
    link_team,
    stream_record,
)
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal

PR_NUMBER = 7

PR_URL = f"https://github.com/{REPOSITORY_FULL_NAME}/pull/{PR_NUMBER}"


@pytest.fixture
def github(monkeypatch: pytest.MonkeyPatch) -> FakeGithub:
    """Patch every GitHub call the thread sync makes."""
    fake = FakeGithub()
    for name in ("installation_token", "create_comment", "update_comment", "list_comments", "user_login"):
        monkeypatch.setattr(issue_sync.github_issues, name, getattr(fake, name))
    return fake


def link_pull_request(repositories: Any, issue: Issue, number: int = PR_NUMBER, **fields: Any) -> None:
    """Link one pull request to the issue, as a delivery naming its key would."""
    link_id = f"PR_node_{number}"
    repositories.github.put_link(
        IssueLink(
            workspace_id=WORKSPACE,
            github_key=link_key(link_id),
            ws_issue=f"{WORKSPACE}#{issue.issue_id}",
            link_id=link_id,
            issue_id=issue.issue_id,
            issue_key=issue.key,
            repository_full_name=REPOSITORY_FULL_NAME,
            repository_id=REPOSITORY_ID,
            pr_number=number,
            pr_title="Cache the board query",
            pr_url=f"https://github.com/{REPOSITORY_FULL_NAME}/pull/{number}",
            pr_updated_ms=1000,
            linked_at=utc_now(),
            updated_at=utc_now(),
            **fields,
        )
    )


@pytest.fixture
def linked(repositories: Any, installed: str, github_env: None, issue: Issue) -> Issue:
    """`ABC-1` with one linked pull request and one member who linked a GitHub account."""
    link_pull_request(repositories, issue)
    repositories.oauth_links.put(
        OAuthLinkRecord(
            provider_subject=f"github#{GITHUB_USER_ID}",
            provider="github",
            subject=GITHUB_USER_ID,
            user_id=MEMBER,
            linked_at=utc_now().isoformat(),
        )
    )
    return issue


def thread_path(issue: Issue, comment_id: str) -> str:
    """The route that syncs and unsyncs one thread."""
    return f"/api/workspaces/{WORKSPACE}/issues/{issue.issue_id}/github-sync/threads/{comment_id}"


def new_root(repositories: Any, issue: Issue, body: str = "Should we cache the board query?") -> Comment:
    """A top level comment by the member."""
    return repositories.comments.create(build_comment(WORKSPACE, issue.issue_id, TEAM, MEMBER, body))


def new_reply(repositories: Any, issue: Issue, root: Comment, body: str = "Yes, behind a flag") -> Comment:
    """A reply by the member under `root`."""
    return repositories.comments.create(
        build_comment(WORKSPACE, issue.issue_id, TEAM, MEMBER, body, parent_comment_id=root.comment_id)
    )


def sync(client: TestClient, issue: Issue, root: Comment, number: int = PR_NUMBER) -> Any:
    """Sync one thread through the route as the member."""
    sign_in(client, MEMBER)
    return client.put(thread_path(issue, root.comment_id), json={"repository_id": REPOSITORY_ID, "number": number})


def push(repositories: Any, comment: Comment) -> None:
    """Run the comment sync job the stream record of `comment` queues."""
    job = {
        "kind": issue_sync.COMMENT_SYNC_JOB,
        "workspace_id": WORKSPACE,
        "issue_id": comment.issue_id,
        "comment_id": comment.comment_id,
    }
    dispatch.handle_record(repositories, sqs_record(job))


def pr_comment(
    action: str = "created",
    *,
    comment_id: int = 901,
    body: str = "Agreed, ship it",
    user: dict[str, Any] | None = None,
    association: str = "MEMBER",
    sender: str = "octo-member",
    number: int = PR_NUMBER,
    created_at: str | None = None,
    updated_at: str | None = None,
    html_url: str | None = None,
) -> dict[str, Any]:
    """One `issue_comment` delivery on the pull request, in the shape the receiver enqueues it."""
    comment: dict[str, Any] = {
        "id": comment_id,
        "body": body,
        "user": user or {"id": 998, "login": "octo-member"},
        "author_association": association,
        "created_at": created_at or at(1),
        "html_url": html_url or f"{PR_URL}#issuecomment-{comment_id}",
    }
    if updated_at is not None:
        comment["updated_at"] = updated_at
    return {
        "event": "issue_comment",
        "delivery": f"pr-{action}-{comment_id}",
        "body": {
            "action": action,
            "installation": {"id": int(INSTALLATION_ID)},
            "repository": {"id": int(REPOSITORY_ID), "full_name": REPOSITORY_FULL_NAME},
            "issue": {"number": number, "pull_request": {"url": PR_URL}},
            "comment": comment,
            "sender": {"login": sender},
        },
    }


def replies(repositories: Any, issue: Issue, root: Comment) -> list[dict[str, Any]]:
    """The replies under one root, oldest first."""
    rows = repositories.comments.list_for_issue(WORKSPACE, issue.issue_id).items
    return [row for row in rows if row.get("parent_comment_id") == root.comment_id]


def test_the_targets_list_the_linked_pull_request(client: TestClient, linked: Issue) -> None:
    """The composer reads one target per linked pull request, with the ref an agent names."""
    sign_in(client, MEMBER)
    response = client.get(f"/api/workspaces/{WORKSPACE}/issues/{linked.issue_id}/github-sync/thread-targets")

    assert response.status_code == 200
    assert response.json() == [
        {
            "kind": "pull_request",
            "repository_id": REPOSITORY_ID,
            "full_name": REPOSITORY_FULL_NAME,
            "number": PR_NUMBER,
            "title": "Cache the board query",
            "url": PR_URL,
            "private": True,
            "ref": f"{REPOSITORY_FULL_NAME}#{PR_NUMBER}",
        }
    ]


def test_a_detached_pull_request_is_not_a_target(repositories: Any, linked: Issue) -> None:
    """A pull request that no longer names the issue is left out."""
    link_pull_request(repositories, linked, number=8, detached=True)

    assert [row["number"] for row in thread_sync.thread_targets(repositories, linked)] == [PR_NUMBER]


def test_syncing_marks_the_root_and_is_idempotent(client: TestClient, repositories: Any, linked: Issue) -> None:
    """The root carries the target, and syncing again to the same place changes nothing."""
    root = new_root(repositories, linked)

    first = sync(client, linked, root)
    second = sync(client, linked, root)

    assert first.status_code == 200
    thread = first.json()["github_thread"]
    assert (thread["repository_id"], thread["number"], thread["kind"]) == (REPOSITORY_ID, PR_NUMBER, "pull_request")
    assert thread["synced_by"] == MEMBER
    assert second.json() == first.json()
    stored = repositories.comments.get(WORKSPACE, linked.issue_id, root.comment_id)
    assert stored.github_thread is not None
    assert repositories.github.get_thread_target(WORKSPACE, REPOSITORY_ID, PR_NUMBER, root.comment_id) is not None


def test_a_reply_or_an_unlinked_target_is_refused(client: TestClient, repositories: Any, linked: Issue) -> None:
    """Only a root syncs, and only to a pull request linked to the issue."""
    root = new_root(repositories, linked)
    reply = new_reply(repositories, linked, root)

    assert sync(client, linked, reply).status_code == 409
    assert sync(client, linked, root, number=99).status_code == 422


def test_an_issue_with_nothing_linked_has_no_target(
    client: TestClient, repositories: Any, installed: str, issue: Issue
) -> None:
    """With no pull request or GitHub issue there is nothing to pick, and nothing to sync to."""
    root = new_root(repositories, issue)
    sign_in(client, MEMBER)

    assert client.get(f"/api/workspaces/{WORKSPACE}/issues/{issue.issue_id}/github-sync/thread-targets").json() == []
    with pytest.raises(HTTPException) as refused:
        thread_sync.pick_target([], None)
    assert refused.value.status_code == 409
    assert sync(client, issue, root).status_code == 422


def mirror_github_issue(repositories: Any, issue: Issue, number: int = 12) -> None:
    """Record `issue` as mirroring GitHub issue `number`, as an import would."""
    assert repositories.github.claim_issue_sync(
        IssueSync(
            workspace_id=WORKSPACE,
            github_key=issue_sync_key(issue.issue_id),
            issue_id=issue.issue_id,
            team_id=TEAM,
            repository_id=REPOSITORY_ID,
            full_name=REPOSITORY_FULL_NAME,
            number=number,
            html_url=f"https://github.com/{REPOSITORY_FULL_NAME}/issues/{number}",
        )
    )


def test_the_two_way_github_issue_is_refused(client: TestClient, repositories: Any, linked: Issue) -> None:
    """A GitHub issue a two way sync mirrors already carries every comment, so it is no target."""
    link_team(repositories)
    mirror_github_issue(repositories, linked)
    root = new_root(repositories, linked)

    assert all(row["number"] != 12 for row in thread_sync.thread_targets(repositories, linked))
    assert sync(client, linked, root, number=12).status_code == 409


def test_the_one_way_github_issue_is_a_target(client: TestClient, repositories: Any, linked: Issue) -> None:
    """An issue imported one way can sync a thread back to its GitHub issue."""
    link_team(repositories, direction="github_to_standupless")
    mirror_github_issue(repositories, linked)
    root = new_root(repositories, linked)

    kinds = {row["number"]: row["kind"] for row in thread_sync.thread_targets(repositories, linked)}
    response = sync(client, linked, root, number=12)

    assert kinds == {PR_NUMBER: "pull_request", 12: "issue"}
    assert response.status_code == 200
    assert response.json()["github_thread"]["kind"] == "issue"


def test_the_opener_quotes_the_root_and_replies_post_with_attribution(
    client: TestClient, repositories: Any, linked: Issue, github: FakeGithub
) -> None:
    """The first post quotes the root under the marker, and a later reply names its author."""
    root = new_root(repositories, linked)
    sync(client, linked, root)
    push(repositories, repositories.comments.get(WORKSPACE, linked.issue_id, root.comment_id))
    push(repositories, repositories.comments.get(WORKSPACE, linked.issue_id, root.comment_id))
    reply = new_reply(repositories, linked, root)
    push(repositories, reply)
    push(repositories, reply)

    assert len(github.comments) == 2
    number, opener = github.comments[0]
    assert number == PR_NUMBER
    assert opener.startswith(thread_sync.thread_marker(root.comment_id))
    assert "**Mel Member** started a thread in Standupless on" in opener
    assert "ABC-1" in opener
    assert "> Should we cache the board query?" in opener
    assert github.comments[1] == (PR_NUMBER, "**Mel Member** commented in Standupless:\n\nYes, behind a flag")


def test_an_anchored_root_quotes_its_passage_in_the_opener(
    client: TestClient, repositories: Any, linked: Issue, github: FakeGithub
) -> None:
    """A thread pinned to the description shows the passage on GitHub, which has no highlight."""
    root = repositories.comments.create(
        build_comment(
            WORKSPACE,
            linked.issue_id,
            TEAM,
            MEMBER,
            "Is this still true?",
            anchor=CommentAnchor(quote="cache the board query"),
        )
    )
    sync(client, linked, root)
    push(repositories, repositories.comments.get(WORKSPACE, linked.issue_id, root.comment_id))

    _, opener = github.comments[0]
    assert "On the description:\n\n> cache the board query\n\n> Is this still true?" in opener


def test_an_anchored_comment_quotes_its_passage_on_github(repositories: Any, linked: Issue) -> None:
    """The App's copy of an anchored comment quotes the passage ahead of the text."""
    body = issue_sync.outbound_comment_body(repositories, MEMBER, "Yes", CommentAnchor(quote="the board query"))

    assert body == "**Mel Member** commented in Standupless:\n\nOn the description:\n\n> the board query\n\nYes"


def test_an_edit_updates_the_github_copy(
    client: TestClient, repositories: Any, linked: Issue, github: FakeGithub
) -> None:
    """Editing the root re-renders the opener, and editing a reply patches its copy."""
    root = new_root(repositories, linked)
    sync(client, linked, root)
    push(repositories, repositories.comments.get(WORKSPACE, linked.issue_id, root.comment_id))
    reply = new_reply(repositories, linked, root)
    push(repositories, reply)

    repositories.comments.edit(WORKSPACE, linked.issue_id, reply.comment_id, "Yes, behind a flag for now", [])
    push(repositories, reply)
    repositories.comments.edit(WORKSPACE, linked.issue_id, root.comment_id, "Should we cache it?", [])
    push(repositories, root)

    assert github.comment_updates[0] == (
        "4243",
        "**Mel Member** commented in Standupless:\n\nYes, behind a flag for now",
    )
    assert github.comment_updates[1][0] == "4242"
    assert "> Should we cache it?" in github.comment_updates[1][1]


def test_a_reply_written_before_the_sync_is_not_replayed(
    client: TestClient, repositories: Any, linked: Issue, github: FakeGithub
) -> None:
    """Syncing an old thread posts the opener only."""
    root = new_root(repositories, linked)
    reply = new_reply(repositories, linked, root)
    sync(client, linked, root)
    push(repositories, reply)

    assert github.comments == []


def test_the_apps_own_opener_delivery_records_its_link(
    client: TestClient, repositories: Any, linked: Issue, github: FakeGithub, enqueued: list[tuple[str, Any]]
) -> None:
    """The bot's delivery of the opener sets the link the thread shows, and adds no reply."""
    root = new_root(repositories, linked)
    sync(client, linked, root)
    push(repositories, repositories.comments.get(WORKSPACE, linked.issue_id, root.comment_id))
    opener_url = f"{PR_URL}#issuecomment-4242"

    events.handle_record(
        repositories,
        sqs_record(
            pr_comment(
                comment_id=4242,
                body=github.comments[0][1],
                sender=f"{APP_SLUG}[bot]",
                user={"id": 1, "login": f"{APP_SLUG}[bot]"},
                association="NONE",
                html_url=opener_url,
            )
        ),
    )

    stored = repositories.comments.get(WORKSPACE, linked.issue_id, root.comment_id)
    assert stored.github_thread.comment_url == opener_url
    assert replies(repositories, linked, root) == []


def test_a_github_comment_lands_as_a_reply_and_is_not_posted_back(
    client: TestClient, repositories: Any, linked: Issue, github: FakeGithub, enqueued: list[tuple[str, Any]]
) -> None:
    """A trusted comment on the pull request becomes a reply once, and its job posts nothing."""
    root = new_root(repositories, linked)
    sync(client, linked, root)
    delivery = pr_comment()

    events.handle_record(repositories, sqs_record(delivery))
    events.handle_record(repositories, sqs_record(delivery))

    rows = replies(repositories, linked, root)
    assert len(rows) == 1
    assert rows[0]["body"] == "Agreed, ship it"
    assert rows[0]["author_id"] == issue_sync.github_author("octo-member")
    assert rows[0]["source"] == "github"
    reply = repositories.comments.get(WORKSPACE, linked.issue_id, rows[0]["comment_id"])
    push(repositories, reply)
    assert github.comments == []


def test_a_linked_account_reply_shows_the_member(
    client: TestClient, repositories: Any, linked: Issue, github: FakeGithub, enqueued: list[tuple[str, Any]]
) -> None:
    """A commenter who linked their GitHub account is stored as that member, with no repository standing needed."""
    root = new_root(repositories, linked)
    sync(client, linked, root)

    events.handle_record(
        repositories,
        sqs_record(pr_comment(user={"id": int(GITHUB_USER_ID), "login": "octo-member"}, association="NONE")),
    )

    assert [row["author_id"] for row in replies(repositories, linked, root)] == [MEMBER]


def test_an_untrusted_commenter_is_ignored(
    client: TestClient, repositories: Any, linked: Issue, github: FakeGithub, enqueued: list[tuple[str, Any]]
) -> None:
    """A stranger on the pull request cannot write into the thread."""
    root = new_root(repositories, linked)
    sync(client, linked, root)

    events.handle_record(repositories, sqs_record(pr_comment(association="NONE")))

    assert replies(repositories, linked, root) == []


def test_a_github_edit_and_delete_follow_the_reply(
    client: TestClient, repositories: Any, linked: Issue, github: FakeGithub, enqueued: list[tuple[str, Any]]
) -> None:
    """An edit on GitHub rewrites the reply, and a delete removes it."""
    root = new_root(repositories, linked)
    sync(client, linked, root)
    events.handle_record(repositories, sqs_record(pr_comment()))

    events.handle_record(
        repositories, sqs_record(pr_comment("edited", body="Agreed, ship it Friday", updated_at=at(2)))
    )
    assert [row["body"] for row in replies(repositories, linked, root)] == ["Agreed, ship it Friday"]

    events.handle_record(repositories, sqs_record(pr_comment("deleted", updated_at=at(3))))
    assert replies(repositories, linked, root) == []


def test_a_reply_quoting_one_thread_lands_in_it(
    client: TestClient, repositories: Any, linked: Issue, github: FakeGithub, enqueued: list[tuple[str, Any]]
) -> None:
    """With two threads on one pull request, a quote picks the thread it answers."""
    first = new_root(repositories, linked, "Should we cache the board query?")
    second = new_root(repositories, linked, "Who owns the rollout?")
    sync(client, linked, first)
    sync(client, linked, second)

    events.handle_record(
        repositories, sqs_record(pr_comment(body="> Should we cache the board query?\n\nYes, for an hour"))
    )

    assert len(replies(repositories, linked, first)) == 1
    assert replies(repositories, linked, second) == []


def test_unsync_stops_mirroring_and_keeps_comments(
    client: TestClient, repositories: Any, linked: Issue, github: FakeGithub, enqueued: list[tuple[str, Any]]
) -> None:
    """After unsync nothing crosses either way, and the comments already there stay."""
    root = new_root(repositories, linked)
    sync(client, linked, root)
    push(repositories, repositories.comments.get(WORKSPACE, linked.issue_id, root.comment_id))
    events.handle_record(repositories, sqs_record(pr_comment()))

    response = client.delete(thread_path(linked, root.comment_id))
    assert response.status_code == 200
    assert response.json()["github_thread"] is None
    assert client.delete(thread_path(linked, root.comment_id)).status_code == 200

    push(repositories, new_reply(repositories, linked, root, "After the unsync"))
    events.handle_record(repositories, sqs_record(pr_comment(comment_id=902, body="Still here?")))

    assert len(github.comments) == 1
    assert [row["body"] for row in replies(repositories, linked, root)] == ["Agreed, ship it", "After the unsync"]
    assert repositories.github.get_thread_target(WORKSPACE, REPOSITORY_ID, PR_NUMBER, root.comment_id) is None


def test_the_stream_queues_a_newly_synced_thread_and_its_replies(
    repositories: Any, linked: Issue, enqueued: list[tuple[str, Any]]
) -> None:
    """Marking a root and a reply under it queue a job; the opener's link landing and a GitHub reply do not."""
    root = new_root(repositories, linked)
    plain = as_item(root)
    thread = {
        "kind": "pull_request",
        "repository_id": REPOSITORY_ID,
        "full_name": REPOSITORY_FULL_NAME,
        "number": PR_NUMBER,
        "target_url": PR_URL,
        "private": True,
        "synced_by": MEMBER,
        "synced_at": utc_now().isoformat(),
    }
    marked = {**plain, "github_thread": thread}
    with_url = {**plain, "github_thread": {**thread, "comment_url": f"{PR_URL}#issuecomment-1"}}

    assert not stream.queue_comment_sync(repositories, stream_record("INSERT", plain))
    assert stream.queue_comment_sync(repositories, stream_record("MODIFY", marked, plain))
    assert not stream.queue_comment_sync(repositories, stream_record("MODIFY", with_url, marked))


def test_the_stream_queues_replies_under_a_synced_thread(
    client: TestClient, repositories: Any, linked: Issue, enqueued: list[tuple[str, Any]]
) -> None:
    """A member's reply queues a job, a GitHub sourced reply does not."""
    root = new_root(repositories, linked)
    sync(client, linked, root)
    reply = as_item(new_reply(repositories, linked, root))

    assert stream.queue_comment_sync(repositories, stream_record("INSERT", reply))
    assert not stream.queue_comment_sync(repositories, stream_record("INSERT", {**reply, "source": "github"}))


def test_the_mcp_tools_list_sync_and_unsync(client: TestClient, repositories: Any, linked: Issue) -> None:
    """An agent lists targets, adds a synced comment by ref, and unsyncs it."""
    secret = mint_for(repositories, MEMBER, ("issues:read", "comments:write"))
    ref = f"{REPOSITORY_FULL_NAME}#{PR_NUMBER}"

    targets = answer(tool(client, secret, "list_github_thread_targets", {"issue_id": "ABC-1"}))
    added = answer(
        tool(
            client,
            secret,
            "add_comment",
            {"issue_id": "ABC-1", "body": "Tracking the rollout here", "sync_to_github": True, "github_target": ref},
        )
    )
    unsynced = answer(
        tool(client, secret, "unsync_comment_thread", {"issue_id": "ABC-1", "comment_id": added["comment_id"]})
    )
    resynced = answer(
        tool(client, secret, "sync_comment_thread", {"issue_id": "ABC-1", "comment_id": added["comment_id"]})
    )
    unknown = refusal(
        tool(
            client,
            secret,
            "sync_comment_thread",
            {"issue_id": "ABC-1", "comment_id": added["comment_id"], "github_target": "other/repo#1"},
        )
    )

    assert [row["ref"] for row in targets["targets"]] == [ref]
    assert added["github_thread"]["number"] == PR_NUMBER
    assert unsynced["github_thread"] is None
    assert resynced["github_thread"]["number"] == PR_NUMBER
    assert "Unknown github_target" in unknown


def test_a_github_reply_reopens_a_resolved_thread(
    client: TestClient, repositories: Any, linked: Issue, github: FakeGithub, enqueued: list[tuple[str, Any]]
) -> None:
    """A reply arriving from GitHub clears the resolution, as a reply in the app does."""
    root = new_root(repositories, linked)
    sync(client, linked, root)
    repositories.comments.set_resolution(
        WORKSPACE, linked.issue_id, root.comment_id, ThreadResolution(resolved_by=MEMBER)
    )

    events.handle_record(repositories, sqs_record(pr_comment()))

    assert len(replies(repositories, linked, root)) == 1
    assert repositories.comments.get(WORKSPACE, linked.issue_id, root.comment_id).resolution is None
    history = [as_activity(item) for item in repositories.activity.list_for_issue(WORKSPACE, linked.issue_id).items]
    reopened = [row for row in history if row.kind == "thread_unresolved"]
    assert [(row.field, row.actor_kind, row.to_value) for row in reopened] == [("reply", "github", root.comment_id)]


def test_the_mcp_tools_resolve_and_unresolve(client: TestClient, repositories: Any, linked: Issue) -> None:
    """An agent resolves a thread, resolves it again for free, and reopens it."""
    secret = mint_for(repositories, MEMBER, ("issues:read", "comments:write"))
    root = new_root(repositories, linked)
    reply = new_reply(repositories, linked, root)
    arguments = {"issue_id": "ABC-1", "comment_id": root.comment_id}

    resolved = answer(tool(client, secret, "resolve_comment_thread", arguments))
    again = answer(tool(client, secret, "resolve_comment_thread", arguments))
    unresolved = answer(tool(client, secret, "unresolve_comment_thread", arguments))
    refused = refusal(
        tool(client, secret, "resolve_comment_thread", {"issue_id": "ABC-1", "comment_id": reply.comment_id})
    )

    assert resolved["resolution"]["resolved_by"] == MEMBER
    assert again["resolution"] == resolved["resolution"]
    assert unresolved["resolution"] is None
    assert "first comment" in refused
