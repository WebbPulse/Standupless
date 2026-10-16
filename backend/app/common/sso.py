"""Single sign-on pieces the workspaces and identity functions share.

The workspaces function stores a connection and seals its client secret, and the
identity function opens that secret to run a sign-in, so both build the same
cipher from the same master key here. Both also need the service provider URLs a
workspace registers with its identity provider, which are derived from the issuer
rather than configured, so the settings page can never show a URL the identity
function does not serve.

Two seams exist for the local stack only, where no public DNS record can be
published and the test identity provider runs on loopback over plain HTTP. Each is
honoured only when `APP_ENVIRONMENT` is `local`, so a deployed function ignores
them whatever its environment says.
"""

from __future__ import annotations

import base64
import os
from collections.abc import Sequence
from typing import TYPE_CHECKING, Any, Final

from app.common.core.config import settings

if TYPE_CHECKING:  # pragma: no cover
    from webbpulse.identity import SsoConnection
    from webbpulse.identity.crypto import TotpCipher

    from app.common.db.dynamo.memberships import SsoConnectionRow, SsoDomain

SSO_VERIFICATION_PREFIX: Final = "standupless"
"""The TXT record prefix: a domain proves itself with `standupless-verification=<token>`."""

LOCAL_ENVIRONMENT: Final = "local"

TRUSTED_HOSTS_VARIABLE: Final = "SSO_TRUSTED_HOSTS"
"""Comma separated provider hosts the local stack may fetch over HTTP on loopback."""

SKIP_DNS_VARIABLE: Final = "SSO_SKIP_DNS_VERIFICATION"
"""`true` lets the local stack treat a domain as verified without a DNS lookup."""


class SsoUnavailable(Exception):
    """This function has no master key to seal or open a client secret with."""


def local_overrides_allowed() -> bool:
    """Whether this process is the local stack, the only place the test seams apply."""
    return settings.APP_ENVIRONMENT.strip().lower() == LOCAL_ENVIRONMENT


def trusted_provider_hosts() -> tuple[str, ...]:
    """Provider hosts exempt from the HTTPS and public address checks, on the local stack only."""
    if not local_overrides_allowed():
        return ()
    raw = os.environ.get(TRUSTED_HOSTS_VARIABLE, "")
    return tuple(host.strip().lower() for host in raw.split(",") if host.strip())


def dns_checks_skipped() -> bool:
    """Whether domain verification answers yes without DNS, which only the local stack allows."""
    return local_overrides_allowed() and os.environ.get(SKIP_DNS_VARIABLE, "").strip().lower() == "true"


def domain_is_verified(domain: str, token: str) -> bool:
    """Whether the domain publishes its TXT record now.

    Raises `DomainVerificationUnavailable` when DNS cannot answer, so a timeout is
    reported as such rather than as a missing record.
    """
    if dns_checks_skipped():
        return True
    from webbpulse.identity import is_domain_verified

    return bool(is_domain_verified(domain, token, prefix=SSO_VERIFICATION_PREFIX))


def sso_cipher() -> "TotpCipher":
    """The cipher a connection's client secret is sealed and opened with.

    The master key is the app secret's `mfa_master_key`, the one TOTP seeds use. Each
    sealed value is bound to its connection and to the client secret purpose, so it
    cannot be opened as a seed or as another workspace's secret. Raises
    `SsoUnavailable` when no source has the key.
    """
    from webbpulse.identity.crypto import SecretMasterKeyCipher, resolve_totp_master_key

    arn = os.environ.get("APP_SECRETS_ARN", "") or settings.APP_SECRETS_ARN or None
    resolved = resolve_totp_master_key(secret_arn=arn)
    if not resolved:
        raise SsoUnavailable("No master key is available to seal a single sign-on client secret.")
    try:
        raw = base64.b64decode(resolved.encode("ascii"), validate=True)
        return SecretMasterKeyCipher(raw)
    except ValueError as exc:
        raise SsoUnavailable("The master key for single sign-on client secrets is unusable.") from exc


def identity_issuer() -> str:
    """The identity issuer URL, without a trailing slash."""
    return settings.IDENTITY_ISSUER.strip().rstrip("/")


def service_provider_urls(workspace_id: str) -> dict[str, str]:
    """What a workspace registers with its identity provider, for both protocols.

    These are the paths the identity package serves for a connection whose id is the
    workspace id, which is the one connection a workspace has.
    """
    issuer = identity_issuer()
    metadata_url = f"{issuer}/sso/saml/{workspace_id}/metadata"
    return {
        "oidc_redirect_uri": f"{issuer}/sso/oidc/{workspace_id}/callback",
        "saml_acs_url": f"{issuer}/sso/saml/{workspace_id}/acs",
        "saml_metadata_url": metadata_url,
        "saml_entity_id": metadata_url,
    }


def normalise_certificate(certificate: str) -> str:
    """A signing certificate as PEM, or `ValueError` when it does not parse as X.509."""
    from cryptography import x509

    text = certificate.strip()
    if "BEGIN CERTIFICATE" not in text:
        body = "".join(text.split())
        lines = [body[index : index + 64] for index in range(0, len(body), 64)]
        text = "-----BEGIN CERTIFICATE-----\n" + "\n".join(lines) + "\n-----END CERTIFICATE-----"
    x509.load_pem_x509_certificate(text.encode("ascii"))
    return text + "\n"


def build_connection(
    row: "SsoConnectionRow",
    domains: Sequence["SsoDomain"],
    *,
    enabled: bool,
) -> "SsoConnection":
    """The package's connection for a stored row and the workspace's verified domains.

    `enabled` is false when the workspace's plan no longer includes single sign-on,
    which makes the identity package refuse every start and callback for it.
    """
    from webbpulse.identity import OidcConnectionConfig, SamlConnectionConfig, SsoConnection
    from webbpulse.identity.crypto import SealedSecret

    oidc: Any = None
    saml: Any = None
    if row.protocol == "oidc":
        sealed = SealedSecret.from_item(row.oidc_sealed_secret)
        if sealed is not None and row.oidc_issuer and row.oidc_client_id:
            oidc = OidcConnectionConfig(
                issuer=row.oidc_issuer,
                client_id=row.oidc_client_id,
                sealed_client_secret=sealed,
                scopes=tuple(row.oidc_scopes) or ("openid", "email", "profile"),
            )
    elif row.saml_idp_entity_id and row.saml_idp_sso_url and row.saml_idp_certificates:
        saml = SamlConnectionConfig(
            idp_entity_id=row.saml_idp_entity_id,
            idp_sso_url=row.saml_idp_sso_url,
            idp_certificates=tuple(row.saml_idp_certificates),
        )
    return SsoConnection(
        connection_id=row.workspace_id,
        tenant_id=row.workspace_id,
        protocol=row.protocol,
        verified_domains=tuple(domain.domain for domain in domains if domain.verified),
        enabled=enabled and (oidc is not None or saml is not None),
        jit_provisioning=True,
        display_name=row.display_name,
        oidc=oidc,
        saml=saml,
    )
