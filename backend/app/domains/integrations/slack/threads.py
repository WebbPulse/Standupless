"""Comments synced both ways between an issue and the Slack thread it was created from.

Creating an issue with the "Create issue" message shortcut pairs it with the
message's thread. The bot replies in that thread with a link to the issue, and
the issue gains one root comment marked with the Slack thread, which is what the
comment area shows as synced. From then on a reply in the Slack thread lands as a
reply under that root, attributed to the member whose confirmed Slack email
matches, or else to the Slack display name, and a reply written under that root
in Standupless is posted to the Slack thread by the bot, naming its author.

Only new messages cross. Edits and deletes on either side stay where they were
made, and a Slack reply's files, reactions and formatting beyond links, mentions
and channel names are left behind. The pairing is deterministic: nothing here
reads the text to decide anything beyond rewriting Slack's link syntax.

Three echo guards keep a message from bouncing. A Slack message the bot or any
other app posted is ignored, a comment written from Slack is never posted back,
and every crossing claims a row before it is written on the other side, so a
redelivered event or a retried job crosses once. Removing the App, revoking its
token or disconnecting Slack forgets every pairing and clears the root marks.
"""

from __future__ import annotations

import logging
import re
from datetime import timedelta
from typing import Any, Mapping

from webbpulse.dynamodb import ConditionFailed
from webbpulse.events import deserialize_image

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.change_source import SLACK
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.comments import Comment, SlackThread, build_comment, new_comment_id
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.slack import SlackInstallation
from app.common.db.dynamo.slack_threads import SlackMessageClaim, SlackThreadLink, comment_key, message_key, thread_key
from app.common.discussion_reads import PLACEHOLDER_AUTHORS, SLACK_AUTHOR_PREFIX
from app.common.issue_keys import current
from app.common.thread_resolution import reopen_on_reply
from app.common.triage_wake import wake_on_activity
from app.domains.integrations.channels.messages import clip, excerpt, slack_escape
from app.domains.integrations.chat.people import NotLinked, member_context
from app.domains.integrations.slack import install
from app.domains.integrations.slack.api import SlackError
from app.domains.integrations.slack.people import email_of

_log = logging.getLogger(__name__)

THREAD_COMMENT_JOB = "slack.thread_comment"

PENDING_STALE = timedelta(minutes=2)

ROOT_BODY = (
    "Synced with the Slack thread this issue was created from. "
    "Replies here are posted to Slack, and replies in Slack land here."
)

ACCEPTED_SUBTYPES = frozenset({"", "thread_broadcast", "file_share"})
"""Message subtypes a person writes; joins, edits, deletes and app posts are left alone."""

RETRYABLE_ERRORS = frozenset(
    {"ratelimited", "unreachable", "invalid_response", "internal_error", "service_unavailable", "fatal_error"}
)
"""Slack refusals worth retrying the job for, rather than dropping the reply."""

BODY_LIMIT = 3500

NAME_LIMIT = 80

MAX_MENTION_LOOKUPS = 5

_SLACK_TOKEN = re.compile(r"<([^<>]+)>")

_MARKDOWN_LINK = re.compile(r"\[([^\[\]\n]+)\]\((https?://[^\s()]+)\)")


def _issue_link(repositories: Repositories, issue: Issue) -> str:
    """The issue page, or an empty string when the workspace cannot be named."""
    from app.domains.integrations.issue_sync import issue_url

    workspace = repositories.workspaces.get(issue.workspace_id)
    if workspace is None or not workspace.slug:
        return ""
    return issue_url(workspace.slug, current(repositories.teams, issue).key)


def pair(
    repositories: Repositories,
    installation: SlackInstallation,
    context: AuthzContext,
    issue: Issue,
    *,
    channel_id: str,
    thread_ts: str,
    permalink: str = "",
) -> bool:
    """Pair a new issue with the Slack thread its message is in, answering whether it took.

    The bot joins a public channel first so Slack sends it the thread's replies; a
    private channel it was not invited to refuses the join and the reply both, and
    then nothing is paired. The pairing is written only once the reply landed, so
    an issue is never marked synced with a thread that never heard of it.
    """
    if not channel_id or not thread_ts:
        return False
    try:
        install.call(installation, "conversations.join", {"channel": channel_id})
    except (SlackError, install.BotUnavailable):
        pass
    key = current(repositories.teams, issue).key
    url = _issue_link(repositories, issue)
    label = slack_escape(clip(f"{key} {issue.title}", 150))
    named = f"<{url}|{label}>" if url else f"*{label}*"
    text = f"Tracking this in Standupless as {named}. Replies in this thread sync with the issue's comments."
    try:
        install.call(
            installation,
            "chat.postMessage",
            {"channel": channel_id, "thread_ts": thread_ts, "text": text, "unfurl_links": False, "unfurl_media": False},
        )
    except (SlackError, install.BotUnavailable) as error:
        _log.info(
            "Slack refused the reply that pairs an issue with its thread.",
            extra={"event": "integrations.slack.thread_pair_failed", "reason": getattr(error, "code", "unreadable")},
        )
        return False
    synced_at = utc_now()
    root = build_comment(
        issue.workspace_id, issue.issue_id, issue.team_id, context.user_id, ROOT_BODY, source=SLACK
    ).model_copy(
        update={
            "slack_thread": SlackThread(
                slack_team_id=installation.slack_team_id,
                channel_id=channel_id,
                thread_ts=thread_ts,
                permalink=permalink if permalink.startswith("https://") else "",
                synced_by=context.user_id,
                synced_at=synced_at,
            )
        }
    )
    repositories.github.slack_threads.pair(
        SlackThreadLink(
            workspace_id=issue.workspace_id,
            github_key=thread_key(channel_id, thread_ts, issue.issue_id),
            issue_id=issue.issue_id,
            team_id=issue.team_id,
            root_comment_id=root.comment_id,
            slack_team_id=installation.slack_team_id,
            channel_id=channel_id,
            thread_ts=thread_ts,
            synced_by=context.user_id,
            synced_at=synced_at,
        )
    )
    repositories.comments.create(root)
    _log.info("Paired an issue with its Slack thread.", extra={"event": "integrations.slack.thread_paired"})
    return True


def wanted(event: Mapping[str, Any]) -> bool:
    """Whether a `message` event is a person's reply in a thread, the only kind that crosses.

    Checked before the event is claimed, so the stream of ordinary channel
    messages the bot sees costs no write.
    """
    if event.get("type") != "message":
        return False
    if str(event.get("subtype") or "") not in ACCEPTED_SUBTYPES:
        return False
    if event.get("bot_id") or event.get("bot_profile") or event.get("app_id"):
        return False
    thread_ts = str(event.get("thread_ts") or "")
    ts = str(event.get("ts") or "")
    return bool(thread_ts) and bool(ts) and thread_ts != ts and bool(event.get("user"))


def _profile(installation: SlackInstallation, slack_user_id: str) -> Mapping[str, Any]:
    """The `users.info` answer for one Slack user, or an empty mapping."""
    try:
        return install.call(installation, "users.info", {"user": slack_user_id})
    except (SlackError, install.BotUnavailable):
        return {}


def _display_name(profile: Mapping[str, Any]) -> str:
    """The name Slack shows for a person, falling back to their real name and then their handle."""
    user = profile.get("user") or {}
    if not isinstance(user, Mapping):
        return ""
    details = user.get("profile") or {}
    details = details if isinstance(details, Mapping) else {}
    for value in (details.get("display_name"), details.get("real_name"), user.get("real_name"), user.get("name")):
        name = " ".join(str(value or "").split())
        if name:
            return clip(name, NAME_LIMIT)
    return ""


def _author(repositories: Repositories, installation: SlackInstallation, slack_user_id: str) -> str:
    """Who a Slack reply is stored as: the matching member, or the Slack display name."""
    profile = _profile(installation, slack_user_id)
    try:
        return member_context(repositories, installation.workspace_id, email_of(profile)).user_id
    except NotLinked:
        pass
    return f"{SLACK_AUTHOR_PREFIX}{_display_name(profile) or 'someone'}"


def from_slack(text: str, installation: SlackInstallation) -> str:
    """Slack message text as comment Markdown.

    Links become Markdown links, a mention becomes the person's display name, a
    channel its name, and the three characters Slack entity encodes come back.
    Mentions are looked up a few at a time, and any past that read as `@someone`.
    """
    names: dict[str, str] = {}

    def token(match: re.Match[str]) -> str:
        """One `<...>` token as plain Markdown."""
        inner = match.group(1)
        target, _, label = inner.partition("|")
        if target.startswith("@"):
            user_id = target[1:]
            if user_id not in names:
                if len(names) < MAX_MENTION_LOOKUPS:
                    names[user_id] = _display_name(_profile(installation, user_id)) or "someone"
                else:
                    return f"@{label or 'someone'}"
            return f"@{names[user_id]}"
        if target.startswith("#"):
            return f"#{label or 'channel'}"
        if target.startswith("!"):
            return f"@{label or target[1:].split('^')[0]}"
        if target.startswith(("http://", "https://", "mailto:")):
            return f"[{label}]({target})" if label and label != target else target
        return label or target

    converted = _SLACK_TOKEN.sub(token, text)
    return converted.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&").strip()


def to_slack(body: str) -> str:
    """Comment Markdown as Slack text: entity encoded so it cannot mention or link, then links put back."""
    escaped = slack_escape(excerpt(body, BODY_LIMIT))
    return _MARKDOWN_LINK.sub(lambda match: f"<{match.group(2)}|{match.group(1)}>", escaped)


def receive(repositories: Repositories, installation: SlackInstallation, event: Mapping[str, Any]) -> int:
    """Carry one Slack thread reply into every issue paired with its thread, answering how many took it.

    A reply from the bot itself is ignored as well as any app's, so the bot's own
    posts of Standupless comments never come back as comments. A reply written
    before the pairing, which a late redelivery could carry, is ignored too.
    """
    if not wanted(event):
        return 0
    slack_user_id = str(event.get("user") or "")
    if installation.bot_user_id and slack_user_id == installation.bot_user_id:
        return 0
    channel_id = str(event.get("channel") or "")
    thread_ts = str(event.get("thread_ts") or "")
    ts = str(event.get("ts") or "")
    workspace_id = installation.workspace_id
    links = repositories.github.slack_threads.links_for_thread(workspace_id, channel_id, thread_ts)
    links = [link for link in links if link.slack_team_id == installation.slack_team_id]
    if not links:
        return 0
    try:
        written = float(ts)
    except ValueError:
        return 0
    links = [link for link in links if written >= link.synced_at.timestamp() - 1]
    if not links:
        return 0
    text = str(event.get("text") or "")
    body = from_slack(text, installation)
    if not body:
        return 0
    author_id = _author(repositories, installation, slack_user_id)
    taken = 0
    for link in links:
        if _receive_one(repositories, link, author_id, body, ts):
            taken += 1
    if taken:
        _log.info("Added a Slack reply to a synced thread.", extra={"event": "integrations.slack.thread_received"})
    return taken


def _receive_one(repositories: Repositories, link: SlackThreadLink, author_id: str, body: str, ts: str) -> bool:
    """Write one Slack reply under one paired root, once."""
    workspace_id = link.workspace_id
    root = repositories.comments.get(workspace_id, link.issue_id, link.root_comment_id)
    if root is None or root.slack_thread is None:
        return False
    issue = repositories.issues.get(workspace_id, link.issue_id)
    if issue is None:
        return False
    comment_id = new_comment_id()
    claim = SlackMessageClaim(
        workspace_id=workspace_id,
        github_key=message_key(link.channel_id, ts, link.issue_id),
        issue_id=link.issue_id,
        comment_id=comment_id,
        channel_id=link.channel_id,
        ts=ts,
        origin="slack",
    )
    if not repositories.github.slack_threads.claim(claim):
        return False
    reply = build_comment(
        workspace_id, link.issue_id, issue.team_id, author_id, body, parent_comment_id=root.comment_id, source=SLACK
    )
    try:
        repositories.comments.create(reply.model_copy(update={"comment_id": comment_id}))
    except ConditionFailed:
        return False
    actor_kind = "system" if author_id.startswith(SLACK_AUTHOR_PREFIX) else "user"
    reopen_on_reply(repositories, root, author_id, actor_kind=actor_kind, source=SLACK)
    wake_on_activity(repositories, issue, author_id)
    return True


def queue_reply(repositories: Repositories, record: Mapping[str, Any]) -> bool:
    """Queue a Slack post for a new reply under a root synced with a Slack thread.

    Read off the `comments` stream. A reply written from Slack is never queued,
    which is the echo guard on this side.
    """
    from app.domains.integrations.issue_sync import _enqueue

    if record.get("eventName") != "INSERT":
        return False
    image = deserialize_image(record, "NewImage")
    if not image:
        return False
    parent_id = str(image.get("parent_comment_id") or "")
    if not parent_id or str(image.get("source") or "") == SLACK:
        return False
    workspace_id = str(image.get("workspace_id", ""))
    issue_id = str(image.get("issue_id", ""))
    parent = repositories.comments.get(workspace_id, issue_id, parent_id)
    if parent is None or parent.slack_thread is None:
        return False
    _enqueue(
        THREAD_COMMENT_JOB,
        {
            "kind": THREAD_COMMENT_JOB,
            "workspace_id": workspace_id,
            "issue_id": issue_id,
            "comment_id": str(image.get("comment_id", "")),
        },
        workspace_id,
    )
    return True


def _author_name(repositories: Repositories, author_id: str) -> str:
    """The name a Slack post gives a comment's author."""
    for prefix, _ in PLACEHOLDER_AUTHORS:
        if author_id.startswith(prefix):
            return author_id.removeprefix(prefix)
    user = repositories.users.get(author_id)
    return (user.display_name or "") if user is not None else ""


def push_reply(repositories: Repositories, job: Mapping[str, Any]) -> None:
    """Post one Standupless reply to the Slack thread its root is synced with.

    A transient refusal releases the claim and raises, so the queue retries the
    job; a lasting one, such as the bot being removed from the channel, drops the
    reply. A reply written before the thread was synced, or once the App left the
    Slack workspace it was synced in, is not posted.
    """
    workspace_id = str(job.get("workspace_id", ""))
    issue_id = str(job.get("issue_id", ""))
    comment = repositories.comments.get(workspace_id, issue_id, str(job.get("comment_id", "")))
    if comment is None or not comment.parent_comment_id or comment.source == SLACK:
        return
    if comment.author_id.startswith(SLACK_AUTHOR_PREFIX):
        return
    root = repositories.comments.get(workspace_id, issue_id, comment.parent_comment_id)
    thread = root.slack_thread if root is not None else None
    if root is None or thread is None or comment.created_at < thread.synced_at:
        return
    link = repositories.github.slack_threads.get_link(workspace_id, thread.channel_id, thread.thread_ts, issue_id)
    if link is None or link.root_comment_id != root.comment_id:
        return
    installation = repositories.github.slack.get(workspace_id)
    if installation is None or installation.slack_team_id != thread.slack_team_id:
        return
    _post(repositories, installation, comment, link)


def _post(repositories: Repositories, installation: SlackInstallation, comment: Comment, link: SlackThreadLink) -> None:
    """Claim one reply's crossing, post it as the bot, and record Slack's `ts` for it."""
    store = repositories.github.slack_threads
    claim = SlackMessageClaim(
        workspace_id=comment.workspace_id,
        github_key=comment_key(comment.issue_id, comment.comment_id),
        issue_id=comment.issue_id,
        comment_id=comment.comment_id,
        channel_id=link.channel_id,
        origin="standupless",
        state="pending",
    )
    if not store.claim(claim, stale_before=utc_now() - PENDING_STALE):
        return
    name = slack_escape(clip(_author_name(repositories, comment.author_id), NAME_LIMIT)) or "Someone"
    text = f"*{name}* commented in Standupless:\n{to_slack(comment.body)}"
    try:
        answer = install.call(
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
            "Dropped a Slack thread reply: the bot token will not open.",
            extra={"event": "integrations.slack.thread_post_dropped"},
        )
        return
    except SlackError as error:
        if error.code in RETRYABLE_ERRORS:
            store.release(claim.workspace_id, claim.github_key)
            raise
        _log.info(
            "Slack refused a synced thread reply.",
            extra={"event": "integrations.slack.thread_post_refused", "reason": error.code},
        )
        return
    store.save_claim(claim.model_copy(update={"state": "linked", "ts": str(answer.get("ts", ""))}))
    _log.info("Posted a reply to a synced Slack thread.", extra={"event": "integrations.slack.thread_posted"})


def forget_workspace(repositories: Repositories, workspace_id: str) -> int:
    """Stop syncing every Slack thread of a workspace, answering how many pairings went.

    The root comments keep their text and replies, and only lose the mark that
    says they are synced, so the discussion stays where it is.
    """
    if not workspace_id:
        return 0
    links = repositories.github.slack_threads.forget_workspace(workspace_id)
    for link in links:
        repositories.comments.clear_slack_thread(workspace_id, link.issue_id, link.root_comment_id)
    return len(links)
