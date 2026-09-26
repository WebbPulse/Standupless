"""Two way issue sync between a team and a GitHub repository.

Inbound deliveries are driven through the events consumer's `handle_record`, and
outbound jobs through the dispatch consumer's, so each test exercises the same
routing a deployed function runs. Every GitHub call is patched at
`github_issues`, which is the only module the sync reaches GitHub through.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Mapping

import httpx
import pytest
from boto3.dynamodb.types import TypeSerializer
from fastapi.testclient import TestClient
from webbpulse.identity.oauth import OAuthLinkRecord

from app.common.db.dynamo.base import as_item, utc_now
from app.common.db.dynamo.comments import build_comment
from app.common.db.dynamo.github import TeamSync, team_sync_key
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.team_config import Label, label_key
from app.common.team_purge import Deadline, PurgeJob
from app.domains.discussion.service import authors_for
from app.domains.integrations import github_issues, issue_sync
from app.domains.integrations.consumers import dispatch, events, purge, stream
from tests.domains.helpers import ADMIN, GUEST, MEMBER, sign_in
from tests.domains.integrations.conftest import (
    APP_SLUG,
    INSTALLATION_ID,
    OTHER_TEAM,
    REPOSITORY_FULL_NAME,
    REPOSITORY_ID,
    TEAM,
    WORKSPACE,
    sqs_record,
)

GITHUB_USER_ID = "5150"

GITHUB_LOGIN = "octo-member"


def at(minutes: int) -> str:
    """A GitHub timestamp `minutes` from now, so a test can order deliveries."""
    return (datetime.now(timezone.utc) + timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%SZ")


def github_issue(
    *,
    number: int = 12,
    title: str = "Crash on save",
    body: str = "Steps to reproduce",
    state: str = "open",
    state_reason: str | None = None,
    assignees: list[dict[str, Any]] | None = None,
    labels: list[str] | None = None,
    updated_at: str | None = None,
) -> dict[str, Any]:
    """One GitHub issue record, as a delivery or an API answer carries it."""
    return {
        "number": number,
        "node_id": f"I_node_{number}",
        "html_url": f"https://github.com/{REPOSITORY_FULL_NAME}/issues/{number}",
        "title": title,
        "body": body,
        "state": state,
        "state_reason": state_reason,
        "assignees": assignees or [],
        "labels": [{"name": name} for name in labels or []],
        "user": {"id": 999, "login": "reporter"},
        "updated_at": updated_at or at(0),
    }


def issues_delivery(action: str, issue: Mapping[str, Any], *, sender: str = "reporter") -> dict[str, Any]:
    """One `issues` delivery in the shape the receiver enqueues it."""
    return {
        "event": "issues",
        "delivery": f"d-{action}",
        "body": {
            "action": action,
            "installation": {"id": int(INSTALLATION_ID)},
            "repository": {"id": int(REPOSITORY_ID), "full_name": REPOSITORY_FULL_NAME},
            "issue": dict(issue),
            "sender": {"login": sender},
        },
    }


def comment_delivery(
    action: str,
    *,
    comment_id: int = 777,
    body: str = "Looks like a race",
    user: Mapping[str, Any] | None = None,
    sender: str = "reporter",
    number: int = 12,
) -> dict[str, Any]:
    """One `issue_comment` delivery in the shape the receiver enqueues it."""
    return {
        "event": "issue_comment",
        "delivery": f"c-{action}",
        "body": {
            "action": action,
            "installation": {"id": int(INSTALLATION_ID)},
            "repository": {"id": int(REPOSITORY_ID), "full_name": REPOSITORY_FULL_NAME},
            "issue": {"number": number},
            "comment": {"id": comment_id, "body": body, "user": dict(user or {"id": 998, "login": "commenter"})},
            "sender": {"login": sender},
        },
    }


class FakeGithub:
    """Records what the sync would have sent to GitHub, and answers like GitHub."""

    def __init__(self) -> None:
        """Start with nothing recorded."""
        self.created: list[dict[str, Any]] = []
        self.updated: list[tuple[int, dict[str, Any]]] = []
        self.comments: list[tuple[int, str]] = []
        self.comment_updates: list[tuple[str, str]] = []
        self.tokens = 0

    def installation_token(self, installation_id: str) -> str:
        """A placeholder token, counted so a test can see a lazy mint."""
        self.tokens += 1
        return "ghs_test"

    def create_issue(self, token: str, full_name: str, **fields: Any) -> dict[str, Any]:
        """Record an opened issue and answer with number 55."""
        self.created.append(fields)
        return github_issue(
            number=55,
            title=fields["title"],
            body=fields["body"],
            labels=list(fields.get("labels", [])),
            assignees=[{"id": GITHUB_USER_ID}] if fields.get("assignees") else [],
        )

    def update_issue(self, token: str, full_name: str, number: int, changes: Mapping[str, Any]) -> dict[str, Any]:
        """Record a patch and answer with the patched record."""
        self.updated.append((number, dict(changes)))
        return github_issue(
            number=number,
            title=str(changes.get("title", "Crash on save")),
            state=str(changes.get("state", "open")),
            state_reason=changes.get("state_reason"),
            updated_at=at(1),
        )

    def create_comment(self, installation_id: str, full_name: str, number: int, body: str) -> dict[str, Any]:
        """Record a posted comment and answer with id 4242."""
        self.comments.append((number, body))
        return {"id": 4242, "body": body}

    def update_comment(self, installation_id: str, full_name: str, comment_id: str, body: str) -> dict[str, Any]:
        """Record an edited comment."""
        self.comment_updates.append((comment_id, body))
        return {"id": comment_id, "body": body}

    def user_login(self, token: str, github_user_id: str) -> str:
        """The login of the one linked account."""
        return GITHUB_LOGIN if github_user_id == GITHUB_USER_ID else ""


@pytest.fixture
def github(monkeypatch: pytest.MonkeyPatch) -> FakeGithub:
    """Patch every GitHub call the sync makes."""
    fake = FakeGithub()
    for name in (
        "installation_token",
        "create_issue",
        "update_issue",
        "create_comment",
        "update_comment",
        "user_login",
    ):
        monkeypatch.setattr(issue_sync.github_issues, name, getattr(fake, name))
    return fake


def link_team(repositories: Any, *, direction: str = "two_way", enabled: bool = True) -> TeamSync:
    """Link `TEAM` to the installed repository."""
    row = TeamSync(
        workspace_id=WORKSPACE,
        github_key=team_sync_key(TEAM),
        team_id=TEAM,
        repository_id=REPOSITORY_ID,
        full_name=REPOSITORY_FULL_NAME,
        direction=direction,
        enabled=enabled,
        created_by=ADMIN,
    )
    repositories.github.put_team_sync(row)
    return row


@pytest.fixture
def synced(repositories: Any, installed: str, github_env: None) -> TeamSync:
    """`TEAM` syncing both ways with the repository, with one label and one linked member."""
    repositories.team_config.create_label(
        Label(
            workspace_id=WORKSPACE,
            config_key=label_key(TEAM, "bug-label"),
            team_id=TEAM,
            label_id="bug-label",
            name="bug",
            color="#ff0000",
        )
    )
    repositories.oauth_links.put(
        OAuthLinkRecord(
            provider_subject=f"github#{GITHUB_USER_ID}",
            provider="github",
            subject=GITHUB_USER_ID,
            user_id=MEMBER,
            linked_at=utc_now().isoformat(),
        )
    )
    return link_team(repositories)


def statuses(repositories: Any) -> dict[str, str]:
    """The team's statuses by category."""
    rows = repositories.team_config.list_statuses(WORKSPACE, TEAM)
    return {row.category: row.status_id for row in sorted(rows, key=lambda row: -row.position)}


def imported(repositories: Any, number: int = 12) -> Issue:
    """The issue a GitHub issue imported into."""
    row = repositories.github.issue_sync_for_github(WORKSPACE, REPOSITORY_ID, number)
    assert row is not None
    issue = repositories.issues.get(WORKSPACE, row.issue_id)
    assert issue is not None
    return issue


def open_issue(repositories: Any, **fields: Any) -> Issue:
    """Deliver `issues.opened` and answer the issue it imported."""
    events.handle_record(repositories, sqs_record(issues_delivery("opened", github_issue(**fields))))
    return imported(repositories, int(fields.get("number", 12)))


def test_an_opened_issue_imports_with_its_fields(
    repositories: Any,
    synced: TeamSync,
    enqueued: list[tuple[str, Any]],
) -> None:
    """Title, body, the linked assignee and a known label come across, in an open status."""
    issue = open_issue(repositories, assignees=[{"id": int(GITHUB_USER_ID)}], labels=["bug", "unknown"])

    assert issue.title == "Crash on save"
    assert issue.body == "Steps to reproduce"
    assert issue.assignee_id == MEMBER
    assert issue.label_ids == ["bug-label"]
    assert issue.key.startswith("ABC-")
    assert issue.status_id == statuses(repositories)["unstarted"]
    sync = repositories.github.get_issue_sync(WORKSPACE, issue.issue_id)
    assert sync.state == "linked"
    assert sync.standupless["title"] == "Crash on save"


def test_a_redelivered_open_imports_once(
    repositories: Any,
    synced: TeamSync,
    enqueued: list[tuple[str, Any]],
) -> None:
    """The GitHub pointer is the claim, so a second delivery creates nothing."""
    first = open_issue(repositories)
    open_issue(repositories)

    assert len(repositories.issues.list_for_team(WORKSPACE, TEAM).items) == 1
    assert imported(repositories).issue_id == first.issue_id


def test_nothing_imports_without_an_enabled_link(
    repositories: Any,
    installed: str,
    github_env: None,
    enqueued: list[tuple[str, Any]],
) -> None:
    """A paused link imports nothing."""
    link_team(repositories, enabled=False)
    events.handle_record(repositories, sqs_record(issues_delivery("opened", github_issue())))

    assert repositories.github.issue_sync_for_github(WORKSPACE, REPOSITORY_ID, 12) is None


def test_the_apps_own_delivery_is_ignored(
    repositories: Any,
    synced: TeamSync,
    enqueued: list[tuple[str, Any]],
) -> None:
    """A delivery the bot caused would echo the sync's own write, so it is dropped."""
    events.handle_record(
        repositories,
        sqs_record(issues_delivery("opened", github_issue(), sender=f"{APP_SLUG}[bot]")),
    )

    assert repositories.github.issue_sync_for_github(WORKSPACE, REPOSITORY_ID, 12) is None


def test_an_edit_on_github_updates_the_issue_and_records_activity(
    repositories: Any,
    synced: TeamSync,
    enqueued: list[tuple[str, Any]],
) -> None:
    """A changed title lands with a GitHub attributed activity row."""
    issue = open_issue(repositories, updated_at=at(-5))
    events.handle_record(
        repositories,
        sqs_record(issues_delivery("edited", github_issue(title="Crash on save in Safari", updated_at=at(1)))),
    )

    updated = repositories.issues.get(WORKSPACE, issue.issue_id)
    assert updated.title == "Crash on save in Safari"
    rows = repositories.activity.list_for_issue(WORKSPACE, issue.issue_id).items
    assert any(row.get("field") == "title" and row.get("actor_kind") == "github" for row in rows)


@pytest.mark.parametrize(("reason", "category"), [("completed", "completed"), ("not_planned", "cancelled")])
def test_closing_on_github_moves_to_the_matching_category(
    repositories: Any,
    synced: TeamSync,
    enqueued: list[tuple[str, Any]],
    reason: str,
    category: str,
) -> None:
    """Closed as completed lands in done, closed as not planned in cancelled."""
    issue = open_issue(repositories, updated_at=at(-5))
    events.handle_record(
        repositories,
        sqs_record(issues_delivery("closed", github_issue(state="closed", state_reason=reason, updated_at=at(1)))),
    )

    assert repositories.issues.get(WORKSPACE, issue.issue_id).status_id == statuses(repositories)[category]


def test_reopening_on_github_moves_a_closed_issue_back(
    repositories: Any,
    synced: TeamSync,
    enqueued: list[tuple[str, Any]],
) -> None:
    """A reopened GitHub issue moves a done issue back to an open status."""
    issue = open_issue(repositories, state="closed", state_reason="completed", updated_at=at(-5))
    assert issue.status_id == statuses(repositories)["completed"]
    events.handle_record(
        repositories,
        sqs_record(issues_delivery("reopened", github_issue(state="open", state_reason="reopened", updated_at=at(1)))),
    )

    assert repositories.issues.get(WORKSPACE, issue.issue_id).status_id == statuses(repositories)["unstarted"]


def test_a_stale_delivery_is_dropped(
    repositories: Any,
    synced: TeamSync,
    enqueued: list[tuple[str, Any]],
) -> None:
    """A delivery older than the last one synced would roll a newer edit back."""
    issue = open_issue(repositories, updated_at=at(0))
    events.handle_record(
        repositories,
        sqs_record(issues_delivery("edited", github_issue(title="Old title", updated_at=at(-10)))),
    )

    assert repositories.issues.get(WORKSPACE, issue.issue_id).title == "Crash on save"


def test_a_conflict_keeps_the_later_write_and_records_it(
    repositories: Any,
    synced: TeamSync,
    enqueued: list[tuple[str, Any]],
) -> None:
    """Both sides changed the title; the later GitHub edit wins and the conflict is recorded."""
    issue = open_issue(repositories, updated_at=at(-5))
    local = issue.model_copy(update={"title": "Changed here", "updated_at": utc_now()})
    repositories.issues.replace(local)
    events.handle_record(
        repositories,
        sqs_record(issues_delivery("edited", github_issue(title="Changed there", updated_at=at(5)))),
    )

    assert repositories.issues.get(WORKSPACE, issue.issue_id).title == "Changed there"
    rows = repositories.activity.list_for_issue(WORKSPACE, issue.issue_id).items
    conflict = [row for row in rows if row.get("field") == issue_sync.CONFLICT_FIELD]
    assert conflict and conflict[0].get("to_value") == {"field": "title", "kept": "github"}


def test_a_conflict_the_local_edit_wins_is_pushed_back(
    repositories: Any,
    synced: TeamSync,
    enqueued: list[tuple[str, Any]],
) -> None:
    """A later local edit is kept, recorded, and queued so GitHub converges on it."""
    issue = open_issue(repositories, updated_at=at(-10))
    repositories.issues.replace(issue.model_copy(update={"title": "Changed here", "updated_at": utc_now()}))
    enqueued.clear()
    events.handle_record(
        repositories,
        sqs_record(issues_delivery("edited", github_issue(title="Changed there", updated_at=at(-5)))),
    )

    assert repositories.issues.get(WORKSPACE, issue.issue_id).title == "Changed here"
    rows = repositories.activity.list_for_issue(WORKSPACE, issue.issue_id).items
    assert any(row.get("to_value") == {"field": "title", "kept": "standupless"} for row in rows)
    assert [envelope.payload["kind"] for _url, envelope in enqueued] == [issue_sync.ISSUE_SYNC_JOB]


def test_a_github_comment_arrives_under_the_login(
    repositories: Any,
    synced: TeamSync,
    enqueued: list[tuple[str, Any]],
) -> None:
    """An unlinked commenter is stored under their GitHub login, once."""
    issue = open_issue(repositories)
    events.handle_record(repositories, sqs_record(comment_delivery("created")))
    events.handle_record(repositories, sqs_record(comment_delivery("created")))

    comments = repositories.comments.list_for_issue(WORKSPACE, issue.issue_id).items
    assert [(row["author_id"], row["body"]) for row in comments] == [("github:commenter", "Looks like a race")]
    authors = authors_for(repositories, ["github:commenter"])
    assert authors["github:commenter"].display_name == "commenter (GitHub)"


def test_a_linked_commenter_is_the_member(
    repositories: Any,
    synced: TeamSync,
    enqueued: list[tuple[str, Any]],
) -> None:
    """A commenter who linked their GitHub account is stored as themselves."""
    issue = open_issue(repositories)
    events.handle_record(
        repositories,
        sqs_record(comment_delivery("created", user={"id": int(GITHUB_USER_ID), "login": GITHUB_LOGIN})),
    )

    comments = repositories.comments.list_for_issue(WORKSPACE, issue.issue_id).items
    assert comments[0]["author_id"] == MEMBER


def test_a_github_comment_edit_and_delete_follow(
    repositories: Any,
    synced: TeamSync,
    enqueued: list[tuple[str, Any]],
) -> None:
    """Edits and deletes on GitHub reach the mirrored comment and its sync row."""
    issue = open_issue(repositories)
    events.handle_record(repositories, sqs_record(comment_delivery("created")))
    events.handle_record(repositories, sqs_record(comment_delivery("edited", body="Definitely a race")))

    comments = repositories.comments.list_for_issue(WORKSPACE, issue.issue_id).items
    assert comments[0]["body"] == "Definitely a race"

    events.handle_record(repositories, sqs_record(comment_delivery("deleted")))
    assert repositories.comments.list_for_issue(WORKSPACE, issue.issue_id).items == []
    assert repositories.github.comment_sync_for_github(WORKSPACE, "777") is None


def new_local_issue(repositories: Any, **fields: Any) -> Issue:
    """An issue created in Standupless, in the synced team."""
    by_category = statuses(repositories)
    return repositories.issues.create(
        Issue(
            workspace_id=WORKSPACE,
            team_id=TEAM,
            key="ABC-40",
            number=40,
            title=fields.get("title", "Local issue"),
            body=fields.get("body"),
            status_id=fields.get("status_id", by_category["unstarted"]),
            assignee_id=fields.get("assignee_id"),
            label_ids=fields.get("label_ids", []),
            created_by=MEMBER,
        )
    )


def issue_job(issue: Issue, *, created: bool) -> dict[str, Any]:
    """One outbound issue sync job."""
    return {
        "kind": issue_sync.ISSUE_SYNC_JOB,
        "workspace_id": WORKSPACE,
        "issue_id": issue.issue_id,
        "created": created,
    }


def test_a_new_local_issue_opens_on_github_once(
    repositories: Any,
    synced: TeamSync,
    github: FakeGithub,
) -> None:
    """A new issue is opened with its labels and linked assignee, and a replay opens nothing."""
    issue = new_local_issue(repositories, assignee_id=MEMBER, label_ids=["bug-label"])
    dispatch.handle_record(repositories, sqs_record(issue_job(issue, created=True)))
    dispatch.handle_record(repositories, sqs_record(issue_job(issue, created=True)))

    assert len(github.created) == 1
    assert github.created[0]["labels"] == ["bug"]
    assert github.created[0]["assignees"] == [GITHUB_LOGIN]
    sync = repositories.github.get_issue_sync(WORKSPACE, issue.issue_id)
    assert (sync.state, sync.number, sync.origin) == ("linked", 55, "standupless")
    assert repositories.github.issue_sync_for_github(WORKSPACE, REPOSITORY_ID, 55).issue_id == issue.issue_id


def test_a_local_edit_patches_only_what_changed(
    repositories: Any,
    synced: TeamSync,
    github: FakeGithub,
) -> None:
    """A title change and a close are one patch, and an unchanged issue sends nothing."""
    issue = new_local_issue(repositories)
    dispatch.handle_record(repositories, sqs_record(issue_job(issue, created=True)))
    closed = issue.model_copy(
        update={"title": "Renamed", "status_id": statuses(repositories)["completed"], "updated_at": utc_now()}
    )
    repositories.issues.replace(closed)
    dispatch.handle_record(repositories, sqs_record(issue_job(issue, created=False)))
    dispatch.handle_record(repositories, sqs_record(issue_job(issue, created=False)))

    assert github.updated == [(55, {"title": "Renamed", "state": "closed", "state_reason": "completed"})]


def test_an_inbound_change_is_not_echoed_back(
    repositories: Any,
    synced: TeamSync,
    github: FakeGithub,
    enqueued: list[tuple[str, Any]],
) -> None:
    """The job an inbound write raises finds nothing new and makes no call."""
    issue = open_issue(repositories, updated_at=at(-5))
    events.handle_record(
        repositories,
        sqs_record(issues_delivery("edited", github_issue(title="From GitHub", updated_at=at(1)))),
    )
    dispatch.handle_record(repositories, sqs_record(issue_job(issue, created=False)))

    assert github.updated == []
    assert github.tokens == 0


def test_the_one_way_direction_writes_nothing_back(
    repositories: Any,
    installed: str,
    github_env: None,
    github: FakeGithub,
) -> None:
    """A team set to follow GitHub only never opens or patches a GitHub issue."""
    link_team(repositories, direction="github_to_standupless")
    issue = new_local_issue(repositories)
    dispatch.handle_record(repositories, sqs_record(issue_job(issue, created=True)))

    assert github.created == []


def test_a_local_comment_posts_with_attribution_then_edits(
    repositories: Any,
    synced: TeamSync,
    github: FakeGithub,
    enqueued: list[tuple[str, Any]],
) -> None:
    """A comment is posted once, naming its author, and an edit patches that copy."""
    issue = open_issue(repositories)
    comment = repositories.comments.create(build_comment(WORKSPACE, issue.issue_id, TEAM, MEMBER, "On it"))
    job = {
        "kind": issue_sync.COMMENT_SYNC_JOB,
        "workspace_id": WORKSPACE,
        "issue_id": issue.issue_id,
        "comment_id": comment.comment_id,
    }
    dispatch.handle_record(repositories, sqs_record(job))
    dispatch.handle_record(repositories, sqs_record(job))

    assert github.comments == [(12, "**Mel Member** commented in Standupless:\n\nOn it")]

    repositories.comments.edit(WORKSPACE, issue.issue_id, comment.comment_id, "On it now", [])
    dispatch.handle_record(repositories, sqs_record(job))
    assert github.comment_updates == [("4242", "**Mel Member** commented in Standupless:\n\nOn it now")]


def test_a_github_comment_is_not_posted_back(
    repositories: Any,
    synced: TeamSync,
    github: FakeGithub,
    enqueued: list[tuple[str, Any]],
) -> None:
    """The job a mirrored GitHub comment raises posts nothing."""
    issue = open_issue(repositories)
    events.handle_record(repositories, sqs_record(comment_delivery("created")))
    comment = repositories.comments.list_for_issue(WORKSPACE, issue.issue_id).items[0]
    job = {
        "kind": issue_sync.COMMENT_SYNC_JOB,
        "workspace_id": WORKSPACE,
        "issue_id": issue.issue_id,
        "comment_id": comment["comment_id"],
    }
    dispatch.handle_record(repositories, sqs_record(job))

    assert github.comments == []


SERIALIZER = TypeSerializer()


def stream_record(event: str, new: Mapping[str, Any], old: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """One stream record in the shape Lambda delivers it."""
    dynamodb: dict[str, Any] = {"NewImage": {key: SERIALIZER.serialize(value) for key, value in new.items()}}
    if old is not None:
        dynamodb["OldImage"] = {key: SERIALIZER.serialize(value) for key, value in old.items()}
    return {"eventName": event, "dynamodb": dynamodb}


def test_the_stream_queues_a_job_for_a_synced_team_only(
    repositories: Any,
    synced: TeamSync,
    enqueued: list[tuple[str, Any]],
) -> None:
    """A synced field change queues a job; another team's issue and a rollup change do not."""
    issue = new_local_issue(repositories)
    item = as_item(issue)
    assert stream.queue_issue_sync(repositories, stream_record("INSERT", item))
    assert stream.queue_issue_sync(repositories, stream_record("MODIFY", {**item, "title": "New"}, item))
    assert not stream.queue_issue_sync(repositories, stream_record("MODIFY", {**item, "priority": "high"}, item))
    assert not stream.queue_issue_sync(repositories, stream_record("INSERT", {**item, "team_id": OTHER_TEAM}))

    jobs = [envelope.payload for _url, envelope in enqueued]
    assert [job["created"] for job in jobs] == [True, False]


def test_the_stream_queues_comment_inserts_and_body_edits(
    repositories: Any,
    synced: TeamSync,
    enqueued: list[tuple[str, Any]],
) -> None:
    """A new comment and an edited body queue a job; an unrelated change does not."""
    comment = as_item(build_comment(WORKSPACE, "issue-1", TEAM, MEMBER, "Hello"))
    assert stream.queue_comment_sync(repositories, stream_record("INSERT", comment))
    assert stream.queue_comment_sync(repositories, stream_record("MODIFY", {**comment, "body": "Hi"}, comment))
    assert not stream.queue_comment_sync(repositories, stream_record("MODIFY", {**comment, "mentions": ["x"]}, comment))


def test_the_purge_forgets_the_link_and_sync_rows(
    repositories: Any,
    synced: TeamSync,
    enqueued: list[tuple[str, Any]],
) -> None:
    """A deleted team leaves no sync row, pointer or repository claim behind."""
    issue = open_issue(repositories)
    events.handle_record(repositories, sqs_record(comment_delivery("created")))

    while purge.step(repositories, PurgeJob(WORKSPACE, TEAM, "integrations", 0), Deadline(30)) is not None:
        pass

    assert repositories.github.get_team_sync(WORKSPACE, TEAM) is None
    assert repositories.github.team_sync_for_repository(WORKSPACE, REPOSITORY_ID) is None
    assert repositories.github.get_issue_sync(WORKSPACE, issue.issue_id) is None
    assert repositories.github.issue_sync_for_github(WORKSPACE, REPOSITORY_ID, 12) is None
    assert repositories.github.comment_sync_for_github(WORKSPACE, "777") is None


def test_an_admin_links_reads_and_unlinks_a_team(client: TestClient, installed: str) -> None:
    """The team settings round trip, including the one-team-per-repository rule."""
    sign_in(client, ADMIN)
    path = f"/api/workspaces/{WORKSPACE}/teams/{TEAM}/github-sync"

    assert client.get(path).status_code == 404
    response = client.put(path, json={"repository_id": REPOSITORY_ID, "direction": "two_way"})
    assert response.status_code == 200
    assert response.json()["full_name"] == REPOSITORY_FULL_NAME
    assert client.get(path).json()["enabled"] is True

    other = f"/api/workspaces/{WORKSPACE}/teams/{OTHER_TEAM}/github-sync"
    assert client.put(other, json={"repository_id": REPOSITORY_ID}).status_code == 409
    assert client.put(path, json={"repository_id": "404404"}).status_code == 422

    assert client.delete(path).status_code == 204
    assert client.put(other, json={"repository_id": REPOSITORY_ID}).status_code == 200


def test_a_member_cannot_change_the_link(client: TestClient, installed: str) -> None:
    """Linking a repository is a team admin decision."""
    sign_in(client, MEMBER)
    response = client.put(
        f"/api/workspaces/{WORKSPACE}/teams/{TEAM}/github-sync",
        json={"repository_id": REPOSITORY_ID},
    )

    assert response.status_code == 403


def test_the_issue_chip_reads_the_github_issue(
    client: TestClient,
    repositories: Any,
    synced: TeamSync,
    enqueued: list[tuple[str, Any]],
) -> None:
    """A synced issue answers its GitHub issue; a guest outside the team sees 404."""
    issue = open_issue(repositories)
    sign_in(client, MEMBER)
    response = client.get(f"/api/workspaces/{WORKSPACE}/issues/{issue.issue_id}/github-sync")
    assert response.status_code == 200
    assert response.json()["number"] == 12
    assert response.json()["url"].endswith("/issues/12")

    local = new_local_issue(repositories)
    assert client.get(f"/api/workspaces/{WORKSPACE}/issues/{local.issue_id}/github-sync").status_code == 404

    hidden = repositories.issues.create(
        local.model_copy(update={"issue_id": "01JB0000000000000000000HID", "team_id": OTHER_TEAM})
    )
    sign_in(client, GUEST)
    assert client.get(f"/api/workspaces/{WORKSPACE}/issues/{hidden.issue_id}/github-sync").status_code == 404


def test_a_rate_limit_raises_the_shared_error_for_the_queue_to_retry() -> None:
    """A 403 with the limit spent is a rate limit, not a permission refusal."""
    transport = httpx.MockTransport(
        lambda request: httpx.Response(403, headers={"x-ratelimit-remaining": "0", "retry-after": "30"})
    )
    with httpx.Client(transport=transport) as http, pytest.raises(github_issues.GitHubRateLimited) as raised:
        github_issues.update_issue("ghs_test", REPOSITORY_FULL_NAME, 12, {"title": "x"}, client=http)

    assert raised.value.retry_after == 30
    assert raised.value.status_code == 403


def test_an_issue_patch_sends_the_installation_token() -> None:
    """The patch reaches the issue's path with the token as a bearer."""
    seen: list[httpx.Request] = []

    def answer(request: httpx.Request) -> httpx.Response:
        """Record the request and answer like GitHub."""
        seen.append(request)
        return httpx.Response(200, json=github_issue(title="x"))

    with httpx.Client(transport=httpx.MockTransport(answer)) as http:
        github_issues.update_issue("ghs_test", REPOSITORY_FULL_NAME, 12, {"title": "x"}, client=http)

    assert seen[0].url.path == f"/repos/{REPOSITORY_FULL_NAME}/issues/12"
    assert seen[0].headers["authorization"] == "Bearer ghs_test"
