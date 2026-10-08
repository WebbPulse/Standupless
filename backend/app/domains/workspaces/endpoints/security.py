"""Workspace authentication policy routes: read it, require two-factor, limit sign-in methods.

Both routes are for a workspace owner or admin, from a signed in session only: an
API key never changes how the people of a workspace sign in. Tightening the policy
needs a plan that includes it, while relaxing it is always allowed so a downgraded
workspace can still loosen it. The caller must already meet the policy they save,
so an admin cannot lock themselves out with one click.

Enforcement is not here but in `require`, which refuses every workspace route to a
session the policy does not admit.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status

from app.common import audit
from app.common.api.dependencies.authz import AuthzContext, Capability, refuse_api_key_actor, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.db.dynamo.memberships import SIGN_IN_METHODS
from app.common.plan_features import Feature, enforce_feature, has_feature
from app.domains.workspaces.schemas.security import AuthPolicyRead, AuthPolicyUpdate

router = APIRouter()

ENABLE_TWO_FACTOR_FIRST = {
    "error_code": "TWO_FACTOR_REQUIRED",
    "message": "Set up an authenticator app on your own account before requiring it for everyone.",
}

KEEP_YOUR_SIGN_IN_METHOD = {
    "error_code": "SIGN_IN_METHOD_REQUIRED",
    "message": "Keep the way you signed in allowed, or sign in another way first.",
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
    return AuthPolicyRead.from_policy(
        policy,
        available=has_feature(workspace, Feature.AUTH_POLICY),
        current_method=context.sign_in_method,
    )


@router.put("/{workspace_id}/auth-policy", response_model=AuthPolicyRead)
def update_auth_policy(
    payload: AuthPolicyUpdate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> AuthPolicyRead:
    """Change which sessions the workspace admits: a second factor, and the ways of signing in."""
    refuse_api_key_actor(context)
    current = repositories.memberships.get_auth_policy(context.workspace_id)
    require_two_factor = (
        current.require_two_factor if payload.require_two_factor is None else payload.require_two_factor
    )
    allowed_methods = list(current.allowed_methods) if payload.allowed_methods is None else payload.allowed_methods
    turning_on = require_two_factor and not current.require_two_factor
    excluding = bool(set(current.allowed_methods) - set(allowed_methods))
    if turning_on or excluding:
        enforce_feature(repositories, context.workspace_id, Feature.AUTH_POLICY)
    if require_two_factor and not context.two_factor:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=ENABLE_TWO_FACTOR_FIRST)
    if set(allowed_methods) != set(SIGN_IN_METHODS) and context.sign_in_method not in allowed_methods:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=KEEP_YOUR_SIGN_IN_METHOD)
    policy = repositories.memberships.set_auth_policy(
        context.workspace_id,
        require_two_factor=require_two_factor,
        allowed_methods=allowed_methods,
        updated_by=context.user_id,
    )
    if current.require_two_factor != require_two_factor:
        audit.record(
            repositories,
            context,
            "auth_policy.updated",
            target_type="auth_policy",
            target_id=context.workspace_id,
            target_label="Require two-factor authentication",
            before={"require_two_factor": current.require_two_factor},
            after={"require_two_factor": require_two_factor},
        )
    before_methods = _in_listed_order(current.allowed_methods)
    after_methods = _in_listed_order(policy.allowed_methods)
    if before_methods != after_methods:
        audit.record(
            repositories,
            context,
            "auth_policy.updated",
            target_type="auth_policy",
            target_id=context.workspace_id,
            target_label="Allowed sign-in methods",
            before={"allowed_methods": before_methods},
            after={"allowed_methods": after_methods},
        )
    workspace = repositories.workspaces.get(context.workspace_id)
    return AuthPolicyRead.from_policy(
        policy,
        available=has_feature(workspace, Feature.AUTH_POLICY),
        current_method=context.sign_in_method,
    )


def _in_listed_order(methods: Iterable[str]) -> list[str]:
    """The given sign-in methods, without repeats, in the order the settings page lists them."""
    chosen = set(methods)
    return [method for method in SIGN_IN_METHODS if method in chosen]
