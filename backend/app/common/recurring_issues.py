"""Recurring issues: their reads and writes, and creating the issue a run is due for.

Held in `common` because the routes live in the teams domain, the sweep that
runs them in the issues domain, and the MCP tools in the integrations image.
Any team member may keep a team's schedules, as with its templates. A schedule
names a template the team offers and is held to a rule that can run.

A run creates the issue as the person who made the schedule, through the same
create path a person uses, so the template is applied leniently and every
check holds. When that person can no longer write in the team, or the template
is gone, the run pauses the schedule with the reason rather than failing every
hour.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from fastapi import HTTPException
from webbpulse.dynamodb import ConditionFailed

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.issues import IssueCreate
from app.common.api.schemas.recurring import RecurringCreate, RecurringRead, RecurringUpdate
from app.common.change_source import SYSTEM
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.team_config import DEFAULT_STANDUP_TIMEZONE, new_config_id
from app.common.db.dynamo.team_recurring import RecurringIssue, recurring_key
from app.common.db.dynamo.team_templates import IssueTemplate
from app.common.issue_rules import not_found, require_team_member, require_team_reader, unprocessable
from app.common.issue_templates import conflict, find_template, team_templates
from app.common.issue_writes import create_issue
from app.common.recurrence import RecurrenceError, Rule, next_run, resolve_zone, upcoming_runs

MAX_PER_TEAM = 50
"""The most recurring issues one team may keep."""

PREVIEW_RUNS = 3
"""How many runs after the next one a read previews."""

RULE_FIELDS: tuple[str, ...] = ("frequency", "interval", "weekdays", "day_of_month", "time", "timezone", "starts_on")
"""The fields that change when a schedule runs, so editing one moves the next run."""

TEMPLATE_GONE = "template_deleted"
"""The pause reason when the schedule's template no longer exists."""

CREATOR_GONE = "creator_cannot_write"
"""The pause reason when the person who made the schedule can no longer write in the team."""

CREATE_FAILED = "create_failed"
"""The pause reason when the create path refused the issue."""

WORKSPACE_ROLES: tuple[str, ...] = ("owner", "admin", "member", "guest")


def team_timezone(repositories: Repositories, workspace_id: str, team_id: str) -> str:
    """The timezone a team's new schedules default to: its standup timezone, else UTC."""
    settings = repositories.team_config.get_standup_settings(workspace_id, team_id)
    if settings is not None and settings.timezone:
        return str(settings.timezone)
    return DEFAULT_STANDUP_TIMEZONE


def rule_of(row: RecurringIssue) -> Rule:
    """The recurrence rule a stored schedule follows."""
    return Rule(
        frequency=row.frequency,
        interval=row.interval,
        weekdays=tuple(row.weekdays),
        day_of_month=row.day_of_month,
        at=row.time,
        timezone=row.timezone,
        starts_on=row.starts_on,
    )


def checked_rule(row: RecurringIssue) -> Rule:
    """The rule of a draft schedule, or a 422 saying why it cannot run."""
    rule = rule_of(row)
    try:
        rule.check()
    except RecurrenceError as exc:
        raise unprocessable(str(exc)) from exc
    return rule


def preview(row: RecurringIssue) -> list[datetime]:
    """The runs after the next one, empty while paused."""
    if row.paused or row.next_run_at is None:
        return []
    try:
        return upcoming_runs(rule_of(row), row.next_run_at, PREVIEW_RUNS)
    except RecurrenceError:
        return []


def template_names(repositories: Repositories, context: AuthzContext, team_id: str) -> dict[str, str]:
    """The name of every template the team offers the caller, by id."""
    return {row.template_id: row.name for row in team_templates(repositories, context, team_id)}


def _template(repositories: Repositories, context: AuthzContext, team_id: str, template_id: str) -> IssueTemplate:
    """One template the team offers the caller, or a 422 naming it."""
    template = find_template(repositories, context, team_id, template_id)
    if template is None:
        raise unprocessable(f"No such template: {template_id}")
    return template


def list_recurring(
    repositories: Repositories, context: AuthzContext, team_id: str
) -> tuple[list[RecurringIssue], dict[str, str], str]:
    """Every schedule of one team, the names of its templates and the team's default timezone."""
    require_team_reader(repositories, context, team_id)
    rows = repositories.team_config.list_recurring(context.workspace_id, team_id)
    names = template_names(repositories, context, team_id)
    return rows, names, team_timezone(repositories, context.workspace_id, team_id)


def get_recurring(
    repositories: Repositories, context: AuthzContext, team_id: str, recurring_id: str
) -> RecurringIssue:
    """One schedule of a team the caller can see, or a 404."""
    require_team_reader(repositories, context, team_id)
    row = repositories.team_config.get_recurring(context.workspace_id, team_id, recurring_id)
    if row is None:
        raise not_found()
    return row


def template_name(repositories: Repositories, context: AuthzContext, row: RecurringIssue) -> Optional[str]:
    """The name of a schedule's template, `None` once it is gone."""
    template = find_template(repositories, context, row.team_id, row.template_id)
    return template.name if template is not None else None


def read(repositories: Repositories, context: AuthzContext, row: RecurringIssue) -> RecurringRead:
    """One schedule as the API returns it, with its template's name and next runs."""
    return RecurringRead.from_row(row, template_name(repositories, context, row), preview(row))


def _scheduled(row: RecurringIssue, now: datetime) -> RecurringIssue:
    """The schedule with its next run set from `now`, or cleared while paused."""
    if row.paused:
        return row.model_copy(update={"next_run_at": None})
    return row.model_copy(update={"next_run_at": next_run(checked_rule(row), now), "paused_reason": None})


def create_recurring(
    repositories: Repositories, context: AuthzContext, team_id: str, payload: RecurringCreate
) -> RecurringIssue:
    """Save a new schedule on a team the caller may write in."""
    require_team_member(repositories, context, team_id)
    workspace_id = context.workspace_id
    if repositories.teams.get(workspace_id, team_id) is None:
        raise not_found()
    _template(repositories, context, team_id, payload.template_id)
    if len(repositories.team_config.list_recurring(workspace_id, team_id, limit=MAX_PER_TEAM + 1)) >= MAX_PER_TEAM:
        raise unprocessable(f"A team can keep at most {MAX_PER_TEAM} recurring issues")
    zone = payload.timezone or team_timezone(repositories, workspace_id, team_id)
    now = utc_now()
    try:
        today = now.astimezone(resolve_zone(zone)).date()
    except RecurrenceError as exc:
        raise unprocessable(str(exc)) from exc
    recurring_id = new_config_id()
    draft = RecurringIssue(
        workspace_id=workspace_id,
        config_key=recurring_key(team_id, recurring_id),
        recurring_id=recurring_id,
        team_id=team_id,
        template_id=payload.template_id,
        frequency=payload.frequency,
        interval=payload.interval or 1,
        weekdays=payload.weekdays or [],
        day_of_month=payload.day_of_month,
        time=payload.time or "09:00",
        timezone=zone,
        starts_on=payload.starts_on or today,
        paused=payload.paused,
        created_by=context.user_id,
    )
    try:
        return repositories.team_config.create_recurring(_scheduled(draft, now))
    except ConditionFailed as exc:
        raise conflict("That recurring issue already exists") from exc


def update_recurring(
    repositories: Repositories, context: AuthzContext, team_id: str, recurring_id: str, payload: RecurringUpdate
) -> RecurringIssue:
    """Patch one schedule; a rule change or a resume sets the next run from now."""
    require_team_member(repositories, context, team_id)
    existing = repositories.team_config.get_recurring(context.workspace_id, team_id, recurring_id)
    if existing is None:
        raise not_found()
    fields = payload.model_dump(exclude_unset=True)
    for name, value in list(fields.items()):
        if value is None and name != "day_of_month":
            raise unprocessable(f"{name} must not be null")
    if "template_id" in fields:
        _template(repositories, context, team_id, fields["template_id"])
    if "timezone" in fields:
        try:
            resolve_zone(fields["timezone"])
        except RecurrenceError as exc:
            raise unprocessable(str(exc)) from exc
    merged = existing.model_copy(update=fields)
    reschedule = any(name in fields for name in RULE_FIELDS) or (existing.paused and not merged.paused)
    if merged.paused:
        cleared: dict[str, Any] = {"next_run_at": None}
        if "paused" in fields:
            cleared["paused_reason"] = None
        merged = merged.model_copy(update=cleared)
    elif reschedule or merged.next_run_at is None:
        merged = _scheduled(merged, utc_now())
    else:
        checked_rule(merged)
    stored = repositories.team_config.replace_recurring(merged)
    if stored is None:
        raise not_found()
    return stored


def delete_recurring(repositories: Repositories, context: AuthzContext, team_id: str, recurring_id: str) -> None:
    """Delete one schedule of a team the caller may write in, or 404."""
    require_team_member(repositories, context, team_id)
    if not repositories.team_config.delete_recurring(context.workspace_id, team_id, recurring_id):
        raise not_found()


def creator_context(repositories: Any, workspace_id: str, user_id: str) -> Optional[AuthzContext]:
    """The context a run creates its issue under: the schedule's creator, as the system source.

    `None` when that person has left the workspace or their account is disabled,
    so the run pauses rather than acting for someone who is gone.
    """
    user = repositories.users.get(user_id)
    if user is None or user.disabled or user.purging_at is not None:
        return None
    membership = repositories.memberships.get(workspace_id, user_id)
    if membership is None or membership.role not in WORKSPACE_ROLES:
        return None
    private = repositories.memberships.list_private_team_ids(workspace_id)
    team_ids: tuple[str, ...] = ()
    if membership.role == "guest" or private:
        team_ids = tuple(
            row.team_id
            for row in repositories.memberships.list_team_memberships_for_user(workspace_id, user_id)
            if row.team_id is not None
        )
    return AuthzContext(
        workspace_id=workspace_id,
        user_id=user_id,
        role=membership.role,
        team_ids=team_ids,
        private_team_ids=private,
        source=SYSTEM,
    )


def _pause(repositories: Any, row: RecurringIssue, reason: str) -> None:
    """Pause a schedule the sweep cannot run, recording why."""
    repositories.team_config.replace_recurring(
        row.model_copy(update={"paused": True, "paused_reason": reason, "next_run_at": None})
    )


def is_due(row: RecurringIssue, now: datetime) -> bool:
    """Whether a schedule's next run has come."""
    return not row.paused and row.next_run_at is not None and row.next_run_at <= now


def run_due(repositories: Any, row: RecurringIssue, now: datetime) -> tuple[str, Optional[Issue]]:
    """Create the issue a due schedule owes, once, and move it to its next run.

    Answers an outcome, `created`, `skipped` when another sweep or an edit won
    the claim, or `paused`, and the issue created. The next run is the first
    after `now`, so a schedule that missed several runs while the sweep was down
    creates one issue and carries on.
    """
    context = creator_context(repositories, row.workspace_id, row.created_by)
    if context is None:
        _pause(repositories, row, CREATOR_GONE)
        return "paused", None
    template = find_template(repositories, context, row.team_id, row.template_id)
    if template is None:
        _pause(repositories, row, TEMPLATE_GONE)
        return "paused", None
    try:
        following = next_run(rule_of(row), now)
    except RecurrenceError:
        _pause(repositories, row, CREATE_FAILED)
        return "paused", None
    claimed = row.model_copy(update={"next_run_at": following, "last_run_at": now, "updated_at": now})
    if not repositories.team_config.claim_recurring_run(row, claimed):
        return "skipped", None
    title = (template.title or "").strip() or template.name
    try:
        issue = create_issue(
            repositories, context, IssueCreate(team_id=row.team_id, title=title, template_id=row.template_id)
        )
    except HTTPException as exc:
        reason = CREATOR_GONE if exc.status_code in (403, 404) else CREATE_FAILED
        _pause(repositories, claimed, reason)
        return "paused", None
    repositories.team_config.replace_recurring(
        claimed.model_copy(update={"last_issue_id": issue.issue_id, "last_issue_key": issue.key})
    )
    return "created", issue

