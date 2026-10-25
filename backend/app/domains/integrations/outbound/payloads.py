"""What an outbound webhook says about one row change, in the shape Linear's webhooks use.

Every body carries `action` (`create`, `update` or `remove`), `type`, `data`, `url` and
`createdAt`, and an update also carries `updatedFrom`: the previous value of every field
that changed, keyed like `data`. An update that touched none of a type's public fields,
such as a rollup counter the product maintains itself, describes nothing and is dropped.

An Issue's `data` also carries its SLA timer as `slaStartedAt`, `slaBreachesAt`,
`slaPausedAt` and `slaBreached`, all null when no SLA rule applies. They are read off the row when the
change is described, so they never make an update on their own.

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
from app.common.db.dynamo.planning import Initiative
from app.common.issue_keys import display_key
from app.common.readable_ids import readable_id

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
    "archived_at": "archivedAt",
}
"""The issue fields whose change is news, and their public names.

`archived_at` makes an archive or a restore an Issue `update` whose `updatedFrom`
carries the previous `archivedAt`, the shape Linear's own webhooks send.
"""

COMMENT_FIELDS: dict[str, str] = {"body": "body"}

PROJECT_FIELDS: dict[str, str] = {
    "name": "name",
    "description": "description",
    "status": "status",
    "lead_id": "leadId",
    "start_date": "startDate",
    "target_date": "targetDate",
    "start_date_resolution": "startDateResolution",
    "target_date_resolution": "targetDateResolution",
    "team_ids": "teamIds",
    "icon": "icon",
    "color": "color",
    "health": "health",
    "priority": "priority",
    "member_ids": "memberIds",
    "label_ids": "labelIds",
}

CYCLE_FIELDS: dict[str, str] = {
    "name": "name",
    "start_date": "startsAt",
    "end_date": "endsAt",
    "goal": "goal",
    "cancelled": "cancelled",
}

PROJECT_UPDATE_FIELDS: dict[str, str] = {"body": "body", "health": "health"}

LABEL_FIELDS: dict[str, str] = {"name": "name", "color": "color", "parent_id": "parentId"}

DOCUMENT_FIELDS: dict[str, str] = {
    "title": "title",
    "icon": "icon",
    "parent_kind": "parentKind",
    "parent_id": "parentId",
    "updated_by": "updatedById",
    "updated_at": "updatedAt",
}
"""The document summary fields whose change is news.

The body lives on another row, so an edit of the text alone shows here as a new
`updatedAt`, and a search terms rewrite, which moves none of these, sends nothing.
"""

INITIATIVE_FIELDS: dict[str, str] = {
    "name": "name",
    "description": "description",
    "status": "status",
    "health": "health",
    "owner_id": "ownerId",
    "team_id": "teamId",
    "parent_initiative_id": "parentInitiativeId",
    "start_date": "startDate",
    "start_date_resolution": "startDateResolution",
    "target_date": "targetDate",
    "target_date_resolution": "targetDateResolution",
}

INITIATIVE_UPDATE_FIELDS: dict[str, str] = {"body": "body", "health": "health"}

CUSTOMER_FIELDS: dict[str, str] = {
    "name": "name",
    "domains": "domains",
    "status": "status",
    "tier": "tier",
    "owner_id": "ownerId",
    "revenue": "revenue",
    "size": "size",
}

CUSTOMER_REQUEST_FIELDS: dict[str, str] = {
    "customer_id": "customerId",
    "target_kind": "targetKind",
    "target_id": "targetId",
    "team_ids": "teamIds",
    "body": "body",
    "important": "important",
}

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

    def project(self, project_id: str, name: str | None = None) -> str:
        """The project page, in its readable form when the name is known."""
        return f"{self._base()}/projects/{quote(readable_id(project_id, name), safe='')}"

    def project_update(self, project_id: str, update_id: str, name: str | None = None) -> str:
        """One update on its project's updates tab."""
        return f"{self.project(project_id, name)}?tab=updates#update-{quote(update_id, safe='')}"

    def initiative(self, initiative_id: str, name: str | None = None) -> str:
        """The initiative page, in its readable form when the name is known."""
        return f"{self._base()}/initiatives/{quote(readable_id(initiative_id, name), safe='')}"

    def initiative_update(self, initiative_id: str, update_id: str, name: str | None = None) -> str:
        """One update on its initiative's updates tab."""
        return f"{self.initiative(initiative_id, name)}?tab=updates#update-{quote(update_id, safe='')}"

    def document(self, document_id: str) -> str:
        """The document page, which finds its parent from the id alone."""
        return f"{self._base()}/documents/{quote(document_id, safe='')}"

    def customer(self, customer_id: str) -> str:
        """The customer page, which lists its requests."""
        return f"{self._base()}/customers/{quote(customer_id, safe='')}"

    def cycle(self, team_id: str, cycle_id: str) -> str:
        """The cycle page under its team."""
        prefix = quote(self.team_prefix(team_id), safe="")
        return f"{self._base()}/team/{prefix}/cycles/{quote(cycle_id, safe='')}"

    def standup(self, team_id: str, day: str) -> str:
        """The team's standup page on one digest date."""
        prefix = quote(self.team_prefix(team_id), safe="")
        return f"{self._base()}/team/{prefix}/standup?date={quote(day, safe='')}"

    def team_settings(self, team_id: str) -> str:
        """The team settings page, where its labels are managed."""
        return f"{self._base()}/team/{quote(self.team_prefix(team_id), safe='')}/settings"

    def integrations_settings(self) -> str:
        """The workspace integrations page, where Slack, Discord and workspace channels are managed."""
        return f"{self._base()}/settings/integrations"

    def notification_settings(self) -> str:
        """The caller's notification settings page, where chat direct messages are linked."""
        return f"{self._base()}/settings/notifications"


type Built = tuple[dict[str, Any], str, tuple[str, ...] | None]
"""One image's `data`, `url` and team ids, the teams `None` when the event must not be sent."""

type Builder = Callable[[Repositories, Links, str, Mapping[str, Any]], Built]
"""Build `data`, `url` and the team ids for one image of one type.

A builder answers `None` for the teams when it cannot tell which teams a row
belongs to, such as a document whose project is already gone. Sending that row
as workspace wide could carry a private team's text to a webhook outside it, so
the event is withheld instead.
"""


def _moment(value: Any) -> datetime | None:
    """A stored ISO 8601 time as an aware datetime, or `None` when it is absent or unreadable."""
    if not isinstance(value, str) or not value:
        return None
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        return None
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


def _issue_sla(image: Mapping[str, Any], now: datetime | None = None) -> dict[str, Any]:
    """The issue's SLA timer as a receiver reads it: start, due time, pause, breached flag and clock.

    All of them are null when no SLA rule applies to the issue, and an archived
    issue's timer no longer runs, so it reads as not breached. A paused timer is
    judged at the moment it paused.
    """
    breaches_at = _moment(image.get("sla_breaches_at"))
    if breaches_at is None:
        return {
            "slaStartedAt": None,
            "slaBreachesAt": None,
            "slaPausedAt": None,
            "slaBreached": None,
            "slaCalendar": None,
            "slaTimezone": None,
        }
    archived = bool(image.get("archived_at"))
    moment = now or datetime.now(timezone.utc)
    paused_at = _moment(image.get("sla_paused_at"))
    if paused_at is not None and paused_at < moment:
        moment = paused_at
    return {
        "slaStartedAt": image.get("sla_started_at") or None,
        "slaBreachesAt": image.get("sla_breaches_at"),
        "slaPausedAt": image.get("sla_paused_at") or None,
        "slaBreached": not archived and moment >= breaches_at,
        "slaCalendar": "business_days" if image.get("sla_timezone") else "calendar",
        "slaTimezone": image.get("sla_timezone") or None,
    }


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
        **_issue_sla(image),
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
    url = links.project(project_id, str(image.get("name") or ""))
    data = {
        "id": project_id,
        **_pick(image, PROJECT_FIELDS),
        "creatorId": image.get("created_by"),
        "createdAt": image.get("created_at"),
        "updatedAt": image.get("updated_at"),
        "url": url,
    }
    return data, url, team_ids


def _project_update(
    repositories: Repositories, links: Links, workspace_id: str, image: Mapping[str, Any]
) -> tuple[dict[str, Any], str, tuple[str, ...]]:
    """A project update's `data`, URL and its project's teams, read off the project row.

    The update row carries no teams of its own, so the project is read for them;
    an update whose project is already gone reaches only workspace wide webhooks.
    """
    project_id = str(image.get("project_id", ""))
    update_id = str(image.get("update_id", ""))
    project = repositories.planning.get_project(workspace_id, project_id) if project_id else None
    team_ids = tuple(project.team_ids) if project is not None else ()
    url = links.project_update(project_id, update_id, project.name if project is not None else None)
    data = {
        "id": update_id,
        "projectId": project_id,
        "projectName": project.name if project is not None else None,
        "userId": image.get("author_id"),
        **_pick(image, PROJECT_UPDATE_FIELDS),
        "createdAt": image.get("created_at"),
        "updatedAt": image.get("updated_at"),
        "editedAt": image.get("edited_at"),
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
        "isGroup": bool(image.get("is_group")),
        "createdAt": image.get("created_at"),
    }
    return data, url, (team_id,)


def _initiative_teams(initiative: Initiative) -> tuple[str, ...]:
    """An initiative's lead team as an event's teams, none for a workspace level one."""
    return (initiative.team_id,) if initiative.team_id else ()


def _document_parent(
    repositories: Repositories, workspace_id: str, parent_kind: str, parent_id: str
) -> tuple[dict[str, Any], tuple[str, ...] | None]:
    """The parent ids a document's `data` names, and the teams its parent gives it.

    A team parent is its own team. A project gives its teams and an initiative its
    lead team, read off the parent row, and a parent that can no longer be read
    gives `None`, which withholds the event.
    """
    ids: dict[str, Any] = {"projectId": None, "initiativeId": None, "teamId": None}
    if parent_kind == "team":
        ids["teamId"] = parent_id
        return ids, (parent_id,)
    if parent_kind == "project":
        ids["projectId"] = parent_id
        project = repositories.planning.get_project(workspace_id, parent_id) if parent_id else None
        return ids, tuple(project.team_ids) if project is not None else None
    if parent_kind == "initiative":
        ids["initiativeId"] = parent_id
        initiative = repositories.planning.get_initiative(workspace_id, parent_id) if parent_id else None
        return ids, _initiative_teams(initiative) if initiative is not None else None
    return ids, None


def _document(repositories: Repositories, links: Links, workspace_id: str, image: Mapping[str, Any]) -> Built:
    """A document's `data`, URL and its parent's teams, with the Markdown read off its body row.

    A removed document's body is gone with it, so its `content` is null.
    """
    document_id = str(image.get("document_id", ""))
    parent_kind = str(image.get("parent_kind", ""))
    parent_id = str(image.get("parent_id", ""))
    parents, team_ids = _document_parent(repositories, workspace_id, parent_kind, parent_id)
    body = repositories.documents.get_body(workspace_id, document_id) if document_id else None
    url = links.document(document_id)
    data = {
        "id": document_id,
        **_pick(image, DOCUMENT_FIELDS),
        **parents,
        "content": bounded(body.body) if body is not None else None,
        "creatorId": image.get("author_id"),
        "createdAt": image.get("created_at"),
        "url": url,
    }
    return data, url, team_ids


def _initiative(repositories: Repositories, links: Links, workspace_id: str, image: Mapping[str, Any]) -> Built:
    """An initiative's `data`, URL and lead team, none for a workspace level initiative."""
    del repositories, workspace_id
    initiative_id = str(image.get("initiative_id", ""))
    team_id = str(image.get("team_id") or "")
    url = links.initiative(initiative_id, str(image.get("name") or ""))
    data = {
        "id": initiative_id,
        **_pick(image, INITIATIVE_FIELDS),
        "creatorId": image.get("created_by"),
        "createdAt": image.get("created_at"),
        "updatedAt": image.get("updated_at"),
        "url": url,
    }
    return data, url, (team_id,) if team_id else ()


def _initiative_update(repositories: Repositories, links: Links, workspace_id: str, image: Mapping[str, Any]) -> Built:
    """An initiative update's `data`, URL and its initiative's lead team, read off the initiative row.

    An update whose initiative is already gone is withheld, since its row alone
    cannot say whether the initiative belonged to a private team.
    """
    initiative_id = str(image.get("initiative_id", ""))
    update_id = str(image.get("update_id", ""))
    initiative = repositories.planning.get_initiative(workspace_id, initiative_id) if initiative_id else None
    name = initiative.name if initiative is not None else None
    url = links.initiative_update(initiative_id, update_id, name)
    data = {
        "id": update_id,
        "initiativeId": initiative_id,
        "initiativeName": name,
        "userId": image.get("author_id"),
        **_pick(image, INITIATIVE_UPDATE_FIELDS),
        "createdAt": image.get("created_at"),
        "updatedAt": image.get("updated_at"),
        "editedAt": image.get("edited_at"),
        "url": url,
    }
    return data, url, _initiative_teams(initiative) if initiative is not None else None


def _customer(repositories: Repositories, links: Links, workspace_id: str, image: Mapping[str, Any]) -> Built:
    """A customer's `data` and URL; a customer belongs to no team, so only workspace wide webhooks hear it."""
    del repositories, workspace_id
    customer_id = str(image.get("customer_id", ""))
    url = links.customer(customer_id)
    data = {
        "id": customer_id,
        **_pick(image, CUSTOMER_FIELDS),
        "creatorId": image.get("created_by"),
        "createdAt": image.get("created_at"),
        "updatedAt": image.get("updated_at"),
        "url": url,
    }
    return data, url, ()


def _customer_request(repositories: Repositories, links: Links, workspace_id: str, image: Mapping[str, Any]) -> Built:
    """A customer request's `data`, URL and the teams of the issue or project it names."""
    del repositories, workspace_id
    customer_id = str(image.get("customer_id", ""))
    team_ids = tuple(str(team_id) for team_id in (image.get("team_ids") or []))
    url = links.customer(customer_id)
    data = {
        "id": str(image.get("request_id", "")),
        **_pick(image, CUSTOMER_REQUEST_FIELDS),
        "creatorId": image.get("author_id"),
        "createdAt": image.get("created_at"),
        "updatedAt": image.get("updated_at"),
        "url": url,
    }
    return data, url, team_ids


@dataclass(frozen=True, slots=True)
class Kind:
    """How one resource type is recognised and described.

    `team_field` names the row attribute that holds its teams when a change can
    move the row between teams, so an update also reaches the teams it left.
    `teams_from_parent` says the teams come from a parent row instead, so an
    update also reaches the teams of the parent the old image names.
    """

    resource_type: str
    event_type: str
    fields: Mapping[str, str]
    build: Builder
    time_field: str = "updated_at"
    team_field: str | None = None
    teams_from_parent: bool = False


ISSUE = Kind("issues", "Issue", ISSUE_FIELDS, _issue)
COMMENT = Kind("comments", "Comment", COMMENT_FIELDS, _comment, "created_at")
PROJECT = Kind("projects", "Project", PROJECT_FIELDS, _project, team_field="team_ids")
CYCLE = Kind("cycles", "Cycle", CYCLE_FIELDS, _cycle)
PROJECT_UPDATE = Kind("project_updates", "ProjectUpdate", PROJECT_UPDATE_FIELDS, _project_update, "created_at")
LABEL = Kind("labels", "IssueLabel", LABEL_FIELDS, _label, "created_at")
DOCUMENT = Kind("documents", "Document", DOCUMENT_FIELDS, _document, teams_from_parent=True)
INITIATIVE = Kind("initiatives", "Initiative", INITIATIVE_FIELDS, _initiative, team_field="team_id")
INITIATIVE_UPDATE = Kind(
    "initiative_updates", "InitiativeUpdate", INITIATIVE_UPDATE_FIELDS, _initiative_update, "created_at"
)
CUSTOMER = Kind("customers", "Customer", CUSTOMER_FIELDS, _customer)
CUSTOMER_REQUEST = Kind(
    "customer_requests", "CustomerNeed", CUSTOMER_REQUEST_FIELDS, _customer_request, "created_at", "team_ids"
)


def _row_teams(image: Mapping[str, Any], team_field: str) -> tuple[str, ...]:
    """The teams one image names in its team attribute, a list or a single id."""
    value = image.get(team_field)
    if isinstance(value, str):
        return (value,) if value else ()
    return tuple(str(team_id) for team_id in (value or []))


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
    if team_ids is None:
        return None
    if action == "update" and kind.team_field is not None:
        team_ids = tuple(dict.fromkeys((*team_ids, *_row_teams(old_image, kind.team_field))))
    if action == "update" and kind.teams_from_parent:
        _, previous = _document_parent(
            repositories, workspace_id, str(old_image.get("parent_kind", "")), str(old_image.get("parent_id", ""))
        )
        team_ids = tuple(dict.fromkeys((*team_ids, *(previous or ()))))
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
