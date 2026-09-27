"""Every guarded route resolves a caller from the staging gate's claim shape.

Staging's access gate is a REQUEST authorizer, so it publishes its claims JSON
encoded under one `authorizer.lambda` key rather than as the native
`authorizer.jwt.claims` map. Authorization that read only the native shape answered
401 to every signed in caller on every non-identity route, and every unit test
stayed green because they all signed in through the native shape.

One route asserting this is not enough: the failure was a claims reader, and a
reader is reached by every route alike, so the regression hides anywhere a single
example does not look. This drives the whole contract instead. The bar is only that
the route does not answer 401: a 404 on a seeded workspace the caller is not in, a
422 on a body this test does not build and a 405 are all the route having resolved
its caller and then decided something else.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from tests.domains.helpers import (
    MEMBER,
    add_member,
    add_team_member,
    make_team,
    make_user,
    make_workspace,
    sign_in_through_gate,
)

CONTRACT = Path(__file__).with_name("route_contract.json")

INTERNAL = "internal"

PUBLIC = "public"

UNAUTHORIZED = 401

WORKSPACE = "01JB0000000000000000000GTW"

TEAM = "01JB0000000000000000000GTP"

ISSUE = "01JB0000000000000000000GTI"

PLACEHOLDER = "01JB00000000000000000PLCH"
"""What every path parameter other than the workspace id is filled with.

A guarded route reads the workspace id from the path and the caller from the
claims before it looks at anything else, so the remaining parameters only have to
be well formed. A row that does not exist gives a 404, which is the route working.
"""


def guarded_routes() -> "list[tuple[str, str, str]]":
    """Every route that requires a caller, as domain, method and path.

    Public and internal routes are left out: neither reads claims, so neither can
    show a claim-shape regression.
    """
    rows = json.loads(CONTRACT.read_text())
    return [
        (str(row["domain"]), str(row["method"]), str(row["path"]))
        for row in rows
        if str(row["auth"]) not in (INTERNAL, PUBLIC)
    ]


def _fill(path: str) -> str:
    """One contract path with every parameter filled, the workspace by the seeded one."""

    def _substitute(match: re.Match[str]) -> str:
        """The value for one path parameter."""
        name = match.group(1)
        if name == "workspace_id":
            return WORKSPACE
        if name == "team_id":
            return TEAM
        if name == "issue_id":
            return ISSUE
        if name == "user_id":
            return MEMBER
        return PLACEHOLDER

    return re.sub(r"\{(\w+)\}", _substitute, path)


@pytest.fixture
def gate_clients(repositories: Any) -> "Iterator[dict[str, TestClient]]":
    """One client per domain, all bound to one seeded tenant and signed in through the gate.

    Built per domain rather than from Root A because that is the application each
    deployed function runs, so a route answering here is the route answering in
    production. The caller is a member of the workspace and of the team, which
    is the ordinary signed in caller whose 401 was the bug.
    """
    from app.common.api.dependencies.repositories import bind_repositories

    make_user(repositories, MEMBER, "member@example.com", "A Member")
    make_workspace(repositories, WORKSPACE, "gate", MEMBER)
    add_member(repositories, WORKSPACE, MEMBER, "member")
    make_team(repositories, WORKSPACE, TEAM, "GTE")
    add_team_member(repositories, WORKSPACE, TEAM, MEMBER, "admin")

    clients: dict[str, TestClient] = {}
    contexts: list[TestClient] = []
    for name, domain in DOMAINS.items():
        app = build_domain_app(domain)
        bind_repositories(app, repositories)
        client = TestClient(app)
        client.__enter__()
        contexts.append(client)
        sign_in_through_gate(client, MEMBER)
        clients[name] = client

    yield clients

    for client in contexts:
        client.__exit__(None, None, None)


@pytest.mark.parametrize(("domain", "method", "path"), guarded_routes(), ids=lambda value: str(value))
def test_a_guarded_route_resolves_a_caller_from_gate_claims(
    gate_clients: "dict[str, TestClient]", domain: str, method: str, path: str
) -> None:
    """One guarded route answers something other than 401 to gate-shaped claims.

    A 401 here means the route could not find the caller in the claims the staging
    authorizer publishes, which is the whole class of failure this file exists for.
    Anything else, including a 403 on a capability this member does not hold, is the
    claims having been read.
    """
    client = gate_clients[domain]
    response = client.request(method, _fill(path), json={})

    assert response.status_code != UNAUTHORIZED, (
        f"{method} {path} answered 401 to the staging gate's claim shape, so the deployed "
        f"authorizer's claims are not being read on it: {response.text[:300]}"
    )


def test_the_same_routes_answer_401_without_any_claims(gate_clients: "dict[str, TestClient]") -> None:
    """A guarded route still refuses a caller carrying no claims at all.

    Without this the check above passes for the wrong reason: a route that stopped
    requiring a caller would never answer 401 to anything, and the parametrised
    case would read that as the gate shape working.
    """
    from tests.domains.helpers import sign_out

    refused = 0
    for domain, method, path in guarded_routes():
        client = gate_clients[domain]
        sign_out(client)
        response = client.request(method, _fill(path), json={})
        sign_in_through_gate(client, MEMBER)
        if response.status_code == UNAUTHORIZED:
            refused += 1

    total = len(guarded_routes())
    assert refused == total, f"only {refused} of {total} guarded routes refused an anonymous caller"
