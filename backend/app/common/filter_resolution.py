"""Resolving the parts of an issue filter that need a read beyond the issue rows.

`build_issue_filter` turns wire values into a filter without touching a table, so
it can run anywhere a filter is parsed. Some parts of a filter cannot be decided
from the row alone: a relative cycle such as `current` names a different cycle in
each team and on each day, a relation filter needs the workspace's links, and a
subscriber filter needs each named person's subscriptions, and `my_teams` needs
the viewer's team memberships, and an "Added to cycle" phase needs each cycle's
start in its team's timezone. Every
list, export, insight and share read runs the filter through here once, after it
knows which teams it fans out over, so they all agree on what a filter selects.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import date, datetime
from typing import TYPE_CHECKING, Iterable, Mapping, Optional

from fastapi import HTTPException, status

from app.common.customer_index import CUSTOMER_SORTS, REVENUE_SORT, CustomerIndex, load_customer_index
from app.common.cycle_added import cycle_start_instant
from app.common.cycle_schedule import RELATIVE_CYCLES, relative_cycle
from app.common.db.dynamo.planning import Cycle
from app.common.issue_filters import MY_TEAMS, FilterValues, IssueFilter
from app.common.team_time import team_timezone, teams_today

if TYPE_CHECKING:
    from app.common.api.dependencies.repositories import Repositories

NO_CYCLE_MATCH = "\x00no-cycle"
"""A cycle id no issue carries, standing in for a relative cycle a team does not have.

Kept in the set rather than dropping the value, because an empty set means the
filter is absent and would select every issue instead of none.
"""

NO_TEAM_MATCH = "\x00no-team"
"""A team id no issue carries, standing in for `my_teams` when the viewer belongs to no team."""

TEAM_CYCLE_LIMIT = 500
"""The most cycles one team's read takes, far past any schedule a team keeps."""

SUBSCRIPTION_READ_CAP = 5000
"""The most subscribed issue ids one person's read takes for a subscriber filter."""


def unknown_cycle(value: str) -> HTTPException:
    """The 400 a cycle value naming no cycle of the teams answers, naming the value."""
    return HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail={
            "error_code": "UNKNOWN_CYCLE",
            "message": f"Unknown cycle_id {value}. Use a cycle id, none, {', '.join(RELATIVE_CYCLES)}.",
            "value": value,
        },
    )


def _resolve_cycles(values: FilterValues, by_team: dict[str, list[Cycle]], days: Mapping[str, date]) -> FilterValues:
    """One cycle set with relative values expanded per team, each on its own today, and every id checked."""
    known = {cycle.cycle_id for cycles in by_team.values() for cycle in cycles}
    resolved: set[Optional[str]] = set()
    for value in values:
        if value is None:
            resolved.add(None)
        elif value in RELATIVE_CYCLES:
            hits = {
                cycle.cycle_id
                for team, cycles in by_team.items()
                if (cycle := relative_cycle(cycles, value, days[team])) is not None
            }
            resolved.update(hits or {NO_CYCLE_MATCH})
        elif value in known:
            resolved.add(value)
        else:
            raise unknown_cycle(value)
    return frozenset(resolved)


def cycle_starts(
    repositories: Repositories, workspace_id: str, by_team: Mapping[str, list[Cycle]]
) -> dict[str, datetime]:
    """Each cycle's start instant, midnight of its start date in its team's timezone, keyed by cycle id."""
    starts: dict[str, datetime] = {}
    for team, cycles in by_team.items():
        zone = team_timezone(repositories, workspace_id, team)
        for cycle in cycles:
            start = cycle_start_instant(cycle.start_date, zone)
            if start is not None:
                starts[cycle.cycle_id] = start
    return starts


def _resolve_teams(values: FilterValues, mine: frozenset[str], *, keep: bool) -> FilterValues:
    """One team set with `my_teams` swapped for the viewer's teams; a kept set that empties matches nothing."""
    if MY_TEAMS not in values:
        return values
    resolved = (values - {MY_TEAMS}) | mine
    if keep and not resolved:
        return frozenset({NO_TEAM_MATCH})
    return resolved


def viewer_team_ids(repositories: Repositories, workspace_id: str, viewer_id: Optional[str]) -> frozenset[str]:
    """The teams one person holds an explicit membership of, empty for no person."""
    if not viewer_id:
        return frozenset()
    rows = repositories.memberships.list_team_memberships_for_user(workspace_id, viewer_id)
    return frozenset(row.team_id for row in rows if row.team_id is not None)


def resolve_issue_filter(
    repositories: Repositories,
    workspace_id: str,
    teams: Iterable[str],
    wanted: IssueFilter,
    *,
    today: Optional[date] = None,
    sort: Optional[str] = None,
) -> IssueFilter:
    """The filter with relative cycles and `my_teams` named and every index it needs attached.

    The link, subscription, customer and release indexes are each read only when
    the filter or its groups ask for them.

    The customer index is read when the filter names a customer or `sort` orders
    by customer requests, so a list sorting that way finds the counts on the
    filter it already carries. A condition on a customer's status, tier, revenue
    or size reads the customers in that same query, so any number of customer
    conditions, groups included, costs one planning query.

    An "Added to cycle" phase reads the same cycles and attaches each one's start,
    so an issue is judged against the cycle it sits in.

    A relative cycle is read on each team's own today, in its timezone, unless
    `today` pins one day for every team.

    A cycle value that is neither `none`, a relative cycle nor a cycle of one of
    `teams` is refused with a 400 naming it, rather than quietly matching nothing.
    Groups are resolved with the same reads, taken once for the whole filter. A
    filter needing no read comes back as it went in, so the common path costs
    nothing.
    """
    people = wanted.subscribers
    needs_customers = wanted.needs_customers or sort in CUSTOMER_SORTS
    needs_memberships = wanted.needs_memberships
    needs_releases = wanted.needs_releases
    needs_starts = wanted.needs_cycle_starts
    if not (
        wanted.needs_cycles
        or needs_starts
        or wanted.needs_relations
        or people
        or needs_customers
        or needs_memberships
        or needs_releases
    ):
        return wanted
    mine = viewer_team_ids(repositories, workspace_id, wanted.viewer_id) if needs_memberships else None
    by_team: Optional[dict[str, list[Cycle]]] = None
    days: dict[str, date] = {}
    starts: Optional[dict[str, datetime]] = None
    if wanted.needs_cycles or needs_starts:
        read: dict[str, list[Cycle]] = {}
        for team in dict.fromkeys(teams):
            rows, _ = repositories.planning.list_cycles(workspace_id, team, limit=TEAM_CYCLE_LIMIT)
            read[team] = rows
        if wanted.needs_cycles:
            by_team = read
            days = (
                {team: today for team in read} if today is not None else teams_today(repositories, workspace_id, read)
            )
        if needs_starts:
            starts = cycle_starts(repositories, workspace_id, read)
    relation_ids = repositories.relations.issue_ids_by_type(workspace_id) if wanted.needs_relations else None
    subscribed: Optional[dict[str, frozenset[str]]] = None
    if people:
        subscribed = {
            person: frozenset(
                repositories.subscriptions.issue_ids_for_user(workspace_id, person, max_items=SUBSCRIPTION_READ_CAP)
            )
            for person in sorted(people)
        }
    customers: Optional[CustomerIndex] = None
    if needs_customers:
        customers = load_customer_index(
            repositories,
            workspace_id,
            with_revenue=sort == REVENUE_SORT,
            with_profiles=wanted.needs_customer_profiles,
        )
    releases = repositories.releases.release_ids_by_issue(workspace_id) if needs_releases else None
    return _attach(wanted, by_team, days, relation_ids, subscribed, customers, mine, releases, starts)


def _attach(
    wanted: IssueFilter,
    by_team: Optional[dict[str, list[Cycle]]],
    days: Mapping[str, date],
    relation_ids: Optional[Mapping[str, frozenset[str]]],
    subscribed: Optional[Mapping[str, frozenset[str]]],
    customers: Optional[CustomerIndex] = None,
    mine: Optional[frozenset[str]] = None,
    releases: Optional[Mapping[str, frozenset[str]]] = None,
    starts: Optional[Mapping[str, datetime]] = None,
) -> IssueFilter:
    """One filter and each of its groups with the reads `resolve_issue_filter` took applied."""
    cycle_ids, cycle_ids_not = wanted.cycle_ids, wanted.cycle_ids_not
    if by_team is not None:
        cycle_ids = _resolve_cycles(cycle_ids, by_team, days)
        cycle_ids_not = _resolve_cycles(cycle_ids_not, by_team, days)
    team_ids, team_ids_not = wanted.team_ids, wanted.team_ids_not
    if mine is not None:
        team_ids = _resolve_teams(team_ids, mine, keep=True)
        team_ids_not = _resolve_teams(team_ids_not, mine, keep=False)
    return replace(
        wanted,
        team_ids=team_ids,
        team_ids_not=team_ids_not,
        cycle_ids=cycle_ids,
        cycle_ids_not=cycle_ids_not,
        relation_ids=relation_ids if relation_ids is not None else wanted.relation_ids,
        subscribed_issue_ids=subscribed if subscribed is not None else wanted.subscribed_issue_ids,
        customer_index=customers if customers is not None else wanted.customer_index,
        release_index=releases if releases is not None else wanted.release_index,
        cycle_starts=starts if starts is not None else wanted.cycle_starts,
        groups=tuple(
            _attach(group, by_team, days, relation_ids, subscribed, customers, mine, releases, starts)
            for group in wanted.groups
        ),
    )
