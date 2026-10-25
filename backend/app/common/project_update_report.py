"""The progress report a project update carries: where the project stood, and what moved since the last update.

Posting an update records a snapshot of the project on it, beside the snapshot
the update before it recorded, so the report is a deterministic diff of two
stored values and never a model's summary. The web client draws the same diff
from the same two snapshots; the lines here are the plain text the email and
the Slack or Discord message carry.

A first update, or one following an update posted before snapshots existed,
reads as a baseline of the current values instead of a diff. Progress only
shows once it moved by more than `PROGRESS_THRESHOLD` points, as in Linear.
"""

from __future__ import annotations

from typing import Any, Mapping, Optional

from pydantic import ValidationError

from app.common.api.dependencies.repositories import Repositories
from app.common.date_resolution import date_label
from app.common.db.dynamo.planning import (
    MilestoneSnapshot,
    Project,
    ProjectUpdateSnapshot,
    RollupCounts,
)
from app.common.project_statuses import status_of_project, workspace_project_statuses

PROGRESS_THRESHOLD = 2
"""How many whole percent progress must move by before the report names it."""


def whole_percent(completed: int, total: int) -> int:
    """`completed` of `total` as a whole percent, halves rounded up as the web client rounds them."""
    if total <= 0:
        return 0
    return (completed * 200 + total) // (2 * total)


def _done_and_scope(counts: RollupCounts) -> tuple[int, int]:
    """The finished work and the scope it is measured against, cancelled work left out."""
    return counts.done, counts.total - counts.cancelled


def person_name(repositories: Repositories, user_id: Optional[str]) -> Optional[str]:
    """A person's display name, or None when there is no person or no name to show."""
    if not user_id:
        return None
    user = repositories.users.get(user_id)
    return (user.display_name or None) if user is not None else None


def take_snapshot(repositories: Repositories, project: Project) -> ProjectUpdateSnapshot:
    """Where one project stands now: progress, target date, lead, status and each milestone's progress."""
    completed, total = _done_and_scope(project.progress)
    status = status_of_project(workspace_project_statuses(repositories, project.workspace_id), project)
    milestones = []
    for milestone in repositories.planning.list_milestones(project.workspace_id, project.project_id):
        done, scope = _done_and_scope(milestone.progress)
        milestones.append(
            MilestoneSnapshot(milestone_id=milestone.milestone_id, name=milestone.name, completed=done, total=scope)
        )
    return ProjectUpdateSnapshot(
        measure=project.measure,
        completed=completed,
        total=total,
        percent=whole_percent(completed, total),
        target_date=project.target_date,
        target_date_resolution=project.target_date_resolution,
        lead_id=project.lead_id,
        lead_name=person_name(repositories, project.lead_id),
        status=project.status,
        status_id=project.effective_status_id,
        status_name=status.name if status is not None else None,
        milestones=milestones,
    )


def _unit(measure: str, value: int) -> str:
    """The unit word for an amount in one measure, singular for exactly one."""
    if measure == "points":
        return "point" if value == 1 else "points"
    return "issue" if value == 1 else "issues"


def _target(snapshot: ProjectUpdateSnapshot) -> Optional[str]:
    """The target date as people read it at its resolution, or None without one."""
    return date_label(snapshot.target_date, snapshot.target_date_resolution)


def _status(snapshot: ProjectUpdateSnapshot) -> Optional[str]:
    """The status's name, or its category when no name was recorded."""
    if snapshot.status_name:
        return snapshot.status_name
    return snapshot.status.replace("_", " ").capitalize() if snapshot.status else None


def _lead(snapshot: ProjectUpdateSnapshot) -> str:
    """The lead as a line names it."""
    return snapshot.lead_name or "a new lead"


def _milestone_complete(milestone: MilestoneSnapshot) -> bool:
    """Whether every piece of a milestone's scope is finished."""
    return milestone.total > 0 and milestone.completed >= milestone.total


def _baseline(snapshot: ProjectUpdateSnapshot) -> list[str]:
    """The current values, for an update with no earlier snapshot to compare with."""
    unit = _unit(snapshot.measure, snapshot.total)
    lines = [f"Progress {snapshot.percent}% ({snapshot.completed} of {snapshot.total} {unit})"]
    target = _target(snapshot)
    if target:
        lines.append(f"Target date {target}")
    if snapshot.lead_id:
        lines.append(f"Lead {_lead(snapshot)}")
    status = _status(snapshot)
    if status:
        lines.append(f"Status {status}")
    for milestone in snapshot.milestones:
        if _milestone_complete(milestone):
            lines.append(f"Milestone {milestone.name} completed")
        elif milestone.total > 0:
            lines.append(f"Milestone {milestone.name} {milestone.completed} of {milestone.total}")
    return lines


def _progress_line(snapshot: ProjectUpdateSnapshot, previous: ProjectUpdateSnapshot) -> Optional[str]:
    """Progress from and to, with the scope change, once it moved by more than the threshold."""
    if abs(snapshot.percent - previous.percent) <= PROGRESS_THRESHOLD:
        return None
    line = f"Progress {previous.percent}% to {snapshot.percent}%"
    unit = _unit(snapshot.measure, snapshot.total)
    if snapshot.total != previous.total:
        return f"{line}, scope {previous.total} to {snapshot.total} {unit}"
    return f"{line} ({snapshot.completed} of {snapshot.total} {unit})"


def _target_line(snapshot: ProjectUpdateSnapshot, previous: ProjectUpdateSnapshot) -> Optional[str]:
    """How the target date moved, or None when it did not."""
    return target_change(_target(previous), _target(snapshot))


def target_change(before: Optional[str], after: Optional[str]) -> Optional[str]:
    """How a target date moved between two labels, or None when it did not."""
    if before == after:
        return None
    if before and after:
        return f"Target date moved from {before} to {after}"
    if after:
        return f"Target date set to {after}"
    return f"Target date removed, was {before}"


def _milestone_lines(snapshot: ProjectUpdateSnapshot, previous: ProjectUpdateSnapshot) -> list[str]:
    """The milestones that completed, moved or are new since `previous`, in the project's milestone order."""
    earlier = {milestone.milestone_id: milestone for milestone in previous.milestones}
    lines = []
    for milestone in snapshot.milestones:
        was = earlier.get(milestone.milestone_id)
        if _milestone_complete(milestone):
            if was is None or not _milestone_complete(was):
                lines.append(f"Milestone {milestone.name} completed")
        elif was is None:
            if milestone.total > 0:
                lines.append(f"Milestone {milestone.name} {milestone.completed} of {milestone.total}")
        elif (milestone.completed, milestone.total) != (was.completed, was.total):
            before = f"{was.completed} of {was.total}"
            lines.append(f"Milestone {milestone.name} {before} to {milestone.completed} of {milestone.total}")
    return lines


def report_lines(snapshot: ProjectUpdateSnapshot, previous: Optional[ProjectUpdateSnapshot]) -> list[str]:
    """The report as plain lines: a baseline without `previous`, otherwise only what changed."""
    if previous is None:
        return _baseline(snapshot)
    lines = [
        line for line in (_progress_line(snapshot, previous), _target_line(snapshot, previous)) if line is not None
    ]
    if snapshot.lead_id != previous.lead_id:
        lines.append(f"New lead {_lead(snapshot)}" if snapshot.lead_id else "Lead removed")
    if (snapshot.status_id, snapshot.status) != (previous.status_id, previous.status):
        before, after = _status(previous), _status(snapshot)
        if after and before != after:
            lines.append(f"Status changed from {before} to {after}" if before else f"Status set to {after}")
    lines.extend(_milestone_lines(snapshot, previous))
    return lines


def _parse(value: Any) -> Optional[ProjectUpdateSnapshot]:
    """A stored snapshot, or None when it is missing or does not read as one."""
    if not isinstance(value, Mapping):
        return None
    try:
        return ProjectUpdateSnapshot.model_validate(dict(value))
    except ValidationError:
        return None


def report_for_item(item: Mapping[str, Any]) -> list[str]:
    """The report one stored update carries, empty when it predates snapshots or its author hid it."""
    if item.get("hide_details"):
        return []
    snapshot = _parse(item.get("snapshot"))
    if snapshot is None:
        return []
    return report_lines(snapshot, _parse(item.get("previous_snapshot")))
