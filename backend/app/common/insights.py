"""Insights: current-state breakdowns of the issues one scope and filter select.

Held in `common` because the views route and the MCP tool answer the same body,
and the integrations image may not import another domain's code. A breakdown is
computed in the handler from the same per-team index reads the issue list uses,
bounded by `INSIGHTS_ROW_CAP`, so it costs no new index and no precomputed rows.
Time measures read each issue's own lifecycle stamps, so they cost nothing more.
Time series need a daily snapshot and are not computed here.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field, replace
from datetime import datetime
from typing import Any, Iterable, Mapping, Optional

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.insights import (
    INSIGHT_DIMENSIONS,
    INSIGHT_MEASURES,
    INSIGHTS_ROW_CAP,
    TIME_MEASURES,
    InsightBucket,
    InsightDurations,
    InsightGroup,
    InsightPoint,
    InsightsRead,
)
from app.common.api.schemas.views import FILTER_FIELDS
from app.common.customer_index import require_customer_list_reader
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.issues import PRIORITY_ORDER, Issue, as_issue
from app.common.db.dynamo.team_config import STATUS_CATEGORIES, status_order
from app.common.estimates import estimate_points
from app.common.filter_resolution import resolve_issue_filter
from app.common.issue_filters import IssueFilter, UnknownStatusCategory, build_issue_filter, subscribed_by_caller
from app.common.issue_keyed_reads import keyed_rows
from app.common.issue_keys import current_all
from app.common.issue_rules import unprocessable
from app.common.issue_writes import archived_rows
from app.common.plan_features import Feature, enforce_feature
from app.common.saved_views import load_visible_view, require_issue_view
from app.common.sub_teams import listed_teams

PRIORITY_NAMES: dict[str, str] = {
    "urgent": "Urgent",
    "high": "High",
    "medium": "Medium",
    "low": "Low",
    "none": "No priority",
}

CATEGORY_NAMES: dict[str, str] = {
    "backlog": "Backlog",
    "unstarted": "Unstarted",
    "started": "Started",
    "completed": "Completed",
    "cancelled": "Cancelled",
}

UNSET_NAMES: dict[str, str] = {
    "assignee": "No assignee",
    "label": "No label",
    "project": "No project",
    "cycle": "No cycle",
    "estimate": "No estimate",
    "status": "Unknown status",
    "status_category": "Unknown category",
    "creator": "Unknown",
    "priority": "No priority",
    "team": "No team",
}
"""What the unset bucket of each dimension is called."""

UNKNOWN_NAMES: dict[str, str] = {
    "assignee": "Former member",
    "creator": "Former member",
    "label": "Deleted label",
    "project": "Deleted project",
    "cycle": "Deleted cycle",
    "status": "Deleted status",
    "team": "Deleted team",
}
"""What a value is called when the row it names is gone."""

NATURAL_ORDER: frozenset[str] = frozenset({"status", "status_category", "priority", "estimate"})
"""Dimensions whose bars keep their own order rather than sorting by size."""


@dataclass(frozen=True)
class InsightScope:
    """The teams a breakdown reads and every filter an issue must pass.

    `filters` holds the request's filter and, for a saved view, the view's own,
    so the two are ANDed rather than one replacing the other.
    """

    team_ids: list[str]
    filters: tuple[IssueFilter, ...]
    subscribed: bool = False
    view_id: Optional[str] = None


@dataclass
class Names:
    """Display names and colours for the values one breakdown meets."""

    labels: dict[str, str] = field(default_factory=dict)
    colors: dict[str, str] = field(default_factory=dict)
    order: dict[str, Any] = field(default_factory=dict)


def resolve_scope(
    repositories: Repositories,
    context: AuthzContext,
    wanted: IssueFilter,
    *,
    team_id: Optional[str],
    view_id: Optional[str],
    subscribed: bool,
    include_sub_teams: bool = False,
) -> InsightScope:
    """The teams and filters a breakdown runs over, deciding visibility first.

    A saved view brings its team and its live filter. A request naming a team
    other than the view's is a 422 rather than a silent pick of one of them. With
    neither a team nor a view, every active team the caller can see is read,
    and a retired one only when a team filter names it.
    `include_sub_teams` rolls the team's sub-teams in as the issue list does,
    leaving out any the caller cannot see.
    """
    filters: list[IssueFilter] = [wanted]
    if view_id:
        view = load_visible_view(repositories, context, view_id)
        require_issue_view(view)
        stored = dict(view.filter or {})
        view_team = view.team_id or _scalar(stored.get("team_id"))
        if team_id and view_team and team_id != view_team:
            raise unprocessable("team_id does not match the saved view's team")
        team_id = team_id or view_team
        view_subscribed = subscribed_by_caller(stored.get("subscriber_id"), stored.get("match"), context.user_id)
        subscribed = subscribed or view_subscribed
        skipped = ("team_id", "subscriber_id") if view_subscribed else ("team_id",)
        keys = {key: value for key, value in stored.items() if key in FILTER_FIELDS and key not in skipped}
        try:
            view_filter = build_issue_filter(user_id=context.user_id, **keys)
        except UnknownStatusCategory as exc:
            raise unprocessable(str(exc)) from exc
        if view.show_archived:
            view_filter = _with_archived(view_filter)
            filters[0] = _with_archived(wanted)
        filters.append(view_filter)

    named: frozenset[str] = frozenset().union(*(each.named_team_ids for each in filters))
    teams = listed_teams(repositories, context, team_id or None, include_sub_teams=include_sub_teams, named=named)
    return InsightScope(team_ids=teams, filters=tuple(filters), subscribed=subscribed, view_id=view_id)


def _with_archived(wanted: IssueFilter) -> IssueFilter:
    """A filter that keeps archived issues too, the way a view showing them lists them."""
    return replace(wanted, include_archived=True)


def _scalar(value: Any) -> Optional[str]:
    """One stored filter value as a string, or `None` for an absent or list value."""
    return value if isinstance(value, str) and value else None


def insight_rows(repositories: Repositories, context: AuthzContext, scope: InsightScope) -> tuple[list[Issue], bool]:
    """The issues a scope selects, at most `INSIGHTS_ROW_CAP` of them, and whether more were left unread.

    Read the way the issue list reads: a person index when one filter names one
    person, each status's archived partition for an archive, otherwise each
    team's key index. Filtering runs after the read, so the cap bounds what is
    read rather than what matches.
    """
    teams = scope.team_ids
    if not teams:
        return [], False
    require_customer_list_reader(context, any(item.needs_customers for item in scope.filters), None)
    workspace_id = context.workspace_id
    first = scope.filters[0]
    archived_only = any(item.archived_only for item in scope.filters)

    candidates: list[Issue]
    truncated = False
    keyed = keyed_rows(repositories, context, first, scope.subscribed, teams)
    if keyed is not None:
        candidates = keyed
    elif archived_only:
        candidates = archived_rows(repositories, workspace_id, teams, INSIGHTS_ROW_CAP + 1)
    else:
        candidates = []
        for candidate in teams:
            remaining = INSIGHTS_ROW_CAP + 1 - len(candidates)
            if remaining <= 0:
                truncated = True
                break
            page = repositories.issues.list_for_team(workspace_id, candidate, limit=remaining)
            candidates.extend(current_all(repositories.teams, (as_issue(item) for item in page.items)))
            if page.has_more:
                truncated = True

    if len(candidates) > INSIGHTS_ROW_CAP:
        candidates = candidates[:INSIGHTS_ROW_CAP]
        truncated = True

    filters = [resolve_issue_filter(repositories, workspace_id, teams, item) for item in scope.filters]
    categories: dict[str, str] = {}
    if any(item.needs_categories for item in filters):
        for team in teams:
            categories.update(
                {row.status_id: row.category for row in repositories.team_config.list_statuses(workspace_id, team)}
            )
    matched = [issue for issue in candidates if all(item.matches(issue, categories) for item in filters)]
    return matched, truncated


def _values_of(issue: Issue, dimension: str, categories: Mapping[str, str]) -> list[Optional[str]]:
    """The bucket keys one issue falls in for one dimension; several only for labels."""
    if dimension == "status":
        return [issue.status_id]
    if dimension == "status_category":
        return [categories.get(issue.status_id)]
    if dimension == "assignee":
        return [issue.assignee_id]
    if dimension == "creator":
        return [issue.created_by]
    if dimension == "priority":
        return [issue.priority or "none"]
    if dimension == "label":
        return list(dict.fromkeys(issue.label_ids)) or [None]
    if dimension == "project":
        return [issue.project_id]
    if dimension == "cycle":
        return [issue.cycle_id]
    if dimension == "estimate":
        return [issue.estimate or None]
    if dimension == "team":
        return [issue.team_id or None]
    raise unprocessable(f"Unknown insight dimension {dimension}")


def _names(
    repositories: Repositories, workspace_id: str, teams: list[str], dimension: str, keys: Iterable[str]
) -> Names:
    """Display names, colours and an order for the keys one dimension met.

    Each lookup reads only what its dimension needs, so a priority breakdown
    reads no configuration at all.
    """
    names = Names()
    wanted = {key for key in keys if key}
    if dimension == "status":
        rows = [row for team in teams for row in repositories.team_config.list_statuses(workspace_id, team)]
        for rank, row in enumerate(
            sorted(rows, key=lambda row: (STATUS_CATEGORIES.index(row.category), *status_order(row)))
        ):
            if row.status_id in names.labels:
                continue
            names.labels[row.status_id] = row.name
            if row.color:
                names.colors[row.status_id] = row.color
            names.order[row.status_id] = rank
    elif dimension == "status_category":
        for rank, category in enumerate(STATUS_CATEGORIES):
            names.labels[category] = CATEGORY_NAMES[category]
            names.order[category] = rank
    elif dimension == "priority":
        for key, label in PRIORITY_NAMES.items():
            names.labels[key] = label
            names.order[key] = PRIORITY_ORDER.get(key, 4)
    elif dimension == "label":
        for team in teams:
            for row in repositories.team_config.list_labels(workspace_id, team):
                names.labels.setdefault(row.label_id, row.name)
                names.colors.setdefault(row.label_id, row.color)
    elif dimension in ("assignee", "creator"):
        for user_id, user in repositories.users.get_many(sorted(wanted)).items():
            names.labels[user_id] = user.display_name or user.email.split("@", 1)[0]
    elif dimension == "project" and wanted:
        for project in repositories.planning.list_projects(workspace_id):
            if project.project_id in wanted:
                names.labels[project.project_id] = project.name
                if project.color:
                    names.colors[project.project_id] = project.color
    elif dimension == "cycle" and wanted:
        for team in teams:
            cycles, _ = repositories.planning.list_cycles(workspace_id, team, limit=500)
            for rank, cycle in enumerate(cycles):
                if cycle.cycle_id in wanted:
                    names.labels[cycle.cycle_id] = cycle.name or (f"Cycle {cycle.number}" if cycle.number else "Cycle")
                    names.order[cycle.cycle_id] = (cycle.start_date, rank)
    elif dimension == "team" and wanted:
        for team_id in sorted(wanted):
            team = repositories.teams.get(workspace_id, team_id)
            if team is not None:
                names.labels[team_id] = team.name
    elif dimension == "estimate":
        for key in wanted:
            names.labels[key] = key
            names.order[key] = (estimate_points(key), key)
    return names


def issue_hours(issue: Issue, measure: str, now: datetime) -> Optional[float]:
    """How long one issue took under a time measure, in hours, or `None` when the measure leaves it out.

    Cycle time needs both `started_at` and `completed_at`, lead time `completed_at`,
    triage time both triage stamps, and issue age keeps every issue. A negative span
    from clock skew reads as zero.
    """
    start: Optional[datetime]
    end: Optional[datetime]
    if measure == "cycle_time":
        start, end = issue.started_at, issue.completed_at
    elif measure == "lead_time":
        start, end = issue.created_at, issue.completed_at
    elif measure == "triage_time":
        start, end = issue.triage_entered_at, issue.triaged_at
    elif measure == "issue_age":
        start, end = issue.created_at, now
    else:
        return None
    if start is None or end is None:
        return None
    return max((end - start).total_seconds(), 0.0) / 3600


def percentile(ordered: list[float], share: float) -> float:
    """The `share` percentile of a sorted, non-empty list, interpolating linearly between ranks."""
    rank = (len(ordered) - 1) * share
    low = int(rank)
    high = min(low + 1, len(ordered) - 1)
    return ordered[low] + (ordered[high] - ordered[low]) * (rank - low)


def summarize_hours(hours: Iterable[float]) -> InsightDurations:
    """The count, average, quartiles, 95th percentile and range of a set of durations, rounded to 0.01 hours."""
    ordered = sorted(hours)
    if not ordered:
        return InsightDurations()

    def rounded(value: float) -> float:
        """One figure rounded to hundredths of an hour."""
        return round(value, 2)

    return InsightDurations(
        count=len(ordered),
        average=rounded(sum(ordered) / len(ordered)),
        p25=rounded(percentile(ordered, 0.25)),
        p50=rounded(percentile(ordered, 0.5)),
        p75=rounded(percentile(ordered, 0.75)),
        p95=rounded(percentile(ordered, 0.95)),
        minimum=rounded(ordered[0]),
        maximum=rounded(ordered[-1]),
    )


@dataclass
class _Tally:
    """A running sum for one bucket: its measured value, its issue count and any durations."""

    value: int = 0
    issue_count: int = 0
    hours: list[float] = field(default_factory=list)
    segments: dict[Optional[str], "_Tally"] = field(default_factory=dict)

    def add(self, amount: int, hours: Optional[float] = None) -> None:
        """Count one issue weighing `amount`, keeping its duration under a time measure."""
        self.value += amount
        self.issue_count += 1
        if hours is not None:
            self.hours.append(hours)


def _bucket_label(dimension: str, key: Optional[str], names: Names) -> str:
    """The display name of one bucket, falling back for unset and vanished values."""
    if key is None:
        return UNSET_NAMES[dimension]
    if key in names.labels:
        return names.labels[key]
    return UNKNOWN_NAMES.get(dimension, key)


def _ordered(
    dimension: str, tallies: Mapping[Optional[str], _Tally], names: Names
) -> list[tuple[Optional[str], _Tally]]:
    """Buckets in display order: natural order where the dimension has one, else biggest first, unset last."""

    def natural(item: tuple[Optional[str], _Tally]) -> Any:
        """Known values in their own order, then vanished ones, then the unset bucket."""
        key = item[0]
        if key is None:
            return (True, True, 0, "")
        if key in names.order:
            return (False, False, names.order[key], key)
        return (False, True, 0, key)

    def by_size(item: tuple[Optional[str], _Tally]) -> Any:
        """Biggest first, ties by name, the unset bucket last."""
        key, tally = item
        return (key is None, -tally.value, -tally.issue_count, _bucket_label(dimension, key, names).lower())

    natural_order = dimension in NATURAL_ORDER or dimension == "cycle"
    return sorted(tallies.items(), key=natural if natural_order else by_size)


def build_insights(
    repositories: Repositories,
    context: AuthzContext,
    scope: InsightScope,
    *,
    group_by: str,
    segment_by: Optional[str],
    measure: str,
) -> InsightsRead:
    """One breakdown: the scope's issues grouped by one dimension and optionally segmented by another.

    Under a time measure only the issues the measure covers are counted, each
    bucket carries its duration statistics, and every issue answers a point.
    """
    if segment_by == group_by:
        segment_by = None
    issues, truncated = insight_rows(repositories, context, scope)
    workspace_id = context.workspace_id
    timed = measure in TIME_MEASURES
    durations: dict[str, float] = {}
    if timed:
        now = utc_now()
        for issue in issues:
            hours = issue_hours(issue, measure, now)
            if hours is not None:
                durations[issue.issue_id] = hours
        issues = [issue for issue in issues if issue.issue_id in durations]

    categories: dict[str, str] = {}
    if "status_category" in (group_by, segment_by):
        for team in scope.team_ids:
            categories.update(
                {row.status_id: row.category for row in repositories.team_config.list_statuses(workspace_id, team)}
            )

    def weigh(issue: Issue) -> int:
        """What one issue adds to a bucket under the chosen measure."""
        return estimate_points(issue.estimate) if measure == "points" else 1

    tallies: dict[Optional[str], _Tally] = defaultdict(_Tally)
    segment_keys: set[str] = set()
    points: list[InsightPoint] = []
    total = 0
    for issue in issues:
        amount = weigh(issue)
        hours = durations.get(issue.issue_id)
        total += amount
        segments = _values_of(issue, segment_by, categories) if segment_by else []
        for key in _values_of(issue, group_by, categories):
            tally = tallies[key]
            tally.add(amount, hours)
            for segment in segments:
                tally.segments.setdefault(segment, _Tally()).add(amount, hours)
                if segment:
                    segment_keys.add(segment)
            if hours is not None:
                points.append(
                    InsightPoint(
                        issue_id=issue.issue_id,
                        key=issue.key,
                        title=issue.title,
                        group=key,
                        segment=segments[0] if segments else None,
                        hours=round(hours, 2),
                    )
                )

    group_names = _names(repositories, workspace_id, scope.team_ids, group_by, (k for k in tallies if k))
    segment_names = (
        _names(repositories, workspace_id, scope.team_ids, segment_by, segment_keys) if segment_by else Names()
    )

    groups: list[InsightGroup] = []
    for key, tally in _ordered(group_by, tallies, group_names):
        groups.append(
            InsightGroup(
                key=key,
                label=_bucket_label(group_by, key, group_names),
                color=group_names.colors.get(key) if key else None,
                value=tally.value,
                issue_count=tally.issue_count,
                durations=summarize_hours(tally.hours) if timed else None,
                segments=[
                    InsightBucket(
                        key=segment_key,
                        label=_bucket_label(segment_by, segment_key, segment_names),
                        color=segment_names.colors.get(segment_key) if segment_key else None,
                        value=segment.value,
                        issue_count=segment.issue_count,
                        durations=summarize_hours(segment.hours) if timed else None,
                    )
                    for segment_key, segment in _ordered(segment_by, tally.segments, segment_names)
                ]
                if segment_by
                else [],
            )
        )

    return InsightsRead(
        team_ids=scope.team_ids,
        view_id=scope.view_id,
        group_by=group_by,  # pyright: ignore[reportArgumentType]
        segment_by=segment_by,  # pyright: ignore[reportArgumentType]
        measure=measure,  # pyright: ignore[reportArgumentType]
        total=total,
        issue_count=len(issues),
        groups=groups,
        truncated=truncated,
        row_cap=INSIGHTS_ROW_CAP,
        durations=summarize_hours(durations.values()) if timed else None,
        points=points,
    )


def is_plain_count(group_by: str, segment_by: Optional[str], measure: str) -> bool:
    """Whether a breakdown is only the issue count by status category, the tally every plan's view list shows."""
    return group_by == "status_category" and segment_by is None and measure == "count"


def require_insights(
    repositories: Repositories, context: AuthzContext, group_by: str, segment_by: Optional[str], measure: str
) -> None:
    """Refuse a breakdown beyond the plain count unless the workspace's plan includes Insights."""
    if is_plain_count(group_by, segment_by, measure):
        return
    enforce_feature(repositories, context.workspace_id, Feature.INSIGHTS)


def insights_for(
    repositories: Repositories,
    context: AuthzContext,
    *,
    team_id: Optional[str],
    view_id: Optional[str],
    subscriber_id: Any,
    group_by: str,
    segment_by: Optional[str],
    measure: str,
    filters: Mapping[str, Any],
    include_sub_teams: bool = False,
) -> InsightsRead:
    """A breakdown from wire values, the one entry point the route and the MCP tool share.

    `filters` carries the issue list's filter parameters by their wire names, so a
    breakdown accepts exactly what the list accepts and means the same by it.
    """
    if group_by not in INSIGHT_DIMENSIONS:
        raise unprocessable(f"group_by must be one of: {', '.join(INSIGHT_DIMENSIONS)}")
    if segment_by is not None and segment_by not in INSIGHT_DIMENSIONS:
        raise unprocessable(f"segment_by must be one of: {', '.join(INSIGHT_DIMENSIONS)}")
    if measure not in INSIGHT_MEASURES:
        raise unprocessable(f"measure must be one of: {', '.join(INSIGHT_MEASURES)}")
    require_insights(repositories, context, group_by, segment_by, measure)
    subscribed = subscribed_by_caller(subscriber_id, filters.get("match"), context.user_id)
    if subscriber_id is not None and not subscribed:
        filters = {**filters, "subscriber_id": subscriber_id}
    try:
        wanted = build_issue_filter(user_id=context.user_id, **filters)
    except UnknownStatusCategory as exc:
        raise unprocessable(str(exc)) from exc
    scope = resolve_scope(
        repositories,
        context,
        wanted,
        team_id=team_id,
        view_id=view_id,
        subscribed=subscribed,
        include_sub_teams=include_sub_teams,
    )
    return build_insights(repositories, context, scope, group_by=group_by, segment_by=segment_by, measure=measure)


def stored_issue_filter(context: AuthzContext, stored: Mapping[str, Any]) -> tuple[IssueFilter, bool]:
    """A filter as a saved view or a dashboard stores it, and whether it means the caller's own subscriptions.

    A stored `team_id` narrows rather than scopes here, read as `team_id_in`, so
    a dashboard filter naming a team keeps only that team's issues in every
    widget without moving any widget's source.
    """
    subscribed = subscribed_by_caller(stored.get("subscriber_id"), stored.get("match"), context.user_id)
    keys = {key: value for key, value in stored.items() if key in FILTER_FIELDS and key != "team_id"}
    if subscribed:
        keys.pop("subscriber_id", None)
    team = _scalar(stored.get("team_id"))
    if team and "team_id_in" not in keys:
        keys["team_id_in"] = [team]
    try:
        return build_issue_filter(user_id=context.user_id, **keys), subscribed
    except UnknownStatusCategory as exc:
        raise unprocessable(str(exc)) from exc


def combined_insights(
    repositories: Repositories,
    context: AuthzContext,
    *,
    team_id: Optional[str],
    view_id: Optional[str],
    stored_filters: Iterable[Mapping[str, Any]],
    group_by: str,
    segment_by: Optional[str],
    measure: str,
    include_sub_teams: bool = False,
) -> InsightsRead:
    """A breakdown over a team, a view or the workspace with several stored filters all applied.

    The dashboard widget's entry point: the widget's own filter and the
    dashboard's are each kept whole and ANDed, so neither can widen the other,
    and visibility is decided by the same scope resolution the insights route uses.
    """
    built: list[IssueFilter] = []
    subscribed = False
    for stored in stored_filters:
        wanted, mine = stored_issue_filter(context, stored)
        built.append(wanted)
        subscribed = subscribed or mine
    first = built[0] if built else build_issue_filter(user_id=context.user_id)
    scope = resolve_scope(
        repositories,
        context,
        first,
        team_id=team_id,
        view_id=view_id,
        subscribed=subscribed,
        include_sub_teams=include_sub_teams,
    )
    extra = built[1:]
    if scope.filters[0].include_archived:
        extra = [_with_archived(item) for item in extra]
    scope = replace(scope, filters=(*scope.filters, *extra))
    return build_insights(repositories, context, scope, group_by=group_by, segment_by=segment_by, measure=measure)
