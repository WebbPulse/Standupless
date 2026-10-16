"""Finding an issue by its key, the teams a person may write, and a title from a message.

The commands of both chat Apps answer "show ABC-12" and "create an issue from
this", so the lookups, the facts an issue card shows and the rules for what is
offered, including the team a channel already posts for, live here once.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.issues import TITLE_MAX
from app.common.db.dynamo.issues import Issue
from app.common.issue_keys import display_key
from app.common.issue_move import find_issue_by_number
from app.common.issue_rules import team_role
from app.domains.integrations.outbound.payloads import Links

ISSUE_KEY = re.compile(r"^([A-Za-z][A-Za-z0-9]{0,9})-(\d{1,9})$")

MAX_TEAM_OPTIONS = 100

PRIORITY_NAMES: dict[str, str] = {
    "urgent": "Urgent",
    "high": "High",
    "medium": "Medium",
    "low": "Low",
    "none": "No priority",
}


def split_key(key: str) -> tuple[str, int] | None:
    """The prefix and number of an issue key such as `ABC-12`, or `None`."""
    match = ISSUE_KEY.match(key.strip())
    if match is None:
        return None
    return match.group(1).upper(), int(match.group(2))


def issue_by_key(repositories: Repositories, workspace_id: str, key: str) -> Issue | None:
    """The live issue a key names in one workspace, following a move, or `None`."""
    parts = split_key(key)
    if parts is None:
        return None
    team = repositories.teams.get_by_key_prefix(workspace_id, parts[0])
    if team is None:
        return None
    issue = find_issue_by_number(repositories, workspace_id, team.team_id, parts[1])
    if issue is None or issue.archived_at is not None:
        return None
    return issue


@dataclass(frozen=True)
class IssueSummary:
    """What an issue card in a chat says: the key, the link, the title, and its team, status, priority and assignee."""

    key: str
    url: str
    title: str
    team: str
    status: str
    priority: str
    assignee: str

    @property
    def details(self) -> tuple[str, ...]:
        """The facts a one line card shows, leaving out an unset priority."""
        priority = self.priority if self.priority != PRIORITY_NAMES["none"] else ""
        return tuple(part for part in (self.team, self.status, priority, self.assignee) if part)

    @property
    def fields(self) -> tuple[tuple[str, str], ...]:
        """The labelled facts a card with fields shows, each always present."""
        return (
            ("Status", self.status or "Unknown"),
            ("Priority", self.priority),
            ("Assignee", self.assignee),
            ("Team", self.team or "Unknown"),
        )


def summarize(repositories: Repositories, issue: Issue) -> IssueSummary:
    """The plain facts an issue card shows, each App escaping them its own way."""
    workspace_id = issue.workspace_id
    key = display_key(repositories.teams, workspace_id, issue.team_id, issue.key)
    url = Links(repositories, workspace_id).issue(key)
    team = repositories.teams.get(workspace_id, issue.team_id)
    status = repositories.team_config.get_status(workspace_id, issue.team_id, issue.status_id)
    assignee = "Unassigned"
    if issue.assignee_id:
        person = repositories.users.get(issue.assignee_id)
        assignee = person.display_name if person is not None and person.display_name else "Assigned"
    return IssueSummary(
        key=key,
        url=url,
        title=issue.title,
        team=team.name if team is not None else "",
        status=status.name if status is not None else "",
        priority=PRIORITY_NAMES.get(issue.priority, PRIORITY_NAMES["none"]),
        assignee=assignee,
    )


def writable_teams(repositories: Repositories, context: AuthzContext) -> list[tuple[str, str, str]]:
    """The teams this person may create issues in, as `(team id, name, key prefix)` triples."""
    teams = repositories.teams.list_for_workspace(context.workspace_id)
    offered: list[tuple[str, str, str]] = []
    for team in teams:
        if not context.can_see_team(team.team_id):
            continue
        if team_role(repositories, context, team.team_id) is None:
            continue
        offered.append((team.team_id, team.name, team.key_prefix))
    return offered[:MAX_TEAM_OPTIONS]


def channel_team(
    repositories: Repositories,
    context: AuthzContext,
    *,
    slack_channel_ids: tuple[str, ...] = (),
    discord_channel_ids: tuple[str, ...] = (),
) -> str:
    """The team a chat channel posts notifications for, when this person may create issues in it, or `""`.

    A channel is connected to a team by a destination that posts through the
    installed App, so a command run there most likely means that team. The oldest
    such destination whose team the person can write wins, and a channel no
    writable team posts to answers `""` so the caller falls back to asking.
    """
    slack_ids = {channel for channel in slack_channel_ids if channel}
    discord_ids = {channel for channel in discord_channel_ids if channel}
    if not slack_ids and not discord_ids:
        return ""
    writable = {team_id for team_id, _, _ in writable_teams(repositories, context)}
    for destination in repositories.github.channels.list(context.workspace_id):
        if destination.team_id not in writable:
            continue
        if destination.transport == "slack_app" and destination.slack_channel_id in slack_ids:
            return destination.team_id
        if destination.transport == "discord_app" and destination.discord_channel_id in discord_ids:
            return destination.team_id
    return ""


def title_from(text: str) -> str:
    """A title from a message: its first non empty line, cut to the title limit."""
    for line in text.splitlines():
        stripped = " ".join(line.split())
        if stripped:
            return stripped[:TITLE_MAX]
    return ""
