"""Issue reminders a member sets for themselves, shared by the inbox routes and the MCP tools.

Held in `common` because the integrations image may not import another domain's
code. A reminder belongs to its caller alone: every call builds the partition from
the authorization context, never from an argument, so one member can neither read
nor cancel another's reminders. Setting one needs only read access to the issue,
because it changes nothing anyone else sees.

The moment is whatever the caller picked on their own clock, sent with its offset,
so presets like "tomorrow morning" are the client's arithmetic and the server only
checks the moment is sensibly in the future.
"""

from __future__ import annotations

from datetime import timedelta

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.views import IssueReminderRead, IssueReminderWrite
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.issue_reminders import IssueReminder
from app.common.db.dynamo.issues import Issue
from app.common.issue_keys import display_key
from app.common.issue_rules import load_visible_issue, not_found, unprocessable

REMINDER_MIN = timedelta(minutes=1)
"""How far out a reminder must be, so it cannot come due before the request lands."""

REMINDER_MAX = timedelta(days=365)
"""How far out a reminder may be set."""


def _as_read(repositories: Repositories, reminder: IssueReminder, issue: Issue) -> IssueReminderRead:
    """One pending reminder in the response shape, with the issue's key and title as they read now."""
    return IssueReminderRead(
        issue_id=issue.issue_id,
        issue_key=display_key(repositories.teams, issue.workspace_id, issue.team_id, issue.key),
        issue_title=issue.title,
        team_id=issue.team_id,
        remind_at=reminder.remind_at,
        created_at=reminder.created_at,
    )


def set_reminder(
    repositories: Repositories, context: AuthzContext, issue_id: str, payload: IssueReminderWrite
) -> IssueReminderRead:
    """Remind the caller about one issue they can see at one moment, replacing any reminder already set."""
    issue = load_visible_issue(repositories, context, issue_id)
    now = utc_now()
    if payload.remind_at < now + REMINDER_MIN:
        raise unprocessable("remind_at must be at least a minute in the future")
    if payload.remind_at > now + REMINDER_MAX:
        raise unprocessable("remind_at must be within 365 days")
    reminder = repositories.inbox.reminders.set(
        context.workspace_id, context.user_id, issue.issue_id, payload.remind_at
    )
    return _as_read(repositories, reminder, issue)


def cancel_reminder(repositories: Repositories, context: AuthzContext, issue_id: str) -> None:
    """Cancel the caller's pending reminder on one issue, or 404 when there is none."""
    if not repositories.inbox.reminders.cancel(context.workspace_id, context.user_id, issue_id):
        raise not_found()


def list_reminders(
    repositories: Repositories, context: AuthzContext, issue_id: str | None = None
) -> list[IssueReminderRead]:
    """The caller's pending reminders, soonest first, optionally on one issue alone.

    A reminder on an issue that is gone, or in a team the caller can no longer see,
    is left out rather than shown with a title the caller should not read.
    """
    store = repositories.inbox.reminders
    if issue_id:
        one = store.get(context.workspace_id, context.user_id, issue_id)
        reminders = [one] if one is not None else []
    else:
        reminders = store.list(context.workspace_id, context.user_id)
    if not reminders:
        return []
    issues = repositories.issues.get_many(context.workspace_id, [reminder.issue_id for reminder in reminders])
    items: list[IssueReminderRead] = []
    for reminder in reminders:
        issue = issues.get(reminder.issue_id)
        if issue is None or not context.can_see_team(issue.team_id):
            continue
        items.append(_as_read(repositories, reminder, issue))
    return items
