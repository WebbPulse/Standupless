"""The platform admin's Create GitHub App action, under `/api/admin/github-app`.

Three routes, every one behind `require_platform_admin`. The status route tells the
page whether this environment already has an App. The manifest route answers the
manifest, a signed state and the GitHub url the browser posts them to. The
conversions route is what the page GitHub redirects back to calls with the one-time
`code`: it redeems the state, exchanges the code, writes the credentials into the
`app` secret and answers the App's id and slug, and nothing else.

The redirect lands on the web app rather than on this API so the exchange is an
authenticated call like any other. That keeps the one route that writes a secret
behind the gateway's identity check, instead of adding a second unauthenticated
callback beside the install one.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.common.api.dependencies.authz import require_platform_admin
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.domains.admin import github_app

if TYPE_CHECKING:  # pragma: no cover
    from webbpulse.ops.config import SecretStore

router = APIRouter()

_log = logging.getLogger(__name__)

LOGO_PATH = "/github-app-logo.png"

BADGE_COLOR = "#141518"


class GitHubAppStatus(BaseModel):
    """Whether this environment can create an App, and whether it already has one."""

    configured: bool
    secret_available: bool
    organization: str
    app_name: str


class ManifestStart(BaseModel):
    """What the page posts to GitHub: the manifest, and the url carrying the signed state."""

    manifest: dict[str, object]
    post_url: str
    expires_at: str


class ConversionRequest(BaseModel):
    """The `code` and `state` GitHub sent the browser back with."""

    code: str = Field(min_length=1, max_length=128)
    state: str = Field(min_length=1, max_length=2048)


class CreatedApp(BaseModel):
    """The new App as the admin may see it, and where to finish its setup.

    Only the id and slug: the private key, client secret and webhook secret went
    straight into the `app` secret and are never answered.
    """

    id: int
    slug: str
    settings_url: str
    logo_path: str
    badge_color: str


def _refuse(code: int, error_code: str, message: str) -> HTTPException:
    """An error in the product's `{error_code, message}` shape."""
    return HTTPException(status_code=code, detail={"error_code": error_code, "message": message})


def _store() -> SecretStore:
    """The `app` secret store, or a 503 when this deployment has no secret to write to."""
    store = github_app.secret_store()
    if store is None:
        raise _refuse(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "NOT_CONFIGURED",
            "This environment has no app secret to store GitHub App credentials in.",
        )
    return store


def _refuse_if_configured(store: SecretStore) -> None:
    """A 409 when the `app` secret already names an App, so a second one cannot replace it silently."""
    if github_app.app_configured(store):
        raise _refuse(
            status.HTTP_409_CONFLICT,
            "ALREADY_CONFIGURED",
            "This environment already has a GitHub App. Remove its keys from the app secret to replace it.",
        )


@router.get("/github-app", response_model=GitHubAppStatus)
def github_app_status(user_id: str = Depends(require_platform_admin)) -> GitHubAppStatus:
    """Whether this environment has an App yet, for the admin page to choose what to show."""
    del user_id
    store = github_app.secret_store()
    return GitHubAppStatus(
        configured=store is not None and github_app.app_configured(store),
        secret_available=store is not None,
        organization=github_app.GITHUB_ORGANIZATION,
        app_name=github_app.app_name(),
    )


@router.post("/github-app/manifest", response_model=ManifestStart)
def start_github_app(user_id: str = Depends(require_platform_admin)) -> ManifestStart:
    """The manifest and signed state for one creation, refused when an App already exists."""
    _refuse_if_configured(_store())
    state, expires_at = github_app.mint_state(user_id)
    return ManifestStart(
        manifest=github_app.build_manifest(),
        post_url=github_app.creation_url(state),
        expires_at=expires_at.isoformat(),
    )


@router.post("/github-app/conversions", response_model=CreatedApp, status_code=status.HTTP_201_CREATED)
def convert_github_app(
    payload: ConversionRequest,
    user_id: str = Depends(require_platform_admin),
    repositories: Repositories = Depends(get_repositories),
) -> CreatedApp:
    """Exchange the manifest `code`, store the credentials, and answer only the id and slug."""
    from webbpulse.integrations.github import GitHubError
    from webbpulse.ops.config import ConfigToolError

    try:
        github_app.redeem_state(payload.state, user_id, repositories.idempotency)
    except github_app.ManifestStateError as error:
        raise _refuse(
            status.HTTP_400_BAD_REQUEST,
            "INVALID_STATE",
            "This link has expired or was already used. Start again from the admin page.",
        ) from error

    store = _store()
    _refuse_if_configured(store)

    try:
        conversion = github_app.convert(payload.code)
    except ValueError as error:
        raise _refuse(status.HTTP_400_BAD_REQUEST, "INVALID_CODE", "GitHub did not send back a usable code.") from error
    except GitHubError as error:
        _log.warning(
            "GitHub refused the App manifest conversion.",
            extra={"event": "admin.github_app_conversion_failed", "status_code": error.status_code},
        )
        raise _refuse(
            status.HTTP_502_BAD_GATEWAY,
            "GITHUB_UNAVAILABLE",
            "GitHub did not complete the App creation. The code works once and for an hour, so start again.",
        ) from error

    try:
        github_app.store_credentials(store, conversion, created_by=user_id)
    except ConfigToolError as error:
        _log.error(
            "Could not store the new GitHub App's credentials.",
            extra={
                "event": "admin.github_app_store_failed",
                "github_app_id": conversion.id,
                "github_app_slug": conversion.slug,
                "error_type": type(error).__name__,
            },
        )
        raise _refuse(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "STORE_FAILED",
            f"GitHub created the App {conversion.slug} but its credentials could not be stored. "
            "Delete that App on GitHub and start again.",
        ) from None

    return CreatedApp(
        id=conversion.id,
        slug=conversion.slug,
        settings_url=github_app.settings_url(conversion.slug),
        logo_path=LOGO_PATH,
        badge_color=BADGE_COLOR,
    )
