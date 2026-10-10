"""Workspace authentication policy routes: read it, and require two-factor authentication.

Both routes are for a workspace owner or admin, from a signed in session only: an
API key never changes how the people of a workspace sign in. Turning the policy on
needs a plan that includes it, while turning it off is always allowed so a
downgraded workspace can still relax it. The caller must already meet the policy
they turn on, so an admin cannot lock themselves out with one click.

Enforcement is not here but in `require`, which refuses every workspace route to a
session whose person has no second factor while the policy is on.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status

from app.common import audit
from app.common.api.dependencies.authz import AuthzContext, Capability, refuse_api_key_actor, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.plan_features import Feature, enforce_feature, has_feature
from app.domains.workspaces.schemas.security import AuthPolicyRead, AuthPolicyUpdate

router = APIRouter()

ENABLE_TWO_FACTOR_FIRST = {
    "error_code": "TWO_FACTOR_REQUIRED",
    "message": "Set up an authenticator app on your own account before requiring it for everyone.",
}


@router.get("/{workspace_id}/auth-policy", response_model=AuthPolicyRead)
def read_auth_policy(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> AuthPolicyRead:
    """The workspace's authentication policy, and whether its plan offers it."""
    refuse_api_key_actor(context)
    policy = repositories.memberships.get_auth_policy(context.workspace_id)
    workspace = repositories.workspaces.get(context.workspace_id)
    return AuthPolicyRead.from_policy(policy, available=has_feature(workspace, Feature.AUTH_POLICY))


@router.put("/{workspace_id}/auth-policy", response_model=AuthPolicyRead)
def update_auth_policy(
    payload: AuthPolicyUpdate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> AuthPolicyRead:
    """Require two-factor authentication of every member, or stop requiring it."""
    refuse_api_key_actor(context)
    if payload.require_two_factor:
        enforce_feature(repositories, context.workspace_id, Feature.AUTH_POLICY)
        if not context.two_factor:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=ENABLE_TWO_FACTOR_FIRST)
    previous = repositories.memberships.get_auth_policy(context.workspace_id)
    policy = repositories.memberships.set_auth_policy(
        context.workspace_id, require_two_factor=payload.require_two_factor, updated_by=context.user_id
    )
    was_required = previous.require_two_factor
    if was_required != payload.require_two_factor:
        audit.record(
            repositories,
            context,
            "auth_policy.updated",
            target_type="auth_policy",
            target_id=context.workspace_id,
            target_label="Require two-factor authentication",
            before={"require_two_factor": was_required},
            after={"require_two_factor": payload.require_two_factor},
        )
    workspace = repositories.workspaces.get(context.workspace_id)
    return AuthPolicyRead.from_policy(policy, available=has_feature(workspace, Feature.AUTH_POLICY))
