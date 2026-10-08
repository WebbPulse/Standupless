"""Mounts the `webbpulse.identity` package router onto the identity domain.

The router carries the issuer's own path, so it is mounted with no prefix; a
prefix would double every path to `/api/auth/api/auth/...`.

The signing client follows the package's own `IDENTITY_SIGNER` switch rather than
being a `boto3.client("kms")` this module names, so a local stack signs in process
with no AWS credential at all. The package refuses the local signer in production,
so the switch cannot put a seed derived key in front of real users.

The OAuth 2.1 authorization server mounts behind the package's `mcp_oauth_enabled`
switch. Its stores are built only when that switch is on, because they are the one
thing the package refuses to mount without, and a deployment that does not host an
MCP resource should reach none of their tables.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover
    from fastapi import APIRouter

    from app.common.core.config import Settings

IDENTITY_ROUTER_VERSION = "1.0.0"

OAUTH_SECRET_KEYS = {
    "google": "OAUTH_GOOGLE_CLIENT_SECRET",
    "github": "OAUTH_GITHUB_CLIENT_SECRET",
}


def build_identity_settings(settings: "Settings") -> Any:
    """`IdentitySettings` for this product, read straight from the environment.

    Every field arrives through an `IDENTITY_*` variable Terraform sets, so this is
    very nearly a bare constructor call. Raises `ValidationError` on a bad environment.

    `mcp_scopes_supported` is pinned to this product's scope set. The authorization
    server may grant only what a route will honour, and an environment that could set
    the two apart would mint tokens carrying scopes no route has ever heard of.

    The email logo, accents and theme come from `app.common.email.brand`, so the sign
    in and password emails the package sends share the product emails' brand. The logo URL is
    built from the frontend origin of this environment rather than another variable.
    """
    from webbpulse.identity import IdentitySettings

    from app.common.email.brand import BRAND_ACCENT, BRAND_ACCENT_DARK, EMAIL_THEME, logo_url
    from app.domains.identity.oauth_server_glue import MCP_SCOPES

    del settings
    return IdentitySettings(  # pyright: ignore[reportCallIssue]
        mcp_scopes_supported=list(MCP_SCOPES),
        logo_url=logo_url(),
        email_accent_color=BRAND_ACCENT,
        email_dark_accent_color=BRAND_ACCENT_DARK,
        email_theme=EMAIL_THEME,
    )


def build_identity_stores(settings: "Settings") -> Any:
    """Every identity store over this product's tables, the `api-keys` store included.

    The `api-keys` store is what lets the users-table stream purge delete a deleted
    user's API keys. The identity module creates that table and its role policy covers
    it, so opting in cannot fail the purge on a missing grant.
    """
    from webbpulse.identity import dynamo_stores

    return dynamo_stores(
        settings.dynamodb_table_prefix,
        endpoint_url=settings.DYNAMODB_ENDPOINT_URL or None,
        api_keys=True,
    )


def build_router(settings: "Settings") -> "APIRouter":
    """The identity router, mounted by the caller with no prefix of its own.

    Which route groups mount depends on what is supplied: credentials mount the
    flow routes, an email sender and token store the email routes, and so on.
    """
    from webbpulse.identity import build_identity_router, dynamo_login_attempts, signing_client

    from app.domains.identity.consent_theme import build_consent_theme
    from app.domains.identity.identity_hooks import StanduplessIdentityHooks

    identity_settings = build_identity_settings(settings)

    stores = build_identity_stores(settings)

    from app.domains.identity.oauth_server_glue import build_oauth_server_stores, resolve_tenants

    oauth_server_stores = build_oauth_server_stores(settings) if identity_settings.mcp_oauth_enabled else None

    return build_identity_router(
        identity_settings,
        StanduplessIdentityHooks(),
        stores,
        kms_client=signing_client(identity_settings),
        service="standupless-identity",
        version=IDENTITY_ROUTER_VERSION,
        attempts=dynamo_login_attempts(
            settings.dynamodb_table_prefix,
            endpoint_url=settings.DYNAMODB_ENDPOINT_URL or None,
        ),
        email_sender=build_email_sender(identity_settings),
        oauth_client_secrets=build_oauth_client_secrets(settings),
        oauth_server_stores=oauth_server_stores,
        tenant_resolver=resolve_tenants,
        consent_theme=build_consent_theme(),
    )


def build_oauth_client_secrets(settings: "Settings") -> dict[str, str]:
    """The OAuth client secrets from the single app secret, possibly empty.

    An empty result is correct: with no client id the package declares no OAuth
    route. The environment is consulted ahead of the secret, as elsewhere.
    """
    import os

    from webbpulse.security import app_secrets

    arn = os.environ.get("APP_SECRETS_ARN", "") or settings.APP_SECRETS_ARN

    from_env = {provider: os.environ[key] for provider, key in OAUTH_SECRET_KEYS.items() if os.environ.get(key)}
    if len(from_env) == len(OAUTH_SECRET_KEYS) or not arn:
        return from_env

    loaded = app_secrets(arn)
    return {
        provider: from_env.get(provider) or loaded[key]
        for provider, key in OAUTH_SECRET_KEYS.items()
        if from_env.get(provider) or loaded.get(key)
    }


def build_email_sender(identity_settings: Any) -> Any:
    """The `EmailSender` for the email routes, or `None` when SES is absent.

    `None` is a supported state: the package then declares no email route rather
    than several that answer 503. The client is built here, never at import.
    """
    if not identity_settings.email_from:
        return None

    import boto3
    from webbpulse.identity.email import SesV2EmailSender

    return SesV2EmailSender.from_settings(identity_settings, boto3.client("sesv2"))
