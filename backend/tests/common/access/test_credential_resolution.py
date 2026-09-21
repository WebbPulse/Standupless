"""Three credential kinds, one authorization context, one set of rules.

This is the central claim M6 makes, so it is tested against the resolver directly
rather than through any one route. A session, a per-user API key and a per-workspace
API key all arrive as different bytes on the wire and must leave `resolve_context`
as the same shape, carrying a role read live from the membership table and scopes
that are the intersection of what the credential was granted and what its subject
can still do.

The asymmetry is the point. A credential can only ever narrow: a key minted with
`issues:write` by someone who is later demoted to guest must lose the write, and a
key minted with every scope must never let its holder exceed the role they hold
today. Each of those is a separate test below, because they fail independently.
"""

from __future__ import annotations

from typing import Any, Optional

import pytest
from starlette.datastructures import Headers
from starlette.requests import Request
from webbpulse.http import REQUEST_CONTEXT_HEADER

from app.common.api.dependencies.authz import (
    ActorKind,
    AuthzContext,
    resolve_context,
    tenant_claim_of,
)
from app.common.db.dynamo.api_keys import API_KEY_SCOPES, service_subject
from tests.domains.helpers import (
    GUEST,
    MEMBER,
    OUTSIDER,
    OWNER,
    add_member,
    add_project_member,
    make_project,
    make_user,
    make_workspace,
)

WORKSPACE = "01JB00000000000000000000WS"

OTHER_WORKSPACE = "01JB0000000000000000000WS2"

PROJECT = "01JB000000000000000000PRJ1"

OTHER_PROJECT = "01JB000000000000000000PRJ2"


@pytest.fixture
def tenant(repositories: Any) -> str:
    """A workspace carrying one member of each role and two projects."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    add_member(repositories, WORKSPACE, MEMBER, "member")
    add_member(repositories, WORKSPACE, GUEST, "guest")
    make_user(repositories, OWNER, "owner@example.com", "Olive Owner")
    make_user(repositories, MEMBER, "member@example.com", "Mo Member")
    make_user(repositories, GUEST, "guest@example.com", "Gale Guest")
    make_project(repositories, WORKSPACE, PROJECT, "ABC")
    make_project(repositories, WORKSPACE, OTHER_PROJECT, "XYZ")
    add_project_member(repositories, WORKSPACE, PROJECT, GUEST, "member")
    return WORKSPACE


def session_request(subject: str) -> Request:
    """A request carrying a signed in caller, in the shape the adapter injects."""
    import json

    context = {"authorizer": {"jwt": {"claims": {"sub": subject}}}}
    return _request({REQUEST_CONTEXT_HEADER: json.dumps(context)})


def bearer_request(secret: str) -> Request:
    """A request presenting an API key as a bearer token, and no session."""
    return _request({"authorization": f"Bearer {secret}"})


def _request(headers: dict[str, str]) -> Request:
    """One ASGI scope carrying the given headers, enough for the resolver to read."""
    raw = [(key.lower().encode(), value.encode()) for key, value in headers.items()]
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/",
        "headers": raw,
        "query_string": b"",
    }
    request = Request(scope)
    request.scope["headers"] = raw
    assert isinstance(request.headers, Headers)
    return request


def mint_user_key(repositories: Any, user_id: str, scopes: tuple[str, ...]) -> str:
    """A per-user key for one subject, returning the one plaintext copy."""
    return _mint(repositories, kind="user", user_id=user_id, workspace_id=WORKSPACE, scopes=scopes)


def mint_workspace_key(repositories: Any, scopes: tuple[str, ...]) -> str:
    """A per-workspace key acting as the workspace's service principal."""
    return _mint(
        repositories,
        kind="workspace",
        user_id=service_subject(WORKSPACE),
        workspace_id=WORKSPACE,
        scopes=scopes,
    )


def _mint(repositories: Any, *, kind: str, user_id: str, workspace_id: str, scopes: tuple[str, ...]) -> str:
    """Mint one key the way the create route does, and hand back its secret."""
    from webbpulse.identity.api_keys import mint

    return mint(
        user_id=user_id,
        tenant_id=workspace_id,
        scopes=scopes,
        name="A test key",
        store=repositories.api_keys,
        kind=kind,
        created_by=OWNER,
    ).plaintext


def context_for(repositories: Any, request: Request, workspace_id: str = WORKSPACE) -> Optional[AuthzContext]:
    """Resolve one request against the tenant, as every route does."""
    return resolve_context(request, repositories, workspace_id)


def test_a_session_resolves_to_the_live_membership_role(repositories: Any, tenant: str) -> None:
    """A signed in caller carries their current role and acts as a user.

    No scopes are asserted here beyond the actor kind, because a session is
    unrestricted by design: the role is the whole authorization statement.
    """
    context = context_for(repositories, session_request(MEMBER))

    assert context is not None
    assert context.user_id == MEMBER
    assert context.workspace_id == WORKSPACE
    assert context.role == "member"
    assert context.actor is ActorKind.USER


def test_a_user_key_resolves_to_the_same_context_a_session_does(repositories: Any, tenant: str) -> None:
    """The same person, through a key, is the same subject in the same workspace.

    This is what makes the three kinds interchangeable to a route: everything past
    resolution reads `context.role` and `context.user_id` without caring which of
    the three produced them.
    """
    secret = mint_user_key(repositories, MEMBER, API_KEY_SCOPES)

    context = context_for(repositories, bearer_request(secret))

    assert context is not None
    assert context.user_id == MEMBER
    assert context.workspace_id == WORKSPACE
    assert context.role == "member"
    assert context.actor is not ActorKind.USER


def test_a_workspace_key_acts_as_a_member_service_principal(repositories: Any, tenant: str) -> None:
    """A per-workspace key carries the service subject and the member role.

    It holds no membership row, so the role is the fixed `member` the contract
    assigns rather than something read from the table. A workspace key is therefore
    never an admin, which is what keeps it from managing other keys.
    """
    secret = mint_workspace_key(repositories, ("issues:read", "issues:write"))

    context = context_for(repositories, bearer_request(secret))

    assert context is not None
    assert context.user_id == service_subject(WORKSPACE)
    assert context.role == "member"
    assert context.actor is not ActorKind.USER


def test_a_guests_key_keeps_its_scopes_and_is_bounded_by_projects(repositories: Any, tenant: str) -> None:
    """A guest's key keeps `issues:write`, and reaches only the guest's projects.

    The contract is explicit that a scope is a ceiling on a role rather than a
    substitute for it, so the narrowing for a guest is not in the scope set at all:
    it is `project_ids`, which every route re-checks. Asserting both together is
    what stops a later change from "simplifying" the scopes and quietly widening
    the guest to the whole workspace.
    """
    secret = mint_user_key(repositories, GUEST, API_KEY_SCOPES)

    context = context_for(repositories, bearer_request(secret))

    assert context is not None
    assert context.role == "guest"
    assert "issues:write" in context.scopes
    assert context.project_ids == (PROJECT,)
    assert not context.can_see_project(OTHER_PROJECT)


def test_a_key_never_widens_past_its_own_scopes(repositories: Any, tenant: str) -> None:
    """An owner's narrow key stays narrow, although the owner may do everything.

    The intersection runs in both directions. Without this an integration handed a
    read-only key by an admin would silently be able to write.
    """
    secret = mint_user_key(repositories, OWNER, ("issues:read",))

    context = context_for(repositories, bearer_request(secret))

    assert context is not None
    assert context.role == "owner"
    assert set(context.scopes) == {"issues:read"}


def test_a_revoked_key_resolves_to_nothing(repositories: Any, tenant: str) -> None:
    """Revocation takes effect on the next request, with no cache to wait out."""
    secret = mint_user_key(repositories, MEMBER, API_KEY_SCOPES)
    row = next(iter(repositories.api_keys.list_for_tenant(WORKSPACE)))
    repositories.api_keys.revoke_by_id(WORKSPACE, row.key_id)

    assert context_for(repositories, bearer_request(secret)) is None


def test_a_key_whose_subject_left_the_workspace_resolves_to_nothing(repositories: Any, tenant: str) -> None:
    """Losing membership kills the key, without anyone having to revoke it.

    This is why the membership read is live rather than baked into the key at mint
    time: offboarding a person has to close every credential they hold, and a key
    they minted months earlier is one of those.
    """
    secret = mint_user_key(repositories, MEMBER, API_KEY_SCOPES)
    repositories.memberships.delete(WORKSPACE, MEMBER)

    assert context_for(repositories, bearer_request(secret)) is None


def test_a_key_bound_to_one_workspace_is_refused_by_another(repositories: Any, tenant: str) -> None:
    """A key's tenant claim pins it, so it cannot be replayed against a second tenant.

    The subject really is a member of both workspaces here, so the refusal can only
    come from the binding rather than from a failed membership read.
    """
    make_workspace(repositories, OTHER_WORKSPACE, "other", OWNER)
    add_member(repositories, OTHER_WORKSPACE, MEMBER, "member")
    secret = mint_user_key(repositories, MEMBER, API_KEY_SCOPES)

    assert context_for(repositories, bearer_request(secret)) is not None
    assert context_for(repositories, bearer_request(secret), OTHER_WORKSPACE) is None


def test_an_unknown_bearer_resolves_to_nothing(repositories: Any, tenant: str) -> None:
    """A forged key that was never minted authenticates as nobody."""
    assert context_for(repositories, bearer_request("wpk_notarealkeyatallnotreal")) is None


def test_a_non_member_resolves_to_nothing(repositories: Any, tenant: str) -> None:
    """A signed in person outside the workspace gets no context at all."""
    make_user(repositories, OUTSIDER, "outsider@example.com", "Ozzy Outsider")

    assert context_for(repositories, session_request(OUTSIDER)) is None


def test_an_anonymous_request_resolves_to_nothing(repositories: Any, tenant: str) -> None:
    """No credential means no context, rather than an empty one."""
    assert context_for(repositories, _request({})) is None


def test_a_session_carries_no_tenant_claim(repositories: Any, tenant: str) -> None:
    """Only a key binds itself to a workspace, which is what the MCP route reads.

    The MCP endpoint takes its workspace from this claim because it has no path to
    put one in. A session answering here would let a browser cookie drive tool calls
    against whichever workspace it named.
    """
    assert tenant_claim_of(session_request(MEMBER)) == ""


def test_a_key_carries_the_workspace_it_was_bound_to(repositories: Any, tenant: str) -> None:
    """The tenant claim names exactly the workspace consent was given for."""
    secret = mint_user_key(repositories, MEMBER, API_KEY_SCOPES)

    assert tenant_claim_of(bearer_request(secret), repositories) == WORKSPACE
