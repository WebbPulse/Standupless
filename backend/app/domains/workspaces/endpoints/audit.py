"""Workspace audit log routes: read a page of it, or download it as CSV.

Both are for a workspace owner or admin. A personal API key of an owner or admin
may read it with `settings:read` and `admin`, so a security team can pull it into
their own tooling. Events are recorded on every plan, but reading them needs a plan
that includes the audit log: the page answers `available: false` with no events,
and the download refuses with `PLAN_FEATURE_UNAVAILABLE`.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Query, Response

from app.common import audit
from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.audit import AuditLogRead

router = APIRouter()

ActorFilter = Annotated[Optional[str], Query(max_length=64, description="Only events by this actor id.")]
EventFilter = Annotated[Optional[str], Query(max_length=64, description="Only events of this type.")]
SinceFilter = Annotated[Optional[datetime], Query(description="Only events at or after this moment.")]
UntilFilter = Annotated[Optional[datetime], Query(description="Only events before this moment.")]


@router.get("/{workspace_id}/audit-log", response_model=AuditLogRead)
def read_audit_log(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    actor_id: ActorFilter = None,
    event: EventFilter = None,
    since: SinceFilter = None,
    until: UntilFilter = None,
    limit: Annotated[int, Query(ge=1, le=audit.MAX_PAGE)] = 50,
    cursor: Annotated[Optional[str], Query(max_length=2048)] = None,
) -> AuditLogRead:
    """One page of the workspace's audit log, newest first, with the event types to filter by."""
    return audit.list_page(
        repositories,
        context.workspace_id,
        actor_id=actor_id,
        event=event,
        since=since,
        until=until,
        limit=limit,
        cursor=cursor,
    )


@router.get(
    "/{workspace_id}/audit-log/export",
    response_class=Response,
    responses={200: {"content": {"text/csv": {}}, "description": "The matching events as CSV."}},
)
def export_audit_log(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    actor_id: ActorFilter = None,
    event: EventFilter = None,
    since: SinceFilter = None,
    until: UntilFilter = None,
) -> Response:
    """The matching events as a CSV download, newest first, up to five thousand rows."""
    body = audit.as_csv(repositories, context.workspace_id, actor_id=actor_id, event=event, since=since, until=until)
    return Response(
        content=body,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="audit-log.csv"'},
    )
