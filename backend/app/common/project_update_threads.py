"""Replies and reactions on project updates, shared by the planning routes and the MCP tools.

Held in `common` because the integrations image may not import another domain's
code, and a reply an agent posts must pass the same rights as a person's. Anyone
who may read the project may reply and react. A reply's author, a workspace admin
or an admin of one of the project's visible teams may edit or delete it, the same
moderators who may edit the update itself.
"""

from __future__ import annotations

from fastapi import HTTPException, status
from webbpulse.dynamodb import ConditionFailed

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.planning import ProjectUpdateRead
from app.common.api.schemas.update_threads import (
    ProjectUpdateCommentCreate,
    ProjectUpdateCommentPatch,
    ProjectUpdateCommentRead,
    ProjectUpdateReactionWrite,
)
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.planning import Project, ProjectUpdateRow
from app.common.db.dynamo.update_threads import (
    UpdateComment,
    UpdateThread,
    build_update_comment,
    build_update_reaction,
)
from app.common.discussion_reads import (
    AuthorRead,
    ReactionGroupRead,
    authors_for,
    group_reactions,
    normalize_emoji,
)
from app.common.mentions import mentioned_user_ids
from app.common.planning_rules import (
    forbidden,
    load_readable_project,
    not_found,
    team_role,
)


def _may_moderate(repositories: Repositories, context: AuthzContext, teams: list[str], author_id: str) -> bool:
    """Whether the caller wrote the row or moderates the project's teams."""
    if author_id == context.user_id or context.is_workspace_admin:
        return True
    return any(team_role(repositories, context, team_id) == "admin" for team_id in teams)


def load_readable_update(
    repositories: Repositories, context: AuthzContext, project_id: str, update_id: str
) -> tuple[Project, list[str], ProjectUpdateRow]:
    """A readable project, its visible teams and one of its updates, or a 404."""
    project, teams = load_readable_project(repositories, context, project_id)
    update = repositories.planning.get_project_update(context.workspace_id, project.project_id, update_id)
    if update is None:
        raise not_found()
    return project, teams, update


def summarise_updates(
    repositories: Repositories, context: AuthzContext, rows: list[ProjectUpdateRead]
) -> list[ProjectUpdateRead]:
    """The feed's updates with each one's reaction groups and reply count filled in."""
    if not rows:
        return rows
    threads = repositories.planning.update_threads.read_many(
        context.workspace_id, rows[0].project_id, [row.update_id for row in rows]
    )
    summarised: list[ProjectUpdateRead] = []
    for row in rows:
        thread = threads.get(row.update_id, UpdateThread())
        summarised.append(
            row.model_copy(
                update={
                    "reactions": group_reactions(thread.reactions_on(row.update_id), context.user_id),
                    "comment_count": len(thread.comments),
                }
            )
        )
    return summarised


def _comment_read(
    repositories: Repositories,
    context: AuthzContext,
    teams: list[str],
    comment: UpdateComment,
    thread: UpdateThread,
    authors: dict[str, AuthorRead],
) -> ProjectUpdateCommentRead:
    """One reply in its response shape, joined to its author and reactions."""
    return ProjectUpdateCommentRead.from_row(
        comment,
        author=authors.get(comment.author_id, AuthorRead(user_id=comment.author_id)),
        reactions=group_reactions(thread.reactions_on(comment.comment_id), context.user_id),
        can_edit=_may_moderate(repositories, context, teams, comment.author_id),
    )


def list_update_comments(
    repositories: Repositories, context: AuthzContext, project_id: str, update_id: str
) -> list[ProjectUpdateCommentRead]:
    """Every reply on one readable update, oldest first."""
    project, teams, update = load_readable_update(repositories, context, project_id, update_id)
    thread = repositories.planning.update_threads.read(context.workspace_id, project.project_id, update.update_id)
    authors = authors_for(repositories, [comment.author_id for comment in thread.comments])
    return [_comment_read(repositories, context, teams, comment, thread, authors) for comment in thread.comments]


def create_update_comment(
    repositories: Repositories,
    context: AuthzContext,
    project_id: str,
    update_id: str,
    payload: ProjectUpdateCommentCreate,
) -> ProjectUpdateCommentRead:
    """Reply on a readable update; the notify consumer tells its author and anyone mentioned."""
    project, teams, update = load_readable_update(repositories, context, project_id, update_id)
    comment = build_update_comment(
        context.workspace_id,
        project.project_id,
        update.update_id,
        body=payload.body,
        author_id=context.user_id,
        mentions=mentioned_user_ids(repositories, context.workspace_id, payload.body),
        source=context.source,
    )
    try:
        repositories.planning.update_threads.create_comment(comment)
    except ConditionFailed as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error_code": "CONFLICT", "message": "That reply already exists"},
        ) from exc
    authors = authors_for(repositories, [comment.author_id])
    return _comment_read(repositories, context, teams, comment, UpdateThread(), authors)


def _load_editable_comment(
    repositories: Repositories, context: AuthzContext, project_id: str, update_id: str, comment_id: str
) -> tuple[list[str], UpdateComment]:
    """One reply the caller may change, with the project's visible teams."""
    project, teams, update = load_readable_update(repositories, context, project_id, update_id)
    comment = repositories.planning.update_threads.get_comment(
        context.workspace_id, project.project_id, update.update_id, comment_id
    )
    if comment is None:
        raise not_found()
    if not _may_moderate(repositories, context, teams, comment.author_id):
        raise forbidden()
    return teams, comment


def edit_update_comment(
    repositories: Repositories,
    context: AuthzContext,
    project_id: str,
    update_id: str,
    comment_id: str,
    payload: ProjectUpdateCommentPatch,
) -> ProjectUpdateCommentRead:
    """Rewrite a reply's body, stamping when it was edited."""
    teams, existing = _load_editable_comment(repositories, context, project_id, update_id, comment_id)
    edited = existing.model_copy(
        update={
            "body": payload.body,
            "mentions": mentioned_user_ids(repositories, context.workspace_id, payload.body),
            "edited_at": utc_now(),
        }
    )
    try:
        repositories.planning.update_threads.replace_comment(edited)
    except ConditionFailed as exc:
        raise not_found() from exc
    thread = repositories.planning.update_threads.read(context.workspace_id, edited.project_id, edited.update_id)
    authors = authors_for(repositories, [edited.author_id])
    return _comment_read(repositories, context, teams, edited, thread, authors)


def delete_update_comment(
    repositories: Repositories, context: AuthzContext, project_id: str, update_id: str, comment_id: str
) -> None:
    """Delete a reply and every reaction on it."""
    _, comment = _load_editable_comment(repositories, context, project_id, update_id, comment_id)
    repositories.planning.update_threads.delete_comment(
        context.workspace_id, comment.project_id, comment.update_id, comment.comment_id
    )


def _reaction_target(
    repositories: Repositories,
    context: AuthzContext,
    project_id: str,
    update_id: str,
    comment_id: str | None,
) -> tuple[ProjectUpdateRow, str]:
    """The readable update and the id of what is reacted to: the update or one of its replies."""
    project, _, update = load_readable_update(repositories, context, project_id, update_id)
    if not comment_id:
        return update, update.update_id
    comment = repositories.planning.update_threads.get_comment(
        context.workspace_id, project.project_id, update.update_id, comment_id
    )
    if comment is None:
        raise not_found()
    return update, comment.comment_id


def add_update_reaction(
    repositories: Repositories,
    context: AuthzContext,
    project_id: str,
    update_id: str,
    payload: ProjectUpdateReactionWrite,
) -> ReactionGroupRead:
    """React to a readable update or one of its replies, answering that emoji's group."""
    update, target_id = _reaction_target(repositories, context, project_id, update_id, payload.comment_id)
    store = repositories.planning.update_threads
    store.add_reaction(
        build_update_reaction(
            context.workspace_id,
            update.project_id,
            update.update_id,
            target_id=target_id,
            emoji=payload.emoji,
            user_id=context.user_id,
        )
    )
    thread = store.read(context.workspace_id, update.project_id, update.update_id)
    groups = [
        group
        for group in group_reactions(thread.reactions_on(target_id), context.user_id)
        if group.emoji == payload.emoji
    ]
    if groups:
        return groups[0]
    return ReactionGroupRead(emoji=payload.emoji, count=1, user_ids=[context.user_id], reacted=True)


def remove_update_reaction(
    repositories: Repositories,
    context: AuthzContext,
    project_id: str,
    update_id: str,
    emoji: str,
    comment_id: str | None,
) -> None:
    """Take the caller's reaction off an update or one of its replies; a missing one is a no-op."""
    update, target_id = _reaction_target(repositories, context, project_id, update_id, comment_id)
    repositories.planning.update_threads.remove_reaction(
        context.workspace_id, update.project_id, update.update_id, target_id, normalize_emoji(emoji), context.user_id
    )
