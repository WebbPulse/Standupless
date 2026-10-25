"""Replies and reactions on initiative updates, shared by the planning routes and the MCP tools.

The same thread a project update carries, held under its own key root so the
two never collide. Anyone who may read the initiative replies and reacts, which
excludes guests and hides an initiative on a private team the caller is not in.
A reply's author, a workspace admin or the initiative's owner may edit or delete
it, the people who may edit an initiative update besides its author.
"""

from __future__ import annotations

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.update_threads import (
    ProjectUpdateCommentCreate,
    ProjectUpdateCommentPatch,
    ProjectUpdateCommentRead,
    ProjectUpdateReactionWrite,
)
from app.common.db.dynamo.planning import Initiative
from app.common.discussion_reads import ReactionGroupRead
from app.common.initiative_writes import load_initiative
from app.common.planning_rules import not_found
from app.common.update_thread_rules import (
    ThreadHost,
    edit_comment,
    post_comment,
    react,
    remove_comment,
    thread_comments,
    unreact,
)


def _may_moderate(context: AuthzContext, initiative: Initiative, author_id: str) -> bool:
    """Whether the caller wrote the reply, owns the initiative or administers the workspace."""
    if context.is_workspace_admin:
        return True
    return context.user_id in (author_id, initiative.owner_id)


def _host(repositories: Repositories, context: AuthzContext, initiative_id: str, update_id: str) -> ThreadHost:
    """The thread on one update of a readable initiative, or the initiative's 403 or 404."""
    initiative = load_initiative(repositories, context, initiative_id)
    update = repositories.planning.get_initiative_update(context.workspace_id, initiative.initiative_id, update_id)
    if update is None:
        raise not_found()
    return ThreadHost(
        store=repositories.planning.initiative_update_threads,
        parent_id=initiative.initiative_id,
        update_id=update.update_id,
        may_moderate=lambda author_id: _may_moderate(context, initiative, author_id),
    )


def list_initiative_update_comments(
    repositories: Repositories, context: AuthzContext, initiative_id: str, update_id: str
) -> list[ProjectUpdateCommentRead]:
    """Every reply on one readable initiative update, oldest first."""
    return thread_comments(repositories, context, _host(repositories, context, initiative_id, update_id))


def create_initiative_update_comment(
    repositories: Repositories,
    context: AuthzContext,
    initiative_id: str,
    update_id: str,
    payload: ProjectUpdateCommentCreate,
) -> ProjectUpdateCommentRead:
    """Reply on a readable initiative update; the notify consumer tells its author, the owner and earlier repliers."""
    return post_comment(repositories, context, _host(repositories, context, initiative_id, update_id), payload)


def edit_initiative_update_comment(
    repositories: Repositories,
    context: AuthzContext,
    initiative_id: str,
    update_id: str,
    comment_id: str,
    payload: ProjectUpdateCommentPatch,
) -> ProjectUpdateCommentRead:
    """Rewrite a reply's body, stamping when it was edited."""
    host = _host(repositories, context, initiative_id, update_id)
    return edit_comment(repositories, context, host, comment_id, payload)


def delete_initiative_update_comment(
    repositories: Repositories, context: AuthzContext, initiative_id: str, update_id: str, comment_id: str
) -> None:
    """Delete a reply and every reaction on it."""
    remove_comment(context, _host(repositories, context, initiative_id, update_id), comment_id)


def add_initiative_update_reaction(
    repositories: Repositories,
    context: AuthzContext,
    initiative_id: str,
    update_id: str,
    payload: ProjectUpdateReactionWrite,
) -> ReactionGroupRead:
    """React to a readable initiative update or one of its replies, answering that emoji's group."""
    return react(repositories, context, _host(repositories, context, initiative_id, update_id), payload)


def remove_initiative_update_reaction(
    repositories: Repositories,
    context: AuthzContext,
    initiative_id: str,
    update_id: str,
    emoji: str,
    comment_id: str | None,
) -> None:
    """Take the caller's reaction off an initiative update or one of its replies; a missing one is a no-op."""
    unreact(context, _host(repositories, context, initiative_id, update_id), emoji, comment_id)
