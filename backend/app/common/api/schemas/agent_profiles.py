"""Schemas for a person's private agent profiles, shared by the account routes, the CLI and the MCP tools."""

from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field

ProfileRoot = Literal["home", "project", "memory"]
"""Which directory on a machine a profile file's path is relative to."""


class AgentProfileFile(BaseModel):
    """One file of a profile: the root it lives under, its path relative to that root, and its text."""

    root: ProfileRoot = Field(
        description="home is the home directory, project the project checkout, memory Claude Code's memory "
        "folder for that project."
    )
    path: str = Field(description="The file's path relative to its root, with forward slashes.")
    content: str


class AgentProfileRead(BaseModel):
    """One profile as its owner lists it."""

    name: str
    latest_version: int
    file_count: int
    total_bytes: int
    note: str = ""
    created_at: datetime
    updated_at: datetime


class AgentProfileListRead(BaseModel):
    """Every profile the caller keeps, in name order, with the limits a save is held to."""

    profiles: list[AgentProfileRead]
    max_profiles: int
    versions_kept: int


class AgentProfileVersionRead(BaseModel):
    """One kept version of a profile."""

    version: int
    note: str = ""
    file_count: int
    total_bytes: int
    sha256: str = Field(description="The digest of the version's files, equal for identical contents.")
    source: str = Field(description="The client the version was saved through, such as mcp.")
    created_at: datetime
    latest: bool


class AgentProfileVersionListRead(BaseModel):
    """A profile's kept versions, newest first."""

    name: str
    latest_version: int
    versions: list[AgentProfileVersionRead]
    versions_kept: int


class AgentProfileSnapshotRead(BaseModel):
    """One version's files, and what each root means on the machine restoring them."""

    name: str
    version: int
    latest_version: int
    note: str = ""
    sha256: str
    created_at: datetime
    files: list[AgentProfileFile]
    roots: dict[str, str] = Field(description="What each root maps to on the machine the files are written on.")


class AgentProfileSaveRead(BaseModel):
    """What a save stored: the profile after it, and whether the files matched the latest version."""

    profile: AgentProfileRead
    version: int
    unchanged: bool = Field(description="True when the files matched the latest version, so no version was added.")
    pruned_versions: list[int] = Field(default_factory=list)


class AgentProfileEventRead(BaseModel):
    """One entry of the caller's own agent profile trail."""

    audit_id: str
    event: str
    event_label: str
    profile: str
    version: Optional[int] = None
    source: str
    ip: str = ""
    created_at: datetime


class AgentProfileActivityRead(BaseModel):
    """One page of the caller's agent profile trail, newest first."""

    events: list[AgentProfileEventRead]
    next_cursor: Optional[str] = None
