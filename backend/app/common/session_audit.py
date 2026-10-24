"""Sign-ins, session revocations and failed sign-ins in the workspace audit log.

The identity package writes sessions and login attempts through stores it is
handed, so the product hands it subclasses that write the audit row after the
package's own write lands. A session is a refresh family: the first generation is
the sign-in, and rotation writes later generations, which record nothing, so a
refresh never adds a row.

A session belongs to a person rather than a workspace, so its events land in
every workspace the person is a member of, or in the one workspace an MCP client
was authorized for.

Who ended a session is read from `revoked_by` when the product revokes on
someone's behalf, and otherwise from the package route the request reached.
Failed sign-ins are recorded only for an account that exists, and at most a few
times per account in a window, so a password spray cannot flood the log and the
log never says whether an address has an account.

Every write is best effort: a failed audit row is logged and never fails the
sign-in or the revocation it describes.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any, AsyncIterator, Mapping

from fastapi import Request
from webbpulse.identity import DynamoLoginAttemptStore, DynamoRefreshTokenStore

if TYPE_CHECKING:  # pragma: no cover
    from webbpulse.identity import LoginAttempt, RefreshTokenRecord

_log = logging.getLogger(__name__)

MCP_DEVICE_PREFIX = "mcp:"

FAILURE_WINDOW = timedelta(minutes=15)

FAILURES_PER_WINDOW = 3
"""How many failed sign-ins one account records per window before the rest go unrecorded."""

USER_AGENT_LIMIT = 256

ClientNames = Callable[[str], str]


@dataclass(frozen=True)
class Revoker:
    """Who ended a session and why, when the product revokes on someone's behalf.

    `workspace_ids` are workspaces the event lands in beside the person's current
    memberships, for a revocation that runs after the membership is gone.
    """

    id: str
    kind: str = "user"
    source: str = "web"
    ip: str = ""
    reason: str = "revoked"
    workspace_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class CapturedRequest:
    """The parts of an identity request the audit rows need."""

    path: str
    ip: str
    user_agent: str


_revoker: ContextVar[Revoker | None] = ContextVar("session_audit_revoker", default=None)

_request: ContextVar[CapturedRequest | None] = ContextVar("session_audit_request", default=None)


@contextmanager
def revoked_by(revoker: Revoker) -> Iterator[None]:
    """Attribute every session revoked inside this block to `revoker`."""
    token = _revoker.set(revoker)
    try:
        yield
    finally:
        _revoker.reset(token)


async def capture_request(request: Request) -> AsyncIterator[None]:
    """A route dependency that keeps the request's path, address and user agent for the stores."""
    from app.common.api.dependencies.authz import client_ip_of

    token = _request.set(
        CapturedRequest(
            path=request.url.path,
            ip=client_ip_of(request),
            user_agent=request.headers.get("user-agent", "")[:USER_AGENT_LIMIT],
        )
    )
    try:
        yield
    finally:
        try:
            _request.reset(token)
        except ValueError:
            _request.set(None)


def _route_revoker(owner_id: str) -> Revoker:
    """Who ended a session, read from the revoker in force or the package route that ran."""
    explicit = _revoker.get()
    if explicit is not None:
        return explicit
    captured = _request.get()
    if captured is None:
        return Revoker(id=owner_id)
    path = captured.path.rstrip("/")
    if path.endswith("/refresh") or path.endswith("/token"):
        return Revoker(id="system", kind="system", source="system", ip=captured.ip, reason="refresh_refused")
    if path.endswith("/revoke"):
        return Revoker(id=owner_id, source="mcp", ip=captured.ip, reason="client_revoked")
    reasons = (
        ("/logout-all", "signed_out_everywhere"),
        ("/logout", "signed_out"),
        ("/password", "password_changed"),
        ("/reset/confirm", "password_reset"),
    )
    reason = next((label for suffix, label in reasons if path.endswith(suffix)), "revoked")
    return Revoker(id=owner_id, ip=captured.ip, reason=reason)


def _client_id(device: str) -> str:
    """The OAuth client a family was started for, or empty for a browser or app session."""
    if not device.startswith(MCP_DEVICE_PREFIX):
        return ""
    return device[len(MCP_DEVICE_PREFIX) :].split(":", 1)[0]


def _tenant(device: str) -> str:
    """The workspace an MCP family was bound to, or empty when it names none."""
    if not device.startswith(MCP_DEVICE_PREFIX):
        return ""
    parts = device[len(MCP_DEVICE_PREFIX) :].split(":", 1)
    return parts[1] if len(parts) > 1 else ""


def _workspaces(user_id: str, device: str, extra: Iterable[str] = ()) -> list[str]:
    """The workspaces a session event lands in, in a stable order."""
    from app.common.db.dynamo.memberships import MembershipRepository

    member_of = [membership.workspace_id for membership in MembershipRepository().list_workspaces_for_user(user_id)]
    candidates = dict.fromkeys([*member_of, *extra])
    tenant = _tenant(device)
    if tenant:
        return [tenant] if tenant in candidates else []
    return [workspace_id for workspace_id in candidates if workspace_id]


def _method(amr: Iterable[str]) -> list[str]:
    """The sign-in methods a stored `amr` names, without its single sign-on connection marker."""
    from webbpulse.identity.sso import strip_sso_markers

    return list(strip_sso_markers(tuple(amr)))


def _label(record: "RefreshTokenRecord", client_name: str) -> str:
    """How the audit page names a session: the client app, or the browser and platform."""
    if client_name:
        return client_name
    described = " on ".join(part for part in (record.client, record.platform) if part)
    return described or record.device or "Session"


def _write(
    workspace_ids: Iterable[str],
    event: str,
    *,
    actor_id: str,
    actor_kind: str,
    source: str,
    ip: str,
    amr: tuple[str, ...] = (),
    target_type: str,
    target_id: str,
    target_label: str,
    after: Mapping[str, Any] | None = None,
) -> None:
    """Record one event in each workspace, never raising."""
    from app.common import audit
    from app.common.api.dependencies.repositories import build_bundle

    repositories = build_bundle(("audit",), name="identity-sessions")
    for workspace_id in workspace_ids:
        try:
            audit.record_system(
                repositories,
                workspace_id,
                event,
                actor_id=actor_id,
                actor_kind=actor_kind,
                source=source,
                ip=ip,
                amr=amr,
                target_type=target_type,
                target_id=target_id,
                target_label=target_label,
                after=after,
            )
        except Exception:
            _log.warning("session_audit_failed", extra={"event": event, "workspace_id": workspace_id}, exc_info=True)


def _lookup_name(client_names: ClientNames | None, client_id: str) -> str:
    """The registered name of an OAuth client, or empty when it cannot be read."""
    if not client_id or client_names is None:
        return ""
    try:
        return client_names(client_id)
    except Exception:
        return ""


class AuditedRefreshTokenStore(DynamoRefreshTokenStore):
    """The package's refresh token store, recording each sign-in and each revoked session."""

    def __init__(self, repository: Any, *, client_names: ClientNames | None = None, **kwargs: Any) -> None:
        """Bind the store, with `client_names` resolving an OAuth client id to its registered name."""
        super().__init__(repository, **kwargs)
        self._client_names = client_names

    def put(self, record: "RefreshTokenRecord") -> None:
        """Write the generation, then audit the sign-in when it starts a family."""
        super().put(record)
        if record.generation != 1:
            return
        try:
            self._audit_created(record)
        except Exception:
            _log.warning("session_audit_failed", extra={"event": "session.created"}, exc_info=True)

    def revoke_family(self, family_id: str) -> int:
        """Revoke a family, then audit it when it was live and this call ended it."""
        before = self._newest(family_id)
        revoked = super().revoke_family(family_id)
        if revoked and before is not None and self._was_live(before):
            self._audit_revoked(before)
        return revoked

    def revoke_all_for_user(self, user_id: str, *, except_family_id: str = "") -> int:
        """Revoke every family of a user but one, then audit each family that was live."""
        try:
            live = [
                record
                for record in self.latest_by_family_for_user(user_id)
                if record.family_id != except_family_id and self._was_live(record)
            ]
        except Exception:
            live = []
        revoked = super().revoke_all_for_user(user_id, except_family_id=except_family_id)
        if revoked:
            for record in live:
                self._audit_revoked(record)
        return revoked

    def _newest(self, family_id: str) -> "RefreshTokenRecord | None":
        """The newest generation of a family, or `None` when it cannot be read."""
        from boto3.dynamodb.conditions import Key
        from webbpulse.identity import REFRESH_FAMILY_INDEX

        try:
            page = self._repo.query(
                Key("family_id").eq(family_id),
                index_name=REFRESH_FAMILY_INDEX,
                limit=1,
                ascending=False,
            )
            if not page.items:
                return None
            return self.get(str(page.items[0]["token_hash"]))
        except Exception:
            return None

    @staticmethod
    def _was_live(record: "RefreshTokenRecord") -> bool:
        """Whether a family was still signed in, so ending an expired one records nothing."""
        from webbpulse.identity import is_expired

        return not record.revoked and not is_expired(record.expires_at)

    def _audit_created(self, record: "RefreshTokenRecord") -> None:
        """Record `session.created` for the family `record` starts."""
        client_id = _client_id(record.device)
        client_name = _lookup_name(self._client_names, client_id)
        captured = _request.get()
        after: dict[str, Any] = {
            "method": _method(record.amr),
            "device": record.device,
            "client": record.client,
            "platform": record.platform,
        }
        if client_id:
            after["client_id"] = client_id
            after["client_name"] = client_name or client_id
        if captured is not None and captured.user_agent:
            after["user_agent"] = captured.user_agent
        _write(
            _workspaces(record.user_id, record.device),
            "session.created",
            actor_id=record.user_id,
            actor_kind="user",
            source="mcp" if client_id else "web",
            ip=record.ip_first_seen or (captured.ip if captured is not None else ""),
            amr=tuple(record.amr),
            target_type="session",
            target_id=record.family_id,
            target_label=_label(record, client_name),
            after=after,
        )

    def _audit_revoked(self, record: "RefreshTokenRecord") -> None:
        """Record `session.revoked` for the family `record` belongs to, never raising."""
        try:
            revoker = _route_revoker(record.user_id)
            client_id = _client_id(record.device)
            client_name = _lookup_name(self._client_names, client_id)
            after: dict[str, Any] = {"reason": revoker.reason, "user_id": record.user_id, "device": record.device}
            if client_id:
                after["client_id"] = client_id
            _write(
                _workspaces(record.user_id, record.device, revoker.workspace_ids),
                "session.revoked",
                actor_id=revoker.id,
                actor_kind=revoker.kind,
                source=revoker.source,
                ip=revoker.ip,
                target_type="session",
                target_id=record.family_id,
                target_label=_label(record, client_name),
                after=after,
            )
        except Exception:
            _log.warning("session_audit_failed", extra={"event": "session.revoked"}, exc_info=True)


class AuditedLoginAttemptStore(DynamoLoginAttemptStore):
    """The package's login attempt store, recording failed sign-ins to existing accounts."""

    def record(self, attempt: "LoginAttempt") -> None:
        """Write the attempt, then audit a failure against a known account, a few per window."""
        method = _failure_method(attempt)
        prior = self._recent_failures(attempt.identity_key) if method else FAILURES_PER_WINDOW
        super().record(attempt)
        if not method or prior >= FAILURES_PER_WINDOW:
            return
        try:
            _write(
                _workspaces(attempt.user_id, ""),
                "auth.sign_in_failed",
                actor_id=attempt.user_id,
                actor_kind="user",
                source="web",
                ip=attempt.ip,
                target_type="member",
                target_id=attempt.user_id,
                target_label="",
                after={"method": method, "device": attempt.user_agent},
            )
        except Exception:
            _log.warning("session_audit_failed", extra={"event": "auth.sign_in_failed"}, exc_info=True)

    def _recent_failures(self, identity_key: str) -> int:
        """How many failures this key recorded inside the window, or the cap when unreadable."""
        cutoff = datetime.now(UTC) - FAILURE_WINDOW
        try:
            rows = self.recent(identity_key, limit=FAILURES_PER_WINDOW * 4)
        except Exception:
            return FAILURES_PER_WINDOW
        return sum(1 for row in rows if row.outcome == "failure" and _after(row.attempted_at, cutoff))


def _failure_method(attempt: "LoginAttempt") -> str:
    """`password` or `second_factor` for an auditable failure, empty for anything else.

    An attempt with no account, or one written under the address key, records nothing.
    """
    if attempt.outcome != "failure" or not attempt.user_id:
        return ""
    if attempt.identity_key.startswith("email#"):
        return "password"
    if attempt.identity_key.startswith("mfa#"):
        return "second_factor"
    return ""


def _after(stamp: str, cutoff: datetime) -> bool:
    """Whether an ISO timestamp falls after `cutoff`, treating an unreadable one as recent."""
    try:
        moment = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        return True
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return moment > cutoff


def refresh_token_store(settings: Any, *, client_names: ClientNames | None = None) -> AuditedRefreshTokenStore:
    """The audited refresh token store over this environment's `refresh-tokens` table."""
    from webbpulse.dynamodb import Repository
    from webbpulse.identity import REFRESH_TOKENS_TABLE

    return AuditedRefreshTokenStore(
        Repository(
            REFRESH_TOKENS_TABLE,
            prefix=settings.dynamodb_table_prefix,
            endpoint_url=settings.DYNAMODB_ENDPOINT_URL or None,
        ),
        client_names=client_names,
    )


def login_attempt_store(settings: Any) -> AuditedLoginAttemptStore:
    """The audited login attempt store over this environment's `login-attempts` table."""
    from webbpulse.dynamodb import Repository
    from webbpulse.identity import LOGIN_ATTEMPTS_TABLE

    return AuditedLoginAttemptStore(
        Repository(
            LOGIN_ATTEMPTS_TABLE,
            prefix=settings.dynamodb_table_prefix,
            endpoint_url=settings.DYNAMODB_ENDPOINT_URL or None,
        )
    )


def client_names_from(clients: Any) -> ClientNames:
    """A client name lookup over an OAuth client store, falling back to the id."""

    def name(client_id: str) -> str:
        client = clients.get(client_id)
        return client.client_name if client is not None and client.client_name else client_id

    return name
