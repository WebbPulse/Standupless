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
    """The current-user route. Everything under `/api/auth` is the package's."""
    from app.domains.identity.endpoints import users

    return [(users.router, "/users", ("identity",))]


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
    from app.domains.workspaces.endpoints import api_keys, workspaces

    return [
        (workspaces.router, "/workspaces", ("workspaces",)),
        (workspaces.invites_router, "/invites", ("workspaces",)),
        (api_keys.router, "/workspaces", ("workspaces",)),
    ]


def _teams_routers() -> "Sequence[RouterSpec]":
    """The teams domain: teams, their members, statuses and labels.

    Every path is nested under a workspace, so the tenant is in the path of each
    one and the authorization dependency reads it from there.
    """
    from app.domains.teams.endpoints import labels, members, statuses, teams

    return [
        (teams.router, "/workspaces", ("teams",)),
        (members.router, "/workspaces", ("teams",)),
        (statuses.router, "/workspaces", ("teams",)),
        (labels.router, "/workspaces", ("teams",)),
    ]


def _issues_routers() -> "Sequence[RouterSpec]":
    """The issues domain: issues, their links, their activity and their subscribers.

    Every path is nested under a workspace rather than a team, because an issue
    is workspace scoped and a link may cross teams; the routes decide visibility
    against each issue's own team.
    """
    from app.domains.issues.endpoints import activity, issues, links, subscribers

    return [
        (issues.router, "/workspaces", ("issues",)),
        (links.router, "/workspaces", ("issues",)),
        (activity.router, "/workspaces", ("issues",)),
        (subscribers.router, "/workspaces", ("issues",)),
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

    Every path is nested under a workspace, and the team comes from a query
    parameter or off the row rather than from the path, so each route decides
    visibility against the team the data actually belongs to.
    """
    from app.domains.views.endpoints import board, inbox, search, share_links, views

    return [
        (board.router, "/workspaces", ("views",)),
        (views.router, "/workspaces", ("views",)),
        (search.router, "/workspaces", ("views",)),
        (inbox.router, "/workspaces", ("views",)),
        (share_links.router, "/workspaces", ("views",)),
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
    from app.domains.views.endpoints import shared

    return [build_notify_router(), build_search_router(), shared.router]


_IDENTITY_REPOSITORIES: Tuple[str, ...] = ("users",)

_IDENTITY_READ_REPOSITORIES: Tuple[str, ...] = ("memberships", "workspaces")
"""What the OAuth consent screen reads to offer a user their workspaces.

Consent has to name which workspace a token will be bound to, so it lists the
caller's memberships and reads each workspace for a display name. Both are reads:
authorization never writes a membership, and a token can only ever be issued for a
workspace the consenting user already belongs to.
"""

_WORKSPACES_REPOSITORIES = ("workspaces", "memberships", "invites", "api_keys")

_WORKSPACES_READ_REPOSITORIES = ("users",)

_TEAMS_REPOSITORIES = ("teams", "team_config", "counters", "memberships")

_TEAMS_READ_REPOSITORIES = ("workspaces", "users", "api_keys")

_ISSUES_REPOSITORIES = ("issues", "relations", "activity", "counters", "subscriptions")

_ISSUES_READ_REPOSITORIES = (
    "memberships",
    "workspaces",
    "users",
    "teams",
    "team_config",
    "planning",
    "api_keys",
)

_VIEWS_REPOSITORIES = ("views", "inbox", "search_index", "share_links")

_VIEWS_READ_REPOSITORIES = (
    "memberships",
    "workspaces",
    "users",
    "teams",
    "team_config",
    "issues",
    "comments",
    "subscriptions",
    "api_keys",
)


def _discussion_routers() -> "Sequence[RouterSpec]":
    """The discussion domain: comments, reactions and attachments.

    Nested under a workspace rather than an issue for the two id-addressed groups,
    because a comment and an attachment are reached by their own id while the issue
    that partitions them rides along as a query parameter. Every route still starts
    from an issue, so visibility is decided against one team.
    """
    from app.domains.discussion.endpoints import attachments, comments, reactions

    return [
        (comments.router, "/workspaces", ("discussion",)),
        (reactions.router, "/workspaces", ("discussion",)),
        (attachments.router, "/workspaces", ("discussion",)),
    ]


def _integrations_routers() -> "Sequence[RouterSpec]":
    """The integrations domain: the GitHub install, links, transitions and webhooks.

    The transition rules sit under a team and the issue links under an issue,
    because each is read where it is shown rather than from a settings page that
    would have to know every team.
    """
    from app.domains.integrations.endpoints import install, links, transitions, webhooks

    return [
        (install.router, "/workspaces", ("integrations",)),
        (webhooks.router, "/workspaces", ("integrations",)),
        (transitions.router, "/workspaces", ("integrations",)),
        (links.router, "/workspaces", ("integrations",)),
    ]


def _integrations_unprefixed_routers(settings: "Any") -> "Sequence[APIRouter]":
    """The routes GitHub itself calls, plus the three consumers.

    The callback and the webhook receiver are unprefixed here because they sit
    outside the workspace prefix: neither names a workspace, one being pre-install
    and the other resolving the tenant from the installation id instead. They carry
    their own `/api` inside the router, so the gateway sees `/api/github/...`.
    """
    from app.domains.integrations.consumers.dispatch import build_router as build_dispatch_router
    from app.domains.integrations.consumers.events import build_router as build_events_router
    from app.domains.integrations.consumers.stream import build_router as build_stream_router
    from app.domains.integrations.endpoints import github
    from app.domains.integrations.mcp import endpoint as mcp

    return [
        github.router,
        mcp.router,
        build_events_router(),
        build_dispatch_router(),
        build_stream_router(),
    ]


_DISCUSSION_REPOSITORIES = ("comments", "reactions", "attachments", "subscriptions")

_DISCUSSION_READ_REPOSITORIES = ("memberships", "workspaces", "users", "teams", "issues", "api_keys")

_INTEGRATIONS_REPOSITORIES = (
    "github",
    "idempotency",
    "team_config",
    "issues",
    "comments",
    "counters",
    "activity",
)

_INTEGRATIONS_READ_REPOSITORIES = (
    "memberships",
    "workspaces",
    "users",
    "teams",
    "api_keys",
)


def _planning_routers() -> "Sequence[RouterSpec]":
    """The planning domain: cycles, projects and the workspace roadmap.

    Every path is nested under a workspace rather than a team, because the
    roadmap spans teams and a cycle is reached by its own id with the team
    riding along as a query parameter, so each route decides visibility against the
    team the row actually belongs to.
    """
    from app.domains.planning.endpoints import cycles, projects, roadmap

    return [
        (cycles.router, "/workspaces", ("planning",)),
        (projects.router, "/workspaces", ("planning",)),
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
    "teams",
    "team_config",
    "issues",
    "api_keys",
)


DOMAINS: Dict[str, Domain] = {
    "identity": Domain(
        name="identity",
        title="Standupless identity",
        load_routers=_identity_routers,
        load_unprefixed_routers=_identity_unprefixed_routers,
        repositories=_IDENTITY_REPOSITORIES,
        read_repositories=_IDENTITY_READ_REPOSITORIES,
    ),
    "workspaces": Domain(
        name="workspaces",
        title="Standupless workspaces",
        load_routers=_workspaces_routers,
        repositories=_WORKSPACES_REPOSITORIES,
        read_repositories=_WORKSPACES_READ_REPOSITORIES,
    ),
    "teams": Domain(
        name="teams",
        title="Standupless teams",
        load_routers=_teams_routers,
        repositories=_TEAMS_REPOSITORIES,
        read_repositories=_TEAMS_READ_REPOSITORIES,
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
    "integrations": Domain(
        name="integrations",
        title="Standupless integrations",
        load_routers=_integrations_routers,
        load_unprefixed_routers=_integrations_unprefixed_routers,
        requires_secrets=("SECRET_KEY",),
        repositories=_INTEGRATIONS_REPOSITORIES,
        read_repositories=_INTEGRATIONS_READ_REPOSITORIES,
    ),
}

DOMAIN_NAMES: Tuple[str, ...] = tuple(DOMAINS)

ENTRYPOINT_MODULES: Dict[str, str] = {name: name.replace("-", "_") for name in DOMAIN_NAMES}
