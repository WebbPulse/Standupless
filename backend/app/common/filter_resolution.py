"""Resolving the parts of an issue filter that need a read beyond the issue rows.

`build_issue_filter` turns wire values into a filter without touching a table, so
it can run anywhere a filter is parsed. Two parts of a filter cannot be decided
from the row alone: a relative cycle such as `current` names a different cycle in
each team and on each day, and a relation filter needs the workspace's links. Every
list, export, insight and share read runs the filter through here once, after it
knows which teams it fans out over, so they all agree on what a filter selects.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import date
from typing import TYPE_CHECKING, Iterable, Optional

from fastapi import HTTPException, status

from app.common.cycle_schedule import active_cycle
from app.common.db.dynamo.planning import Cycle
from app.common.issue_filters import RELATIVE_CYCLES, FilterValues, IssueFilter

if TYPE_CHECKING:
    from app.common.api.dependencies.repositories import Repositories

NO_CYCLE_MATCH = "\x00no-cycle"
"""A cycle id no issue carries, standing in for a relative cycle a team does not have.

Kept in the set rather than dropping the value, because an empty set means the
filter is absent and would select every issue instead of none.
"""

TEAM_CYCLE_LIMIT = 500
"""The most cycles one team's read takes, far past any schedule a team keeps."""


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


def relative_cycle(cycles: list[Cycle], which: str, today: date) -> Optional[Cycle]:
    """The current, next or previous live cycle of one team on one day."""
    if which == "current":
        return active_cycle(cycles, today)
    now = today.isoformat()
    live = [cycle for cycle in cycles if not cycle.cancelled]
    if which == "next":
        ahead = [cycle for cycle in live if cycle.start_date > now]
        return min(ahead, key=lambda cycle: (cycle.start_date, cycle.cycle_id)) if ahead else None
    behind = [cycle for cycle in live if cycle.end_date < now]
    return max(behind, key=lambda cycle: (cycle.end_date, cycle.cycle_id)) if behind else None


def _resolve_cycles(values: FilterValues, by_team: dict[str, list[Cycle]], today: date) -> FilterValues:
    """One cycle set with relative values expanded per team and every id checked."""
    known = {cycle.cycle_id for cycles in by_team.values() for cycle in cycles}
    resolved: set[Optional[str]] = set()
    for value in values:
        if value is None:
            resolved.add(None)
        elif value in RELATIVE_CYCLES:
            found = {relative_cycle(cycles, value, today) for cycles in by_team.values()}
            hits = {cycle.cycle_id for cycle in found if cycle is not None}
            resolved.update(hits or {NO_CYCLE_MATCH})
        elif value in known:
            resolved.add(value)
        else:
            raise unknown_cycle(value)
    return frozenset(resolved)


def resolve_issue_filter(
    repositories: Repositories,
    workspace_id: str,
    teams: Iterable[str],
    wanted: IssueFilter,
    *,
    today: Optional[date] = None,
) -> IssueFilter:
    """The filter with relative cycles named and the link index attached.

    A cycle value that is neither `none`, a relative cycle nor a cycle of one of
    `teams` is refused with a 400 naming it, rather than quietly matching nothing.
    A filter needing neither read comes back as it went in, so the common path
    costs nothing.
    """
    if not (wanted.needs_cycles or wanted.needs_relations):
        return wanted
    cycle_ids, cycle_ids_not = wanted.cycle_ids, wanted.cycle_ids_not
    if wanted.needs_cycles:
        by_team: dict[str, list[Cycle]] = {}
        for team in dict.fromkeys(teams):
            rows, _ = repositories.planning.list_cycles(workspace_id, team, limit=TEAM_CYCLE_LIMIT)
            by_team[team] = rows
        day = today or date.today()
        cycle_ids = _resolve_cycles(cycle_ids, by_team, day)
        cycle_ids_not = _resolve_cycles(cycle_ids_not, by_team, day)
    relation_ids = wanted.relation_ids
    if wanted.needs_relations:
        relation_ids = repositories.relations.issue_ids_by_type(workspace_id)
    return replace(wanted, cycle_ids=cycle_ids, cycle_ids_not=cycle_ids_not, relation_ids=relation_ids)
