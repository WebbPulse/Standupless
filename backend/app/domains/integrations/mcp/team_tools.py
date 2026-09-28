"""The MCP tools for a workspace's teams, their members, statuses, labels and saved views.

Each one answers or writes exactly what the matching HTTP route does for the same
caller, through the same `app.common` paths and the same capability check, so a
team the credential cannot see is the same not-found here as over HTTP, and a
write a person's role forbids is refused here too. Creating a team needs what the
create route needs, a non-guest workspace role; every other team setting, and the
membership, status and label writes, need team admin, except joining or leaving a
team, which acts on the caller alone.
"""

from __future__ import annotations

from typing import Any, Mapping, Optional

from app.common import team_members, team_workflow, team_writes
from app.common.api.dependencies.authz import Capability, check_capability
from app.common.api.schemas.teams import (
    ArchiveSettingsUpdate,
    CycleSettingsUpdate,
    LabelCreate,
    LabelUpdate,
    StatusCreate,
    StatusUpdate,
    TeamCreate,
    TeamUpdate,
    display_name,
)
from app.common.db.dynamo.memberships import Membership
from app.common.db.dynamo.team_config import MAX_UPCOMING_CYCLES, ArchiveSettings, CycleSettings, Label, Status
from app.common.db.dynamo.teams import Team
from app.common.db.dynamo.users import User
from app.common.icons import icon_url
from app.common.issue_rules import require_team_admin, require_team_reader, team_role, visible_team_ids
from app.common.labels import create_label, ordered_labels
from app.common.saved_views import readable_views
from app.domains.integrations.mcp.toolkit import (
    NOT_VISIBLE,
    Tool,
    ToolCall,
    enum,
    object_schema,
    string,
    team_id_ref,
    team_ref,
)
from app.domains.integrations.mcp.transport import ToolError

VIEW_SCOPES: tuple[str, ...] = ("mine", "team", "all")

ESTIMATE_SCALES: tuple[str, ...] = ("off", "fibonacci", "linear", "tshirt")

STATUS_CATEGORIES: tuple[str, ...] = ("backlog", "unstarted", "started", "completed", "cancelled")

TEAM_ROLES: tuple[str, ...] = ("admin", "member")

ARCHIVE_PERIODS: tuple[int, ...] = (1, 3, 6, 9, 12)

TEAM_ARGUMENT = "Team: id, key such as ENG, or name"


def _integer(description: str, minimum: int, maximum: int) -> dict[str, Any]:
    """An integer property bounded as the route's schema bounds it."""
    return {"type": "integer", "minimum": minimum, "maximum": maximum, "description": description}


def _boolean(description: str) -> dict[str, Any]:
    """A boolean property carrying its description."""
    return {"type": "boolean", "description": description}


def _given(call: ToolCall, names: tuple[str, ...]) -> dict[str, Any]:
    """The named arguments the caller actually sent, so a patch leaves the rest alone."""
    return {name: call.arguments[name] for name in names if name in call.arguments}


def _team_json(team: Team) -> dict[str, Any]:
    """One team's identity, as every team tool answers it."""
    return {
        "team_id": team.team_id,
        "name": team.name,
        "key_prefix": team.key_prefix,
        "description": team.description,
        "estimate_scale": team.estimate_scale,
        "icon_url": icon_url(team.icon_key),
    }


def _status_json(row: Status) -> dict[str, Any]:
    """One status as the tools answer it."""
    return {"status_id": row.status_id, "name": row.name, "category": row.category, "position": row.position}


def _statuses(call: ToolCall, team_id: str) -> list[dict[str, Any]]:
    """One team's statuses in board order, with their categories."""
    return [
        _status_json(row)
        for row in team_workflow.ordered_statuses(call.repositories, call.context.workspace_id, team_id)
    ]


def _label_json(label: Label) -> dict[str, Any]:
    """One label as the tools answer it."""
    return {"label_id": label.label_id, "team_id": label.team_id, "name": label.name, "color": label.color}


def _cycle_settings_json(settings: CycleSettings) -> dict[str, Any]:
    """A team's automatic cycle settings as the tools answer them."""
    return {
        "enabled": settings.enabled,
        "duration_weeks": settings.duration_weeks,
        "cooldown_weeks": settings.cooldown_weeks,
        "start_weekday": settings.start_weekday,
        "upcoming_count": settings.upcoming_count,
        "auto_add_started": settings.auto_add_started,
    }


def _archive_settings_json(settings: ArchiveSettings) -> dict[str, Any]:
    """A team's auto-archive period as the tools answer it."""
    return {"period_months": settings.period_months}


def _member_json(membership: Membership, user: Optional[User]) -> dict[str, Any]:
    """One member as the tools answer it: who they are and the role they hold."""
    return {
        "user_id": membership.user_id,
        "display_name": display_name(user),
        "email": user.email if user is not None else "",
        "avatar_url": icon_url(user.icon_key) if user is not None else None,
        "role": membership.role,
    }


def _team_member_json(call: ToolCall, membership: Membership) -> dict[str, Any]:
    """One team membership with its user row and when it was added."""
    body = _member_json(membership, call.repositories.users.get(membership.user_id))
    body["team_id"] = membership.team_id
    body["added_at"] = membership.joined_at.isoformat()
    return body


def _admin_team(call: ToolCall) -> Team:
    """The team named in `team_id`, held to team admin exactly as its routes are."""
    team = team_ref(call, call.require("team_id"))
    check_capability(call.repositories, call.context, Capability.TEAM_ADMIN, team.team_id)
    return team


def _reader_team(call: ToolCall) -> Team:
    """The team named in `team_id`, held to team read exactly as its routes are."""
    team = team_ref(call, call.require("team_id"))
    check_capability(call.repositories, call.context, Capability.TEAM_READ, team.team_id)
    return team


def _status_ref(call: ToolCall, team_id: str, value: Any) -> Status:
    """One status of a team, named by its id or its name, case-insensitively."""
    reference = str(value).strip()
    workspace_id = call.context.workspace_id
    found = call.repositories.team_config.get_status(workspace_id, team_id, reference)
    if found is None:
        folded = reference.casefold()
        rows = call.repositories.team_config.list_statuses(workspace_id, team_id)
        named = [row for row in rows if row.name.casefold() == folded]
        if len(named) > 1:
            raise ToolError(f"More than one status is named {reference}; pass its status_id")
        found = named[0] if named else None
    if found is None:
        raise ToolError(NOT_VISIBLE)
    return found


def _label_ref(call: ToolCall, team_id: str, value: Any) -> Label:
    """One label of a team, named by its id or its name, case-insensitively."""
    reference = str(value).strip()
    workspace_id = call.context.workspace_id
    found = call.repositories.team_config.get_label(workspace_id, team_id, reference)
    if found is None:
        folded = reference.casefold()
        rows = call.repositories.team_config.list_labels(workspace_id, team_id)
        named = [row for row in rows if row.name.casefold() == folded]
        if len(named) > 1:
            raise ToolError(f"More than one label is named {reference}; pass its label_id")
        found = named[0] if named else None
    if found is None:
        raise ToolError(NOT_VISIBLE)
    return found


def _team_member_ref(call: ToolCall, team_id: str, value: Any) -> Membership:
    """One team membership, its person named by `me`, an email address or a user id.

    Resolved against the team's own memberships rather than the workspace's, so
    someone who has left the workspace can still be removed from a team, and an
    address outside the workspace answers the same not-found as an absent member.
    """
    reference = str(value).strip()
    if not reference:
        raise ToolError("user is required")
    user_id: Optional[str] = reference
    if reference == "me":
        user_id = call.context.user_id
    elif "@" in reference:
        user = call.repositories.users.get_by_email(reference.lower())
        user_id = user.id if user is not None else None
    membership = (
        call.repositories.memberships.get_team_membership(call.context.workspace_id, team_id, user_id)
        if user_id
        else None
    )
    if membership is None:
        raise ToolError(NOT_VISIBLE)
    return membership


def _workspace_user_ref(call: ToolCall, value: Any) -> str:
    """A workspace member's user id from `me`, an email or an id.

    Someone outside the workspace answers the route's own 400, that a team
    membership cannot grant workspace access, rather than a bare not-found.
    """
    reference = str(value).strip()
    if not reference:
        raise ToolError("user is required")
    if reference == "me":
        return call.context.user_id
    if "@" in reference:
        user = call.repositories.users.get_by_email(reference.lower())
        return user.id if user is not None else reference
    return reference


def _list_teams(call: ToolCall) -> Any:
    """Every team this credential may read, with what an agent needs to write."""
    teams = call.repositories.teams.list_for_workspace(call.context.workspace_id)
    visible = [row for row in teams if call.context.can_see_team(row.team_id)]
    return {
        "teams": [
            {
                "team_id": row.team_id,
                "name": row.name,
                "key_prefix": row.key_prefix,
                "estimate_scale": row.estimate_scale,
            }
            for row in sorted(visible, key=lambda row: row.name.lower())
        ]
    }


def _get_team(call: ToolCall) -> Any:
    """One visible team with its statuses, labels, settings and the caller's role in it.

    The role is what the write tools check, so an agent can tell before trying
    whether it may create issues or labels there.
    """
    team = team_ref(call, call.require("team_id"))
    require_team_reader(call.repositories, call.context, team.team_id)
    workspace_id = call.context.workspace_id
    body = _team_json(team)
    body["caller_role"] = team_role(call.repositories, call.context, team.team_id)
    body["statuses"] = _statuses(call, team.team_id)
    body["labels"] = [_label_json(row) for row in ordered_labels(call.repositories, workspace_id, team.team_id)]
    body["cycle_settings"] = _cycle_settings_json(
        team_writes.cycle_settings(call.repositories, workspace_id, team.team_id)
    )
    body["archive_settings"] = _archive_settings_json(
        team_writes.archive_settings(call.repositories, workspace_id, team.team_id)
    )
    return body


def _create_team(call: ToolCall) -> Any:
    """Create a team with the caller as its admin, as the create route does."""
    check_capability(call.repositories, call.context, Capability.TEAM_CREATE)
    payload = TeamCreate.model_validate(_given(call, ("name", "key_prefix", "description", "estimate_scale")))
    team = team_writes.create_team(call.repositories, call.context.workspace_id, call.context.user_id, payload)
    body = _team_json(team)
    body["caller_role"] = "admin"
    body["statuses"] = _statuses(call, team.team_id)
    return body


def _update_team(call: ToolCall) -> Any:
    """Change a team's name, key prefix, description or estimate scale."""
    team = _admin_team(call)
    payload = TeamUpdate.model_validate(_given(call, ("name", "key_prefix", "description", "estimate_scale")))
    updated = team_writes.update_team(call.repositories, call.context.workspace_id, team.team_id, payload)
    body = _team_json(updated)
    body["retired_key_prefixes"] = call.repositories.teams.list_aliases(call.context.workspace_id, team.team_id)
    return body


def _update_cycle_settings(call: ToolCall) -> Any:
    """Change a team's automatic cycle settings, creating due cycles when they are on."""
    team = _admin_team(call)
    fields = ("enabled", "duration_weeks", "cooldown_weeks", "start_weekday", "upcoming_count", "auto_add_started")
    payload = CycleSettingsUpdate.model_validate(_given(call, fields))
    saved = team_writes.update_cycle_settings(call.repositories, call.context.workspace_id, team.team_id, payload)
    return {"team_id": team.team_id, **_cycle_settings_json(saved)}


def _update_archive_settings(call: ToolCall) -> Any:
    """Change after how many months a team's closed issues are archived."""
    team = _admin_team(call)
    payload = ArchiveSettingsUpdate.model_validate(_given(call, ("period_months",)))
    saved = team_writes.update_archive_settings(call.repositories, call.context.workspace_id, team.team_id, payload)
    return {"team_id": team.team_id, **_archive_settings_json(saved)}


def _list_team_members(call: ToolCall) -> Any:
    """Everyone explicitly added to one visible team, with their team roles."""
    team = _reader_team(call)
    memberships = call.repositories.memberships.list_team_members(call.context.workspace_id, team.team_id)
    users = call.repositories.users.get_many([row.user_id for row in memberships])
    members = [_member_json(row, users.get(row.user_id)) for row in memberships]
    return {"members": sorted(members, key=lambda row: (row["display_name"].lower(), row["user_id"]))}


def _add_team_member(call: ToolCall) -> Any:
    """Add a workspace member to a team, or change the role they hold there."""
    team = _admin_team(call)
    user_id = _workspace_user_ref(call, call.require("user"))
    role = str(call.optional("role", "member"))
    if role not in TEAM_ROLES:
        raise ToolError(f"role must be one of: {', '.join(TEAM_ROLES)}")
    membership = team_members.put_team_member(call.repositories, call.context.workspace_id, team.team_id, user_id, role)
    return _team_member_json(call, membership)


def _update_team_member_role(call: ToolCall) -> Any:
    """Change the role of someone already in a team."""
    team = _admin_team(call)
    role = str(call.require("role"))
    if role not in TEAM_ROLES:
        raise ToolError(f"role must be one of: {', '.join(TEAM_ROLES)}")
    current = _team_member_ref(call, team.team_id, call.require("user"))
    membership = team_members.put_team_member(
        call.repositories, call.context.workspace_id, team.team_id, current.user_id, role
    )
    return _team_member_json(call, membership)


def _remove_team_member(call: ToolCall) -> Any:
    """Remove someone from a team, refusing its last admin."""
    team = _admin_team(call)
    current = _team_member_ref(call, team.team_id, call.require("user"))
    team_members.remove_team_member(call.repositories, call.context.workspace_id, team.team_id, current.user_id)
    return {"removed": True, "team_id": team.team_id, "user_id": current.user_id}


def _join_team(call: ToolCall) -> Any:
    """Join a visible team as a member, or answer the membership already held."""
    team = _reader_team(call)
    membership = team_members.join_team(
        call.repositories, call.context.workspace_id, team.team_id, call.context.user_id
    )
    return _team_member_json(call, membership)


def _leave_team(call: ToolCall) -> Any:
    """Leave a team, refusing its last admin."""
    team = _reader_team(call)
    team_members.leave_team(call.repositories, call.context.workspace_id, team.team_id, call.context.user_id)
    return {"left": True, "team_id": team.team_id, "user_id": call.context.user_id}


def _list_statuses(call: ToolCall) -> Any:
    """One visible team's statuses in board order, with their categories."""
    team_id = team_id_ref(call, call.require("team_id"))
    require_team_reader(call.repositories, call.context, team_id)
    return {"statuses": _statuses(call, team_id)}


def _create_status(call: ToolCall) -> Any:
    """Add a status to a team, at the end of the order unless a position is given."""
    team = _admin_team(call)
    payload = StatusCreate.model_validate(_given(call, ("name", "category", "position")))
    return _status_json(
        team_workflow.create_status(call.repositories, call.context.workspace_id, team.team_id, payload)
    )


def _update_status(call: ToolCall) -> Any:
    """Rename a status, recategorise it or move it in the order."""
    team = _admin_team(call)
    found = _status_ref(call, team.team_id, call.require("status"))
    payload = StatusUpdate.model_validate(_given(call, ("name", "category", "position")))
    updated = team_workflow.update_status(
        call.repositories, call.context.workspace_id, team.team_id, found.status_id, payload
    )
    return _status_json(updated)


def _delete_status(call: ToolCall) -> Any:
    """Delete a status, refusing the last one of its category."""
    team = _admin_team(call)
    found = _status_ref(call, team.team_id, call.require("status"))
    team_workflow.delete_status(call.repositories, call.context.workspace_id, team.team_id, found.status_id)
    return {"deleted": True, "status_id": found.status_id, "name": found.name}


def _list_labels(call: ToolCall) -> Any:
    """One visible team's labels in name order, or every visible team's."""
    team = call.optional("team_id")
    if team:
        team_id = team_id_ref(call, team)
        require_team_reader(call.repositories, call.context, team_id)
        teams = [team_id]
    else:
        teams = visible_team_ids(call.repositories, call.context)
    labels: list[dict[str, Any]] = []
    for candidate in teams:
        labels.extend(
            _label_json(row) for row in ordered_labels(call.repositories, call.context.workspace_id, candidate)
        )
    return {"labels": labels}


def _create_label(call: ToolCall) -> Any:
    """Add a label to a team the caller administers, as the label route does."""
    team_id = team_id_ref(call, call.require("team_id"))
    require_team_admin(call.repositories, call.context, team_id)
    payload = LabelCreate.model_validate({"name": call.require("name"), "color": call.require("color")})
    return _label_json(create_label(call.repositories, call.context.workspace_id, team_id, payload))


def _update_label(call: ToolCall) -> Any:
    """Rename or recolour a label."""
    team = _admin_team(call)
    found = _label_ref(call, team.team_id, call.require("label"))
    payload = LabelUpdate.model_validate(_given(call, ("name", "color")))
    updated = team_workflow.update_label(
        call.repositories, call.context.workspace_id, team.team_id, found.label_id, payload
    )
    return _label_json(updated)


def _delete_label(call: ToolCall) -> Any:
    """Delete a label from a team."""
    team = _admin_team(call)
    found = _label_ref(call, team.team_id, call.require("label"))
    team_workflow.delete_label(call.repositories, call.context.workspace_id, team.team_id, found.label_id)
    return {"deleted": True, "label_id": found.label_id, "name": found.name}


def _list_users(call: ToolCall) -> Any:
    """The workspace's members, or one visible team's explicit members.

    The workspace list is what the members route answers to any workspace member,
    guests included, so an agent can resolve an assignee by name or email. With
    `team_id` it narrows to that team's memberships, and the role is the team role.
    """
    team = call.optional("team_id")
    if team:
        team_id = team_id_ref(call, team)
        require_team_reader(call.repositories, call.context, team_id)
        memberships = call.repositories.memberships.list_team_members(call.context.workspace_id, team_id)
    else:
        memberships = call.repositories.memberships.list_members(call.context.workspace_id)
    users = call.repositories.users.get_many([row.user_id for row in memberships])
    members = [_member_json(row, users.get(row.user_id)) for row in memberships]
    return {"users": sorted(members, key=lambda row: (row["display_name"].lower(), row["user_id"]))}


def _list_views(call: ToolCall) -> Any:
    """Saved views this credential may read, in name order, with their stored filters.

    A view's filter uses the issue list's own keys, so it can be passed to
    `list_issues` as is.
    """
    scope = str(call.optional("scope", "all"))
    if scope not in VIEW_SCOPES:
        raise ToolError(f"scope must be one of: {', '.join(VIEW_SCOPES)}")
    team_id = call.optional("team_id")
    rows = readable_views(call.repositories, call.context, scope, str(team_id) if team_id else None)
    return {
        "views": [
            {
                "view_id": row.view_id,
                "name": row.name,
                "team_id": row.team_id,
                "owner_id": row.owner_id,
                "layout": row.layout or row.kind,
                "filter": row.filter,
                "sort": row.sort,
                "group_by": row.group_by,
                "show_sub_issues": row.show_sub_issues is not False,
                "show_completed": row.show_completed is not False,
                "show_archived": row.show_archived is True,
            }
            for row in rows
        ]
    }


def _team_fields(required_name: bool) -> Mapping[str, Any]:
    """The team fields create and update share."""
    return {
        "name": string("The team name" if required_name else "A new name"),
        "key_prefix": string(
            "Issue key prefix, 2 to 6 uppercase letters and digits such as ENG"
            if required_name
            else "A new issue key prefix; the old one keeps resolving existing keys"
        ),
        "description": string("What the team works on"),
        "estimate_scale": enum(ESTIMATE_SCALES, "How issues are estimated"),
    }


TEAM_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="list_teams",
        description="Every team this credential can read, with key prefix and estimate scale.",
        scopes=("teams:read",),
        schema=object_schema({}),
        handler=_list_teams,
    ),
    Tool(
        name="get_team",
        description=(
            "One team with its statuses in board order, labels, cycle and archive settings, "
            "and the caller's role in it. team_id: id, key such as ENG, or name."
        ),
        scopes=("teams:read",),
        schema=object_schema({"team_id": string(TEAM_ARGUMENT)}, required=("team_id",)),
        handler=_get_team,
    ),
    Tool(
        name="create_team",
        description=(
            "Create a team with the default statuses and the caller as its admin. Guests may not create teams."
        ),
        scopes=("teams:write",),
        schema=object_schema(_team_fields(True), required=("name", "key_prefix")),
        handler=_create_team,
    ),
    Tool(
        name="update_team",
        description=(
            "Change a team's name, key prefix, description or estimate scale. Needs team admin. "
            "team_id: id, key such as ENG, or name."
        ),
        scopes=("teams:write",),
        schema=object_schema({"team_id": string(TEAM_ARGUMENT), **_team_fields(False)}, required=("team_id",)),
        handler=_update_team,
    ),
    Tool(
        name="update_team_cycle_settings",
        description=(
            "Turn a team's automatic cycles on or off and set their length, cooldown, start day and "
            "how many upcoming cycles exist. Needs team admin. Turning cycles off keeps existing cycles."
        ),
        scopes=("teams:write",),
        schema=object_schema(
            {
                "team_id": string(TEAM_ARGUMENT),
                "enabled": _boolean("Whether cycles are created automatically"),
                "duration_weeks": _integer("Cycle length in weeks", 1, 8),
                "cooldown_weeks": _integer("Weeks between cycles", 0, 2),
                "start_weekday": _integer("Day cycles start, Monday 0 to Sunday 6", 0, 6),
                "upcoming_count": _integer("How many upcoming cycles to keep created", 1, MAX_UPCOMING_CYCLES),
                "auto_add_started": _boolean("Add issues to the current cycle when they are started"),
            },
            required=("team_id",),
        ),
        handler=_update_cycle_settings,
    ),
    Tool(
        name="update_team_archive_settings",
        description=(
            "Set after how many months a team's completed and cancelled issues are archived "
            "(1, 3, 6, 9 or 12). Needs team admin."
        ),
        scopes=("teams:write",),
        schema=object_schema(
            {
                "team_id": string(TEAM_ARGUMENT),
                "period_months": {
                    "type": "integer",
                    "enum": list(ARCHIVE_PERIODS),
                    "description": "Months after closing",
                },
            },
            required=("team_id", "period_months"),
        ),
        handler=_update_archive_settings,
    ),
    Tool(
        name="list_team_members",
        description="Everyone explicitly added to a team, with team roles. team_id: id, key such as ENG, or name.",
        scopes=("members:read",),
        schema=object_schema({"team_id": string(TEAM_ARGUMENT)}, required=("team_id",)),
        handler=_list_team_members,
    ),
    Tool(
        name="add_team_member",
        description=(
            "Add a workspace member to a team as member (default) or admin, or change the role they hold. "
            "Needs team admin. user: me, email or user id."
        ),
        scopes=("members:write",),
        schema=object_schema(
            {
                "team_id": string(TEAM_ARGUMENT),
                "user": string("me, an email address or a user id"),
                "role": enum(TEAM_ROLES, "The team role, member by default"),
            },
            required=("team_id", "user"),
        ),
        handler=_add_team_member,
    ),
    Tool(
        name="update_team_member_role",
        description=(
            "Change the team role of someone already in a team. Needs team admin, "
            "and a team keeps at least one admin. user: me, email or user id."
        ),
        scopes=("members:write",),
        schema=object_schema(
            {
                "team_id": string(TEAM_ARGUMENT),
                "user": string("me, an email address or a user id"),
                "role": enum(TEAM_ROLES, "The new team role"),
            },
            required=("team_id", "user", "role"),
        ),
        handler=_update_team_member_role,
    ),
    Tool(
        name="remove_team_member",
        description=(
            "Remove someone from a team. Needs team admin; the last admin cannot be removed. "
            "A guest removed from a team loses all access to it."
        ),
        scopes=("members:write",),
        schema=object_schema(
            {"team_id": string(TEAM_ARGUMENT), "user": string("me, an email address or a user id")},
            required=("team_id", "user"),
        ),
        handler=_remove_team_member,
        destructive=True,
    ),
    Tool(
        name="join_team",
        description="Join a team the caller can see as a member. team_id: id, key such as ENG, or name.",
        scopes=("members:write",),
        schema=object_schema({"team_id": string(TEAM_ARGUMENT)}, required=("team_id",)),
        handler=_join_team,
    ),
    Tool(
        name="leave_team",
        description=(
            "Leave a team. The last admin must hand the role on first. A guest who leaves loses all access to the team."
        ),
        scopes=("members:write",),
        schema=object_schema({"team_id": string(TEAM_ARGUMENT)}, required=("team_id",)),
        handler=_leave_team,
        destructive=True,
    ),
    Tool(
        name="list_statuses",
        description="One team's statuses in board order, with their categories. team_id: id, key such as ENG, or name.",
        scopes=("statuses:read",),
        schema=object_schema({"team_id": string(TEAM_ARGUMENT)}, required=("team_id",)),
        handler=_list_statuses,
    ),
    Tool(
        name="create_status",
        description=(
            "Add a workflow status to a team, at the end of the board unless a position is given. Needs team admin."
        ),
        scopes=("statuses:write",),
        schema=object_schema(
            {
                "team_id": string(TEAM_ARGUMENT),
                "name": string("The status name"),
                "category": enum(STATUS_CATEGORIES, "Which board category it belongs to"),
                "position": _integer("Zero-based position in the board order", 0, 10000),
            },
            required=("team_id", "name", "category"),
        ),
        handler=_create_status,
    ),
    Tool(
        name="update_status",
        description="Rename a team's status, change its category or move it in the board order. Needs team admin.",
        scopes=("statuses:write",),
        schema=object_schema(
            {
                "team_id": string(TEAM_ARGUMENT),
                "status": string("The status: its id or its name"),
                "name": string("A new name"),
                "category": enum(STATUS_CATEGORIES, "A new category"),
                "position": _integer("A new zero-based position", 0, 10000),
            },
            required=("team_id", "status"),
        ),
        handler=_update_status,
    ),
    Tool(
        name="delete_status",
        description=(
            "Permanently delete a team's status. Needs team admin; the last status of a category cannot be "
            "deleted. Issues still in it are not moved, so move them first."
        ),
        scopes=("statuses:write",),
        schema=object_schema(
            {"team_id": string(TEAM_ARGUMENT), "status": string("The status: its id or its name")},
            required=("team_id", "status"),
        ),
        handler=_delete_status,
        destructive=True,
    ),
    Tool(
        name="list_labels",
        description="Labels of one team, or of every team this credential can read, in name order.",
        scopes=("labels:read",),
        schema=object_schema({"team_id": string("Narrow to one team: id, key such as ENG, or name")}),
        handler=_list_labels,
    ),
    Tool(
        name="create_label",
        description="Add a label to a team. Needs team admin. team_id: id, key such as ENG, or name.",
        scopes=("labels:write",),
        schema=object_schema(
            {
                "team_id": string(TEAM_ARGUMENT),
                "name": string("The label name, unique within the team"),
                "color": string("A hex colour such as #5e6ad2"),
            },
            required=("team_id", "name", "color"),
        ),
        handler=_create_label,
    ),
    Tool(
        name="update_label",
        description="Rename or recolour a team's label. Needs team admin. label: its id or its name.",
        scopes=("labels:write",),
        schema=object_schema(
            {
                "team_id": string(TEAM_ARGUMENT),
                "label": string("The label: its id or its name"),
                "name": string("A new name"),
                "color": string("A new hex colour such as #5e6ad2"),
            },
            required=("team_id", "label"),
        ),
        handler=_update_label,
    ),
    Tool(
        name="delete_label",
        description=(
            "Permanently delete a team's label. Needs team admin. It can no longer be applied or filtered on, "
            "and this cannot be undone."
        ),
        scopes=("labels:write",),
        schema=object_schema(
            {"team_id": string(TEAM_ARGUMENT), "label": string("The label: its id or its name")},
            required=("team_id", "label"),
        ),
        handler=_delete_label,
        destructive=True,
    ),
    Tool(
        name="list_users",
        description=(
            "Workspace members with id, display name, email and workspace role, "
            "or one team's members and team roles with team_id. Use the user_id as an assignee."
        ),
        scopes=("members:read",),
        schema=object_schema({"team_id": string("Narrow to one team's members: id, key such as ENG, or name")}),
        handler=_list_users,
    ),
    Tool(
        name="list_views",
        description=(
            "Saved views this credential can read: 'mine' the caller's own, 'team' shared team views, "
            "'all' both (the default). Each carries its issue list filter and sort."
        ),
        scopes=("views:read",),
        schema=object_schema(
            {
                "scope": enum(VIEW_SCOPES, "Which views, defaulting to all"),
                "team_id": string("Narrow to one team"),
            }
        ),
        handler=_list_views,
    ),
)
