"""A member's favorites: issues, projects, cycles, views, teams, documents and initiatives they starred.

Held in `common` because the favorites routes in the views image and the MCP
tools in the integrations image both run it, and that image may not import
another domain's code.

Favorites are one ordered row per member per workspace, stored beside saved
views. Nothing is copied from the target: each read resolves every favorite
against what the caller may see right now, so a favorite on a team they have
since left, or on something deleted, quietly drops out of the listing rather
than leaking a stale title. The row itself keeps it, so regaining access brings
it back, and removing one never needs to read its target.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Iterable

from fastapi import HTTPException

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.favorites import FavoriteOrder, FavoriteRead, FavoriteRef
from app.common.api.schemas.teams import StatusRead
from app.common.db.dynamo.teams import Team
from app.common.db.dynamo.views import FAVORITES_MAX, FavoriteItem
from app.common.issue_keys import current
from app.common.issue_rules import not_found, unprocessable
from app.common.planning_rules import visible_project_teams
from app.common.saved_views import load_visible_view


def _item(ref: FavoriteRef) -> FavoriteItem:
    """The stored shape of one reference, keeping a team only where a cycle needs it."""
    return FavoriteItem(kind=ref.kind, target_id=ref.target_id, team_id=ref.team_id if ref.kind == "cycle" else None)


class _Resolver:
    """Resolves favorites against one caller's visibility, reading each shared lookup once."""

    def __init__(self, repositories: Repositories, context: AuthzContext) -> None:
        """Read the workspace's teams once, since nearly every kind needs them."""
        self.repositories = repositories
        self.context = context
        self.teams: dict[str, Team] = {
            team.team_id: team for team in repositories.teams.list_for_workspace(context.workspace_id)
        }
        self.visible = {team_id for team_id in self.teams if context.can_see_team(team_id)}

    def _prefix(self, team_id: str | None) -> str | None:
        """A visible team's current key prefix, or `None`."""
        team = self.teams.get(team_id or "")
        return team.key_prefix if team is not None else None

    def resolve(self, items: Iterable[FavoriteItem]) -> list[FavoriteRead]:
        """Every favorite the caller may still read, in the order given."""
        rows = list(items)
        issues = self._issues([row.target_id for row in rows if row.kind == "issue"])
        resolved: list[FavoriteRead] = []
        for row in rows:
            found = issues.get(row.target_id) if row.kind == "issue" else self._one(row)
            if found is not None:
                resolved.append(found)
        return resolved

    def _issues(self, issue_ids: list[str]) -> dict[str, FavoriteRead]:
        """The visible issues among `issue_ids`, each with its current key and status, keyed by id."""
        if not issue_ids:
            return {}
        found = self.repositories.issues.get_many(self.context.workspace_id, issue_ids)
        visible = [issue for issue in found.values() if issue.team_id in self.visible]
        statuses: dict[str, dict[str, StatusRead]] = defaultdict(dict)
        for team_id in {issue.team_id for issue in visible}:
            for status in self.repositories.team_config.list_statuses(self.context.workspace_id, team_id):
                statuses[team_id][status.status_id] = StatusRead.from_row(status)
        answer: dict[str, FavoriteRead] = {}
        for issue in visible:
            keyed = current(self.repositories.teams, issue)
            answer[issue.issue_id] = FavoriteRead(
                kind="issue",
                target_id=issue.issue_id,
                title=issue.title,
                team_id=issue.team_id,
                team_key_prefix=self._prefix(issue.team_id),
                issue_key=keyed.key,
                status=statuses[issue.team_id].get(issue.status_id),
            )
        return answer

    def _one(self, row: FavoriteItem) -> FavoriteRead | None:
        """One favorite that is not an issue, or `None` when the caller may not read it."""
        workspace_id = self.context.workspace_id
        if row.kind == "team":
            team = self.teams.get(row.target_id)
            if team is None or team.team_id not in self.visible:
                return None
            return FavoriteRead(
                kind="team",
                target_id=team.team_id,
                title=team.name,
                team_id=team.team_id,
                team_key_prefix=team.key_prefix,
            )
        if row.kind == "cycle":
            if not row.team_id or row.team_id not in self.visible:
                return None
            cycle = self.repositories.planning.get_cycle(workspace_id, row.team_id, row.target_id)
            if cycle is None:
                return None
            return FavoriteRead(
                kind="cycle",
                target_id=cycle.cycle_id,
                title=cycle.name,
                team_id=cycle.team_id,
                team_key_prefix=self._prefix(cycle.team_id),
            )
        if row.kind == "project":
            project = self.repositories.planning.get_project(workspace_id, row.target_id)
            if project is None or not visible_project_teams(project, self.visible):
                return None
            return FavoriteRead(
                kind="project",
                target_id=project.project_id,
                title=project.name,
                icon=project.icon,
                color=project.color,
            )
        if row.kind == "initiative":
            if self.context.is_guest:
                return None
            initiative = self.repositories.planning.get_initiative(workspace_id, row.target_id)
            if initiative is None:
                return None
            return FavoriteRead(kind="initiative", target_id=initiative.initiative_id, title=initiative.name)
        if row.kind == "document":
            return self._document(row.target_id)
        if row.kind == "view":
            return self._view(row.target_id)
        return None

    def _document(self, document_id: str) -> FavoriteRead | None:
        """One document whose project or initiative the caller may read, or `None`."""
        found = self.repositories.documents.get(self.context.workspace_id, document_id)
        if found is None:
            return None
        document, _ = found
        if document.parent_kind == "initiative":
            if self.context.is_guest:
                return None
        else:
            project = self.repositories.planning.get_project(self.context.workspace_id, document.parent_id)
            if project is None or not visible_project_teams(project, self.visible):
                return None
        return FavoriteRead(
            kind="document",
            target_id=document.document_id,
            title=document.title,
            parent_kind=document.parent_kind,
            parent_id=document.parent_id,
        )

    def _view(self, view_id: str) -> FavoriteRead | None:
        """One saved view the caller may read, or `None`."""
        try:
            view = load_visible_view(self.repositories, self.context, view_id)
        except HTTPException:
            return None
        return FavoriteRead(
            kind="view",
            target_id=view.view_id,
            title=view.name,
            team_id=view.team_id,
            team_key_prefix=self._prefix(view.team_id),
            icon=view.icon,
            color=view.color,
        )


def list_favorites(repositories: Repositories, context: AuthzContext) -> list[FavoriteRead]:
    """The caller's favorites in their order, each one they may still read."""
    items = repositories.views.favorite_items(context.workspace_id, context.user_id)
    return _Resolver(repositories, context).resolve(items)


def add_favorite(repositories: Repositories, context: AuthzContext, ref: FavoriteRef) -> FavoriteRead:
    """Star something the caller may read, answering it as the sidebar draws it.

    Starring what is already starred keeps its place and answers it again, so a
    double press is never an error. A new favorite goes last, as in Linear. A
    target the caller cannot read is a 404, the same as one that never existed.
    """
    if ref.kind == "cycle" and not ref.team_id:
        raise unprocessable("team_id is required to favorite a cycle")
    item = _item(ref)
    resolved = _Resolver(repositories, context).resolve([item])
    if not resolved:
        raise not_found()
    current_items = repositories.views.favorite_items(context.workspace_id, context.user_id)
    if any(row.kind == item.kind and row.target_id == item.target_id for row in current_items):
        return resolved[0]
    if len(current_items) >= FAVORITES_MAX:
        raise unprocessable(f"A member keeps at most {FAVORITES_MAX} favorites")
    repositories.views.set_favorite_items(context.workspace_id, context.user_id, [*current_items, item])
    return resolved[0]


def remove_favorite(repositories: Repositories, context: AuthzContext, kind: str, target_id: str) -> bool:
    """Unstar one favorite, reporting whether it was starred.

    The target is never read, so a favorite on something deleted or no longer
    visible can still be removed.
    """
    current_items = repositories.views.favorite_items(context.workspace_id, context.user_id)
    kept = [row for row in current_items if not (row.kind == kind and row.target_id == target_id)]
    if len(kept) == len(current_items):
        return False
    repositories.views.set_favorite_items(context.workspace_id, context.user_id, kept)
    return True


def reorder_favorites(repositories: Repositories, context: AuthzContext, order: FavoriteOrder) -> list[FavoriteRead]:
    """Put the caller's favorites in a new order, answering the resolved listing.

    The named favorites come first in the order sent, and any the order leaves
    out follow in their old order, so nothing starred in another tab is lost.
    """
    current_items = repositories.views.favorite_items(context.workspace_id, context.user_id)
    by_identity = {(row.kind, row.target_id): row for row in current_items}
    named: list[FavoriteItem] = []
    for ref in order.items:
        row = by_identity.pop((ref.kind, ref.target_id), None)
        if row is not None:
            named.append(row)
    rest = [row for row in current_items if (row.kind, row.target_id) in by_identity]
    stored = repositories.views.set_favorite_items(context.workspace_id, context.user_id, [*named, *rest])
    return _Resolver(repositories, context).resolve(stored)
