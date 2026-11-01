"""Which other updates landed on a project or initiative just before or after one being posted.

Two authors posting the same due update overwrite each other's health in
silence, because the newest update is the one the project or initiative mirrors.
Nothing here refuses a post: the answer to a create names the others, so the
author can read them and edit or delete a duplicate. The check compares stored
post times with a fixed window, so the same rows always give the same answer.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Sequence

from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.planning import RecentUpdateRead
from app.common.db.dynamo.planning import InitiativeUpdateRow, ProjectUpdateRow
from app.common.initiative_update_report import HEALTH_LABELS
from app.common.project_update_report import person_name

RECENT_UPDATE_WINDOW = timedelta(minutes=5)
"""How close to a new update another one counts as concurrent. The composer holds the same window."""

RECENT_UPDATE_SCAN = 6
"""How many of the newest updates a create reads back: its own and up to five others."""


def recent_updates(
    repositories: Repositories,
    posted: ProjectUpdateRow | InitiativeUpdateRow,
    newest: Sequence[ProjectUpdateRow | InitiativeUpdateRow],
) -> list[RecentUpdateRead]:
    """The rows of `newest` other than `posted` that were posted within the window of it, newest first."""
    cutoff = posted.created_at - RECENT_UPDATE_WINDOW
    return [
        RecentUpdateRead(
            update_id=row.update_id,
            author_id=row.author_id,
            author_name=person_name(repositories, row.author_id),
            health=row.health,  # pyright: ignore[reportArgumentType]
            source=row.source,  # pyright: ignore[reportArgumentType]
            created_at=row.created_at,
        )
        for row in newest
        if row.update_id != posted.update_id and row.created_at >= cutoff
    ]


def recent_update_hints(subject: str, recent: Sequence[RecentUpdateRead]) -> list[str]:
    """One line per concurrent update for an agent to act on, empty when there is none."""
    return [
        f"{update.author_name or 'Someone'} also posted update {update.update_id} on this {subject} "
        f"at {update.created_at.isoformat()}, health {HEALTH_LABELS.get(update.health, update.health)}. "
        f"Read it, and edit or delete yours if the two repeat each other, "
        f"because the newest update sets the {subject}'s health."
        for update in recent
    ]
