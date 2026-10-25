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

Single sign-on mounts whenever this function can open a connection's client secret,
which needs the master key every deployed environment's app secret carries. Its
OIDC states and links are the package's own TTL tables, and a SAML assertion id is
claimed in the `idempotency` table, whose rows expire on their TTL, so a replayed
response is refused by every execution environment and no claim outlives the
assertion it guards.
"""

from __future__ import annotations

from functools import partial
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


def passkey_second_factor(identity_settings: Any) -> bool:
    """Whether a passkey answers the login MFA challenge, which needs passkeys and TOTP both on."""
    return bool(
        identity_settings.passkeys_enabled
        and identity_settings.passkeys_second_factor
        and identity_settings.totp_enabled
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
    The refresh token and login attempt stores are the audited ones, and every
    route captures its request, so sign-ins, revoked sessions and failed sign-ins
    reach the workspace audit log with the address and client that made them. A
    consent post also keeps its authorization parameters, which the consent store's
    third-party app gate needs to send a held member to the request page.
    """
    from dataclasses import replace

    from fastapi import APIRouter, Depends
    from webbpulse.identity import build_identity_router, signing_client

    from app.common.session_audit import capture_request, client_names_from, login_attempt_store, refresh_token_store
    from app.domains.identity.app_approval_gate import capture_consent_request
    from app.domains.identity.consent_theme import build_consent_theme
    from app.domains.identity.identity_hooks import StanduplessIdentityHooks

    identity_settings = build_identity_settings(settings)

    from app.domains.identity.oauth_server_glue import (
        build_oauth_server_stores,
        build_refresh_guard,
        refresh_allowed,
        resolve_tenants,
    )

    oauth_server_stores = build_oauth_server_stores(settings) if identity_settings.mcp_oauth_enabled else None

    client_names = client_names_from(oauth_server_stores.clients) if oauth_server_stores is not None else None
    stores = replace(
        build_identity_stores(settings),
        refresh_tokens=refresh_token_store(settings, client_names=client_names),
    )

    hooks = StanduplessIdentityHooks(
        totp_factors=stores.totp_factors if identity_settings.totp_enabled else None,
        passkeys=stores.passkeys if passkey_second_factor(identity_settings) else None,
    )

    router = build_identity_router(
        identity_settings,
        hooks,
        stores,
        kms_client=signing_client(identity_settings),
        service="standupless-identity",
        version=IDENTITY_ROUTER_VERSION,
        attempts=login_attempt_store(settings),
        email_sender=build_email_sender(identity_settings),
        oauth_client_secrets=build_oauth_client_secrets(settings),
        oauth_server_stores=oauth_server_stores,
        session_tenant_resolver=partial(resolve_tenants, has_two_factor=hooks.has_two_factor),
        refresh_guard=refresh_allowed if oauth_server_stores is None else build_refresh_guard(oauth_server_stores),
        consent_theme=build_consent_theme(),
        sso=build_sso_service(identity_settings, hooks, stores),
    )
    audited = APIRouter()
    audited.include_router(router, dependencies=[Depends(capture_request), Depends(capture_consent_request)])
    return audited


def build_sso_service(identity_settings: Any, hooks: Any, stores: Any) -> Any:
    """The single sign-on service, or `None` when this function has no master key to open secrets with.

    `None` mounts no single sign-on route at all, which is what a test application
    without an app secret wants. The URL guard trusts provider hosts only on the
    local stack, where the test provider runs over HTTP on loopback.
    """
    import logging

    from webbpulse.identity import PublicUrlGuard, SsoService

    from app.common.db.dynamo.idempotency import IdempotencyRepository
    from app.common.sso import SsoUnavailable, sso_cipher, trusted_provider_hosts
    from app.domains.identity.sso_hooks import StanduplessSsoHooks

    try:
        cipher = sso_cipher()
    except SsoUnavailable:
        logging.getLogger(__name__).info(
            "Single sign-on is not mounted: no master key is available.",
            extra={"event": "sso.unavailable"},
        )
        return None

    return SsoService(
        identity_settings,
        hooks,
        StanduplessSsoHooks(),
        states=stores.require_oauth_states(),
        links=stores.require_oauth_links(),
        cipher=cipher,
        url_guard=PublicUrlGuard(trusted_hosts=trusted_provider_hosts()),
        saml_replay=IdempotencyRepository().event_store,
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
