"""A team's triage inbox: its settings, its list and the four ways an issue leaves it.

Held in `common` because the issue routes, the team routes and the MCP tools in
the integrations image all run it, and that image may not import another
domain's code. An issue awaiting triage keeps an ordinary status but sits in its
team's own partition of the status index, so the inbox is one key read and no
board column sees it. Accepting, declining and marking as duplicate go through
the same patch path a person's edit does, so the history reads the same.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Optional

from fastapi import HTTPException, status
from webbpulse.dynamodb import ConditionFailed

from app.common import audit
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
from app.common.change_source import EMAIL, SLACK
from app.common.comment_writes import create_comment
from app.common.db.dynamo.activity import build_activity
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.issues import Issue, IssueWriteConflict
from app.common.db.dynamo.team_config import TriageSettings, default_triage_settings
from app.common.db.dynamo.teams import Team
from app.common.issue_keys import current_all
from app.common.issue_links import create_link
from app.common.issue_privacy import can_see_issue, issue_reader
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
from app.common.plan_features import Feature, enforce_feature
from app.common.relation_effects import cancelled_status
from app.common.triage_duty import can_be_on_duty, require_priority
from app.common.triage_rules import saved_rules

SNOOZE_MIN = timedelta(minutes=1)

SNOOZE_MAX = timedelta(days=90)

TRIAGE_READ_CAP = 1000
"""The most waiting issues one team's inbox reads, far past any inbox worked by hand."""


AUDITED_FIELDS: tuple[str, ...] = (
    "enabled",
    "responsible_user_ids",
    "responsibility_action",
    "require_priority",
    "rules",
)
"""The triage settings a change to is recorded in the audit log."""


def triage_settings(repositories: Repositories, workspace_id: str, team_id: str) -> TriageSettings:
    """A team's triage settings, off with nobody on duty when the team never saved any."""
    stored = repositories.team_config.get_triage_settings(workspace_id, team_id)
    return stored or default_triage_settings(workspace_id, team_id)


def _audited(settings: TriageSettings) -> dict[str, Any]:
    """The audited fields of one settings row, as the audit log stores them."""
    return settings.model_dump(mode="json", include=set(AUDITED_FIELDS))


def update_triage_settings(
    repositories: Repositories, context: AuthzContext, team: Team, payload: TriageSettingsUpdate
) -> TriageSettings:
    """Change a team's triage settings; issues already waiting stay until worked.

    Turning it on needs a plan that includes triage. Turning it off never does, so
    a downgrade never traps a team with an inbox it cannot switch off. Everyone
    put on duty must be a workspace member other than a guest who can see the
    team, since duty may assign them issues there. `rules` replaces the whole
    ordered list, each rule checked against the team. The change is audited.
    """
    workspace_id = context.workspace_id
    current = triage_settings(repositories, workspace_id, team.team_id)
    changes = payload.model_dump(exclude_unset=True, exclude_none=True, exclude={"rules"})
    if payload.rules is not None:
        changes["rules"] = saved_rules(repositories, workspace_id, team.team_id, current.rules, payload.rules)
    if changes.get("enabled") is True and not current.enabled:
        enforce_feature(repositories, workspace_id, Feature.TRIAGE)
    for user_id in changes.get("responsible_user_ids", []):
        if user_id not in current.responsible_user_ids and not can_be_on_duty(
            repositories, workspace_id, team.team_id, user_id
        ):
            raise unprocessable("Everyone on triage duty must be a member who can see this team")
    saved = repositories.team_config.put_triage_settings(current.model_copy(update=changes))
    audit.record_triage_change(repositories, context, team, _audited(current), _audited(saved))
    return saved


def is_snoozed(issue: Issue, now: datetime) -> bool:
    """Whether a waiting issue is still hidden by its snooze."""
    return issue.snoozed_until is not None and issue.snoozed_until > now


REQUESTER_NONE = "none"
"""The requester source value that matches issues filed with no requester."""

REQUESTER_ME = "me"
"""The requester member value that means the caller."""

REQUESTER_SOURCES: tuple[str, ...] = (SLACK, EMAIL, REQUESTER_NONE)
"""The requester sources the triage list narrows to."""


@dataclass(frozen=True)
class RequesterFilter:
    """Which requester a triage list keeps: a linked member, a Slack user, a source, or any mix of them.

    Every field set must hold, so `source=slack` with a Slack user id keeps only
    that person's Slack asks. `source=none` keeps the issues no intake filed for
    anyone. An empty filter keeps every issue.
    """

    user_id: Optional[str] = None
    slack_user_id: Optional[str] = None
    source: Optional[str] = None

    def is_empty(self) -> bool:
        """Whether the filter keeps every issue."""
        return self.user_id is None and self.slack_user_id is None and self.source is None

    def matches(self, issue: Issue) -> bool:
        """Whether one waiting issue's requester passes every condition set."""
        requester = issue.requester
        if self.source == REQUESTER_NONE:
            return requester is None and self.user_id is None and self.slack_user_id is None
        if self.source is not None and (requester is None or requester.source != self.source):
            return False
        if self.user_id is not None and (requester is None or requester.user_id != self.user_id):
            return False
        if self.slack_user_id is not None and (
            requester is None or requester.source != SLACK or requester.external_id != self.slack_user_id
        ):
            return False
        return True

    def scope(self) -> str:
        """The filter as it is folded into the cursor scope, so a cursor never serves another filter."""
        return f"{self.user_id or ''}|{self.slack_user_id or ''}|{self.source or ''}"


def requester_filter(
    context: AuthzContext,
    *,
    user_id: Optional[str] = None,
    slack_user_id: Optional[str] = None,
    source: Optional[str] = None,
) -> RequesterFilter:
    """The requester filter a caller asked for, `me` read as the caller and an unknown source refused with a 422."""
    if source is not None and source not in REQUESTER_SOURCES:
        raise unprocessable(f"requester_source must be one of {', '.join(REQUESTER_SOURCES)}")
    member = context.user_id if user_id == REQUESTER_ME else (user_id or None)
    return RequesterFilter(user_id=member, slack_user_id=slack_user_id or None, source=source or None)


def list_triage(
    repositories: Repositories,
    context: AuthzContext,
    team_id: str,
    *,
    snoozed: bool = False,
    requester: Optional[RequesterFilter] = None,
    cursor: Optional[str] = None,
    limit: int = 50,
) -> tuple[list[Issue], Optional[str]]:
    """One page of a team's waiting issues, newest filed first, and the next cursor.

    Snoozed issues are left out until their time passes, or listed alone with
    `snoozed`, so a snooze ends on read without any schedule. `requester`
    narrows the inbox to who asked before it is paged, so every page holds
    only matching issues.
    """
    require_team_reader(repositories, context, team_id)
    now = utc_now()
    wanted = requester or RequesterFilter()
    readable = issue_reader(repositories, context)
    rows = [
        issue
        for issue in repositories.issues.iter_triage(context.workspace_id, team_id, max_items=TRIAGE_READ_CAP)
        if is_snoozed(issue, now) == snoozed and wanted.matches(issue) and readable(issue)
    ]
    rows.sort(key=lambda issue: (issue.created_at, issue.issue_id), reverse=True)
    scope = f"triage:{context.workspace_id}:{team_id}:{snoozed}"
    if not wanted.is_empty():
        scope = f"{scope}:{wanted.scope()}"
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
    readable = issue_reader(repositories, context)
    for team_id in visible_team_ids(repositories, context):
        if team_id not in enabled:
            continue
        waiting = repositories.issues.iter_triage(context.workspace_id, team_id, max_items=TRIAGE_READ_CAP)
        counts.append(
            TriageTeamCount(
                team_id=team_id, count=sum(1 for issue in waiting if not is_snoozed(issue, now) and readable(issue))
            )
        )
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


def _leave(
    repositories: Repositories,
    context: AuthzContext,
    issue: Issue,
    status_id: str,
    outcome: str,
    extra: Optional[dict[str, Any]] = None,
) -> Issue:
    """Move one waiting issue to `status_id` and out of triage, recording `outcome`.

    `extra` names further fields the same write sets, such as the priority an
    accept carries. Only an accept is held to the team's require-priority rule.
    """
    attributes = {"status_id": status_id, **(extra or {})}
    updated = apply_patch(repositories, context, issue, attributes, accepting=outcome == "accepted")
    updated.in_triage = False
    updated.snoozed_until = None
    updated.snoozed_by = None
    return store_patch(repositories, context, issue, updated, triage_outcome=outcome)


def first_unstarted(repositories: Repositories, workspace_id: str, team_id: str) -> Optional[str]:
    """The team's lowest-position visible `unstarted` status, or `None` when it has none."""
    rows = repositories.team_config.list_statuses(workspace_id, team_id, include_hidden=False)
    unstarted = sorted((row for row in rows if row.category == "unstarted"), key=lambda row: (row.position, row.name))
    return unstarted[0].status_id if unstarted else None


def accept(repositories: Repositories, context: AuthzContext, issue_id: str, payload: TriageAccept) -> Issue:
    """Accept a waiting issue into the team, in the named status or the first unstarted one.

    A team with no unstarted status keeps the issue's own status, so accepting
    never fails for want of a column. A comment rides along as an ordinary
    comment by the person accepting, posted after the move so the thread reads
    the accept first, with the same mentions and subscriptions a typed one gets.
    A priority is set in the same write, and a team that requires one refuses an
    accept that leaves the issue without it, whatever status it names.
    """
    issue = _waiting(repositories, context, issue_id)
    if payload.status_id:
        target = check_status(repositories, context.workspace_id, issue.team_id, payload.status_id).status_id
    else:
        target = first_unstarted(repositories, context.workspace_id, issue.team_id) or issue.status_id
    extra = {"priority": payload.priority} if payload.priority is not None else {}
    if (payload.priority or issue.priority) == "none":
        require_priority(repositories, context.workspace_id, issue.team_id, "none")
    stored = _leave(repositories, context, issue, target, "accepted", extra)
    if payload.comment:
        create_comment(repositories, context, stored.issue_id, payload.comment)
    return stored


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
    if target is None or not can_see_issue(repositories, context, target):
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
    history and leaves `updated_at` alone. The caller is kept as `snoozed_by`, so
    a comment from anyone else brings the issue back early (`triage_wake`).
    """
    issue = _waiting(repositories, context, issue_id)
    until = payload.until
    if until is not None:
        now = utc_now()
        if until < now + SNOOZE_MIN:
            raise unprocessable("until must be in the future")
        if until > now + SNOOZE_MAX:
            raise unprocessable("until must be within 90 days")
    snoozed_by = context.user_id if until is not None else None
    if issue.snoozed_until == until and issue.snoozed_by == snoozed_by:
        return issue
    try:
        return repositories.issues.replace(issue.model_copy(update={"snoozed_until": until, "snoozed_by": snoozed_by}))
    except IssueWriteConflict as exc:
        raise issue_changed() from exc
    except ConditionFailed as exc:
        raise not_found() from exc
