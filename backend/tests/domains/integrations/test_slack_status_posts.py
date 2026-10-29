"""Status changes posted back into the Slack thread an issue came from.

Slack is faked at `api.call` as in `test_slack_threads.py`, and the pairing is
made the same way, through the form a message shortcut opens. A status change
is written to the issue, its stream record is handed to the stream consumer's
hook, and the delayed job it queues is run through the dispatch consumer, so
each test runs the routing a deployed function runs.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common.db.dynamo.activity import build_activity
from app.common.db.dynamo.base import as_item
from app.common.db.dynamo.issues import Issue
from app.domains.integrations.consumers import dispatch, stream
from app.domains.integrations.slack import status_posts
from app.domains.integrations.slack.api import SlackError
from tests.domains.helpers import ADMIN, MEMBER, sign_in
from tests.domains.integrations.conftest import TEAM, WORKSPACE, sqs_record
from tests.domains.integrations.test_issue_sync import statuses, stream_record
from tests.domains.integrations.test_slack_threads import (
    THREAD_TS,
    ThreadSlack,
    installed,
    paired,
    slack,
    slack_client,
)

__all__ = ["installed", "paired", "slack", "slack_client"]

SETTING_PATH = f"/api/workspaces/{WORKSPACE}/teams/{TEAM}/webhooks/slack-status-posts"


def _move(repositories: Any, issue: Issue, **changes: Any) -> tuple[Issue, dict[str, Any]]:
    """Write `changes` to the stored issue, answering it and the stream record the write makes."""
    current = repositories.issues.get(WORKSPACE, issue.issue_id)
    assert current is not None
    before = as_item(current)
    stored = repositories.issues.replace(current.model_copy(update=changes))
    return stored, stream_record("MODIFY", as_item(stored), before)


def _note(repositories: Any, issue: Issue, kind: str, field: str, to_value: Any) -> None:
    """Record one activity row on the issue, as a triage or link write does."""
    repositories.activity.record(
        build_activity(WORKSPACE, TEAM, issue.issue_id, ADMIN, kind, field=field, to_value=to_value)
    )


def _jobs(enqueued: list[tuple[str, Any]]) -> list[dict[str, Any]]:
    """Every status post job queued so far."""
    return [
        envelope.payload for _url, envelope in enqueued if envelope.payload.get("kind") == status_posts.STATUS_POST_JOB
    ]


def _run(repositories: Any, job: dict[str, Any]) -> None:
    """Run one queued job through the dispatch consumer."""
    dispatch.handle_record(repositories, sqs_record(job))


def _posts(slack: ThreadSlack, since: int) -> list[str]:
    """The text of every post the bot made into the paired thread after call `since`."""
    return [
        str(body.get("text", ""))
        for method, _token, body in slack.calls[since:]
        if method == "chat.postMessage" and body.get("thread_ts") == THREAD_TS
    ]


def test_only_triage_exits_and_category_moves_qualify() -> None:
    """Leaving triage and moving into a posted category qualify; edits, triage and archived issues do not."""
    base = {"issue_id": "i1", "in_triage": False}
    assert status_posts.qualifies({**base, "in_triage": True}, base, "", "backlog")
    assert status_posts.qualifies(base, base, "unstarted", "started")
    assert status_posts.qualifies(base, base, "started", "completed")
    assert status_posts.qualifies(base, base, "started", "cancelled")
    assert not status_posts.qualifies(base, base, "started", "started")
    assert not status_posts.qualifies(base, base, "started", "unstarted")
    assert not status_posts.qualifies(base, base, "backlog", "unstarted")
    assert not status_posts.qualifies(base, {**base, "in_triage": True}, "", "started")
    assert not status_posts.qualifies(base, {**base, "archived_at": "2026-10-25T00:00:00Z"}, "started", "completed")
    assert not status_posts.qualifies({}, base, "", "started")


def test_each_change_says_one_sentence() -> None:
    """A duplicate, a decline, an accept and each posted category have their own sentence."""
    assert status_posts.describe("cancelled", "Canceled", "duplicate", "ENG-9") == status_posts.StatusPost(
        "duplicate", "Marked as a duplicate of ENG-9."
    )
    declined = status_posts.describe("cancelled", "Canceled", "declined", "")
    assert declined is not None and declined.text == "Declined in triage."
    accepted = status_posts.describe("unstarted", "Todo", "accepted", "")
    assert accepted is not None and accepted.text == "Accepted from triage, now *Todo*."
    started = status_posts.describe("started", "In <Progress>", "", "")
    assert started is not None and started.text == "Work started, now *In &lt;Progress&gt;*."
    completed = status_posts.describe("completed", "Done", "", "")
    assert completed is not None and completed.kind == "completed"
    assert status_posts.describe("unstarted", "Todo", "", "") is None


def test_a_burst_of_changes_posts_once_and_a_redelivery_posts_nothing(
    paired: Issue, repositories: Any, slack: ThreadSlack, enqueued: list[tuple[str, Any]]
) -> None:
    """Two status moves inside the window queue one job, which posts the latest state once."""
    ids = statuses(repositories)
    _issue, started = _move(repositories, paired, status_id=ids["started"])
    assert stream.queue_slack_status_post(repositories, started)
    _issue, completed = _move(repositories, paired, status_id=ids["completed"])
    assert not stream.queue_slack_status_post(repositories, completed)

    jobs = _jobs(enqueued)
    assert len(jobs) == 1
    since = len(slack.calls)
    _run(repositories, jobs[0])
    posts = _posts(slack, since)
    assert len(posts) == 1
    assert "Completed, now" in posts[0]

    since = len(slack.calls)
    _run(repositories, jobs[0])
    assert _posts(slack, since) == []


def test_a_flip_back_to_what_the_thread_was_told_stays_quiet(
    paired: Issue, repositories: Any, slack: ThreadSlack, enqueued: list[tuple[str, Any]]
) -> None:
    """Started, posted, then out and back into the same status posts nothing more."""
    ids = statuses(repositories)
    _issue, started = _move(repositories, paired, status_id=ids["started"])
    assert stream.queue_slack_status_post(repositories, started)
    _run(repositories, _jobs(enqueued)[-1])

    _move(repositories, paired, status_id=ids["unstarted"])
    _issue, back = _move(repositories, paired, status_id=ids["started"])
    assert stream.queue_slack_status_post(repositories, back)
    since = len(slack.calls)
    _run(repositories, _jobs(enqueued)[-1])
    assert _posts(slack, since) == []


def test_ordinary_edits_and_unpaired_issues_queue_nothing(
    paired: Issue, repositories: Any, enqueued: list[tuple[str, Any]]
) -> None:
    """A title edit, a move inside one category and an issue with no thread queue no job."""
    ids = statuses(repositories)
    _issue, renamed = _move(repositories, paired, title="Checkout fails on Safari 18")
    assert not stream.queue_slack_status_post(repositories, renamed)
    _issue, unstarted = _move(repositories, paired, status_id=ids["unstarted"])
    assert not stream.queue_slack_status_post(repositories, unstarted)

    current = repositories.issues.get(WORKSPACE, paired.issue_id)
    assert current is not None
    item = {**as_item(current), "issue_id": "01JB00000000000000000NOPE0"}
    record = stream_record("MODIFY", {**item, "status_id": ids["started"]}, item)
    assert not stream.queue_slack_status_post(repositories, record)
    assert _jobs(enqueued) == []


def test_leaving_triage_says_how(
    paired: Issue, repositories: Any, slack: ThreadSlack, enqueued: list[tuple[str, Any]]
) -> None:
    """An accept names the new status, and a duplicate names the issue it duplicates."""
    ids = statuses(repositories)
    _move(repositories, paired, in_triage=True)
    _note(repositories, paired, "field_changed", "triage", "accepted")
    _issue, accepted = _move(repositories, paired, in_triage=False, status_id=ids["unstarted"])
    assert stream.queue_slack_status_post(repositories, accepted)
    since = len(slack.calls)
    _run(repositories, _jobs(enqueued)[-1])
    posts = _posts(slack, since)
    assert len(posts) == 1 and "Accepted from triage" in posts[0]

    _note(repositories, paired, "link_added", "duplicate_of", {"id": "x", "key": "ENG-9", "title": "Older"})
    _issue, cancelled = _move(repositories, paired, status_id=ids["cancelled"])
    assert stream.queue_slack_status_post(repositories, cancelled)
    since = len(slack.calls)
    _run(repositories, _jobs(enqueued)[-1])
    posts = _posts(slack, since)
    assert len(posts) == 1 and "Marked as a duplicate of ENG-9." in posts[0]


def test_a_rate_limited_post_is_retried_and_a_revoked_one_dropped(
    paired: Issue, repositories: Any, slack: ThreadSlack, enqueued: list[tuple[str, Any]]
) -> None:
    """A retryable refusal hands the job back to the queue; a revoked token drops the post quietly."""
    ids = statuses(repositories)
    _issue, started = _move(repositories, paired, status_id=ids["started"])
    assert stream.queue_slack_status_post(repositories, started)
    job = _jobs(enqueued)[-1]

    slack.errors["chat.postMessage"] = "ratelimited"
    with pytest.raises(SlackError):
        status_posts.push_status(repositories, job)
    row = repositories.github.slack_status.get_post(WORKSPACE, paired.issue_id)
    assert row is not None and row.state == "scheduled"

    del slack.errors["chat.postMessage"]
    since = len(slack.calls)
    _run(repositories, job)
    assert len(_posts(slack, since)) == 1

    _issue, completed = _move(repositories, paired, status_id=ids["completed"])
    assert stream.queue_slack_status_post(repositories, completed)
    slack.errors["chat.postMessage"] = "token_revoked"
    _run(repositories, _jobs(enqueued)[-1])
    row = repositories.github.slack_status.get_post(WORKSPACE, paired.issue_id)
    assert row is not None and row.state == "done"


def test_the_team_switch_is_on_by_default_and_admin_only(
    slack_client: TestClient, paired: Issue, repositories: Any, slack: ThreadSlack, enqueued: list[tuple[str, Any]]
) -> None:
    """Members read the switch, only an admin turns it off, and off stops both queueing and posting."""
    ids = statuses(repositories)
    _issue, started = _move(repositories, paired, status_id=ids["started"])
    assert stream.queue_slack_status_post(repositories, started)
    waiting = _jobs(enqueued)[-1]

    sign_in(slack_client, MEMBER)
    read = slack_client.get(SETTING_PATH)
    assert read.status_code == 200
    assert read.json()["enabled"] is True and read.json()["installed"] is True
    assert slack_client.put(SETTING_PATH, json={"enabled": False}).status_code == 403

    sign_in(slack_client, ADMIN)
    turned = slack_client.put(SETTING_PATH, json={"enabled": False})
    assert turned.status_code == 200
    assert turned.json()["enabled"] is False
    assert slack_client.get(SETTING_PATH).json()["enabled"] is False

    since = len(slack.calls)
    _run(repositories, waiting)
    assert _posts(slack, since) == []

    _issue, completed = _move(repositories, paired, status_id=ids["completed"])
    assert not stream.queue_slack_status_post(repositories, completed)


def test_private_asks_start_off_and_change_without_touching_status_posts(
    slack_client: TestClient, repositories: Any
) -> None:
    """Private asks read off until an admin turns them on, and each field of a write is kept when left out."""
    sign_in(slack_client, ADMIN)
    assert slack_client.get(SETTING_PATH).json()["private_asks"] is False
    assert not repositories.github.slack_status.allows_private_asks(WORKSPACE, TEAM)

    turned = slack_client.put(SETTING_PATH, json={"private_asks": True})
    assert turned.status_code == 200
    assert turned.json()["private_asks"] is True and turned.json()["enabled"] is True
    assert repositories.github.slack_status.allows_private_asks(WORKSPACE, TEAM)

    slack_client.put(SETTING_PATH, json={"enabled": False})
    read = slack_client.get(SETTING_PATH).json()
    assert read["enabled"] is False and read["private_asks"] is True

    sign_in(slack_client, MEMBER)
    assert slack_client.put(SETTING_PATH, json={"private_asks": False}).status_code == 403
