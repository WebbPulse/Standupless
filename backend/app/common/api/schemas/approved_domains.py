"""Request and response schemas for approved email domains and joining by domain."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field

from app.common.db.dynamo.memberships import ApprovedDomain
from app.common.db.dynamo.workspaces import Workspace
from app.common.icons import icon_url


class ApprovedDomainCreate(BaseModel):
    """The body `POST /api/workspaces/{workspace_id}/approved-domains` takes."""

    domain: str = Field(
        min_length=1,
        max_length=254,
        description="The email domain to approve, such as example.com. It must be the caller's own verified domain.",
    )


class ApprovedDomainRead(BaseModel):
    """One approved email domain."""

    domain: str
    added_by: str
    added_at: datetime

    @classmethod
    def from_row(cls, row: ApprovedDomain) -> "ApprovedDomainRead":
        """Build the response from the stored row."""
        return cls(domain=row.domain, added_by=row.added_by, added_at=row.added_at)


class ApprovedDomainListRead(BaseModel):
    """Every approved email domain of one workspace."""

    domains: list[ApprovedDomainRead]


class JoinableWorkspaceRead(BaseModel):
    """A workspace the caller may join through their verified email domain."""

    id: str
    name: str
    slug: str
    icon_url: Optional[str] = None
    accent_color: Optional[str] = None
    domain: str = Field(description="The approved domain that lets the caller join.")

    @classmethod
    def from_row(cls, workspace: Workspace, domain: str) -> "JoinableWorkspaceRead":
        """Build the response from a stored workspace and the domain that admits the caller."""
        return cls(
            id=workspace.id,
            name=workspace.name,
            slug=workspace.slug,
            icon_url=icon_url(workspace.icon_key),
            accent_color=workspace.accent_color,
            domain=domain,
        )


class JoinableWorkspaceListRead(BaseModel):
    """Every workspace the caller may join without an invite."""

    workspaces: list[JoinableWorkspaceRead]
