"""Decisions the integrations routes and consumers share.

The secret handling is the part worth reading. An endpoint's secret is shown once
and never stored: the row keeps a salted SHA-256 of it, which is only ever used to
answer "is this the value you were shown", and the signing key the dispatcher
actually uses is derived per endpoint with HKDF from one environment-wide master
key. That means a dump of the `github` table yields no value that can forge a
signature, and rotating the master key rotates every endpoint at once without a
migration.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from typing import Any, Iterable, Literal

from fastapi import HTTPException, status

from app.common.core.config import settings
from app.common.db.dynamo.github import IssueLink, Repository_, WebhookEndpoint
from app.common.db.dynamo.project_config import DEFAULT_TRANSITIONS, TRIGGERS, Transition
from app.domains.integrations.schemas.integrations import (
    IssueLinkRead,
    RepositoryRead,
    TransitionRead,
    WebhookEndpointRead,
)

NOT_FOUND = {"error_code": "NOT_FOUND", "message": "Resource not found"}

SECRET_BYTES = 32

HKDF_INFO_PREFIX = b"standupless.webhook.v1:"


def not_found() -> HTTPException:
    """The 404 an absent or invisible row gets.

    Invisible and absent look identical here for the same reason they do elsewhere
    in the product: a distinguishable 403 would confirm a workspace exists.
    """
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)


def forbidden() -> HTTPException:
    """The 403 a caller inside the workspace but outside the rule gets."""
    return HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail={"error_code": "FORBIDDEN", "message": "Not allowed"},
    )


def conflict(message: str) -> HTTPException:
    """A 409 carrying the product's error envelope."""
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail={"error_code": "CONFLICT", "message": message})


def unprocessable(message: str, error_code: str = "VALIDATION_ERROR") -> HTTPException:
    """A 422 carrying one of the contract's own error codes."""
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail={"error_code": error_code, "message": message},
    )


def not_configured() -> HTTPException:
    """The 503 every GitHub route gives when the App credentials are absent.

    The App is created by hand and its values land in the secret out of band, so an
    environment without them is a normal state rather than a bug, and it has to be
    told apart from a workspace that simply has no installation.
    """
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail={"error_code": "NOT_CONFIGURED", "message": "The GitHub App is not configured."},
    )


def mint_secret() -> str:
    """A fresh endpoint secret, shown to the caller exactly once."""
    return f"whsec_{secrets.token_urlsafe(SECRET_BYTES)}"


def hash_secret(secret: str, salt: str) -> str:
    """The stored digest of an endpoint secret.

    Salted per endpoint so two endpoints given the same secret do not produce the
    same digest. This is never used to authenticate an inbound request, only to
    compare against a value the caller already holds, so a fast digest is the right
    cost here.
    """
    return hashlib.sha256(f"{salt}:{secret}".encode()).hexdigest()


def secret_hint(secret: str) -> str:
    """The last four characters of a secret, for telling two endpoints apart."""
    return secret[-4:]


def signing_key(webhook_id: str) -> bytes:
    """The per-endpoint signing key, derived from the environment master key.

    HKDF with the webhook id as `info` gives every endpoint an independent key from
    one stored secret, so leaking one endpoint's key tells an attacker nothing about
    another's and no per-endpoint key is ever at rest.
    """
    master = settings.WEBHOOK_SIGNING_KEY
    if not master:
        raise not_configured()
    return hkdf_expand(hashlib.sha256(master.encode()).digest(), HKDF_INFO_PREFIX + webhook_id.encode(), 32)


def hkdf_expand(prk: bytes, info: bytes, length: int) -> bytes:
    """The expand half of HKDF over SHA-256.

    Waits on a `webbpulse.security.derive_key` surface upstream; the extract step is
    skipped because the master key is already a high-entropy random value rather
    than a password or a shared Diffie-Hellman output.
    """
    output = b""
    block = b""
    counter = 1
    while len(output) < length:
        block = hmac.new(prk, block + info + bytes([counter]), hashlib.sha256).digest()
        output += block
        counter += 1
    return output[:length]


def endpoint_read(endpoint: WebhookEndpoint, *, secret: str | None = None) -> WebhookEndpointRead:
    """The response body for one endpoint, carrying the secret only when minted."""
    return WebhookEndpointRead(
        webhook_id=endpoint.webhook_id,
        url=endpoint.url,
        events=list(endpoint.events),
        description=endpoint.description,
        active=endpoint.active,
        secret_hint=endpoint.secret_hint,
        created_by=endpoint.created_by,
        created_at=endpoint.created_at,
        updated_at=endpoint.updated_at,
        last_status=endpoint.last_status,
        last_delivery_at=endpoint.last_delivery_at,
        secret=secret,
    )


def repository_read(repository: Repository_) -> RepositoryRead:
    """The response body for one linked repository."""
    return RepositoryRead(
        repository_id=repository.repository_id,
        full_name=repository.full_name,
        name=repository.name,
        private=repository.private,
        default_branch=repository.default_branch,
        project_id=repository.project_id,
        linked_at=repository.linked_at,
    )


def _pr_state(value: str) -> Literal["open", "draft", "merged", "closed"]:
    """Narrow a stored state string to the four the contract names.

    The row is written by this product, so an unknown value means a row from an
    older shape; it reads as open rather than failing the whole page.
    """
    return value if value in ("open", "draft", "merged", "closed") else "open"  # type: ignore[return-value]


def link_read(link: IssueLink) -> IssueLinkRead:
    """The response body for one linked pull request."""
    return IssueLinkRead(
        link_id=link.link_id,
        issue_id=link.issue_id,
        issue_key=link.issue_key,
        repository_full_name=link.repository_full_name,
        pr_number=link.pr_number,
        pr_title=link.pr_title,
        pr_url=link.pr_url,
        pr_state=_pr_state(link.pr_state),
        author_login=link.author_login,
        closes_issue=link.magic_word is not None,
        applied_status_id=link.applied_status_id,
        linked_at=link.linked_at,
        updated_at=link.updated_at,
    )


def transition_read(transition: Transition) -> TransitionRead:
    """The response body for one stored rule."""
    return TransitionRead(
        transition_id=transition.transition_id,
        project_id=transition.project_id,
        trigger=transition.trigger,
        status_id=transition.status_id or None,
        is_default=False,
    )


def default_transitions(project_id: str, statuses: Iterable[Any]) -> list[TransitionRead]:
    """The rules a project with none configured behaves as if it had.

    Resolved against the project's own statuses rather than returned as a category
    name, because the frontend shows a status and a category is not one. A category
    with no status in this project simply produces no rule.
    """
    by_category: dict[str, list[Any]] = {}
    for status_row in statuses:
        by_category.setdefault(status_row.category, []).append(status_row)

    rules: list[TransitionRead] = []
    for trigger, category, _position in DEFAULT_TRANSITIONS:
        candidates = sorted(by_category.get(category, []), key=lambda row: (row.position, row.status_id))
        if not candidates:
            continue
        rules.append(
            TransitionRead(
                transition_id=f"default#{trigger}",
                project_id=project_id,
                trigger=trigger,
                status_id=candidates[0].status_id,
                is_default=True,
            )
        )
    return rules


def effective_transitions(
    project_id: str,
    stored: list[Transition],
    statuses: Iterable[Any],
) -> list[TransitionRead]:
    """What the project actually does, whether or not anybody configured it.

    Stored rules replace the defaults entirely rather than merging with them, so a
    project that deliberately disabled the merge transition does not get it back
    because a default exists for that trigger.
    """
    if stored:
        return [transition_read(row) for row in sorted(stored, key=lambda row: TRIGGERS.index(row.trigger))]
    return default_transitions(project_id, statuses)
