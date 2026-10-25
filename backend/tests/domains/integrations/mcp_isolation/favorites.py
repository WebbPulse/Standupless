"""Isolation arguments for the favorites MCP tools.

Favorites are keyed by the credential's own user in the key's own workspace, so
listing answers from home, and removing a foreign target answers removed=false
from the caller's own row rather than a refusal. Starring or reordering a foreign
row refuses, because its target never resolves.
"""

from __future__ import annotations

from typing import Any

from app.common.db.dynamo.views import FavoriteFolder
from tests.domains.helpers import OWNER

ANSWERS_AT_HOME: frozenset[str] = frozenset(
    {"list_favorites", "remove_favorite", "create_favorite_folder", "delete_favorite_folder"}
)

FOREIGN_FOLDER = "01JB000000000000000FOREIGNF"


def seed(repositories: Any, workspace_id: str, team_id: str) -> dict[str, str]:
    """A favorite folder in the other workspace, on the owner's own row there."""
    repositories.views.set_favorites(
        workspace_id, OWNER, [], [FavoriteFolder(folder_id=FOREIGN_FOLDER, name="Foreign folder")]
    )
    return {"favorite_folder_id": FOREIGN_FOLDER}


def arguments(foreign: dict[str, str], home_issue: str) -> dict[str, dict[str, Any]]:
    """Arguments naming the other workspace's rows, one set per tool."""
    return {
        "list_favorites": {},
        "add_favorite": {"kind": "issue", "target": foreign["issue_id"]},
        "remove_favorite": {"kind": "team", "target": foreign["team_id"]},
        "reorder_favorites": {"order": [{"kind": "project", "target": foreign["project_id"]}]},
        "create_favorite_folder": {"name": "Home folder"},
        "rename_favorite_folder": {"folder": foreign["favorite_folder_id"], "name": "Renamed"},
        "delete_favorite_folder": {"folder": foreign["favorite_folder_id"]},
    }
