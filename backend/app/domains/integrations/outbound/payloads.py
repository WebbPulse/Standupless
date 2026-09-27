"""What an outbound webhook says about one row change, in the shape Linear's webhooks use.

Every body carries `action` (`create`, `update` or `remove`), `type`, `data`, `url` and
`createdAt`, and an update also carries `updatedFrom`: the previous value of every field
that changed, keyed like `data`. An update that touched none of a type's public fields,
such as a rollup counter the product maintains itself, describes nothing and is dropped.

`data` is a deliberate subset of the row in camelCase. A webhook goes to somebody else's
server, so it carries what identifies the row and what a receiver acts on, never
internal index attributes, and long text is cut to a bound so one body always fits the
queue message and the delivery log row that carry it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Callable, Mapping
from urllib.parse import quote

from app.common.api.dependencies.repositories import Repositories
from app.common.core.config import settings
from app.common.issue_keys import display_key

TEXT_LIMIT = 16_000
"""The most characters of any one text field a body carries."""

ISSUE_FIELDS: dict[str, str] = {
    "title": "title",
    "body": "description",
    "status_id": "statusId",
    "priority": "priority",
    "assignee_id": "assigneeId",
    "label_ids": "labelIds",
    "estimate": "estimate",
    "start_date": "startDate",
    "due_date": "dueDate",
    "parent_id": "parentId",
    "cycle_id": "cycleId",
    "project_id": "projectId",
    "project_milestone_id": "projectMilestoneId",
}
"""The issue fields whose change is news, and their public names."""

COMMENT_FIELDS: dict[str, str] = {"body": "body"}

PROJECT_FIELDS: dict[str, str] = {
    "name": "name",
    "description": "description",
    "status": "status",
    "lead_id": "leadId",
    "start_date": "startDate",
    "target_date": "targetDate",
    "team_ids": "teamIds",
    "icon": "icon",
    "color": "color",
    "health": "health",
    "priority": "priority",
    "member_ids": "memberIds",
}

CYCLE_FIELDS: dict[str, str] = {
    "name": "name",
    "start_date": "startsAt",
    "end_date": "endsAt",
    "goal": "goal",
    "cancelled": "cancelled",
}

LABEL_FIELDS: dict[str, str] = {"name": "name", "color": "color"}

ACTIONS = {"INSERT": "create", "MODIFY": "update", "REMOVE": "remove"}


@dataclass(frozen=True, slots=True)
class OutboundEvent:
    """One row change described for delivery, before any endpoint is chosen."""

    workspace_id: str
    resource_type: str
    event_type: str
    action: str
    team_ids: tuple[str, ...]
    data: dict[str, Any]
    url: str
    created_at: str
    updated_from: dict[str, Any] | None = field(default=None)

    def body(self, *, webhook_id: str, delivery_id: str, timestamp_ms: int) -> dict[str, Any]:
        """The JSON body one endpoint is sent for this event."""
        body: dict[str, Any] = {
            "action": self.action,
            "type": self.event_type,
            "data": self.data,
            "url": self.url,
            "createdAt": self.created_at,
            "workspaceId": self.workspace_id,
            "webhookId": webhook_id,
            "webhookDeliveryId": delivery_id,
            "webhookTimestamp": timestamp_ms,
        }
        if self.updated_from is not None:
            body["updatedFrom"] = self.updated_from
        return body


def bounded(value: Any) -> Any:
    """A text value cut to `TEXT_LIMIT` characters, anything else unchanged."""
    if isinstance(value, str) and len(value) > TEXT_LIMIT:
        return value[:TEXT_LIMIT]
    return value


def _plain(value: Any) -> Any:
    """A stream image value as plain JSON: sets become sorted lists, whole decimals ints."""
    if isinstance(value, (set, frozenset)):
        return sorted(_plain(item) for item in value)
    if isinstance(value, list):
        return [_plain(item) for item in value]
    if isinstance(value, Mapping):
        return {str(key): _plain(item) for key, item in value.items()}
    if isinstance(value, Decimal):
        return int(value) if value == int(value) else float(value)
    return bounded(value)


def _pick(image: Mapping[str, Any], fields: Mapping[str, str]) -> dict[str, Any]:
    """The public fields of one image under their public names."""
    return {public: _plain(image.get(stored)) for stored, public in fields.items()}


def updated_from(old: Mapping[str, Any], new: Mapping[str, Any], fields: Mapping[str, str]) -> dict[str, Any]:
    """The previous value of every public field that changed, keyed by its public name."""
    return {
        public: _plain(old.get(stored))
        for stored, public in fields.items()
        if _plain(old.get(stored)) != _plain(new.get(stored))
    }


def _now() -> str:
    """Now in UTC as an ISO 8601 string, for an event whose image carries no time."""
    return datetime.now(timezone.utc).isoformat()


class Links:
    """Builds web app URLs for the rows of one workspace, reading each lookup once."""

    def __init__(self, repositories: Repositories, workspace_id: str) -> None:
        """Remember the bundle and the workspace the links are for."""
        self._repositories = repositories
        self._workspace_id = workspace_id
        self._slug: str | None = None
        self._prefixes: dict[str, str] = {}

    def _base(self) -> str:
        """The workspace's root URL on the web app this environment serves."""
        if self._slug is None:
            workspace = self._repositories.workspaces.get(self._workspace_id)
            self._slug = workspace.slug if workspace is not None else ""
        return f"{settings.frontend_base_url}/w/{quote(self._slug, safe='')}"

    def team_prefix(self, team_id: str) -> str:
        """The team's current key prefix, or an empty string when it is gone."""
        if team_id not in self._prefixes:
            team = self._repositories.teams.get(self._workspace_id, team_id) if team_id else None
            self._prefixes[team_id] = team.key_prefix if team is not None else ""
        return self._prefixes[team_id]

    def issue(self, identifier: str) -> str:
        """The issue page for one display key."""
        return f"{self._base()}/issues/{quote(identifier, safe='')}"

    def project(self, project_id: str) -> str:
        """The project page."""
        return f"{self._base()}/projects/{quote(project_id, safe='')}"

    def cycle(self, team_id: str, cycle_id: str) -> str:
        """The cycle page under its team."""
        prefix = quote(self.team_prefix(team_id), safe="")
        return f"{self._base()}/team/{prefix}/cycles/{quote(cycle_id, safe='')}"

    def team_settings(self, team_id: str) -> str:
        """The team settings page, where its labels are managed."""
        return f"{self._base()}/team/{quote(self.team_prefix(team_id), safe='')}/settings"


type Builder = Callable[[Repositories, Links, str, Mapping[str, Any]], tuple[dict[str, Any], str, tuple[str, ...]]]
"""Build `data`, `url` and the team ids for one image of one type."""


def _issue(
    repositories: Repositories, links: Links, workspace_id: str, image: Mapping[str, Any]
) -> tuple[dict[str, Any], str, tuple[str, ...]]:
    """An issue's `data`, URL and team."""
    team_id = str(image.get("team_id", ""))
    identifier = display_key(repositories.teams, workspace_id, team_id, str(image.get("key", "")))
    data = {
        "id": str(image.get("issue_id", "")),
        "identifier": identifier,
        "number": _plain(image.get("number")),
        "teamId": team_id,
        **_pick(image, ISSUE_FIELDS),
        "creatorId": image.get("created_by"),
        "createdAt": image.get("created_at"),
        "updatedAt": image.get("updated_at"),
    }
    url = links.issue(identifier)
    data["url"] = url
    return data, url, (team_id,)


def _comment(
    repositories: Repositories, links: Links, workspace_id: str, image: Mapping[str, Any]
) -> tuple[dict[str, Any], str, tuple[str, ...]]:
    """A comment's `data`, URL and team, reading its issue for the key."""
    team_id = str(image.get("team_id", ""))
    issue_id = str(image.get("issue_id", ""))
    comment_id = str(image.get("comment_id", ""))
    issue = repositories.issues.get(workspace_id, issue_id) if issue_id else None
    identifier = display_key(repositories.teams, workspace_id, team_id, issue.key) if issue is not None else ""
    url = f"{links.issue(identifier)}#comment-{quote(comment_id, safe='')}" if identifier else ""
    data = {
        "id": comment_id,
        "issueId": issue_id,
        "issueIdentifier": identifier or None,
        "teamId": team_id,
        "parentId": image.get("parent_comment_id"),
        "userId": image.get("author_id"),
        **_pick(image, COMMENT_FIELDS),
        "createdAt": image.get("created_at"),
        "editedAt": image.get("edited_at"),
        "url": url,
    }
    return data, url, (team_id,)


def _project(
    repositories: Repositories, links: Links, workspace_id: str, image: Mapping[str, Any]
) -> tuple[dict[str, Any], str, tuple[str, ...]]:
    """A project's `data`, URL and every team it belongs to."""
    del repositories, workspace_id
    project_id = str(image.get("project_id", ""))
    team_ids = tuple(str(team_id) for team_id in (image.get("team_ids") or []))
    url = links.project(project_id)
    data = {
        "id": project_id,
        **_pick(image, PROJECT_FIELDS),
        "creatorId": image.get("created_by"),
        "createdAt": image.get("created_at"),
        "updatedAt": image.get("updated_at"),
        "url": url,
    }
    return data, url, team_ids


def _cycle(
    repositories: Repositories, links: Links, workspace_id: str, image: Mapping[str, Any]
) -> tuple[dict[str, Any], str, tuple[str, ...]]:
    """A cycle's `data`, URL and team."""
    del repositories, workspace_id
    team_id = str(image.get("team_id", ""))
    cycle_id = str(image.get("cycle_id", ""))
    url = links.cycle(team_id, cycle_id)
    data = {
        "id": cycle_id,
        "teamId": team_id,
        **_pick(image, CYCLE_FIELDS),
        "createdAt": image.get("created_at"),
        "updatedAt": image.get("updated_at"),
        "url": url,
    }
    return data, url, (team_id,)


def _label(
    repositories: Repositories, links: Links, workspace_id: str, image: Mapping[str, Any]
) -> tuple[dict[str, Any], str, tuple[str, ...]]:
    """A label's `data`, URL and team."""
    del repositories, workspace_id
    team_id = str(image.get("team_id", ""))
    url = links.team_settings(team_id)
    data = {
        "id": str(image.get("label_id", "")),
        "teamId": team_id,
        **_pick(image, LABEL_FIELDS),
        "createdAt": image.get("created_at"),
    }
    return data, url, (team_id,)


@dataclass(frozen=True, slots=True)
class Kind:
    """How one resource type is recognised and described."""

    resource_type: str
    event_type: str
    fields: Mapping[str, str]
    build: Builder
    time_field: str = "updated_at"


ISSUE = Kind("issues", "Issue", ISSUE_FIELDS, _issue)
COMMENT = Kind("comments", "Comment", COMMENT_FIELDS, _comment, "created_at")
PROJECT = Kind("projects", "Project", PROJECT_FIELDS, _project)
CYCLE = Kind("cycles", "Cycle", CYCLE_FIELDS, _cycle)
LABEL = Kind("labels", "IssueLabel", LABEL_FIELDS, _label, "created_at")


def describe(
    repositories: Repositories,
    kind: Kind,
    event_name: str,
    new_image: Mapping[str, Any],
    old_image: Mapping[str, Any],
) -> OutboundEvent | None:
    """Describe one change of one row, or `None` when nothing public changed."""
    action = ACTIONS.get(event_name)
    image = old_image if action == "remove" else new_image
    if action is None or not image:
        return None
    changes: dict[str, Any] | None = None
    if action == "update":
        if not old_image:
            return None
        changes = updated_from(old_image, new_image, kind.fields)
        if not changes:
            return None

    workspace_id = str(image.get("workspace_id", ""))
    links = Links(repositories, workspace_id)
    data, url, team_ids = kind.build(repositories, links, workspace_id, image)
    if action == "update" and kind is PROJECT:
        previous = tuple(str(team_id) for team_id in (old_image.get("team_ids") or []))
        team_ids = tuple(dict.fromkeys((*team_ids, *previous)))
    moment = new_image.get(kind.time_field) if action != "remove" else None
    return OutboundEvent(
        workspace_id=workspace_id,
        resource_type=kind.resource_type,
        event_type=kind.event_type,
        action=action,
        team_ids=tuple(team_id for team_id in team_ids if team_id),
        data=data,
        url=url,
        created_at=str(moment) if moment else _now(),
        updated_from=changes,
    )


def ping(workspace_id: str, webhook_id: str, label: str, team_id: str | None) -> OutboundEvent:
    """The event a "send test ping" delivers, which describes the webhook itself."""
    return OutboundEvent(
        workspace_id=workspace_id,
        resource_type="",
        event_type="Webhook",
        action="ping",
        team_ids=(team_id,) if team_id else (),
        data={"id": webhook_id, "label": label, "teamId": team_id, "message": "A test ping from Standupless."},
        url="",
        created_at=_now(),
    )
