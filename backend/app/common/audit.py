"""Record workspace audit events from any domain, best effort.

Every write path that changes who is in a workspace, how they sign in, which
credentials reach it, what leaves it, or how it is configured calls `record` after
the change has landed. Recording never fails the change it describes: a bundle
with no audit grant skips it and a failed write is logged, because refusing a
member removal over a log row would be the worse outcome.

The event names are a fixed catalogue so the settings page and the MCP tool can
offer them as a filter.
"""

from __future__ import annotations

import csv
import io
import json
import logging
from datetime import datetime
from typing import Any, Mapping

from webbpulse.dynamodb import encode_start_key

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.pagination import resume_key
from app.common.api.schemas.audit import AuditEventRead, AuditEventType, AuditLogRead
from app.common.db.dynamo.audit import AuditEvent
from app.common.plan_features import Feature, enforce_feature, has_feature

_log = logging.getLogger(__name__)

SYSTEM_ACTOR = "system"

MAX_PAGE = 100

MAX_CSV_ROWS = 5000
"""The most rows one CSV download carries; a narrower date range reaches older ones."""

EVENTS: dict[str, str] = {
    "member.joined": "Member joined",
    "member.removed": "Member removed",
    "member.left": "Member left",
    "member.role_changed": "Member role changed",
    "invite.created": "Invite sent",
    "invite.revoked": "Invite revoked",
    "auth_policy.updated": "Authentication policy changed",
    "api_key.created": "API key created",
    "api_key.revoked": "API key revoked",
    "connected_app.authorized": "Connected app authorized",
    "connected_app.revoked": "Connected app revoked",
    "export.started": "Workspace export started",
    "workspace.updated": "Workspace settings changed",
    "workspace.deletion_scheduled": "Workspace deletion scheduled",
    "workspace.deletion_cancelled": "Workspace deletion cancelled",
    "plan.changed": "Plan changed",
    "team.created": "Team created",
    "team.deleted": "Team deleted",
}
"""Every event the log records, with the label the settings page shows."""

EVENT_TYPES: tuple[str, ...] = tuple(EVENTS)


def _write(repositories: Repositories, event: AuditEvent) -> AuditEvent | None:
    """Store one event unless this bundle cannot, never raising."""
    if event.event not in EVENTS:
        raise ValueError(f"unknown audit event {event.event!r}")
    if repositories.is_read_only("audit"):
        _log.info("audit_skipped", extra={"event": event.event, "workspace_id": event.workspace_id})
        return None
    try:
        return repositories.audit.record(event)
    except Exception:
        _log.exception("audit_write_failed", extra={"event": event.event, "workspace_id": event.workspace_id})
        return None


def record(
    repositories: Repositories,
    context: AuthzContext,
    event: str,
    *,
    target_type: str = "",
    target_id: str = "",
    target_label: str = "",
    before: Mapping[str, Any] | None = None,
    after: Mapping[str, Any] | None = None,
    workspace_id: str | None = None,
) -> AuditEvent | None:
    """Record one event done by the caller of a request, with how they signed in and from where."""
    return _write(
        repositories,
        AuditEvent(
            workspace_id=workspace_id or context.workspace_id,
            event=event,
            actor_id=context.user_id,
            actor_kind=context.actor.value,
            source=context.source,
            ip=context.ip,
            amr=list(context.amr),
            target_type=target_type,
            target_id=target_id,
            target_label=target_label,
            before=dict(before) if before is not None else None,
            after=dict(after) if after is not None else None,
        ),
    )


def record_system(
    repositories: Repositories,
    workspace_id: str,
    event: str,
    *,
    actor_id: str = SYSTEM_ACTOR,
    actor_kind: str = "system",
    source: str = "system",
    target_type: str = "",
    target_id: str = "",
    target_label: str = "",
    before: Mapping[str, Any] | None = None,
    after: Mapping[str, Any] | None = None,
) -> AuditEvent | None:
    """Record one event no signed-in request carried, such as a billing webhook or an OAuth consent."""
    return _write(
        repositories,
        AuditEvent(
            workspace_id=workspace_id,
            event=event,
            actor_id=actor_id,
            actor_kind=actor_kind,
            source=source,
            target_type=target_type,
            target_id=target_id,
            target_label=target_label,
            before=dict(before) if before is not None else None,
            after=dict(after) if after is not None else None,
        ),
    )


def changed(before: Mapping[str, Any], after: Mapping[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """Only the fields that differ, as the before and after an event carries."""
    keys = [key for key in after if before.get(key) != after.get(key)]
    return {key: before.get(key) for key in keys}, {key: after.get(key) for key in keys}


def cursor_scope(workspace_id: str) -> str:
    """The scope an audit log cursor is minted under, so it resumes only this workspace's log."""
    return f"audit:{workspace_id}"


def _actor_names(repositories: Repositories, rows: list[AuditEvent]) -> dict[str, str]:
    """Display names for the people behind a page of rows, empty where this bundle has no users."""
    if "users" not in repositories.repository_names:
        return {}
    from app.common.api.schemas.workspaces import display_name_for

    ids = sorted({row.actor_id for row in rows if row.actor_kind != "system"})
    users = repositories.users.get_many(ids) if ids else {}
    return {user_id: display_name_for(user) for user_id, user in users.items()}


def list_page(
    repositories: Repositories,
    workspace_id: str,
    *,
    actor_id: str | None = None,
    event: str | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
    limit: int = 50,
    cursor: str | None = None,
) -> AuditLogRead:
    """One page of the audit log for an admin, or an empty page when the plan leaves it out.

    Events are recorded on every plan, so a workspace that upgrades sees the year
    behind it; only reading is gated.
    """
    types = [AuditEventType(key=key, label=label) for key, label in EVENTS.items()]
    if not has_feature(repositories.workspaces.get(workspace_id), Feature.AUDIT_LOG):
        return AuditLogRead(events=[], next_cursor=None, available=False, event_types=types)
    start = resume_key(cursor, cursor_scope(workspace_id))
    if start is not None and start.get("workspace_id") != workspace_id:
        start = None
    rows, last = repositories.audit.list_events(
        workspace_id,
        actor_id=actor_id or None,
        event=event or None,
        since=since,
        until=until,
        limit=max(1, min(limit, MAX_PAGE)),
        start_key=start,
    )
    names = _actor_names(repositories, rows)
    return AuditLogRead(
        events=[
            AuditEventRead.from_row(row, label=EVENTS.get(row.event, row.event), actor_name=names.get(row.actor_id, ""))
            for row in rows
        ],
        next_cursor=encode_start_key(last, scope=cursor_scope(workspace_id)) if last else None,
        available=True,
        event_types=types,
    )


CSV_COLUMNS: tuple[str, ...] = (
    "created_at",
    "event",
    "actor_id",
    "actor_name",
    "actor_kind",
    "source",
    "ip",
    "amr",
    "target_type",
    "target_id",
    "target_label",
    "before",
    "after",
)


def _csv_cell(value: str) -> str:
    """A cell a spreadsheet will not run as a formula."""
    if value and value[0] in "=+-@\t\r":
        return "'" + value
    return value


def as_csv(
    repositories: Repositories,
    workspace_id: str,
    *,
    actor_id: str | None = None,
    event: str | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
) -> str:
    """Every matching event up to `MAX_CSV_ROWS` as CSV, newest first, for a plan that includes the log."""
    enforce_feature(repositories, workspace_id, Feature.AUDIT_LOG)
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(CSV_COLUMNS)
    start: dict[str, Any] | None = None
    written = 0
    while written < MAX_CSV_ROWS:
        rows, start = repositories.audit.list_events(
            workspace_id,
            actor_id=actor_id or None,
            event=event or None,
            since=since,
            until=until,
            limit=min(MAX_PAGE, MAX_CSV_ROWS - written),
            start_key=start,
        )
        names = _actor_names(repositories, rows)
        for row in rows:
            writer.writerow(
                [
                    row.created_at.isoformat(),
                    row.event,
                    row.actor_id,
                    _csv_cell(names.get(row.actor_id, "")),
                    row.actor_kind,
                    row.source,
                    row.ip,
                    " ".join(row.amr),
                    row.target_type,
                    row.target_id,
                    _csv_cell(row.target_label),
                    json.dumps(row.before, sort_keys=True) if row.before is not None else "",
                    json.dumps(row.after, sort_keys=True) if row.after is not None else "",
                ]
            )
        written += len(rows)
        if start is None:
            break
    return buffer.getvalue()
