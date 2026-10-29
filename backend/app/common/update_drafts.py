"""Status update drafts: one unposted update per member per project and per initiative.

The status update counterpart of `comment_drafts`, held in `common` for the same
reason: the drafts routes in the views image and the MCP tools in the
integrations image both run it. A draft is its author's alone, keyed by the
caller, and sits in the `views` table, which has no stream, so saving one never
notifies anyone.

Each kind of target is one entry in `_TARGETS`, saying how to load it for a
read and for a post and what to call it, so drafting a further kind of update
is one more entry rather than another drafts system. Posting an update clears
the draft it came from, whichever client posted it.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Callable, Optional

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.drafts import UpdateDraftRead, UpdateDraftWrite
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.views import UpdateDraft, UpdateDraftTarget, update_draft_key
from app.common.initiative_writes import load_initiative
from app.common.issue_rules import not_found
from app.common.planning_rules import (
    can_see_initiative,
    load_readable_project,
    require_project_editor,
    visible_project_teams,
    visible_team_ids,
)


@dataclass(frozen=True)
class _Target:
    """How one kind of draft target is read, held to posting rights, and named.

    `readable` answers the target's id and name or raises its 404, `postable`
    does the same but also holds the caller to what posting an update there
    needs, and `visible` reports quietly whether a listing may show a draft on
    that target, with `None` when the target is gone.
    """

    readable: Callable[[Repositories, AuthzContext, str], tuple[str, str]]
    postable: Callable[[Repositories, AuthzContext, str], tuple[str, str]]
    visible: Callable[[Repositories, AuthzContext, str, set[str]], Optional[tuple[bool, str]]]


def _project_readable(repositories: Repositories, context: AuthzContext, project_id: str) -> tuple[str, str]:
    """A project the caller can read, as its id and name."""
    project, _ = load_readable_project(repositories, context, project_id)
    return project.project_id, project.name


def _project_postable(repositories: Repositories, context: AuthzContext, project_id: str) -> tuple[str, str]:
    """A project the caller may post an update on, as its id and name."""
    project, teams = load_readable_project(repositories, context, project_id)
    require_project_editor(repositories, context, teams)
    return project.project_id, project.name


def _project_visible(
    repositories: Repositories, context: AuthzContext, project_id: str, teams: set[str]
) -> Optional[tuple[bool, str]]:
    """Whether a listing shows a draft on a project, with its name, or `None` once it is gone."""
    project = repositories.planning.get_project(context.workspace_id, project_id)
    if project is None:
        return None
    return bool(visible_project_teams(project, teams)), project.name


def _initiative_readable(repositories: Repositories, context: AuthzContext, initiative_id: str) -> tuple[str, str]:
    """An initiative the caller can see, as its id and name."""
    initiative = load_initiative(repositories, context, initiative_id)
    return initiative.initiative_id, initiative.name


def _initiative_visible(
    repositories: Repositories, context: AuthzContext, initiative_id: str, teams: set[str]
) -> Optional[tuple[bool, str]]:
    """Whether a listing shows a draft on an initiative, with its name, or `None` once it is gone."""
    initiative = repositories.planning.get_initiative(context.workspace_id, initiative_id)
    if initiative is None:
        return None
    return (not context.is_guest and can_see_initiative(context, initiative)), initiative.name


_TARGETS: dict[str, _Target] = {
    "project": _Target(readable=_project_readable, postable=_project_postable, visible=_project_visible),
    "initiative": _Target(readable=_initiative_readable, postable=_initiative_readable, visible=_initiative_visible),
}


def save_update_draft(
    repositories: Repositories,
    context: AuthzContext,
    target_kind: UpdateDraftTarget,
    target_id: str,
    payload: UpdateDraftWrite,
) -> UpdateDraftRead:
    """Save the caller's status update draft on a project or initiative, replacing the one there.

    Held to what posting the update would need, so a draft can always be posted.
    """
    resolved_id, name = _TARGETS[target_kind].postable(repositories, context, target_id)
    existing = repositories.views.get_update_draft(context.workspace_id, context.user_id, target_kind, resolved_id)
    now = utc_now()
    row = UpdateDraft(
        workspace_id=context.workspace_id,
        view_key=update_draft_key(context.user_id, target_kind, resolved_id),
        user_id=context.user_id,
        target_kind=target_kind,
        target_id=resolved_id,
        body=payload.body,
        health=payload.health,
        created_at=existing.created_at if existing is not None else now,
        updated_at=now,
    )
    repositories.views.put_update_draft(row)
    return UpdateDraftRead.from_row(row, target_name=name)


def get_update_draft(
    repositories: Repositories, context: AuthzContext, target_kind: UpdateDraftTarget, target_id: str
) -> UpdateDraftRead:
    """The caller's status update draft on a project or initiative, or a 404 when there is none."""
    resolved_id, name = _TARGETS[target_kind].readable(repositories, context, target_id)
    row = repositories.views.get_update_draft(context.workspace_id, context.user_id, target_kind, resolved_id)
    if row is None:
        raise not_found()
    return UpdateDraftRead.from_row(row, target_name=name)


def find_update_draft(
    repositories: Repositories, context: AuthzContext, target_kind: UpdateDraftTarget, target_id: str
) -> Optional[UpdateDraftRead]:
    """The caller's status update draft on a target they can read, or `None` when there is none."""
    resolved_id, name = _TARGETS[target_kind].readable(repositories, context, target_id)
    row = repositories.views.get_update_draft(context.workspace_id, context.user_id, target_kind, resolved_id)
    return UpdateDraftRead.from_row(row, target_name=name) if row is not None else None


def list_update_drafts(repositories: Repositories, context: AuthzContext) -> list[UpdateDraftRead]:
    """The caller's status update drafts across the workspace, newest saved first.

    A draft on a target the caller can no longer see drops out of the listing
    and is kept, so regaining access brings it back. A draft on a target that is
    gone is deleted on the way past.
    """
    rows = repositories.views.list_update_drafts(context.workspace_id, context.user_id)
    if not rows:
        return []
    teams = set(visible_team_ids(repositories, context))
    answer: list[UpdateDraftRead] = []
    for row in rows:
        seen = _TARGETS[row.target_kind].visible(repositories, context, row.target_id, teams)
        if seen is None:
            repositories.views.delete_update_draft(
                context.workspace_id, context.user_id, row.target_kind, row.target_id
            )
            continue
        shown, name = seen
        if shown:
            answer.append(UpdateDraftRead.from_row(row, target_name=name))
    return answer


def delete_update_draft(
    repositories: Repositories, context: AuthzContext, target_kind: UpdateDraftTarget, target_id: str
) -> None:
    """Discard the caller's status update draft on one target, a no-op when there is none.

    The target is never read, so a draft on a project or initiative since
    deleted or hidden can still be cleared.
    """
    repositories.views.delete_update_draft(context.workspace_id, context.user_id, target_kind, target_id)


def clear_posted_update_draft(
    repositories: Repositories,
    workspace_id: str,
    author_id: str,
    target_kind: UpdateDraftTarget,
    target_id: str,
    posted_at: datetime,
) -> bool:
    """Clear the draft a posted update came from, keeping one saved after it was posted."""
    return repositories.views.clear_update_draft_before(workspace_id, author_id, target_kind, target_id, posted_at)
