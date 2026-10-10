"""The async standup digest: what each person on a team did over one window.

Built deterministically from rows the product already writes: status changes on
the team feed index of `activity`, comments through the author index, project
updates under each of the team's projects, and the live state of the team's open
issues for what is blocked, overdue or due soon. Nothing is summarised by a model.

A digest is named by its team local `date`. Its window ends on that date at the
team's send time and starts at the previous digest: the previous weekday for a
daily digest, so Monday's covers Friday onward, and seven days earlier for a
weekly one. Times are resolved in the team's IANA timezone, so a window across a
daylight saving change is one hour shorter or longer in UTC, never shifted.

Shared because the REST route and the MCP tool both live in the integrations
image and must return the same digest.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta
from typing import Any, Iterable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, Field

from app.common import issue_keys
from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.activity import Activity
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.planning import Project
from app.common.db.dynamo.team_config import StandupSettings, default_standup_settings

DUE_SOON_DAYS = 3
"""How many days after the digest date an open issue's due date counts as due soon."""

OPEN_CATEGORIES: tuple[str, ...] = ("backlog", "unstarted", "started")

MAX_FEED_ROWS = 5000

MAX_UPDATES_PER_PROJECT = 50


class StandupWindowError(ValueError):
    """A digest asked for with a timezone or send time that cannot be resolved."""


class StandupItem(BaseModel):
    """One issue line of a digest section."""

    issue_id: str
    key: str
    title: str
    status_id: str
    project_id: str | None = None
    project_name: str | None = None
    due_date: str | None = None
    at: datetime | None = None
    count: int = 0


class StandupProjectUpdate(BaseModel):
    """One project update a person posted in the window."""

    update_id: str
    project_id: str
    project_name: str
    health: str
    body: str
    created_at: datetime


class StandupPerson(BaseModel):
    """Everything one person did and carries in one digest.

    `user_id` is empty for the unassigned group, which only ever holds open
    issues that are blocked, overdue or due soon with nobody on them.
    """

    user_id: str
    display_name: str
    note: str | None = None
    completed: list[StandupItem] = Field(default_factory=list)
    started: list[StandupItem] = Field(default_factory=list)
    commented: list[StandupItem] = Field(default_factory=list)
    blocked: list[StandupItem] = Field(default_factory=list)
    overdue: list[StandupItem] = Field(default_factory=list)
    due_soon: list[StandupItem] = Field(default_factory=list)
    project_updates: list[StandupProjectUpdate] = Field(default_factory=list)

    @property
    def is_empty(self) -> bool:
        """Whether this person has nothing at all in the digest."""
        return not (
            self.note
            or self.completed
            or self.started
            or self.commented
            or self.blocked
            or self.overdue
            or self.due_soon
            or self.project_updates
        )


class StandupDigest(BaseModel):
    """One team's digest for one date, grouped by person."""

    team_id: str
    team_key: str
    team_name: str
    date: str
    cadence: str
    timezone: str
    send_time: str
    window_start: datetime
    window_end: datetime
    generated_at: datetime
    people: list[StandupPerson] = Field(default_factory=list)


def resolve_zone(name: str) -> ZoneInfo:
    """The IANA zone `name`, raising `StandupWindowError` when it is unknown."""
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise StandupWindowError(f"Unknown timezone {name!r}") from exc


def parse_send_time(value: str) -> time:
    """A `HH:MM` send time, raising `StandupWindowError` when it is malformed."""
    try:
        hours, minutes = value.split(":")
        return time(int(hours), int(minutes))
    except ValueError as exc:
        raise StandupWindowError(f"Send time {value!r} is not HH:MM") from exc


def previous_weekday(day: date) -> date:
    """The weekday before `day`, skipping Saturday and Sunday."""
    previous = day - timedelta(days=1)
    while previous.weekday() >= 5:
        previous -= timedelta(days=1)
    return previous


def window_for(day: date, cadence: str, send_time: str, timezone: str) -> tuple[datetime, datetime]:
    """The UTC `[start, end)` window of the digest dated `day`."""
    zone = resolve_zone(timezone)
    at = parse_send_time(send_time)
    start_day = day - timedelta(days=7) if cadence == "weekly" else previous_weekday(day)
    end = datetime.combine(day, at, tzinfo=zone)
    start = datetime.combine(start_day, at, tzinfo=zone)
    return start.astimezone(UTC), end.astimezone(UTC)


def local_today(timezone: str, now: datetime | None = None) -> date:
    """Today's date in the team's timezone."""
    moment = now or utc_now()
    return moment.astimezone(resolve_zone(timezone)).date()


def next_digest_date(settings: StandupSettings, now: datetime | None = None) -> date:
    """The date of the next digest that has not been cut yet, which is where a new note lands."""
    moment = now or utc_now()
    zone = resolve_zone(settings.timezone)
    at = parse_send_time(settings.send_time)
    day = moment.astimezone(zone).date()
    for _ in range(15):
        due = datetime.combine(day, at, tzinfo=zone)
        if settings.cadence == "weekly":
            fits = day.weekday() == settings.weekday
        else:
            fits = day.weekday() < 5
        if fits and due > moment:
            return day
        day += timedelta(days=1)
    return day


def build_digest(
    repositories: Repositories,
    workspace_id: str,
    team_id: str,
    day: date,
    *,
    cadence: str | None = None,
    settings: StandupSettings | None = None,
    now: datetime | None = None,
) -> StandupDigest:
    """One team's digest for the team local `day`.

    `cadence` overrides the team's own, so a team with the digest off still
    gets a daily view, and anyone can ask for the weekly one.
    """
    team = repositories.teams.get(workspace_id, team_id)
    if team is None:
        raise LookupError(team_id)
    stored = settings or repositories.team_config.get_standup_settings(workspace_id, team_id)
    settings = stored or default_standup_settings(workspace_id, team_id)
    shape = cadence or ("weekly" if settings.cadence == "weekly" else "daily")
    start, end = window_for(day, shape, settings.send_time, settings.timezone)
    categories = {
        status.status_id: status.category
        for status in repositories.team_config.list_statuses(workspace_id, team_id, include_hidden=True)
    }
    projects = {project.project_id: project for project in repositories.planning.list_projects(workspace_id)}
    feed = repositories.activity.iter_team_feed(workspace_id, team_id, start, end, max_items=MAX_FEED_ROWS)
    open_issues = _open_issues(repositories, workspace_id, team_id, categories)
    member_ids = [member.user_id for member in repositories.memberships.list_team_members(workspace_id, team_id)]
    comments = _comments(repositories, workspace_id, team_id, member_ids, start, end)
    touched = {row.issue_id for row in feed} | {issue_id for issue_id, _, _ in comments}
    issues = {issue.issue_id: issue for issue in open_issues}
    missing = sorted(touched - set(issues))
    if missing:
        issues.update(repositories.issues.get_many(workspace_id, missing))
    issues = {issue_id: issue_keys.current(repositories.teams, issue) for issue_id, issue in issues.items()}
    builder = _Builder(projects, issues)
    _credit_status_changes(builder, feed, categories)
    for issue_id, author_id, at in comments:
        builder.comment(author_id, issue_id, at)
    _carry_open_state(builder, open_issues, day)
    for update, project in _project_updates(repositories, workspace_id, team_id, projects.values(), start, end):
        builder.project_update(update.author_id, update, project)
    notes = repositories.team_config.list_standup_notes(workspace_id, team_id, day.isoformat())
    renames = issue_keys.retired_prefixes(repositories.teams, workspace_id) if notes else {}
    for note in notes:
        builder.person(note.user_id).note = issue_keys.current_references(note.body, renames)
    for user_id in member_ids:
        builder.person(user_id)
    people = builder.finish(repositories)
    return StandupDigest(
        team_id=team_id,
        team_key=team.key_prefix,
        team_name=team.name,
        date=day.isoformat(),
        cadence=shape,
        timezone=settings.timezone,
        send_time=settings.send_time,
        window_start=start,
        window_end=end,
        generated_at=now or utc_now(),
        people=people,
    )


class _Builder:
    """Collects digest lines per person, deduplicating each issue per section."""

    def __init__(self, projects: dict[str, Project], issues: dict[str, Issue]) -> None:
        """Hold the lookups every line is rendered from."""
        self._projects = projects
        self.issues = issues
        self._people: dict[str, StandupPerson] = {}

    def person(self, user_id: str) -> StandupPerson:
        """The person entry for `user_id`, created empty on first use."""
        entry = self._people.get(user_id)
        if entry is None:
            entry = StandupPerson(user_id=user_id, display_name="")
            self._people[user_id] = entry
        return entry

    def item(self, issue_id: str, at: datetime | None = None) -> StandupItem | None:
        """One issue as a digest line, or `None` when the issue is gone."""
        issue = self.issues.get(issue_id)
        if issue is None:
            return None
        project = self._projects.get(issue.project_id) if issue.project_id else None
        return StandupItem(
            issue_id=issue.issue_id,
            key=issue.key,
            title=issue.title,
            status_id=issue.status_id,
            project_id=issue.project_id,
            project_name=project.name if project is not None else None,
            due_date=issue.due_date,
            at=at,
        )

    def add(self, user_id: str, section: str, issue_id: str, at: datetime | None = None) -> None:
        """Put one issue in one section of one person, keeping the latest time once."""
        lines: list[StandupItem] = getattr(self.person(user_id), section)
        for line in lines:
            if line.issue_id == issue_id:
                if at is not None and (line.at is None or at > line.at):
                    line.at = at
                return
        line = self.item(issue_id, at)
        if line is not None:
            lines.append(line)

    def drop(self, user_id: str, section: str, issue_id: str) -> None:
        """Remove one issue from one section of one person."""
        entry = self._people.get(user_id)
        if entry is not None:
            setattr(entry, section, [line for line in getattr(entry, section) if line.issue_id != issue_id])

    def comment(self, user_id: str, issue_id: str, at: datetime) -> None:
        """Count one comment by `user_id` on `issue_id`."""
        self.add(user_id, "commented", issue_id, at)
        for line in self.person(user_id).commented:
            if line.issue_id == issue_id:
                line.count += 1

    def project_update(self, user_id: str, update: Any, project: Project) -> None:
        """Record one project update posted by `user_id`."""
        self.person(user_id).project_updates.append(
            StandupProjectUpdate(
                update_id=update.update_id,
                project_id=project.project_id,
                project_name=project.name,
                health=update.health,
                body=update.body,
                created_at=update.created_at,
            )
        )

    def finish(self, repositories: Repositories) -> list[StandupPerson]:
        """Every person with names filled in, active people first, then by name."""
        ids = [user_id for user_id in self._people if user_id]
        users = repositories.users.get_many(ids) if ids else {}
        for user_id, entry in self._people.items():
            user = users.get(user_id)
            entry.display_name = (user.display_name if user is not None else "") or (
                "Unassigned" if not user_id else ""
            )
            for section in ("completed", "started", "commented"):
                getattr(entry, section).sort(key=lambda line: line.at or datetime.min.replace(tzinfo=UTC))
            for section in ("blocked", "overdue", "due_soon"):
                getattr(entry, section).sort(key=lambda line: (line.due_date or "9999-99-99", line.key))
            entry.project_updates.sort(key=lambda update: update.created_at)
        people = [entry for entry in self._people.values() if entry.user_id or not entry.is_empty]
        return sorted(
            people, key=lambda entry: (entry.is_empty, not entry.user_id, entry.display_name.lower(), entry.user_id)
        )


def _credit(row: Activity, issue: Issue | None) -> str | None:
    """Who a status change is credited to: the person, or the assignee for automation."""
    if row.actor_kind == "user" and row.actor_id:
        return row.actor_id
    return issue.assignee_id if issue is not None else None


def _credit_status_changes(builder: _Builder, feed: list[Activity], categories: dict[str, str]) -> None:
    """File each status change under completed or started, completed winning per issue."""
    for row in feed:
        if row.kind != "field_changed" or row.field != "status_id":
            continue
        category = categories.get(str(row.to_value or ""))
        if category not in ("completed", "started"):
            continue
        user_id = _credit(row, builder.issues.get(row.issue_id))
        if not user_id:
            continue
        if category == "completed":
            builder.drop(user_id, "started", row.issue_id)
            builder.add(user_id, "completed", row.issue_id, row.created_at)
        elif not any(line.issue_id == row.issue_id for line in builder.person(user_id).completed):
            builder.add(user_id, "started", row.issue_id, row.created_at)


def _carry_open_state(builder: _Builder, open_issues: list[Issue], day: date) -> None:
    """File each open issue under blocked, overdue or due soon for its assignee."""
    soon = (day + timedelta(days=DUE_SOON_DAYS)).isoformat()
    today = day.isoformat()
    for issue in open_issues:
        owner = issue.assignee_id or ""
        if issue.blocked_by_open_count > 0:
            builder.add(owner, "blocked", issue.issue_id)
        if issue.due_date and issue.due_date < today:
            builder.add(owner, "overdue", issue.issue_id)
        elif issue.due_date and issue.due_date <= soon:
            builder.add(owner, "due_soon", issue.issue_id)


def _open_issues(
    repositories: Repositories, workspace_id: str, team_id: str, categories: dict[str, str]
) -> list[Issue]:
    """Every live issue of the team in an open status."""
    found: list[Issue] = []
    for status_id, category in categories.items():
        if category in OPEN_CATEGORIES:
            found.extend(repositories.issues.iter_for_status(workspace_id, team_id, status_id, include_archived=False))
    return found


def _comments(
    repositories: Repositories,
    workspace_id: str,
    team_id: str,
    author_ids: Iterable[str],
    start: datetime,
    end: datetime,
) -> list[tuple[str, str, datetime]]:
    """Each member's comments on this team's issues in the window, as issue, author and time."""
    found: list[tuple[str, str, datetime]] = []
    for author_id in dict.fromkeys(author_ids):
        for comment in repositories.comments.iter_by_author(workspace_id, author_id, start, end):
            if comment.team_id == team_id:
                found.append((comment.issue_id, author_id, comment.created_at))
    return found


def _project_updates(
    repositories: Repositories,
    workspace_id: str,
    team_id: str,
    projects: Iterable[Project],
    start: datetime,
    end: datetime,
) -> list[tuple[Any, Project]]:
    """Updates posted in the window on projects the team is part of."""
    found: list[tuple[Any, Project]] = []
    for project in projects:
        if team_id not in project.team_ids or project.last_update_at is None or project.last_update_at < start:
            continue
        rows, _ = repositories.planning.list_project_updates(
            workspace_id, project.project_id, limit=MAX_UPDATES_PER_PROJECT
        )
        found.extend((row, project) for row in rows if start <= row.created_at < end)
    return found
