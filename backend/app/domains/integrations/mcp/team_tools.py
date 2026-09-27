"""The MCP tools that read a workspace's teams, members, labels and saved views.

Each one answers exactly what the matching HTTP read answers to the same caller,
through the same `app.common` visibility helpers, so a team the credential cannot
see is the same not-found here as over HTTP. Creating a label is the one write,
held to team admin as the label route is, because a team's label set is a setting
every one of its issues draws on.
"""

from __future__ import annotations

from typing import Any, Optional

from app.common.api.schemas.teams import LabelCreate, display_name
from app.common.db.dynamo.memberships import Membership
from app.common.db.dynamo.team_config import Label
from app.common.db.dynamo.users import User
from app.common.issue_rules import require_team_admin, require_team_reader, team_role, visible_team_ids
from app.common.labels import create_label, ordered_labels
from app.common.saved_views import readable_views
from app.domains.integrations.mcp.toolkit import Tool, ToolCall, enum, object_schema, string
from app.domains.integrations.mcp.transport import ToolError

VIEW_SCOPES: tuple[str, ...] = ("mine", "team", "all")


def _team_json(call: ToolCall, team_id: str) -> dict[str, Any]:
    """One visible team's identity, as the listing and the single read share it."""
    team = call.repositories.teams.get(call.context.workspace_id, team_id)
    if team is None:
        raise ToolError("Not found, or not visible to this credential")
    return {
        "team_id": team.team_id,
        "name": team.name,
        "key_prefix": team.key_prefix,
        "description": team.description,
        "estimate_scale": team.estimate_scale,
    }


def _statuses(call: ToolCall, team_id: str) -> list[dict[str, Any]]:
    """One team's statuses in board order, with their categories."""
    rows = call.repositories.team_config.list_statuses(call.context.workspace_id, team_id)
    return [
        {"status_id": row.status_id, "name": row.name, "category": row.category, "position": row.position}
        for row in sorted(rows, key=lambda row: row.position)
    ]


def _label_json(label: Label) -> dict[str, Any]:
    """One label as the tools answer it."""
    return {"label_id": label.label_id, "team_id": label.team_id, "name": label.name, "color": label.color}


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
    """One visible team with its statuses, its labels and the caller's role in it.

    The role is what the write tools check, so an agent can tell before trying
    whether it may create issues or labels there.
    """
    team_id = str(call.require("team_id"))
    require_team_reader(call.repositories, call.context, team_id)
    body = _team_json(call, team_id)
    body["caller_role"] = team_role(call.repositories, call.context, team_id)
    body["statuses"] = _statuses(call, team_id)
    body["labels"] = [_label_json(row) for row in ordered_labels(call.repositories, call.context.workspace_id, team_id)]
    return body


def _list_statuses(call: ToolCall) -> Any:
    """One visible team's statuses in board order, with their categories."""
    team_id = str(call.require("team_id"))
    require_team_reader(call.repositories, call.context, team_id)
    return {"statuses": _statuses(call, team_id)}


def _list_labels(call: ToolCall) -> Any:
    """One visible team's labels in name order, or every visible team's."""
    team_id = call.optional("team_id")
    if team_id:
        require_team_reader(call.repositories, call.context, str(team_id))
        teams = [str(team_id)]
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
    team_id = str(call.require("team_id"))
    require_team_admin(call.repositories, call.context, team_id)
    payload = LabelCreate.model_validate({"name": call.require("name"), "color": call.require("color")})
    return _label_json(create_label(call.repositories, call.context.workspace_id, team_id, payload))


def _member_json(membership: Membership, user: Optional[User]) -> dict[str, Any]:
    """One member as the tools answer it: who they are and the role they hold."""
    return {
        "user_id": membership.user_id,
        "display_name": display_name(user),
        "email": user.email if user is not None else "",
        "role": membership.role,
    }


def _list_users(call: ToolCall) -> Any:
    """The workspace's members, or one visible team's explicit members.

    The workspace list is what the members route answers to any workspace member,
    guests included, so an agent can resolve an assignee by name or email. With
    `team_id` it narrows to that team's memberships, and the role is the team role.
    """
    team_id = call.optional("team_id")
    if team_id:
        require_team_reader(call.repositories, call.context, str(team_id))
        memberships = call.repositories.memberships.list_team_members(call.context.workspace_id, str(team_id))
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
        description="One team with its statuses in board order, its labels and the caller's role in it.",
        scopes=("teams:read",),
        schema=object_schema({"team_id": string("The team to read")}, required=("team_id",)),
        handler=_get_team,
    ),
    Tool(
        name="list_statuses",
        description="One team's statuses in board order, with their categories.",
        scopes=("teams:read",),
        schema=object_schema({"team_id": string("The team to read")}, required=("team_id",)),
        handler=_list_statuses,
    ),
    Tool(
        name="list_labels",
        description="Labels of one team, or of every team this credential can read, in name order.",
        scopes=("teams:read",),
        schema=object_schema({"team_id": string("Narrow to one team")}),
        handler=_list_labels,
    ),
    Tool(
        name="create_label",
        description="Add a label to a team. Needs team admin, as the label route does.",
        scopes=("issues:write",),
        schema=object_schema(
            {
                "team_id": string("The team to add it to"),
                "name": string("The label name, unique within the team"),
                "color": string("A hex colour such as #5e6ad2"),
            },
            required=("team_id", "name", "color"),
        ),
        handler=_create_label,
    ),
    Tool(
        name="list_users",
        description=(
            "Workspace members with id, display name, email and workspace role, "
            "or one team's members and team roles with team_id. Use the user_id as an assignee."
        ),
        scopes=("teams:read",),
        schema=object_schema({"team_id": string("Narrow to one team's members")}),
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
