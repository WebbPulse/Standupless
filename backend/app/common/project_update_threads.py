"""Replies and reactions on project updates, shared by the planning routes and the MCP tools.

Held in `common` because the integrations image may not import another domain's
code, and a reply an agent posts must pass the same rights as a person's. Anyone
who may read the project may reply and react. A reply's author, a workspace admin
or an admin of one of the project's visible teams may edit or delete it, the same
moderators who may edit the update itself. The thread mechanics live in
`update_thread_rules`, which initiative updates share.
"""

from __future__ import annotations

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.planning import ProjectUpdateRead
from app.common.api.schemas.update_threads import (
    ProjectUpdateCommentCreate,
    ProjectUpdateCommentPatch,
    ProjectUpdateCommentRead,
    ProjectUpdateReactionWrite,
)
from app.common.db.dynamo.planning import Project, ProjectUpdateRow
from app.common.discussion_reads import ReactionGroupRead
from app.common.planning_rules import load_readable_project, not_found, team_role
from app.common.update_thread_rules import (
    ThreadHost,
    edit_comment,
    post_comment,
    react,
    remove_comment,
    summarise_threads,
    thread_comments,
    unreact,
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


def _host(repositories: Repositories, context: AuthzContext, project_id: str, update_id: str) -> ThreadHost:
    """The thread on one readable project update, moderated by the project's team admins."""
    project, teams, update = load_readable_update(repositories, context, project_id, update_id)
    return ThreadHost(
        store=repositories.planning.update_threads,
        parent_id=project.project_id,
        update_id=update.update_id,
        may_moderate=lambda author_id: _may_moderate(repositories, context, teams, author_id),
    )


def summarise_updates(
    repositories: Repositories, context: AuthzContext, rows: list[ProjectUpdateRead]
) -> list[ProjectUpdateRead]:
    """The feed's updates with each one's reaction groups and reply count filled in."""
    if not rows:
        return rows
    return summarise_threads(
        context, repositories.planning.update_threads, rows[0].project_id, rows, lambda row: row.update_id
    )


def list_update_comments(
    repositories: Repositories, context: AuthzContext, project_id: str, update_id: str
) -> list[ProjectUpdateCommentRead]:
    """Every reply on one readable update, oldest first."""
    return thread_comments(repositories, context, _host(repositories, context, project_id, update_id))


def create_update_comment(
    repositories: Repositories,
    context: AuthzContext,
    project_id: str,
    update_id: str,
    payload: ProjectUpdateCommentCreate,
) -> ProjectUpdateCommentRead:
    """Reply on a readable update; the notify consumer tells its author and anyone mentioned."""
    return post_comment(repositories, context, _host(repositories, context, project_id, update_id), payload)


def edit_update_comment(
    repositories: Repositories,
    context: AuthzContext,
    project_id: str,
    update_id: str,
    comment_id: str,
    payload: ProjectUpdateCommentPatch,
) -> ProjectUpdateCommentRead:
    """Rewrite a reply's body, stamping when it was edited."""
    host = _host(repositories, context, project_id, update_id)
    return edit_comment(repositories, context, host, comment_id, payload)


def delete_update_comment(
    repositories: Repositories, context: AuthzContext, project_id: str, update_id: str, comment_id: str
) -> None:
    """Delete a reply and every reaction on it."""
    remove_comment(context, _host(repositories, context, project_id, update_id), comment_id)


def add_update_reaction(
    repositories: Repositories,
    context: AuthzContext,
    project_id: str,
    update_id: str,
    payload: ProjectUpdateReactionWrite,
) -> ReactionGroupRead:
    """React to a readable update or one of its replies, answering that emoji's group."""
    return react(repositories, context, _host(repositories, context, project_id, update_id), payload)


def remove_update_reaction(
    repositories: Repositories,
    context: AuthzContext,
    project_id: str,
    update_id: str,
    emoji: str,
    comment_id: str | None,
) -> None:
    """Take the caller's reaction off an update or one of its replies; a missing one is a no-op."""
    unreact(context, _host(repositories, context, project_id, update_id), emoji, comment_id)
