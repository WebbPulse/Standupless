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
from typing import Any, Iterator, Mapping

from webbpulse.audit import (
    SYSTEM_ACTOR,
    AuditActor,
    AuditCatalogue,
    AuditEvent,
    AuditPage,
    AuditQuery,
    AuditRecorder,
    AuditTarget,
    csv_safe,
)
from webbpulse.dynamodb import InvalidStartKey

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.audit import AuditEventRead, AuditEventType, AuditLogRead
from app.common.db.dynamo.audit import RETENTION
from app.common.db.dynamo.teams import Team
from app.common.plan_features import Feature, enforce_feature, has_feature

_log = logging.getLogger(__name__)

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
    "connected_app.scopes_granted": "Connected app permissions granted",
    "export.started": "Workspace export started",
    "import.started": "Issue import started",
    "workspace.updated": "Workspace settings changed",
    "workspace.deletion_scheduled": "Workspace deletion scheduled",
    "workspace.deletion_cancelled": "Workspace deletion cancelled",
    "plan.changed": "Plan changed",
    "team.created": "Team created",
    "team.deleted": "Team deleted",
    "team.parent_changed": "Team parent changed",
}
"""Every event the log records, with the label the settings page shows."""

EVENT_TYPES: tuple[str, ...] = tuple(EVENTS)

CATALOGUE = AuditCatalogue(EVENTS)
"""The shared catalogue over `EVENTS`, so a typo in an event name fails at the call site."""


def _record(
    repositories: Repositories,
    workspace_id: str,
    event: str,
    actor: AuditActor,
    *,
    target_type: str,
    target_id: str,
    target_label: str,
    before: Mapping[str, Any] | None,
    after: Mapping[str, Any] | None,
) -> AuditEvent | None:
    """Store one event unless this bundle cannot, never raising on a store failure."""
    if event not in CATALOGUE:
        raise ValueError(f"unknown audit event {event!r}")
    if repositories.is_read_only("audit"):
        _log.info("audit_skipped", extra={"event": event, "workspace_id": workspace_id})
        return None
    recorder = AuditRecorder(repositories.audit, CATALOGUE, retention=RETENTION)
    return recorder.record(
        workspace_id,
        event,
        actor=actor,
        target=AuditTarget(target_type, target_id, target_label),
        before=before,
        after=after,
    )


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
    return _record(
        repositories,
        workspace_id or context.workspace_id,
        event,
        AuditActor(
            id=context.user_id,
            kind=context.actor.value,
            source=context.source,
            ip=context.ip,
            amr=tuple(context.amr),
        ),
        target_type=target_type,
        target_id=target_id,
        target_label=target_label,
        before=before,
        after=after,
    )


def record_parent_change(
    repositories: Repositories, context: AuthzContext, team: Team, before: str | None
) -> AuditEvent | None:
    """Record a team moving under another parent or to the top level, and nothing when its parent stayed."""
    if team.parent_team_id == before:
        return None
    return record(
        repositories,
        context,
        "team.parent_changed",
        target_type="team",
        target_id=team.team_id,
        target_label=team.name,
        before={"parent_team_id": before},
        after={"parent_team_id": team.parent_team_id},
    )


def record_system(
    repositories: Repositories,
    workspace_id: str,
    event: str,
    *,
    actor_id: str = SYSTEM_ACTOR.id,
    actor_kind: str = SYSTEM_ACTOR.kind,
    source: str = SYSTEM_ACTOR.source,
    target_type: str = "",
    target_id: str = "",
    target_label: str = "",
    before: Mapping[str, Any] | None = None,
    after: Mapping[str, Any] | None = None,
) -> AuditEvent | None:
    """Record one event no signed-in request carried, such as a billing webhook or an OAuth consent."""
    return _record(
        repositories,
        workspace_id,
        event,
        AuditActor(id=actor_id, kind=actor_kind, source=source),
        target_type=target_type,
        target_id=target_id,
        target_label=target_label,
        before=before,
        after=after,
    )


def _query(actor_id: str | None, event: str | None, since: datetime | None, until: datetime | None) -> AuditQuery:
    """The shared listing query for the route and MCP filters, a blank filter meaning none."""
    return AuditQuery(since=since, until=until, actor_id=actor_id or None, action=event or None)


def _page(
    repositories: Repositories, workspace_id: str, query: AuditQuery, *, limit: int, cursor: str | None
) -> AuditPage:
    """One page of the log, starting over from the newest when the cursor will not serve.

    A malformed, stale or foreign cursor answers the first page rather than an error,
    so an old bookmark still opens the log.
    """
    try:
        return repositories.audit.list_events(workspace_id, query, limit=limit, cursor=cursor)
    except InvalidStartKey:
        return repositories.audit.list_events(workspace_id, query, limit=limit)


def _actor_names(repositories: Repositories, rows: list[AuditEvent]) -> dict[str, str]:
    """Display names for the people behind a page of rows, empty where this bundle has no users."""
    if "users" not in repositories.repository_names:
        return {}
    from app.common.api.schemas.workspaces import display_name_for

    ids = sorted({row.actor.id for row in rows if row.actor.kind != "system"})
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
    types = [AuditEventType(key=key, label=label) for key, label in CATALOGUE.event_types()]
    if not has_feature(repositories.workspaces.get(workspace_id), Feature.AUDIT_LOG):
        return AuditLogRead(events=[], next_cursor=None, available=False, event_types=types)
    page = _page(
        repositories,
        workspace_id,
        _query(actor_id, event, since, until),
        limit=max(1, min(limit, MAX_PAGE)),
        cursor=cursor,
    )
    names = _actor_names(repositories, page.events)
    return AuditLogRead(
        events=[
            AuditEventRead.from_event(row, label=CATALOGUE.label(row.action), actor_name=names.get(row.actor.id, ""))
            for row in page.events
        ],
        next_cursor=page.next_cursor,
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


def _events(repositories: Repositories, workspace_id: str, query: AuditQuery) -> Iterator[list[AuditEvent]]:
    """The matching events a page at a time, newest first, up to `MAX_CSV_ROWS`."""
    cursor: str | None = None
    written = 0
    while written < MAX_CSV_ROWS:
        page = repositories.audit.list_events(
            workspace_id, query, limit=min(MAX_PAGE, MAX_CSV_ROWS - written), cursor=cursor
        )
        yield page.events
        written += len(page.events)
        if page.next_cursor is None:
            return
        cursor = page.next_cursor


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
    for rows in _events(repositories, workspace_id, _query(actor_id, event, since, until)):
        names = _actor_names(repositories, rows)
        for row in rows:
            writer.writerow(
                [
                    row.occurred_at.isoformat(),
                    row.action,
                    row.actor.id,
                    csv_safe(names.get(row.actor.id, "")),
                    row.actor.kind,
                    row.actor.source,
                    row.actor.ip,
                    " ".join(row.actor.amr),
                    row.target.type,
                    row.target.id,
                    csv_safe(row.target.label),
                    json.dumps(row.before, sort_keys=True) if row.before is not None else "",
                    json.dumps(row.after, sort_keys=True) if row.after is not None else "",
                ]
            )
    return buffer.getvalue()
