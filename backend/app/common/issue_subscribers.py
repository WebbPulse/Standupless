"""Who follows an issue, and following or leaving it, shared by the routes and the MCP tools.

Held in `common` because the integrations image may not import another domain's
code. Subscribing needs only read access to the issue, as in Linear: following an
issue changes nothing about it, so anyone who can see it may ask to hear about it.
A member may also subscribe or unsubscribe a teammate, provided that teammate can
see the issue too. Doing so records an activity row naming both people, and a new
subscription made for someone else carries `added_by`, which is what the notify
consumer turns into the "subscribed you" notification.
"""

from __future__ import annotations

from app.common.account_deletion import DELETED_USER_NAME
from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.issues import SubscriberRead, SubscribersRead
from app.common.db.dynamo.activity import build_activity
from app.common.db.dynamo.issues import Issue
from app.common.icons import icon_url
from app.common.issue_rules import load_visible_issue, unprocessable
from app.common.team_privacy import person_can_see_team

ME = "me"

SUBSCRIBER_ADDED = "subscriber_added"

SUBSCRIBER_REMOVED = "subscriber_removed"


def render_subscribers(repositories: Repositories, context: AuthzContext, issue_id: str) -> SubscribersRead:
    """The issue's subscribers with their names, oldest subscription first."""
    rows = repositories.subscriptions.list_for_issue(context.workspace_id, issue_id)
    rows.sort(key=lambda row: row.created_at)
    users = repositories.users.get_many([row.user_id for row in rows]) if rows else {}
    subscribers = []
    for row in rows:
        user = users.get(row.user_id)
        name = (user.display_name or str(user.email).split("@", 1)[0]) if user is not None else DELETED_USER_NAME
        subscribers.append(
            SubscriberRead(
                user_id=row.user_id,
                display_name=name,
                avatar_url=icon_url(user.icon_key) if user is not None else None,
                reason=row.reason,
                created_at=row.created_at,
            )
        )
    return SubscribersRead(
        subscribers=subscribers,
        subscribed=any(row.user_id == context.user_id for row in rows),
    )


def list_subscribers(repositories: Repositories, context: AuthzContext, issue_id: str) -> SubscribersRead:
    """Everyone following one issue the caller may read."""
    load_visible_issue(repositories, context, issue_id)
    return render_subscribers(repositories, context, issue_id)


def resolve_target(context: AuthzContext, user_id: str | None) -> str:
    """The person a subscribe or unsubscribe acts on: the caller unless someone else is named."""
    if not user_id or user_id == ME:
        return context.user_id
    return user_id


def check_target(repositories: Repositories, context: AuthzContext, issue: Issue, user_id: str) -> None:
    """Hold someone being subscribed by another member to being able to see the issue, or raise a 422.

    The caller already passed `load_visible_issue`. A teammate must be a member of
    the workspace who can read the issue's team, which keeps private teams private
    and limits a guest to the teams they hold a membership in.
    """
    if user_id == context.user_id:
        return
    if repositories.memberships.get(context.workspace_id, user_id) is None:
        raise unprocessable("The subscriber is not a member of this workspace")
    if not person_can_see_team(repositories, context.workspace_id, issue.team_id, user_id):
        raise unprocessable("The subscriber cannot see this issue")


def _record(
    repositories: Repositories, context: AuthzContext, issue: Issue, kind: str, user_id: str, *, added: bool
) -> None:
    """Record that the caller subscribed or unsubscribed someone else."""
    repositories.activity.record(
        build_activity(
            context.workspace_id,
            issue.team_id,
            issue.issue_id,
            context.user_id,
            kind,
            from_value=None if added else user_id,
            to_value=user_id if added else None,
            source=context.source,
        )
    )


def subscribe(
    repositories: Repositories, context: AuthzContext, issue_id: str, user_id: str | None = None
) -> SubscribersRead:
    """Follow the issue as the caller, or subscribe a teammate who can see it.

    Subscribing twice keeps the first subscription. Subscribing someone else writes
    `added_by` and a `subscriber_added` history row, but only when the row is new.
    """
    issue = load_visible_issue(repositories, context, issue_id)
    target = resolve_target(context, user_id)
    check_target(repositories, context, issue, target)
    added = repositories.subscriptions.subscribe(
        context.workspace_id, issue_id, issue.team_id, target, "manual", added_by=context.user_id
    )
    if added and target != context.user_id:
        _record(repositories, context, issue, SUBSCRIBER_ADDED, target, added=True)
    return render_subscribers(repositories, context, issue_id)


def unsubscribe(
    repositories: Repositories, context: AuthzContext, issue_id: str, user_id: str | None = None
) -> SubscribersRead:
    """Stop following the issue as the caller, or unsubscribe a teammate.

    Unsubscribing someone who is not subscribed is not an error and records nothing.
    Removing someone else writes a `subscriber_removed` history row.
    """
    issue = load_visible_issue(repositories, context, issue_id)
    target = resolve_target(context, user_id)
    existing = repositories.subscriptions.get(context.workspace_id, issue_id, target)
    if existing is None:
        return render_subscribers(repositories, context, issue_id)
    repositories.subscriptions.unsubscribe(context.workspace_id, issue_id, target)
    if target != context.user_id:
        _record(repositories, context, issue, SUBSCRIBER_REMOVED, target, added=False)
    return render_subscribers(repositories, context, issue_id)
