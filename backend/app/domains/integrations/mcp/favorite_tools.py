"""The MCP tools for a member's favorites, the starred items at the top of their sidebar.

Every tool runs the favorites routes' own `app.common.favorites` path, which
keys the row by the credential's own user, so no argument can reach another
member's favorites. A target is named the way a person writes it: an issue by
its key, a team by its key prefix, a project, initiative or view by its name.
"""

from __future__ import annotations

from typing import Any, get_args

from app.common.api.dependencies.authz import Capability, check_capability
from app.common.api.schemas.favorites import FavoriteKindField, FavoriteOrder, FavoriteRead, FavoriteRef
from app.common.favorites import add_favorite, list_favorites, remove_favorite, reorder_favorites
from app.domains.integrations.mcp.toolkit import (
    Tool,
    ToolCall,
    enum,
    initiative_id_ref,
    issue_ref,
    object_schema,
    project_id_ref,
    string,
    team_id_ref,
)
from app.domains.integrations.mcp.transport import ToolError
from app.domains.integrations.mcp.view_tools import view_ref

FAVORITE_KINDS: tuple[str, ...] = get_args(FavoriteKindField)


def _workspace_member(call: ToolCall) -> None:
    """Hold the capability every favorites route declares."""
    check_capability(call.repositories, call.context, Capability.WORKSPACE_READ)


def _kind(call: ToolCall) -> str:
    """The kind argument, refusing one favorites do not hold."""
    kind = str(call.require("kind")).strip().lower()
    if kind not in FAVORITE_KINDS:
        raise ToolError(f"kind must be one of {', '.join(FAVORITE_KINDS)}")
    return kind


def _target_id(call: ToolCall, kind: str, value: Any) -> str:
    """The id of the target a person named, resolved the way the matching tools resolve it."""
    if kind == "issue":
        return issue_ref(call, value).issue_id
    if kind == "team":
        return team_id_ref(call, value)
    if kind == "project":
        return project_id_ref(call, value)
    if kind == "initiative":
        return initiative_id_ref(call, value)
    if kind == "view":
        return view_ref(call, value).view_id
    reference = str(value).strip()
    if not reference:
        raise ToolError("target is required")
    return reference


def _ref(call: ToolCall, entry: Any) -> FavoriteRef:
    """One favorite reference from a reorder entry, its target resolved like the add tool's."""
    if not isinstance(entry, dict):
        raise ToolError("each order entry is an object with kind and target")
    nested = ToolCall(context=call.context, repositories=call.repositories, arguments=entry)
    kind = _kind(nested)
    return FavoriteRef.model_validate({"kind": kind, "target_id": _target_id(nested, kind, nested.require("target"))})


def _favorite_json(favorite: FavoriteRead) -> dict[str, Any]:
    """One favorite as the favorites routes answer it."""
    return favorite.model_dump(mode="json")


def _list_favorites(call: ToolCall) -> Any:
    """The caller's favorites in their sidebar order."""
    _workspace_member(call)
    return {"favorites": [_favorite_json(row) for row in list_favorites(call.repositories, call.context)]}


def _add_favorite(call: ToolCall) -> Any:
    """Star one thing the caller can read, placed last in their favorites."""
    _workspace_member(call)
    kind = _kind(call)
    target_id = _target_id(call, kind, call.require("target"))
    team = call.optional("team_id")
    if kind == "cycle":
        if team is None:
            raise ToolError("team_id is required to favorite a cycle")
        team = team_id_ref(call, team)
    ref = FavoriteRef.model_validate({"kind": kind, "target_id": target_id, "team_id": team})
    return _favorite_json(add_favorite(call.repositories, call.context, ref))


def _remove_favorite(call: ToolCall) -> Any:
    """Unstar one favorite, answering whether it was starred."""
    _workspace_member(call)
    kind = _kind(call)
    raw = str(call.require("target")).strip()
    try:
        target_id = _target_id(call, kind, raw)
    except ToolError:
        target_id = raw
    removed = remove_favorite(call.repositories, call.context, kind, target_id)
    return {"removed": removed, "kind": kind, "target_id": target_id}


def _reorder_favorites(call: ToolCall) -> Any:
    """Put the caller's favorites in a new order, the ones left out following in their old order."""
    _workspace_member(call)
    entries = call.require("order")
    if not isinstance(entries, list):
        raise ToolError("order is a list of {kind, target} objects")
    order = FavoriteOrder.model_validate({"items": [_ref(call, entry).model_dump() for entry in entries]})
    favorites = reorder_favorites(call.repositories, call.context, order)
    return {"favorites": [_favorite_json(row) for row in favorites]}


KIND = enum(FAVORITE_KINDS, "What is starred: issue, project, cycle, view, team, document or initiative")

TARGET = string(
    "The target: an issue id or key such as ENG-12, a team id, key or name, a project, initiative or view "
    "id or exact name, or a cycle or document id"
)

FAVORITE_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="list_favorites",
        description=(
            "Your favorites in sidebar order: issues, projects, cycles, views, teams, documents and initiatives "
            "you starred. Each answers its kind, target_id and current title; an issue also its key and status. "
            "Favorites on things you can no longer see are left out."
        ),
        scopes=("views:read",),
        schema=object_schema({}),
        handler=_list_favorites,
    ),
    Tool(
        name="add_favorite",
        description=(
            "Star an issue, project, cycle, view, team, document or initiative so it shows in your sidebar "
            "Favorites. It goes last; starring one already starred keeps its place. A cycle also needs team_id. "
            "Favorites are yours alone, up to 100."
        ),
        scopes=("views:write",),
        schema=object_schema(
            {
                "kind": KIND,
                "target": TARGET,
                "team_id": string("For a cycle: its team's id, key or name"),
            },
            required=("kind", "target"),
        ),
        handler=_add_favorite,
        idempotent=True,
    ),
    Tool(
        name="remove_favorite",
        description=(
            "Unstar one of your favorites. Answers removed=false when it was not starred. The item itself is "
            "untouched, and a favorite on something deleted can still be removed by its id."
        ),
        scopes=("views:write",),
        schema=object_schema({"kind": KIND, "target": TARGET}, required=("kind", "target")),
        handler=_remove_favorite,
        idempotent=True,
    ),
    Tool(
        name="reorder_favorites",
        description=(
            "Put your favorites in a new sidebar order. order lists {kind, target} objects first to last; "
            "favorites it leaves out follow in their old order, and entries that are not favorites are ignored."
        ),
        scopes=("views:write",),
        schema=object_schema(
            {
                "order": {
                    "type": "array",
                    "maxItems": 100,
                    "description": "The favorites in their new order",
                    "items": {
                        "type": "object",
                        "properties": {"kind": KIND, "target": TARGET},
                        "required": ["kind", "target"],
                        "additionalProperties": False,
                    },
                }
            },
            required=("order",),
        ),
        handler=_reorder_favorites,
        idempotent=True,
    ),
)
