"""Outbound webhook management, for workspace admins and for team admins.

The same set of routes exists twice. Under `/{workspace_id}/webhooks` a workspace
admin sees and manages every webhook, including the ones scoped to a single team,
and may create one that covers all teams. Under `/{workspace_id}/teams/{team_id}/
webhooks` a team admin manages only that team's webhooks, and the path decides the
team, so a team admin can never widen a webhook past the team they administer.

The secret is the reason these routes are admin only: holding it lets a receiver
believe anything it is sent. It is returned by create and rotate and by nothing
else, which is why rotate exists at all.

Every URL is run through the SSRF guard when it is saved, so an admin gets a clear
422 for a private or loopback address. The sender checks again on every attempt,
because the answer DNS gives can change after the save.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Response, status

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.github import WebhookEndpoint, new_webhook_id, webhook_key
from app.common.plan_limits import LimitedResource, enforce_limit
from app.domains.integrations.outbound import delivery as outbound
from app.domains.integrations.outbound.payloads import ping as ping_event
from app.domains.integrations.outbound.ssrf import UnsafeDestination, check_destination
from app.domains.integrations.schemas.integrations import (
    WebhookDeliveryRead,
    WebhookEndpointCreate,
    WebhookEndpointRead,
    WebhookEndpointUpdate,
)
from app.domains.integrations.service import (
    delivery_read,
    endpoint_read,
    hash_secret,
    mint_secret,
    new_salt,
    not_found,
    secret_hint,
    unprocessable,
)

router = APIRouter()

DELIVERY_LOG_LIMIT = 50

AUTO_DISABLE_FIELDS = ("disabled_reason", "disabled_at")

WorkspaceAdmin = Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))]

TeamAdmin = Annotated[AuthzContext, Depends(require(Capability.TEAM_ADMIN))]

Bundle = Annotated[Repositories, Depends(get_repositories)]


def _safe_url(url: str) -> str:
    """Hold the SSRF rules on a URL being saved, as a 422 the settings form can show."""
    try:
        check_destination(url)
    except UnsafeDestination as exc:
        raise unprocessable(str(exc), "UNSAFE_URL") from exc
    return url


def _require_team(repositories: Repositories, workspace_id: str, team_id: str) -> None:
    """Refuse a team that does not exist or is being deleted."""
    if repositories.teams.get(workspace_id, team_id) is None:
        raise unprocessable("That team does not exist.", "UNKNOWN_TEAM")


def _scoped(repositories: Repositories, workspace_id: str, webhook_id: str, team_id: str | None) -> WebhookEndpoint:
    """One webhook the caller may manage, or a 404.

    On a team route a webhook of another team, or one covering every team, is
    answered as absent rather than forbidden, so the route reveals nothing beyond
    the team the caller administers.
    """
    endpoint = repositories.github.get_endpoint(workspace_id, webhook_id)
    if endpoint is None or (team_id is not None and endpoint.team_id != team_id):
        raise not_found()
    return endpoint


def _list(repositories: Repositories, workspace_id: str, team_id: str | None) -> list[WebhookEndpointRead]:
    """The webhooks a scope sees, oldest first."""
    rows = repositories.github.list_endpoints(workspace_id)
    if team_id is not None:
        rows = [row for row in rows if row.team_id == team_id]
    return [endpoint_read(row) for row in sorted(rows, key=lambda row: row.created_at)]


def _create(
    repositories: Repositories, context: AuthzContext, payload: WebhookEndpointCreate, team_id: str | None
) -> WebhookEndpointRead:
    """Register a webhook and show its secret, the only time it is ever shown."""
    if team_id is not None and payload.team_id not in (None, team_id):
        raise unprocessable("A team webhook belongs to the team in the path.")
    scope = team_id if team_id is not None else payload.team_id
    if scope is not None:
        _require_team(repositories, context.workspace_id, scope)
    url = _safe_url(payload.url)
    enforce_limit(repositories, context.workspace_id, LimitedResource.WEBHOOKS)

    webhook_id = new_webhook_id()
    salt = new_salt()
    secret = mint_secret(webhook_id, salt)
    now = utc_now()
    endpoint = WebhookEndpoint(
        workspace_id=context.workspace_id,
        github_key=webhook_key(webhook_id),
        webhook_id=webhook_id,
        url=url,
        label=payload.label,
        team_id=scope,
        resource_types=list(payload.resource_types),
        active=payload.enabled,
        secret_salt=salt,
        secret_hash=hash_secret(secret, salt),
        secret_hint=secret_hint(secret),
        created_by=context.user_id,
        created_at=now,
        updated_at=now,
    )
    return endpoint_read(repositories.github.create_endpoint(endpoint), secret=secret)


def _update(
    repositories: Repositories,
    workspace_id: str,
    webhook_id: str,
    payload: WebhookEndpointUpdate,
    team_id: str | None,
) -> WebhookEndpointRead:
    """Change a webhook; turning it back on also clears its failure run and notice."""
    endpoint = _scoped(repositories, workspace_id, webhook_id, team_id)
    changes = payload.model_fields_set
    attributes: dict[str, Any] = {}
    clear: list[str] = []

    if "team_id" in changes:
        if team_id is not None:
            if payload.team_id != team_id:
                raise unprocessable("A team webhook cannot be moved off its team.")
        elif payload.team_id is None:
            clear.append("team_id")
        else:
            _require_team(repositories, workspace_id, payload.team_id)
            attributes["team_id"] = payload.team_id
    if payload.url is not None:
        attributes["url"] = _safe_url(payload.url)
    if payload.label is not None:
        attributes["label"] = payload.label
    if payload.resource_types is not None:
        attributes["resource_types"] = list(payload.resource_types)
    if payload.enabled is not None:
        attributes["active"] = payload.enabled
        if payload.enabled and not endpoint.active:
            attributes["consecutive_failures"] = 0
            clear.extend(AUTO_DISABLE_FIELDS)
        elif payload.enabled and endpoint.consecutive_failures:
            attributes["consecutive_failures"] = 0

    updated: WebhookEndpoint | None = endpoint
    if attributes:
        updated = repositories.github.update_endpoint(workspace_id, webhook_id, **attributes)
    if updated is not None and clear:
        updated = repositories.github.clear_endpoint_fields(workspace_id, webhook_id, *clear)
    if updated is None:
        raise not_found()
    return endpoint_read(updated)


def _rotate(repositories: Repositories, workspace_id: str, webhook_id: str, team_id: str | None) -> WebhookEndpointRead:
    """Mint a new secret, invalidating the old one at once.

    There is no overlap window: a receiver that has not been updated starts failing
    verification immediately, which is the honest behaviour for a rotate somebody
    reached for because the old value leaked.
    """
    _scoped(repositories, workspace_id, webhook_id, team_id)
    salt = new_salt()
    secret = mint_secret(webhook_id, salt)
    updated = repositories.github.update_endpoint(
        workspace_id,
        webhook_id,
        secret_salt=salt,
        secret_hash=hash_secret(secret, salt),
        secret_hint=secret_hint(secret),
    )
    if updated is None:
        raise not_found()
    return endpoint_read(updated, secret=secret)


def _delete(repositories: Repositories, workspace_id: str, webhook_id: str, team_id: str | None) -> Response:
    """Stop delivering to a webhook and forget it and its delivery log."""
    _scoped(repositories, workspace_id, webhook_id, team_id)
    if not repositories.github.delete_endpoint(workspace_id, webhook_id):
        raise not_found()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _deliveries(
    repositories: Repositories, workspace_id: str, webhook_id: str, team_id: str | None
) -> list[WebhookDeliveryRead]:
    """The webhook's most recent deliveries, newest first."""
    _scoped(repositories, workspace_id, webhook_id, team_id)
    rows = repositories.github.list_deliveries(workspace_id, webhook_id, limit=DELIVERY_LOG_LIMIT)
    return [delivery_read(row) for row in rows]


def _ping(repositories: Repositories, workspace_id: str, webhook_id: str, team_id: str | None) -> WebhookDeliveryRead:
    """Send a signed test ping now and log it, whether or not the webhook is enabled.

    A disabled webhook can be pinged so an admin can prove the receiver is fixed
    before turning it back on. The failure run is left alone either way.
    """
    endpoint = _scoped(repositories, workspace_id, webhook_id, team_id)
    event = ping_event(workspace_id, webhook_id, endpoint.label, endpoint.team_id)
    delivery = outbound.open_delivery(endpoint, event, delivery_id=outbound.new_delivery_id(), is_test=True)
    return delivery_read(outbound.send_now(repositories, endpoint, delivery))


def _redeliver(
    repositories: Repositories, workspace_id: str, webhook_id: str, delivery_id: str, team_id: str | None
) -> WebhookDeliveryRead:
    """Send a logged delivery again now, as a new log entry pointing back at the original."""
    endpoint = _scoped(repositories, workspace_id, webhook_id, team_id)
    original = repositories.github.get_delivery(workspace_id, webhook_id, delivery_id)
    if original is None:
        raise not_found()
    return delivery_read(outbound.send_now(repositories, endpoint, outbound.redelivery(endpoint, original)))


@router.get("/{workspace_id}/webhooks", response_model=list[WebhookEndpointRead])
def list_webhooks(context: WorkspaceAdmin, repositories: Bundle) -> list[WebhookEndpointRead]:
    """Every webhook in the workspace, team scoped ones included, without any secret."""
    return _list(repositories, context.workspace_id, None)


@router.post("/{workspace_id}/webhooks", response_model=WebhookEndpointRead, status_code=status.HTTP_201_CREATED)
def create_webhook(
    payload: WebhookEndpointCreate, context: WorkspaceAdmin, repositories: Bundle
) -> WebhookEndpointRead:
    """Register a webhook for every team, or for the team named in the body."""
    return _create(repositories, context, payload, None)


@router.patch("/{workspace_id}/webhooks/{webhook_id}", response_model=WebhookEndpointRead)
def update_webhook(
    webhook_id: str, payload: WebhookEndpointUpdate, context: WorkspaceAdmin, repositories: Bundle
) -> WebhookEndpointRead:
    """Change any webhook in the workspace."""
    return _update(repositories, context.workspace_id, webhook_id, payload, None)


@router.post("/{workspace_id}/webhooks/{webhook_id}/rotate", response_model=WebhookEndpointRead)
def rotate_webhook_secret(webhook_id: str, context: WorkspaceAdmin, repositories: Bundle) -> WebhookEndpointRead:
    """Mint a new secret for any webhook in the workspace."""
    return _rotate(repositories, context.workspace_id, webhook_id, None)


@router.delete("/{workspace_id}/webhooks/{webhook_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_webhook(webhook_id: str, context: WorkspaceAdmin, repositories: Bundle) -> Response:
    """Delete any webhook in the workspace."""
    return _delete(repositories, context.workspace_id, webhook_id, None)


@router.get("/{workspace_id}/webhooks/{webhook_id}/deliveries", response_model=list[WebhookDeliveryRead])
def list_webhook_deliveries(
    webhook_id: str, context: WorkspaceAdmin, repositories: Bundle
) -> list[WebhookDeliveryRead]:
    """The delivery log of any webhook in the workspace."""
    return _deliveries(repositories, context.workspace_id, webhook_id, None)


@router.post("/{workspace_id}/webhooks/{webhook_id}/ping", response_model=WebhookDeliveryRead)
def ping_webhook(webhook_id: str, context: WorkspaceAdmin, repositories: Bundle) -> WebhookDeliveryRead:
    """Send a test ping to any webhook in the workspace."""
    return _ping(repositories, context.workspace_id, webhook_id, None)


@router.post(
    "/{workspace_id}/webhooks/{webhook_id}/deliveries/{delivery_id}/redeliver",
    response_model=WebhookDeliveryRead,
)
def redeliver_webhook_delivery(
    webhook_id: str, delivery_id: str, context: WorkspaceAdmin, repositories: Bundle
) -> WebhookDeliveryRead:
    """Redeliver one logged delivery of any webhook in the workspace."""
    return _redeliver(repositories, context.workspace_id, webhook_id, delivery_id, None)


@router.get("/{workspace_id}/teams/{team_id}/webhooks", response_model=list[WebhookEndpointRead])
def list_team_webhooks(team_id: str, context: TeamAdmin, repositories: Bundle) -> list[WebhookEndpointRead]:
    """The webhooks scoped to one team."""
    _require_team_route(repositories, context.workspace_id, team_id)
    return _list(repositories, context.workspace_id, team_id)


@router.post(
    "/{workspace_id}/teams/{team_id}/webhooks",
    response_model=WebhookEndpointRead,
    status_code=status.HTTP_201_CREATED,
)
def create_team_webhook(
    team_id: str, payload: WebhookEndpointCreate, context: TeamAdmin, repositories: Bundle
) -> WebhookEndpointRead:
    """Register a webhook for one team."""
    _require_team_route(repositories, context.workspace_id, team_id)
    return _create(repositories, context, payload, team_id)


@router.patch("/{workspace_id}/teams/{team_id}/webhooks/{webhook_id}", response_model=WebhookEndpointRead)
def update_team_webhook(
    team_id: str, webhook_id: str, payload: WebhookEndpointUpdate, context: TeamAdmin, repositories: Bundle
) -> WebhookEndpointRead:
    """Change one of a team's webhooks."""
    return _update(repositories, context.workspace_id, webhook_id, payload, team_id)


@router.post("/{workspace_id}/teams/{team_id}/webhooks/{webhook_id}/rotate", response_model=WebhookEndpointRead)
def rotate_team_webhook_secret(
    team_id: str, webhook_id: str, context: TeamAdmin, repositories: Bundle
) -> WebhookEndpointRead:
    """Mint a new secret for one of a team's webhooks."""
    return _rotate(repositories, context.workspace_id, webhook_id, team_id)


@router.delete("/{workspace_id}/teams/{team_id}/webhooks/{webhook_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_team_webhook(team_id: str, webhook_id: str, context: TeamAdmin, repositories: Bundle) -> Response:
    """Delete one of a team's webhooks."""
    return _delete(repositories, context.workspace_id, webhook_id, team_id)


@router.get(
    "/{workspace_id}/teams/{team_id}/webhooks/{webhook_id}/deliveries",
    response_model=list[WebhookDeliveryRead],
)
def list_team_webhook_deliveries(
    team_id: str, webhook_id: str, context: TeamAdmin, repositories: Bundle
) -> list[WebhookDeliveryRead]:
    """The delivery log of one of a team's webhooks."""
    return _deliveries(repositories, context.workspace_id, webhook_id, team_id)


@router.post("/{workspace_id}/teams/{team_id}/webhooks/{webhook_id}/ping", response_model=WebhookDeliveryRead)
def ping_team_webhook(team_id: str, webhook_id: str, context: TeamAdmin, repositories: Bundle) -> WebhookDeliveryRead:
    """Send a test ping to one of a team's webhooks."""
    return _ping(repositories, context.workspace_id, webhook_id, team_id)


@router.post(
    "/{workspace_id}/teams/{team_id}/webhooks/{webhook_id}/deliveries/{delivery_id}/redeliver",
    response_model=WebhookDeliveryRead,
)
def redeliver_team_webhook_delivery(
    team_id: str, webhook_id: str, delivery_id: str, context: TeamAdmin, repositories: Bundle
) -> WebhookDeliveryRead:
    """Redeliver one logged delivery of one of a team's webhooks."""
    return _redeliver(repositories, context.workspace_id, webhook_id, delivery_id, team_id)


def _require_team_route(repositories: Repositories, workspace_id: str, team_id: str) -> None:
    """Answer a team route for a team that is gone or going with a 404."""
    if repositories.teams.get(workspace_id, team_id) is None:
        raise not_found()
