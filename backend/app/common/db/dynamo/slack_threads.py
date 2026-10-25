"""Issues paired with the Slack thread they were created from, in the `github` table.

A pairing is one row in the workspace's partition, keyed
`slackthread#<channel>#<thread ts>#<issue id>`, so a Slack reply finds every issue
its thread feeds with one prefix query on the channel and thread. Each message
that crosses, either way, also claims one row before it is written on the other
side: `slackmsg#<channel>#<ts>#<issue id>` for a Slack reply that became a comment,
and `slackcmt#<issue id>#<comment id>` for a comment posted to Slack. The claim is
what keeps a redelivered event or a retried job from crossing twice.

Every row lives in the workspace's own partition, so the workspace purge removes
them with the rest of the partition.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field, TypeAdapter
from webbpulse.dynamodb import ConditionFailed, Repository

from app.common.db.dynamo.base import as_item, utc_now

THREAD_PREFIX = "slackthread#"
MESSAGE_PREFIX = "slackmsg#"
COMMENT_PREFIX = "slackcmt#"
MAX_PAIRINGS = 50

_DATETIME = TypeAdapter(datetime)


def thread_key(channel_id: str, thread_ts: str, issue_id: str) -> str:
    """The sort key of one issue's pairing with one Slack thread."""
    return f"{THREAD_PREFIX}{channel_id}#{thread_ts}#{issue_id}"


def message_key(channel_id: str, ts: str, issue_id: str) -> str:
    """The sort key of the claim on one Slack reply crossing into one issue."""
    return f"{MESSAGE_PREFIX}{channel_id}#{ts}#{issue_id}"


def comment_key(issue_id: str, comment_id: str) -> str:
    """The sort key of the claim on one comment crossing into Slack."""
    return f"{COMMENT_PREFIX}{issue_id}#{comment_id}"


class SlackThreadLink(BaseModel):
    """One issue paired with the Slack thread it was created from."""

    workspace_id: str
    github_key: str
    issue_id: str
    team_id: str
    root_comment_id: str
    slack_team_id: str
    channel_id: str
    thread_ts: str
    synced_by: str
    synced_at: datetime = Field(default_factory=utc_now)


class SlackMessageClaim(BaseModel):
    """The claim on one message crossing between Slack and an issue.

    `state` is `pending` while a comment is being posted to Slack and `linked`
    once Slack answered with the message's `ts`. A Slack reply's claim is linked
    from the start, since the comment is written straight after it.
    """

    workspace_id: str
    github_key: str
    issue_id: str
    comment_id: str
    channel_id: str
    ts: str = ""
    origin: Literal["slack", "standupless"]
    state: Literal["pending", "linked"] = "linked"
    synced_at: datetime = Field(default_factory=utc_now)


class SlackThreadStore:
    """Reads and writes Slack thread pairings and their crossing claims, every method workspace first."""

    def __init__(self, repository: Repository) -> None:
        """Share the `github` table's package repository."""
        self._repository = repository

    def _key(self, workspace_id: str, github_key: str) -> dict[str, str]:
        """The primary key of one row."""
        return {"workspace_id": workspace_id, "github_key": github_key}

    def pair(self, link: SlackThreadLink) -> SlackThreadLink:
        """Store one pairing, replacing an earlier one for the same issue and thread."""
        self._repository.put(as_item(link))
        return link

    def links_for_thread(self, workspace_id: str, channel_id: str, thread_ts: str) -> list[SlackThreadLink]:
        """Every issue paired with one Slack thread."""
        if not workspace_id or not channel_id or not thread_ts:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id)
            & Key("github_key").begins_with(f"{THREAD_PREFIX}{channel_id}#{thread_ts}#"),
            max_items=MAX_PAIRINGS,
            consistent=True,
        )
        return [SlackThreadLink.model_validate(dict(item)) for item in items]

    def get_link(self, workspace_id: str, channel_id: str, thread_ts: str, issue_id: str) -> SlackThreadLink | None:
        """One issue's pairing with one Slack thread, or `None`."""
        item = self._repository.get(
            self._key(workspace_id, thread_key(channel_id, thread_ts, issue_id)), consistent=True
        )
        return SlackThreadLink.model_validate(dict(item)) if item is not None else None

    def list_links(self, workspace_id: str) -> list[SlackThreadLink]:
        """Every pairing the workspace holds, for forgetting them when Slack goes."""
        if not workspace_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("github_key").begins_with(THREAD_PREFIX),
            max_items=10000,
            consistent=True,
        )
        return [SlackThreadLink.model_validate(dict(item)) for item in items]

    def claim(self, row: SlackMessageClaim, *, stale_before: datetime | None = None) -> bool:
        """Write a crossing claim, refusing when one is already there.

        A pending claim older than `stale_before` may be taken over, so a post that
        died half way is retried rather than lost.
        """
        condition = Attr("github_key").not_exists()
        if stale_before is not None:
            stale = str(_DATETIME.dump_python(stale_before, mode="json"))
            condition = condition | (Attr("state").eq("pending") & Attr("synced_at").lt(stale))
        try:
            self._repository.put(as_item(row), condition=condition)
        except ConditionFailed:
            return False
        return True

    def save_claim(self, row: SlackMessageClaim) -> SlackMessageClaim:
        """Replace one crossing claim, stamping when it was written."""
        saved = row.model_copy(update={"synced_at": utc_now()})
        self._repository.put(as_item(saved))
        return saved

    def release(self, workspace_id: str, github_key: str) -> None:
        """Drop one crossing claim, so a failed post can be retried."""
        self._repository.delete(self._key(workspace_id, github_key))

    def forget_workspace(self, workspace_id: str) -> list[SlackThreadLink]:
        """Remove every pairing and claim the workspace holds, answering the pairings removed."""
        links = self.list_links(workspace_id)
        for prefix in (THREAD_PREFIX, MESSAGE_PREFIX, COMMENT_PREFIX):
            items = self._repository.iter_query(
                Key("workspace_id").eq(workspace_id) & Key("github_key").begins_with(prefix),
                max_items=10000,
                consistent=True,
            )
            for item in items:
                self._repository.delete(self._key(workspace_id, str(item["github_key"])))
        return links
