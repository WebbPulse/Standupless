"""The change notice one stream record becomes, if any.

A notice is the kind of thing that changed, its id, its workspace and its team,
and what happened to it. It carries no field of the row, so a connection that
receives it learns nothing it could not already read, and the visibility check
before a send is about the team alone.

Issues, comments, cycles, projects and initiatives are announced. Everything else
the stream carries, project and initiative updates, documents, customers and
labels among them, stays on polling. A row a bulk import wrote is skipped, so an
import of thousands of issues does not push thousands of notices, and a comment
on a document is skipped because it belongs to no team the check could use.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Mapping

from webbpulse.dynamodb import table_name
from webbpulse.events import deserialize_image, source_table

from app.common.bulk_import import from_bulk_import
from app.common.core.config import settings
from app.common.db.dynamo.planning import CYCLE, INITIATIVE, PROJECT

NoticeKind = Literal["issue", "comment", "cycle", "project", "initiative"]

ACTIONS: dict[str, str] = {"INSERT": "created", "MODIFY": "updated", "REMOVE": "removed"}
"""The word a client reads for each stream event name."""


@dataclass(frozen=True)
class Notice:
    """One change worth telling a client about.

    `team_id` is the team that decides who may read it, or `None` for a project,
    which may sit in several teams named by `team_ids`, and for an initiative with
    no lead team. `initiative` marks the one kind a guest never sees.
    """

    kind: NoticeKind
    id: str
    workspace_id: str
    team_id: str | None
    action: str
    team_ids: tuple[str, ...] = ()

    @property
    def dedupe_key(self) -> tuple[str, str, str, str | None]:
        """What makes two notices in one batch the same message to a client."""
        return (self.workspace_id, self.kind, self.id, self.team_id)

    def message(self) -> dict[str, Any]:
        """The JSON a connection receives: names and ids, never content."""
        return {
            "type": "change",
            "kind": self.kind,
            "id": self.id,
            "action": self.action,
            "workspace_id": self.workspace_id,
            "team_id": self.team_id,
        }


def _images(record: Mapping[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """The record's new and old images, each empty when absent."""
    return deserialize_image(record, "NewImage") or {}, deserialize_image(record, "OldImage") or {}


def _text(image: Mapping[str, Any], name: str) -> str:
    """One string attribute of an image, or the empty string."""
    value = image.get(name)
    return value if isinstance(value, str) else ""


def _issue_notices(record: Mapping[str, Any], action: str) -> list[Notice]:
    """An issue change, told to its team, and to its old team too when it moved."""
    new, old = _images(record)
    image = new or old
    workspace_id, issue_id = _text(image, "workspace_id"), _text(image, "issue_id")
    if not workspace_id or not issue_id:
        return []
    teams = [team for team in (_text(new, "team_id"), _text(old, "team_id")) if team]
    return [Notice("issue", issue_id, workspace_id, team, action) for team in dict.fromkeys(teams)]


def _comment_notices(record: Mapping[str, Any], action: str) -> list[Notice]:
    """A comment change on an issue, told to the issue's team."""
    new, old = _images(record)
    image = new or old
    if image.get("document_id"):
        return []
    workspace_id, comment_id, team_id = (
        _text(image, "workspace_id"),
        _text(image, "comment_id"),
        _text(image, "team_id"),
    )
    if not workspace_id or not comment_id or not team_id:
        return []
    return [Notice("comment", comment_id, workspace_id, team_id, action)]


def _planning_notices(record: Mapping[str, Any], action: str) -> list[Notice]:
    """A cycle, project or initiative change, and nothing for any other planning row."""
    new, old = _images(record)
    image = new or old
    workspace_id, kind = _text(image, "workspace_id"), _text(image, "kind")
    if not workspace_id:
        return []
    if kind == CYCLE:
        cycle_id, team_id = _text(image, "cycle_id"), _text(image, "team_id")
        return [Notice("cycle", cycle_id, workspace_id, team_id, action)] if cycle_id and team_id else []
    if kind == PROJECT:
        project_id = _text(image, "project_id")
        teams = [*(new.get("team_ids") or ()), *(old.get("team_ids") or ())]
        team_ids = tuple(dict.fromkeys(str(team) for team in teams if team))
        if not project_id or not team_ids:
            return []
        return [Notice("project", project_id, workspace_id, None, action, team_ids)]
    if kind == INITIATIVE:
        initiative_id = _text(image, "initiative_id")
        team_id = _text(image, "team_id") or None
        return [Notice("initiative", initiative_id, workspace_id, team_id, action)] if initiative_id else []
    return []


def notices_for(record: Mapping[str, Any]) -> list[Notice]:
    """The notices one stream record becomes, empty for a record no client hears."""
    if from_bulk_import(record):
        return []
    action = ACTIONS.get(str(record.get("eventName", "")))
    if action is None:
        return []
    physical = source_table(record)
    prefix = settings.dynamodb_table_prefix
    if physical == table_name("issues", prefix):
        return _issue_notices(record, action)
    if physical == table_name("comments", prefix):
        return _comment_notices(record, action)
    if physical == table_name("planning", prefix):
        return _planning_notices(record, action)
    return []


def batch_notices(records: list[Mapping[str, Any]]) -> list[Notice]:
    """Every notice a stream batch becomes, each change once, the last action winning."""
    seen: dict[tuple[str, str, str, str | None], Notice] = {}
    for record in records:
        for notice in notices_for(record):
            seen.pop(notice.dedupe_key, None)
            seen[notice.dedupe_key] = notice
    return list(seen.values())
