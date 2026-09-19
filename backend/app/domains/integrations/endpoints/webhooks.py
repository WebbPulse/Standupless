"""Outbound webhook endpoint management, workspace admin only.

The secret is the whole reason these routes are admin rather than member: holding
it lets a receiver believe anything it is sent, so minting one is as sensitive as
changing who is in the workspace. It is returned by create and rotate and by
nothing else, which is why rotate exists at all: there is no route that can show an
existing secret again.
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Response, status

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.github import WebhookEndpoint, new_webhook_id
from app.domains.integrations.schemas.integrations import (
    WebhookEndpointCreate,
    WebhookEndpointRead,
    WebhookEndpointUpdate,
)
from app.domains.integrations.service import (
    conflict,
    endpoint_read,
    hash_secret,
    mint_secret,
    not_found,
    secret_hint,
)

router = APIRouter()

MAX_ENDPOINTS = 20


@router.get("/{workspace_id}/webhooks", response_model=list[WebhookEndpointRead])
def list_webhooks(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> list[WebhookEndpointRead]:
    """Every endpoint this workspace delivers to, without any secret."""
    rows = repositories.github.list_endpoints(context.workspace_id)
    return [endpoint_read(row) for row in sorted(rows, key=lambda row: row.created_at)]


@router.post("/{workspace_id}/webhooks", response_model=WebhookEndpointRead, status_code=status.HTTP_201_CREATED)
def create_webhook(
    payload: WebhookEndpointCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> WebhookEndpointRead:
    """Register an endpoint and show its secret, the only time it is ever shown."""
    existing = repositories.github.list_endpoints(context.workspace_id)
    if len(existing) >= MAX_ENDPOINTS:
        raise conflict(f"A workspace may have at most {MAX_ENDPOINTS} webhook endpoints.")

    secret = mint_secret()
    salt = uuid.uuid4().hex
    now = utc_now()
    endpoint = WebhookEndpoint(
        workspace_id=context.workspace_id,
        github_key="",
        webhook_id=new_webhook_id(),
        url=payload.url,
        events=list(payload.events),
        description=payload.description,
        active=payload.active,
        secret_salt=salt,
        secret_hash=hash_secret(secret, salt),
        secret_hint=secret_hint(secret),
        created_by=context.user_id,
        created_at=now,
        updated_at=now,
    )
    stored = repositories.github.create_endpoint(endpoint)
    return endpoint_read(stored, secret=secret)


@router.patch("/{workspace_id}/webhooks/{webhook_id}", response_model=WebhookEndpointRead)
def update_webhook(
    webhook_id: str,
    payload: WebhookEndpointUpdate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> WebhookEndpointRead:
    """Change an endpoint's url, events or enabled flag."""
    attributes = payload.model_dump(exclude_unset=True, exclude_none=True)
    if not attributes:
        endpoint = repositories.github.get_endpoint(context.workspace_id, webhook_id)
        if endpoint is None:
            raise not_found()
        return endpoint_read(endpoint)

    attributes["updated_at"] = utc_now().isoformat()
    updated = repositories.github.update_endpoint(context.workspace_id, webhook_id, **attributes)
    if updated is None:
        raise not_found()
    return endpoint_read(updated)


@router.post("/{workspace_id}/webhooks/{webhook_id}/rotate", response_model=WebhookEndpointRead)
def rotate_webhook_secret(
    webhook_id: str,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> WebhookEndpointRead:
    """Mint a new secret for an endpoint, invalidating the old one at once.

    There is no overlap window: a receiver that has not been updated starts failing
    verification immediately. That is the honest behaviour for a rotate somebody
    reached for because the old value leaked.
    """
    salt = uuid.uuid4().hex
    secret = mint_secret()
    updated = repositories.github.update_endpoint(
        context.workspace_id,
        webhook_id,
        secret_salt=salt,
        secret_hash=hash_secret(secret, salt),
        secret_hint=secret_hint(secret),
        updated_at=utc_now().isoformat(),
    )
    if updated is None:
        raise not_found()
    return endpoint_read(updated, secret=secret)


@router.delete("/{workspace_id}/webhooks/{webhook_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_webhook(
    webhook_id: str,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> Response:
    """Stop delivering to an endpoint and forget it."""
    if not repositories.github.delete_endpoint(context.workspace_id, webhook_id):
        raise not_found()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
