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
from app.common.db.dynamo.views import FAVORITES_MAX

FavoriteKindField = Literal["issue", "project", "cycle", "view", "team", "document", "initiative"]


class FavoriteRef(BaseModel):
    """One favorite named by its kind and id, as an add or a reorder sends it.

    `team_id` is needed only for a cycle, whose key carries its team.
    """

    kind: FavoriteKindField
    target_id: str = Field(min_length=1, max_length=64)
    team_id: Optional[str] = Field(default=None, max_length=64)


class FavoriteOrder(BaseModel):
    """The caller's favorites in their new order.

    Favorites the list leaves out keep their relative order after the named
    ones, and names that are not favorites are ignored, so a reorder racing an
    add or a removal in another tab never drops or resurrects anything.
    """

    items: list[FavoriteRef] = Field(max_length=FAVORITES_MAX)


class FavoriteRead(BaseModel):
    """One favorite as the sidebar draws it.

    `title` is the issue title, or the name of the project, cycle, view, team,
    document or initiative. `issue_key` and `status` are set for an issue, and
    `team_key_prefix` wherever the target belongs to one team, which is what a
    client builds a team or cycle link from. `icon` and `color` are the target's
    own, where it has them.
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


class FavoriteListRead(BaseModel):
    """The caller's favorites in their order, each one they can still read."""

    favorites: list[FavoriteRead]
