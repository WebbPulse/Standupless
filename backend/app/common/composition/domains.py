"""The domain registry: every deployable domain, as a descriptor carrying its routers.

Adding a domain is a new package under `app/domains/` plus one entry in `DOMAINS`.
Nothing else in the backend enumerates domains: the Dockerfile, both composition
roots and the Terraform function map all read this registry's names.

Importing this module imports no endpoint module: each loader does its own imports
in its body, which is what keeps one domain's image free of the rest.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Dict, Sequence, Tuple

from app.common.composition.wiring import Domain

if TYPE_CHECKING:  # pragma: no cover
    from fastapi import APIRouter

RouterSpec = Tuple["APIRouter", str, Tuple[str, ...]]


def _identity_routers() -> "Sequence[RouterSpec]":
    """No routers of its own. The package's router is all of `/api/auth`."""
    return []


def _identity_unprefixed_routers(settings: "Any") -> "Sequence[APIRouter]":
    """The shared package's identity router, which carries the issuer's own path.

    It mounts with no prefix; a prefix would double every path to
    `/api/auth/api/auth/...`. Empty when `IDENTITY_ISSUER` is unset, so a
    deployment without an issuer builds none of the glue's AWS clients.
    """
    if not settings.IDENTITY_ISSUER:
        return []

    from app.domains.identity.package_glue import build_router as build_identity_router

    return [build_identity_router(settings)]


def _workspaces_routers() -> "Sequence[RouterSpec]":
    """The workspaces router: the tenant every other key will be scoped to."""
    from app.domains.workspaces.endpoints import workspaces

    return [(workspaces.router, "/workspaces", ("workspaces",))]


_IDENTITY_REPOSITORIES: Tuple[str, ...] = ("users",)

_WORKSPACES_REPOSITORIES = ("workspaces",)


DOMAINS: Dict[str, Domain] = {
    "identity": Domain(
        name="identity",
        title="Standupless identity",
        load_routers=_identity_routers,
        load_unprefixed_routers=_identity_unprefixed_routers,
        repositories=_IDENTITY_REPOSITORIES,
    ),
    "workspaces": Domain(
        name="workspaces",
        title="Standupless workspaces",
        load_routers=_workspaces_routers,
        repositories=_WORKSPACES_REPOSITORIES,
    ),
}

DOMAIN_NAMES: Tuple[str, ...] = tuple(DOMAINS)

ENTRYPOINT_MODULES: Dict[str, str] = {name: name.replace("-", "_") for name in DOMAIN_NAMES}
