"""Request and response schemas for the planning domain.

Every list body is an object with one plural key beside `next_cursor`, matching the
M1 to M3 domains and the contract, which is what `webbpulse.http.cursor_page`
builds. Validation that needs no table read happens here, so a malformed body is a
422 naming the field; anything needing the team's own rows is decided in the
route, because the schema cannot read.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator
from webbpulse.http import cursor_page

from app.common.db.dynamo.planning import Cycle, Project, RollupCounts

ProjectStatusField = Literal["planned", "in_progress", "done"]

CycleStatusField = Literal["upcoming", "active", "completed", "cancelled"]

RoadmapKindField = Literal["cycle", "project"]

NAME_MAX = 80

GOAL_MAX = 2000

DESCRIPTION_MAX_BYTES = 8192

DEFAULT_LIMIT = 50

MAX_LIMIT = 100


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


def _check_order(start_date: Optional[str], end_date: Optional[str]) -> None:
    """Refuse an end date before the start date, when both are present."""
    if start_date and end_date and end_date < start_date:
        raise ValueError("end_date must not be before start_date")


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
    """The body `POST /api/workspaces/{workspace_id}/projects` takes."""

    team_id: str = Field(min_length=1)
    name: str = Field(min_length=1, max_length=NAME_MAX)
    description: Optional[str] = None
    target_date: Optional[str] = None
    status: ProjectStatusField = "planned"

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
    def check_target(cls, value: Optional[str]) -> Optional[str]:
        """Hold the target date to the contract's format."""
        return _check_date(value)


class ProjectUpdate(BaseModel):
    """The body a project patch takes.

    `team_id` is required rather than patchable, for the same reason a cycle's is.
    """

    team_id: str = Field(min_length=1)
    name: Optional[str] = Field(default=None, min_length=1, max_length=NAME_MAX)
    description: Optional[str] = None
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

    @field_validator("target_date")
    @classmethod
    def check_target(cls, value: Optional[str]) -> Optional[str]:
        """Hold the target date to the contract's format."""
        return _check_date(value)


class ProjectRead(BaseModel):
    """One project as the API returns it, with its status stored rather than derived."""

    project_id: str
    workspace_id: str
    team_id: str
    name: str
    description: Optional[str] = None
    target_date: Optional[str] = None
    status: ProjectStatusField
    counts: CountsRead
    created_by: str
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, project: Project) -> "ProjectRead":
        """Build the response shape from a stored project row."""
        return cls(
            project_id=project.project_id,
            workspace_id=project.workspace_id,
            team_id=project.team_id,
            name=project.name,
            description=project.description,
            target_date=project.target_date,
            status=project.status,  # pyright: ignore[reportArgumentType]
            counts=CountsRead.from_counts(project.counts),
            created_by=project.created_by,
            created_at=project.created_at,
            updated_at=project.updated_at,
        )


ProjectListRead = cursor_page(ProjectRead, "projects", model_name="ProjectListRead")
"""The body the project list route answers with, items under `projects`."""


class RoadmapEntryRead(BaseModel):
    """One cycle or project as the roadmap draws it.

    A projection rather than the full row: the timeline renders a bar and a count,
    and a reader wanting the rest has the entity's own route.
    """

    kind: RoadmapKindField
    id: str
    team_id: str
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
            name=cycle.name,
            target_date=cycle.end_date,
            start_date=cycle.start_date,
            status=cycle.status(today),
            counts=CountsRead.from_counts(cycle.counts),
        )

    @classmethod
    def from_project(cls, project: Project) -> "RoadmapEntryRead":
        """One project as a roadmap entry, drawn at its target date."""
        return cls(
            kind="project",
            id=project.project_id,
            team_id=project.team_id,
            name=project.name,
            target_date=project.target_date,
            start_date=None,
            status=project.status,
            counts=CountsRead.from_counts(project.counts),
        )


RoadmapListRead = cursor_page(RoadmapEntryRead, "entries", model_name="RoadmapListRead")
"""The body the roadmap route answers with, items under `entries`."""
