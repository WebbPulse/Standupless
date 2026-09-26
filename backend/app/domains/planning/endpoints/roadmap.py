"""The roadmap route: every cycle and project across readable teams.

One timeline over both entities: a cycle is drawn at its end date and a project at
its target. Cycles are read one index query per readable team, and projects, which
are workspace level and span teams, are read once from the workspace's project
prefix and kept when the caller can see at least one of their teams. Undated
projects sort after every dated entry, so nothing an engineer has not committed to
a date jumps the queue.
"""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Path, Query
from webbpulse.http import CursorPage

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.pagination import decode_offset_cursor, encode_offset_cursor
from app.domains.planning.schemas.planning import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    RoadmapEntryRead,
    RoadmapKindField,
    RoadmapListRead,
)
from app.domains.planning.service import require_team_reader, visible_project_teams, visible_team_ids

router = APIRouter()

UNDATED_SORT_KEY = "￿"
"""What an undated entry sorts under, which is after every real date.

A date is `YYYY-MM-DD`, so any string above `9` sorts after all of them; spelled as
a constant rather than inline so the ordering rule has one home.
"""


def _entry_sort_key(entry: RoadmapEntryRead) -> tuple[str, str, str]:
    """The order the roadmap draws entries in: by date, then team, then id."""
    return (entry.target_date or UNDATED_SORT_KEY, entry.team_id, entry.id)


@router.get("/{workspace_id}/roadmap", response_model=RoadmapListRead)
def read_roadmap(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    team_id: Annotated[Optional[str], Query()] = None,
    kind: Annotated[Optional[RoadmapKindField], Query()] = None,
    cursor: Annotated[Optional[str], Query()] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
) -> CursorPage[RoadmapEntryRead]:
    """One page of the workspace's roadmap, by date ascending, undated last.

    The read fans out one index query per readable team for cycles, reads the
    workspace's projects once, and merges, so the cursor is a position in the merged
    order rather than a start key: a merged page has no single last evaluated key.
    A team the caller is outside is never queried, and a project on no team the
    caller can see is dropped before the merge, so neither can influence a page
    boundary.
    """
    if team_id is not None:
        require_team_reader(repositories, context, team_id)
        teams = [team_id]
    else:
        teams = visible_team_ids(repositories, context)

    if not teams:
        return RoadmapListRead(items=[], next_cursor=None)

    entries: list[RoadmapEntryRead] = []
    if kind != "project":
        for candidate in teams:
            for cycle in repositories.planning.list_for_roadmap(context.workspace_id, candidate):
                entries.append(RoadmapEntryRead.from_cycle(cycle))
    if kind != "cycle":
        visible = set(visible_team_ids(repositories, context)) if team_id is not None else set(teams)
        for project in repositories.planning.list_projects(context.workspace_id):
            shown = visible_project_teams(project, visible)
            if shown and (team_id is None or team_id in shown):
                entries.append(RoadmapEntryRead.from_project(project, shown))

    ordered = sorted(entries, key=_entry_sort_key)
    scope = f"roadmap:{context.workspace_id}:{','.join(teams)}:{kind or 'all'}"
    offset = decode_offset_cursor(cursor, scope)
    window = ordered[offset : offset + limit]
    next_offset = offset + len(window)
    next_cursor = encode_offset_cursor(next_offset, scope) if next_offset < len(ordered) else None
    return RoadmapListRead(items=window, next_cursor=next_cursor)
