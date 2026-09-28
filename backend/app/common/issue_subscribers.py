"""Who follows an issue, and following or leaving it, shared by the routes and the MCP tools.

Held in `common` because the integrations image may not import another domain's
code. Subscribing needs only read access to the issue, as in Linear: following an
issue changes nothing about it, so anyone who can see it may ask to hear about it.
Only the caller can be subscribed or unsubscribed, never someone else.
"""

from __future__ import annotations

from app.common.account_deletion import DELETED_USER_NAME
from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.issues import SubscriberRead, SubscribersRead
from app.common.icons import icon_url
from app.common.issue_rules import load_visible_issue


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


def subscribe(repositories: Repositories, context: AuthzContext, issue_id: str) -> SubscribersRead:
    """Follow the issue as the caller. Subscribing twice keeps the first subscription."""
    issue = load_visible_issue(repositories, context, issue_id)
    repositories.subscriptions.subscribe(context.workspace_id, issue_id, issue.team_id, context.user_id, "manual")
    return render_subscribers(repositories, context, issue_id)


def unsubscribe(repositories: Repositories, context: AuthzContext, issue_id: str) -> SubscribersRead:
    """Stop following the issue as the caller. Unsubscribing when not subscribed is not an error."""
    load_visible_issue(repositories, context, issue_id)
    repositories.subscriptions.unsubscribe(context.workspace_id, issue_id, context.user_id)
    return render_subscribers(repositories, context, issue_id)
