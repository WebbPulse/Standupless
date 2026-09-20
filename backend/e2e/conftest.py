"""Product wiring for the `webbpulse.e2e` post-deploy suite.

Supplies what the plugin cannot know: the merged OpenAPI document the deployed
gateway routes against, the header names `@webbpulse/api-client` sends on a cross
origin request, and the browser contract naming the login form and every frontend
route.

This directory sits outside `tests/` so the unit CI, whose `testpaths` is `tests`,
never collects it. It installs as the `e2e` dependency group alone.
"""

from __future__ import annotations

import os
from collections.abc import Callable, Mapping, Sequence
from typing import Any

import pytest
from route_coverage_allowlist import UNCOVERED_BY_DESIGN
from webbpulse.e2e import LoginForm, RouteSpec

pytest_plugins = ["webbpulse.e2e"]

CORS_REQUEST_HEADERS = (
    "authorization",
    "content-type",
    "x-request-id",
    "x-retry-attempt",
)

PUBLIC_ROUTES = (
    ("/", "public"),
    ("/nonexistent-route-for-404-test", "public"),
)

GUEST_ONLY_ROUTES = (
    ("/login", "guest-only"),
    ("/register", "guest-only"),
    ("/forgot-password", "guest-only"),
)

PROTECTED_ROUTES = (("/workspaces", "protected"),)

_CLEANUP_CLIENT: dict[str, Any] = {}
"""Where the authenticated client is left for the cleanup hook, which takes no fixtures."""


COLLECTION_PLACEHOLDERS = {
    "E2E_ENVIRONMENT": "local",
    "E2E_API_BASE_URL": "http://localhost:8000",
    "E2E_WEB_BASE_URL": "http://localhost:5173",
    "E2E_AWS_REGION": "us-west-2",
    "E2E_RUN_ID": "collect-only",
    "E2E_USER_EMAIL": "collect-only@example.com",
    "E2E_USER_PASSWORD": "collect-only",
}
"""A local-shaped environment, used only when the run was given no environment at all."""


def pytest_configure(config: Any) -> None:
    """Let `--collect-only` describe the suite on a machine with no stage to point at.

    The plugin parametrises its coverage, reachability and route cut groups at
    collection time, so it builds the environment before any fixture runs and raises
    `MissingEnvironment` when the `E2E_*` variables are unset. That makes the shape of
    the suite unreadable outside CI, and it makes a syntax error in a new e2e module
    indistinguishable from an unconfigured shell, which is the opposite of what a
    collection check is for.

    Filling in a local-shaped placeholder set restores that. It applies only when
    `E2E_ENVIRONMENT` is unset, so a real run against a stage is never touched, and
    the values describe a local stack, so nothing here can point a run at staging or
    production. Every case that would call a gateway skips on the local environment
    anyway.
    """
    del config
    if os.environ.get("E2E_ENVIRONMENT", "").strip():
        return
    for name, value in COLLECTION_PLACEHOLDERS.items():
        os.environ.setdefault(name, value)


def _identity_environment() -> dict[str, str]:
    """The `IDENTITY_*` variables that decide which identity routes mount.

    `terraform/lambda_domains.tf` sets these on the deployed identity function, and
    the registry mounts the `webbpulse.identity` router only when `IDENTITY_ISSUER`
    is set, its OAuth routes only when a provider client id is present and its
    passkey routes only when passkeys are enabled. A document built without them
    would omit the `/api/auth` operations the gateway declares route keys for, and
    the coverage group would then pass while saying nothing about any of them.

    The issuer is derived from `E2E_API_BASE_URL` exactly as `terraform/identity.tf`
    renders it, so it describes the stage under test. No value here is read at run
    time by the deployed code; they only decide which routes the document declares.

    `IDENTITY_SIGNER=local` keeps the build from constructing a KMS client, which
    would need AWS credentials to describe routes that are never called here. The
    package refuses the local signer in production, so this cannot put a seed
    derived key in front of real users.
    """
    api_base_url = os.environ.get("E2E_API_BASE_URL", "").rstrip("/")
    environment = os.environ.get("E2E_ENVIRONMENT", "staging").strip()
    issuer = os.environ.get("E2E_ISSUER", "").rstrip("/") or f"{api_base_url}/api/auth"
    audience = os.environ.get("E2E_AUDIENCE", "") or f"standupless-{environment}-api"
    return {
        "TESTING": "true",
        "ENABLE_RATE_LIMITING": "false",
        "APP_ENVIRONMENT": environment,
        "SECRET_KEY": os.environ.get("SECRET_KEY", "e2e-openapi-build-only"),
        "IDENTITY_ENVIRONMENT": environment,
        "IDENTITY_ISSUER": issuer,
        "IDENTITY_AUDIENCE": audience,
        "IDENTITY_SIGNING_KEY_ARNS": '["arn:aws:kms:us-west-2:000000000000:key/openapi-build-only"]',
        "IDENTITY_SIGNER": "local",
        "IDENTITY_LOCAL_SIGNER_SEED": "openapi-build-only-not-a-real-key",
        "IDENTITY_REGISTRATION_ENABLED": "true",
        "IDENTITY_EPHEMERAL_USERS_ENABLED": "true",
        "IDENTITY_PASSKEYS_ENABLED": "true",
        "IDENTITY_GOOGLE_CLIENT_ID": "openapi-build-only",
        "IDENTITY_GITHUB_CLIENT_ID": "openapi-build-only",
        "IDENTITY_OAUTH_REDIRECT_URIS": f'["{issuer}/oauth/callback"]',
    }


def _bind_json_response() -> None:
    """Put `JSONResponse` in the namespace of every module that annotates a route with it.

    `webbpulse.identity.router` and its OAuth and passkey route modules import
    `JSONResponse` inside the function that declares the routes, so at module scope
    the `-> JSONResponse` annotation is an unresolvable forward reference and FastAPI
    raises `PydanticUserError` the moment it builds a response model for those
    operations. The deployed functions never generate their own document, so nothing
    else needs this. Binding the name resolves the reference and changes no served
    behaviour.
    """
    from fastapi.responses import JSONResponse
    from webbpulse.identity import oauth_routes, passkey_routes, router

    for module in (router, oauth_routes, passkey_routes):
        module.JSONResponse = JSONResponse  # type: ignore[attr-defined]


def e2e_openapi_document() -> Mapping[str, Any]:
    """The merged document the deployed gateway sees, built from Root A.

    Standupless deploys one application per domain, and
    `tests/common/test_composition.py` pins that the union of them is Root A exactly.
    So Root A is the merged document: one operation per route, each under its own
    domain's `/api` path, with the identity package's `/api/auth` routes included.

    Called at collection time, before any fixture runs, because the coverage and
    reachability groups are parametrised per operation.
    """
    os.environ.update(_identity_environment())
    _bind_json_response()

    from app.common.composition.app import build_app

    return build_app().openapi()


@pytest.fixture(scope="session")
def openapi_document() -> Mapping[str, Any]:
    """The merged document, for the fixtures that take it."""
    return e2e_openapi_document()


@pytest.fixture(scope="session")
def cors_request_headers() -> tuple[str, ...]:
    """The header names `@webbpulse/api-client` sends on every cross origin request.

    A gateway allow list missing any one of them rejects the browser's preflight and
    is invisible to a server side probe.
    """
    return CORS_REQUEST_HEADERS


@pytest.fixture
def track(api: Any, created_resources: list[Any]) -> "Callable[..., str]":
    """Register a resource's delete path so the session end sweep removes it.

    Returns the path it was given, so a caller can register and keep using it in one
    expression. Registration is by path rather than by handle because every product
    resource is deleted by a DELETE to where it was created, and a path is what the
    cleanup hook below can act on without knowing the domain.

    A route whose delete needs a query parameter, such as a comment needing its
    `issue_id`, passes it as `params`; the path alone would answer 422 and be
    reported as a leftover that is not one.
    """
    del api

    def _track(path: str, params: "dict[str, Any] | None" = None) -> str:
        """Remember one delete path, with any query it needs, and hand the path back."""
        created_resources.append(path if params is None else (path, dict(params)))
        return path

    return _track


def pytest_e2e_cleanup(env: Any, phase: str, created: Sequence[Any]) -> Any:
    """Delete what this run created, reporting whatever would not go.

    Only the end phase acts. The start sweep is meant to collect `e2e-` resources
    older than an hour, and this product has no list route that crosses tenants to
    find them with: every product resource this run makes hangs off a workspace it
    also made, so deleting the workspace collects the rest, and an orphan left by a
    dead run is not reachable from any other run's credentials.

    Deletion runs in reverse order of creation so a child goes before the workspace it
    belongs to. A path that answers 404 is already gone and is not reported; anything
    else is handed back as a leftover, which the plugin raises as a warning rather
    than failing the run on.
    """
    if phase != "end" or env.read_only:
        return ""

    session = _CLEANUP_CLIENT.get("api")
    if session is None:
        return ""

    leftovers: list[str] = []
    for item in reversed([entry for entry in created if isinstance(entry, (str, tuple))]):
        path, params = item if isinstance(item, tuple) else (item, None)
        try:
            response = session.delete(path, params=params) if params else session.delete(path)
        except Exception as error:
            leftovers.append(f"DELETE {path} raised {type(error).__name__}: {error}")
            continue
        if response.status_code not in (200, 202, 204, 404):
            leftovers.append(f"DELETE {path} answered {response.status_code}")
    return "; ".join(leftovers)


@pytest.fixture(scope="session", autouse=True)
def cleanup_client(e2e_env: Any, request: pytest.FixtureRequest) -> None:
    """Give the cleanup hook the authenticated client, which it has no other way to reach.

    `pytest_e2e_cleanup` is a hook, not a fixture, so it receives only the environment,
    and `E2EEnvironment` is frozen so it cannot carry the client either. A module level
    holder is the one place both can reach. A read-only run and a run that never signed
    in both leave it unset, and the hook then reports nothing rather than attempting a
    delete with no identity.
    """
    if e2e_env.read_only:
        return
    try:
        _CLEANUP_CLIENT["api"] = request.getfixturevalue("api")
    except Exception:
        _CLEANUP_CLIENT["api"] = None


def pytest_e2e_login_form(env: Any) -> LoginForm:
    """Where the login form lives and which elements prove the state changed.

    Every locator is the plugin's own default except the signed out marker, because
    the auth pages carry the conventional `data-testid` attributes. Signing out lands
    on `/`, where no login form renders, so the header's login link is the marker
    rather than the submit button.
    """
    del env
    return LoginForm(path="/login", signed_out_marker="[data-testid=signed-out]")


def pytest_e2e_routes(env: Any) -> list[RouteSpec]:
    """Every frontend route the app serves, and who is allowed to see it.

    Day one is the auth shell plus one authenticated placeholder, so this is short.
    It grows with the product UI, which the design doc has yet to specify.
    """
    del env
    declared = PUBLIC_ROUTES + GUEST_ONLY_ROUTES + PROTECTED_ROUTES
    return [RouteSpec(path=path, access=access) for path, access in declared]


def pytest_e2e_journeys(env: Any) -> list[Any]:
    """No product journeys yet.

    A journey drives a flow through the real UI, and the only authenticated page is
    a placeholder. The first journey arrives with the first real screen.
    """
    del env
    return []


def pytest_e2e_uncovered_routes(env: Any) -> "dict[tuple[str, str], str]":
    """The routes this product knowingly leaves unexercised, each with its reason.

    Only the allowlist is the product's. The template matching, the staleness check
    and the empty reason check are the plugin's, so the exceptions live here and the
    logic that judges them does not.
    """
    del env
    return UNCOVERED_BY_DESIGN
