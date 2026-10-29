"""Status changes posted back into the Slack thread an issue came from.

An issue paired with a Slack thread, by the message shortcut, the slash command,
reaction intake or a request form, tells that thread when it leaves triage, when
its status moves into another of the started, completed or cancelled categories,
and when it is marked as a duplicate, so the person who asked sees progress
without a Standupless seat.

The `issues` stream picks the changes worth a post and schedules one delayed job
per issue on its debounce row, so a burst of changes inside `DEBOUNCE_SECONDS`
queues a single job. The job reads the issue as it stands then and the history
of the burst, and posts one message, unless the thread was already told exactly
that. The job's token on the row makes a redelivered job post nothing. Slack
refusals follow the thread sync rules: the codes in `RETRYABLE_ERRORS` hand the
job back to the queue, and a revoked or unreadable bot token drops the post
quietly. A team turns the posts off from its Slack intake settings.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Mapping

from webbpulse.events import deserialize_image

from app.common.api.dependencies.repositories import Repositories
from app.common.core.config import settings
from app.common.db.dynamo.activity import as_activity
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.comments import as_comment
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.slack_threads import SlackThreadLink
from app.common.issue_keys import current
from app.domains.integrations.channels.messages import clip, slack_escape
from app.domains.integrations.slack import install
from app.domains.integrations.slack.api import SlackError
from app.domains.integrations.slack.threads import RETRYABLE_ERRORS
from app.domains.integrations.slack.transport import REVOKED_ERRORS

_log = logging.getLogger(__name__)

STATUS_POST_JOB = "slack.status_post"

DEBOUNCE_SECONDS = 60

SCHEDULE_STALE = timedelta(minutes=15)

PENDING_STALE = timedelta(minutes=2)

HISTORY_SLACK = timedelta(seconds=5)

HISTORY_PAGE = 50

ROOT_SCAN = 25

POSTED_CATEGORIES = frozenset({"started", "completed", "cancelled"})
"""The status categories whose arrival a thread hears about."""


@dataclass(frozen=True)
class StatusPost:
    """What one job tells a thread: which kind of change, and the sentence that says it."""

    kind: str
    text: str


def qualifies(old: Mapping[str, Any], new: Mapping[str, Any], old_category: str, new_category: str) -> bool:
    """Whether one issue write is a change a paired thread hears about.

    Leaving triage always is, whether the issue was accepted, declined or marked
    a duplicate. Otherwise the status has to land in a posted category other
    than the one it left. An issue still in triage, archived or trashed is not.
    """
    if not new or not old or new.get("in_triage"):
        return False
    if new.get("archived_at") or new.get("deleted_at"):
        return False
    if old.get("in_triage"):
        return True
    return new_category in POSTED_CATEGORIES and new_category != old_category


def describe(category: str, status_name: str, outcome: str, duplicate_key: str) -> StatusPost | None:
    """The post for an issue's state at the end of a burst, or `None` when it says nothing new.

    `outcome` is the triage outcome the burst recorded, and `duplicate_key` the
    key of the issue a duplicate link in the burst named.
    """
    named = f"*{slack_escape(clip(status_name, 80))}*" if status_name else "a new status"
    if category == "cancelled" and duplicate_key:
        return StatusPost("duplicate", f"Marked as a duplicate of {slack_escape(clip(duplicate_key, 40))}.")
    if outcome in ("declined", "duplicate") and category == "cancelled":
        return StatusPost("declined", "Declined in triage.")
    if outcome == "accepted":
        return StatusPost("accepted", f"Accepted from triage, now {named}.")
    if category == "started":
        return StatusPost("started", f"Work started, now {named}.")
    if category == "completed":
        return StatusPost("completed", f"Completed, now {named}.")
    if category == "cancelled":
        return StatusPost("cancelled", f"Cancelled, now {named}.")
    return None


def paired_links(
    repositories: Repositories, workspace_id: str, issue_id: str, slack_team_id: str
) -> list[SlackThreadLink]:
    """The Slack threads one issue is paired with in the installed Slack workspace.

    A pairing's root comment is written as the issue is created, so it sits on
    the first page of the thread, and each root is checked against its pairing row.
    """
    page = repositories.comments.list_for_issue(workspace_id, issue_id, limit=ROOT_SCAN)
    links: list[SlackThreadLink] = []
    for item in page.items:
        root = as_comment(item)
        thread = root.slack_thread
        if thread is None or thread.slack_team_id != slack_team_id:
            continue
        link = repositories.github.slack_threads.get_link(workspace_id, thread.channel_id, thread.thread_ts, issue_id)
        if link is not None and link.root_comment_id == root.comment_id:
            links.append(link)
    return links


def _category(repositories: Repositories, workspace_id: str, team_id: str, status_id: Any) -> tuple[str, str]:
    """A status's category and name, or empty strings when it is gone."""
    status = repositories.team_config.get_status(workspace_id, team_id, str(status_id or ""))
    return (status.category, status.name) if status is not None else ("", "")


def queue_status_post(repositories: Repositories, record: Mapping[str, Any]) -> bool:
    """Schedule a status post for an issue write a paired thread hears about, answering whether one was queued.

    Read off the `issues` stream. The cheap checks run first, so an ordinary
    edit costs no read, and a change inside a burst already scheduled queues nothing.
    """
    from app.domains.integrations.issue_sync import _enqueue

    if record.get("eventName") != "MODIFY" or not settings.WEBHOOK_DISPATCH_QUEUE_URL:
        return False
    new = deserialize_image(record, "NewImage") or {}
    old = deserialize_image(record, "OldImage") or {}
    if not new or not old or new.get("in_triage"):
        return False
    if not old.get("in_triage") and old.get("status_id") == new.get("status_id"):
        return False
    workspace_id = str(new.get("workspace_id", ""))
    team_id = str(new.get("team_id", ""))
    issue_id = str(new.get("issue_id", ""))
    if not workspace_id or not team_id or not issue_id:
        return False
    installation = repositories.github.slack.get(workspace_id)
    if installation is None:
        return False
    store = repositories.github.slack_status
    if not store.enabled(workspace_id, team_id):
        return False
    old_category, _ = _category(repositories, workspace_id, str(old.get("team_id") or team_id), old.get("status_id"))
    new_category, _ = _category(repositories, workspace_id, team_id, new.get("status_id"))
    if not qualifies(old, new, old_category, new_category):
        return False
    if not paired_links(repositories, workspace_id, issue_id, installation.slack_team_id):
        return False
    row = store.schedule(workspace_id, issue_id, team_id, uuid.uuid4().hex, stale_before=utc_now() - SCHEDULE_STALE)
    if row is None:
        return False
    _enqueue(
        STATUS_POST_JOB,
        {"kind": STATUS_POST_JOB, "workspace_id": workspace_id, "issue_id": issue_id, "token": row.token},
        workspace_id,
        delay_seconds=DEBOUNCE_SECONDS,
    )
    return True


def _history(repositories: Repositories, issue: Issue, since: datetime) -> tuple[str, str]:
    """The triage outcome and duplicate target the burst since `since` recorded, newest first."""
    page = repositories.activity.list_for_issue(issue.workspace_id, issue.issue_id, limit=HISTORY_PAGE)
    outcome = ""
    duplicate_key = ""
    cutoff = since - HISTORY_SLACK
    for item in page.items:
        if item.get("kind") not in ("field_changed", "link_added"):
            continue
        row = as_activity(item)
        if row.created_at < cutoff:
            break
        if not outcome and row.kind == "field_changed" and row.field == "triage":
            outcome = str(row.to_value or "")
        if not duplicate_key and row.kind == "link_added" and row.field == "duplicate_of":
            target = row.to_value if isinstance(row.to_value, Mapping) else {}
            duplicate_key = str(target.get("key") or "")
    return ("" if outcome == "pending" else outcome), duplicate_key


def _issue_label(repositories: Repositories, issue: Issue) -> str:
    """The issue's key, linked to its page when the workspace can be named."""
    from app.domains.integrations.issue_sync import issue_url

    key = current(repositories.teams, issue).key
    workspace = repositories.workspaces.get(issue.workspace_id)
    label = slack_escape(key)
    if workspace is None or not workspace.slug:
        return f"*{label}*"
    return f"<{issue_url(workspace.slug, key)}|{label}>"


def push_status(repositories: Repositories, job: Mapping[str, Any]) -> None:
    """Post one scheduled status change into every thread the issue is paired with.

    The row is claimed by the job's token first, so a redelivered or superseded
    job posts nothing. A transient refusal hands the row back as scheduled and
    raises for the queue, keeping the threads already told, and a lasting one
    drops the post.
    """
    workspace_id = str(job.get("workspace_id", ""))
    issue_id = str(job.get("issue_id", ""))
    token = str(job.get("token", ""))
    store = repositories.github.slack_status
    row = store.get_post(workspace_id, issue_id)
    if row is None or not token or row.token != token or row.state == "done":
        return
    claimed = store.claim(row, stale_before=utc_now() - PENDING_STALE)
    if claimed is None:
        return
    finished = claimed.model_copy(update={"state": "done", "posted_links": []})
    issue = repositories.issues.get(workspace_id, issue_id)
    installation = repositories.github.slack.get(workspace_id)
    if (
        issue is None
        or issue.archived_at is not None
        or issue.deleted_at is not None
        or issue.in_triage
        or installation is None
        or not store.enabled(workspace_id, issue.team_id)
    ):
        store.settle(finished)
        return
    category, status_name = _category(repositories, workspace_id, issue.team_id, issue.status_id)
    outcome, duplicate_key = _history(repositories, issue, claimed.window_started_at)
    post = describe(category, status_name, outcome, duplicate_key)
    signature = f"{post.kind}:{issue.status_id}" if post is not None else ""
    if post is None or signature == claimed.last_signature:
        store.settle(finished)
        return
    text = f"{_issue_label(repositories, issue)}: {post.text}"
    posted = list(claimed.posted_links)
    for link in paired_links(repositories, workspace_id, issue_id, installation.slack_team_id):
        if link.github_key in posted:
            continue
        try:
            install.call(
                installation,
                "chat.postMessage",
                {
                    "channel": link.channel_id,
                    "thread_ts": link.thread_ts,
                    "text": text,
                    "unfurl_links": False,
                    "unfurl_media": False,
                },
            )
        except install.BotUnavailable:
            _log.info(
                "Dropped a Slack status post: the bot token will not open.",
                extra={"event": "integrations.slack.status_post_dropped"},
            )
            store.settle(finished)
            return
        except SlackError as error:
            if error.code in RETRYABLE_ERRORS:
                store.settle(claimed.model_copy(update={"state": "scheduled", "posted_links": posted}))
                raise
            if error.code in REVOKED_ERRORS:
                _log.info(
                    "Dropped a Slack status post: the App was revoked.",
                    extra={"event": "integrations.slack.status_post_dropped"},
                )
                store.settle(finished)
                return
            _log.info(
                "Slack refused a status post.",
                extra={"event": "integrations.slack.status_post_refused", "reason": error.code},
            )
            continue
        posted.append(link.github_key)
    store.settle(finished.model_copy(update={"last_signature": signature}))
    _log.info("Posted a status change to a synced Slack thread.", extra={"event": "integrations.slack.status_posted"})
