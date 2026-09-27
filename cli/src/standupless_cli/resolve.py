"""Turning what people type into the ids the API wants.

Nobody remembers a team id. Commands accept a team's key prefix or name, a status's
name or category, a label's name, `me`, an email, `current` for the active cycle, and
a project's name, and this module looks each one up once per invocation.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from standupless_cli._generated.models import (
    CycleRead,
    LabelRead,
    MemberRead,
    ProjectRead,
    StatusRead,
    TeamRead,
    WorkspaceRead,
)
from standupless_cli.client import ApiError, Issue, StanduplessClient
from standupless_cli.config import Settings

STATUS_CATEGORIES = ("backlog", "unstarted", "started", "completed", "cancelled")
CATEGORY_ALIASES = {"canceled": "cancelled", "todo": "unstarted", "in_progress": "started", "done": "completed"}
OPEN_CATEGORIES = ("backlog", "unstarted", "started")


class ResolveError(Exception):
    """A name matched nothing, or matched more than one thing where one was needed."""


def _norm(value: str) -> str:
    """Case and surrounding space never change which thing a name means."""
    return value.strip().casefold()


def category_of(value: str) -> str | None:
    """The status category a word names, accepting common spellings, or None."""
    lowered = _norm(value).replace(" ", "_").replace("-", "_")
    lowered = CATEGORY_ALIASES.get(lowered, lowered)
    return lowered if lowered in STATUS_CATEGORIES else None


def key_prefix_of(issue_key: str) -> str:
    """`ENG` from `ENG-12`, rejecting anything that is not a key."""
    prefix, sep, number = issue_key.rpartition("-")
    if not sep or not prefix or not number.isdigit():
        raise ResolveError(f"{issue_key!r} is not an issue key such as ENG-12.")
    return prefix


class Context:
    """One invocation's view of a workspace, caching every lookup it makes."""

    def __init__(self, settings: Settings, client: StanduplessClient):
        self.settings = settings
        self.client = client
        self._workspace: WorkspaceRead | None = None
        self._teams: list[TeamRead] | None = None
        self._statuses: dict[str, list[StatusRead]] = {}
        self._labels: dict[str, list[LabelRead]] = {}
        self._members: list[MemberRead] | None = None
        self._projects: list[ProjectRead] | None = None
        self._me: str | None = settings.host.get("user_id")

    def bound_workspace(self) -> WorkspaceRead:
        """The workspace this key works in.

        A key is bound to one workspace but lists all of its user's, so with several to
        choose from, the one whose teams answer is the one the key belongs to.
        """
        workspaces = self.client.list_workspaces()
        if len(workspaces) == 1:
            return workspaces[0]
        for workspace in workspaces:
            try:
                self.client.list_teams(workspace["id"])
            except ApiError as exc:
                if exc.status in (403, 404):
                    continue
                raise
            return workspace
        raise ResolveError("This key cannot read any of your workspaces. Check its scopes include teams:read.")

    def use_workspace(self, workspace: WorkspaceRead) -> None:
        """Pin the workspace, once login has found the one the key is bound to."""
        self._workspace = workspace

    @property
    def workspace(self) -> WorkspaceRead:
        """The workspace named by `--workspace`, the env or config, else the key's own."""
        if self._workspace is None:
            wanted = self.settings.workspace
            if not wanted:
                self._workspace = self.bound_workspace()
            else:
                matches = [
                    ws
                    for ws in self.client.list_workspaces()
                    if wanted in (ws["id"], ws["slug"]) or _norm(ws["name"]) == _norm(wanted)
                ]
                if not matches:
                    raise ResolveError(f"No workspace matches {wanted!r}.")
                self._workspace = matches[0]
        return self._workspace

    @property
    def workspace_id(self) -> str:
        """The workspace id every path is built on."""
        return self.workspace["id"]

    def teams(self) -> list[TeamRead]:
        """The workspace's teams, fetched once."""
        if self._teams is None:
            self._teams = self.client.list_teams(self.workspace_id)
        return self._teams

    def team(self, ref: str) -> TeamRead:
        """A team by id, key prefix (current or retired) or name."""
        wanted = _norm(ref)
        for team in self.teams():
            prefixes = [team["key_prefix"], *team.get("retired_key_prefixes", [])]
            if ref == team["id"] or wanted in (_norm(p) for p in prefixes) or wanted == _norm(team["name"]):
                return team
        known = ", ".join(t["key_prefix"] for t in self.teams()) or "none"
        raise ResolveError(f"No team matches {ref!r}. Teams: {known}.")

    def team_for_key(self, issue_key: str) -> TeamRead:
        """The team an issue key belongs to, by its prefix."""
        return self.team(key_prefix_of(issue_key))

    def scoped_teams(self, team_ref: str | None) -> list[TeamRead]:
        """One named team, or every team when none is named."""
        return [self.team(team_ref)] if team_ref else self.teams()

    def statuses(self, team_id: str) -> list[StatusRead]:
        """A team's statuses in board order, fetched once."""
        if team_id not in self._statuses:
            found = self.client.list_statuses(self.workspace_id, team_id)
            self._statuses[team_id] = sorted(found, key=lambda status: status["position"])
        return self._statuses[team_id]

    def status_names(self, team_id: str) -> dict[str, str]:
        """Status id to name for a team, for rendering."""
        return {status["id"]: status["name"] for status in self.statuses(team_id)}

    def status_id(self, team_id: str, ref: str) -> str:
        """One status in one team, by id, name or category (the first in board order)."""
        statuses = self.statuses(team_id)
        for status in statuses:
            if ref == status["id"] or _norm(ref) == _norm(status["name"]):
                return status["id"]
        category = category_of(ref)
        if category:
            for status in statuses:
                if status["category"] == category:
                    return status["id"]
        names = ", ".join(status["name"] for status in statuses)
        raise ResolveError(f"No status matches {ref!r}. Statuses: {names}.")

    def status_filter(self, teams: Iterable[TeamRead], refs: Iterable[str]) -> tuple[list[str], list[str]]:
        """Split status refs into status ids and categories; a status's own name wins over a category word."""
        categories: list[str] = []
        ids: list[str] = []
        teams = list(teams)
        for ref in refs:
            matched = [
                status["id"]
                for team in teams
                for status in self.statuses(team["id"])
                if ref == status["id"] or _norm(ref) == _norm(status["name"])
            ]
            category = category_of(ref)
            if matched:
                ids.extend(matched)
            elif category:
                categories.append(category)
            else:
                raise ResolveError(f"No status matches {ref!r}.")
        return categories, ids

    def labels(self, team_id: str) -> list[LabelRead]:
        """A team's labels, fetched once."""
        if team_id not in self._labels:
            self._labels[team_id] = self.client.list_labels(self.workspace_id, team_id)
        return self._labels[team_id]

    def label_ids(self, teams: Iterable[TeamRead], refs: Iterable[str]) -> list[str]:
        """Label ids by id or name, across the given teams."""
        ids: list[str] = []
        teams = list(teams)
        for ref in refs:
            matched = [
                label["id"]
                for team in teams
                for label in self.labels(team["id"])
                if ref == label["id"] or _norm(ref) == _norm(label["name"])
            ]
            if not matched:
                raise ResolveError(f"No label matches {ref!r}.")
            ids.extend(matched)
        return ids

    def members(self) -> list[MemberRead]:
        """The workspace's members, fetched once."""
        if self._members is None:
            self._members = self.client.list_members(self.workspace_id)
        return self._members

    def member_names(self) -> dict[str, str]:
        """User id to display name, for rendering; empty when the list is not readable."""
        try:
            return {member["user_id"]: member["display_name"] or member["email"] for member in self.members()}
        except ApiError:
            return {}

    def user_filter(self, ref: str) -> str:
        """A user for a list filter, where the server itself understands `me` and `none`."""
        if _norm(ref) in ("me", "none"):
            return _norm(ref)
        return self.user_id(ref)

    def user_id(self, ref: str) -> str:
        """A concrete user id from `me`, an id, an email or a display name."""
        if _norm(ref) == "me":
            return self.my_user_id()
        for member in self.members():
            if ref == member["user_id"] or _norm(ref) in (_norm(member["email"]), _norm(member["display_name"])):
                return member["user_id"]
        raise ResolveError(f"No workspace member matches {ref!r}.")

    def my_user_id(self) -> str:
        """The key's user id, from config or from an issue the user created or holds.

        API keys cannot read `/api/users/me`, but the list filters resolve `me` on the
        server, so any issue the user created or is assigned names them.
        """
        if self._me:
            return self._me
        for field, attr in (("creator_id", "created_by"), ("assignee_id", "assignee_id")):
            found = self.client.list_issues(self.workspace_id, {field: "me"}, limit=1)
            if found and found[0].get(attr):
                self._me = str(found[0].get(attr))
                return self._me
        raise ResolveError("Could not work out who this key belongs to until they create or hold an issue.")

    def cycles(self, team_id: str, status: str | None = None) -> list[CycleRead]:
        """A team's cycles, optionally one status only."""
        return self.client.list_cycles(self.workspace_id, team_id, status=status)

    def current_cycle(self, team_id: str) -> CycleRead | None:
        """A team's active cycle, if it has one."""
        active = self.cycles(team_id, status="active")
        return active[0] if active else None

    def cycle_ids(self, teams: Iterable[TeamRead], ref: str) -> list[str]:
        """Cycle ids for `current`, `none`, an id or a name, across the given teams."""
        if _norm(ref) == "none":
            return ["none"]
        ids: list[str] = []
        for team in teams:
            if _norm(ref) == "current":
                cycle = self.current_cycle(team["id"])
                if cycle:
                    ids.append(cycle["cycle_id"])
                continue
            ids.extend(
                cycle["cycle_id"]
                for cycle in self.cycles(team["id"])
                if ref == cycle["cycle_id"] or _norm(ref) == _norm(cycle["name"])
            )
        if not ids:
            raise ResolveError(f"No cycle matches {ref!r}.")
        return ids

    def cycle_id(self, team_id: str, ref: str) -> str:
        """One cycle in one team, for setting on an issue."""
        return self.cycle_ids([self.team(team_id)], ref)[0]

    def projects(self) -> list[ProjectRead]:
        """The workspace's projects, fetched once."""
        if self._projects is None:
            self._projects = self.client.list_projects(self.workspace_id)
        return self._projects

    def project(self, ref: str) -> ProjectRead:
        """A project by id or name."""
        for project in self.projects():
            if ref == project["project_id"] or _norm(ref) == _norm(project["name"]):
                return project
        raise ResolveError(f"No project matches {ref!r}.")

    def project_filter(self, ref: str) -> str:
        """A project for a list filter, where `none` means issues outside any project."""
        return "none" if _norm(ref) == "none" else self.project(ref)["project_id"]

    def issue(self, issue_key: str) -> Issue:
        """One issue by key, uppercased so `eng-12` works too."""
        key_prefix_of(issue_key)
        return self.client.get_issue_by_key(self.workspace_id, issue_key.upper())

    def team_by_id(self, team_id: str) -> TeamRead | None:
        """A team from the cached list by id."""
        return next((team for team in self.teams() if team["id"] == team_id), None)

    def issue_url(self, issue_key: str) -> str:
        """The issue's page in the web app."""
        return f"{self.settings.web_url}/w/{self.workspace['slug']}/issues/{issue_key.upper()}"

    def project_url(self, project_id: str) -> str:
        """The project's page in the web app."""
        return f"{self.settings.web_url}/w/{self.workspace['slug']}/projects/{project_id}"


def compact(body: dict[str, Any]) -> dict[str, Any]:
    """Drop the keys a command left unset, so a patch touches only what was asked."""
    return {key: value for key, value in body.items() if value is not None}
