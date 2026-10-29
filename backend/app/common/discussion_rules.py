"""Who may read, edit and delete in a discussion, shared by the discussion routes and the MCP tools.

Held in `common` because the integrations image may not import another domain's
code, and an agent editing or deleting a comment, reacting or managing a link must
meet exactly the rule a person meets in the UI.

Every rule starts from an issue, because the team is what visibility is decided
against. `load_visible_issue` is that one entry point, so a comment, a reaction
and an attachment in a team the caller is outside are all indistinguishable from
ones that never existed.
"""

from __future__ import annotations

from fastapi import HTTPException, status

from app.common.api.dependencies.authz import IMPLIED_TEAM_ROLE, AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.comments import Comment
from app.common.db.dynamo.issues import Issue
from app.common.issue_privacy import can_see_issue

NOT_FOUND = {"error_code": "NOT_FOUND", "message": "Resource not found"}

FORBIDDEN = {"error_code": "FORBIDDEN", "message": "Not allowed"}


def not_found() -> HTTPException:
    """The 404 an absent or invisible row gets.

    Invisible and absent must look identical, or a caller could probe for issues in
    teams they are outside.
    """
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)


def forbidden() -> HTTPException:
    """The 403 a caller inside the team but outside the rule gets.

    A caller who can see the resource and still may not act on it gets a 403: the
    resource is not in doubt, only the verb.
    """
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=FORBIDDEN)


def conflict(message: str) -> HTTPException:
    """A 409 carrying the product's error envelope."""
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={"error_code": "CONFLICT", "message": message},
    )


def load_visible_issue(repositories: Repositories, context: AuthzContext, issue_id: str) -> Issue:
    """One issue the caller may read, or a 404.

    Every route in this domain starts here, which is what makes the issue's team
    the single place visibility is decided for its comments, reactions and
    attachments alike.
    """
    issue = repositories.issues.get(context.workspace_id, issue_id)
    if issue is None:
        raise not_found()
    if not can_see_issue(repositories, context, issue):
        raise not_found()
    return issue


def team_role(repositories: Repositories, context: AuthzContext, team_id: str) -> str | None:
    """The caller's role on one team, explicit membership winning over implied.

    The authorization dependency resolves this for a team in the path, and every
    route here carries the team on the issue instead, so the same decision is
    made against the team the issue actually belongs to.
    """
    membership = repositories.memberships.get_team_membership(context.workspace_id, team_id, context.user_id)
    if membership is not None:
        return membership.role
    return IMPLIED_TEAM_ROLE.get(context.role)


def require_team_member(repositories: Repositories, context: AuthzContext, team_id: str) -> None:
    """Hold that the caller may write in one team, or 404 or 403.

    Invisibility was already a 404 at `load_visible_issue`; what is left is a
    caller who can see the team and holds no role that writes, which is a 403.
    """
    if not context.can_see_team(team_id):
        raise not_found()
    if team_role(repositories, context, team_id) is None:
        raise forbidden()


def is_team_admin(repositories: Repositories, context: AuthzContext, team_id: str) -> bool:
    """Whether the caller administers one team.

    Answered rather than raised, because the contract's delete rules are each an
    author-or-admin disjunction and reading them as one condition hid a case.
    """
    if context.is_workspace_admin:
        return True
    return team_role(repositories, context, team_id) == "admin"


def may_edit_comment(context: AuthzContext, comment: Comment) -> bool:
    """Whether this caller may edit one comment: the author alone.

    Not a team admin, per the contract. Editing someone else's words is a
    different act from removing them, and only the second has a moderation case.
    """
    return comment.author_id == context.user_id


def may_delete_comment(repositories: Repositories, context: AuthzContext, comment: Comment, team_id: str) -> bool:
    """Whether this caller may delete one comment: the author or an admin of the issue's current team.

    The team is the issue's, not the one stamped on the comment, because an issue
    moved to another team brings its comments with it.
    """
    if comment.author_id == context.user_id:
        return True
    return is_team_admin(repositories, context, team_id)
