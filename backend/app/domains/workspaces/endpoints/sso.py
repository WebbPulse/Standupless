"""Workspace single sign-on routes: prove a domain, connect a provider, test it, then require it.

Setting single sign-on up is for a workspace owner or admin, from a signed in
session only, and saving the connection is for an owner alone: the provider it
names can sign in as anyone on the verified domains, so an admin pointing it at
a provider of their own would reach every account there, owners included. Every
step that widens who can sign in, adding or verifying a domain, saving a
connection, recording a test and turning the requirement on, needs a plan that
includes single sign-on; removing things and turning the requirement off are
always allowed, so a downgraded workspace can still undo it.

The sign-in itself is the identity function's: these routes only store the rows it
reads. The one exception is joining, `POST /sso/join`, which the sign-in page calls
after a session arrives from a connection, because adding a member belongs with
the member cap here. That route has no workspace in its path, so it reads the
workspace from the session's own `sso_connection` claim.

This router is included before the approved domains router, so `POST /sso/join`
is matched before `POST /{workspace_id}/join` could read `sso` as an id.
"""

from __future__ import annotations

from typing import Annotated, Any, Optional
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Path, Request, Response, status
from webbpulse.dynamodb import TransactionCanceled

from app.common import audit, plan_usage, scim
from app.common.api.dependencies.authz import (
    AuthzContext,
    Capability,
    caller_claims,
    refuse_api_key_actor,
    refuse_delegated_claims,
    request_context,
    require,
    sso_connection_of,
)
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.workspaces import display_name_for
from app.common.approved_domains import PUBLIC_EMAIL_PROVIDERS
from app.common.billing import sync_seats
from app.common.db.dynamo.memberships import (
    SSO_DOMAIN_LIMIT,
    Membership,
    SsoConnectionRow,
    SsoDomain,
    SsoDomainTaken,
    workspace_member_key,
)
from app.common.db.dynamo.users import User
from app.common.plan_features import Feature, enforce_feature, has_feature
from app.common.plan_limits import LimitedResource
from app.domains.workspaces.endpoints.workspaces import refuse_deleted_caller
from app.domains.workspaces.schemas.sso import (
    ServiceProviderRead,
    SsoConnectionRead,
    SsoConnectionUpdate,
    SsoDomainCreate,
    SsoDomainRead,
    SsoJoinRead,
    SsoPolicyUpdate,
    SsoSettingsRead,
)

router = APIRouter()

INVALID_DOMAIN = {"error_code": "INVALID_DOMAIN", "message": "Enter a domain such as example.com."}

PUBLIC_DOMAIN = {
    "error_code": "PUBLIC_EMAIL_DOMAIN",
    "message": "Public email providers cannot be used for single sign-on, because nobody owns them.",
}

TOO_MANY_DOMAINS = {
    "error_code": "LIMIT_EXCEEDED",
    "message": f"A workspace can use at most {SSO_DOMAIN_LIMIT} domains for single sign-on.",
}

DOMAIN_NOT_FOUND = {"error_code": "NOT_FOUND", "message": "That domain is not listed for single sign-on."}

DOMAIN_TAKEN = {
    "error_code": "SSO_DOMAIN_TAKEN",
    "message": "Another workspace already verified this domain for single sign-on.",
}

DOMAIN_RECORD_MISSING = {
    "error_code": "SSO_DOMAIN_UNVERIFIED",
    "message": "We could not find the TXT record yet. DNS changes can take a while to appear, so try again soon.",
}

DNS_UNAVAILABLE = {
    "error_code": "SSO_DNS_UNAVAILABLE",
    "message": "DNS did not answer just now, so the domain could not be checked. Try again in a minute.",
}

LAST_DOMAIN_IN_USE = {
    "error_code": "SSO_REQUIRED_IN_USE",
    "message": "Turn off Require single sign-on before removing the last verified domain.",
}

CONNECTION_IN_USE = {
    "error_code": "SSO_REQUIRED_IN_USE",
    "message": "Turn off Require single sign-on before changing or removing the connection.",
}

CONNECTION_NOT_FOUND = {"error_code": "NOT_FOUND", "message": "This workspace has no single sign-on connection."}

SECRETS_UNAVAILABLE = {
    "error_code": "SSO_UNAVAILABLE",
    "message": "Single sign-on cannot store a client secret right now. Try again later.",
}

NOT_THROUGH_CONNECTION = {
    "error_code": "SSO_TEST_REQUIRED",
    "message": "Sign in through this workspace's connection first, then record the test.",
}

OWNER_ONLY_CONNECTION = {
    "error_code": "FORBIDDEN",
    "message": (
        "Only an owner can change the identity provider, because it can sign in as anyone on your verified domains."
    ),
}

NOT_READY = {
    "error_code": "SSO_NOT_READY",
    "message": "Verify a domain and complete a test sign-in before requiring single sign-on.",
}

SIGN_IN_WITH_SSO_FIRST = {
    "error_code": "SSO_SESSION_REQUIRED",
    "message": "Sign in with single sign-on before requiring it, so you know it works for you.",
}

NOT_AN_SSO_SESSION = {
    "error_code": "SSO_SESSION_REQUIRED",
    "message": "This session did not come through single sign-on.",
}

JOIN_NOT_ALLOWED = {
    "error_code": "SSO_DOMAIN_NOT_VERIFIED",
    "message": "Your email address is not on a domain this workspace verified.",
}

OIDC_SCOPES_DEFAULT = ["openid", "email", "profile"]


def _invalid(field: str, message: str) -> HTTPException:
    """The 422 for one unusable connection field."""
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail={"error_code": "SSO_CONNECTION_INVALID", "message": message, "details": {"field": field}},
    )


def _normalise(value: str) -> str:
    """A domain as the identity package stores it, or a 422 when it is not one."""
    from webbpulse.identity import normalise_domain

    try:
        domain = str(normalise_domain(value.strip().lstrip("@")))
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=INVALID_DOMAIN) from exc
    return domain


def _provider_url(value: str, field: str) -> str:
    """A provider URL, which must be HTTPS except for a trusted host on the local stack."""
    from app.common.sso import trusted_provider_hosts

    url = value.strip()
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    if not host:
        raise _invalid(field, "Enter a full URL, starting with https://.")
    if parts.scheme == "https" or (parts.scheme == "http" and host in trusted_provider_hosts()):
        return url.rstrip("/") if field == "oidc_issuer" else url
    raise _invalid(field, "The URL must start with https://.")


def _settings(repositories: Repositories, context: AuthzContext) -> SsoSettingsRead:
    """Everything the settings section shows, read fresh."""
    from app.common.sso import service_provider_urls

    workspace_id = context.workspace_id
    domains = repositories.memberships.list_sso_domains(workspace_id)
    connection = repositories.memberships.get_sso_connection(workspace_id)
    policy = repositories.memberships.get_auth_policy(workspace_id)
    workspace = repositories.workspaces.get(workspace_id)
    return SsoSettingsRead(
        available=has_feature(workspace, Feature.SSO),
        domains=[SsoDomainRead.from_row(row) for row in domains],
        connection=None if connection is None else SsoConnectionRead.from_row(connection),
        require_sso=policy.require_sso,
        service_provider=ServiceProviderRead(**service_provider_urls(workspace_id)),
        current_session_sso=_signed_in_through(context, connection),
        can_require=_ready(connection, domains),
    )


def _ready(connection: Optional[SsoConnectionRow], domains: list[SsoDomain]) -> bool:
    """Whether a tested connection and at least one verified domain exist."""
    return connection is not None and connection.tested and any(row.verified for row in domains)


def _admin(context: AuthzContext) -> AuthzContext:
    """Refuse an API key, which never changes how the people of a workspace sign in."""
    refuse_api_key_actor(context)
    return context


def _signed_in_through(context: AuthzContext, connection: Optional[SsoConnectionRow]) -> bool:
    """Whether the caller's session came through this workspace's connection as it is now saved.

    A session from before the connection's last save proves the old settings, not
    the current ones, so it counts only when its `auth_time` is at or after that save.
    """
    if connection is None or context.sso_connection != context.workspace_id:
        return False
    return context.auth_time >= int(connection.updated_at.timestamp())


@router.get("/{workspace_id}/sso", response_model=SsoSettingsRead)
def read_sso(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> SsoSettingsRead:
    """The workspace's single sign-on domains, connection and requirement."""
    return _settings(repositories, _admin(context))


@router.post("/{workspace_id}/sso/domains", response_model=SsoDomainRead, status_code=status.HTTP_201_CREATED)
def add_sso_domain(
    payload: SsoDomainCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> SsoDomainRead:
    """List a domain to prove, answering the TXT record that proves it."""
    from webbpulse.identity import new_domain_verification_token

    _admin(context)
    enforce_feature(repositories, context.workspace_id, Feature.SSO)
    domain = _normalise(payload.domain)
    if domain in PUBLIC_EMAIL_PROVIDERS:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=PUBLIC_DOMAIN)
    existing = repositories.memberships.list_sso_domains(context.workspace_id)
    if domain not in {row.domain for row in existing} and len(existing) >= SSO_DOMAIN_LIMIT:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=TOO_MANY_DOMAINS)
    row = repositories.memberships.add_sso_domain(
        context.workspace_id,
        domain,
        token=new_domain_verification_token(),
        added_by=context.user_id,
    )
    if domain not in {item.domain for item in existing}:
        audit.record(
            repositories,
            context,
            "sso.domain_added",
            target_type="sso_domain",
            target_id=domain,
            target_label=domain,
        )
    return SsoDomainRead.from_row(row)


@router.post("/{workspace_id}/sso/domains/{domain}/verify", response_model=SsoDomainRead)
def verify_sso_domain(
    domain: Annotated[str, Path(min_length=3, max_length=254)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> SsoDomainRead:
    """Look the domain's TXT record up now, and claim the domain for this workspace when it is there.

    The claim is a conditional write, so of two workspaces verifying one domain at
    once only one wins and the other is answered `SSO_DOMAIN_TAKEN`. A domain whose
    verification lapsed is verified again the same way.
    """
    from webbpulse.identity import DomainVerificationUnavailable

    from app.common.sso import domain_is_verified

    _admin(context)
    enforce_feature(repositories, context.workspace_id, Feature.SSO)
    name = _normalise(domain)
    row = repositories.memberships.get_sso_domain(context.workspace_id, name)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=DOMAIN_NOT_FOUND)
    claim = repositories.memberships.get_sso_domain_claim(name)
    if claim is not None and claim.holder_workspace_id == context.workspace_id and row.verified:
        return SsoDomainRead.from_row(row)
    if claim is not None and claim.holder_workspace_id != context.workspace_id:
        if not repositories.memberships.sso_domain_claim_is_stale(claim):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=DOMAIN_TAKEN)
    try:
        found = domain_is_verified(name, row.token)
    except DomainVerificationUnavailable as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=DNS_UNAVAILABLE) from exc
    if not found:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=DOMAIN_RECORD_MISSING)
    try:
        verified = repositories.memberships.mark_sso_domain_verified(row, verified_by=context.user_id)
    except SsoDomainTaken as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=DOMAIN_TAKEN) from exc
    except TransactionCanceled:
        if repositories.memberships.get_sso_domain(context.workspace_id, name) is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=DOMAIN_NOT_FOUND) from None
        raise
    audit.record(
        repositories,
        context,
        "sso.domain_verified",
        target_type="sso_domain",
        target_id=name,
        target_label=name,
    )
    return SsoDomainRead.from_row(verified)


@router.delete("/{workspace_id}/sso/domains/{domain}", status_code=status.HTTP_204_NO_CONTENT)
def remove_sso_domain(
    domain: Annotated[str, Path(min_length=3, max_length=254)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> Response:
    """Stop using a domain for single sign-on. Idempotent.

    The last verified domain cannot go while single sign-on is required, because
    nobody could then sign in through the connection.
    """
    _admin(context)
    name = _normalise(domain)
    rows = repositories.memberships.list_sso_domains(context.workspace_id)
    row = next((item for item in rows if item.domain == name), None)
    if row is None:
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    others_verified = any(item.verified for item in rows if item.domain != name)
    required = repositories.memberships.get_auth_policy(context.workspace_id).require_sso
    if row.verified and not others_verified and required:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=LAST_DOMAIN_IN_USE)
    repositories.memberships.remove_sso_domain(context.workspace_id, name)
    audit.record(
        repositories,
        context,
        "sso.domain_removed",
        target_type="sso_domain",
        target_id=name,
        target_label=name,
        before={"verified": row.verified},
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _oidc_row(
    payload: SsoConnectionUpdate,
    current: Optional[SsoConnectionRow],
    context: AuthzContext,
) -> dict[str, Any]:
    """The OIDC fields of a connection, sealing a new client secret or keeping the stored one."""
    from webbpulse.identity.sso_oidc import seal_oidc_client_secret

    from app.common.sso import SsoUnavailable, sso_cipher

    issuer = _provider_url(payload.oidc_issuer, "oidc_issuer")
    client_id = payload.oidc_client_id.strip()
    if not client_id:
        raise _invalid("oidc_client_id", "Enter the client ID your identity provider gave you.")
    scopes = [scope.strip() for scope in (payload.oidc_scopes or OIDC_SCOPES_DEFAULT) if scope.strip()]
    if "openid" not in scopes:
        scopes.insert(0, "openid")
    secret = payload.oidc_client_secret.strip()
    sealed: dict[str, str]
    if secret:
        try:
            cipher = sso_cipher()
        except SsoUnavailable as exc:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=SECRETS_UNAVAILABLE) from exc
        sealed = dict(
            seal_oidc_client_secret(cipher, connection_id=context.workspace_id, client_secret=secret).as_item()
        )
    elif current is not None and current.protocol == "oidc" and current.oidc_sealed_secret:
        sealed = dict(current.oidc_sealed_secret)
    else:
        raise _invalid("oidc_client_secret", "Enter the client secret your identity provider gave you.")
    return {
        "oidc_issuer": issuer,
        "oidc_client_id": client_id,
        "oidc_sealed_secret": sealed,
        "oidc_scopes": scopes,
    }


def _saml_row(payload: SsoConnectionUpdate) -> dict[str, Any]:
    """The SAML fields of a connection, from the provider's metadata or from its three values."""
    from webbpulse.identity import SsoRejected
    from webbpulse.identity.sso_saml import parse_saml_idp_metadata

    from app.common.sso import normalise_certificate

    if payload.saml_metadata_xml.strip():
        try:
            metadata = parse_saml_idp_metadata(payload.saml_metadata_xml)
        except SsoRejected as exc:
            raise _invalid("saml_metadata_xml", "That metadata could not be read. Paste the provider's XML.") from exc
        entity_id = metadata.entity_id
        sso_url = _provider_url(metadata.sso_url, "saml_metadata_xml")
        try:
            certificates = [normalise_certificate(cert) for cert in metadata.certificates]
        except ValueError as exc:
            raise _invalid("saml_metadata_xml", "The metadata's signing certificate could not be read.") from exc
    else:
        entity_id = payload.saml_idp_entity_id.strip()
        sso_url = _provider_url(payload.saml_idp_sso_url, "saml_idp_sso_url")
        if not entity_id:
            raise _invalid("saml_idp_entity_id", "Enter the identity provider's entity ID.")
        try:
            certificates = [normalise_certificate(payload.saml_idp_certificate)]
        except ValueError as exc:
            raise _invalid("saml_idp_certificate", "Paste the provider's X.509 signing certificate.") from exc
    if not certificates:
        raise _invalid("saml_metadata_xml", "The metadata carries no signing certificate.")
    return {
        "saml_idp_entity_id": entity_id,
        "saml_idp_sso_url": sso_url,
        "saml_idp_certificates": certificates,
    }


def _audit_fields(row: SsoConnectionRow) -> dict[str, Any]:
    """The non-secret fields of a connection, as the audit log records them."""
    if row.protocol == "oidc":
        return {"protocol": "oidc", "issuer": row.oidc_issuer, "client_id": row.oidc_client_id}
    return {"protocol": "saml", "entity_id": row.saml_idp_entity_id, "sso_url": row.saml_idp_sso_url}


@router.put("/{workspace_id}/sso/connection", response_model=SsoSettingsRead)
def save_sso_connection(
    payload: SsoConnectionUpdate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> SsoSettingsRead:
    """Save the workspace's connection, which then needs a new test sign-in. Owners only.

    Refused while single sign-on is required, because an untested change could lock
    every member out at once.
    """
    from app.common.db.dynamo.base import utc_now

    _admin(context)
    if context.role != "owner":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=OWNER_ONLY_CONNECTION)
    enforce_feature(repositories, context.workspace_id, Feature.SSO)
    if repositories.memberships.get_auth_policy(context.workspace_id).require_sso:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=CONNECTION_IN_USE)
    current = repositories.memberships.get_sso_connection(context.workspace_id)
    fields = _oidc_row(payload, current, context) if payload.protocol == "oidc" else _saml_row(payload)
    now = utc_now()
    row = SsoConnectionRow(
        workspace_id=context.workspace_id,
        protocol=payload.protocol,
        display_name=payload.display_name.strip(),
        created_by=current.created_by if current is not None else context.user_id,
        created_at=current.created_at if current is not None else now,
        updated_by=context.user_id,
        updated_at=now,
        **fields,
    )
    repositories.memberships.put_sso_connection(row)
    audit.record(
        repositories,
        context,
        "sso.connection_saved",
        target_type="sso_connection",
        target_id=context.workspace_id,
        target_label=row.display_name or row.protocol.upper(),
        before=None if current is None else _audit_fields(current),
        after=_audit_fields(row),
    )
    return _settings(repositories, context)


@router.delete("/{workspace_id}/sso/connection", status_code=status.HTTP_204_NO_CONTENT)
def remove_sso_connection(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> Response:
    """Remove the workspace's connection. Refused while single sign-on is required. Idempotent."""
    _admin(context)
    current = repositories.memberships.get_sso_connection(context.workspace_id)
    if current is None:
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    if repositories.memberships.get_auth_policy(context.workspace_id).require_sso:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=CONNECTION_IN_USE)
    repositories.memberships.delete_sso_connection(context.workspace_id)
    audit.record(
        repositories,
        context,
        "sso.connection_removed",
        target_type="sso_connection",
        target_id=context.workspace_id,
        target_label=current.display_name or current.protocol.upper(),
        before=_audit_fields(current),
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{workspace_id}/sso/connection/test-result", response_model=SsoSettingsRead)
def record_sso_test(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> SsoSettingsRead:
    """Record that the caller just signed in through the connection, which proves its settings.

    The caller's own session is the proof: it must have come through this
    workspace's connection after its last save, so the record cannot be made
    without a real sign-in through the settings now stored.
    """
    from app.common.db.dynamo.base import utc_now

    _admin(context)
    enforce_feature(repositories, context.workspace_id, Feature.SSO)
    current = repositories.memberships.get_sso_connection(context.workspace_id)
    if current is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=CONNECTION_NOT_FOUND)
    if not _signed_in_through(context, current):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=NOT_THROUGH_CONNECTION)
    if not current.tested:
        repositories.memberships.put_sso_connection(
            current.model_copy(update={"tested_at": utc_now(), "tested_by": context.user_id})
        )
        audit.record(
            repositories,
            context,
            "sso.connection_tested",
            target_type="sso_connection",
            target_id=context.workspace_id,
            target_label=current.display_name or current.protocol.upper(),
            after=_audit_fields(current),
        )
    return _settings(repositories, context)


@router.put("/{workspace_id}/sso/policy", response_model=SsoSettingsRead)
def update_sso_policy(
    payload: SsoPolicyUpdate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> SsoSettingsRead:
    """Require single sign-on for every member but owners, or stop requiring it.

    Turning it on needs a tested connection, a verified domain and, unless the
    caller is an owner, a caller signed in through the connection, so an admin
    never locks themselves out. Turning it off is always allowed.
    """
    _admin(context)
    policy = repositories.memberships.get_auth_policy(context.workspace_id)
    if payload.require_sso and not policy.require_sso:
        enforce_feature(repositories, context.workspace_id, Feature.SSO)
        connection = repositories.memberships.get_sso_connection(context.workspace_id)
        domains = repositories.memberships.list_sso_domains(context.workspace_id)
        if not _ready(connection, domains):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=NOT_READY)
        if context.role != "owner" and not _signed_in_through(context, connection):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=SIGN_IN_WITH_SSO_FIRST)
    if payload.require_sso != policy.require_sso:
        repositories.memberships.set_auth_policy(
            context.workspace_id,
            require_two_factor=policy.require_two_factor,
            allowed_methods=list(policy.allowed_methods),
            require_sso=payload.require_sso,
            updated_by=context.user_id,
        )
        audit.record(
            repositories,
            context,
            "auth_policy.updated",
            target_type="auth_policy",
            target_id=context.workspace_id,
            target_label="Require single sign-on",
            before={"require_sso": policy.require_sso},
            after={"require_sso": payload.require_sso},
        )
    return _settings(repositories, context)


def _email_domain(user: Optional[User]) -> Optional[str]:
    """The domain of a person's verified email, as the identity package normalises it."""
    from webbpulse.identity import domain_of_email

    if user is None or user.is_deleted or not user.email_verified:
        return None
    try:
        return str(domain_of_email(user.email_lower))
    except ValueError:
        return None


@router.post("/sso/join", response_model=SsoJoinRead)
def join_through_sso(
    request: Request,
    claims: Annotated[Any, Depends(caller_claims)],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    response: Response,
) -> SsoJoinRead:
    """Join the workspace whose connection this session came through, as a member.

    Answers 201 for a new membership and 200 for one that already existed. Only an
    address on one of the workspace's verified domains joins, within the plan's
    member cap, which is the just in time membership single sign-on promises. A
    person the workspace's directory deactivated is refused with 403, and one the
    directory provisioned is linked to their directory row and given its teams.
    """
    refuse_delegated_claims(claims)
    subject = str(claims.get("sub", "")).strip()
    refuse_deleted_caller(repositories, subject)
    workspace_id = sso_connection_of(claims)
    if not workspace_id:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=NOT_AN_SSO_SESSION)
    workspace = repositories.workspaces.get(workspace_id)
    if workspace is None or workspace.is_purging:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=CONNECTION_NOT_FOUND)
    user = repositories.users.get(subject)
    existing = repositories.memberships.get(workspace_id, subject)
    if existing is not None:
        response.status_code = status.HTTP_200_OK
        return SsoJoinRead(workspace_id=workspace_id, slug=workspace.slug, name=workspace.name, created=False)
    enforce_feature(repositories, workspace_id, Feature.SSO)
    domain = _email_domain(user)
    sso_domain = None if domain is None else repositories.memberships.get_sso_domain(workspace_id, domain)
    if sso_domain is None or not sso_domain.verified:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=JOIN_NOT_ALLOWED)
    directory_row = scim.refuse_deactivated(repositories, workspace_id, user)
    membership = Membership(
        workspace_id=workspace_id,
        member_key=workspace_member_key(subject),
        user_id=subject,
        role="member",
    )
    try:
        plan_usage.commit(
            repositories,
            workspace_id,
            [repositories.memberships.create_action(membership)],
            [plan_usage.Delta(LimitedResource.MEMBERS, 1)],
        )
    except TransactionCanceled:
        if repositories.memberships.get_consistent(workspace_id, subject) is None:
            raise
        response.status_code = status.HTTP_200_OK
        return SsoJoinRead(workspace_id=workspace_id, slug=workspace.slug, name=workspace.name, created=False)
    sync_seats(repositories, workspace_id)
    audit.record(
        repositories,
        request_context(request, workspace_id, subject, "member"),
        "member.joined",
        target_type="member",
        target_id=subject,
        target_label=display_name_for(user),
        after={"role": "member", "via": "sso"},
    )
    scim.adopt(repositories, workspace_id, directory_row, subject)
    response.status_code = status.HTTP_201_CREATED
    return SsoJoinRead(workspace_id=workspace_id, slug=workspace.slug, name=workspace.name, created=True)
