"""The shapes the Jira import routes take and answer."""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

from app.domains.integrations.jira_import import Credentials, ProjectChoice, ProjectPreview

SITE_DESCRIPTION = "The Jira Cloud site, such as https://your-team.atlassian.net."

EMAIL_DESCRIPTION = "The email of the Atlassian account the API token belongs to. Used for this request or import only."

TOKEN_DESCRIPTION = "An Atlassian API token. Used for this request or import only and never stored after it."

KEY_PATTERN = r"^[A-Za-z][A-Za-z0-9_]{0,49}$"


class JiraCredentialsRequest(BaseModel):
    """A Jira site and the account email and API token to read it with, used for this request only."""

    site_url: str = Field(min_length=1, max_length=200, description=SITE_DESCRIPTION)
    email: str = Field(min_length=3, max_length=320, description=EMAIL_DESCRIPTION)
    token: str = Field(min_length=1, max_length=500, description=TOKEN_DESCRIPTION)

    def credentials(self) -> Credentials:
        """The email and token as the importer takes them."""
        return Credentials(email=self.email.strip(), token=self.token.strip())


class JiraProjectRead(BaseModel):
    """One project the account can browse on the Jira site."""

    id: str
    key: str
    name: str
    project_type: Optional[str] = None
    team_managed: bool
    archived: bool
    url: Optional[str] = None


class JiraProjectListRead(BaseModel):
    """Every project the account can browse on the Jira site."""

    site_url: str
    items: list[JiraProjectRead]


class JiraProjectChoice(BaseModel):
    """One Jira project or JQL filter to import, the Standupless team it goes into, and how its issues map."""

    project_key: Optional[str] = Field(default=None, pattern=KEY_PATTERN)
    jql: Optional[str] = Field(
        default=None,
        max_length=2000,
        description="A JQL filter, alone or narrowing the project. Any ORDER BY is dropped.",
    )
    team_id: str = Field(min_length=1, max_length=64)
    epics_as: Literal["projects", "parents"] = Field(
        default="projects",
        description="Whether each epic becomes a Standupless project, or an issue its children are sub-issues of.",
    )
    statuses: dict[str, str] = Field(
        default_factory=dict,
        max_length=200,
        description=(
            "Jira status name to the id of the team status it lands in. Anything unmapped lands in the status of "
            "the same name, else the one its Jira status category means, else the team's default."
        ),
    )

    def choice(self) -> ProjectChoice:
        """The choice as the importer takes it."""
        return ProjectChoice(
            team_id=self.team_id,
            project_key=self.project_key or "",
            jql=self.jql or "",
            epics_as=self.epics_as,
            statuses=dict(self.statuses),
        )


class JiraImportRequest(JiraCredentialsRequest):
    """A Jira import or its preview: the site, the credentials, sealed while the job runs, and the projects."""

    projects: list[JiraProjectChoice] = Field(min_length=1, max_length=50)


class JiraStatusPlanRead(BaseModel):
    """Where one Jira status lands."""

    source: str
    category: Optional[str] = Field(default=None, description="Jira's status category: new, indeterminate or done.")
    status_id: str
    status_name: str


class JiraProjectPreviewRead(BaseModel):
    """What importing one Jira project or filter would do."""

    project_key: Optional[str] = None
    jql: Optional[str] = None
    name: str
    team_id: str
    epics_as: str
    issue_count: int = Field(description="How many issues the project or filter holds, as Jira counts them.")
    done_count: int
    estimate_field: Optional[str] = Field(default=None, description="The story point field estimates come from.")
    sprint_field: Optional[str] = Field(default=None, description="The sprint field cycles come from.")
    statuses: list[JiraStatusPlanRead]

    @classmethod
    def from_preview(cls, preview: ProjectPreview) -> "JiraProjectPreviewRead":
        """One project's preview as the API shows it."""
        mapping = preview.mapping
        return cls(
            project_key=mapping.project_key or None,
            jql=mapping.jql or None,
            name=mapping.name,
            team_id=mapping.team_id,
            epics_as=mapping.epics_as,
            issue_count=preview.issue_count,
            done_count=preview.done_count,
            estimate_field=preview.estimate_field,
            sprint_field=preview.sprint_field,
            statuses=[
                JiraStatusPlanRead(
                    source=plan.source,
                    category=plan.category or None,
                    status_id=plan.status_id,
                    status_name=plan.status_name,
                )
                for plan in preview.statuses
            ],
        )


class JiraImportPreviewRead(BaseModel):
    """What a Jira import would do, project by project, read from Jira without writing anything."""

    site_url: str
    projects: list[JiraProjectPreviewRead]
