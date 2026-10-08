"""Request and response schemas for the workspace export routes."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field

from app.common.workspace_export import Download, ExportJob, ExportStatus


class WorkspaceExportCreate(BaseModel):
    """The body `POST /api/workspaces/{workspace_id}/exports` takes."""

    include_emails: bool = Field(
        default=True,
        description="Whether member emails are exported in full. False masks them even for an admin.",
    )


class WorkspaceExportRead(BaseModel):
    """One export job, with a short-lived download link once it is ready."""

    export_id: str
    workspace_id: str
    status: ExportStatus
    format_version: int
    requested_by: str
    emails_masked: bool
    created_at: datetime
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    expires_at: Optional[datetime] = None
    size_bytes: int = 0
    counts: dict[str, int] = Field(default_factory=dict)
    error: Optional[str] = None
    download_url: Optional[str] = None
    download_expires_at: Optional[datetime] = None

    @classmethod
    def from_job(cls, job: ExportJob, download: Download | None = None) -> "WorkspaceExportRead":
        """One job as the API shows it, without the requester's authorization snapshot."""
        return cls(
            **job.model_dump(include=set(cls.model_fields) & set(ExportJob.model_fields)),
            download_url=download.url if download is not None else None,
            download_expires_at=download.expires_at if download is not None else None,
        )


class WorkspaceExportListRead(BaseModel):
    """A workspace's most recent exports, newest first."""

    items: list[WorkspaceExportRead]
