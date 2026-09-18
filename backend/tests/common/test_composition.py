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
    """Projects reads memberships, workspaces and users but owns none of them.

    The read grant is what keeps a project route from writing a membership row
    that only the workspaces function should ever create.
    """
    projects = DOMAINS["projects"]
    assert set(projects.tables) == {"projects", "project_config", "counters"}
    assert set(projects.read_tables) == {"memberships", "workspaces", "users"}
    assert not set(projects.tables) & set(projects.read_tables)


def test_the_root_routes_are_served() -> None:
    """The probes the gateway and the Lambda adapter poll are always present."""
    paths = _paths(build_domain_app(DOMAINS["workspaces"]))
    assert {"/", "/health", "/ready"} <= paths


def test_a_domain_can_be_named_by_string() -> None:
    """Naming a domain by its registry key builds the same application."""
    assert _paths(build_domain_app("workspaces")) == _paths(build_domain_app(DOMAINS["workspaces"]))
