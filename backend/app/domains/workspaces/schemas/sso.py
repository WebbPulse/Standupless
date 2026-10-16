"""Request and response schemas for the workspace single sign-on routes.

No response ever carries a client secret, sealed or not: the settings page only
learns whether one is stored, so a stolen admin session cannot read it back.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field

from app.common.db.dynamo.memberships import SsoConnectionRow, SsoDomain


class SsoDomainCreate(BaseModel):
    """The body `POST /api/workspaces/{workspace_id}/sso/domains` takes."""

    domain: str = Field(min_length=3, max_length=254, description="The email domain to prove, such as example.com.")


class SsoDomainRead(BaseModel):
    """One domain and the TXT record that proves it."""

    domain: str
    verified: bool
    verified_at: Optional[datetime] = None
    added_at: datetime
    record_name: str = Field(description="Where the TXT record goes: the domain's apex.")
    record_type: str = Field(description="Always TXT.")
    record_value: str = Field(description="Exactly what the TXT record says.")

    @classmethod
    def from_row(cls, row: SsoDomain) -> "SsoDomainRead":
        """Build the response from a stored row and the challenge its token implies."""
        from webbpulse.identity import domain_verification_challenge

        from app.common.sso import SSO_VERIFICATION_PREFIX

        challenge = domain_verification_challenge(row.domain, row.token, prefix=SSO_VERIFICATION_PREFIX)
        return cls(
            domain=row.domain,
            verified=row.verified,
            verified_at=row.verified_at,
            added_at=row.added_at,
            record_name=challenge.record_name,
            record_type=challenge.record_type,
            record_value=challenge.record_value,
        )


class SsoConnectionUpdate(BaseModel):
    """The body `PUT /api/workspaces/{workspace_id}/sso/connection` takes.

    For OIDC, `oidc_client_secret` may be left out to keep the stored one. For SAML,
    either `saml_metadata_xml` or the three provider fields are given.
    """

    protocol: Literal["oidc", "saml"]
    display_name: str = Field(default="", max_length=80)
    oidc_issuer: str = Field(default="", max_length=2048)
    oidc_client_id: str = Field(default="", max_length=512)
    oidc_client_secret: str = Field(default="", max_length=4096)
    oidc_scopes: Optional[list[str]] = Field(default=None, max_length=20)
    saml_metadata_xml: str = Field(default="", max_length=262_144)
    saml_idp_entity_id: str = Field(default="", max_length=2048)
    saml_idp_sso_url: str = Field(default="", max_length=2048)
    saml_idp_certificate: str = Field(default="", max_length=16_384)


class SsoConnectionRead(BaseModel):
    """The stored connection, without its secret."""

    protocol: Literal["oidc", "saml"]
    display_name: str
    oidc_issuer: str
    oidc_client_id: str
    oidc_scopes: list[str]
    has_client_secret: bool
    saml_idp_entity_id: str
    saml_idp_sso_url: str
    saml_certificate_count: int
    tested: bool
    tested_at: Optional[datetime] = None
    updated_at: datetime

    @classmethod
    def from_row(cls, row: SsoConnectionRow) -> "SsoConnectionRead":
        """Build the response from a stored row."""
        return cls(
            protocol=row.protocol,
            display_name=row.display_name,
            oidc_issuer=row.oidc_issuer,
            oidc_client_id=row.oidc_client_id,
            oidc_scopes=list(row.oidc_scopes),
            has_client_secret=bool(row.oidc_sealed_secret),
            saml_idp_entity_id=row.saml_idp_entity_id,
            saml_idp_sso_url=row.saml_idp_sso_url,
            saml_certificate_count=len(row.saml_idp_certificates),
            tested=row.tested,
            tested_at=row.tested_at,
            updated_at=row.updated_at,
        )


class ServiceProviderRead(BaseModel):
    """What the workspace registers with its identity provider."""

    oidc_redirect_uri: str
    saml_acs_url: str
    saml_metadata_url: str
    saml_entity_id: str


class SsoSettingsRead(BaseModel):
    """Everything the single sign-on settings section shows."""

    available: bool = Field(description="Whether the workspace's plan includes single sign-on.")
    domains: list[SsoDomainRead]
    connection: Optional[SsoConnectionRead] = None
    require_sso: bool
    service_provider: ServiceProviderRead
    current_session_sso: bool = Field(
        description="Whether the caller's own session came through this workspace's connection."
    )
    can_require: bool = Field(
        description="Whether single sign-on can be required now: a tested connection and a verified domain."
    )


class SsoPolicyUpdate(BaseModel):
    """The body `PUT /api/workspaces/{workspace_id}/sso/policy` takes."""

    require_sso: bool = Field(description="Whether members must sign in through the workspace's connection.")


class SsoJoinRead(BaseModel):
    """The workspace a single sign-on session belongs to, after joining it if needed."""

    workspace_id: str
    slug: str
    name: str
    created: bool = Field(description="Whether this call made the caller a member.")
