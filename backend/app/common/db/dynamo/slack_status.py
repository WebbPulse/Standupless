"""Status posts into the Slack thread an issue came from, in the `github` table.

A team's switch is one row, `slackposts#<team id>`, written only once an admin
touches it; a team without the row has status posts on and private asks off.
The same row carries whether the team takes private asks from Slack DMs and
private channels. Each paired issue that
moved holds one debounce row, `slackstatus#<issue id>`, which a status change
schedules and the delayed job claims, so a burst of changes inside the debounce
window queues one job and that job posts once. The row keeps the signature of
the last post, so a flip that lands back where the thread was last told stays
quiet, and the token of the scheduled job, so a redelivered job posts nothing.

Every row lives in the workspace's own partition, so the workspace purge removes
them with the rest of the partition.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from boto3.dynamodb.conditions import Attr
from pydantic import BaseModel, Field, TypeAdapter
from webbpulse.dynamodb import ConditionFailed, Repository

from app.common.db.dynamo.base import as_item, utc_now

SETTING_PREFIX = "slackposts#"
POST_PREFIX = "slackstatus#"

_DATETIME = TypeAdapter(datetime)


def setting_key(team_id: str) -> str:
    """The sort key of one team's status post switch."""
    return f"{SETTING_PREFIX}{team_id}"


def post_key(issue_id: str) -> str:
    """The sort key of one issue's debounce row."""
    return f"{POST_PREFIX}{issue_id}"


def _stored(value: datetime) -> str:
    """A datetime in the string form `as_item` stores, so a condition compares like with like."""
    return str(_DATETIME.dump_python(value, mode="json"))


class SlackStatusSetting(BaseModel):
    """Whether one team posts status changes into the Slack threads its issues came from, and takes private asks."""

    workspace_id: str
    github_key: str
    team_id: str
    enabled: bool = True
    private_asks: bool = False
    updated_by: str
    updated_at: datetime = Field(default_factory=utc_now)


class SlackStatusPost(BaseModel):
    """One issue's debounce row: the job scheduled for it and what its thread was last told.

    `state` is `scheduled` while a job waits, `pending` while that job posts and
    `done` once it finished. `window_started_at` is when the first change of the
    current burst landed, which bounds the history the job reads.
    """

    workspace_id: str
    github_key: str
    issue_id: str
    team_id: str
    token: str
    state: Literal["scheduled", "pending", "done"] = "scheduled"
    window_started_at: datetime = Field(default_factory=utc_now)
    scheduled_at: datetime = Field(default_factory=utc_now)
    claimed_at: datetime | None = None
    last_signature: str = ""
    posted_links: list[str] = Field(default_factory=list)


class SlackStatusStore:
    """Reads and writes status post switches and debounce rows, every method workspace first."""

    def __init__(self, repository: Repository) -> None:
        """Share the `github` table's package repository."""
        self._repository = repository

    def _key(self, workspace_id: str, github_key: str) -> dict[str, str]:
        """The primary key of one row."""
        return {"workspace_id": workspace_id, "github_key": github_key}

    def get_setting(self, workspace_id: str, team_id: str) -> SlackStatusSetting | None:
        """One team's stored switch, or `None` while it was never changed."""
        if not workspace_id or not team_id:
            return None
        item = self._repository.get(self._key(workspace_id, setting_key(team_id)), consistent=True)
        return SlackStatusSetting.model_validate(dict(item)) if item is not None else None

    def enabled(self, workspace_id: str, team_id: str) -> bool:
        """Whether one team posts status changes, on unless an admin turned it off."""
        setting = self.get_setting(workspace_id, team_id)
        return setting is None or setting.enabled

    def allows_private_asks(self, workspace_id: str, team_id: str) -> bool:
        """Whether one team's Slack request form offers a private ask, off until an admin turns it on."""
        setting = self.get_setting(workspace_id, team_id)
        return setting is not None and setting.private_asks

    def put_setting(self, setting: SlackStatusSetting) -> SlackStatusSetting:
        """Store one team's switch, replacing the one before it."""
        self._repository.put(as_item(setting))
        return setting

    def delete_team(self, workspace_id: str, team_id: str) -> bool:
        """Forget a purged team's switch."""
        if self.get_setting(workspace_id, team_id) is None:
            return False
        self._repository.delete(self._key(workspace_id, setting_key(team_id)))
        return True

    def get_post(self, workspace_id: str, issue_id: str) -> SlackStatusPost | None:
        """One issue's debounce row, or `None`."""
        if not workspace_id or not issue_id:
            return None
        item = self._repository.get(self._key(workspace_id, post_key(issue_id)), consistent=True)
        return SlackStatusPost.model_validate(dict(item)) if item is not None else None

    def schedule(
        self, workspace_id: str, issue_id: str, team_id: str, token: str, *, stale_before: datetime
    ) -> SlackStatusPost | None:
        """Schedule a job for one issue, answering the row, or `None` when one is already waiting.

        A row scheduled before `stale_before` counts as lost and is scheduled again,
        so a job that never ran does not silence the issue for good.
        """
        current = self.get_post(workspace_id, issue_id)
        if current is not None and current.state == "scheduled" and current.scheduled_at >= stale_before:
            return None
        now = utc_now()
        row = SlackStatusPost(
            workspace_id=workspace_id,
            github_key=post_key(issue_id),
            issue_id=issue_id,
            team_id=team_id,
            token=token,
            window_started_at=now,
            scheduled_at=now,
            last_signature=current.last_signature if current is not None else "",
        )
        if current is None:
            condition = Attr("github_key").not_exists()
        else:
            condition = Attr("token").eq(current.token) & (
                Attr("state").ne("scheduled") | Attr("scheduled_at").lt(_stored(stale_before))
            )
        try:
            self._repository.put(as_item(row), condition=condition)
        except ConditionFailed:
            return None
        return row

    def claim(self, row: SlackStatusPost, *, stale_before: datetime) -> SlackStatusPost | None:
        """Take a scheduled row for its job, answering the claimed row, or `None` when it is not this job's.

        A row left `pending` before `stale_before` may be taken again, so a job that
        died half way is retried rather than lost.
        """
        claimed = row.model_copy(update={"state": "pending", "claimed_at": utc_now()})
        condition = Attr("token").eq(row.token) & (
            Attr("state").eq("scheduled") | (Attr("state").eq("pending") & Attr("claimed_at").lt(_stored(stale_before)))
        )
        try:
            self._repository.put(as_item(claimed), condition=condition)
        except ConditionFailed:
            return None
        return claimed

    def settle(self, row: SlackStatusPost) -> bool:
        """Write back the row a job claimed, refusing when a newer change scheduled another job meanwhile."""
        try:
            self._repository.put(as_item(row), condition=Attr("token").eq(row.token) & Attr("state").eq("pending"))
        except ConditionFailed:
            return False
        return True
