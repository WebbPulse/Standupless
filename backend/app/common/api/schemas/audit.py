"""Response schemas for the workspace audit log, shared by its route and its MCP tool."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, Field
from webbpulse.audit import AuditEvent


class AuditEventType(BaseModel):
    """One event the log can record, as a filter option."""

    key: str
    label: str


class AuditEventRead(BaseModel):
    """One audit entry: what happened, to what, by whom, through which client and from where."""

    audit_id: str
    event: str
    event_label: str
    actor_id: str
    actor_kind: str = Field(description="user, api_key, service or system.")
    actor_name: str = ""
    source: str = Field(description="The client the change came through: web, api, cli, mcp or system.")
    ip: str = ""
    amr: list[str] = Field(default_factory=list, description="How the actor last authenticated.")
    target_type: str = ""
    target_id: str = ""
    target_label: str = ""
    before: Optional[dict[str, Any]] = None
    after: Optional[dict[str, Any]] = None
    created_at: datetime

    @classmethod
    def from_event(cls, event: AuditEvent, *, label: str, actor_name: str) -> "AuditEventRead":
        """Build the response from a stored event, its label and the actor's display name."""
        return cls(
            audit_id=event.event_id,
            event=event.action,
            event_label=label,
            actor_id=event.actor.id,
            actor_kind=event.actor.kind,
            actor_name=actor_name,
            source=event.actor.source,
            ip=event.actor.ip,
            amr=list(event.actor.amr),
            target_type=event.target.type,
            target_id=event.target.id,
            target_label=event.target.label,
            before=dict(event.before) if event.before is not None else None,
            after=dict(event.after) if event.after is not None else None,
            created_at=event.occurred_at,
        )


class AuditLogRead(BaseModel):
    """One page of the audit log, newest first, and whether the plan includes it."""

    events: list[AuditEventRead]
    next_cursor: Optional[str] = None
    available: bool = Field(description="Whether the workspace's plan includes the audit log.")
    event_types: list[AuditEventType]
