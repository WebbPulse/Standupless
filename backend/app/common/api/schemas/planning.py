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
from typing import Any, Literal, Optional
from urllib.parse import urlsplit

from pydantic import BaseModel, Field, field_validator, model_validator
from webbpulse.http import cursor_page

from app.common.api.schemas.teams import COLOR_PATTERN
from app.common.change_source import ChangeSource
from app.common.date_resolution import DateEdge, DateResolution, read_resolution, snap
from app.common.db.dynamo.planning import (
    CarryOver,
    Cycle,
    Initiative,
    InitiativeUpdateRow,
    InitiativeUpdateSnapshot,
    ProgressMeasure,
    Project,
    ProjectActivityRow,
    ProjectLink,
    ProjectMilestone,
    ProjectUpdateRow,
    ProjectUpdateSnapshot,
    PulseEvent,
    RollupCounts,
    normalise_project_status,
)
from app.common.discussion_reads import ReactionGroupRead
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

ProjectSortField = Literal["target_asc", "customer_requests_desc", "customer_important_desc", "customer_revenue_desc"]
"""The orders the projects list takes: target date, undated last, or the most customer requests, important
requests or revenue first."""

ProgressMeasureField = ProgressMeasure
"""The unit `progress` reads in: estimate points when a team on the work estimates, otherwise issues."""

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

PROJECT_LABELS_MAX = 50

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


START_RESOLUTION_HELP = "How wide the start date is: an exact day, or the month, quarter, half or year it opens"

TARGET_RESOLUTION_HELP = "How wide the target date is: an exact day, or the month, quarter, half or year it closes"


def _settle_resolution(value: Optional[str], resolution: Optional[str], edge: DateEdge, name: str) -> Optional[str]:
    """One created date moved to the edge of its period, refusing a resolution with no date to widen."""
    if value is None:
        if resolution not in (None, "day"):
            raise ValueError(f"{name}_resolution needs a {name}")
        return None
    return snap(value, resolution, edge)


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


def _check_label_ids(value: Optional[list[str]]) -> Optional[list[str]]:
    """Hold a project label list to distinct, non-blank ids, keeping the caller's order."""
    if value is None:
        return None
    seen: list[str] = []
    for label_id in value:
        candidate = label_id.strip()
        if not candidate:
            raise ValueError("label_ids must not contain a blank id")
        if candidate not in seen:
            seen.append(candidate)
    return seen


def project_slug_id(project_id: str) -> str:
    """The short id a project reads by, the last eight characters of its id in lower case.

    Derived rather than stored, so every project has one without a backfill. A
    ULID's tail is its random part, so two projects of a workspace sharing one is
    vanishingly rare, and a lookup by slug id refuses an ambiguous match.
    """
    return project_id[-8:].lower()


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
    """One cycle as the API returns it, with its status derived from its dates.

    `gap_before_days` is set on the cycle list: the days with no live cycle
    between the team's cycles before this one and its start, which the cycles
    page draws as "Cycles paused". It is null on the first live cycle, on a
    cancelled one, and on reads other than the list.
    """

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
    gap_before_days: Optional[int] = None
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


class CycleStartToday(BaseModel):
    """The body `POST /api/workspaces/{workspace_id}/cycles/{cycle_id}/start-today` takes."""

    team_id: str = Field(min_length=1)


class CycleEndToday(BaseModel):
    """The body `POST /api/workspaces/{workspace_id}/cycles/{cycle_id}/end-today` takes."""

    team_id: str = Field(min_length=1)


class CycleStartTodayRead(BaseModel):
    """What starting a cycle today changed.

    `ended` is the cycle that was current, now ending yesterday, or null when no
    cycle was running. `moved_issues` counts its unfinished issues rolled into
    the started cycle.
    """

    cycle: CycleRead
    ended: Optional[CycleRead] = None
    moved_issues: int = 0


class CycleCalendarFeedCreate(BaseModel):
    """The body `POST /api/workspaces/{workspace_id}/cycles/calendar-feed` takes."""

    team_id: str = Field(min_length=1)


class CycleCalendarFeedRead(BaseModel):
    """The caller's cycle calendar feed for one team.

    `url` carries the feed token, so it is answered only by the call that minted
    it: the token is stored as a hash and cannot be read back. A read of an
    existing feed says it is `active` with a null `url`, and minting again revokes
    the old URL.
    """

    team_id: str
    active: bool
    created_at: Optional[datetime] = None
    url: Optional[str] = None


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


class ProjectProjectionRead(BaseModel):
    """Where the recent completion rate takes a project's remaining scope.

    `rate_per_day` is in the project's `measure`. `expected_date` is None when
    nothing was completed over the window or the finish is out of sight, and
    `days_past_target` is negative when the finish lands before the target date.
    """

    rate_per_day: float
    expected_date: Optional[str] = None
    days_past_target: Optional[int] = None


class ProjectHistoryRead(BaseModel):
    """A project's daily scope, started and completed figures, from the day its series opens to today.

    `recorded_since` is the first day the snapshots recorded, None while the
    project has no history yet and `days` holds today alone.
    """

    project_id: str
    start_date: Optional[str] = None
    target_date: Optional[str] = None
    target_date_resolution: Optional[DateResolution] = Field(
        default=None, description="How wide the target date is, null without one"
    )
    today: str
    measure: ProgressMeasureField
    recorded_since: Optional[str] = None
    days: list[CycleHistoryPoint]
    projection: Optional[ProjectProjectionRead] = None


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
    given beside `team_ids` it must be one of them. `template_id` names a project
    template one of the teams offers: it fills the fields left out and adds its
    milestones and issues.
    """

    team_ids: Optional[list[str]] = Field(default=None, max_length=TEAMS_MAX)
    team_id: Optional[str] = Field(default=None, min_length=1)
    template_id: Optional[str] = Field(default=None, min_length=1)
    name: str = Field(min_length=1, max_length=NAME_MAX)
    description: Optional[str] = None
    lead_id: Optional[str] = Field(default=None, min_length=1)
    start_date: Optional[str] = None
    target_date: Optional[str] = None
    start_date_resolution: Optional[DateResolution] = Field(default=None, description=START_RESOLUTION_HELP)
    target_date_resolution: Optional[DateResolution] = Field(default=None, description=TARGET_RESOLUTION_HELP)
    status: ProjectStatusField = Field(
        default="backlog", description="The status category; alone it lands on the category's default status"
    )
    status_id: Optional[str] = Field(
        default=None, min_length=1, description="The workspace project status; its category wins over `status`"
    )
    icon: Optional[ProjectIconField] = None
    color: Optional[str] = None
    health: Optional[ProjectHealthField] = None
    priority: ProjectPriorityField = "none"
    member_ids: list[str] = Field(default_factory=list, max_length=MEMBERS_MAX)
    label_ids: list[str] = Field(default_factory=list, max_length=PROJECT_LABELS_MAX)
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

    @field_validator("label_ids")
    @classmethod
    def check_label_ids(cls, value: Optional[list[str]]) -> Optional[list[str]]:
        """Hold the project label list to distinct, non-blank ids."""
        return _check_label_ids(value)

    @field_validator("status", mode="before")
    @classmethod
    def check_status(cls, value: object) -> object:
        """Accept an earlier status name as the status it now is."""
        return _legacy_status(value)

    @model_validator(mode="after")
    def check_teams_and_dates(self) -> "ProjectCreate":
        """Settle the team list from either spelling, widen each coarse date to its period and hold them in order."""
        if self.team_ids is None:
            if self.team_id is None:
                raise ValueError("team_ids must name at least one team")
            self.team_ids = [self.team_id]
        elif self.team_id is not None and self.team_id not in self.team_ids:
            raise ValueError("team_id must be one of team_ids")
        start = _settle_resolution(self.start_date, self.start_date_resolution, "start", "start_date")
        if start != self.start_date:
            self.start_date = start
        target = _settle_resolution(self.target_date, self.target_date_resolution, "end", "target_date")
        if target != self.target_date:
            self.target_date = target
        _check_order(self.start_date, self.target_date, "target_date")
        return self

    @property
    def teams(self) -> list[str]:
        """The settled team list, which the validator guarantees is present."""
        return list(self.team_ids or [])


ProjectOpenIssuesAction = Literal["keep", "move", "cancel"]


class ProjectOpenIssues(BaseModel):
    """What a patch that completes or cancels a project does with the issues still open in it.

    `keep` leaves them in the project, `move` moves them to the project named by
    `project_id`, and `cancel` moves each to its team's first canceled status.
    """

    action: ProjectOpenIssuesAction
    project_id: Optional[str] = Field(default=None, min_length=1)

    @model_validator(mode="after")
    def check_target(self) -> "ProjectOpenIssues":
        """Hold `project_id` to the move, which needs it, and refuse it elsewhere."""
        if self.action == "move" and self.project_id is None:
            raise ValueError("project_id is required to move the open issues")
        if self.action != "move" and self.project_id is not None:
            raise ValueError("project_id is only taken when moving the open issues")
        return self


class ProjectUpdate(BaseModel):
    """The body a project patch takes.

    `team_ids` replaces the teams the caller can see; teams the caller cannot see
    are kept as they are, so a guest's edit never drops a team it was never
    shown. `team_id` is the single-team spelling an older client sends; it moves
    nothing and must name one of the project's teams, or the patch is a 404.
    A null `update_interval_days` returns the project to the workspace's cadence,
    and a null `initiative_id` takes the project out of its initiative.
    `open_issues` says what happens to the issues still open in a project the
    patch leaves completed or canceled; without it they stay where they are.
    `sort_order` is the project's manual position, a base 62 fractional key
    shared by every viewer, so a drag rewrites only the project moved.
    """

    team_id: Optional[str] = Field(default=None, min_length=1)
    team_ids: Optional[list[str]] = Field(default=None, min_length=1, max_length=TEAMS_MAX)
    name: Optional[str] = Field(default=None, min_length=1, max_length=NAME_MAX)
    description: Optional[str] = None
    lead_id: Optional[str] = Field(default=None, min_length=1)
    start_date: Optional[str] = None
    target_date: Optional[str] = None
    start_date_resolution: Optional[DateResolution] = Field(
        default=None, description=f"{START_RESOLUTION_HELP}; set alone it widens the stored date"
    )
    target_date_resolution: Optional[DateResolution] = Field(
        default=None, description=f"{TARGET_RESOLUTION_HELP}; set alone it widens the stored date"
    )
    status: Optional[ProjectStatusField] = Field(
        default=None, description="The status category; a project already in it keeps its status"
    )
    status_id: Optional[str] = Field(
        default=None, min_length=1, description="The workspace project status to move the project to"
    )
    icon: Optional[ProjectIconField] = None
    color: Optional[str] = None
    health: Optional[ProjectHealthField] = None
    priority: Optional[ProjectPriorityField] = None
    member_ids: Optional[list[str]] = Field(default=None, max_length=MEMBERS_MAX)
    label_ids: Optional[list[str]] = Field(default=None, max_length=PROJECT_LABELS_MAX)
    update_interval_days: Optional[int] = None
    initiative_id: Optional[str] = Field(default=None, min_length=1)
    sort_order: Optional[str] = None
    open_issues: Optional[ProjectOpenIssues] = None

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

    @field_validator("label_ids")
    @classmethod
    def check_label_ids(cls, value: Optional[list[str]]) -> Optional[list[str]]:
        """Hold the project label list to distinct, non-blank ids."""
        return _check_label_ids(value)

    @field_validator("status", mode="before")
    @classmethod
    def check_status(cls, value: object) -> object:
        """Accept an earlier status name as the status it now is."""
        return _legacy_status(value)

    @field_validator("sort_order")
    @classmethod
    def check_sort_order(cls, value: Optional[str]) -> Optional[str]:
        """Hold a manual position to the base 62 alphabet and its length cap."""
        return _check_sort_order(value)


class SkippedTemplateIssueRead(BaseModel):
    """One template issue a project created from a template left out, and why."""

    key: str = Field(description="The issue's key within the template")
    title: str
    reason: str = Field(description="Why the issue rules refused it, as the 422 would have said")


class ProjectMilestoneMarkerRead(BaseModel):
    """One dated milestone of a project, as the timeline marks it on the project's lane."""

    milestone_id: str
    name: str
    target_date: str
    completed: bool = Field(description="Every issue in the milestone is finished, and it holds at least one")
    counts: CountsRead = Field(default_factory=CountsRead, description="The milestone's issue counts")
    measure: ProgressMeasureField = Field(
        default="issues", description="The unit `progress` reads in, points when a team on it estimates"
    )
    progress: CountsRead = Field(
        default_factory=CountsRead, description="The buckets scope and completion are measured by, in `measure`"
    )

    @classmethod
    def from_row(cls, milestone: ProjectMilestone) -> "ProjectMilestoneMarkerRead":
        """Build the marker from a stored milestone that has a target date."""
        progress = milestone.progress
        return cls(
            milestone_id=milestone.milestone_id,
            name=milestone.name,
            target_date=milestone.target_date or "",
            completed=progress.scope > 0 and progress.done >= progress.scope,
            counts=CountsRead.from_counts(milestone.counts),
            measure=milestone.measure,
            progress=CountsRead.from_counts(milestone.progress),
        )


LINK_URL_MAX = 2048
"""The longest URL a Resources link may hold."""

LINK_TITLE_MAX = 200
"""The longest title a Resources link may hold."""


def _check_link_url(value: str) -> str:
    """Hold a Resources link to an absolute http or https URL with a host."""
    candidate = value.strip()
    if not candidate:
        raise ValueError("url must not be blank")
    if len(candidate) > LINK_URL_MAX:
        raise ValueError(f"url must be at most {LINK_URL_MAX} characters")
    if any(character.isspace() for character in candidate):
        raise ValueError("url must not contain whitespace")
    parts = urlsplit(candidate)
    if parts.scheme.lower() not in ("http", "https"):
        raise ValueError("url must start with http:// or https://")
    try:
        host = parts.hostname
    except ValueError as exc:
        raise ValueError("url must name a host") from exc
    if not host:
        raise ValueError("url must name a host")
    return candidate


def _check_link_title(value: Optional[str]) -> Optional[str]:
    """Trim a Resources link title, a blank one read as no title at all."""
    if value is None:
        return None
    candidate = value.strip()
    if not candidate:
        return None
    if len(candidate) > LINK_TITLE_MAX:
        raise ValueError(f"title must be at most {LINK_TITLE_MAX} characters")
    return candidate


class ProjectLinkCreate(BaseModel):
    """The body `POST /api/workspaces/{workspace_id}/projects/{project_id}/links` takes.

    `title` is optional, and a link without one reads as its hostname. `sort_order`
    is optional too: left out, the link is placed after the last one.
    """

    url: str = Field(description="An absolute http or https URL")
    title: Optional[str] = Field(default=None, description="What the link reads as, its hostname when blank")
    sort_order: Optional[str] = None

    @field_validator("url")
    @classmethod
    def check_url(cls, value: str) -> str:
        """Hold the URL to http or https with a host."""
        return _check_link_url(value)

    @field_validator("title")
    @classmethod
    def check_title(cls, value: Optional[str]) -> Optional[str]:
        """Trim the title and hold it to its cap."""
        return _check_link_title(value)

    @field_validator("sort_order")
    @classmethod
    def check_sort_order(cls, value: Optional[str]) -> Optional[str]:
        """Hold the manual position to the base 62 alphabet."""
        return _check_sort_order(value)


class ProjectLinkUpdate(BaseModel):
    """The body a Resources link patch takes; a reorder is a patch of `sort_order` alone.

    Setting the title to null or blank clears it, so the link reads as its hostname.
    """

    url: Optional[str] = None
    title: Optional[str] = None
    sort_order: Optional[str] = None

    @field_validator("url")
    @classmethod
    def check_url(cls, value: Optional[str]) -> Optional[str]:
        """Hold the URL to http or https with a host."""
        return None if value is None else _check_link_url(value)

    @field_validator("title")
    @classmethod
    def check_title(cls, value: Optional[str]) -> Optional[str]:
        """Trim the title and hold it to its cap."""
        return _check_link_title(value)

    @field_validator("sort_order")
    @classmethod
    def check_sort_order(cls, value: Optional[str]) -> Optional[str]:
        """Hold the manual position to the base 62 alphabet."""
        return _check_sort_order(value)


class ProjectLinkRead(BaseModel):
    """One external link in a project's Resources section as the API returns it."""

    link_id: str
    project_id: str
    workspace_id: str
    url: str
    title: Optional[str] = Field(
        default=None, description="What the person typed, null when the link reads as its hostname"
    )
    sort_order: str
    created_by: str
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, link: ProjectLink) -> "ProjectLinkRead":
        """Build the response shape from a stored link row."""
        return cls(
            link_id=link.link_id,
            project_id=link.project_id,
            workspace_id=link.workspace_id,
            url=link.url,
            title=link.title,
            sort_order=link.sort_order,
            created_by=link.created_by,
            created_at=link.created_at,
            updated_at=link.updated_at,
        )


ProjectLinkListRead = cursor_page(ProjectLinkRead, "links", model_name="ProjectLinkListRead")
"""The body the Resources link list route answers with, items under `links`, in manual order."""


class ProjectRead(BaseModel):
    """One project as the API returns it, with its status stored rather than derived.

    `team_ids` holds only the teams the caller can see, so a guest learns nothing
    about the rest of the workspace from a shared project. `team_id` is the first
    of them, kept for a single-team reader.
    """

    project_id: str
    slug_id: str = Field(default="", description="The project's short id, the last eight characters of its id")
    workspace_id: str
    team_id: str
    team_ids: list[str]
    name: str
    description: Optional[str] = None
    lead_id: Optional[str] = None
    start_date: Optional[str] = None
    target_date: Optional[str] = None
    start_date_resolution: Optional[DateResolution] = Field(
        default=None,
        description="How wide the start date is, null without one; a coarse start is its period's first day",
    )
    target_date_resolution: Optional[DateResolution] = Field(
        default=None,
        description="How wide the target date is, null without one; a coarse target is its period's last day",
    )
    status: ProjectStatusField = Field(description="The category of the project's status, which every rule reads")
    status_id: str = Field(default="", description="The workspace project status the project sits in")
    icon: Optional[str] = None
    color: Optional[str] = None
    health: Optional[ProjectHealthField] = None
    priority: ProjectPriorityField = "none"
    member_ids: list[str] = Field(default_factory=list)
    label_ids: list[str] = Field(default_factory=list, description="The workspace project labels the project carries")
    counts: CountsRead
    points: CountsRead = Field(default_factory=CountsRead)
    measure: ProgressMeasureField = Field(
        default="issues", description="The unit `progress` reads in, points when a team on it estimates"
    )
    progress: CountsRead = Field(
        default_factory=CountsRead, description="The buckets scope and completion are measured by, in `measure`"
    )
    status_counts: dict[str, int] = Field(
        default_factory=dict, description="Issues per status id, beside the category totals in `counts`"
    )
    last_update_at: Optional[datetime] = None
    update_interval_days: int = DEFAULT_INTERVAL_DAYS
    update_interval_inherited: bool = True
    next_update_due_at: Optional[datetime] = None
    update_due_state: Optional[UpdateDueState] = None
    initiative_id: Optional[str] = None
    sort_order: Optional[str] = Field(
        default=None,
        description="The manual position, a base 62 fractional key; null on a project never placed, which sorts last",
    )
    open_issue_count: Optional[int] = Field(
        default=None,
        description="Issues still open in the project, answered by a patch that leaves it completed or canceled",
    )
    completed_at: Optional[datetime] = Field(
        default=None, description="When the project last became completed or canceled, null while it is open"
    )
    archived_at: Optional[datetime] = Field(
        default=None, description="When the project was archived, null while it is live"
    )
    skipped_template_issues: Optional[list[SkippedTemplateIssueRead]] = Field(
        default=None,
        description="Template issues left out, answered by a create from a project template, empty when none were",
    )
    blocked_by_project_ids: list[str] = Field(
        default_factory=list, description="The visible projects that block this one, oldest link first"
    )
    blocking_project_ids: list[str] = Field(
        default_factory=list, description="The visible projects this one blocks, oldest link first"
    )
    milestone_markers: list[ProjectMilestoneMarkerRead] = Field(
        default_factory=list,
        description="The project's milestones that have a target date, earliest first, filled on the project list",
    )
    customer_request_count: Optional[int] = Field(
        default=None,
        description="Customer requests naming the project, answered by a list filtered or sorted by customer",
    )
    customer_important_count: Optional[int] = Field(
        default=None,
        description="Customer requests naming the project marked important, answered with customer_request_count",
    )
    customer_revenue: Optional[int] = Field(
        default=None,
        description="Summed revenue of the customers asking for the project, answered by the revenue sort",
    )
    links: Optional[list[ProjectLinkRead]] = Field(
        default=None,
        description="The project's Resources links in manual order, filled on a single project read only",
    )
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
            slug_id=project_slug_id(project.project_id),
            workspace_id=project.workspace_id,
            team_id=teams[0],
            team_ids=teams,
            name=project.name,
            description=project.description,
            lead_id=project.lead_id,
            start_date=project.start_date,
            target_date=project.target_date,
            start_date_resolution=read_resolution(project.start_date, project.start_date_resolution),
            target_date_resolution=read_resolution(project.target_date, project.target_date_resolution),
            status=project.status,  # pyright: ignore[reportArgumentType]
            status_id=project.effective_status_id,
            icon=project.icon,
            color=project.color,
            health=project.health,  # pyright: ignore[reportArgumentType]
            priority=project.priority,  # pyright: ignore[reportArgumentType]
            member_ids=list(project.member_ids),
            label_ids=list(project.label_ids),
            counts=CountsRead.from_counts(project.counts),
            points=CountsRead.from_counts(project.points),
            measure=project.measure,
            progress=CountsRead.from_counts(project.progress),
            status_counts=dict(project.status_counts),
            last_update_at=project.last_update_at,
            update_interval_days=effective_interval(project, default_interval_days),
            update_interval_inherited=project.update_interval_days is None,
            next_update_due_at=next_update_due_at(project, default_interval_days),
            update_due_state=update_due_state(project, default_interval_days, now),
            initiative_id=project.initiative_id,
            sort_order=project.sort_order,
            completed_at=project.completed_at,
            archived_at=project.archived_at,
            created_by=project.created_by,
            created_at=project.created_at,
            updated_at=project.updated_at,
        )


ProjectListRead = cursor_page(ProjectRead, "projects", model_name="ProjectListRead")
"""The body the project list route answers with, items under `projects`."""

ProjectRelationType = Literal["blocks", "blocked_by"]
"""How a dependency reads from the project named in the path."""

PROJECT_RELATION_TYPES: tuple[str, ...] = ("blocks", "blocked_by")


class ProjectRelationCreate(BaseModel):
    """A dependency to add between the path project and another one."""

    type: ProjectRelationType = Field(description="`blocks` when the path project blocks the target")
    target_project_id: str = Field(min_length=1, description="The other project")


class ProjectRelationRead(BaseModel):
    """One dependency read from the path project's side."""

    relation_id: str
    type: ProjectRelationType
    project_id: str = Field(description="The path project")
    target_project_id: str = Field(description="The project at the other end")
    created_by: str
    created_at: datetime


ProjectRelationListRead = cursor_page(ProjectRelationRead, "relations", model_name="ProjectRelationListRead")
"""The body the project relation list answers with, whole and never paged."""


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
    project stands and posting one is what sets the project's health. `body`
    may be left out when `template_id` names a document template, whose body
    the update then takes.
    """

    body: Optional[str] = None
    health: ProjectHealthField
    template_id: Optional[str] = None
    hide_details: bool = Field(default=False, description="Hide the progress report on this update for everyone")

    @field_validator("body")
    @classmethod
    def check_body(cls, value: Optional[str]) -> Optional[str]:
        """Hold the body to non-blank markdown under the byte cap."""
        return _check_update_body(value)


class ProjectUpdatePatch(BaseModel):
    """The body a project update patch takes; any field may be left out, none cleared."""

    body: Optional[str] = None
    health: Optional[ProjectHealthField] = None
    hide_details: Optional[bool] = Field(default=None, description="Hide or show the update's progress report")

    @field_validator("body")
    @classmethod
    def check_body(cls, value: Optional[str]) -> Optional[str]:
        """Hold the body to non-blank markdown under the byte cap."""
        return _check_update_body(value)


class MilestoneSnapshotRead(BaseModel):
    """One milestone's progress as a project update recorded it, in the project's measure."""

    milestone_id: str
    name: str
    completed: int = 0
    total: int = 0


class ProjectUpdateSnapshotRead(BaseModel):
    """Where a project stood when an update was posted, as the API returns it.

    `completed` and `total` are in `measure`, cancelled work left out, and
    `percent` is their whole percent.
    """

    measure: ProgressMeasureField = "issues"
    completed: int = 0
    total: int = 0
    percent: int = 0
    target_date: Optional[str] = None
    target_date_resolution: Optional[DateResolution] = None
    lead_id: Optional[str] = None
    lead_name: Optional[str] = None
    status: Optional[ProjectStatusField] = None
    status_id: Optional[str] = None
    status_name: Optional[str] = None
    milestones: list[MilestoneSnapshotRead] = Field(default_factory=list)

    @classmethod
    def from_snapshot(cls, snapshot: Optional[ProjectUpdateSnapshot]) -> Optional["ProjectUpdateSnapshotRead"]:
        """The response shape of a stored snapshot, or None without one."""
        if snapshot is None:
            return None
        fields = snapshot.model_dump()
        fields["target_date_resolution"] = read_resolution(snapshot.target_date, snapshot.target_date_resolution)
        fields["status"] = normalise_project_status(snapshot.status) if snapshot.status else None
        return cls.model_validate(fields)


class ProjectUpdateRead(BaseModel):
    """One project update as the API returns it.

    `can_edit` says whether this caller may edit or delete it, which is its
    author, a workspace admin or an admin of one of the project's teams, so a
    client draws the menu without repeating the rule. `reactions` and
    `comment_count` summarise the update's thread so the feed draws the reaction
    bar and the replies toggle without a read per card.

    `snapshot` and `previous_snapshot` are what the progress report diffs: the
    project when this update was posted, and when the one before it was. A null
    `snapshot` is an update posted before reports existed, which shows none,
    and a null `previous_snapshot` beside a snapshot is a first update, whose
    report is a baseline. `hide_details` is the author's choice to hide it.
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
    reactions: list[ReactionGroupRead] = Field(default_factory=list)
    comment_count: int = 0
    snapshot: Optional[ProjectUpdateSnapshotRead] = None
    previous_snapshot: Optional[ProjectUpdateSnapshotRead] = None
    hide_details: bool = False

    @classmethod
    def from_row(
        cls,
        update: ProjectUpdateRow,
        *,
        can_edit: bool,
        reactions: Optional[list[ReactionGroupRead]] = None,
        comment_count: int = 0,
    ) -> "ProjectUpdateRead":
        """Build the response shape from a stored update row and its thread summary."""
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
            reactions=reactions or [],
            comment_count=comment_count,
            snapshot=ProjectUpdateSnapshotRead.from_snapshot(update.snapshot),
            previous_snapshot=ProjectUpdateSnapshotRead.from_snapshot(update.previous_snapshot),
            hide_details=update.hide_details,
        )


ProjectUpdateListRead = cursor_page(ProjectUpdateRead, "updates", model_name="ProjectUpdateListRead")
"""The body the project update feed answers with, items under `updates`, newest first."""

ProjectActivityKindField = Literal[
    "created",
    "field_changed",
    "milestone_added",
    "milestone_removed",
    "milestone_changed",
    "milestone_converted",
    "converted_from_milestone",
    "link_added",
    "link_removed",
    "link_changed",
    "archived",
    "unarchived",
]

PROJECT_ACTIVITY_DEFAULT_LIMIT = 50
"""How many activity rows one page of a project's feed holds when the caller names no limit."""


class ProjectActivityRead(BaseModel):
    """One recorded change to a project as the API returns it.

    `from` and `to` are the wire names the issue activity uses, aliased off the
    stored `from_value` and `to_value` because `from` is a Python keyword. A
    milestone row carries the milestone's id and names it in `to`, or in `from`
    once removed. A Resources link row does the same with the link's id and its
    title or hostname; a `link_changed` row names the moved property in `field`.
    """

    activity_id: str
    project_id: str
    actor_id: str
    kind: ProjectActivityKindField
    field: Optional[str] = None
    from_: Any = Field(default=None, alias="from")
    to: Any = None
    milestone_id: Optional[str] = None
    link_id: Optional[str] = None
    source: Optional[ChangeSource] = None
    created_at: datetime

    model_config = {"populate_by_name": True}

    @classmethod
    def from_row(cls, row: ProjectActivityRow) -> "ProjectActivityRead":
        """Build the response shape from a stored project activity row."""
        return cls(
            activity_id=row.activity_id,
            project_id=row.project_id,
            actor_id=row.actor_id,
            kind=row.event,  # pyright: ignore[reportArgumentType]
            field=row.field,
            **{"from": row.from_value},
            to=row.to_value,
            milestone_id=row.milestone_id,
            link_id=row.link_id,
            source=row.source,  # pyright: ignore[reportArgumentType]
            created_at=row.created_at,
        )


ProjectActivityListRead = cursor_page(ProjectActivityRead, "activity", model_name="ProjectActivityListRead")
"""The body the project activity feed answers with, items under `activity`, newest first."""


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
    measure: ProgressMeasureField = Field(
        default="issues", description="The unit `progress` reads in, points when a team on it estimates"
    )
    progress: CountsRead = Field(
        default_factory=CountsRead, description="The buckets scope and completion are measured by, in `measure`"
    )
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
            measure=milestone.measure,
            progress=CountsRead.from_counts(milestone.progress),
            status_counts=dict(milestone.status_counts),
            created_by=milestone.created_by,
            created_at=milestone.created_at,
            updated_at=milestone.updated_at,
        )


class MilestoneConversionRead(BaseModel):
    """What converting a milestone into a project answers with.

    `project` is the new project and `moved_issue_ids` the issues that left the
    milestone for it, oldest first. The milestone itself is gone.
    """

    project: ProjectRead
    moved_issue_ids: list[str] = Field(default_factory=list)


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
    target_date_resolution: Optional[DateResolution] = Field(
        default=None, description="How wide a project's target date is; a cycle's end is always a day"
    )
    start_date_resolution: Optional[DateResolution] = Field(
        default=None, description="How wide a project's start date is; a cycle's start is always a day"
    )
    status: str
    status_id: Optional[str] = Field(default=None, description="A project's workspace project status, null on a cycle")
    icon: Optional[str] = None
    color: Optional[str] = None
    health: Optional[str] = None
    priority: Optional[str] = None
    counts: CountsRead
    measure: ProgressMeasureField = Field(
        default="issues", description="The unit `progress` reads in, points when a team on it estimates"
    )
    progress: CountsRead = Field(
        default_factory=CountsRead, description="The buckets scope and completion are measured by, in `measure`"
    )

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
            target_date_resolution="day",
            start_date_resolution="day",
            status=cycle.status(today),
            counts=CountsRead.from_counts(cycle.counts),
            progress=CountsRead.from_counts(cycle.counts),
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
            target_date_resolution=read_resolution(project.target_date, project.target_date_resolution),
            start_date_resolution=read_resolution(project.start_date, project.start_date_resolution),
            status=project.status,
            status_id=project.effective_status_id,
            icon=project.icon,
            color=project.color,
            health=project.health,
            priority=project.priority,
            counts=CountsRead.from_counts(project.counts),
            measure=project.measure,
            progress=CountsRead.from_counts(project.progress),
        )


RoadmapListRead = cursor_page(RoadmapEntryRead, "entries", model_name="RoadmapListRead")
"""The body the roadmap route answers with, items under `entries`."""


class HealthBreakdownRead(BaseModel):
    """How many of an initiative's visible projects report each health."""

    on_track: int = 0
    at_risk: int = 0
    off_track: int = 0
    none: int = 0


INITIATIVE_TEAM_HELP = (
    "The lead team, by id; its page lists the initiative, and a private team's initiative is seen only by its members"
)


class InitiativeCreate(BaseModel):
    """The body `POST /api/workspaces/{workspace_id}/initiatives` takes."""

    name: str = Field(min_length=1, max_length=NAME_MAX)
    description: Optional[str] = None
    owner_id: Optional[str] = Field(default=None, min_length=1)
    team_id: Optional[str] = Field(default=None, min_length=1, description=INITIATIVE_TEAM_HELP)
    status: InitiativeStatusField = "planned"
    health: Optional[ProjectHealthField] = None
    start_date: Optional[str] = None
    start_date_resolution: Optional[DateResolution] = Field(default=None, description=START_RESOLUTION_HELP)
    target_date: Optional[str] = None
    target_date_resolution: Optional[DateResolution] = Field(default=None, description=TARGET_RESOLUTION_HELP)
    update_interval_days: Optional[int] = None
    parent_initiative_id: Optional[str] = Field(
        default=None, min_length=1, description="The initiative this one sits under as a sub-initiative"
    )

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

    @model_validator(mode="after")
    def widen_dates(self) -> "InitiativeCreate":
        """Move each coarse date to the edge of its period and hold the start no later than the target."""
        start = _settle_resolution(self.start_date, self.start_date_resolution, "start", "start_date")
        if start != self.start_date:
            self.start_date = start
        target = _settle_resolution(self.target_date, self.target_date_resolution, "end", "target_date")
        if target != self.target_date:
            self.target_date = target
        _check_order(self.start_date, self.target_date, "target_date")
        return self


class InitiativeUpdate(BaseModel):
    """The body an initiative patch takes; null clears the description, owner, team, health, date, cadence or parent.

    `sort_order` is the initiative's manual position, a base 62 fractional key
    shared by every viewer, so a drag rewrites only the initiative moved.
    """

    name: Optional[str] = Field(default=None, min_length=1, max_length=NAME_MAX)
    description: Optional[str] = None
    owner_id: Optional[str] = Field(default=None, min_length=1)
    team_id: Optional[str] = Field(
        default=None, min_length=1, description=f"{INITIATIVE_TEAM_HELP}; null makes it workspace level"
    )
    status: Optional[InitiativeStatusField] = None
    health: Optional[ProjectHealthField] = None
    start_date: Optional[str] = None
    start_date_resolution: Optional[DateResolution] = Field(
        default=None, description=f"{START_RESOLUTION_HELP}; set alone it widens the stored date"
    )
    target_date: Optional[str] = None
    target_date_resolution: Optional[DateResolution] = Field(
        default=None, description=f"{TARGET_RESOLUTION_HELP}; set alone it widens the stored date"
    )
    update_interval_days: Optional[int] = None
    parent_initiative_id: Optional[str] = Field(
        default=None, min_length=1, description="The initiative to nest this one under; null makes it top level"
    )
    sort_order: Optional[str] = Field(
        default=None, description="The manual position, a base 62 fractional key shared by every viewer"
    )

    @field_validator("update_interval_days")
    @classmethod
    def check_update_interval(cls, value: Optional[int]) -> Optional[int]:
        """Hold the update cadence to the allowed options; null returns it to the workspace default."""
        return check_interval(value)

    @field_validator("sort_order")
    @classmethod
    def check_sort_order(cls, value: Optional[str]) -> Optional[str]:
        """Hold a manual position to the base 62 alphabet and its length cap."""
        return _check_sort_order(value)

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


class InitiativeRefRead(BaseModel):
    """An initiative named by id and name, enough to draw a breadcrumb or a link."""

    initiative_id: str
    name: str


class InitiativeRead(BaseModel):
    """One initiative as the API returns it, rolled up from the projects the caller can see.

    `project_ids` are the projects held directly, and `rollup_project_ids` adds
    every sub-initiative's below it. `counts`, `points`, `progress` and
    `project_health` roll up that whole subtree, and count only the projects
    visible to this caller, so the rollup never reveals work on a team they
    cannot read.
    """

    initiative_id: str
    workspace_id: str
    name: str
    description: Optional[str] = None
    owner_id: Optional[str] = None
    team_id: Optional[str] = Field(default=None, description="The lead team, null for a workspace level initiative")
    status: InitiativeStatusField
    health: Optional[ProjectHealthField] = None
    start_date: Optional[str] = None
    start_date_resolution: Optional[DateResolution] = Field(
        default=None,
        description="How wide the start date is, null without one; a coarse start is its period's first day",
    )
    target_date: Optional[str] = None
    target_date_resolution: Optional[DateResolution] = Field(
        default=None,
        description="How wide the target date is, null without one; a coarse target is its period's last day",
    )
    parent_initiative_id: Optional[str] = None
    ancestors: list[InitiativeRefRead] = Field(
        default_factory=list, description="The chain of parent initiatives, root first"
    )
    sub_initiative_ids: list[str] = Field(default_factory=list, description="The initiatives directly below this one")
    project_ids: list[str] = Field(default_factory=list, description="The visible projects held directly")
    rollup_project_ids: list[str] = Field(
        default_factory=list, description="The visible projects of this initiative and every sub-initiative below it"
    )
    project_count: int = Field(default=0, description="How many projects the rollup covers")
    counts: CountsRead = Field(default_factory=CountsRead)
    points: CountsRead = Field(default_factory=CountsRead)
    measure: ProgressMeasureField = Field(
        default="issues", description="The unit `progress` reads in, points when a team on it estimates"
    )
    progress: CountsRead = Field(
        default_factory=CountsRead, description="The buckets scope and completion are measured by, in `measure`"
    )
    status_counts: dict[str, int] = Field(
        default_factory=dict, description="Issues per status id across the visible projects, beside `counts`"
    )
    project_health: HealthBreakdownRead = Field(default_factory=HealthBreakdownRead)
    last_update_at: Optional[datetime] = None
    update_interval_days: int = DEFAULT_INTERVAL_DAYS
    update_interval_inherited: bool = True
    next_update_due_at: Optional[datetime] = None
    update_due_state: Optional[UpdateDueState] = None
    sort_order: Optional[str] = Field(
        default=None, description="The manual position, null when the initiative was never placed"
    )
    created_by: str
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(
        cls,
        initiative: Initiative,
        projects: list[Project],
        *,
        direct_project_ids: Optional[list[str]] = None,
        ancestors: Optional[list[Initiative]] = None,
        sub_initiative_ids: Optional[list[str]] = None,
        default_interval_days: int = DEFAULT_INTERVAL_DAYS,
        now: Optional[datetime] = None,
    ) -> "InitiativeRead":
        """Build the response shape from a stored initiative and the visible projects its subtree rolls up.

        `direct_project_ids` narrows `project_ids` to the ones the initiative
        holds itself; left out, every rolled up project counts as direct.
        """
        counts = RollupCounts()
        points = RollupCounts()
        progress = RollupCounts()
        tally = {"on_track": 0, "at_risk": 0, "off_track": 0, "none": 0}
        statuses: dict[str, int] = {}
        for project in projects:
            counts = counts.plus(project.counts)
            points = points.plus(project.points)
            progress = progress.plus(project.progress)
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
            team_id=initiative.team_id,
            status=initiative.status,  # pyright: ignore[reportArgumentType]
            health=initiative.health,  # pyright: ignore[reportArgumentType]
            start_date=initiative.start_date,
            start_date_resolution=read_resolution(initiative.start_date, initiative.start_date_resolution),
            target_date=initiative.target_date,
            target_date_resolution=read_resolution(initiative.target_date, initiative.target_date_resolution),
            parent_initiative_id=initiative.parent_initiative_id,
            ancestors=[InitiativeRefRead(initiative_id=row.initiative_id, name=row.name) for row in ancestors or []],
            sub_initiative_ids=list(sub_initiative_ids or []),
            project_ids=(
                [project.project_id for project in projects] if direct_project_ids is None else direct_project_ids
            ),
            rollup_project_ids=[project.project_id for project in projects],
            project_count=len(projects),
            counts=CountsRead.from_counts(counts),
            points=CountsRead.from_counts(points),
            measure="points" if any(project.measure == "points" for project in projects) else "issues",
            progress=CountsRead.from_counts(progress),
            status_counts=statuses,
            project_health=HealthBreakdownRead(**tally),
            last_update_at=initiative.last_update_at,
            update_interval_days=effective_interval(initiative, default_interval_days),
            update_interval_inherited=initiative.update_interval_days is None,
            next_update_due_at=next_update_due_at(initiative, default_interval_days),
            update_due_state=update_due_state(initiative, default_interval_days, now),
            sort_order=initiative.sort_order,
            created_by=initiative.created_by,
            created_at=initiative.created_at,
            updated_at=initiative.updated_at,
        )


InitiativeListRead = cursor_page(InitiativeRead, "initiatives", model_name="InitiativeListRead")
"""The body the initiative list route answers with, items under `initiatives`."""


class InitiativeProgressPointRead(BaseModel):
    """One day of an initiative's progress graph, in the series' measure."""

    date: str
    scope: float
    started: float
    completed: float


class InitiativeProgressRead(BaseModel):
    """An initiative's scope, started and completed work per day, across its whole subtree.

    Derived from the visible issues' own dates, the way a project's graph is,
    so it needs no stored history. `days` runs from `start_date` through today
    and `end_date` is where the graph's axis ends, the target date when it is
    still ahead.
    """

    initiative_id: str
    measure: ProgressMeasureField = "issues"
    start_date: str
    end_date: str
    days: list[InitiativeProgressPointRead] = Field(default_factory=list)


class InitiativeUpdateCreate(BaseModel):
    """The body `POST /api/workspaces/{workspace_id}/initiatives/{initiative_id}/updates` takes.

    `body` may be left out when `template_id` names a workspace document
    template, whose body the update then takes.
    """

    body: Optional[str] = None
    health: ProjectHealthField
    template_id: Optional[str] = None
    hide_details: bool = Field(default=False, description="Hide the progress report on this update for everyone")

    @field_validator("body")
    @classmethod
    def check_body(cls, value: Optional[str]) -> Optional[str]:
        """Hold the body to non-blank markdown under the byte cap."""
        return _check_update_body(value)


class InitiativeUpdatePatch(BaseModel):
    """The body an initiative update patch takes; any field may be left out, none cleared."""

    body: Optional[str] = None
    health: Optional[ProjectHealthField] = None
    hide_details: Optional[bool] = Field(default=None, description="Hide or show the update's progress report")

    @field_validator("body")
    @classmethod
    def check_body(cls, value: Optional[str]) -> Optional[str]:
        """Hold the body to non-blank markdown under the byte cap."""
        return _check_update_body(value)


class InitiativeUpdateSnapshotRead(BaseModel):
    """Where an initiative stood when an update was posted, as the API returns it.

    `projects_by_status` counts the rolled up projects every member can see by
    status category, and `projects_by_health` by health.
    """

    owner_id: Optional[str] = None
    owner_name: Optional[str] = None
    status: Optional[InitiativeStatusField] = None
    target_date: Optional[str] = None
    target_date_resolution: Optional[DateResolution] = None
    health: Optional[ProjectHealthField] = None
    project_count: int = 0
    projects_by_status: dict[str, int] = Field(default_factory=dict)
    projects_by_health: dict[str, int] = Field(default_factory=dict)

    @classmethod
    def from_snapshot(cls, snapshot: Optional[InitiativeUpdateSnapshot]) -> Optional["InitiativeUpdateSnapshotRead"]:
        """The response shape of a stored snapshot, or None without one."""
        if snapshot is None:
            return None
        fields = snapshot.model_dump()
        fields["target_date_resolution"] = read_resolution(snapshot.target_date, snapshot.target_date_resolution)
        return cls.model_validate(fields)


class InitiativeUpdateRead(BaseModel):
    """One initiative update as the API returns it, with this caller's edit right.

    `snapshot` and `previous_snapshot` are what the progress report diffs: the
    initiative when this update was posted, and when the one before it was.
    `report` is that diff as plain lines, empty on a first update, on one
    posted before reports existed, and when `hide_details` says its author hid it.
    """

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
    snapshot: Optional[InitiativeUpdateSnapshotRead] = None
    previous_snapshot: Optional[InitiativeUpdateSnapshotRead] = None
    hide_details: bool = False
    report: list[str] = Field(default_factory=list)

    @classmethod
    def from_row(
        cls, update: InitiativeUpdateRow, *, can_edit: bool, report: Optional[list[str]] = None
    ) -> "InitiativeUpdateRead":
        """Build the response shape from a stored update row and the report its snapshots give."""
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
            snapshot=InitiativeUpdateSnapshotRead.from_snapshot(update.snapshot),
            previous_snapshot=InitiativeUpdateSnapshotRead.from_snapshot(update.previous_snapshot),
            hide_details=update.hide_details,
            report=report or [],
        )


InitiativeUpdateListRead = cursor_page(InitiativeUpdateRead, "updates", model_name="InitiativeUpdateListRead")
"""The body the initiative update feed answers with, items under `updates`, newest first."""


PulseEventTypeField = Literal[
    "project_update", "initiative_update", "project_health", "initiative_health", "milestone_completed"
]

PulseScopeField = Literal["for_me", "popular", "recent"]


class PulseItemRead(BaseModel):
    """One Pulse entry as the API returns it.

    The project's or initiative's name, icon and colour ride along, so a feed
    renders without a read per entry. `actor_id` is null for what no person did,
    which is a milestone its last closed issue completed, and `actor_name` is
    then empty. `unread` is this caller's own state.
    """

    event_id: str
    workspace_id: str
    event_type: PulseEventTypeField
    subject_type: Literal["project", "initiative"]
    project_id: Optional[str] = None
    project_name: Optional[str] = None
    project_icon: Optional[str] = None
    project_color: Optional[str] = None
    initiative_id: Optional[str] = None
    initiative_name: Optional[str] = None
    milestone_id: Optional[str] = None
    milestone_name: Optional[str] = None
    update_id: Optional[str] = None
    body: Optional[str] = None
    health: Optional[ProjectHealthField] = None
    previous_health: Optional[ProjectHealthField] = None
    actor_id: Optional[str] = None
    actor_name: str = ""
    source: Optional[ChangeSource] = None
    created_at: datetime
    edited_at: Optional[datetime] = None
    unread: bool = False

    @classmethod
    def from_event(
        cls,
        event: PulseEvent,
        *,
        project: Optional[Project],
        initiative: Optional[Initiative],
        unread: bool,
        actor_name: str = "",
    ) -> "PulseItemRead":
        """Build the response shape from a stored event and what it is about."""
        return cls(
            event_id=event.event_id,
            workspace_id=event.workspace_id,
            event_type=event.event_type,  # pyright: ignore[reportArgumentType]
            subject_type=event.subject_type,  # pyright: ignore[reportArgumentType]
            project_id=event.project_id,
            project_name=project.name if project is not None else None,
            project_icon=project.icon if project is not None else None,
            project_color=project.color if project is not None else None,
            initiative_id=initiative.initiative_id if initiative is not None else event.initiative_id,
            initiative_name=initiative.name if initiative is not None else None,
            milestone_id=event.milestone_id,
            milestone_name=event.milestone_name,
            update_id=event.update_id,
            body=event.body,
            health=event.health,  # pyright: ignore[reportArgumentType]
            previous_health=event.previous_health,  # pyright: ignore[reportArgumentType]
            actor_id=event.actor_id or None,
            actor_name=actor_name if event.actor_id else "",
            source=event.source,  # pyright: ignore[reportArgumentType]
            created_at=event.created_at,
            edited_at=event.edited_at,
            unread=unread,
        )


PulseListRead = cursor_page(PulseItemRead, "items", model_name="PulseListRead")
"""The body the Pulse feed answers with, entries under `items`, newest first."""


class PulseCountRead(BaseModel):
    """How many of the caller's "for me" Pulse entries are unread, capped at 99."""

    unread: int


class PulseReadMarker(BaseModel):
    """When the caller's Pulse was marked read up to."""

    read_at: datetime


class PulseFollowRead(BaseModel):
    """Whether the caller follows a project or initiative in Pulse.

    `explicit` says the caller chose it; otherwise it follows from leading, being
    a member of or owning the subject, or following the project's initiative.
    """

    following: bool
    explicit: bool
