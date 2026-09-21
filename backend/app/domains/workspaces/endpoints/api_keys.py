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

from app.common.api.dependencies.authz import (
    AuthzContext,
    Capability,
    refuse_api_key_actor,
    require,
)
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.db.dynamo.api_keys import service_subject
from app.common.db.dynamo.base import expiry_timestamp
from app.domains.workspaces.schemas.api_key import (
    MAX_KEYS_PER_WORKSPACE,
    ApiKeyCreate,
    ApiKeyCreated,
    ApiKeyListRead,
    ApiKeyRead,
    ApiKeyScopeListField,
)

router = APIRouter()

NOT_FOUND = {"error_code": "NOT_FOUND", "message": "Resource not found"}

AT_LIMIT = {
    "error_code": "CONFLICT",
    "message": f"A workspace may hold at most {MAX_KEYS_PER_WORKSPACE} live API keys",
}

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
    than as its minter, so it survives that person leaving. That is exactly why
    only an admin may mint one: a credential nobody's departure revokes is a
    different thing from one that dies with a membership.

    The limit is checked before the mint rather than enforced by a conditional
    write, because the count spans the partition and no single-item condition can
    express it. The race that leaves a workspace one key over is harmless: the
    limit exists to stop unbounded growth, not to be exact.
    """
    refuse_api_key_actor(context)

    if payload.kind == "workspace" and not context.is_workspace_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=ADMIN_ONLY_KIND)

    if _live_count(repositories.api_keys.list_for_tenant(context.workspace_id)) >= MAX_KEYS_PER_WORKSPACE:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=AT_LIMIT)

    subject = service_subject(context.workspace_id) if payload.kind == "workspace" else context.user_id

    minted = mint(
        user_id=subject,
        tenant_id=context.workspace_id,
        scopes=payload.scopes,
        name=payload.name,
        expires_at=expiry_timestamp(payload.expires_in_days),
        store=repositories.api_keys,
        kind=payload.kind,
        created_by=context.user_id,
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

    if not existing.is_revoked:
        repositories.api_keys.revoke_by_id(context.workspace_id, key_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _newest_first(rows: list[ApiKeyRecord]) -> list[ApiKeyRecord]:
    """The tenant's keys in creation order, newest first.

    Sorted here rather than trusted to the index, because the package answers from
    `tenant_id-created_at-index` in ascending order and the settings list reads
    newest first.
    """
    return sorted(rows, key=lambda row: row.created_at, reverse=True)


def _live_count(rows: list[ApiKeyRecord]) -> int:
    """How many of a tenant's keys are still usable, for the limit check.

    Revoked keys do not count: they authenticate nobody, and counting them would
    make a workspace that rotated its keys unable to mint another. The package's
    own `count_for_tenant` counts every row including revoked ones by design, so
    the subtraction is this product's to make.
    """
    return len([row for row in rows if not row.is_revoked])
