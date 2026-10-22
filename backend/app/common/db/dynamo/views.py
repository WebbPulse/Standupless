"""The `views` table: saved filters, personal and per team, in one partition.

A saved view stores a filter and never results, so nothing here reads an issue.
Personal and team views share the workspace partition and are told apart by the
sort key prefix, which keeps "my views" and "this team's views" each one query
rather than a partition read with a filter behind it.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Iterator, Literal, Mapping, get_args

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import ConditionFailed, Repository, new_ulid

from app.common.db.dynamo.base import as_item, build_repository, delete_partition, utc_now
from app.common.db.dynamo.tables import VIEWS

ViewKind = Literal["list", "board"]

VIEW_KINDS: tuple[str, ...] = ("list", "board")

GroupBy = Literal["status", "assignee", "priority", "label", "milestone", "project", "cycle", "parent", "team", "sla"]

GROUP_BY_FIELDS: tuple[str, ...] = get_args(GroupBy)


def new_view_id() -> str:
    """A fresh saved view id, time sortable so a listing reads in creation order."""
    return new_ulid()


def personal_view_key(owner_id: str, view_id: str) -> str:
    """The sort key of one member's own view."""
    return f"user#{owner_id}#view#{view_id}"


def team_view_key(team_id: str, view_id: str) -> str:
    """The sort key of one team's shared view."""
    return f"team#{team_id}#view#{view_id}"


def workspace_view_key(view_id: str) -> str:
    """The sort key of a view shared with the whole workspace."""
    return f"{WORKSPACE_VIEW_PREFIX}{view_id}"


WORKSPACE_VIEW_PREFIX = "workspace#view#"
"""The sort key prefix every workspace shared view shares."""


VIEW_KEY_MARKER = "#view#"
"""The part of the sort key every saved view carries and no other row of the table does."""


def favorites_key(user_id: str) -> str:
    """The sort key of one member's favorite views row."""
    return f"fav#{user_id}"


def personal_view_prefix(owner_id: str) -> str:
    """The sort key prefix every personal view of one member shares."""
    return f"user#{owner_id}#view#"


def team_view_prefix(team_id: str) -> str:
    """The sort key prefix every view of one team shares."""
    return f"team#{team_id}#view#"


def view_key_for(owner_id: str, team_id: str | None, view_id: str, *, shared: bool = False) -> str:
    """The sort key a view takes, which is what decides its scope.

    Scope is derived from whether a team is named, or the view is shared with the
    whole workspace, rather than sent by the caller, so a personal view cannot be
    created carrying a team it is not scoped to.
    """
    if team_id:
        return team_view_key(team_id, view_id)
    if shared:
        return workspace_view_key(view_id)
    return personal_view_key(owner_id, view_id)


class SavedView(BaseModel):
    """One saved view: a stored filter, its sort, grouping and display settings.

    The display fields default to empty so rows saved before they existed read
    back unchanged, and `layout` falls back to `kind` at the API rather than being
    backfilled. The two display switches read an absent value as shown, which is
    what every view saved before they existed displayed. `entity` says whether the
    view lists issues or projects, an absent value reading as issues because every
    view saved before project views existed was one; a project view keeps its
    arrangement in `projects_display` and leaves the issue display fields empty.
    """

    workspace_id: str
    view_key: str
    view_id: str = Field(default_factory=new_view_id)
    name: str
    entity: str | None = None
    kind: str = "list"
    team_id: str | None = None
    filter: dict[str, Any] = Field(default_factory=dict)
    sort: str = "updated_desc"
    group_by: str | None = None
    sub_group_by: str | None = None
    ordering: str | None = None
    ordering_reversed: bool | None = None
    visible_properties: list[str] | None = None
    layout: str | None = None
    show_sub_issues: bool | None = None
    show_completed: bool | None = None
    completed_window: str | None = None
    show_archived: bool | None = None
    projects_display: dict[str, str] | None = None
    icon: str | None = None
    color: str | None = None
    description: str | None = None
    owner_id: str
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)

    @property
    def lists_projects(self) -> bool:
        """Whether this view lists projects rather than issues."""
        return self.entity == "projects"

    @property
    def scope(self) -> str:
        """Whether this view is one member's own, a whole team's or the workspace's.

        Derived from the team and the sort key rather than stored, so the two can
        never disagree with the key the row is filed under.
        """
        if self.team_id:
            return "team"
        if self.view_key.startswith(WORKSPACE_VIEW_PREFIX):
            return "workspace"
        return "personal"


FavoriteKind = Literal["issue", "project", "cycle", "view", "team", "document", "initiative"]

FAVORITE_KINDS: tuple[str, ...] = ("issue", "project", "cycle", "view", "team", "document", "initiative")
"""What a member may star, in the order the API documents them."""

FAVORITES_MAX = 100
"""The most favorites one member keeps in one workspace, so the sidebar read stays bounded."""


class FavoriteItem(BaseModel):
    """One starred thing: its kind, its id, and the team a cycle needs to be found again.

    A cycle's sort key carries its team, so the team is stored beside the id
    rather than looked up, which keeps a guessed cycle id from reading anything.
    """

    kind: str
    target_id: str
    team_id: str | None = None


class FavoriteViews(BaseModel):
    """One member's favorites in a workspace, in the order they arranged them.

    One row per member rather than a flag on each target, because a team or
    workspace view is shared and a favorite is not. `items` holds every kind;
    `view_ids` is the view subset, still written so a row stays readable by a
    function deployed before `items` existed, and read to build `items` on a row
    written before it.
    """

    workspace_id: str
    view_key: str
    user_id: str
    view_ids: list[str] = Field(default_factory=list)
    items: list[FavoriteItem] | None = None

    def ordered_items(self) -> list[FavoriteItem]:
        """The favorites in order, a row older than `items` reading as its views."""
        if self.items is not None:
            return list(self.items)
        return [FavoriteItem(kind="view", target_id=view_id) for view_id in self.view_ids]


class ViewRepository:
    """Reads and writes `views` rows, every method workspace first."""

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = build_repository(VIEWS, repository)

    def delete_workspace_rows(self, workspace_id: str) -> int:
        """Delete every row this table holds for one workspace, for the workspace purge."""
        return delete_partition(self._repository, VIEWS, workspace_id)

    def get(self, workspace_id: str, view_key: str) -> SavedView | None:
        """One saved view by its full sort key, or `None`.

        The key carries the scope, so a caller that guesses a personal key for a
        view it does not own reads nothing rather than another member's row.
        """
        if not workspace_id or not view_key:
            return None
        item = self._repository.get({"workspace_id": workspace_id, "view_key": view_key})
        return SavedView.model_validate(dict(item)) if item is not None else None

    def find(
        self, workspace_id: str, view_id: str, owner_id: str, team_ids: list[str], *, workspace_shared: bool = True
    ) -> SavedView | None:
        """One view by its id, looked for only where this caller may find it.

        A view id alone does not say which partition prefix files it, and the table
        has no index on the bare id by design: an id index would be a read path that
        skips the scope the key encodes. So the candidate keys are built from what
        the caller may see, which makes an invisible view indistinguishable from an
        absent one without a second authorization decision.
        """
        if not workspace_id or not view_id:
            return None
        candidates = [personal_view_key(owner_id, view_id)]
        if workspace_shared:
            candidates.append(workspace_view_key(view_id))
        candidates.extend(team_view_key(team_id, view_id) for team_id in team_ids)
        for view_key in candidates:
            found = self.get(workspace_id, view_key)
            if found is not None:
                return found
        return None

    def create(self, view: SavedView) -> SavedView:
        """Store a new saved view, raising `ConditionFailed` when the key is taken."""
        self._repository.put(as_item(view), condition=Attr("view_key").not_exists())
        return view

    def update(self, workspace_id: str, view_key: str, **attributes: Any) -> SavedView | None:
        """Apply `attributes` to one view, or `None` when it does not exist.

        A `None` is written rather than dropped, because `group_by` is nullable and a
        patch clearing it is the only way a caller ungroups a view. The caller sends
        only the fields it means to move, so nothing here has to guess which nulls
        were intended.

        `updated_at` moves on every patch, including one that sets a field to what
        it already held, because the contract returns it and a client comparing two
        reads should see the write happened.
        """
        values: dict[str, Any] = dict(attributes)
        values["updated_at"] = utc_now().isoformat()
        key = {"workspace_id": workspace_id, "view_key": view_key}
        try:
            item = self._repository.set_attributes(key, values, condition=Attr("view_id").exists())
        except ConditionFailed:
            return None
        return SavedView.model_validate(dict(item)) if item is not None else None

    def delete(self, workspace_id: str, view_key: str) -> bool:
        """Remove one saved view, reporting whether one was there."""
        if self.get(workspace_id, view_key) is None:
            return False
        self._repository.delete({"workspace_id": workspace_id, "view_key": view_key})
        return True

    def list_personal(self, workspace_id: str, owner_id: str, *, limit: int = 200) -> list[SavedView]:
        """Every view one member saved for themselves, oldest first."""
        return self._list(workspace_id, personal_view_prefix(owner_id), limit)

    def list_for_team(self, workspace_id: str, team_id: str, *, limit: int = 200) -> list[SavedView]:
        """Every shared view of one team, oldest first."""
        return self._list(workspace_id, team_view_prefix(team_id), limit)

    def list_workspace(self, workspace_id: str, *, limit: int = 200) -> list[SavedView]:
        """Every view shared with the whole workspace, oldest first."""
        return self._list(workspace_id, WORKSPACE_VIEW_PREFIX, limit)

    def iter_all(self, workspace_id: str) -> Iterator[SavedView]:
        """Every saved view of one workspace, personal, team and workspace ones alike, a page at a time.

        For the rare write that must reach every view naming something, such as a
        label merge repointing the filters on the merged label. Favorites rows and
        anything else that is not a view are skipped.
        """
        if not workspace_id:
            return
        for item in self._repository.iter_query(Key("workspace_id").eq(workspace_id)):
            if VIEW_KEY_MARKER in str(item.get("view_key", "")) and item.get("view_id"):
                yield SavedView.model_validate(dict(item))

    def favorite_items(self, workspace_id: str, user_id: str) -> list[FavoriteItem]:
        """One member's favorites of every kind, in the order they arranged them."""
        if not workspace_id or not user_id:
            return []
        item = self._repository.get({"workspace_id": workspace_id, "view_key": favorites_key(user_id)})
        if item is None:
            return []
        return FavoriteViews.model_validate(dict(item)).ordered_items()

    def favorites(self, workspace_id: str, user_id: str) -> list[str]:
        """One member's favorite view ids, in the order they arranged them."""
        return [row.target_id for row in self.favorite_items(workspace_id, user_id) if row.kind == "view"]

    def set_favorite_items(self, workspace_id: str, user_id: str, items: list[FavoriteItem]) -> list[FavoriteItem]:
        """Replace one member's favorites, dropping repeats and the row itself when none are left."""
        key = {"workspace_id": workspace_id, "view_key": favorites_key(user_id)}
        seen: set[tuple[str, str]] = set()
        ordered: list[FavoriteItem] = []
        for row in items:
            identity = (row.kind, row.target_id)
            if identity not in seen:
                seen.add(identity)
                ordered.append(row)
        if not ordered:
            self._repository.delete(key)
            return []
        row = FavoriteViews(
            workspace_id=workspace_id,
            view_key=key["view_key"],
            user_id=user_id,
            view_ids=[entry.target_id for entry in ordered if entry.kind == "view"],
            items=ordered,
        )
        self._repository.put(as_item(row))
        return ordered

    def _list(self, workspace_id: str, prefix: str, limit: int) -> list[SavedView]:
        """Every view under one sort key prefix, in creation order."""
        if not workspace_id or not prefix:
            return []
        items: list[Mapping[str, Any]] = list(
            self._repository.iter_query(
                Key("workspace_id").eq(workspace_id) & Key("view_key").begins_with(prefix),
                max_items=limit,
            )
        )
        rows = [SavedView.model_validate(dict(item)) for item in items]
        return sorted(rows, key=lambda row: (row.created_at, row.view_id))
