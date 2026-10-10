"""The workspace home: one read that answers everything the landing page draws.

Assembled from the same services the individual pages use, so the home never
disagrees with My issues, a cycle, a project or the inbox about what it shows.
Every section is bounded: a fixed number of rows per list, the caller's own
teams for the team sections, and a short window for what shipped and what was
said, so the read costs the same on a quiet workspace and a busy one.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date, datetime, timedelta
from typing import Optional

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.home import (
    FocusReason,
    HomeAttentionItem,
    HomeFocusRead,
    HomeInboxRead,
    HomePullRequestItem,
    HomePulseItem,
    HomeRead,
    HomeShippedItem,
    HomeShippedRead,
)
from app.common.api.schemas.issues import IssueRead, PullRequestSummaryEntryRead, PullRequestSummaryRead
from app.common.api.schemas.planning import CycleRead, ProjectRead, ProjectUpdateRead
from app.common.api.schemas.releases import ReleaseRead
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.planning import Project
from app.common.db.dynamo.releases import default_pipeline
from app.common.inbox import list_notifications
from app.common.issue_filters import ME, build_issue_filter
from app.common.issue_keys import current
from app.common.issue_rules import status_categories, visible_team_ids
from app.common.issue_writes import list_issues
from app.common.planning_rules import counts_unestimated, visible_project_teams
from app.common.project_cadence import workspace_interval
from app.common.sla import sla_status
from app.common.standup import DUE_SOON_DAYS, StandupWindowError, resolve_zone

FOCUS_READ_LIMIT = 100
"""How many open assigned issues the focus section reads before it reports `truncated`."""

ATTENTION_LIMIT = 8
"""How many issues the needs attention group lists."""

IN_PROGRESS_LIMIT = 10
"""How many issues the in progress group lists."""

UP_NEXT_LIMIT = 6
"""How many issues the up next group lists."""

PROJECT_LIMIT = 8
"""How many in-flight projects the home lists."""

SHIPPED_DAYS = 7
"""How far back what shipped looks."""

SHIPPED_LIMIT = 10
"""How many shipped issues the home lists."""

SHIPPED_FEED_ROWS = 2000
"""How many activity rows one team's shipped window reads at most."""

PULSE_DAYS = 14
"""How far back the pulse looks for project updates."""

PULSE_LIMIT = 5
"""How many project updates the pulse lists."""

INBOX_LIMIT = 5
"""How many unread notifications the home lists."""

PULL_REQUEST_LIMIT = 8
"""How many open pull requests on the caller's issues the home lists."""

RELEASE_LIMIT = 6
"""How many recent releases the home lists."""

RELEASE_READ_ROWS = 20
"""How many of each team's newest releases the home reads looking for recent ones."""

OPEN_PULL_REQUEST_STATES = ("open", "draft")
"""The pull request states the home counts as still in flight."""

PRIORITY_RANK: dict[str, int] = {"urgent": 0, "high": 1, "medium": 2, "low": 3, "none": 4}
"""Priority order for the focus lists, urgent first and unset last."""

ACTIVE_PROJECT_STATUSES: dict[str, int] = {"in_progress": 0, "planned": 1}
"""The project statuses the home lists, in the order it lists them."""

OPEN_FOCUS_CATEGORIES = ("completed", "cancelled")
"""The status categories the focus section leaves out."""


CategoryLookup = Callable[[str], dict[str, str]]
"""Status id to category for one team, read once per request."""


class UnknownTimezone(ValueError):
    """The caller named a timezone that is not an IANA zone."""


def home_for(
    repositories: Repositories,
    context: AuthzContext,
    *,
    timezone: str = "UTC",
    now: Optional[datetime] = None,
) -> HomeRead:
    """Every section of the workspace home for the caller, with `today` in their timezone.

    Raises `UnknownTimezone` for a zone name the zone database does not know.
    """
    try:
        zone = resolve_zone(timezone)
    except StandupWindowError as exc:
        raise UnknownTimezone(str(exc)) from exc
    moment = now or utc_now()
    today = moment.astimezone(zone).date()
    visible = visible_team_ids(repositories, context)
    scope = _scope_teams(repositories, context, visible)
    categories: dict[str, dict[str, str]] = {}

    def team_categories(team_id: str) -> dict[str, str]:
        """One team's status categories, read once per request."""
        if team_id not in categories:
            categories[team_id] = status_categories(repositories, context.workspace_id, team_id)
        return categories[team_id]

    projects = repositories.planning.list_projects(context.workspace_id) if visible else []
    shown_projects = [(project, visible_project_teams(project, visible)) for project in projects]
    shown_projects = [(project, teams) for project, teams in shown_projects if teams]
    active_projects = _active_projects(shown_projects)
    interval = workspace_interval(repositories.workspaces, context.workspace_id) if active_projects else 0

    focus, assigned = _focus(repositories, context, today, team_categories) if visible else (_empty_focus(), [])
    return HomeRead(
        generated_at=moment,
        today=today.isoformat(),
        team_ids=scope,
        focus=focus,
        cycles=_cycles(repositories, context, scope, today),
        projects=[
            ProjectRead.from_row(project, teams, default_interval_days=interval, now=moment)
            for project, teams in active_projects[:PROJECT_LIMIT]
        ],
        projects_total=len(active_projects),
        shipped=_shipped(repositories, context, scope, moment, team_categories),
        pulse=_pulse(repositories, context, shown_projects, moment),
        inbox=_inbox(repositories, context),
        pull_requests=_pull_requests(assigned),
        releases=_releases(repositories, context, scope, moment),
    )


def _scope_teams(repositories: Repositories, context: AuthzContext, visible: list[str]) -> list[str]:
    """The caller's own teams they can see, or every visible team when they belong to none."""
    if not visible:
        return []
    allowed = set(visible)
    rows = repositories.memberships.list_team_memberships_for_user(context.workspace_id, context.user_id)
    mine = sorted({row.team_id for row in rows if row.team_id and row.team_id in allowed})
    return mine or list(visible)


def _empty_focus() -> HomeFocusRead:
    """The focus section of a caller who can see no team."""
    return HomeFocusRead(open_count=0, attention_count=0, in_progress_count=0, up_next_count=0)


def _reasons(issue: Issue, today: date) -> list[FocusReason]:
    """Every reason one open issue needs attention today, most pressing first."""
    reasons: list[FocusReason] = []
    if issue.due_date and issue.due_date < today.isoformat():
        reasons.append("overdue")
    elif issue.due_date and issue.due_date <= (today + timedelta(days=DUE_SOON_DAYS)).isoformat():
        reasons.append("due_soon")
    sla = sla_status(issue)
    if sla == "breached":
        reasons.append("sla_breached")
    elif sla == "at_risk":
        reasons.append("sla_at_risk")
    if issue.blocked_by_open_count > 0:
        reasons.append("blocked")
    return reasons


REASON_RANK: dict[str, int] = {"overdue": 0, "sla_breached": 1, "due_soon": 2, "sla_at_risk": 3, "blocked": 4}
"""How pressing each reason is, lower first, for ordering the attention group."""


def _priority_key(issue: Issue) -> tuple[int, float]:
    """Priority first, then most recently touched."""
    return (PRIORITY_RANK.get(issue.priority, 4), -issue.updated_at.timestamp())


def _focus(
    repositories: Repositories,
    context: AuthzContext,
    today: date,
    team_categories: CategoryLookup,
) -> tuple[HomeFocusRead, list[Issue]]:
    """The caller's open assigned issues, grouped into attention, in progress and up next, and the rows read."""
    wanted = build_issue_filter(
        user_id=context.user_id, assignee_id=[ME], status_category_not=list(OPEN_FOCUS_CATEGORIES)
    )
    rows, next_cursor = list_issues(
        repositories, context, wanted, team_id=None, sort="priority_desc", cursor=None, limit=FOCUS_READ_LIMIT
    )
    attention: list[tuple[Issue, list[FocusReason]]] = []
    in_progress: list[Issue] = []
    up_next: list[Issue] = []
    for issue in rows:
        reasons = _reasons(issue, today)
        category = team_categories(issue.team_id).get(issue.status_id)
        if reasons:
            attention.append((issue, reasons))
        elif category == "started":
            in_progress.append(issue)
        elif category == "unstarted":
            up_next.append(issue)
    attention.sort(
        key=lambda pair: (
            min(REASON_RANK[reason] for reason in pair[1]),
            pair[0].due_date or "9999-99-99",
            _priority_key(pair[0]),
        )
    )
    in_progress.sort(key=_priority_key)
    up_next.sort(key=_priority_key)
    focus = HomeFocusRead(
        open_count=len(rows),
        truncated=next_cursor is not None,
        attention_count=len(attention),
        in_progress_count=len(in_progress),
        up_next_count=len(up_next),
        attention=[
            HomeAttentionItem(issue=IssueRead.from_row(issue), reasons=reasons)
            for issue, reasons in attention[:ATTENTION_LIMIT]
        ],
        in_progress=[IssueRead.from_row(issue) for issue in in_progress[:IN_PROGRESS_LIMIT]],
        up_next=[IssueRead.from_row(issue) for issue in up_next[:UP_NEXT_LIMIT]],
    )
    return focus, rows


def _cycles(repositories: Repositories, context: AuthzContext, scope: list[str], today: date) -> list[CycleRead]:
    """The active cycle of each team in scope, soonest ending first."""
    day = today.isoformat()
    found: list[CycleRead] = []
    for team_id in scope:
        active = [
            cycle
            for cycle in repositories.planning.list_for_roadmap(context.workspace_id, team_id)
            if cycle.status(day) == "active"
        ]
        if not active:
            continue
        unestimated = counts_unestimated(repositories, context.workspace_id, team_id)
        found.extend(CycleRead.from_row(cycle, day, count_unestimated=unestimated) for cycle in active)
    return sorted(found, key=lambda cycle: (cycle.end_date, cycle.team_id, cycle.cycle_id))


def _active_projects(shown: list[tuple[Project, list[str]]]) -> list[tuple[Project, list[str]]]:
    """The in-flight projects the caller can see, started before planned, then by target date."""
    active = [(project, teams) for project, teams in shown if project.status in ACTIVE_PROJECT_STATUSES]
    return sorted(
        active,
        key=lambda pair: (
            ACTIVE_PROJECT_STATUSES[pair[0].status],
            pair[0].target_date or "9999-99-99",
            pair[0].name.lower(),
            pair[0].project_id,
        ),
    )


def _shipped(
    repositories: Repositories,
    context: AuthzContext,
    scope: list[str],
    moment: datetime,
    team_categories: CategoryLookup,
) -> HomeShippedRead:
    """Issues moved into a completed status in the window that are still completed, newest first.

    Read off each team's activity feed, the same record the standup digest credits
    from, because an issue keeps no completion time of its own.
    """
    since = moment - timedelta(days=SHIPPED_DAYS)
    completed: dict[str, tuple[datetime, Optional[str], str]] = {}
    for team_id in scope:
        lookup = team_categories(team_id)
        feed = repositories.activity.iter_team_feed(
            context.workspace_id, team_id, since, moment, max_items=SHIPPED_FEED_ROWS
        )
        for row in feed:
            if row.kind != "field_changed" or row.field != "status_id":
                continue
            if lookup.get(str(row.to_value or "")) != "completed":
                continue
            actor = row.actor_id if row.actor_kind == "user" and row.actor_id else None
            held = completed.get(row.issue_id)
            if held is None or row.created_at >= held[0]:
                completed[row.issue_id] = (row.created_at, actor, team_id)
    if not completed:
        return HomeShippedRead(since=since, count=0, mine=0)
    issues = repositories.issues.get_many(context.workspace_id, list(completed))
    items: list[HomeShippedItem] = []
    for issue_id, (at, actor, _) in completed.items():
        issue = issues.get(issue_id)
        if issue is None or not context.can_see_team(issue.team_id):
            continue
        if team_categories(issue.team_id).get(issue.status_id) != "completed":
            continue
        items.append(
            HomeShippedItem(
                issue=IssueRead.from_row(current(repositories.teams, issue)),
                completed_at=at,
                completed_by=actor or issue.assignee_id,
            )
        )
    items.sort(key=lambda item: (item.completed_at, item.issue.id), reverse=True)
    mine = sum(1 for item in items if item.completed_by == context.user_id)
    return HomeShippedRead(since=since, count=len(items), mine=mine, items=items[:SHIPPED_LIMIT])


def _pulse(
    repositories: Repositories,
    context: AuthzContext,
    shown: list[tuple[Project, list[str]]],
    moment: datetime,
) -> list[HomePulseItem]:
    """The newest update of each visible project updated in the window, newest first."""
    since = moment - timedelta(days=PULSE_DAYS)
    recent = [project for project, _ in shown if project.last_update_at is not None and project.last_update_at >= since]
    recent.sort(key=lambda project: (project.last_update_at, project.project_id), reverse=True)
    found: list[HomePulseItem] = []
    for project in recent[:PULSE_LIMIT]:
        update = repositories.planning.latest_project_update(context.workspace_id, project.project_id)
        if update is None:
            continue
        found.append(
            HomePulseItem(
                project_id=project.project_id,
                project_name=project.name,
                update=ProjectUpdateRead.from_row(update, can_edit=False),
            )
        )
    return found


def _inbox(repositories: Repositories, context: AuthzContext) -> HomeInboxRead:
    """The caller's unread count and newest unread notifications."""
    items, _ = list_notifications(repositories, context, unread=True, snoozed=False, cursor=None, limit=INBOX_LIMIT)
    return HomeInboxRead(
        unread_count=repositories.inbox.unread_count(context.workspace_id, context.user_id),
        items=items,
    )


REVIEW_RANK: dict[str, int] = {"changes_requested": 0, "approved": 1, "pending": 2, "none": 3}
"""How soon an open pull request wants the caller, lower first: changes asked for, then ready to merge."""


def _pull_request_key(pair: tuple[Issue, PullRequestSummaryEntryRead]) -> tuple[int, int, int, float]:
    """Open before draft, failing checks and requested changes first, then most recently touched issue."""
    issue, entry = pair
    return (
        1 if entry.state == "draft" else 0,
        0 if entry.ci_state == "failure" else 1,
        REVIEW_RANK.get(entry.review_state, 3),
        -issue.updated_at.timestamp(),
    )


def _pull_requests(assigned: list[Issue]) -> list[HomePullRequestItem]:
    """Open and draft pull requests linked to the caller's open assigned issues, one row per pull request.

    Read off the summary each issue row already carries, so this costs no read of
    its own. A pull request linked to several of the caller's issues is listed
    once, under the issue touched most recently.
    """
    found: dict[tuple[str, int], tuple[Issue, PullRequestSummaryEntryRead]] = {}
    for issue in assigned:
        summary = PullRequestSummaryRead.from_summary(issue.pull_request_summary)
        if summary is None:
            continue
        for entry in summary.pull_requests:
            if entry.state not in OPEN_PULL_REQUEST_STATES:
                continue
            key = (entry.repository_full_name, entry.number)
            held = found.get(key)
            if held is None or issue.updated_at > held[0].updated_at:
                found[key] = (issue, entry)
    ordered = sorted(found.values(), key=_pull_request_key)
    return [
        HomePullRequestItem(issue=IssueRead.from_row(issue), pull_request=entry)
        for issue, entry in ordered[:PULL_REQUEST_LIMIT]
    ]


def _releases(
    repositories: Repositories,
    context: AuthzContext,
    scope: list[str],
    moment: datetime,
) -> list[ReleaseRead]:
    """Releases of the teams in scope that reached their pipeline's last stage in the window, newest first.

    Reads each team's pipeline and its newest few releases, so the cost is two
    reads a team however many releases it keeps.
    """
    since = moment - timedelta(days=SHIPPED_DAYS)
    found: list[ReleaseRead] = []
    for team_id in scope:
        stored = repositories.releases.get_pipeline(context.workspace_id, team_id)
        pipeline = stored if stored is not None and stored.stages else None
        pipeline = pipeline or default_pipeline(context.workspace_id, team_id)
        final = pipeline.stages[-1].stage_id
        rows, _ = repositories.releases.list_for_team(context.workspace_id, team_id, limit=RELEASE_READ_ROWS)
        for row in rows:
            read = ReleaseRead.from_row(row, pipeline)
            stage = read.current_stage
            if stage is None or stage.stage_id != final or stage.reached_at < since:
                continue
            found.append(read)
    found.sort(
        key=lambda read: (read.current_stage.reached_at if read.current_stage else since, read.release_id), reverse=True
    )
    return found[:RELEASE_LIMIT]
