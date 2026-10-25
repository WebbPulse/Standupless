"""The report an initiative update carries: what moved on the initiative since the last update.

Posting an initiative update records a snapshot of the initiative on it beside
the snapshot the update before it recorded, the way a project update does, so
the report is a deterministic diff of two stored values. Each line reads in the
same style as a project update's report and reuses its helpers.

Unlike a project update, a first update, or one following an update posted
before snapshots existed, carries no report at all: there is nothing to
compare it with, and its own text already says where the initiative stands.

The projects counted are the ones rolled up from the initiative and its
sub-initiatives that every workspace member can see, so a stored count never
reveals work on a private team to a reader outside it.
"""

from __future__ import annotations

from collections import Counter
from typing import Iterable, Optional

from app.common.api.dependencies.repositories import Repositories
from app.common.date_resolution import date_label
from app.common.db.dynamo.planning import (
    PROJECT_STATUSES,
    Initiative,
    InitiativeUpdateSnapshot,
    Project,
    normalise_project_status,
)
from app.common.project_update_report import person_name, target_change

HEALTH_ORDER: tuple[str, ...] = ("on_track", "at_risk", "off_track")
"""The project healths in the order the report names them."""

HEALTH_LABELS: dict[str, str] = {"on_track": "On track", "at_risk": "At risk", "off_track": "Off track"}
"""How a health reads at the start of a line."""

PROJECT_STATUS_PHRASES: dict[str, str] = {
    "backlog": "in backlog",
    "planned": "planned",
    "in_progress": "in progress",
    "paused": "paused",
    "completed": "completed",
    "canceled": "canceled",
}
"""How a project status category reads after the word Projects."""


def take_snapshot(
    repositories: Repositories, initiative: Initiative, projects: Iterable[Project], health: str
) -> InitiativeUpdateSnapshot:
    """Where one initiative stands now: owner, status, target date, the health posted, and its projects' counts."""
    rolled = list(projects)
    statuses = Counter(normalise_project_status(project.status) for project in rolled)
    healths = Counter(project.health for project in rolled if project.health in HEALTH_LABELS)
    return InitiativeUpdateSnapshot(
        owner_id=initiative.owner_id,
        owner_name=person_name(repositories, initiative.owner_id),
        status=initiative.status,
        target_date=initiative.target_date,
        target_date_resolution=initiative.target_date_resolution,
        health=health,
        project_count=len(rolled),
        projects_by_status=dict(statuses),
        projects_by_health={str(key): value for key, value in healths.items()},
    )


def _label(value: Optional[str]) -> Optional[str]:
    """A stored status or health as people read it, or None without one."""
    if not value:
        return None
    return HEALTH_LABELS.get(value) or value.replace("_", " ").capitalize()


def _changed(name: str, before: Optional[str], after: Optional[str]) -> Optional[str]:
    """A from and to line for one named value, or None when it did not change or was cleared."""
    if before == after or not after:
        return None
    return f"{name} changed from {before} to {after}" if before else f"{name} set to {after}"


def _count_lines(phrases: Iterable[tuple[str, str]], after: dict[str, int], before: dict[str, int]) -> list[str]:
    """One line per bucket whose project count moved, in the order `phrases` gives."""
    lines = []
    for key, phrase in phrases:
        was, now = before.get(key, 0), after.get(key, 0)
        if was != now:
            lines.append(f"Projects {phrase} {was} to {now}")
    return lines


def report_lines(snapshot: InitiativeUpdateSnapshot, previous: Optional[InitiativeUpdateSnapshot]) -> list[str]:
    """What changed since `previous` as plain lines, empty without one to compare with."""
    if previous is None:
        return []
    lines = [
        line
        for line in (
            _changed("Status", _label(previous.status), _label(snapshot.status)),
            target_change(
                date_label(previous.target_date, previous.target_date_resolution),
                date_label(snapshot.target_date, snapshot.target_date_resolution),
            ),
            _changed("Health", _label(previous.health), _label(snapshot.health)),
        )
        if line is not None
    ]
    if snapshot.owner_id != previous.owner_id:
        lines.append(f"New owner {snapshot.owner_name or 'a new owner'}" if snapshot.owner_id else "Owner removed")
    if snapshot.project_count != previous.project_count:
        lines.append(f"Projects {previous.project_count} to {snapshot.project_count}")
    lines.extend(
        _count_lines(
            ((key, PROJECT_STATUS_PHRASES[key]) for key in PROJECT_STATUSES),
            snapshot.projects_by_status,
            previous.projects_by_status,
        )
    )
    lines.extend(
        _count_lines(
            ((key, HEALTH_LABELS[key].lower()) for key in HEALTH_ORDER),
            snapshot.projects_by_health,
            previous.projects_by_health,
        )
    )
    return lines


def update_report(
    snapshot: Optional[InitiativeUpdateSnapshot], previous: Optional[InitiativeUpdateSnapshot], hide_details: bool
) -> list[str]:
    """The report one stored update carries, empty when it predates snapshots, is a first update or is hidden."""
    if hide_details or snapshot is None:
        return []
    return report_lines(snapshot, previous)
