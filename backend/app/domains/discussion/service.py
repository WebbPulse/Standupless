"""Decisions a discussion write needs that a schema cannot make on its own.

Every route here starts from an issue, because the project is not in the path and
the project is what visibility is decided against. `load_visible_issue` is that one
entry point, so a comment, a reaction and an attachment in a project the caller is
outside are all indistinguishable from ones that never existed.

The authorization helpers delegate to the issues domain's own rules rather than
restating them: the contract says a comment is readable exactly when the issue's
project is readable, and a second spelling of that rule is a second place it can
drift.
"""

from __future__ import annotations

from typing import Iterable

from fastapi import HTTPException, status

from app.common.api.dependencies.authz import IMPLIED_PROJECT_ROLE, AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.core.config import settings
from app.common.db.dynamo.comments import Comment
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.reactions import USER_IDS_CAP, Reaction
from app.domains.discussion.schemas.discussion import AuthorRead, ReactionGroupRead

NOT_FOUND = {"error_code": "NOT_FOUND", "message": "Resource not found"}

FORBIDDEN = {"error_code": "FORBIDDEN", "message": "Not allowed"}


def not_found() -> HTTPException:
    """The 404 an absent or invisible row gets.

    Invisible and absent must look identical, or a caller could probe for issues in
    projects they are outside.
    """
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)


def forbidden() -> HTTPException:
    """The 403 a caller inside the project but outside the rule gets.

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


def unprocessable(message: str, error_code: str = "VALIDATION_ERROR") -> HTTPException:
    """A 422 carrying one of the contract's own error codes.

    The code is a parameter because M3 adds `UNSUPPORTED_MEDIA_TYPE` and
    `UPLOAD_TOO_LARGE` beside the platform envelope's own, and a client
    distinguishes them by code rather than by message.
    """
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail={"error_code": error_code, "message": message},
    )


def unknown_upload() -> HTTPException:
    """The 404 a commit naming a ticket this caller did not mint gets.

    One answer for an absent ticket, an expired one and one minted for another
    caller or another issue, so a commit cannot be used to probe for tickets.
    """
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail={"error_code": "UNKNOWN_UPLOAD", "message": "No such upload"},
    )


def load_visible_issue(repositories: Repositories, context: AuthzContext, issue_id: str) -> Issue:
    """One issue the caller may read, or a 404.

    Every route in this domain starts here, which is what makes the issue's project
    the single place visibility is decided for its comments, reactions and
    attachments alike.
    """
    issue = repositories.issues.get(context.workspace_id, issue_id)
    if issue is None:
        raise not_found()
    if not context.can_see_project(issue.project_id):
        raise not_found()
    return issue


def project_role(repositories: Repositories, context: AuthzContext, project_id: str) -> str | None:
    """The caller's role on one project, explicit membership winning over implied.

    The authorization dependency resolves this for a project in the path, and every
    route here carries the project on the issue instead, so the same decision is
    made against the project the issue actually belongs to.
    """
    membership = repositories.memberships.get_project_membership(context.workspace_id, project_id, context.user_id)
    if membership is not None:
        return membership.role
    return IMPLIED_PROJECT_ROLE.get(context.role)


def require_project_member(repositories: Repositories, context: AuthzContext, project_id: str) -> None:
    """Hold that the caller may write in one project, or 404 or 403.

    Invisibility was already a 404 at `load_visible_issue`; what is left is a
    caller who can see the project and holds no role that writes, which is a 403.
    """
    if not context.can_see_project(project_id):
        raise not_found()
    if project_role(repositories, context, project_id) is None:
        raise forbidden()


def is_project_admin(repositories: Repositories, context: AuthzContext, project_id: str) -> bool:
    """Whether the caller administers one project.

    Answered rather than raised, because the contract's delete rules are each an
    author-or-admin disjunction and reading them as one condition hid a case.
    """
    if context.is_workspace_admin:
        return True
    return project_role(repositories, context, project_id) == "admin"


def authors_for(repositories: Repositories, user_ids: Iterable[str]) -> dict[str, AuthorRead]:
    """The author block for each named user, in one batched read.

    Joined per page rather than denormalised onto every comment row, so a display
    name change shows up without rewriting a thread. A user who is gone still
    renders, carrying their id alone, rather than 404ing the list they appear in.
    """
    wanted = [user_id for user_id in dict.fromkeys(user_ids) if user_id]
    if not wanted:
        return {}
    users = repositories.users.get_many(wanted)
    resolved: dict[str, AuthorRead] = {}
    for user_id in wanted:
        user = users.get(user_id)
        if user is None:
            resolved[user_id] = AuthorRead(user_id=user_id)
            continue
        resolved[user_id] = AuthorRead(
            user_id=user_id,
            display_name=user.display_name,
            email=str(user.email),
        )
    return resolved


def group_reactions(rows: list[Reaction], caller_id: str) -> list[ReactionGroupRead]:
    """One target's reactions as groups, in the key order they were read in.

    A group with a count of zero is never produced, because a group exists only
    where a row does. `reacted` is resolved here rather than by the frontend so the
    caller's own reaction renders as pressed without a second read.
    """
    order: list[str] = []
    grouped: dict[str, list[str]] = {}
    for row in rows:
        if row.emoji not in grouped:
            grouped[row.emoji] = []
            order.append(row.emoji)
        grouped[row.emoji].append(row.user_id)

    groups: list[ReactionGroupRead] = []
    for emoji in order:
        user_ids = grouped[emoji]
        groups.append(
            ReactionGroupRead(
                emoji=emoji,
                count=len(user_ids),
                user_ids=user_ids[:USER_IDS_CAP],
                reacted=caller_id in user_ids,
            )
        )
    return groups


def resolve_mentions(repositories: Repositories, workspace_id: str, handles: list[str]) -> list[str]:
    """The workspace members the `@handle` mentions in a body name, as user ids.

    A handle is matched against the local part of a member's email and against
    their display name with spaces removed, both case insensitively, because the
    identity package stores no handle of its own and the contract's `mentions` is a
    list of user ids rather than of the text that was typed.

    Scoped to the workspace's own members, so a mention can only ever name someone
    the author could already see, and an unmatched handle is dropped rather than
    stored as a dangling id.
    """
    if not handles:
        return []
    memberships = repositories.memberships.list_members(workspace_id)
    member_ids = [membership.user_id for membership in memberships if membership.user_id]
    if not member_ids:
        return []
    users = repositories.users.get_many(member_ids)

    by_handle: dict[str, str] = {}
    for user_id in member_ids:
        user = users.get(user_id)
        if user is None:
            continue
        local_part = str(user.email).split("@", 1)[0].strip().lower()
        if local_part:
            by_handle.setdefault(local_part, user_id)
        display = user.display_name.replace(" ", "").strip().lower()
        if display:
            by_handle.setdefault(display, user_id)

    resolved: list[str] = []
    for handle in handles:
        user_id = by_handle.get(handle.strip().lower())
        if user_id is not None and user_id not in resolved:
            resolved.append(user_id)
    return resolved


def attachments_bucket() -> str:
    """The bucket attachments are presigned against, or a 422 when none is set.

    Fails closed rather than guessing a name: a function deployed without the
    bucket or without its IAM grant refuses to sign, instead of handing out a URL
    that S3 rejects after the client has read the whole file.
    """
    bucket = settings.ATTACHMENTS_BUCKET.strip()
    if not bucket:
        raise unprocessable("File uploads are not configured for this environment")
    return bucket


def object_exists(bucket: str, key: str) -> bool:
    """Whether one object is really in the bucket.

    The commit route's guard, so recording an attachment for an upload that never
    happened is a 409 rather than a row pointing at nothing. `webbpulse.storage`
    presigns but does not read, and a `HeadObject` is the one S3 call this service
    makes itself; anything beyond it belongs upstream rather than here.

    Any error that is not a plain absence is treated as absence too, because the
    only use of this answer is whether to record a row, and recording one on an
    inconclusive read is the worse failure.
    """
    import boto3
    from botocore.exceptions import ClientError

    client = boto3.client("s3", region_name=settings.AWS_REGION or None)
    try:
        client.head_object(Bucket=bucket, Key=key)
    except ClientError:
        return False
    return True


def may_edit_comment(context: AuthzContext, comment: Comment) -> bool:
    """Whether this caller may edit one comment: the author alone.

    Not a project admin, per the contract. Editing someone else's words is a
    different act from removing them, and only the second has a moderation case.
    """
    return comment.author_id == context.user_id


def may_delete_comment(repositories: Repositories, context: AuthzContext, comment: Comment) -> bool:
    """Whether this caller may delete one comment: the author or a project admin."""
    if comment.author_id == context.user_id:
        return True
    return is_project_admin(repositories, context, comment.project_id)
