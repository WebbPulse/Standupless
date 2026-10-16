"""Pulse: the feed of project and initiative updates, health changes and completed milestones.

Held in `common` because the planning routes, the MCP tools, the rollup consumer
and the email digest all read or write it, and none of them may import another
domain's code.

Every event is one row in the workspace's `planning` partition, written by the
path that made the change, so the feed is one descending query. Who may read an
entry is decided as it is read: a project's entry needs one of its teams to be
visible, and an initiative's needs a workspace member other than a guest, which
are the same rules the project and initiative routes apply. An entry whose
project or initiative is gone is skipped.

A person follows a project they lead or are a member of, an initiative they own,
and every project inside an initiative they follow, unless they unfollowed it.
An explicit follow or unfollow is stored and wins over all of that. The "for me"
feed is what they follow, and "recent" is everything they may read.

Unread state is one marker per person: an entry newer than the moment they last
read their Pulse, and not their own, is unread.

The writers are best effort. A Pulse row is a side effect of a change that has
already been stored, so a failure to write it is logged rather than turned into
an error for a change the caller made.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Iterator, Literal, Mapping

from webbpulse.dynamodb import encode_start_key

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.pagination import resume_key
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.planning import (
    PULSE_KEY_PREFIX,
    Initiative,
    InitiativeUpdateRow,
    Project,
    ProjectMilestone,
    ProjectUpdateRow,
    PulseEvent,
    new_planning_id,
    pulse_key,
)
from app.common.planning_rules import visible_team_ids
from app.common.team_privacy import person_can_see_team

PulseScope = Literal["for_me", "recent"]

PULSE_SCOPES: tuple[str, ...] = ("for_me", "recent")

PAGE_SIZE = 100
"""How many events one read of the partition takes."""

SCAN_LIMIT = 1000
"""How many events one feed page reads at most before answering with what it found."""

UNREAD_CAP = 99
"""How far the unread count goes before it reads as 99 or more."""

DEFAULT_LIMIT = 25
"""How many entries a feed page holds when the caller names no limit."""

MAX_LIMIT = 100
"""The most entries one feed page holds."""

_log = logging.getLogger(__name__)


@dataclass(frozen=True)
class PulseViewer:
    """Who is reading a feed: their workspace, their id, the teams they may read and whether they are a guest."""

    workspace_id: str
    user_id: str
    visible_teams: frozenset[str]
    is_guest: bool


@dataclass
class PulseEntry:
    """One feed entry as a reader sees it, with the project or initiative it is about and its unread state."""

    event: PulseEvent
    project: Project | None
    initiative: Initiative | None
    unread: bool


@dataclass
class PulseSubjects:
    """The workspace's projects and initiatives, read once for a feed, with what one person follows."""

    projects: dict[str, Project]
    initiatives: dict[str, Initiative]
    explicit: dict[tuple[str, str], bool] = field(default_factory=dict)


def viewer_for(repositories: Repositories, context: AuthzContext) -> PulseViewer:
    """The reader a request makes, with the teams the request's own authorization may read."""
    return PulseViewer(
        workspace_id=context.workspace_id,
        user_id=context.user_id,
        visible_teams=frozenset(visible_team_ids(repositories, context)),
        is_guest=context.is_guest,
    )


def viewer_for_person(repositories: Repositories, workspace_id: str, user_id: str) -> PulseViewer | None:
    """The reader one workspace member makes outside a request, or `None` when they are not a member."""
    membership = repositories.memberships.get(workspace_id, user_id)
    if membership is None:
        return None
    teams = frozenset(
        team.team_id
        for team in repositories.teams.list_for_workspace(workspace_id)
        if person_can_see_team(repositories, workspace_id, team.team_id, user_id)
    )
    return PulseViewer(
        workspace_id=workspace_id, user_id=user_id, visible_teams=teams, is_guest=membership.role == "guest"
    )


def load_subjects(repositories: Repositories, viewer: PulseViewer) -> PulseSubjects:
    """The workspace's projects and initiatives and the reader's explicit follows."""
    return PulseSubjects(
        projects={row.project_id: row for row in repositories.planning.list_projects(viewer.workspace_id)},
        initiatives={row.initiative_id: row for row in repositories.planning.list_initiatives(viewer.workspace_id)},
        explicit=repositories.planning.list_pulse_follows(viewer.workspace_id, viewer.user_id),
    )


def implicitly_follows_project(project: Project, user_id: str) -> bool:
    """Whether a person follows a project without having chosen to: they lead it or are a member."""
    return project.lead_id == user_id or user_id in project.member_ids


def implicitly_follows_initiative(initiative: Initiative, user_id: str) -> bool:
    """Whether a person follows an initiative without having chosen to: they own it."""
    return initiative.owner_id == user_id


def follows_initiative(subjects: PulseSubjects, initiative: Initiative, user_id: str) -> bool:
    """Whether a person follows one initiative, their own choice first."""
    chosen = subjects.explicit.get(("initiative", initiative.initiative_id))
    if chosen is not None:
        return chosen
    return implicitly_follows_initiative(initiative, user_id)


def follows_project(subjects: PulseSubjects, project: Project, user_id: str) -> bool:
    """Whether a person follows one project: their own choice, else their role on it or its initiative."""
    chosen = subjects.explicit.get(("project", project.project_id))
    if chosen is not None:
        return chosen
    if implicitly_follows_project(project, user_id):
        return True
    parent = subjects.initiatives.get(project.initiative_id or "")
    return parent is not None and follows_initiative(subjects, parent, user_id)


def _resolve(
    event: PulseEvent, viewer: PulseViewer, subjects: PulseSubjects, scope: str
) -> tuple[Project | None, Initiative | None] | None:
    """The project or initiative an event is about when this reader may see it in this scope, else `None`."""
    if event.subject_type == "initiative":
        initiative = subjects.initiatives.get(event.initiative_id or "")
        if initiative is None or viewer.is_guest:
            return None
        if scope == "for_me" and not follows_initiative(subjects, initiative, viewer.user_id):
            return None
        return None, initiative
    project = subjects.projects.get(event.project_id or "")
    if project is None or not any(team_id in viewer.visible_teams for team_id in project.team_ids):
        return None
    if scope == "for_me" and not follows_project(subjects, project, viewer.user_id):
        return None
    initiative = subjects.initiatives.get(project.initiative_id or "") if not viewer.is_guest else None
    return project, initiative


def is_unread(event: PulseEvent, viewer: PulseViewer, read_at: datetime | None) -> bool:
    """Whether an entry is unread: someone else's, and newer than the reader's marker."""
    if event.actor_id and event.actor_id == viewer.user_id:
        return False
    return read_at is None or event.created_at > read_at


def cursor_scope(viewer: PulseViewer, scope: str) -> str:
    """The scope a feed cursor is minted under, so it only resumes the same reader's same feed."""
    return f"pulse:{viewer.workspace_id}:{viewer.user_id}:{scope}"


def _start_key(cursor: str | None, viewer: PulseViewer, scope: str) -> Mapping[str, Any] | None:
    """A decoded cursor, or `None` when it would resume outside this workspace's Pulse."""
    start = resume_key(cursor, cursor_scope(viewer, scope))
    if start is None:
        return None
    if start.get("workspace_id") != viewer.workspace_id:
        return None
    if not str(start.get("planning_key", "")).startswith(PULSE_KEY_PREFIX):
        return None
    return start


def _scan(
    repositories: Repositories, workspace_id: str, start_key: Mapping[str, Any] | None, budget: int
) -> Iterator[PulseEvent]:
    """The workspace's events newest first from `start_key`, reading at most `budget` of them."""
    read = 0
    start = start_key
    while read < budget:
        rows, last_key = repositories.planning.list_pulse_events(
            workspace_id, limit=min(PAGE_SIZE, budget - read), start_key=start
        )
        read += max(len(rows), 1)
        yield from rows
        if not last_key:
            return
        start = last_key


def list_feed(
    repositories: Repositories,
    viewer: PulseViewer,
    *,
    scope: str,
    cursor: str | None = None,
    limit: int | None = None,
) -> tuple[list[PulseEntry], str | None]:
    """One page of a reader's Pulse, newest first, and the cursor to the next.

    The partition is read in pages and filtered to what the reader may see, so a
    page is filled from as many reads as it takes, up to `SCAN_LIMIT` events, and
    the cursor resumes after the last event looked at.
    """
    size = max(1, min(limit or DEFAULT_LIMIT, MAX_LIMIT))
    subjects = load_subjects(repositories, viewer)
    read_at = repositories.planning.get_pulse_read(viewer.workspace_id, viewer.user_id)
    entries: list[PulseEntry] = []
    last: PulseEvent | None = None
    scanned = 0
    exhausted = True
    for event in _scan(repositories, viewer.workspace_id, _start_key(cursor, viewer, scope), SCAN_LIMIT + 1):
        if len(entries) >= size or scanned >= SCAN_LIMIT:
            exhausted = False
            break
        scanned += 1
        last = event
        resolved = _resolve(event, viewer, subjects, scope)
        if resolved is None:
            continue
        project, initiative = resolved
        entries.append(PulseEntry(event, project, initiative, is_unread(event, viewer, read_at)))
    if exhausted or last is None:
        return entries, None
    key = {"workspace_id": viewer.workspace_id, "planning_key": last.planning_key}
    return entries, encode_start_key(key, scope=cursor_scope(viewer, scope))


def entries_between(
    repositories: Repositories, viewer: PulseViewer, *, since: datetime, until: datetime, limit: int
) -> tuple[list[PulseEntry], int]:
    """A reader's "for me" entries posted in `[since, until)`, newest first, and how many there were in all.

    What the email digest reads; their own entries are left out, since a digest
    reports what other people did.
    """
    subjects = load_subjects(repositories, viewer)
    entries: list[PulseEntry] = []
    total = 0
    for event in _scan(repositories, viewer.workspace_id, None, SCAN_LIMIT):
        if event.created_at < since:
            break
        if event.created_at >= until or event.actor_id == viewer.user_id:
            continue
        resolved = _resolve(event, viewer, subjects, "for_me")
        if resolved is None:
            continue
        total += 1
        if len(entries) < limit:
            entries.append(PulseEntry(event, resolved[0], resolved[1], True))
    return entries, total


def unread_count(repositories: Repositories, viewer: PulseViewer) -> int:
    """How many "for me" entries the reader has not read, up to `UNREAD_CAP`."""
    subjects = load_subjects(repositories, viewer)
    read_at = repositories.planning.get_pulse_read(viewer.workspace_id, viewer.user_id)
    count = 0
    for event in _scan(repositories, viewer.workspace_id, None, SCAN_LIMIT):
        if read_at is not None and event.created_at <= read_at:
            break
        if not is_unread(event, viewer, read_at) or _resolve(event, viewer, subjects, "for_me") is None:
            continue
        count += 1
        if count >= UNREAD_CAP:
            break
    return count


def mark_read(repositories: Repositories, viewer: PulseViewer, at: datetime | None = None) -> datetime:
    """Mark everything in the reader's Pulse up to `at`, or now, as read."""
    moment = at or utc_now()
    repositories.planning.set_pulse_read(viewer.workspace_id, viewer.user_id, moment)
    return moment


@dataclass(frozen=True)
class FollowState:
    """Whether a person follows a subject, and whether that is their own choice or follows from their role."""

    following: bool
    explicit: bool


def project_follow_state(repositories: Repositories, project: Project, user_id: str) -> FollowState:
    """Whether a person follows one project, and why."""
    chosen = repositories.planning.get_pulse_follow(project.workspace_id, user_id, "project", project.project_id)
    if chosen is not None:
        return FollowState(following=chosen, explicit=True)
    if implicitly_follows_project(project, user_id):
        return FollowState(following=True, explicit=False)
    if project.initiative_id:
        initiative = repositories.planning.get_initiative(project.workspace_id, project.initiative_id)
        if initiative is not None:
            return FollowState(
                following=initiative_follow_state(repositories, initiative, user_id).following, explicit=False
            )
    return FollowState(following=False, explicit=False)


def initiative_follow_state(repositories: Repositories, initiative: Initiative, user_id: str) -> FollowState:
    """Whether a person follows one initiative, and why."""
    chosen = repositories.planning.get_pulse_follow(
        initiative.workspace_id, user_id, "initiative", initiative.initiative_id
    )
    if chosen is not None:
        return FollowState(following=chosen, explicit=True)
    return FollowState(following=implicitly_follows_initiative(initiative, user_id), explicit=False)


def set_follow(
    repositories: Repositories, workspace_id: str, user_id: str, subject_type: str, subject_id: str, following: bool
) -> None:
    """Record a person's own choice to follow or unfollow a project or initiative."""
    repositories.planning.set_pulse_follow(workspace_id, user_id, subject_type, subject_id, following=following)


def _write(repositories: Repositories, event: PulseEvent) -> None:
    """Store one event, logging rather than raising when the write fails."""
    try:
        repositories.planning.create_pulse_event(event)
    except Exception:
        _log.exception(
            "A Pulse event failed to write.",
            extra={"event": "planning.pulse.write_failed", "workspace_id": event.workspace_id},
        )


def record_project_update(repositories: Repositories, update: ProjectUpdateRow, previous_health: str | None) -> None:
    """Post a new project update to Pulse, keyed by the update's own id."""
    _write(
        repositories,
        PulseEvent(
            workspace_id=update.workspace_id,
            planning_key=pulse_key(update.update_id),
            event_id=update.update_id,
            event_type="project_update",
            subject_type="project",
            project_id=update.project_id,
            update_id=update.update_id,
            body=update.body,
            health=update.health,
            previous_health=previous_health,
            actor_id=update.author_id,
            source=update.source,
            created_at=update.created_at,
        ),
    )


def record_initiative_update(
    repositories: Repositories, update: InitiativeUpdateRow, previous_health: str | None
) -> None:
    """Post a new initiative update to Pulse, keyed by the update's own id."""
    _write(
        repositories,
        PulseEvent(
            workspace_id=update.workspace_id,
            planning_key=pulse_key(update.update_id),
            event_id=update.update_id,
            event_type="initiative_update",
            subject_type="initiative",
            initiative_id=update.initiative_id,
            update_id=update.update_id,
            body=update.body,
            health=update.health,
            previous_health=previous_health,
            actor_id=update.author_id,
            source=update.source,
            created_at=update.created_at,
        ),
    )


def revise_update(
    repositories: Repositories, workspace_id: str, update_id: str, *, body: str, health: str, edited_at: datetime
) -> None:
    """Carry an edited update onto its Pulse entry, when it has one."""
    try:
        repositories.planning.revise_pulse_event(workspace_id, update_id, body=body, health=health, edited_at=edited_at)
    except Exception:
        _log.exception(
            "A Pulse event failed to update.",
            extra={"event": "planning.pulse.write_failed", "workspace_id": workspace_id},
        )


def remove_update(repositories: Repositories, workspace_id: str, update_id: str) -> None:
    """Take a deleted update's entry out of Pulse."""
    try:
        repositories.planning.delete(workspace_id, pulse_key(update_id))
    except Exception:
        _log.exception(
            "A Pulse event failed to delete.",
            extra={"event": "planning.pulse.write_failed", "workspace_id": workspace_id},
        )


def record_health_change(
    repositories: Repositories,
    context: AuthzContext,
    *,
    subject_type: str,
    subject_id: str,
    health: str | None,
    previous_health: str | None,
) -> None:
    """Post a health set by hand on a project or initiative, when it moved to a reported health."""
    if health is None or health == previous_health:
        return
    event_id = new_planning_id()
    _write(
        repositories,
        PulseEvent(
            workspace_id=context.workspace_id,
            planning_key=pulse_key(event_id),
            event_id=event_id,
            event_type=f"{subject_type}_health",
            subject_type=subject_type,
            project_id=subject_id if subject_type == "project" else None,
            initiative_id=subject_id if subject_type == "initiative" else None,
            health=health,
            previous_health=previous_health,
            actor_id=context.user_id,
            source=context.source,
        ),
    )


def record_milestone_completed(repositories: Repositories, milestone: ProjectMilestone) -> None:
    """Post a milestone whose last open issue closed, once until it is reopened."""
    event_id = new_planning_id()
    _write(
        repositories,
        PulseEvent(
            workspace_id=milestone.workspace_id,
            planning_key=pulse_key(event_id),
            event_id=event_id,
            event_type="milestone_completed",
            subject_type="project",
            project_id=milestone.project_id,
            milestone_id=milestone.milestone_id,
            milestone_name=milestone.name,
        ),
    )
