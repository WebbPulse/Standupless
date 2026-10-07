"""Turning issue, comment and project update writes into channel notifications.

The stream consumer hands every issue, comment and planning record here as well as
to the outbound webhooks. A record becomes an ordered list of candidate events, the
most specific first, and each destination of the record's team gets the first one it
subscribes to, so moving an issue to Done posts one "completed" message to a channel
that wants both completions and status changes, not two.

A workspace's destinations are remembered for a few seconds per process, as the
webhook endpoints are, so a workspace with no channels costs one Query per batch.
Nothing is sent for a workspace being deleted or a team being deleted.

`project_update_due` is in the filter so a destination can opt in today. The
reminder job that decides an update is due calls `announce_project_update_due`.
"""

from __future__ import annotations

import time
import uuid
from datetime import datetime
from typing import Any, Callable, Mapping

from webbpulse.events import deserialize_image

from app.common.api.dependencies.repositories import Repositories
from app.common.core.config import settings
from app.common.db.dynamo.channels import ChannelDestination
from app.common.db.dynamo.planning import PROJECT_UPDATE
from app.common.issue_keys import display_key
from app.domains.integrations.channels.delivery import Enqueue, schedule
from app.domains.integrations.channels.messages import HEALTH_COLORS, ChannelMessage, excerpt
from app.domains.integrations.outbound.delivery import epoch_to_datetime
from app.domains.integrations.outbound.payloads import Links

CACHE_SECONDS = 5.0
"""How long one process reuses a workspace's destination list, the length of a stream batching window."""

CACHE_SIZE = 1024

HEALTH_NAMES = {"on_track": "On track", "at_risk": "At risk", "off_track": "Off track"}

type Candidate = tuple[str, ChannelMessage]


class DestinationCache:
    """A short lived, per process memory of each workspace's channel destinations."""

    def __init__(self, *, ttl: float = CACHE_SECONDS, clock: Callable[[], float] = time.monotonic) -> None:
        """Start empty, with an injectable clock for tests."""
        self._ttl = ttl
        self._clock = clock
        self._entries: dict[str, tuple[float, list[ChannelDestination]]] = {}

    def destinations(self, repositories: Repositories, workspace_id: str) -> list[ChannelDestination]:
        """The workspace's destinations, read at most once per `ttl`."""
        now = self._clock()
        cached = self._entries.get(workspace_id)
        if cached is not None and now - cached[0] < self._ttl:
            return cached[1]
        rows = repositories.github.channels.list(workspace_id, consistent=False)
        if len(self._entries) >= CACHE_SIZE:
            self._entries.clear()
        self._entries[workspace_id] = (now, rows)
        return rows


def _rows(repositories: Repositories, workspace_id: str, cache: DestinationCache | None) -> list[ChannelDestination]:
    """The workspace's destinations, through the consumer's cache when it has one."""
    if cache is not None:
        return cache.destinations(repositories, workspace_id)
    return repositories.github.channels.list(workspace_id)


def _enabled(
    repositories: Repositories, workspace_id: str, team_ids: tuple[str, ...], cache: DestinationCache | None
) -> list[ChannelDestination]:
    """The enabled destinations of these teams, checked before any record is described."""
    if not workspace_id or not team_ids or not settings.WEBHOOK_DISPATCH_QUEUE_URL:
        return []
    rows = _rows(repositories, workspace_id, cache)
    return [row for row in rows if row.enabled and row.team_id in team_ids and row.events]


def _live(repositories: Repositories, workspace_id: str, team_ids: tuple[str, ...]) -> tuple[str, ...]:
    """The teams that are not being deleted, none at all for a workspace on its way out."""
    workspace = repositories.workspaces.get(workspace_id)
    if workspace is None or workspace.deletion_scheduled_at is not None or workspace.purging_at is not None:
        return ()
    return tuple(team_id for team_id in team_ids if not repositories.teams.is_deleting(workspace_id, team_id))


def _actor(repositories: Repositories, user_id: Any) -> str:
    """A person's display name, or a neutral word for an automation or a deleted user."""
    user = repositories.users.get(str(user_id)) if user_id else None
    return (user.display_name if user is not None else "") or "Someone"


def _key(repositories: Repositories, workspace_id: str, team_id: str, stored: str) -> str:
    """An issue's key under its team's current prefix."""
    return display_key(repositories.teams, workspace_id, team_id, stored)


def _status(repositories: Repositories, workspace_id: str, team_id: str, status_id: Any) -> tuple[str, str]:
    """A status's name and category, or empty strings when it is gone."""
    status = repositories.team_config.get_status(workspace_id, team_id, str(status_id or ""))
    return (status.name, status.category) if status is not None else ("", "")


def issue_candidates(
    repositories: Repositories, event_name: str, new: Mapping[str, Any], old: Mapping[str, Any]
) -> list[Candidate]:
    """What one issue write could announce, most specific first."""
    if event_name not in ("INSERT", "MODIFY") or not new or new.get("archived_at"):
        return []
    workspace_id = str(new.get("workspace_id", ""))
    team_id = str(new.get("team_id", ""))
    key = _key(repositories, workspace_id, team_id, str(new.get("key", "")))
    title = str(new.get("title", ""))
    url = Links(repositories, workspace_id).issue(key)
    created = event_name == "INSERT"
    actor = _actor(repositories, new.get("created_by") if created else new.get("updated_by") or new.get("created_by"))
    assignee = new.get("assignee_id")

    def message(event: str, summary: str, fields: tuple[tuple[str, str], ...] = ()) -> Candidate:
        """One candidate for this issue."""
        return event, ChannelMessage(
            event=event, subject=title, url=url, summary=summary, actor=actor, key=key, fields=fields
        )

    candidates: list[Candidate] = []
    status_name, category = _status(repositories, workspace_id, team_id, new.get("status_id"))
    if created:
        fields = (("Status", status_name),) if status_name else ()
        candidates.append(message("issue_created", f"{actor} created this issue.", fields))
        if assignee:
            name = _actor(repositories, assignee)
            candidates.append(message("issue_assigned", f"{actor} assigned this issue to {name}."))
        return candidates

    if old.get("status_id") != new.get("status_id"):
        before, _ = _status(repositories, workspace_id, team_id, old.get("status_id"))
        moved = f"{before or 'Unknown'} to {status_name or 'Unknown'}"
        if category == "completed":
            candidates.append(message("issue_completed", f"{actor} completed this issue.", (("Status", moved),)))
        candidates.append(message("issue_status_changed", f"{actor} moved this issue.", (("Status", moved),)))
    if assignee and old.get("assignee_id") != assignee:
        name = _actor(repositories, assignee)
        candidates.append(message("issue_assigned", f"{actor} assigned this issue to {name}."))
    return candidates


def comment_candidates(repositories: Repositories, event_name: str, new: Mapping[str, Any]) -> list[Candidate]:
    """What a new comment announces: the comment, under its issue's key and title."""
    if event_name != "INSERT" or not new:
        return []
    workspace_id = str(new.get("workspace_id", ""))
    issue = repositories.issues.get(workspace_id, str(new.get("issue_id", "")))
    if issue is None or issue.archived_at is not None:
        return []
    key = _key(repositories, workspace_id, issue.team_id, issue.key)
    actor = _actor(repositories, new.get("author_id"))
    return [
        (
            "comment_created",
            ChannelMessage(
                event="comment_created",
                subject=issue.title,
                url=Links(repositories, workspace_id).issue(key),
                summary=f"{actor} commented.",
                actor=actor,
                key=key,
                detail=excerpt(str(new.get("body", ""))),
            ),
        )
    ]


def project_update_candidates(
    repositories: Repositories, workspace_id: str, new: Mapping[str, Any]
) -> tuple[list[Candidate], tuple[str, ...]]:
    """What a new project update announces, with the teams of its project."""
    project = repositories.planning.get_project(workspace_id, str(new.get("project_id", "")))
    if project is None:
        return [], ()
    health = str(new.get("health", ""))
    actor = _actor(repositories, new.get("author_id"))
    message = ChannelMessage(
        event="project_update_posted",
        subject=project.name,
        url=Links(repositories, workspace_id).project_update(project.project_id, str(new.get("update_id", ""))),
        summary=f"{actor} posted a project update.",
        actor=actor,
        detail=excerpt(str(new.get("body", ""))),
        color=HEALTH_COLORS.get(health),
        fields=(("Health", HEALTH_NAMES.get(health, health)),) if health else (),
    )
    return [("project_update_posted", message)], tuple(project.team_ids)


def deliver(
    repositories: Repositories,
    workspace_id: str,
    team_ids: tuple[str, ...],
    candidates: list[Candidate],
    *,
    seed: str,
    at: datetime | None = None,
    destinations: list[ChannelDestination] | None = None,
    send: Enqueue | None = None,
) -> int:
    """Schedule each destination's first wanted candidate, returning how many were scheduled."""
    if not candidates:
        return 0
    live = _live(repositories, workspace_id, team_ids)
    events = tuple(event for event, _ in candidates)
    messages = dict(reversed(candidates))
    scheduled = 0
    for destination in destinations if destinations is not None else []:
        if destination.team_id not in live:
            continue
        wanted = destination.wants(events)
        if wanted is not None and schedule(
            repositories, destination, wanted, messages[wanted], seed=seed, at=at, send=send
        ):
            scheduled += 1
    return scheduled


def _stamp(record: Mapping[str, Any]) -> tuple[str, datetime | None]:
    """The stream record's id and creation time, which make a redelivered record idempotent."""
    stream = record.get("dynamodb")
    created = stream.get("ApproximateCreationDateTime") if isinstance(stream, Mapping) else None
    at = epoch_to_datetime(float(created)) if isinstance(created, (int, float, str)) and created else None
    return str(record.get("eventID") or uuid.uuid4().hex), at


def on_issue(repositories: Repositories, record: Mapping[str, Any], cache: DestinationCache | None = None) -> int:
    """Announce one issue write to the channels of its team."""
    new = deserialize_image(record, "NewImage") or {}
    workspace_id = str(new.get("workspace_id", ""))
    teams = (str(new.get("team_id", "")),)
    destinations = _enabled(repositories, workspace_id, teams, cache)
    if not destinations:
        return 0
    old = deserialize_image(record, "OldImage") or {}
    candidates = issue_candidates(repositories, str(record.get("eventName", "")), new, old)
    seed, at = _stamp(record)
    return deliver(repositories, workspace_id, teams, candidates, seed=seed, at=at, destinations=destinations)


def on_comment(repositories: Repositories, record: Mapping[str, Any], cache: DestinationCache | None = None) -> int:
    """Announce one new comment to the channels of its issue's team."""
    new = deserialize_image(record, "NewImage") or {}
    workspace_id = str(new.get("workspace_id", ""))
    teams = (str(new.get("team_id", "")),)
    destinations = _enabled(repositories, workspace_id, teams, cache)
    if not destinations:
        return 0
    candidates = comment_candidates(repositories, str(record.get("eventName", "")), new)
    seed, at = _stamp(record)
    return deliver(repositories, workspace_id, teams, candidates, seed=seed, at=at, destinations=destinations)


def on_planning(repositories: Repositories, record: Mapping[str, Any], cache: DestinationCache | None = None) -> int:
    """Announce a newly posted project update to the channels of its project's teams."""
    if record.get("eventName") != "INSERT":
        return 0
    new = deserialize_image(record, "NewImage") or {}
    if str(new.get("kind", "")) != PROJECT_UPDATE:
        return 0
    workspace_id = str(new.get("workspace_id", ""))
    if not workspace_id or not settings.WEBHOOK_DISPATCH_QUEUE_URL:
        return 0
    rows = _rows(repositories, workspace_id, cache)
    if not any(row.enabled and "project_update_posted" in row.events for row in rows):
        return 0
    candidates, teams = project_update_candidates(repositories, workspace_id, new)
    destinations = [row for row in rows if row.enabled and row.team_id in teams]
    seed, at = _stamp(record)
    return deliver(repositories, workspace_id, teams, candidates, seed=seed, at=at, destinations=destinations)


def announce_project_update_due(
    repositories: Repositories,
    workspace_id: str,
    project_id: str,
    *,
    seed: str,
    due_at: datetime,
    send: Enqueue | None = None,
) -> int:
    """Post that a project's update is due to the channels of its teams that want it.

    For the reminder job to call once per project and due date; `seed` and `due_at`
    name that pair, so a reminder that runs twice lands on the same delivery rows.
    """
    project = repositories.planning.get_project(workspace_id, project_id)
    if project is None:
        return 0
    teams = tuple(project.team_ids)
    destinations = _enabled(repositories, workspace_id, teams, None)
    if not destinations:
        return 0
    message = ChannelMessage(
        event="project_update_due",
        subject=project.name,
        url=f"{Links(repositories, workspace_id).project(project_id)}?tab=updates",
        summary="A project update is due.",
        at=due_at,
    )
    return deliver(
        repositories,
        workspace_id,
        teams,
        [("project_update_due", message)],
        seed=seed,
        at=due_at,
        destinations=destinations,
        send=send,
    )
