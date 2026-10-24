"""The MCP tools for a member's favorites, the starred items at the top of their sidebar.

Every tool runs the favorites routes' own `app.common.favorites` path, which
keys the row by the credential's own user, so no argument can reach another
member's favorites. A target is named the way a person writes it: an issue by
its key, a team by its key prefix, a project, initiative or view by its name,
and a favorite folder by its id or its name.
"""

from __future__ import annotations

from typing import Any, get_args

from app.common.api.dependencies.authz import Capability, check_capability
from app.common.api.schemas.favorites import (
    FavoriteFolderRead,
    FavoriteFolderWrite,
    FavoriteKindField,
    FavoriteListRead,
    FavoriteOrder,
    FavoriteRead,
    FavoriteRef,
)
from app.common.favorites import (
    add_favorite,
    create_folder,
    delete_folder,
    list_favorites,
    remove_favorite,
    rename_folder,
    reorder_favorites,
)
from app.domains.integrations.mcp.toolkit import (
    Tool,
    ToolCall,
    enum,
    initiative_id_ref,
    issue_ref,
    nullable,
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


def _folder_id(call: ToolCall, value: Any) -> str:
    """The id of one of the caller's favorite folders, named by its id or its name in any case."""
    reference = str(value).strip()
    if not reference:
        raise ToolError("folder is required")
    folders = call.repositories.views.favorite_folders(call.context.workspace_id, call.context.user_id)
    for folder in folders:
        if folder.folder_id == reference:
            return folder.folder_id
    named = [folder for folder in folders if folder.name.casefold() == reference.casefold()]
    if len(named) > 1:
        raise ToolError(f"More than one favorite folder is named {reference}; name it by its id")
    if not named:
        raise ToolError(f"No favorite folder {reference}")
    return named[0].folder_id


def _placement(call: ToolCall) -> dict[str, Any]:
    """The folder an entry names, as a reference carries it: absent, null for the top level, or an id."""
    if not call.present("folder"):
        return {}
    value = call.arguments.get("folder")
    if value is None or (isinstance(value, str) and not value.strip()):
        return {"folder_id": None}
    return {"folder_id": _folder_id(call, value)}


def _ref(call: ToolCall, entry: Any) -> FavoriteRef:
    """One favorite reference from a reorder entry, its target resolved like the add tool's."""
    if not isinstance(entry, dict):
        raise ToolError("each order entry is an object with kind and target")
    nested = ToolCall(context=call.context, repositories=call.repositories, arguments=entry)
    kind = _kind(nested)
    target_id = _target_id(nested, kind, nested.require("target"))
    return FavoriteRef.model_validate({"kind": kind, "target_id": target_id, **_placement(nested)})


def _favorite_json(favorite: FavoriteRead) -> dict[str, Any]:
    """One favorite as the favorites routes answer it."""
    return favorite.model_dump(mode="json")


def _folder_json(folder: FavoriteFolderRead) -> dict[str, Any]:
    """One favorite folder as the favorites routes answer it."""
    return folder.model_dump(mode="json")


def _listing_json(listing: FavoriteListRead) -> dict[str, Any]:
    """The favorites and folders as the listing route answers them."""
    return {
        "favorites": [_favorite_json(row) for row in listing.favorites],
        "folders": [_folder_json(row) for row in listing.folders],
    }


def _list_favorites(call: ToolCall) -> Any:
    """The caller's favorites in their sidebar order, with their folders."""
    _workspace_member(call)
    return _listing_json(list_favorites(call.repositories, call.context))


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
    ref = FavoriteRef.model_validate({"kind": kind, "target_id": target_id, "team_id": team, **_placement(call)})
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
    folders = call.optional("folders")
    if folders is not None and not isinstance(folders, list):
        raise ToolError("folders is a list of folder ids or names")
    order = FavoriteOrder.model_validate(
        {
            "items": [_ref(call, entry).model_dump(exclude_unset=True) for entry in entries],
            "folders": None if folders is None else [_folder_id(call, folder) for folder in folders],
        }
    )
    return _listing_json(reorder_favorites(call.repositories, call.context, order))


def _create_favorite_folder(call: ToolCall) -> Any:
    """Add an empty favorite folder below the caller's others."""
    _workspace_member(call)
    payload = FavoriteFolderWrite.model_validate({"name": str(call.require("name"))})
    return _folder_json(create_folder(call.repositories, call.context, payload.name))


def _rename_favorite_folder(call: ToolCall) -> Any:
    """Rename one of the caller's favorite folders."""
    _workspace_member(call)
    folder_id = _folder_id(call, call.require("folder"))
    payload = FavoriteFolderWrite.model_validate({"name": str(call.require("name"))})
    return _folder_json(rename_folder(call.repositories, call.context, folder_id, payload.name))


def _delete_favorite_folder(call: ToolCall) -> Any:
    """Delete one of the caller's favorite folders, its favorites moving to the top level."""
    _workspace_member(call)
    raw = str(call.require("folder")).strip()
    try:
        folder_id = _folder_id(call, raw)
    except ToolError:
        folder_id = raw
    return {"deleted": delete_folder(call.repositories, call.context, folder_id), "folder_id": folder_id}


KIND = enum(FAVORITE_KINDS, "What is starred: issue, project, cycle, view, team, document or initiative")

TARGET = string(
    "The target: an issue id or key such as ENG-12, a team id, key or name, a project, initiative or view "
    "id or exact name, or a cycle or document id"
)

FOLDER = string("One of your favorite folders, by its id or its name")

PLACEMENT = nullable("A favorite folder by id or name to file it in, or null for the top level")

FAVORITE_TOOLS: tuple[Tool, ...] = (
    Tool(
        name="list_favorites",
        description=(
            "Your favorites in sidebar order: issues, projects, cycles, views, teams, documents and initiatives "
            "you starred. Each answers its kind, target_id, current title and folder_id (null at the top level); "
            "an issue also its key and status. folders lists your favorite folders in order. Favorites on things "
            "you can no longer see are left out."
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
            "folder files it in one of your favorite folders, and on one already starred moves it there. "
            "Favorites are yours alone, up to 100."
        ),
        scopes=("views:write",),
        schema=object_schema(
            {
                "kind": KIND,
                "target": TARGET,
                "team_id": string("For a cycle: its team's id, key or name"),
                "folder": PLACEMENT,
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
            "favorites it leaves out follow in their old order, and entries that are not favorites are ignored. "
            "An entry's folder moves it into that folder, or to the top level with null; without folder it stays "
            "where it is. folders orders your favorite folders the same way."
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
                        "properties": {"kind": KIND, "target": TARGET, "folder": PLACEMENT},
                        "required": ["kind", "target"],
                        "additionalProperties": False,
                    },
                },
                "folders": {
                    "type": "array",
                    "maxItems": 50,
                    "description": "Your favorite folders by id or name in their new order",
                    "items": {"type": "string"},
                },
            },
            required=("order",),
        ),
        handler=_reorder_favorites,
        idempotent=True,
    ),
    Tool(
        name="create_favorite_folder",
        description=(
            "Add a named folder to your sidebar Favorites, below your other folders. It starts empty; file "
            "favorites in it with add_favorite or reorder_favorites. Up to 50 folders."
        ),
        scopes=("views:write",),
        schema=object_schema({"name": string("The folder's name, up to 80 characters")}, required=("name",)),
        handler=_create_favorite_folder,
    ),
    Tool(
        name="rename_favorite_folder",
        description="Rename one of your favorite folders.",
        scopes=("views:write",),
        schema=object_schema(
            {"folder": FOLDER, "name": string("The folder's new name, up to 80 characters")},
            required=("folder", "name"),
        ),
        handler=_rename_favorite_folder,
        idempotent=True,
    ),
    Tool(
        name="delete_favorite_folder",
        description=(
            "Delete one of your favorite folders. Nothing is unstarred: its favorites move to the top level "
            "of your Favorites. Answers deleted=false when there was no such folder."
        ),
        scopes=("views:write",),
        schema=object_schema({"folder": FOLDER}, required=("folder",)),
        handler=_delete_favorite_folder,
        destructive=True,
        idempotent=True,
    ),
)
