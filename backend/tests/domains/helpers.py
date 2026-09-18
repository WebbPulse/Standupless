"""Helpers the domain route tests share: signing in, and seeding a tenant.

Signing in sets the request context header the Lambda Web Adapter injects behind
API Gateway, rather than overriding the authorization dependency. That way the
tests drive the same claims path production does, so a change to how claims are
read fails here instead of only in a deployed request.
"""

from __future__ import annotations

import json
from typing import Any

from fastapi.testclient import TestClient
from webbpulse.http import REQUEST_CONTEXT_HEADER

from app.common.db.dynamo.memberships import Membership, project_member_key, workspace_member_key
from app.common.db.dynamo.projects import Project
from app.common.db.dynamo.users import User
from app.common.db.dynamo.workspaces import Workspace

OWNER = "01JB000000000000000000OWNR"

ADMIN = "01JB0000000000000000000ADM"

MEMBER = "01JB0000000000000000000MEM"

GUEST = "01JB0000000000000000000GST"

OUTSIDER = "01JB000000000000000000OUTS"


def sign_in(client: TestClient, subject: str, **claims: Any) -> None:
    """Make every later request on this client arrive as `subject`.

    Writes the header the adapter injects, so the route resolves its caller the
    way a deployed one does.
    """
    context = {"authorizer": {"jwt": {"claims": {"sub": subject, **claims}}}}
    client.headers[REQUEST_CONTEXT_HEADER] = json.dumps(context)


def sign_out(client: TestClient) -> None:
    """Drop the claims header, so the next request reads as unauthenticated."""
    client.headers.pop(REQUEST_CONTEXT_HEADER, None)


def make_user(repositories: Any, user_id: str, email: str, display_name: str = "") -> User:
    """Put one user row in, so a member list has something to join against."""
    return repositories.users.create(User(id=user_id, email=email, display_name=display_name))


def make_workspace(repositories: Any, workspace_id: str, slug: str, owner: str) -> Workspace:
    """Create a workspace with an owner membership, the way the route does."""
    workspace = repositories.workspaces.create(Workspace(id=workspace_id, name=slug.title(), slug=slug))
    add_member(repositories, workspace_id, owner, "owner")
    return workspace


def add_member(repositories: Any, workspace_id: str, user_id: str, role: str) -> Membership:
    """Grant someone a workspace role directly, skipping the invite flow."""
    return repositories.memberships.put(
        Membership(
            workspace_id=workspace_id,
            member_key=workspace_member_key(user_id),
            user_id=user_id,
            role=role,
        )
    )


def add_project_member(repositories: Any, workspace_id: str, project_id: str, user_id: str, role: str) -> Membership:
    """Grant someone a project role directly, which is what a guest needs."""
    return repositories.memberships.put(
        Membership(
            workspace_id=workspace_id,
            member_key=project_member_key(project_id, user_id),
            user_id=user_id,
            role=role,
            project_id=project_id,
        )
    )


def make_project(repositories: Any, workspace_id: str, project_id: str, key_prefix: str) -> Project:
    """Put one project row in, with the default statuses seeded beside it."""
    project = repositories.projects.create(
        Project(
            workspace_id=workspace_id,
            project_id=project_id,
            name=key_prefix.title(),
            key_prefix=key_prefix,
        )
    )
    repositories.project_config.seed_statuses(workspace_id, project_id)
    return project
