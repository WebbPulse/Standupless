"""The roadmap route: every dated cycle and milestone across readable projects.

One timeline over both entities, which is why the `planning` table carries a
denormalised `target_date`: a cycle is drawn at its end date and a milestone at its
target, and one index over that attribute orders them together. Undated milestones
fall outside the sparse index by construction and are appended after the dated
rows, so nothing an engineer has not committed to a date jumps the queue.
"""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Path, Query
from webbpulse.http import CursorPage

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.pagination import decode_offset_cursor, encode_offset_cursor
from app.common.db.dynamo.planning import as_cycle, as_milestone, is_cycle
from app.domains.planning.schemas.planning import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    RoadmapEntryRead,
    RoadmapKindField,
    RoadmapListRead,
)
from app.domains.planning.service import require_project_reader, visible_project_ids

router = APIRouter()

UNDATED_SORT_KEY = "￿"
"""What an undated entry sorts under, which is after every real date.

A date is `YYYY-MM-DD`, so any string above `9` sorts after all of them; spelled as
a constant rather than inline so the ordering rule has one home.
"""


def _entry_sort_key(entry: RoadmapEntryRead) -> tuple[str, str, str]:
    """The order the roadmap draws entries in: by date, then project, then id."""
    return (entry.target_date or UNDATED_SORT_KEY, entry.project_id, entry.id)


@router.get("/{workspace_id}/roadmap", response_model=RoadmapListRead)
def read_roadmap(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    project_id: Annotated[Optional[str], Query()] = None,
    kind: Annotated[Optional[RoadmapKindField], Query()] = None,
    cursor: Annotated[Optional[str], Query()] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
) -> CursorPage[RoadmapEntryRead]:
    """One page of the workspace's roadmap, by date ascending, undated last.

    The read fans out one index query per readable project and merges, so the
    cursor is a position in the merged order rather than a start key: a merged page
    has no single last evaluated key. A project the caller is outside is never
    queried, so an invisible project cannot influence a page boundary either.
    """
    if project_id is not None:
        require_project_reader(repositories, context, project_id)
        projects = [project_id]
    else:
        projects = visible_project_ids(repositories, context)

    if not projects:
        return RoadmapListRead(items=[], next_cursor=None)

    entries: list[RoadmapEntryRead] = []
    for candidate in projects:
        for item in repositories.planning.list_for_roadmap(context.workspace_id, candidate):
            if is_cycle(item):
                entries.append(RoadmapEntryRead.from_cycle(as_cycle(item)))
            else:
                entries.append(RoadmapEntryRead.from_milestone(as_milestone(item)))
        for milestone in repositories.planning.list_undated_milestones(context.workspace_id, candidate):
            entries.append(RoadmapEntryRead.from_milestone(milestone))

    if kind is not None:
        entries = [entry for entry in entries if entry.kind == kind]

    ordered = sorted(entries, key=_entry_sort_key)
    scope = f"roadmap:{context.workspace_id}:{','.join(projects)}:{kind or 'all'}"
    offset = decode_offset_cursor(cursor, scope)
    window = ordered[offset : offset + limit]
    next_offset = offset + len(window)
    next_cursor = encode_offset_cursor(next_offset, scope) if next_offset < len(ordered) else None
    return RoadmapListRead(items=window, next_cursor=next_cursor)
