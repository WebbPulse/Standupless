"""Pulse reads and follows in their response shapes, shared by the Pulse routes and the MCP tools.

Held apart from `app.common.pulse` because the update and initiative writers
import that module, and these reads need the initiative rules those writers own.
"""

from __future__ import annotations

from datetime import datetime

from app.common import pulse
from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.planning import PulseFollowRead, PulseItemRead
from app.common.api.schemas.workspaces import display_name_for
from app.common.initiative_writes import load_initiative
from app.common.planning_rules import load_readable_project, unprocessable


def check_scope(scope: str) -> str:
    """A feed scope the caller named, or a 422 naming the ones there are."""
    if scope not in pulse.PULSE_SCOPES:
        raise unprocessable(f"scope must be one of {', '.join(pulse.PULSE_SCOPES)}")
    return scope


def _actor_names(repositories: Repositories, entries: list[pulse.PulseEntry]) -> dict[str, str]:
    """Display names for the people behind a page of entries, read in one batch."""
    ids = sorted({entry.event.actor_id for entry in entries if entry.event.actor_id})
    users = repositories.users.get_many(ids) if ids else {}
    return {user_id: display_name_for(user) for user_id, user in users.items()}


def list_pulse(
    repositories: Repositories,
    context: AuthzContext,
    *,
    scope: str,
    cursor: str | None,
    limit: int | None,
) -> tuple[list[PulseItemRead], str | None]:
    """One page of the caller's Pulse, newest first, and the cursor to the next."""
    viewer = pulse.viewer_for(repositories, context)
    entries, next_cursor = pulse.list_feed(repositories, viewer, scope=check_scope(scope), cursor=cursor, limit=limit)
    names = _actor_names(repositories, entries)
    return (
        [
            PulseItemRead.from_event(
                entry.event,
                project=entry.project,
                initiative=entry.initiative,
                unread=entry.unread,
                actor_name=names.get(entry.event.actor_id or "", ""),
            )
            for entry in entries
        ],
        next_cursor,
    )


def unread_count(repositories: Repositories, context: AuthzContext) -> int:
    """How many of the caller's "for me" entries are unread, up to the cap."""
    return pulse.unread_count(repositories, pulse.viewer_for(repositories, context))


def mark_read(repositories: Repositories, context: AuthzContext) -> datetime:
    """Mark the caller's whole Pulse read as of now."""
    return pulse.mark_read(repositories, pulse.viewer_for(repositories, context))


def project_follow(repositories: Repositories, context: AuthzContext, project_id: str) -> PulseFollowRead:
    """Whether the caller follows one project they may read, and why."""
    project, _ = load_readable_project(repositories, context, project_id)
    state = pulse.project_follow_state(repositories, project, context.user_id)
    return PulseFollowRead(following=state.following, explicit=state.explicit)


def set_project_follow(
    repositories: Repositories, context: AuthzContext, project_id: str, following: bool
) -> PulseFollowRead:
    """Follow or unfollow one project the caller may read."""
    project, _ = load_readable_project(repositories, context, project_id)
    pulse.set_follow(repositories, context.workspace_id, context.user_id, "project", project.project_id, following)
    return PulseFollowRead(following=following, explicit=True)


def initiative_follow(repositories: Repositories, context: AuthzContext, initiative_id: str) -> PulseFollowRead:
    """Whether the caller follows one initiative, and why."""
    initiative = load_initiative(repositories, context, initiative_id)
    state = pulse.initiative_follow_state(repositories, initiative, context.user_id)
    return PulseFollowRead(following=state.following, explicit=state.explicit)


def set_initiative_follow(
    repositories: Repositories, context: AuthzContext, initiative_id: str, following: bool
) -> PulseFollowRead:
    """Follow or unfollow one initiative."""
    initiative = load_initiative(repositories, context, initiative_id)
    pulse.set_follow(
        repositories, context.workspace_id, context.user_id, "initiative", initiative.initiative_id, following
    )
    return PulseFollowRead(following=following, explicit=True)
