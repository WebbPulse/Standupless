"""The shapes the Asana import routes take and answer."""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field

from app.domains.integrations.asana_import import ProjectChoice, ProjectPreview

TOKEN_DESCRIPTION = "An Asana personal access token. Used for this request or import only and never stored after it."

GID_PATTERN = r"^[0-9]{1,32}$"


class AsanaTokenRequest(BaseModel):
    """An Asana personal access token, used for this request only and never stored."""

    token: str = Field(min_length=1, max_length=200, description=TOKEN_DESCRIPTION)


class AsanaProjectRead(BaseModel):
    """One project the token can read in Asana."""

    gid: str
    name: str
    workspace_gid: str
    workspace_name: str
    team_name: Optional[str] = None
    archived: bool
    completed: bool
    url: Optional[str] = None


class AsanaProjectListRead(BaseModel):
    """Every project the token can read across its Asana workspaces."""

    items: list[AsanaProjectRead]


class AsanaProjectChoice(BaseModel):
    """One Asana project to import, the Standupless team it goes into, and how its tasks map."""

    project_gid: str = Field(pattern=GID_PATTERN)
    team_id: str = Field(min_length=1, max_length=64)
    create_project: bool = Field(default=True, description="Also write the Asana project as a Standupless project.")
    status_field_gid: Optional[str] = Field(
        default=None,
        pattern=GID_PATTERN,
        description="A single choice custom field whose options set the status, instead of the task's section.",
    )
    statuses: dict[str, str] = Field(
        default_factory=dict,
        max_length=200,
        description=(
            "Section or option name to the id of the team status it lands in. Anything unmapped lands in the "
            "status of the same name, else the status its name means, else the team's default."
        ),
    )

    def choice(self) -> ProjectChoice:
        """The choice as the importer takes it."""
        return ProjectChoice(
            project_gid=self.project_gid,
            team_id=self.team_id,
            create_project=self.create_project,
            status_field_gid=self.status_field_gid or "",
            statuses=dict(self.statuses),
        )


class AsanaImportRequest(BaseModel):
    """An Asana import or its preview: the token, sealed while the job runs and deleted after, and the projects."""

    token: str = Field(min_length=1, max_length=200, description=TOKEN_DESCRIPTION)
    projects: list[AsanaProjectChoice] = Field(min_length=1, max_length=50)


class AsanaStatusPlanRead(BaseModel):
    """Where one section or option of a project lands."""

    source: str
    status_id: str
    status_name: str


class AsanaStatusFieldRead(BaseModel):
    """One single choice custom field of a project that could set the status instead of the section."""

    gid: str
    name: str
    options: list[str]


class AsanaProjectPreviewRead(BaseModel):
    """What importing one Asana project would do."""

    project_gid: str
    name: str
    team_id: str
    create_project: bool
    status_field_gid: Optional[str] = None
    status_field_name: Optional[str] = None
    task_count: int = Field(description="How many tasks the project holds, as Asana counts them.")
    completed_count: int
    sections: list[str]
    status_fields: list[AsanaStatusFieldRead]
    statuses: list[AsanaStatusPlanRead]

    @classmethod
    def from_preview(cls, preview: ProjectPreview) -> "AsanaProjectPreviewRead":
        """One project's preview as the API shows it."""
        mapping = preview.mapping
        return cls(
            project_gid=mapping.project_gid,
            name=mapping.name,
            team_id=mapping.team_id,
            create_project=mapping.create_project,
            status_field_gid=mapping.status_field_gid or None,
            status_field_name=mapping.status_field_name or None,
            task_count=preview.task_count,
            completed_count=preview.completed_count,
            sections=preview.sections,
            status_fields=[AsanaStatusFieldRead(**entry) for entry in preview.status_fields],
            statuses=[
                AsanaStatusPlanRead(source=plan.source, status_id=plan.status_id, status_name=plan.status_name)
                for plan in preview.statuses
            ],
        )


class AsanaImportPreviewRead(BaseModel):
    """What an Asana import would do, project by project, read from Asana without writing anything."""

    projects: list[AsanaProjectPreviewRead]
