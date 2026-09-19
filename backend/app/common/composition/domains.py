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
    """The workspaces router, plus the invite acceptance route beside it.

    Accepting an invite cannot sit under `/workspaces/{workspace_id}`: the caller
    is not yet a member of anything, and the token is what names the workspace.
    """
    from app.domains.workspaces.endpoints import workspaces

    return [
        (workspaces.router, "/workspaces", ("workspaces",)),
        (workspaces.invites_router, "/invites", ("workspaces",)),
    ]


def _projects_routers() -> "Sequence[RouterSpec]":
    """The projects domain: projects, their members, statuses and labels.

    Every path is nested under a workspace, so the tenant is in the path of each
    one and the authorization dependency reads it from there.
    """
    from app.domains.projects.endpoints import labels, members, projects, statuses

    return [
        (projects.router, "/workspaces", ("projects",)),
        (members.router, "/workspaces", ("projects",)),
        (statuses.router, "/workspaces", ("projects",)),
        (labels.router, "/workspaces", ("projects",)),
    ]


def _issues_routers() -> "Sequence[RouterSpec]":
    """The issues domain: issues, their links and their activity.

    Every path is nested under a workspace rather than a project, because an issue
    is workspace scoped and a link may cross projects; the routes decide visibility
    against each issue's own project.
    """
    from app.domains.issues.endpoints import activity, issues, links

    return [
        (issues.router, "/workspaces", ("issues",)),
        (links.router, "/workspaces", ("issues",)),
        (activity.router, "/workspaces", ("issues",)),
    ]


def _issues_unprefixed_routers(settings: "Any") -> "Sequence[APIRouter]":
    """The rollup consumer's route, at the adapter's pass-through path.

    Unprefixed because the Lambda Web Adapter posts a stream invocation outside
    `/api`, and a prefix would leave the event source mapping posting to a path the
    application does not serve.
    """
    from app.domains.issues.consumers.rollup import build_router

    return [build_router()]


def _views_routers() -> "Sequence[RouterSpec]":
    """The views domain: the board, saved views, search and the inbox.

    Every path is nested under a workspace, and the project comes from a query
    parameter or off the row rather than from the path, so each route decides
    visibility against the project the data actually belongs to.
    """
    from app.domains.views.endpoints import board, inbox, search, views

    return [
        (board.router, "/workspaces", ("views",)),
        (views.router, "/workspaces", ("views",)),
        (search.router, "/workspaces", ("views",)),
        (inbox.router, "/workspaces", ("views",)),
    ]


def _views_unprefixed_routers(settings: "Any") -> "Sequence[APIRouter]":
    """Both stream consumers' routes, at the adapter's pass-through path.

    Included here so the merged document and the local stack serve the same surface
    the two deployed consumer functions do. Each consumer also has an entrypoint of
    its own, which is what the deployed function runs; this is the composition root
    that holds the two in step.
    """
    from app.domains.views.consumers.notify import build_router as build_notify_router
    from app.domains.views.consumers.search import build_router as build_search_router

    return [build_notify_router(), build_search_router()]


_IDENTITY_REPOSITORIES: Tuple[str, ...] = ("users",)

_WORKSPACES_REPOSITORIES = ("workspaces", "memberships", "invites")

_WORKSPACES_READ_REPOSITORIES = ("users",)

_PROJECTS_REPOSITORIES = ("projects", "project_config", "counters")

_PROJECTS_READ_REPOSITORIES = ("memberships", "workspaces", "users")

_ISSUES_REPOSITORIES = ("issues", "relations", "activity", "counters")

_ISSUES_READ_REPOSITORIES = (
    "memberships",
    "workspaces",
    "users",
    "projects",
    "project_config",
    "planning",
)

_VIEWS_REPOSITORIES = ("views", "inbox", "search_index")

_VIEWS_READ_REPOSITORIES = (
    "memberships",
    "workspaces",
    "users",
    "projects",
    "project_config",
    "issues",
    "comments",
)


def _discussion_routers() -> "Sequence[RouterSpec]":
    """The discussion domain: comments, reactions and attachments.

    Nested under a workspace rather than an issue for the two id-addressed groups,
    because a comment and an attachment are reached by their own id while the issue
    that partitions them rides along as a query parameter. Every route still starts
    from an issue, so visibility is decided against one project.
    """
    from app.domains.discussion.endpoints import attachments, comments, reactions

    return [
        (comments.router, "/workspaces", ("discussion",)),
        (reactions.router, "/workspaces", ("discussion",)),
        (attachments.router, "/workspaces", ("discussion",)),
    ]


_DISCUSSION_REPOSITORIES = ("comments", "reactions", "attachments")

_DISCUSSION_READ_REPOSITORIES = ("memberships", "workspaces", "users", "projects", "issues")


def _planning_routers() -> "Sequence[RouterSpec]":
    """The planning domain: cycles, milestones and the workspace roadmap.

    Every path is nested under a workspace rather than a project, because the
    roadmap spans projects and a cycle is reached by its own id with the project
    riding along as a query parameter, so each route decides visibility against the
    project the row actually belongs to.
    """
    from app.domains.planning.endpoints import cycles, milestones, roadmap

    return [
        (cycles.router, "/workspaces", ("planning",)),
        (milestones.router, "/workspaces", ("planning",)),
        (roadmap.router, "/workspaces", ("planning",)),
    ]


def _planning_unprefixed_routers(settings: "Any") -> "Sequence[APIRouter]":
    """The rollup consumer's route, at the adapter's pass-through path.

    Included here so the merged document and the local stack serve the same surface
    the deployed consumer function does. The consumer also has an entrypoint of its
    own, which is what that function runs; this is the composition root that holds
    the two in step.
    """
    from app.domains.planning.consumers.rollup import build_router

    return [build_router()]


_PLANNING_REPOSITORIES = ("planning", "idempotency")

_PLANNING_READ_REPOSITORIES = (
    "memberships",
    "workspaces",
    "users",
    "projects",
    "project_config",
    "issues",
)


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
        read_repositories=_WORKSPACES_READ_REPOSITORIES,
    ),
    "projects": Domain(
        name="projects",
        title="Standupless projects",
        load_routers=_projects_routers,
        repositories=_PROJECTS_REPOSITORIES,
        read_repositories=_PROJECTS_READ_REPOSITORIES,
    ),
    "issues": Domain(
        name="issues",
        title="Standupless issues",
        load_routers=_issues_routers,
        load_unprefixed_routers=_issues_unprefixed_routers,
        repositories=_ISSUES_REPOSITORIES,
        read_repositories=_ISSUES_READ_REPOSITORIES,
    ),
    "views": Domain(
        name="views",
        title="Standupless views",
        load_routers=_views_routers,
        load_unprefixed_routers=_views_unprefixed_routers,
        repositories=_VIEWS_REPOSITORIES,
        read_repositories=_VIEWS_READ_REPOSITORIES,
    ),
    "discussion": Domain(
        name="discussion",
        title="Standupless discussion",
        load_routers=_discussion_routers,
        requires_secrets=("SECRET_KEY",),
        repositories=_DISCUSSION_REPOSITORIES,
        read_repositories=_DISCUSSION_READ_REPOSITORIES,
    ),
    "planning": Domain(
        name="planning",
        title="Standupless planning",
        load_routers=_planning_routers,
        load_unprefixed_routers=_planning_unprefixed_routers,
        repositories=_PLANNING_REPOSITORIES,
        read_repositories=_PLANNING_READ_REPOSITORIES,
    ),
}

DOMAIN_NAMES: Tuple[str, ...] = tuple(DOMAINS)

ENTRYPOINT_MODULES: Dict[str, str] = {name: name.replace("-", "_") for name in DOMAIN_NAMES}
