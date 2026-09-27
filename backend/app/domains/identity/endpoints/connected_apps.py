"""Connected apps: the OAuth clients a person authorized, and a workspace admin's view of them.

Two routers, both served by the identity function because the consents, clients and
refresh tokens are identity tables. The account router sits under `/api/users/me`
and shows the caller their own grants across workspaces. The workspace router sits
under `/api/workspaces/{workspace_id}/connected-apps` and shows an admin every
member's grant in that workspace.

Revoking goes through the package's `revoke_authorization`, which deletes the
consent and revokes the refresh families behind it, so the client has to authorize
again. An access token already minted runs out on its own short lifetime.

No delegated credential reaches any of these routes. A token that could list or
revoke grants could revoke the grant a person is about to use to stop it.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Response, status
from pydantic import BaseModel

from app.common.api.dependencies.authz import (
    AuthzContext,
    Capability,
    caller_subject,
    refuse_api_key_actor,
    require,
    require_person,
)
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.domains.identity.connected_apps import (
    AuthorizationServer,
    ConnectedApp,
    Grant,
    build_authorization_server,
    grants_for_user,
    grants_for_workspace,
    group_by_client,
)

account_router = APIRouter()

workspace_router = APIRouter()

NOT_FOUND = {"error_code": "NOT_FOUND", "message": "Resource not found"}


class ConnectedAppWorkspaceRead(BaseModel):
    """One workspace a client was authorized in, and what it may do there."""

    id: str
    name: str
    scopes: list[str]
    authorized_at: Optional[datetime] = None
    last_used_at: Optional[datetime] = None


class ConnectedAppRead(BaseModel):
    """One client the caller authorized, across every workspace they granted it."""

    client_id: str
    client_name: str
    scopes: list[str]
    first_authorized_at: Optional[datetime] = None
    last_used_at: Optional[datetime] = None
    workspaces: list[ConnectedAppWorkspaceRead]


class ConnectedAppListRead(BaseModel):
    """The caller's connected apps, most recently used first."""

    apps: list[ConnectedAppRead]


class ConnectedAppMemberRead(BaseModel):
    """The person who authorized a client, as a workspace admin sees them."""

    id: str
    display_name: str
    email: str


class WorkspaceConnectedAppRead(BaseModel):
    """One member's grant to one client in this workspace."""

    client_id: str
    client_name: str
    user: ConnectedAppMemberRead
    scopes: list[str]
    authorized_at: Optional[datetime] = None
    last_used_at: Optional[datetime] = None


class WorkspaceConnectedAppListRead(BaseModel):
    """Every member grant in the workspace, most recently used first."""

    apps: list[WorkspaceConnectedAppRead]


def get_authorization_server() -> AuthorizationServer:
    """The package's authorization server over this deployment's tables, or a 404.

    A deployment that does not host the MCP resource mounts no authorization server,
    so there is nothing to have connected, and the routes answer as if absent.
    """
    from app.common.core.config import get_settings

    server = build_authorization_server(get_settings())
    if server is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
    return server


@account_router.get("/me/connected-apps", response_model=ConnectedAppListRead, dependencies=[Depends(require_person)])
def list_my_connected_apps(
    subject: Annotated[str, Depends(caller_subject)],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    server: Annotated[AuthorizationServer, Depends(get_authorization_server)],
) -> ConnectedAppListRead:
    """Every client the caller has authorized, grouped by client with a row per workspace."""
    apps = group_by_client(grants_for_user(server.stores, subject))
    workspace_ids = sorted({grant.tenant_id for app in apps for grant in app.grants})
    workspaces = repositories.workspaces.get_many(workspace_ids) if workspace_ids else {}
    names = {workspace_id: workspace.name for workspace_id, workspace in workspaces.items()}
    return ConnectedAppListRead(apps=[_app_read(app, names) for app in apps])


@account_router.delete(
    "/me/connected-apps/{client_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_person)],
)
def revoke_my_connected_app(
    subject: Annotated[str, Depends(caller_subject)],
    server: Annotated[AuthorizationServer, Depends(get_authorization_server)],
    client_id: str = Path(..., min_length=1, max_length=256),
) -> Response:
    """Revoke the caller's grant to one client in every workspace.

    A client the caller never authorized is a 404 rather than a silent success, so
    the page can tell a stale row from a revocation that happened.
    """
    revocation = server.service.revoke_authorization(subject, client_id)
    if not revocation.consents:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@workspace_router.get("/{workspace_id}/connected-apps", response_model=WorkspaceConnectedAppListRead)
def list_workspace_connected_apps(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    server: Annotated[AuthorizationServer, Depends(get_authorization_server)],
) -> WorkspaceConnectedAppListRead:
    """Every current member's grant in this workspace, for an admin.

    Read one member at a time, because consents are indexed by person and not by
    workspace. A grant held by someone no longer a member is not listed: their
    token already fails at every route, which checks membership on each request.
    """
    refuse_api_key_actor(context)
    member_ids = [membership.user_id for membership in repositories.memberships.list_members(context.workspace_id)]
    grants = grants_for_workspace(server.stores, member_ids, context.workspace_id)
    users = repositories.users.get_many(sorted({grant.user_id for grant in grants})) if grants else {}
    rows = sorted(grants, key=lambda grant: (grant.last_used_at or grant.granted_at, grant.client_name), reverse=True)
    return WorkspaceConnectedAppListRead(apps=[_workspace_grant_read(grant, users) for grant in rows])


@workspace_router.delete(
    "/{workspace_id}/connected-apps/{user_id}/{client_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def revoke_workspace_connected_app(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    server: Annotated[AuthorizationServer, Depends(get_authorization_server)],
    user_id: str = Path(..., min_length=1, max_length=64),
    client_id: str = Path(..., min_length=1, max_length=256),
) -> Response:
    """Revoke one member's grant to one client in this workspace only.

    Narrowed to this workspace's tenant, so an admin ends access to their own
    workspace and never to another workspace the same person granted the client.
    """
    refuse_api_key_actor(context)
    revocation = server.service.revoke_authorization(user_id, client_id, tenant_id=context.workspace_id)
    if not revocation.consents:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _app_read(app: ConnectedApp, workspace_names: dict[str, str]) -> ConnectedAppRead:
    """Shape one client's grants for the account page."""
    return ConnectedAppRead(
        client_id=app.client_id,
        client_name=app.client_name,
        scopes=list(app.scopes),
        first_authorized_at=_timestamp(app.first_authorized_at),
        last_used_at=_timestamp(app.last_used_at),
        workspaces=[
            ConnectedAppWorkspaceRead(
                id=grant.tenant_id,
                name=workspace_names.get(grant.tenant_id, ""),
                scopes=list(grant.scopes),
                authorized_at=_timestamp(grant.granted_at),
                last_used_at=_timestamp(grant.last_used_at),
            )
            for grant in app.grants
        ],
    )


def _workspace_grant_read(grant: Grant, users: dict[str, Any]) -> WorkspaceConnectedAppRead:
    """Shape one member grant for the workspace admin view."""
    user = users.get(grant.user_id)
    return WorkspaceConnectedAppRead(
        client_id=grant.client_id,
        client_name=grant.client_name,
        user=ConnectedAppMemberRead(
            id=grant.user_id,
            display_name=getattr(user, "display_name", "") or "",
            email=getattr(user, "email", "") or "",
        ),
        scopes=list(grant.scopes),
        authorized_at=_timestamp(grant.granted_at),
        last_used_at=_timestamp(grant.last_used_at),
    )


def _timestamp(value: str) -> Optional[datetime]:
    """An RFC 3339 string as a datetime, or `None` for an empty or unreadable one."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
