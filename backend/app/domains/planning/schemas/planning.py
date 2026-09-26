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

from app.common.db.dynamo.planning import Cycle, Project, ProjectMilestone, RollupCounts, normalise_project_status

ProjectStatusField = Literal["backlog", "planned", "in_progress", "paused", "completed", "canceled"]

CycleStatusField = Literal["upcoming", "active", "completed", "cancelled"]

RoadmapKindField = Literal["cycle", "project"]

NAME_MAX = 80

GOAL_MAX = 2000

DESCRIPTION_MAX_BYTES = 8192

TEAMS_MAX = 20

DEFAULT_LIMIT = 50

MAX_LIMIT = 100

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
    cancelled: bool
    status: CycleStatusField
    counts: CountsRead
    created_by: str
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, cycle: Cycle, today: Optional[str] = None) -> "CycleRead":
        """Build the response shape from a stored cycle row.

        `today` is threaded through rather than read inside, so a test can pin the
        day a status is derived against without freezing the clock.
        """
        return cls(
            cycle_id=cycle.cycle_id,
            workspace_id=cycle.workspace_id,
            team_id=cycle.team_id,
            name=cycle.name,
            start_date=cycle.start_date,
            end_date=cycle.end_date,
            goal=cycle.goal,
            cancelled=cycle.cancelled,
            status=cycle.status(today),  # pyright: ignore[reportArgumentType]
            counts=CountsRead.from_counts(cycle.counts),
            created_by=cycle.created_by,
            created_at=cycle.created_at,
            updated_at=cycle.updated_at,
        )


CycleListRead = cursor_page(CycleRead, "cycles", model_name="CycleListRead")
"""The body the cycle list route answers with, items under `cycles`."""


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
    """

    team_id: Optional[str] = Field(default=None, min_length=1)
    team_ids: Optional[list[str]] = Field(default=None, min_length=1, max_length=TEAMS_MAX)
    name: Optional[str] = Field(default=None, min_length=1, max_length=NAME_MAX)
    description: Optional[str] = None
    lead_id: Optional[str] = Field(default=None, min_length=1)
    start_date: Optional[str] = None
    target_date: Optional[str] = None
    status: Optional[ProjectStatusField] = None

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
    counts: CountsRead
    created_by: str
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, project: Project, visible_team_ids: Optional[list[str]] = None) -> "ProjectRead":
        """Build the response shape from a stored project row.

        `visible_team_ids` is the caller's own view of the row's teams; the route
        has already decided the caller sees at least one, so the list is never
        empty when it is passed.
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
            counts=CountsRead.from_counts(project.counts),
            created_by=project.created_by,
            created_at=project.created_at,
            updated_at=project.updated_at,
        )


ProjectListRead = cursor_page(ProjectRead, "projects", model_name="ProjectListRead")
"""The body the project list route answers with, items under `projects`."""


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
    """One project milestone as the API returns it, with its progress counts."""

    milestone_id: str
    project_id: str
    workspace_id: str
    name: str
    description: Optional[str] = None
    target_date: Optional[str] = None
    sort_order: str
    counts: CountsRead
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
            created_by=milestone.created_by,
            created_at=milestone.created_at,
            updated_at=milestone.updated_at,
        )


MilestoneListRead = cursor_page(MilestoneRead, "milestones", model_name="MilestoneListRead")
"""The body the milestone list route answers with, items under `milestones`."""


class RoadmapEntryRead(BaseModel):
    """One cycle or project as the roadmap draws it.

    A projection rather than the full row: the timeline renders a bar and a count,
    and a reader wanting the rest has the entity's own route.
    """

    kind: RoadmapKindField
    id: str
    team_id: str
    team_ids: list[str]
    name: str
    target_date: Optional[str] = None
    start_date: Optional[str] = None
    status: str
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
            counts=CountsRead.from_counts(project.counts),
        )


RoadmapListRead = cursor_page(RoadmapEntryRead, "entries", model_name="RoadmapListRead")
"""The body the roadmap route answers with, items under `entries`."""
