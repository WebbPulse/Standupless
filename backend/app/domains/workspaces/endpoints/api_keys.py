"""API key routes: mint, list and revoke a machine credential for one workspace.

Three rules shape every handler here and none of them are in the dependency.

An API key may never reach these routes. `refuse_api_key_actor` runs first on all
four, because a key that could mint its successor would make revoking the first
one meaningless, and one that could revoke another would let a leaked key lock out
the workspace it leaked from.

A key is minted inside one workspace and acts inside that one only. There is no
account-wide key, so every path is nested under the workspace and the tenant on
the minted record is the one authorization was decided against.

The plaintext exists in exactly one response. `mint` hands it back once and the
stored row holds its SHA-256, so no later read can produce it and no support path
can recover it.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Response, status
from webbpulse.identity.api_keys import ApiKeyRecord, mint

from app.common import audit, plan_usage
from app.common.api.dependencies.authz import (
    AuthzContext,
    Capability,
    refuse_api_key_actor,
    require,
)
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.db.dynamo.api_keys import service_subject
from app.common.db.dynamo.base import expiry_timestamp
from app.common.plan_limits import LimitedResource
from app.domains.workspaces.schemas.api_key import (
    ApiKeyCreate,
    ApiKeyCreated,
    ApiKeyListRead,
    ApiKeyRead,
    ApiKeyScopeListField,
)

router = APIRouter()

NOT_FOUND = {"error_code": "NOT_FOUND", "message": "Resource not found"}

ADMIN_ONLY_KIND = {
    "error_code": "FORBIDDEN",
    "message": "Only a workspace admin may mint a workspace key",
}

ADMIN_ONLY_LIST = {
    "error_code": "FORBIDDEN",
    "message": "Only a workspace admin may list every key in the workspace",
}


@router.get("/{workspace_id}/api-keys", response_model=ApiKeyListRead)
def list_api_keys(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    scope: ApiKeyScopeListField = Query(default="mine"),
) -> ApiKeyListRead:
    """The caller's own keys, or every key in the workspace for an admin.

    `mine` is the default rather than `workspace` so the ordinary read shows a
    person only what they are responsible for, and widening it is a deliberate
    query parameter that an admin check then has to pass.
    """
    refuse_api_key_actor(context)

    rows = _newest_first(repositories.api_keys.list_for_tenant(context.workspace_id))

    if scope == "workspace":
        if not context.is_workspace_admin:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=ADMIN_ONLY_LIST)
    else:
        rows = [row for row in rows if row.user_id == context.user_id]

    return ApiKeyListRead(api_keys=[ApiKeyRead.from_row(row) for row in rows])


@router.post(
    "/{workspace_id}/api-keys",
    response_model=ApiKeyCreated,
    status_code=status.HTTP_201_CREATED,
)
def create_api_key(
    payload: ApiKeyCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> ApiKeyCreated:
    """Mint a key and show its plaintext, the only time it is ever shown.

    A workspace key acts as the synthetic principal `svc#<workspace_id>` rather
    than as its minter, but it still only works while that minter is an owner or
    admin of the workspace, so a departure or demotion disables it. Only an admin
    may mint one because it acts for the workspace rather than for a person.

    The key row and the workspace's API key usage row are written in one
    transaction, the usage row under a conditional increment, so two concurrent
    mints at the limit cannot both land.
    """
    refuse_api_key_actor(context)

    if payload.kind == "workspace" and not context.is_workspace_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=ADMIN_ONLY_KIND)

    subject = service_subject(context.workspace_id) if payload.kind == "workspace" else context.user_id

    minted = mint(
        user_id=subject,
        tenant_id=context.workspace_id,
        scopes=payload.scopes,
        name=payload.name,
        expires_at=expiry_timestamp(payload.expires_in_days),
        kind=payload.kind,
        created_by=context.user_id,
    )
    plan_usage.commit(
        repositories,
        context.workspace_id,
        [repositories.api_keys.put_action(minted.record)],
        [plan_usage.Delta(LimitedResource.API_KEYS, 1)],
    )

    audit.record(
        repositories,
        context,
        "api_key.created",
        target_type="api_key",
        target_id=minted.record.key_id,
        target_label=minted.record.name,
        after={"kind": payload.kind, "scopes": list(payload.scopes), "prefix": minted.record.prefix},
    )
    return ApiKeyCreated(**ApiKeyRead.from_row(minted.record).model_dump(), secret=minted.plaintext)


@router.delete("/{workspace_id}/api-keys/{key_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_api_key(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    key_id: str = Path(..., min_length=1),
) -> Response:
    """Revoke one key the caller owns, or any key for a workspace admin.

    A key the caller neither owns nor administers is a 404 rather than a 403, so a
    member cannot walk key ids to learn what other people hold.

    Revoking is idempotent: a key already revoked answers 204 rather than 404,
    because the caller's intent is satisfied and a client retrying a revoke should
    not have to distinguish the two.
    """
    refuse_api_key_actor(context)

    existing = repositories.api_keys.get_by_id(context.workspace_id, key_id)
    if existing is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)

    owns = existing.created_by == context.user_id or existing.user_id == context.user_id
    if not owns and not context.is_workspace_admin:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)

    if not existing.is_revoked and plan_usage.revoke_api_key(repositories, context.workspace_id, existing.key_hash):
        audit.record(
            repositories,
            context,
            "api_key.revoked",
            target_type="api_key",
            target_id=key_id,
            target_label=existing.name,
            before={"kind": existing.kind, "prefix": existing.prefix},
        )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _newest_first(rows: list[ApiKeyRecord]) -> list[ApiKeyRecord]:
    """The tenant's keys in creation order, newest first.

    Sorted here rather than trusted to the index, because the package answers from
    `tenant_id-created_at-index` in ascending order and the settings list reads
    newest first.
    """
    return sorted(rows, key=lambda row: row.created_at, reverse=True)
