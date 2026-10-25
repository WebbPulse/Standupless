"""GitLab merge request linking: the connections a workspace admin manages, and the receiver GitLab calls.

`router` sits under `/workspaces` and is authorized like every other workspace
admin route. `public_router` carries its own `/api` and no session, because
GitLab cannot present one. Its one route is addressed to one connection, and it
compares the `X-Gitlab-Token` GitLab echoes against that connection's secret
digest before the body is parsed, so a forged delivery never reaches a parser.

The receiver never calls GitLab. It claims the delivery's id, enqueues the body on
the queue GitHub deliveries travel and answers, so GitLab's own timeout cannot
make it redeliver work that is already running.
"""

from __future__ import annotations

import json
import logging
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, Path, Request, Response, status
from webbpulse import events as webbpulse_events
from webbpulse.dynamodb import new_ulid

from app.common import audit
from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.core.config import settings
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.gitlab import MAX_CONNECTIONS, GitlabConnection, gitlab_connection_key
from app.domains.integrations.gitlab import api, tokens
from app.domains.integrations.gitlab.events import EVENT
from app.domains.integrations.schemas.gitlab import (
    GitlabConnectionCreated,
    GitlabConnectionRead,
    GitlabConnectionsRead,
    GitlabConnectionWrite,
)
from app.domains.integrations.service import conflict, not_configured, not_found, unprocessable

router = APIRouter()

public_router = APIRouter(prefix="/api", tags=["integrations"])

_log = logging.getLogger(__name__)

PLATFORM_SCOPE = "_platform"

DELIVERY_SCOPE = "gitlab-delivery"

DELIVERY_TTL_SECONDS = 86400.0

MERGE_REQUEST_HOOK = "Merge Request Hook"
"""The `X-Gitlab-Event` of the only delivery acted on."""

WorkspaceAdmin = Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))]

Bundle = Annotated[Repositories, Depends(get_repositories)]

ConnectionId = Annotated[str, Path(min_length=1, max_length=64)]


def webhook_url(workspace_id: str, connection_id: str) -> str:
    """The address GitLab sends one connection's merge request events to."""
    return f"{settings.api_base_url}/api/gitlab/webhooks/{workspace_id}/{connection_id}"


def _read(connection: GitlabConnection) -> GitlabConnectionRead:
    """The response body for one connection, without its token or secret digest."""
    return GitlabConnectionRead(
        connection_id=connection.connection_id,
        instance_url=connection.instance_url,
        scope_kind=connection.scope_kind,
        scope_id=connection.scope_id,
        scope_path=connection.scope_path,
        scope_name=connection.scope_name,
        web_url=connection.web_url,
        token_hint=connection.token_hint,
        webhook_url=webhook_url(connection.workspace_id, connection.connection_id),
        connected_by=connection.connected_by,
        connected_at=connection.connected_at,
        secret_rotated_at=connection.secret_rotated_at,
    )


def _created(connection: GitlabConnection, secret: str) -> GitlabConnectionCreated:
    """A connection's response body carrying the webhook secret this request made."""
    return GitlabConnectionCreated(**_read(connection).model_dump(), webhook_secret=secret)


def _audit_view(connection: GitlabConnection) -> dict[str, str]:
    """What the audit log keeps about a connection: where it points, never its credentials."""
    return {
        "instance_url": connection.instance_url,
        "scope_kind": connection.scope_kind,
        "scope_path": connection.scope_path,
    }


def _require_configured() -> None:
    """Refuse a connection change in an environment that cannot seal a token."""
    if not tokens.configured():
        raise not_configured("GitLab")


@router.get("/{workspace_id}/gitlab/connections", response_model=GitlabConnectionsRead)
def list_gitlab_connections(context: WorkspaceAdmin, repositories: Bundle) -> GitlabConnectionsRead:
    """Whether GitLab can be connected here, and every group or project this workspace is connected to."""
    rows = repositories.github.gitlab.list(context.workspace_id)
    return GitlabConnectionsRead(configured=tokens.configured(), connections=[_read(row) for row in rows])


@router.post(
    "/{workspace_id}/gitlab/connections",
    response_model=GitlabConnectionCreated,
    status_code=status.HTTP_201_CREATED,
)
def create_gitlab_connection(
    body: GitlabConnectionWrite, context: WorkspaceAdmin, repositories: Bundle
) -> GitlabConnectionCreated:
    """Check the token can read the group or project, then store the connection and show its webhook secret once.

    The token is sealed before the row is written and the webhook secret is kept
    only as a digest, so neither is readable from the table afterwards.
    """
    _require_configured()
    try:
        instance_url = api.normalize_instance(body.instance_url)
        scope_path = api.normalize_path(body.scope_path)
        scope = api.read_scope(instance_url, body.scope_kind, scope_path, body.access_token)
    except api.GitlabError as exc:
        raise unprocessable(exc.message, exc.code) from exc

    existing = repositories.github.gitlab.list(context.workspace_id)
    if any(row.instance_url == instance_url and row.scope_id == scope.scope_id for row in existing):
        raise conflict(f"This workspace is already connected to {scope.path}.")
    if len(existing) >= MAX_CONNECTIONS:
        raise unprocessable(
            f"A workspace can hold at most {MAX_CONNECTIONS} GitLab connections.", "GITLAB_CONNECTION_LIMIT"
        )

    connection_id = new_ulid()
    secret = tokens.new_webhook_secret()
    now = utc_now()
    connection = GitlabConnection(
        workspace_id=context.workspace_id,
        github_key=gitlab_connection_key(connection_id),
        connection_id=connection_id,
        instance_url=instance_url,
        scope_kind=body.scope_kind,
        scope_id=scope.scope_id,
        scope_path=scope.path,
        scope_name=scope.name,
        web_url=scope.web_url,
        token_hint=tokens.hint(body.access_token),
        webhook_secret_hash=tokens.secret_digest(secret),
        connected_by=context.user_id,
        connected_at=now,
        updated_at=now,
        **tokens.sealed_fields(context.workspace_id, connection_id, body.access_token),
    )
    if not repositories.github.gitlab.create(connection):
        raise conflict("That connection already exists.")
    audit.record(
        repositories,
        context,
        "gitlab.connected",
        target_type="gitlab",
        target_id=connection_id,
        target_label=scope.path,
        after=_audit_view(connection),
    )
    return _created(connection, secret)


@router.post(
    "/{workspace_id}/gitlab/connections/{connection_id}/rotate-secret",
    response_model=GitlabConnectionCreated,
)
def rotate_gitlab_webhook_secret(
    connection_id: ConnectionId, context: WorkspaceAdmin, repositories: Bundle
) -> GitlabConnectionCreated:
    """Replace a connection's webhook secret and show the new one once; the old one stops working at once."""
    _require_configured()
    current = repositories.github.gitlab.get(context.workspace_id, connection_id)
    if current is None:
        raise not_found()
    secret = tokens.new_webhook_secret()
    updated = repositories.github.gitlab.update(
        context.workspace_id,
        connection_id,
        webhook_secret_hash=tokens.secret_digest(secret),
        secret_rotated_at=utc_now(),
    )
    if updated is None:
        raise not_found()
    audit.record(
        repositories,
        context,
        "gitlab.secret_rotated",
        target_type="gitlab",
        target_id=connection_id,
        target_label=updated.scope_path,
    )
    return _created(updated, secret)


@router.delete("/{workspace_id}/gitlab/connections/{connection_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_gitlab_connection(connection_id: ConnectionId, context: WorkspaceAdmin, repositories: Bundle) -> Response:
    """Remove a connection, its sealed token with it; deliveries to its webhook are refused from then on.

    Links already made stay on their issues, as a GitHub pull request's do when its
    repository is removed.
    """
    removed = repositories.github.gitlab.delete(context.workspace_id, connection_id)
    if removed is None:
        raise not_found()
    audit.record(
        repositories,
        context,
        "gitlab.disconnected",
        target_type="gitlab",
        target_id=connection_id,
        target_label=removed.scope_path,
        before=_audit_view(removed),
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _answer(payload: dict[str, Any], status_code: int) -> Response:
    """A JSON answer to GitLab."""
    return Response(content=json.dumps(payload), media_type="application/json", status_code=status_code)


WEBHOOK_RESPONSES: dict[int | str, dict[str, Any]] = {
    status.HTTP_401_UNAUTHORIZED: {"description": "The token does not match the connection's webhook secret."},
    status.HTTP_202_ACCEPTED: {"description": "The delivery was queued."},
}


@public_router.post(
    "/gitlab/webhooks/{workspace_id}/{connection_id}",
    responses=WEBHOOK_RESPONSES,
)
async def receive_gitlab_webhook(
    request: Request,
    repositories: Bundle,
    workspace_id: Annotated[str, Path(min_length=1, max_length=64)],
    connection_id: ConnectionId,
    x_gitlab_token: Annotated[str | None, Header()] = None,
    x_gitlab_event: Annotated[str | None, Header()] = None,
    x_gitlab_event_uuid: Annotated[str | None, Header()] = None,
) -> Response:
    """Check, claim and enqueue one GitLab delivery, then answer at once.

    The order is the security property. The token is compared before the body is
    read, an unknown connection is answered exactly as a wrong token is so the
    route confirms nothing, and only a merge request event is claimed. A failed
    enqueue releases the claim, so GitLab's retry does the work rather than being
    dropped as a replay.
    """
    connection = repositories.github.gitlab.get(workspace_id, connection_id)
    if connection is None or not tokens.secret_matches(connection, x_gitlab_token):
        _log.warning(
            "Rejected a GitLab delivery whose token did not match.",
            extra={"event": "integrations.gitlab.token_rejected"},
        )
        return _answer(
            {"error_code": "INVALID_SIGNATURE", "message": "The token does not match."},
            status.HTTP_401_UNAUTHORIZED,
        )

    if (x_gitlab_event or "") != MERGE_REQUEST_HOOK:
        return _answer({"accepted": False, "reason": "ignored"}, status.HTTP_200_OK)

    delivery = (x_gitlab_event_uuid or "")[:128]
    if delivery and not repositories.idempotency.claim(
        PLATFORM_SCOPE, DELIVERY_SCOPE, delivery, ttl_seconds=DELIVERY_TTL_SECONDS
    ):
        _log.info("Dropped a replayed GitLab delivery.", extra={"event": "integrations.gitlab.delivery_replayed"})
        return _answer({"accepted": False, "reason": "duplicate"}, status.HTTP_200_OK)

    try:
        payload: Any = json.loads(await request.body())
    except ValueError:
        return _answer({"accepted": False, "reason": "unparseable"}, status.HTTP_200_OK)
    if not isinstance(payload, dict) or payload.get("object_kind") != "merge_request":
        return _answer({"accepted": False, "reason": "ignored"}, status.HTTP_200_OK)

    try:
        webbpulse_events.enqueue(
            settings.GITHUB_EVENTS_QUEUE_URL,
            webbpulse_events.EventEnvelope(
                name=EVENT,
                payload={
                    "event": EVENT,
                    "workspace_id": workspace_id,
                    "connection_id": connection_id,
                    "delivery": delivery,
                    "body": payload,
                },
                scope=workspace_id,
            ),
        )
    except Exception:
        if delivery:
            repositories.idempotency.release(PLATFORM_SCOPE, DELIVERY_SCOPE, delivery)
        raise
    return _answer({"accepted": True}, status.HTTP_202_ACCEPTED)
