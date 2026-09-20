"""Root A and Root B are built the same way, so they cannot drift apart.

Root A is every domain in one process. Root B is one application per deployed
function. Both go through `build_domain_app`, and these pin that the union of the
Root B applications is exactly Root A: a route reachable in development and
missing in production is the failure this catches.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.common.composition.domains import DOMAIN_NAMES, DOMAINS
from app.common.composition.wiring import build_domain_app


def _paths(app: Any) -> set[str]:
    """Every declared path of an application, ignoring the lazy router wrappers."""
    return {path for route in app.routes if (path := getattr(route, "path", None))}


def test_root_a_is_the_union_of_the_root_b_applications() -> None:
    """Every route a deployed function serves is reachable in the single process one."""
    root_a = _paths(build_domain_app(list(DOMAINS.values())))
    union: set[str] = set()
    for name in DOMAIN_NAMES:
        union |= _paths(build_domain_app(DOMAINS[name]))
    assert union == root_a


def test_each_domain_app_carries_only_its_own_repositories() -> None:
    """A deployed function's bundle matches the domain's declared data surface.

    Read through the dependency override, which is how a route resolves it, so
    this asserts what a request actually gets rather than a parallel record. The
    bundle carries what the domain writes plus what it only reads, because both
    reach a table through the same attribute access.
    """
    from app.common.api.dependencies.repositories import get_repositories

    for name in DOMAIN_NAMES:
        app = build_domain_app(DOMAINS[name])
        bundle = app.dependency_overrides[get_repositories]()
        assert set(bundle.repository_names) == set(DOMAINS[name].all_repositories)
        assert set(bundle.tables) == set(DOMAINS[name].tables) | set(DOMAINS[name].read_tables)


def test_a_bundle_excludes_every_table_its_domain_does_not_declare() -> None:
    """The invariant design section 2 lists: no reach beyond the declared surface.

    A repository outside the declaration raises rather than reaching a table the
    function holds no IAM grant on, so the code and the policy describe the same
    surface. Asserted per domain, because the bug this catches is one domain
    quietly using another's table.
    """
    from app.common.api.dependencies.repositories import (
        RepositoryNotInBundle,
        get_repositories,
    )
    from app.common.db.dynamo.registry import ALL_REPOSITORY_NAMES

    for name in DOMAIN_NAMES:
        app = build_domain_app(DOMAINS[name])
        bundle = app.dependency_overrides[get_repositories]()
        for repository in set(ALL_REPOSITORY_NAMES) - set(DOMAINS[name].all_repositories):
            with pytest.raises(RepositoryNotInBundle):
                getattr(bundle, repository)


def test_the_projects_domain_never_writes_a_table_it_does_not_own() -> None:
    """Projects owns project member rows in memberships but never touches workspaces or users.

    Those two stay read grants, so a project route cannot create a workspace or
    rewrite a user; it can only add and remove members of its own projects.
    """
    projects = DOMAINS["projects"]
    assert set(projects.tables) == {"projects", "project_config", "counters", "memberships"}
    assert set(projects.read_tables) == {"workspaces", "users"}
    assert not set(projects.tables) & set(projects.read_tables)


def test_a_read_repository_refuses_writes_in_every_domain_application() -> None:
    """Writing through a repository a domain only reads raises before any AWS call.

    This is the in-process twin of the `read_tables` IAM grant: a route that
    writes a table its function cannot write fails the suite rather than
    returning a DynamoDB AccessDenied 500 in staging.
    """
    from app.common.api.dependencies.repositories import get_repositories
    from app.common.db.dynamo.base import ReadOnlyTable

    checked = 0
    for name in DOMAIN_NAMES:
        domain = DOMAINS[name]
        bundle = build_domain_app(domain).dependency_overrides[get_repositories]()
        for repository in domain.read_repositories:
            if repository in domain.repositories:
                continue
            with pytest.raises(ReadOnlyTable):
                getattr(bundle, repository)._repository.put({"id": "never-written"})
            checked += 1
    assert checked > 0


def test_a_test_fixture_bound_to_a_domain_application_keeps_its_grants() -> None:
    """Binding an all-carrying bundle narrows it to the application's declared scope.

    Without this, every route test would run against every table writable and
    the moto suite could not catch a grant mismatch.
    """
    from app.common.api.dependencies.repositories import (
        ALL_REPOSITORY_NAMES,
        RepositoryNotInBundle,
        bind_repositories,
        build_bundle,
    )
    from app.common.db.dynamo.base import ReadOnlyTable

    app = build_domain_app(DOMAINS["projects"])
    bound = bind_repositories(app, build_bundle(ALL_REPOSITORY_NAMES, name="tests"))
    assert set(bound.repository_names) == set(DOMAINS["projects"].all_repositories)
    assert set(bound.read_only_names) == {"workspaces", "users"}
    with pytest.raises(ReadOnlyTable):
        bound.workspaces._repository.put({"id": "never-written"})
    with pytest.raises(RepositoryNotInBundle):
        bound.issues


def test_the_root_routes_are_served() -> None:
    """The probes the gateway and the Lambda adapter poll are always present."""
    paths = _paths(build_domain_app(DOMAINS["workspaces"]))
    assert {"/", "/health", "/ready"} <= paths


def test_a_domain_can_be_named_by_string() -> None:
    """Naming a domain by its registry key builds the same application."""
    assert _paths(build_domain_app("workspaces")) == _paths(build_domain_app(DOMAINS["workspaces"]))


def test_a_domain_that_verifies_api_keys_carries_the_repository() -> None:
    """Every domain resolving a key can reach `api_keys`, read only where it does not mint.

    `_api_key_claims` builds its store over the serving bundle, so a domain that
    authenticates a bearer without the repository would answer 401 for every valid
    key. `integrations` is the case that matters: the MCP route takes its workspace
    from the key's own tenant claim, so the verification has to succeed there.
    """
    from app.common.api.dependencies.repositories import get_repositories

    bundle = build_domain_app(DOMAINS["integrations"]).dependency_overrides[get_repositories]()
    assert "api_keys" in bundle.repository_names
    assert "api_keys" in bundle.read_only_names


def test_a_read_only_key_repository_still_authenticates() -> None:
    """A domain that only reads `api_keys` verifies a key instead of failing on the stamp.

    `verify` touches `last_used_at` on success, which a read-only grant refuses.
    The refusal is swallowed as telemetry, so the key still resolves: the grant
    costs the stamp and not the request.
    """
    from app.common.db.dynamo.api_keys import ApiKeyRepository
    from app.common.db.dynamo.base import READ_ONLY_HINT, ReadOnlyTable

    class RefusingRepository:
        """A repository whose writes refuse exactly as a read-only grant does."""

        table_name = "api_keys"

        def set_attributes(self, *args: object, **kwargs: object) -> None:
            """Refuse the stamp the way the package repository would."""
            raise ReadOnlyTable("api_keys", "set_attributes", READ_ONLY_HINT)

    keys = ApiKeyRepository.__new__(ApiKeyRepository)
    keys._repository = RefusingRepository()  # type: ignore[assignment]

    keys.touch("ws_1", "key_1")
