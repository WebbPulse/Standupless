"""SCIM token routes: the credentials a workspace's identity provider provisions with.

A SCIM token is an API key of its own kind. It counts toward the workspace's API
key allowance, it is never listed or revoked on the API key routes, and product
authorization refuses it, so the only thing it can reach is the SCIM router. Only
a workspace admin manages them, an API key never can, and minting one needs the
plan that includes single sign-on, because provisioning is part of that feature.
"""

from __future__ import annotations

from typing import Annotated, Final

from fastapi import APIRouter, Depends, HTTPException, Path, Response, status
from webbpulse.identity.api_keys import mint
from webbpulse.identity.scim import SCIM_SCOPE

from app.common import audit, plan_usage
from app.common.api.dependencies.authz import (
    SCIM_KEY_KIND,
    AuthzContext,
    Capability,
    refuse_api_key_actor,
    require,
)
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.plan_features import Feature, enforce_feature
from app.common.plan_limits import LimitedResource
from app.common.sso import identity_issuer
from app.domains.workspaces.schemas.scim import (
    ScimSettingsRead,
    ScimTokenCreate,
    ScimTokenCreated,
    ScimTokenRead,
)

router = APIRouter()

TOKEN_LIMIT: Final = 5
"""Live SCIM tokens per workspace: enough to rotate one while another directory runs."""

NOT_FOUND = {"error_code": "NOT_FOUND", "message": "Resource not found"}

TOO_MANY = {
    "error_code": "SCIM_TOKEN_LIMIT",
    "message": f"A workspace can hold at most {TOKEN_LIMIT} SCIM tokens. Revoke one first.",
}


def scim_base_url() -> str:
    """The SCIM 2.0 base URL an identity provider is given for this deployment."""
    return identity_issuer().removesuffix("/api/auth") + "/api/scim/v2"


def scim_subject(workspace_id: str) -> str:
    """The subject a workspace's SCIM tokens act as, which is never a person."""
    return f"scim#{workspace_id}"


def _live_tokens(repositories: Repositories, workspace_id: str) -> list[ScimTokenRead]:
    """The workspace's unrevoked SCIM tokens, newest first."""
    rows = [
        row
        for row in repositories.api_keys.list_for_tenant(workspace_id)
        if row.kind == SCIM_KEY_KIND and not row.is_revoked
    ]
    rows.sort(key=lambda row: row.created_at, reverse=True)
    return [ScimTokenRead.from_row(row) for row in rows]


@router.get("/{workspace_id}/sso/scim", response_model=ScimSettingsRead)
def read_scim(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> ScimSettingsRead:
    """The base URL to give the identity provider and the workspace's live tokens."""
    refuse_api_key_actor(context)
    return ScimSettingsRead(base_url=scim_base_url(), tokens=_live_tokens(repositories, context.workspace_id))


@router.post("/{workspace_id}/sso/scim/tokens", response_model=ScimTokenCreated, status_code=status.HTTP_201_CREATED)
def create_scim_token(
    payload: ScimTokenCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> ScimTokenCreated:
    """Mint a SCIM token and show its plaintext, the only time it is ever shown."""
    refuse_api_key_actor(context)
    enforce_feature(repositories, context.workspace_id, Feature.SSO)
    if len(_live_tokens(repositories, context.workspace_id)) >= TOKEN_LIMIT:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=TOO_MANY)
    minted = mint(
        user_id=scim_subject(context.workspace_id),
        tenant_id=context.workspace_id,
        scopes=(SCIM_SCOPE,),
        name=payload.name.strip() or "SCIM",
        kind=SCIM_KEY_KIND,
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
        "scim.token_created",
        target_type="api_key",
        target_id=minted.record.key_id,
        target_label=minted.record.name,
        after={"prefix": minted.record.prefix},
    )
    return ScimTokenCreated(**ScimTokenRead.from_row(minted.record).model_dump(), secret=minted.plaintext)


@router.delete("/{workspace_id}/sso/scim/tokens/{key_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_scim_token(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    key_id: str = Path(..., min_length=1),
) -> Response:
    """Revoke one SCIM token. Revoking one already revoked answers 204, as API keys do."""
    refuse_api_key_actor(context)
    existing = repositories.api_keys.get_by_id(context.workspace_id, key_id)
    if existing is None or existing.kind != SCIM_KEY_KIND:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
    if not existing.is_revoked and plan_usage.revoke_api_key(repositories, context.workspace_id, existing.key_hash):
        audit.record(
            repositories,
            context,
            "scim.token_revoked",
            target_type="api_key",
            target_id=key_id,
            target_label=existing.name,
            before={"prefix": existing.prefix},
        )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
