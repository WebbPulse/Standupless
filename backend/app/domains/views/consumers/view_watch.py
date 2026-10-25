"""Which view subscribers an issue write newly brings an issue to, for the notify consumer.

A member who subscribes to a saved issue view hears about each issue that starts
matching it, as in Linear: an issue created into the view, or changed so that it
now meets the filter, notifies once on that transition. An issue that already
matched before the write, or that matches neither before nor after, says nothing,
which is why subscribing to a full view is quiet.

The view is judged per subscriber, because a filter naming `me` means the
subscriber, and with the same evaluator the issue list runs, so the inbox and the
list agree on what a view holds. The display switches count too: a view hiding
sub-issues, completed issues or archived ones never gains those. A view the
subscriber can no longer read, such as a team view after they left a private
team, notifies nobody, and the issue itself is still checked for visibility when
the row is written.

The work per write is bounded. The workspace's subscriptions are one query, a
team view on a team the issue is not on is skipped without a read, and the team
views of the issue's team are one query per team rather than a read per view.
A subscriber hears of one issue entering one view at most once, which a sent
notice record beside the subscription remembers, so an issue leaving the view
and coming back stays quiet.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Mapping, Optional

from fastapi import HTTPException

from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.views import FILTER_FIELDS
from app.common.db.dynamo.issues import Issue, as_issue
from app.common.db.dynamo.team_config import FINISHED_CATEGORIES
from app.common.db.dynamo.views import (
    SavedView,
    ViewSubscription,
    personal_view_key,
    team_view_prefix,
    workspace_view_key,
)
from app.common.filter_resolution import resolve_issue_filter
from app.common.issue_filters import IssueFilter, UnknownStatusCategory, build_issue_filter
from app.common.team_privacy import person_can_see_team

_log = logging.getLogger(__name__)


@dataclass(frozen=True)
class ViewEntry:
    """One subscriber an issue newly entered a view for, and the view it entered."""

    user_id: str
    view: SavedView


def image_issue(image: Mapping[str, Any]) -> Optional[Issue]:
    """One stream image as an `Issue`, or `None` when it is not a whole issue row."""
    if not image:
        return None
    try:
        return as_issue(image)
    except ValueError:
        return None


def _view_for(repositories: Repositories, workspace_id: str, row: ViewSubscription) -> Optional[SavedView]:
    """The subscribed view, found under its stored key or the keys a rescope could have moved it to.

    Sharing a view with the workspace, or taking it back, moves its row between the
    owner's personal key and the workspace key, so a subscription written before
    the move still finds it. The personal key tried is the subscriber's own, so a
    view taken back to private is found only for its owner.
    """
    candidates = dict.fromkeys(
        (row.saved_view_key, workspace_view_key(row.view_id), personal_view_key(row.user_id, row.view_id))
    )
    for view_key in candidates:
        view = repositories.views.get(workspace_id, view_key)
        if view is not None and view.view_id == row.view_id:
            return view
    return None


def _subscribed_team(row: ViewSubscription) -> Optional[str]:
    """The team a subscription's view belongs to, read off its stored sort key, or `None` for a teamless view."""
    prefix, _, rest = row.saved_view_key.partition("#")
    team_id = rest.split("#", 1)[0]
    if prefix != "team" or not team_id or not row.saved_view_key.startswith(team_view_prefix(team_id)):
        return None
    return team_id


class _ViewLookup:
    """Finds each subscribed view once per write, a team's views in one query."""

    def __init__(self, repositories: Repositories, workspace_id: str, teams: list[str]) -> None:
        """Hold the bundle, the workspace and the teams the written issue is or was on."""
        self._repositories = repositories
        self._workspace_id = workspace_id
        self._teams = set(teams)
        self._team_views: dict[str, dict[str, SavedView]] = {}

    def find(self, row: ViewSubscription) -> Optional[SavedView]:
        """The view one subscription follows, or `None` when it is gone or cannot hold the issue.

        A team view never holds an issue of another team, so it is skipped without
        a read, and the views of the issue's own team come from one listing, with
        a direct read only for a view past the listing's bound.
        """
        team_id = _subscribed_team(row)
        if team_id is None:
            return _view_for(self._repositories, self._workspace_id, row)
        if team_id not in self._teams:
            return None
        if team_id not in self._team_views:
            listed = self._repositories.views.list_for_team(self._workspace_id, team_id)
            self._team_views[team_id] = {view.view_id: view for view in listed}
        listed_view = self._team_views[team_id].get(row.view_id)
        return listed_view if listed_view is not None else _view_for(self._repositories, self._workspace_id, row)


def subscriber_can_read(repositories: Repositories, workspace_id: str, view: SavedView, user_id: str) -> bool:
    """Whether one subscriber may still read the view, by the same rule the view routes hold."""
    if view.team_id:
        return person_can_see_team(repositories, workspace_id, view.team_id, user_id)
    if view.scope == "personal":
        return view.owner_id == user_id
    membership = repositories.memberships.get(workspace_id, user_id)
    return membership is not None and membership.role != "guest"


def _team_scope(view: SavedView) -> Optional[set[str]]:
    """The teams a view is held to by its own team or a `team_id` in its filter, or `None` for any."""
    teams: set[str] = set()
    if view.team_id:
        teams.add(view.team_id)
    named = view.filter.get("team_id")
    if isinstance(named, str) and named:
        teams.add(named)
    elif isinstance(named, list):
        teams.update(str(value) for value in named if value)
    return teams or None


def _view_filter(view: SavedView, user_id: str) -> IssueFilter:
    """The issue filter a view runs for one subscriber, `me` meaning them."""
    keys = {key: value for key, value in view.filter.items() if key in FILTER_FIELDS and key != "team_id"}
    return build_issue_filter(user_id=user_id, include_archived=view.show_archived is True, **keys)


def in_view(view: SavedView, wanted: IssueFilter, issue: Optional[Issue], categories: Mapping[str, str]) -> bool:
    """Whether one issue state shows in the view, its display switches included."""
    if issue is None:
        return False
    teams = _team_scope(view)
    if teams is not None and issue.team_id not in teams:
        return False
    if view.show_sub_issues is False and issue.parent_id:
        return False
    hides_finished = view.show_completed is False or view.completed_window == "none"
    if hides_finished and categories.get(issue.status_id) in FINISHED_CATEGORIES:
        return False
    return wanted.matches(issue, categories)


def newly_entered(
    repositories: Repositories,
    workspace_id: str,
    before: Optional[Issue],
    after: Optional[Issue],
) -> list[ViewEntry]:
    """Each subscriber whose subscribed view `after` matches and `before` did not, one entry per view.

    `before` is `None` for a created issue, which matched nothing until now. A
    subscriber already told of this issue entering this view is left out. A view
    whose filter no longer parses, such as one naming a deleted cycle, is skipped
    and logged rather than failing the whole record.
    """
    if after is None:
        return []
    subscriptions = repositories.views.list_subscriptions(workspace_id)
    if not subscriptions:
        return []
    by_view: dict[str, list[ViewSubscription]] = {}
    for row in subscriptions:
        by_view.setdefault(row.view_id, []).append(row)

    teams = list(dict.fromkeys(t for t in (after.team_id, before.team_id if before else None) if t))
    lookup = _ViewLookup(repositories, workspace_id, teams)
    categories: Optional[dict[str, str]] = None
    entries: list[ViewEntry] = []
    for view_id, rows in by_view.items():
        view = lookup.find(rows[0])
        if view is None or view.lists_projects:
            continue
        for row in sorted(rows, key=lambda item: item.created_at):
            try:
                wanted = resolve_issue_filter(repositories, workspace_id, teams, _view_filter(view, row.user_id))
            except (UnknownStatusCategory, HTTPException, TypeError, ValueError):
                _log.info(
                    "Skipped a view subscription whose filter does not run.",
                    extra={
                        "event": "views.notify.view_filter_skipped",
                        "workspace_id": workspace_id,
                        "view_id": view_id,
                    },
                )
                break
            if categories is None:
                categories = {}
                for team in teams:
                    for status in repositories.team_config.list_statuses(workspace_id, team):
                        categories[status.status_id] = status.category
            if in_view(view, wanted, before, categories) or not in_view(view, wanted, after, categories):
                continue
            if repositories.views.notice_sent(workspace_id, view.view_id, row.user_id, after.issue_id):
                continue
            if subscriber_can_read(repositories, workspace_id, view, row.user_id):
                entries.append(ViewEntry(user_id=row.user_id, view=view))
    return entries
