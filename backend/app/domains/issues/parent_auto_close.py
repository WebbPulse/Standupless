"""Closing a parent with its last sub-issue, and open sub-issues with their parent.

Linear's two workflow toggles, both off until a team turns them on in its
`ParentAutoCloseSettings`. The rollup consumer calls `apply` for every issues
stream record, and only a record that moved an issue from an open status into a
completed or cancelled one does anything:

- the issue's parent, when its team has `close_parent` on and every sub-issue is
  now completed or cancelled, moves to the team's first completed status;
- the issue's open sub-issues, when its team has `close_sub_issues` on, move to
  the first status of the same category in their own team.

Neither direction loops: a parent closed here is already finished when its own
record arrives, so it closes only the sub-issues still open, and a sub-issue
closed here finds its parent already finished. Each write is skipped when the
issue moved since it was read, so a redelivered record is a no-op. Every close
records a `status_id` history row with the system as the actor, the same row the
auto-close sweep writes, and drops any SLA timer the issue carried.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Mapping

from webbpulse.events import deserialize_image

from app.common.change_source import SYSTEM
from app.common.db.dynamo.activity import build_activity
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.team_config import ParentAutoCloseSettings
from app.common.issue_rules import COMPLETED_CATEGORIES
from app.common.sla import apply_sla
from app.domains.issues.auto_archive import SYSTEM_ACTOR

_log = logging.getLogger(__name__)

COMPLETED = "completed"


def _text(image: Mapping[str, Any], name: str) -> str:
    """One attribute of a stream image as a string, empty when it is absent or null."""
    value = image.get(name)
    return str(value).strip() if value is not None else ""


def _category(repositories: Any, workspace_id: str, team_id: str, status_id: str) -> str:
    """The category of one status as a team sees it, empty when the status is gone."""
    row = repositories.team_config.get_status(workspace_id, team_id, status_id)
    return str(row.category) if row is not None else ""


def first_status(repositories: Any, workspace_id: str, team_id: str, category: str) -> str | None:
    """A team's first visible status of `category` by position, `None` when it has none."""
    rows = repositories.team_config.list_statuses(workspace_id, team_id, include_hidden=False)
    matching = sorted((row for row in rows if row.category == category), key=lambda row: (row.position, row.name))
    return str(matching[0].status_id) if matching else None


def _settings(repositories: Any, workspace_id: str, team_id: str) -> ParentAutoCloseSettings | None:
    """A team's stored parent and sub-issue auto-close settings, `None` when it never saved any."""
    return repositories.team_config.get_parent_auto_close_settings(workspace_id, team_id)


def closed_issue(repositories: Any, record: Mapping[str, Any]) -> tuple[Mapping[str, Any], str] | None:
    """The new image and new category of an issue this record moved from open to finished, or `None`.

    Only a modify that kept the team and changed the status counts, so a create, a
    delete, a team move or an edit to any other field costs no read, and a
    top-level issue costs one only when its team closes sub-issues.
    """
    new_image = deserialize_image(record, "NewImage")
    old_image = deserialize_image(record, "OldImage")
    if not new_image or not old_image:
        return None
    new_status, old_status = _text(new_image, "status_id"), _text(old_image, "status_id")
    if not new_status or new_status == old_status:
        return None
    workspace_id, team_id = _text(new_image, "workspace_id"), _text(new_image, "team_id")
    if not workspace_id or not team_id or team_id != _text(old_image, "team_id"):
        return None
    if not _text(new_image, "parent_id"):
        settings = _settings(repositories, workspace_id, team_id)
        if settings is None or not settings.close_sub_issues:
            return None
    category = _category(repositories, workspace_id, team_id, new_status)
    if category not in COMPLETED_CATEGORIES:
        return None
    if _category(repositories, workspace_id, team_id, old_status) in COMPLETED_CATEGORIES:
        return None
    return new_image, category


def _close(repositories: Any, issue: Issue, target: str, now: datetime) -> bool:
    """Move one issue to `target`, recording a system history row, answering whether it moved.

    Skipped when the issue is archived or its status moved since it was read.
    """

    def change(current: Issue) -> Issue | None:
        """The fresh issue moved to `target`, or `None` once someone moved it."""
        if current.archived_at is not None or current.status_id != issue.status_id:
            return None
        moved = current.model_copy(
            update={
                "status_id": target,
                "updated_at": now,
                "updated_by": SYSTEM_ACTOR,
                "updated_source": SYSTEM,
            }
        )
        apply_sla(repositories, current, moved, now)
        return moved

    if repositories.issues.replace_with(issue, change) is None:
        return False
    repositories.activity.record(
        build_activity(
            issue.workspace_id,
            issue.team_id,
            issue.issue_id,
            SYSTEM_ACTOR,
            "field_changed",
            actor_kind="system",
            field="status_id",
            from_value=issue.status_id,
            to_value=target,
        )
    )
    return True


def close_parent(repositories: Any, workspace_id: str, parent_id: str, now: datetime) -> bool:
    """Close one parent once every sub-issue is finished, when its team has `close_parent` on.

    A parent already finished, archived, or with any sub-issue still open is left
    alone, and so is a team with no visible completed status.
    """
    parent = repositories.issues.get(workspace_id, parent_id)
    if parent is None or parent.archived_at is not None:
        return False
    settings = _settings(repositories, workspace_id, parent.team_id)
    if settings is None or not settings.close_parent:
        return False
    if _category(repositories, workspace_id, parent.team_id, parent.status_id) in COMPLETED_CATEGORIES:
        return False
    children = repositories.issues.iter_children(workspace_id, parent_id)
    if not children:
        return False
    for child in children:
        if _category(repositories, workspace_id, child.team_id, child.status_id) not in COMPLETED_CATEGORIES:
            return False
    target = first_status(repositories, workspace_id, parent.team_id, COMPLETED)
    if target is None:
        return False
    return _close(repositories, parent, target, now)


def close_sub_issues(repositories: Any, workspace_id: str, parent: Issue, category: str, now: datetime) -> int:
    """Close a finished parent's open sub-issues into `category`, when its team has `close_sub_issues` on.

    Each sub-issue moves to the first visible status of `category` in its own
    team, and one whose team has none is left open. Answers how many moved.
    """
    settings = _settings(repositories, workspace_id, parent.team_id)
    if settings is None or not settings.close_sub_issues:
        return 0
    closed = 0
    targets: dict[str, str | None] = {}
    for child in repositories.issues.iter_children(workspace_id, parent.issue_id):
        if child.archived_at is not None:
            continue
        if _category(repositories, workspace_id, child.team_id, child.status_id) in COMPLETED_CATEGORIES:
            continue
        if child.team_id not in targets:
            targets[child.team_id] = first_status(repositories, workspace_id, child.team_id, category)
        target = targets[child.team_id]
        if target is not None and _close(repositories, child, target, now):
            closed += 1
    return closed


def apply(repositories: Any, record: Mapping[str, Any], now: datetime | None = None) -> None:
    """Close the parent or the open sub-issues of an issue this record just finished, as its team chose."""
    found = closed_issue(repositories, record)
    if found is None:
        return
    image, category = found
    moment = now or utc_now()
    workspace_id = _text(image, "workspace_id")
    issue_id = _text(image, "issue_id")
    parent_id = _text(image, "parent_id")
    parent_closed = bool(parent_id) and close_parent(repositories, workspace_id, parent_id, moment)
    issue = repositories.issues.get(workspace_id, issue_id) if issue_id else None
    children_closed = close_sub_issues(repositories, workspace_id, issue, category, moment) if issue else 0
    if parent_closed or children_closed:
        _log.info(
            "Closed parent and sub-issues together.",
            extra={
                "event": "issues.parent_auto_close",
                "workspace_id": workspace_id,
                "parent_closed": parent_closed,
                "sub_issues_closed": children_closed,
            },
        )
