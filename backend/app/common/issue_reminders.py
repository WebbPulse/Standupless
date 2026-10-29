"""Reminders a member sets for themselves, shared by the inbox routes and the MCP tools.

Held in `common` because the integrations image may not import another domain's
code. A reminder belongs to its caller alone: every call builds the partition from
the authorization context, never from an argument, so one member can neither read
nor cancel another's reminders. Setting one needs only read access to its subject,
an issue, project, initiative or document, because it changes nothing anyone
else sees. The issue routes speak only of issues, as they always have; the entity
routes take any kind of subject, issues included.

The moment is whatever the caller picked on their own clock, sent with its offset,
so presets like "tomorrow morning" are the client's arithmetic and the server only
checks the moment is sensibly in the future.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import cast

from fastapi import HTTPException

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.views import IssueReminderRead, IssueReminderWrite, ReminderRead
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.issue_reminders import REMINDER_ENTITIES, IssueReminder, ReminderEntity
from app.common.db.dynamo.issues import Issue
from app.common.documents import load_readable_document
from app.common.initiative_writes import load_initiative
from app.common.issue_keys import display_key
from app.common.issue_privacy import can_see_issue
from app.common.issue_rules import load_visible_issue, not_found, unprocessable
from app.common.planning_rules import load_readable_project

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


def _check_moment(remind_at: datetime) -> None:
    """Refuse a moment too soon to land or more than a year out."""
    now = utc_now()
    if remind_at < now + REMINDER_MIN:
        raise unprocessable("remind_at must be at least a minute in the future")
    if remind_at > now + REMINDER_MAX:
        raise unprocessable("remind_at must be within 365 days")


def set_reminder(
    repositories: Repositories, context: AuthzContext, issue_id: str, payload: IssueReminderWrite
) -> IssueReminderRead:
    """Remind the caller about one issue they can see at one moment, replacing any reminder already set."""
    issue = load_visible_issue(repositories, context, issue_id)
    _check_moment(payload.remind_at)
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
        reminders = [
            reminder
            for reminder in store.list(context.workspace_id, context.user_id)
            if reminder.entity_type == "issue"
        ]
    if not reminders:
        return []
    issues = repositories.issues.get_many(context.workspace_id, [reminder.issue_id for reminder in reminders])
    items: list[IssueReminderRead] = []
    for reminder in reminders:
        issue = issues.get(reminder.issue_id)
        if issue is None or not can_see_issue(repositories, context, issue):
            continue
        items.append(_as_read(repositories, reminder, issue))
    return items


def _entity_type(entity_type: str) -> ReminderEntity:
    """One entity type a reminder may name, or a 422."""
    if entity_type not in REMINDER_ENTITIES:
        raise unprocessable(f"entity_type must be one of {', '.join(REMINDER_ENTITIES)}")
    return cast(ReminderEntity, entity_type)


def _subject(
    repositories: Repositories, context: AuthzContext, entity_type: ReminderEntity, entity_id: str
) -> tuple[str, str | None, str]:
    """The title, issue key and team of one subject the caller can read, or the 404 its loader raises."""
    if entity_type == "issue":
        issue = load_visible_issue(repositories, context, entity_id)
        key = display_key(repositories.teams, issue.workspace_id, issue.team_id, issue.key)
        return issue.title, key, issue.team_id
    if entity_type == "project":
        project, teams = load_readable_project(repositories, context, entity_id)
        return project.name, None, teams[0]
    if entity_type == "initiative":
        initiative = load_initiative(repositories, context, entity_id)
        return initiative.name, None, ""
    _, document = load_readable_document(repositories, context, entity_id)
    return document.title, None, document.parent_id if document.parent_kind == "team" else ""


def _entity_read(reminder: IssueReminder, subject: tuple[str, str | None, str]) -> ReminderRead:
    """One pending reminder in the entity response shape."""
    title, issue_key, team_id = subject
    return ReminderRead(
        entity_type=reminder.entity_type,
        entity_id=reminder.entity_id,
        title=title,
        issue_key=issue_key,
        team_id=team_id,
        remind_at=reminder.remind_at,
        created_at=reminder.created_at,
    )


def set_entity_reminder(
    repositories: Repositories,
    context: AuthzContext,
    entity_type: str,
    entity_id: str,
    payload: IssueReminderWrite,
) -> ReminderRead:
    """Remind the caller about one issue, project, initiative or document they can read, replacing any set."""
    kind = _entity_type(entity_type)
    subject = _subject(repositories, context, kind, entity_id)
    _check_moment(payload.remind_at)
    reminder = repositories.inbox.reminders.set(
        context.workspace_id, context.user_id, entity_id, payload.remind_at, entity_type=kind
    )
    return _entity_read(reminder, subject)


def cancel_entity_reminder(repositories: Repositories, context: AuthzContext, entity_type: str, entity_id: str) -> None:
    """Cancel the caller's pending reminder on one subject, or 404 when there is none."""
    kind = _entity_type(entity_type)
    if not repositories.inbox.reminders.cancel(context.workspace_id, context.user_id, entity_id, kind):
        raise not_found()


def list_entity_reminders(
    repositories: Repositories,
    context: AuthzContext,
    entity_type: str | None = None,
    entity_id: str | None = None,
) -> list[ReminderRead]:
    """The caller's pending reminders on every kind of subject, soonest first, optionally narrowed.

    Naming `entity_id` needs `entity_type` too, and narrows to that one subject. A
    reminder on a subject that is gone, or the caller can no longer read, is left
    out rather than shown with a title the caller should not read.
    """
    kind = _entity_type(entity_type) if entity_type else None
    if entity_id and kind is None:
        raise unprocessable("entity_id needs entity_type")
    store = repositories.inbox.reminders
    if kind is not None and entity_id:
        one = store.get(context.workspace_id, context.user_id, entity_id, kind)
        reminders = [one] if one is not None else []
    else:
        reminders = [
            reminder
            for reminder in store.list(context.workspace_id, context.user_id)
            if kind is None or reminder.entity_type == kind
        ]
    items: list[ReminderRead] = []
    for reminder in reminders:
        try:
            subject = _subject(repositories, context, reminder.entity_type, reminder.entity_id)
        except HTTPException:
            continue
        items.append(_entity_read(reminder, subject))
    return items
