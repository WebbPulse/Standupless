"""A team's triage inbox: its switch, its list and the four ways an issue leaves it.

Held in `common` because the issue routes, the team routes and the MCP tools in
the integrations image all run it, and that image may not import another
domain's code. An issue awaiting triage keeps an ordinary status but sits in its
team's own partition of the status index, so the inbox is one key read and no
board column sees it. Accepting, declining and marking as duplicate go through
the same patch path a person's edit does, so the history reads the same.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Optional

from fastapi import HTTPException, status
from webbpulse.dynamodb import ConditionFailed

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.pagination import decode_offset_cursor, encode_offset_cursor
from app.common.api.schemas.issues import (
    LinkCreate,
    TriageAccept,
    TriageDecline,
    TriageDuplicate,
    TriageSnooze,
    TriageTeamCount,
)
from app.common.api.schemas.teams import TriageSettingsUpdate
from app.common.db.dynamo.activity import build_activity
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.issues import Issue, IssueWriteConflict
from app.common.db.dynamo.team_config import TriageSettings, default_triage_settings
from app.common.issue_keys import current_all
from app.common.issue_links import create_link
from app.common.issue_rules import (
    check_status,
    issue_changed,
    load_visible_issue,
    not_found,
    require_team_member,
    require_team_reader,
    unprocessable,
    visible_team_ids,
)
from app.common.issue_writes import apply_patch, store_patch
from app.common.relation_effects import cancelled_status

SNOOZE_MIN = timedelta(minutes=1)

SNOOZE_MAX = timedelta(days=90)

TRIAGE_READ_CAP = 1000
"""The most waiting issues one team's inbox reads, far past any inbox worked by hand."""


def triage_settings(repositories: Repositories, workspace_id: str, team_id: str) -> TriageSettings:
    """A team's triage switch, off when the team never saved one."""
    stored = repositories.team_config.get_triage_settings(workspace_id, team_id)
    return stored or default_triage_settings(workspace_id, team_id)


def update_triage_settings(
    repositories: Repositories, workspace_id: str, team_id: str, payload: TriageSettingsUpdate
) -> TriageSettings:
    """Turn a team's triage inbox on or off; issues already waiting stay until worked."""
    current = triage_settings(repositories, workspace_id, team_id)
    changes = payload.model_dump(exclude_unset=True, exclude_none=True)
    return repositories.team_config.put_triage_settings(current.model_copy(update=changes))


def is_snoozed(issue: Issue, now: datetime) -> bool:
    """Whether a waiting issue is still hidden by its snooze."""
    return issue.snoozed_until is not None and issue.snoozed_until > now


def list_triage(
    repositories: Repositories,
    context: AuthzContext,
    team_id: str,
    *,
    snoozed: bool = False,
    cursor: Optional[str] = None,
    limit: int = 50,
) -> tuple[list[Issue], Optional[str]]:
    """One page of a team's waiting issues, newest filed first, and the next cursor.

    Snoozed issues are left out until their time passes, or listed alone with
    `snoozed`, so a snooze ends on read without any schedule.
    """
    require_team_reader(repositories, context, team_id)
    now = utc_now()
    rows = [
        issue
        for issue in repositories.issues.iter_triage(context.workspace_id, team_id, max_items=TRIAGE_READ_CAP)
        if is_snoozed(issue, now) == snoozed
    ]
    rows.sort(key=lambda issue: (issue.created_at, issue.issue_id), reverse=True)
    scope = f"triage:{context.workspace_id}:{team_id}:{snoozed}"
    offset = decode_offset_cursor(cursor, scope)
    page = rows[offset : offset + limit]
    next_offset = offset + len(page)
    next_cursor = encode_offset_cursor(next_offset, scope) if next_offset < len(rows) else None
    return current_all(repositories.teams, page), next_cursor


def triage_summary(repositories: Repositories, context: AuthzContext) -> list[TriageTeamCount]:
    """Each visible team with triage on and how many issues wait in it, snoozed ones aside."""
    enabled = set(repositories.team_config.triage_team_ids(context.workspace_id))
    now = utc_now()
    counts: list[TriageTeamCount] = []
    for team_id in visible_team_ids(repositories, context):
        if team_id not in enabled:
            continue
        waiting = repositories.issues.iter_triage(context.workspace_id, team_id, max_items=TRIAGE_READ_CAP)
        counts.append(TriageTeamCount(team_id=team_id, count=sum(1 for issue in waiting if not is_snoozed(issue, now))))
    return counts


def _waiting(repositories: Repositories, context: AuthzContext, issue_id: str) -> Issue:
    """One visible issue still in triage that the caller may work, or the 404, 403 or 422.

    Guests file into triage but never work it, so a guest cannot accept their own issue.
    """
    issue = load_visible_issue(repositories, context, issue_id)
    require_team_member(repositories, context, issue.team_id)
    if context.is_guest:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Guests cannot triage issues")
    if not issue.in_triage:
        raise unprocessable("This issue is not in triage")
    return issue


def _leave(repositories: Repositories, context: AuthzContext, issue: Issue, status_id: str, outcome: str) -> Issue:
    """Move one waiting issue to `status_id` and out of triage, recording `outcome`."""
    updated = apply_patch(repositories, context, issue, {"status_id": status_id})
    updated.in_triage = False
    updated.snoozed_until = None
    return store_patch(repositories, context, issue, updated, triage_outcome=outcome)


def first_unstarted(repositories: Repositories, workspace_id: str, team_id: str) -> Optional[str]:
    """The team's lowest-position visible `unstarted` status, or `None` when it has none."""
    rows = repositories.team_config.list_statuses(workspace_id, team_id, include_hidden=False)
    unstarted = sorted((row for row in rows if row.category == "unstarted"), key=lambda row: (row.position, row.name))
    return unstarted[0].status_id if unstarted else None


def accept(repositories: Repositories, context: AuthzContext, issue_id: str, payload: TriageAccept) -> Issue:
    """Accept a waiting issue into the team, in the named status or the first unstarted one.

    A team with no unstarted status keeps the issue's own status, so accepting
    never fails for want of a column.
    """
    issue = _waiting(repositories, context, issue_id)
    if payload.status_id:
        target = check_status(repositories, context.workspace_id, issue.team_id, payload.status_id).status_id
    else:
        target = first_unstarted(repositories, context.workspace_id, issue.team_id) or issue.status_id
    return _leave(repositories, context, issue, target, "accepted")


def decline(repositories: Repositories, context: AuthzContext, issue_id: str, payload: TriageDecline) -> Issue:
    """Decline a waiting issue to the team's first cancelled status, keeping the reason in history."""
    issue = _waiting(repositories, context, issue_id)
    target = cancelled_status(repositories, context.workspace_id, issue.team_id)
    if target is None:
        raise unprocessable("This team has no cancelled status to decline into")
    stored = _leave(repositories, context, issue, target.status_id, "declined")
    reason = (payload.reason or "").strip()
    if reason:
        repositories.activity.record(
            build_activity(
                context.workspace_id,
                stored.team_id,
                stored.issue_id,
                context.user_id,
                "field_changed",
                field="triage_reason",
                from_value=None,
                to_value=reason,
            )
        )
    return stored


def mark_duplicate(repositories: Repositories, context: AuthzContext, issue_id: str, payload: TriageDuplicate) -> Issue:
    """Close a waiting issue as a duplicate of another, through the ordinary duplicate link.

    The target is checked before anything is written, so a bad target leaves the
    issue waiting. The link then moves it to the team's cancelled status.
    """
    issue = _waiting(repositories, context, issue_id)
    if payload.duplicate_of_id == issue.issue_id:
        raise unprocessable("An issue cannot duplicate itself")
    target = repositories.issues.get(context.workspace_id, payload.duplicate_of_id)
    if target is None or not context.can_see_team(target.team_id):
        raise not_found()
    _leave(repositories, context, issue, issue.status_id, "duplicate")
    create_link(repositories, context, issue.issue_id, LinkCreate(type="duplicate_of", target_issue_id=target.issue_id))
    fresh = repositories.issues.get(context.workspace_id, issue.issue_id)
    if fresh is None:
        raise not_found()
    return fresh


def snooze(repositories: Repositories, context: AuthzContext, issue_id: str, payload: TriageSnooze) -> Issue:
    """Hide a waiting issue from the inbox until a moment, or bring it back with `null`.

    The moment must be at least a minute and at most 90 days out, the bounds the
    notification inbox's snooze keeps. Snoozing is arrangement, so it records no
    history and leaves `updated_at` alone.
    """
    issue = _waiting(repositories, context, issue_id)
    until = payload.until
    if until is not None:
        now = utc_now()
        if until < now + SNOOZE_MIN:
            raise unprocessable("until must be in the future")
        if until > now + SNOOZE_MAX:
            raise unprocessable("until must be within 90 days")
    if issue.snoozed_until == until:
        return issue
    try:
        return repositories.issues.replace(issue.model_copy(update={"snoozed_until": until}))
    except IssueWriteConflict as exc:
        raise issue_changed() from exc
    except ConditionFailed as exc:
        raise not_found() from exc
