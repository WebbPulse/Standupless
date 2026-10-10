"""Request and response schemas for the planning domain.

Every list body is an object with one plural key beside `next_cursor`, matching the
M1 to M3 domains and the contract, which is what `webbpulse.http.cursor_page`
builds. Validation that needs no table read happens here, so a malformed body is a
422 naming the field; anything needing the team's own rows is decided in the
route, because the schema cannot read.
"""

from __future__ import annotations

import re
from datetime import date, datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator
from webbpulse.http import cursor_page

from app.common.api.schemas.teams import COLOR_PATTERN
from app.common.change_source import ChangeSource
from app.common.db.dynamo.planning import (
    CarryOver,
    Cycle,
    Initiative,
    InitiativeUpdateRow,
    Project,
    ProjectMilestone,
    ProjectUpdateRow,
    RollupCounts,
    normalise_project_status,
)
from app.common.project_cadence import (
    DEFAULT_INTERVAL_DAYS,
    UpdateDueState,
    check_interval,
    effective_interval,
    next_update_due_at,
    update_due_state,
)

ProjectStatusField = Literal["backlog", "planned", "in_progress", "paused", "completed", "canceled"]

CycleStatusField = Literal["upcoming", "active", "completed", "cancelled"]

RoadmapKindField = Literal["cycle", "project"]

InitiativeStatusField = Literal["planned", "active", "completed"]

ProjectHealthField = Literal["on_track", "at_risk", "off_track"]

ProjectPriorityField = Literal["none", "urgent", "high", "medium", "low"]

ProjectIconField = Literal[
    "box",
    "rocket",
    "target",
    "flag",
    "zap",
    "star",
    "bug",
    "book",
    "code",
    "globe",
    "heart",
    "layers",
    "shield",
    "sparkles",
    "users",
    "wrench",
]
"""The glyphs a project may wear, a fixed set so a client never meets one it cannot draw."""

MEMBERS_MAX = 50

NAME_MAX = 80

GOAL_MAX = 2000

DESCRIPTION_MAX_BYTES = 8192

TEAMS_MAX = 20

DEFAULT_LIMIT = 50

MAX_LIMIT = 100

UPDATE_BODY_MAX_BYTES = 16384
"""The byte cap on one project update's markdown body, twice a description's."""

UPDATES_DEFAULT_LIMIT = 20
"""How many updates one page of the feed holds when the caller names no limit."""

SORT_ORDER_PATTERN = re.compile(r"^[0-9A-Za-z]{1,64}$")
"""A manual position: base 62 fractional key, the same alphabet issues order by."""


def _check_name(value: str) -> str:
    """Reject a name that is only whitespace."""
    candidate = value.strip()
    if not candidate:
        raise ValueError("name must not be blank")
    return candidate


def _check_date(value: Optional[str]) -> Optional[str]:
    """Hold a date field to `YYYY-MM-DD`, which is what the contract states."""
    if value is None:
        return None
    candidate = value.strip()
    if not candidate:
        return None
    try:
        date.fromisoformat(candidate)
    except ValueError as exc:
        raise ValueError("must be a YYYY-MM-DD date") from exc
    return candidate


def _check_required_date(value: str) -> str:
    """Hold a required date field to the contract's format."""
    checked = _check_date(value)
    if checked is None:
        raise ValueError("must be a YYYY-MM-DD date")
    return checked


def _check_description(value: Optional[str]) -> Optional[str]:
    """Hold a markdown description to the contract's byte cap.

    Measured in UTF-8 bytes rather than characters, for the same reason an issue
    body is: the cap exists to keep the item well under DynamoDB's limit and it is
    the encoded length that counts.
    """
    if value is None:
        return None
    if len(value.encode("utf-8")) > DESCRIPTION_MAX_BYTES:
        raise ValueError(f"description must be at most {DESCRIPTION_MAX_BYTES} bytes")
    return value


def _check_order(start_date: Optional[str], end_date: Optional[str], end_name: str = "end_date") -> None:
    """Refuse an end date before the start date, when both are present."""
    if start_date and end_date and end_date < start_date:
        raise ValueError(f"{end_name} must not be before start_date")


def _check_team_ids(value: Optional[list[str]]) -> Optional[list[str]]:
    """Hold a team list to distinct, non-blank ids, keeping the caller's order.

    The order is kept because the first team is the one a single-team reader
    treats as the project's own, and a duplicate is folded rather than refused
    since it asks for nothing the single entry does not.
    """
    if value is None:
        return None
    seen: list[str] = []
    for team_id in value:
        candidate = team_id.strip()
        if not candidate:
            raise ValueError("team_ids must not contain a blank id")
        if candidate not in seen:
            seen.append(candidate)
    if not seen:
        raise ValueError("team_ids must name at least one team")
    return seen


def _check_sort_order(value: Optional[str]) -> Optional[str]:
    """Hold a manual position to the base 62 alphabet and its length cap."""
    if value is None:
        return None
    if not SORT_ORDER_PATTERN.match(value):
        raise ValueError("sort_order must be 1 to 64 characters of 0-9, A-Z and a-z")
    return value


def _check_color(value: Optional[str]) -> Optional[str]:
    """Hold a colour to `#rrggbb`, lowercased so two spellings never differ."""
    if value is None:
        return None
    candidate = value.strip().lower()
    if not COLOR_PATTERN.match(candidate):
        raise ValueError("color must be #rrggbb")
    return candidate


def _check_member_ids(value: Optional[list[str]]) -> Optional[list[str]]:
    """Hold a member list to distinct, non-blank ids, keeping the caller's order.

    An empty list is allowed, since a project with no members is the default.
    Whether each id is in the workspace needs a table read, so that is the
    write path's decision.
    """
    if value is None:
        return None
    seen: list[str] = []
    for user_id in value:
        candidate = user_id.strip()
        if not candidate:
            raise ValueError("member_ids must not contain a blank id")
        if candidate not in seen:
            seen.append(candidate)
    return seen


def _legacy_status(value: object) -> object:
    """Read an earlier project status name as the status it now is."""
    return normalise_project_status(value) if isinstance(value, str) else value


class CountsRead(BaseModel):
    """One planning row's issue counts as the API returns them.

    `total` is rendered rather than stored so a reader never has to trust that the
    four buckets agree with a fifth counter that could drift from them.
    """

    todo: int = 0
    in_progress: int = 0
    done: int = 0
    cancelled: int = 0
    total: int = 0

    @classmethod
    def from_counts(cls, counts: RollupCounts) -> "CountsRead":
        """Build the response shape from the stored counters."""
        return cls(
            todo=counts.todo,
            in_progress=counts.in_progress,
            done=counts.done,
            cancelled=counts.cancelled,
            total=counts.total,
        )


class CarryOverRead(BaseModel):
    """What cycle closes moved into and out of one cycle, in issues and in points."""

    carried_in: int = 0
    carried_out: int = 0
    carried_in_points: int = 0
    carried_out_points: int = 0
    carried_in_unestimated: int = 0
    carried_out_unestimated: int = 0
    carried_in_issue_ids: list[str] = Field(default_factory=list)
    carried_out_issue_ids: list[str] = Field(default_factory=list)

    @classmethod
    def from_carry(
        cls,
        carry: CarryOver,
        carried_in_issue_ids: Optional[list[str]] = None,
        carried_out_issue_ids: Optional[list[str]] = None,
    ) -> "CarryOverRead":
        """Build the response shape from the stored carry counters and the ids a close recorded."""
        return cls(
            **carry.model_dump(),
            carried_in_issue_ids=list(carried_in_issue_ids or []),
            carried_out_issue_ids=list(carried_out_issue_ids or []),
        )


class CycleCreate(BaseModel):
    """The body `POST /api/workspaces/{workspace_id}/cycles` takes."""

    team_id: str = Field(min_length=1)
    name: str = Field(min_length=1, max_length=NAME_MAX)
    start_date: str
    end_date: str
    goal: Optional[str] = Field(default=None, max_length=GOAL_MAX)

    @field_validator("name")
    @classmethod
    def check_name(cls, value: str) -> str:
        """Reject a name that is only whitespace."""
        return _check_name(value)

    @field_validator("start_date", "end_date")
    @classmethod
    def check_dates(cls, value: str) -> str:
        """Hold both dates to the contract's format; neither is optional."""
        return _check_required_date(value)

    @model_validator(mode="after")
    def check_date_order(self) -> "CycleCreate":
        """Refuse an end date before the start date."""
        _check_order(self.start_date, self.end_date)
        return self


class CycleUpdate(BaseModel):
    """The body a cycle patch takes.

    `team_id` is required rather than patchable: it names the partition prefix
    the row is filed under, and moving a cycle between teams would orphan every
    issue pointing at it.
    """

    team_id: str = Field(min_length=1)
    name: Optional[str] = Field(default=None, min_length=1, max_length=NAME_MAX)
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    goal: Optional[str] = Field(default=None, max_length=GOAL_MAX)
    cancelled: Optional[bool] = None

    @field_validator("name")
    @classmethod
    def check_name(cls, value: Optional[str]) -> Optional[str]:
        """Reject a name that is only whitespace."""
        return None if value is None else _check_name(value)

    @field_validator("start_date", "end_date")
    @classmethod
    def check_dates(cls, value: Optional[str]) -> Optional[str]:
        """Hold both dates to the contract's format."""
        return _check_date(value)


class CycleRead(BaseModel):
    """One cycle as the API returns it, with its status derived from its dates."""

    cycle_id: str
    workspace_id: str
    team_id: str
    name: str
    start_date: str
    end_date: str
    goal: Optional[str] = None
    number: Optional[int] = None
    cancelled: bool
    status: CycleStatusField
    counts: CountsRead
    points: CountsRead = Field(default_factory=CountsRead)
    unestimated: CountsRead = Field(default_factory=CountsRead)
    carry: CarryOverRead = Field(default_factory=CarryOverRead)
    created_by: str
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, cycle: Cycle, today: Optional[str] = None, *, count_unestimated: bool = False) -> "CycleRead":
        """Build the response shape from a stored cycle row.

        `today` is threaded through rather than read inside, so a test can pin the
        day a status is derived against without freezing the clock. With
        `count_unestimated`, the team's setting, each unestimated issue adds one
        point to `points` and to the carried points; `unestimated` always holds
        how many there are.
        """
        return cls(
            cycle_id=cycle.cycle_id,
            workspace_id=cycle.workspace_id,
            team_id=cycle.team_id,
            name=cycle.name,
            start_date=cycle.start_date,
            end_date=cycle.end_date,
            goal=cycle.goal,
            number=cycle.number,
            cancelled=cycle.cancelled,
            status=cycle.status(today),  # pyright: ignore[reportArgumentType]
            counts=CountsRead.from_counts(cycle.counts),
            points=CountsRead.from_counts(cycle.counted_points(count_unestimated)),
            unestimated=CountsRead.from_counts(cycle.unestimated),
            carry=CarryOverRead.from_carry(
                cycle.carry.counting_unestimated(count_unestimated),
                cycle.carried_in_issue_ids,
                cycle.carried_out_issue_ids,
            ),
            created_by=cycle.created_by,
            created_at=cycle.created_at,
            updated_at=cycle.updated_at,
        )


CycleListRead = cursor_page(CycleRead, "cycles", model_name="CycleListRead")
"""The body the cycle list route answers with, items under `cycles`."""


class CycleHistoryPoint(BaseModel):
    """One day of a cycle's burn-up, in issues and in estimate points.

    `scope` excludes cancelled work, `started` includes finished work, and
    `completed` is finished work alone, matching the cycle page's own figures.
    """

    date: str
    scope: int
    started: int
    completed: int
    scope_points: int
    started_points: int
    completed_points: int


class CycleHistoryRead(BaseModel):
    """A cycle's daily scope history, first day to today or its end."""

    cycle_id: str
    team_id: str
    start_date: str
    end_date: str
    status: CycleStatusField
    today: str
    days: list[CycleHistoryPoint]


class VelocityCycleRead(BaseModel):
    """One completed cycle's delivered work, frozen at its end date."""

    cycle_id: str
    name: str
    start_date: str
    end_date: str
    completed_issues: int
    completed_points: int
    scope_issues: int
    scope_points: int
    carried_out: int
    carried_out_points: int


class CycleCapacityRead(BaseModel):
    """The active or next cycle's current scope, which capacity guidance weighs."""

    cycle_id: str
    name: str
    status: CycleStatusField
    start_date: str
    end_date: str
    scope_issues: int
    scope_points: int
    carried_in: int
    carried_in_points: int


class VelocityRead(BaseModel):
    """A team's velocity over its last completed cycles, oldest first.

    `estimate_scale` tells a reader whether points mean anything for this team;
    when it is `off`, issue counts are the unit to plan against.
    """

    team_id: str
    estimate_scale: str
    cycles: list[VelocityCycleRead]
    average_points: float
    average_issues: float
    upcoming: Optional[CycleCapacityRead] = None


class ProjectCreate(BaseModel):
    """The body `POST /api/workspaces/{workspace_id}/projects` takes.

    `team_ids` is the project's teams, at least one. `team_id` is the single-team
    spelling an older client sends; given alone it is read as a one-team list, and
    given beside `team_ids` it must be one of them.
    """

    team_ids: Optional[list[str]] = Field(default=None, max_length=TEAMS_MAX)
    team_id: Optional[str] = Field(default=None, min_length=1)
    name: str = Field(min_length=1, max_length=NAME_MAX)
    description: Optional[str] = None
    lead_id: Optional[str] = Field(default=None, min_length=1)
    start_date: Optional[str] = None
    target_date: Optional[str] = None
    status: ProjectStatusField = "backlog"
    icon: Optional[ProjectIconField] = None
    color: Optional[str] = None
    health: Optional[ProjectHealthField] = None
    priority: ProjectPriorityField = "none"
    member_ids: list[str] = Field(default_factory=list, max_length=MEMBERS_MAX)
    update_interval_days: Optional[int] = None
    initiative_id: Optional[str] = Field(default=None, min_length=1)

    @field_validator("update_interval_days")
    @classmethod
    def check_update_interval(cls, value: Optional[int]) -> Optional[int]:
        """Hold the update cadence to the allowed options; `None` follows the workspace."""
        return check_interval(value)

    @field_validator("name")
    @classmethod
    def check_name(cls, value: str) -> str:
        """Reject a name that is only whitespace."""
        return _check_name(value)

    @field_validator("description")
    @classmethod
    def check_description(cls, value: Optional[str]) -> Optional[str]:
        """Hold the description to the shared byte cap."""
        return _check_description(value)

    @field_validator("start_date", "target_date")
    @classmethod
    def check_dates(cls, value: Optional[str]) -> Optional[str]:
        """Hold both dates to the contract's format."""
        return _check_date(value)

    @field_validator("team_ids")
    @classmethod
    def check_team_ids(cls, value: Optional[list[str]]) -> Optional[list[str]]:
        """Hold the team list to distinct, non-blank ids."""
        return _check_team_ids(value)

    @field_validator("color")
    @classmethod
    def check_color(cls, value: Optional[str]) -> Optional[str]:
        """Hold the colour to `#rrggbb` when one is being set."""
        return _check_color(value)

    @field_validator("member_ids")
    @classmethod
    def check_member_ids(cls, value: Optional[list[str]]) -> Optional[list[str]]:
        """Hold the member list to distinct, non-blank ids."""
        return _check_member_ids(value)

    @field_validator("status", mode="before")
    @classmethod
    def check_status(cls, value: object) -> object:
        """Accept an earlier status name as the status it now is."""
        return _legacy_status(value)

    @model_validator(mode="after")
    def check_teams_and_dates(self) -> "ProjectCreate":
        """Settle the team list from either spelling and hold the dates in order."""
        if self.team_ids is None:
            if self.team_id is None:
                raise ValueError("team_ids must name at least one team")
            self.team_ids = [self.team_id]
        elif self.team_id is not None and self.team_id not in self.team_ids:
            raise ValueError("team_id must be one of team_ids")
        _check_order(self.start_date, self.target_date, "target_date")
        return self

    @property
    def teams(self) -> list[str]:
        """The settled team list, which the validator guarantees is present."""
        return list(self.team_ids or [])


class ProjectUpdate(BaseModel):
    """The body a project patch takes.

    `team_ids` replaces the teams the caller can see; teams the caller cannot see
    are kept as they are, so a guest's edit never drops a team it was never
    shown. `team_id` is the single-team spelling an older client sends; it moves
    nothing and must name one of the project's teams, or the patch is a 404.
    A null `update_interval_days` returns the project to the workspace's cadence,
    and a null `initiative_id` takes the project out of its initiative.
    """

    team_id: Optional[str] = Field(default=None, min_length=1)
    team_ids: Optional[list[str]] = Field(default=None, min_length=1, max_length=TEAMS_MAX)
    name: Optional[str] = Field(default=None, min_length=1, max_length=NAME_MAX)
    description: Optional[str] = None
    lead_id: Optional[str] = Field(default=None, min_length=1)
    start_date: Optional[str] = None
    target_date: Optional[str] = None
    status: Optional[ProjectStatusField] = None
    icon: Optional[ProjectIconField] = None
    color: Optional[str] = None
    health: Optional[ProjectHealthField] = None
    priority: Optional[ProjectPriorityField] = None
    member_ids: Optional[list[str]] = Field(default=None, max_length=MEMBERS_MAX)
    update_interval_days: Optional[int] = None
    initiative_id: Optional[str] = Field(default=None, min_length=1)

    @field_validator("update_interval_days")
    @classmethod
    def check_update_interval(cls, value: Optional[int]) -> Optional[int]:
        """Hold the update cadence to the allowed options; null returns it to the workspace default."""
        return check_interval(value)

    @field_validator("name")
    @classmethod
    def check_name(cls, value: Optional[str]) -> Optional[str]:
        """Reject a name that is only whitespace."""
        return None if value is None else _check_name(value)

    @field_validator("description")
    @classmethod
    def check_description(cls, value: Optional[str]) -> Optional[str]:
        """Hold the description to the shared byte cap."""
        return _check_description(value)

    @field_validator("start_date", "target_date")
    @classmethod
    def check_dates(cls, value: Optional[str]) -> Optional[str]:
        """Hold both dates to the contract's format."""
        return _check_date(value)

    @field_validator("team_ids")
    @classmethod
    def check_team_ids(cls, value: Optional[list[str]]) -> Optional[list[str]]:
        """Hold the team list to distinct, non-blank ids."""
        return _check_team_ids(value)

    @field_validator("color")
    @classmethod
    def check_color(cls, value: Optional[str]) -> Optional[str]:
        """Hold the colour to `#rrggbb` when one is being set."""
        return _check_color(value)

    @field_validator("member_ids")
    @classmethod
    def check_member_ids(cls, value: Optional[list[str]]) -> Optional[list[str]]:
        """Hold the member list to distinct, non-blank ids."""
        return _check_member_ids(value)

    @field_validator("status", mode="before")
    @classmethod
    def check_status(cls, value: object) -> object:
        """Accept an earlier status name as the status it now is."""
        return _legacy_status(value)


class ProjectRead(BaseModel):
    """One project as the API returns it, with its status stored rather than derived.

    `team_ids` holds only the teams the caller can see, so a guest learns nothing
    about the rest of the workspace from a shared project. `team_id` is the first
    of them, kept for a single-team reader.
    """

    project_id: str
    workspace_id: str
    team_id: str
    team_ids: list[str]
    name: str
    description: Optional[str] = None
    lead_id: Optional[str] = None
    start_date: Optional[str] = None
    target_date: Optional[str] = None
    status: ProjectStatusField
    icon: Optional[str] = None
    color: Optional[str] = None
    health: Optional[ProjectHealthField] = None
    priority: ProjectPriorityField = "none"
    member_ids: list[str] = Field(default_factory=list)
    counts: CountsRead
    points: CountsRead = Field(default_factory=CountsRead)
    status_counts: dict[str, int] = Field(
        default_factory=dict, description="Issues per status id, beside the category totals in `counts`"
    )
    last_update_at: Optional[datetime] = None
    update_interval_days: int = DEFAULT_INTERVAL_DAYS
    update_interval_inherited: bool = True
    next_update_due_at: Optional[datetime] = None
    update_due_state: Optional[UpdateDueState] = None
    initiative_id: Optional[str] = None
    created_by: str
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(
        cls,
        project: Project,
        visible_team_ids: Optional[list[str]] = None,
        *,
        default_interval_days: int = DEFAULT_INTERVAL_DAYS,
        now: Optional[datetime] = None,
    ) -> "ProjectRead":
        """Build the response shape from a stored project row.

        `visible_team_ids` is the caller's own view of the row's teams; the route
        has already decided the caller sees at least one, so the list is never
        empty when it is passed. `default_interval_days` is the workspace cadence
        a project without its own follows, from which the due state is computed.
        """
        teams = visible_team_ids if visible_team_ids is not None else list(project.team_ids)
        return cls(
            project_id=project.project_id,
            workspace_id=project.workspace_id,
            team_id=teams[0],
            team_ids=teams,
            name=project.name,
            description=project.description,
            lead_id=project.lead_id,
            start_date=project.start_date,
            target_date=project.target_date,
            status=project.status,  # pyright: ignore[reportArgumentType]
            icon=project.icon,
            color=project.color,
            health=project.health,  # pyright: ignore[reportArgumentType]
            priority=project.priority,  # pyright: ignore[reportArgumentType]
            member_ids=list(project.member_ids),
            counts=CountsRead.from_counts(project.counts),
            points=CountsRead.from_counts(project.points),
            status_counts=dict(project.status_counts),
            last_update_at=project.last_update_at,
            update_interval_days=effective_interval(project, default_interval_days),
            update_interval_inherited=project.update_interval_days is None,
            next_update_due_at=next_update_due_at(project, default_interval_days),
            update_due_state=update_due_state(project, default_interval_days, now),
            initiative_id=project.initiative_id,
            created_by=project.created_by,
            created_at=project.created_at,
            updated_at=project.updated_at,
        )


ProjectListRead = cursor_page(ProjectRead, "projects", model_name="ProjectListRead")
"""The body the project list route answers with, items under `projects`."""


def _check_update_body(value: Optional[str]) -> Optional[str]:
    """Hold an update body to non-blank markdown under the byte cap."""
    if value is None:
        return None
    if not value.strip():
        raise ValueError("body must not be blank")
    if len(value.encode("utf-8")) > UPDATE_BODY_MAX_BYTES:
        raise ValueError(f"body must be at most {UPDATE_BODY_MAX_BYTES} bytes")
    return value


class ProjectUpdateCreate(BaseModel):
    """The body `POST /api/workspaces/{workspace_id}/projects/{project_id}/updates` takes.

    Health is required, as in Linear, because an update is the report of how the
    project stands and posting one is what sets the project's health.
    """

    body: str
    health: ProjectHealthField

    @field_validator("body")
    @classmethod
    def check_body(cls, value: str) -> str:
        """Hold the body to non-blank markdown under the byte cap."""
        return _check_update_body(value) or value


class ProjectUpdatePatch(BaseModel):
    """The body a project update patch takes; either field may be left out, neither cleared."""

    body: Optional[str] = None
    health: Optional[ProjectHealthField] = None

    @field_validator("body")
    @classmethod
    def check_body(cls, value: Optional[str]) -> Optional[str]:
        """Hold the body to non-blank markdown under the byte cap."""
        return _check_update_body(value)


class ProjectUpdateRead(BaseModel):
    """One project update as the API returns it.

    `can_edit` says whether this caller may edit or delete it, which is its
    author, a workspace admin or an admin of one of the project's teams, so a
    client draws the menu without repeating the rule.
    """

    update_id: str
    project_id: str
    workspace_id: str
    body: str
    health: ProjectHealthField
    author_id: str
    source: Optional[ChangeSource] = None
    created_at: datetime
    updated_at: datetime
    edited_at: Optional[datetime] = None
    can_edit: bool = False

    @classmethod
    def from_row(cls, update: ProjectUpdateRow, *, can_edit: bool) -> "ProjectUpdateRead":
        """Build the response shape from a stored update row."""
        return cls(
            update_id=update.update_id,
            project_id=update.project_id,
            workspace_id=update.workspace_id,
            body=update.body,
            health=update.health,  # pyright: ignore[reportArgumentType]
            author_id=update.author_id,
            source=update.source,  # pyright: ignore[reportArgumentType]
            created_at=update.created_at,
            updated_at=update.updated_at,
            edited_at=update.edited_at,
            can_edit=can_edit,
        )


ProjectUpdateListRead = cursor_page(ProjectUpdateRead, "updates", model_name="ProjectUpdateListRead")
"""The body the project update feed answers with, items under `updates`, newest first."""


class MilestoneCreate(BaseModel):
    """The body `POST /api/workspaces/{workspace_id}/projects/{project_id}/milestones` takes.

    `sort_order` is optional: left out, the milestone is placed after the last one.
    """

    name: str = Field(min_length=1, max_length=NAME_MAX)
    description: Optional[str] = None
    target_date: Optional[str] = None
    sort_order: Optional[str] = None

    @field_validator("name")
    @classmethod
    def check_name(cls, value: str) -> str:
        """Reject a name that is only whitespace."""
        return _check_name(value)

    @field_validator("description")
    @classmethod
    def check_description(cls, value: Optional[str]) -> Optional[str]:
        """Hold the description to the shared byte cap."""
        return _check_description(value)

    @field_validator("target_date")
    @classmethod
    def check_target_date(cls, value: Optional[str]) -> Optional[str]:
        """Hold the target date to the contract's format."""
        return _check_date(value)

    @field_validator("sort_order")
    @classmethod
    def check_sort_order(cls, value: Optional[str]) -> Optional[str]:
        """Hold the manual position to the base 62 alphabet."""
        return _check_sort_order(value)


class MilestoneUpdate(BaseModel):
    """The body a milestone patch takes; a reorder is a patch of `sort_order` alone.

    Setting the description or the target date to null clears it.
    """

    name: Optional[str] = Field(default=None, min_length=1, max_length=NAME_MAX)
    description: Optional[str] = None
    target_date: Optional[str] = None
    sort_order: Optional[str] = None

    @field_validator("name")
    @classmethod
    def check_name(cls, value: Optional[str]) -> Optional[str]:
        """Reject a name that is only whitespace."""
        return None if value is None else _check_name(value)

    @field_validator("description")
    @classmethod
    def check_description(cls, value: Optional[str]) -> Optional[str]:
        """Hold the description to the shared byte cap."""
        return _check_description(value)

    @field_validator("target_date")
    @classmethod
    def check_target_date(cls, value: Optional[str]) -> Optional[str]:
        """Hold the target date to the contract's format."""
        return _check_date(value)

    @field_validator("sort_order")
    @classmethod
    def check_sort_order(cls, value: Optional[str]) -> Optional[str]:
        """Hold the manual position to the base 62 alphabet."""
        return _check_sort_order(value)


class MilestoneRead(BaseModel):
    """One project milestone as the API returns it, with its progress counts and points."""

    milestone_id: str
    project_id: str
    workspace_id: str
    name: str
    description: Optional[str] = None
    target_date: Optional[str] = None
    sort_order: str
    counts: CountsRead
    points: CountsRead = Field(default_factory=CountsRead)
    status_counts: dict[str, int] = Field(
        default_factory=dict, description="Issues per status id, beside the category totals in `counts`"
    )
    created_by: str
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, milestone: ProjectMilestone) -> "MilestoneRead":
        """Build the response shape from a stored milestone row."""
        return cls(
            milestone_id=milestone.milestone_id,
            project_id=milestone.project_id,
            workspace_id=milestone.workspace_id,
            name=milestone.name,
            description=milestone.description,
            target_date=milestone.target_date,
            sort_order=milestone.sort_order,
            counts=CountsRead.from_counts(milestone.counts),
            points=CountsRead.from_counts(milestone.points),
            status_counts=dict(milestone.status_counts),
            created_by=milestone.created_by,
            created_at=milestone.created_at,
            updated_at=milestone.updated_at,
        )


MilestoneListRead = cursor_page(MilestoneRead, "milestones", model_name="MilestoneListRead")
"""The body the milestone list route answers with, items under `milestones`."""


class RoadmapEntryRead(BaseModel):
    """One cycle or project as the roadmap draws it.

    A projection rather than the full row: the timeline renders a bar and a count,
    and a reader wanting the rest has the entity's own route. The icon, colour,
    health and priority are a project's alone, so a cycle answers them as null.
    """

    kind: RoadmapKindField
    id: str
    team_id: str
    team_ids: list[str]
    name: str
    target_date: Optional[str] = None
    start_date: Optional[str] = None
    status: str
    icon: Optional[str] = None
    color: Optional[str] = None
    health: Optional[str] = None
    priority: Optional[str] = None
    counts: CountsRead

    @classmethod
    def from_cycle(cls, cycle: Cycle, today: Optional[str] = None) -> "RoadmapEntryRead":
        """One cycle as a roadmap entry, drawn at its end date."""
        return cls(
            kind="cycle",
            id=cycle.cycle_id,
            team_id=cycle.team_id,
            team_ids=[cycle.team_id],
            name=cycle.name,
            target_date=cycle.end_date,
            start_date=cycle.start_date,
            status=cycle.status(today),
            counts=CountsRead.from_counts(cycle.counts),
        )

    @classmethod
    def from_project(cls, project: Project, visible_team_ids: list[str]) -> "RoadmapEntryRead":
        """One project as a roadmap entry, drawn from its start to its target date.

        Carries only the teams the caller can see, for the same reason the full
        project read does.
        """
        return cls(
            kind="project",
            id=project.project_id,
            team_id=visible_team_ids[0],
            team_ids=visible_team_ids,
            name=project.name,
            target_date=project.target_date,
            start_date=project.start_date,
            status=project.status,
            icon=project.icon,
            color=project.color,
            health=project.health,
            priority=project.priority,
            counts=CountsRead.from_counts(project.counts),
        )


RoadmapListRead = cursor_page(RoadmapEntryRead, "entries", model_name="RoadmapListRead")
"""The body the roadmap route answers with, items under `entries`."""


class HealthBreakdownRead(BaseModel):
    """How many of an initiative's visible projects report each health."""

    on_track: int = 0
    at_risk: int = 0
    off_track: int = 0
    none: int = 0


class InitiativeCreate(BaseModel):
    """The body `POST /api/workspaces/{workspace_id}/initiatives` takes."""

    name: str = Field(min_length=1, max_length=NAME_MAX)
    description: Optional[str] = None
    owner_id: Optional[str] = Field(default=None, min_length=1)
    status: InitiativeStatusField = "planned"
    health: Optional[ProjectHealthField] = None
    target_date: Optional[str] = None
    update_interval_days: Optional[int] = None

    @field_validator("update_interval_days")
    @classmethod
    def check_update_interval(cls, value: Optional[int]) -> Optional[int]:
        """Hold the update cadence to the allowed options; `None` follows the workspace."""
        return check_interval(value)

    @field_validator("name")
    @classmethod
    def check_name(cls, value: str) -> str:
        """Reject a name that is only whitespace."""
        return _check_name(value)

    @field_validator("description")
    @classmethod
    def check_description(cls, value: Optional[str]) -> Optional[str]:
        """Hold the description to the shared byte cap."""
        return _check_description(value)

    @field_validator("target_date")
    @classmethod
    def check_target_date(cls, value: Optional[str]) -> Optional[str]:
        """Hold the target date to the contract's format."""
        return _check_date(value)


class InitiativeUpdate(BaseModel):
    """The body an initiative patch takes; null clears the description, owner, health, date or cadence."""

    name: Optional[str] = Field(default=None, min_length=1, max_length=NAME_MAX)
    description: Optional[str] = None
    owner_id: Optional[str] = Field(default=None, min_length=1)
    status: Optional[InitiativeStatusField] = None
    health: Optional[ProjectHealthField] = None
    target_date: Optional[str] = None
    update_interval_days: Optional[int] = None

    @field_validator("update_interval_days")
    @classmethod
    def check_update_interval(cls, value: Optional[int]) -> Optional[int]:
        """Hold the update cadence to the allowed options; null returns it to the workspace default."""
        return check_interval(value)

    @field_validator("name")
    @classmethod
    def check_name(cls, value: Optional[str]) -> Optional[str]:
        """Reject a name that is only whitespace."""
        return None if value is None else _check_name(value)

    @field_validator("description")
    @classmethod
    def check_description(cls, value: Optional[str]) -> Optional[str]:
        """Hold the description to the shared byte cap."""
        return _check_description(value)

    @field_validator("target_date")
    @classmethod
    def check_target_date(cls, value: Optional[str]) -> Optional[str]:
        """Hold the target date to the contract's format."""
        return _check_date(value)


class InitiativeRead(BaseModel):
    """One initiative as the API returns it, rolled up from the projects the caller can see.

    `project_ids`, `counts`, `points` and `project_health` count only the
    projects visible to this caller, so the rollup never reveals work on a team
    they cannot read.
    """

    initiative_id: str
    workspace_id: str
    name: str
    description: Optional[str] = None
    owner_id: Optional[str] = None
    status: InitiativeStatusField
    health: Optional[ProjectHealthField] = None
    target_date: Optional[str] = None
    project_ids: list[str] = Field(default_factory=list)
    project_count: int = 0
    counts: CountsRead = Field(default_factory=CountsRead)
    points: CountsRead = Field(default_factory=CountsRead)
    status_counts: dict[str, int] = Field(
        default_factory=dict, description="Issues per status id across the visible projects, beside `counts`"
    )
    project_health: HealthBreakdownRead = Field(default_factory=HealthBreakdownRead)
    last_update_at: Optional[datetime] = None
    update_interval_days: int = DEFAULT_INTERVAL_DAYS
    update_interval_inherited: bool = True
    next_update_due_at: Optional[datetime] = None
    update_due_state: Optional[UpdateDueState] = None
    created_by: str
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(
        cls,
        initiative: Initiative,
        projects: list[Project],
        *,
        default_interval_days: int = DEFAULT_INTERVAL_DAYS,
        now: Optional[datetime] = None,
    ) -> "InitiativeRead":
        """Build the response shape from a stored initiative and its visible projects."""
        counts = RollupCounts()
        points = RollupCounts()
        tally = {"on_track": 0, "at_risk": 0, "off_track": 0, "none": 0}
        statuses: dict[str, int] = {}
        for project in projects:
            counts = counts.plus(project.counts)
            points = points.plus(project.points)
            for status_id, count in project.status_counts.items():
                statuses[status_id] = statuses.get(status_id, 0) + count
            bucket = project.health if project.health in tally else "none"
            tally[bucket or "none"] += 1
        return cls(
            initiative_id=initiative.initiative_id,
            workspace_id=initiative.workspace_id,
            name=initiative.name,
            description=initiative.description,
            owner_id=initiative.owner_id,
            status=initiative.status,  # pyright: ignore[reportArgumentType]
            health=initiative.health,  # pyright: ignore[reportArgumentType]
            target_date=initiative.target_date,
            project_ids=[project.project_id for project in projects],
            project_count=len(projects),
            counts=CountsRead.from_counts(counts),
            points=CountsRead.from_counts(points),
            status_counts=statuses,
            project_health=HealthBreakdownRead(**tally),
            last_update_at=initiative.last_update_at,
            update_interval_days=effective_interval(initiative, default_interval_days),
            update_interval_inherited=initiative.update_interval_days is None,
            next_update_due_at=next_update_due_at(initiative, default_interval_days),
            update_due_state=update_due_state(initiative, default_interval_days, now),
            created_by=initiative.created_by,
            created_at=initiative.created_at,
            updated_at=initiative.updated_at,
        )


InitiativeListRead = cursor_page(InitiativeRead, "initiatives", model_name="InitiativeListRead")
"""The body the initiative list route answers with, items under `initiatives`."""


class InitiativeUpdateCreate(BaseModel):
    """The body `POST /api/workspaces/{workspace_id}/initiatives/{initiative_id}/updates` takes."""

    body: str
    health: ProjectHealthField

    @field_validator("body")
    @classmethod
    def check_body(cls, value: str) -> str:
        """Hold the body to non-blank markdown under the byte cap."""
        return _check_update_body(value) or value


class InitiativeUpdatePatch(BaseModel):
    """The body an initiative update patch takes; either field may be left out, neither cleared."""

    body: Optional[str] = None
    health: Optional[ProjectHealthField] = None

    @field_validator("body")
    @classmethod
    def check_body(cls, value: Optional[str]) -> Optional[str]:
        """Hold the body to non-blank markdown under the byte cap."""
        return _check_update_body(value)


class InitiativeUpdateRead(BaseModel):
    """One initiative update as the API returns it, with this caller's edit right."""

    update_id: str
    initiative_id: str
    workspace_id: str
    body: str
    health: ProjectHealthField
    author_id: str
    source: Optional[ChangeSource] = None
    created_at: datetime
    updated_at: datetime
    edited_at: Optional[datetime] = None
    can_edit: bool = False

    @classmethod
    def from_row(cls, update: InitiativeUpdateRow, *, can_edit: bool) -> "InitiativeUpdateRead":
        """Build the response shape from a stored update row."""
        return cls(
            update_id=update.update_id,
            initiative_id=update.initiative_id,
            workspace_id=update.workspace_id,
            body=update.body,
            health=update.health,  # pyright: ignore[reportArgumentType]
            author_id=update.author_id,
            source=update.source,  # pyright: ignore[reportArgumentType]
            created_at=update.created_at,
            updated_at=update.updated_at,
            edited_at=update.edited_at,
            can_edit=can_edit,
        )


InitiativeUpdateListRead = cursor_page(InitiativeUpdateRead, "updates", model_name="InitiativeUpdateListRead")
"""The body the initiative update feed answers with, items under `updates`, newest first."""
