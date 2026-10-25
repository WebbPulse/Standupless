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

FAVORITE_FOLDERS_MAX = 50
"""The most favorite folders one member keeps in one workspace."""

FAVORITE_FOLDER_NAME_MAX = 80
"""The longest name a favorite folder takes."""


def new_favorite_folder_id() -> str:
    """A fresh favorite folder id, time sortable like every other id here."""
    return new_ulid()


class FavoriteFolder(BaseModel):
    """One named folder in a member's favorites, its place being its index in the row's `folders`."""

    folder_id: str
    name: str


class FavoriteItem(BaseModel):
    """One starred thing: its kind, its id, and the team a cycle needs to be found again.

    A cycle's sort key carries its team, so the team is stored beside the id
    rather than looked up, which keeps a guessed cycle id from reading anything.
    """

    kind: str
    target_id: str
    team_id: str | None = None
    folder_id: str | None = None


class FavoriteViews(BaseModel):
    """One member's favorites in a workspace, in the order they arranged them.

    One row per member rather than a flag on each target, because a team or
    workspace view is shared and a favorite is not. `items` holds every kind;
    `view_ids` is the view subset, still written so a row stays readable by a
    function deployed before `items` existed, and read to build `items` on a row
    written before it. `folders` holds the member's favorite folders in their
    order, and an item's `folder_id` names the one it sits in, so a row written
    before folders existed reads as every favorite at the top level.
    """

    workspace_id: str
    view_key: str
    user_id: str
    view_ids: list[str] = Field(default_factory=list)
    items: list[FavoriteItem] | None = None
    folders: list[FavoriteFolder] = Field(default_factory=list)

    def ordered_items(self) -> list[FavoriteItem]:
        """The favorites in order, a row older than `items` reading as its views."""
        if self.items is not None:
            return list(self.items)
        return [FavoriteItem(kind="view", target_id=view_id) for view_id in self.view_ids]


DRAFT_PREFIX = "draft#"
"""The sort key prefix every comment draft shares."""

DRAFT_ISSUE_THREAD = "issue"
"""The thread part of a draft key for a draft on the issue itself rather than a reply."""

DRAFTS_MAX = 200
"""The most drafts one listing reads, so "my drafts" stays one bounded query."""


def draft_user_prefix(user_id: str) -> str:
    """The sort key prefix every draft of one member shares."""
    return f"{DRAFT_PREFIX}{user_id}#"


def draft_issue_prefix(user_id: str, issue_id: str) -> str:
    """The sort key prefix every draft one member holds on one issue shares."""
    return f"{draft_user_prefix(user_id)}{issue_id}#"


def draft_key(user_id: str, issue_id: str, parent_comment_id: str | None = None) -> str:
    """The sort key of one member's draft on an issue, or on one reply thread of it."""
    return f"{draft_issue_prefix(user_id, issue_id)}{parent_comment_id or DRAFT_ISSUE_THREAD}"


class CommentDraft(BaseModel):
    """One member's unposted comment on an issue, or a reply to one root comment.

    Stored beside saved views because the table has no stream, so writing a
    draft can never notify anyone, and its key starts with the author, so a
    member reads only their own. One row per member per thread: saving again
    replaces the body.
    """

    workspace_id: str
    view_key: str
    user_id: str
    issue_id: str
    team_id: str
    parent_comment_id: str | None = None
    body: str
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


ISSUE_DRAFT_PREFIX = "issuedraft#"
"""The sort key prefix every new issue draft shares, apart from the comment drafts' own."""

ISSUE_DRAFTS_MAX = 200
"""The most new issue drafts one member may hold in a workspace, and so what one listing reads."""


def issue_draft_user_prefix(user_id: str) -> str:
    """The sort key prefix every new issue draft of one member shares."""
    return f"{ISSUE_DRAFT_PREFIX}{user_id}#"


def issue_draft_key(user_id: str, draft_id: str) -> str:
    """The sort key of one member's new issue draft."""
    return f"{issue_draft_user_prefix(user_id)}{draft_id}"


class IssueDraft(BaseModel):
    """One member's unfiled new issue, everything the create dialog held when it was saved.

    Stored beside saved views for the reason comment drafts are: the table has no
    stream, so saving never notifies, and the key starts with the author, so a
    member reads only their own. The ids it names are not checked against their
    rows here, because filing the issue checks them, and a draft must keep what
    was typed even after a label or project it named is gone.
    """

    workspace_id: str
    view_key: str
    user_id: str
    draft_id: str
    team_id: str
    title: str = ""
    body: str = ""
    template_id: str | None = None
    template_title: str = ""
    template_body: str = ""
    answers: dict[str, str | bool] = Field(default_factory=dict)
    status_id: str | None = None
    priority: str = "none"
    assignee_id: str | None = None
    label_ids: list[str] = Field(default_factory=list)
    estimate: str | None = None
    project_id: str | None = None
    project_milestone_id: str | None = None
    cycle_id: str | None = None
    start_date: str | None = None
    due_date: str | None = None
    parent_id: str | None = None
    parent_key: str | None = None
    parent_title: str | None = None
    sub_issues: list[str] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


VIEW_SUBSCRIPTION_PREFIX = "viewsub#"
"""The sort key prefix every view subscription shares."""

VIEW_SUBSCRIPTIONS_MAX = 1000
"""The most subscriptions one workspace listing reads, a bound the notify consumer scans per issue write."""


def view_subscription_prefix(view_id: str) -> str:
    """The sort key prefix every subscription to one view shares."""
    return f"{VIEW_SUBSCRIPTION_PREFIX}{view_id}#"


def view_subscription_key(view_id: str, user_id: str) -> str:
    """The sort key of one member's subscription to one view."""
    return f"{view_subscription_prefix(view_id)}{user_id}"


class ViewSubscription(BaseModel):
    """One member following one saved view, to hear when an issue newly enters it.

    Stored beside the views so a subscription lives and dies with the view's
    partition, and keyed view first, so the view's subscribers are one query.
    `saved_view_key` is the subscribed view's own sort key, which tells the
    notify consumer where to read it without guessing its scope.
    """

    workspace_id: str
    view_key: str
    view_id: str
    user_id: str
    saved_view_key: str
    created_at: datetime = Field(default_factory=utc_now)


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

    def _favorites_row(self, workspace_id: str, user_id: str) -> FavoriteViews | None:
        """One member's favorites row, or `None` when they have none."""
        if not workspace_id or not user_id:
            return None
        item = self._repository.get({"workspace_id": workspace_id, "view_key": favorites_key(user_id)})
        return FavoriteViews.model_validate(dict(item)) if item is not None else None

    def favorite_items(self, workspace_id: str, user_id: str) -> list[FavoriteItem]:
        """One member's favorites of every kind, in the order they arranged them."""
        row = self._favorites_row(workspace_id, user_id)
        return row.ordered_items() if row is not None else []

    def favorite_folders(self, workspace_id: str, user_id: str) -> list[FavoriteFolder]:
        """One member's favorite folders, in the order they arranged them."""
        row = self._favorites_row(workspace_id, user_id)
        return list(row.folders) if row is not None else []

    def favorites(self, workspace_id: str, user_id: str) -> list[str]:
        """One member's favorite view ids, in the order they arranged them."""
        return [row.target_id for row in self.favorite_items(workspace_id, user_id) if row.kind == "view"]

    def set_favorite_items(self, workspace_id: str, user_id: str, items: list[FavoriteItem]) -> list[FavoriteItem]:
        """Replace one member's favorites, keeping their folders as they are."""
        folders = self.favorite_folders(workspace_id, user_id)
        stored, _ = self.set_favorites(workspace_id, user_id, items, folders)
        return stored

    def clear_favorites(self, workspace_id: str, user_id: str) -> None:
        """Remove one member's favorites and folders together."""
        self.set_favorites(workspace_id, user_id, [], [])

    def set_favorites(
        self, workspace_id: str, user_id: str, items: list[FavoriteItem], folders: list[FavoriteFolder]
    ) -> tuple[list[FavoriteItem], list[FavoriteFolder]]:
        """Replace one member's favorites and folders in one write.

        Repeats are dropped, a favorite naming a folder that is not kept moves to
        the top level, and the row itself goes once nothing is left in it.
        """
        key = {"workspace_id": workspace_id, "view_key": favorites_key(user_id)}
        kept_folders: list[FavoriteFolder] = []
        folder_ids: set[str] = set()
        for folder in folders:
            if folder.folder_id not in folder_ids:
                folder_ids.add(folder.folder_id)
                kept_folders.append(folder)
        seen: set[tuple[str, str]] = set()
        ordered: list[FavoriteItem] = []
        for row in items:
            identity = (row.kind, row.target_id)
            if identity not in seen:
                seen.add(identity)
                if row.folder_id is not None and row.folder_id not in folder_ids:
                    row = row.model_copy(update={"folder_id": None})
                ordered.append(row)
        if not ordered and not kept_folders:
            self._repository.delete(key)
            return [], []
        stored = FavoriteViews(
            workspace_id=workspace_id,
            view_key=key["view_key"],
            user_id=user_id,
            view_ids=[entry.target_id for entry in ordered if entry.kind == "view"],
            items=ordered,
            folders=kept_folders,
        )
        self._repository.put(as_item(stored))
        return ordered, kept_folders

    def get_draft(
        self, workspace_id: str, user_id: str, issue_id: str, parent_comment_id: str | None = None
    ) -> CommentDraft | None:
        """One member's draft on an issue or a reply thread, or `None`."""
        if not workspace_id or not user_id or not issue_id:
            return None
        item = self._repository.get(
            {"workspace_id": workspace_id, "view_key": draft_key(user_id, issue_id, parent_comment_id)}
        )
        return CommentDraft.model_validate(dict(item)) if item is not None else None

    def put_draft(self, draft: CommentDraft) -> CommentDraft:
        """Store a draft, replacing the one already in its thread."""
        self._repository.put(as_item(draft))
        return draft

    def delete_draft(
        self, workspace_id: str, user_id: str, issue_id: str, parent_comment_id: str | None = None
    ) -> None:
        """Remove one member's draft in one thread, a no-op when there is none."""
        if not workspace_id or not user_id or not issue_id:
            return
        key = {"workspace_id": workspace_id, "view_key": draft_key(user_id, issue_id, parent_comment_id)}
        self._repository.delete(key)

    def clear_draft_before(
        self,
        workspace_id: str,
        user_id: str,
        issue_id: str,
        parent_comment_id: str | None,
        posted_at: datetime,
    ) -> bool:
        """Remove a draft last saved no later than `posted_at`, reporting whether one went.

        For a comment that was posted: the draft it came from goes, while one
        saved after the post, such as the author starting their next comment,
        stays. The delete is conditioned on the read `updated_at`, so a save that
        lands between the read and the delete survives too.
        """
        if not workspace_id or not user_id or not issue_id:
            return False
        key = {"workspace_id": workspace_id, "view_key": draft_key(user_id, issue_id, parent_comment_id)}
        item = self._repository.get(key)
        if item is None or CommentDraft.model_validate(dict(item)).updated_at > posted_at:
            return False
        try:
            self._repository.delete(key, condition=Attr("updated_at").eq(item["updated_at"]))
        except ConditionFailed:
            return False
        return True

    def list_drafts(
        self, workspace_id: str, user_id: str, *, issue_id: str | None = None, limit: int = DRAFTS_MAX
    ) -> list[CommentDraft]:
        """One member's drafts, newest saved first, across the workspace or on one issue."""
        if not workspace_id or not user_id:
            return []
        prefix = draft_issue_prefix(user_id, issue_id) if issue_id else draft_user_prefix(user_id)
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("view_key").begins_with(prefix),
            max_items=limit,
        )
        rows = [CommentDraft.model_validate(dict(item)) for item in items]
        return sorted(rows, key=lambda row: row.updated_at, reverse=True)

    def delete_drafts_for_user(self, workspace_id: str, user_id: str) -> int:
        """Delete every draft one member holds in a workspace, for the account purge."""
        if not workspace_id or not user_id:
            return 0
        removed = 0
        for item in list(
            self._repository.iter_query(
                Key("workspace_id").eq(workspace_id) & Key("view_key").begins_with(draft_user_prefix(user_id))
            )
        ):
            self._repository.delete({"workspace_id": workspace_id, "view_key": item["view_key"]})
            removed += 1
        return removed

    def delete_drafts_for_team(self, workspace_id: str, team_id: str) -> int:
        """Delete every draft on one team's issues, whoever wrote it, for the team purge."""
        if not workspace_id or not team_id:
            return 0
        removed = 0
        for item in list(
            self._repository.iter_query(
                Key("workspace_id").eq(workspace_id) & Key("view_key").begins_with(DRAFT_PREFIX)
            )
        ):
            if item.get("team_id") == team_id:
                self._repository.delete({"workspace_id": workspace_id, "view_key": item["view_key"]})
                removed += 1
        return removed

    def get_issue_draft(self, workspace_id: str, user_id: str, draft_id: str) -> IssueDraft | None:
        """One member's new issue draft, or `None`."""
        if not workspace_id or not user_id or not draft_id:
            return None
        item = self._repository.get({"workspace_id": workspace_id, "view_key": issue_draft_key(user_id, draft_id)})
        return IssueDraft.model_validate(dict(item)) if item is not None else None

    def put_issue_draft(self, draft: IssueDraft) -> IssueDraft:
        """Store a new issue draft, replacing the one with its id."""
        self._repository.put(as_item(draft))
        return draft

    def delete_issue_draft(self, workspace_id: str, user_id: str, draft_id: str) -> None:
        """Remove one member's new issue draft, a no-op when there is none."""
        if not workspace_id or not user_id or not draft_id:
            return
        self._repository.delete({"workspace_id": workspace_id, "view_key": issue_draft_key(user_id, draft_id)})

    def list_issue_drafts(self, workspace_id: str, user_id: str, *, limit: int = ISSUE_DRAFTS_MAX) -> list[IssueDraft]:
        """One member's new issue drafts, newest saved first."""
        if not workspace_id or not user_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("view_key").begins_with(issue_draft_user_prefix(user_id)),
            max_items=limit,
        )
        rows = [IssueDraft.model_validate(dict(item)) for item in items]
        return sorted(rows, key=lambda row: (row.updated_at, row.draft_id), reverse=True)

    def delete_issue_drafts_for_user(self, workspace_id: str, user_id: str) -> int:
        """Delete every new issue draft one member holds in a workspace, for the account purge."""
        if not workspace_id or not user_id:
            return 0
        removed = 0
        for item in list(
            self._repository.iter_query(
                Key("workspace_id").eq(workspace_id) & Key("view_key").begins_with(issue_draft_user_prefix(user_id))
            )
        ):
            self._repository.delete({"workspace_id": workspace_id, "view_key": item["view_key"]})
            removed += 1
        return removed

    def delete_issue_drafts_for_team(self, workspace_id: str, team_id: str) -> int:
        """Delete every new issue draft filed to one team, whoever wrote it, for the team purge."""
        if not workspace_id or not team_id:
            return 0
        removed = 0
        for item in list(
            self._repository.iter_query(
                Key("workspace_id").eq(workspace_id) & Key("view_key").begins_with(ISSUE_DRAFT_PREFIX)
            )
        ):
            if item.get("team_id") == team_id:
                self._repository.delete({"workspace_id": workspace_id, "view_key": item["view_key"]})
                removed += 1
        return removed

    def subscribe(self, workspace_id: str, view: SavedView, user_id: str) -> ViewSubscription:
        """Subscribe one member to a view, keeping the first subscription when they already follow it."""
        existing = self.get_subscription(workspace_id, view.view_id, user_id)
        if existing is not None:
            return existing
        row = ViewSubscription(
            workspace_id=workspace_id,
            view_key=view_subscription_key(view.view_id, user_id),
            view_id=view.view_id,
            user_id=user_id,
            saved_view_key=view.view_key,
        )
        self._repository.put(as_item(row))
        return row

    def get_subscription(self, workspace_id: str, view_id: str, user_id: str) -> ViewSubscription | None:
        """One member's subscription to one view, or `None`."""
        if not workspace_id or not view_id or not user_id:
            return None
        item = self._repository.get({"workspace_id": workspace_id, "view_key": view_subscription_key(view_id, user_id)})
        return ViewSubscription.model_validate(dict(item)) if item is not None else None

    def unsubscribe(self, workspace_id: str, view_id: str, user_id: str) -> None:
        """Remove one member's subscription to one view, a no-op when there is none."""
        if not workspace_id or not view_id or not user_id:
            return
        self._repository.delete({"workspace_id": workspace_id, "view_key": view_subscription_key(view_id, user_id)})

    def subscriber_ids(self, workspace_id: str, view_id: str) -> list[str]:
        """The members subscribed to one view, oldest subscription first."""
        if not workspace_id or not view_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("view_key").begins_with(view_subscription_prefix(view_id))
        )
        rows = [ViewSubscription.model_validate(dict(item)) for item in items]
        return [row.user_id for row in sorted(rows, key=lambda row: row.created_at)]

    def list_subscriptions(self, workspace_id: str, *, limit: int = VIEW_SUBSCRIPTIONS_MAX) -> list[ViewSubscription]:
        """Every view subscription in one workspace, for the notify consumer to evaluate an issue write."""
        if not workspace_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("view_key").begins_with(VIEW_SUBSCRIPTION_PREFIX),
            max_items=limit,
        )
        return [ViewSubscription.model_validate(dict(item)) for item in items]

    def delete_view_subscriptions(self, workspace_id: str, view_id: str) -> int:
        """Delete every subscription to one view, for when the view itself goes."""
        if not workspace_id or not view_id:
            return 0
        removed = 0
        for item in list(
            self._repository.iter_query(
                Key("workspace_id").eq(workspace_id) & Key("view_key").begins_with(view_subscription_prefix(view_id))
            )
        ):
            self._repository.delete({"workspace_id": workspace_id, "view_key": item["view_key"]})
            removed += 1
        return removed

    def delete_subscriptions_for_user(self, workspace_id: str, user_id: str) -> int:
        """Delete every view subscription one member holds in a workspace, for the account purge."""
        if not workspace_id or not user_id:
            return 0
        removed = 0
        for row in list(
            self._repository.iter_query(
                Key("workspace_id").eq(workspace_id) & Key("view_key").begins_with(VIEW_SUBSCRIPTION_PREFIX)
            )
        ):
            if row.get("user_id") == user_id:
                self._repository.delete({"workspace_id": workspace_id, "view_key": row["view_key"]})
                removed += 1
        return removed

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
