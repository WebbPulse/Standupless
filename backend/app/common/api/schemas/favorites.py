"""Request and response schemas for a member's favorites, shared by the favorites routes and the MCP tools.

Held in `common` because the integrations image may not import another domain's
code, and a tool that stars something must validate exactly what the route does.
A favorite answers what the sidebar draws for it, resolved at read time, so a
renamed project or a moved issue never shows a stale title or key.
"""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

from app.common.api.schemas.teams import StatusRead
from app.common.db.dynamo.views import FAVORITE_FOLDER_NAME_MAX, FAVORITE_FOLDERS_MAX, FAVORITES_MAX

FavoriteKindField = Literal["issue", "project", "cycle", "view", "team", "document", "initiative"]


class FavoriteRef(BaseModel):
    """One favorite named by its kind and id, as an add or a reorder sends it.

    `team_id` is needed only for a cycle, whose key carries its team.
    `folder_id` places the favorite in one of the caller's folders, and null
    puts it at the top level. Left out, an add files a new favorite at the top
    level and a reorder leaves the favorite in whatever folder it is in.
    """

    kind: FavoriteKindField
    target_id: str = Field(min_length=1, max_length=64)
    team_id: Optional[str] = Field(default=None, max_length=64)
    folder_id: Optional[str] = Field(default=None, max_length=64)


class FavoriteOrder(BaseModel):
    """The caller's favorites in their new order.

    Favorites the list leaves out keep their relative order after the named
    ones, and names that are not favorites are ignored, so a reorder racing an
    add or a removal in another tab never drops or resurrects anything.
    `folders` orders the caller's folders by id the same way, and leaving it
    out keeps the folders where they are.
    """

    items: list[FavoriteRef] = Field(max_length=FAVORITES_MAX)
    folders: Optional[list[str]] = Field(default=None, max_length=FAVORITE_FOLDERS_MAX)


class FavoriteRead(BaseModel):
    """One favorite as the sidebar draws it.

    `title` is the issue title, or the name of the project, cycle, view, team,
    document or initiative. `issue_key` and `status` are set for an issue, and
    `team_key_prefix` wherever the target belongs to one team, which is what a
    client builds a team or cycle link from. `icon` and `color` are the target's
    own, where it has them. `folder_id` is the folder it sits in, or null at
    the top level.
    """

    kind: FavoriteKindField
    target_id: str
    title: str
    team_id: Optional[str] = None
    team_key_prefix: Optional[str] = None
    issue_key: Optional[str] = None
    status: Optional[StatusRead] = None
    icon: Optional[str] = None
    color: Optional[str] = None
    parent_kind: Optional[str] = None
    parent_id: Optional[str] = None
    folder_id: Optional[str] = None


class FavoriteFolderWrite(BaseModel):
    """A favorite folder's name, as creating or renaming one sends it."""

    name: str = Field(min_length=1, max_length=FAVORITE_FOLDER_NAME_MAX)


class FavoriteFolderRead(BaseModel):
    """One of the caller's favorite folders, `position` counting from 0 at the top."""

    folder_id: str
    name: str
    position: int


class FavoriteListRead(BaseModel):
    """The caller's favorites in their order, each one they can still read, and their folders in theirs."""

    favorites: list[FavoriteRead]
    folders: list[FavoriteFolderRead] = Field(default_factory=list)
