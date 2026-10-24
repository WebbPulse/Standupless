"""Sign-ins, revoked sessions and failed sign-ins in the workspace audit log.

Drives the package's own session service and attempt records over the audited
stores, because those are the calls the identity router makes. The rows are read
back through `audit.list_page`, the function the settings page and the MCP tool
both read, so a row that lands here is a row an admin can see and filter.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from webbpulse.identity import (
    LOGIN_ATTEMPTS_TABLE,
    REFRESH_TOKENS_TABLE,
    IdentitySettings,
    SessionService,
    email_key,
    ip_key,
    mfa_key,
    new_attempt,
)

from app.common import audit
from app.common.core.config import settings
from app.common.session_audit import (
    FAILURES_PER_WINDOW,
    AuditedLoginAttemptStore,
    AuditedRefreshTokenStore,
    CapturedRequest,
    Revoker,
    _request,
    login_attempt_store,
    refresh_token_store,
    revoked_by,
)
from tests.domains.helpers import ADMIN, MEMBER, OWNER, add_member, make_user, make_workspace

WORKSPACE = "01JB00000000000000000000WS"

OTHER_WORKSPACE = "01JB00000000000000000000W2"

CHROME_ON_MAC = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/130.0.0.0 Safari/537.36"
)

IDENTITY_ENVIRONMENT = {
    "IDENTITY_ISSUER": "http://identity.test/api/auth",
    "IDENTITY_AUDIENCE": "standupless",
    "IDENTITY_ENVIRONMENT": "test",
    "IDENTITY_SIGNER": "local",
    "IDENTITY_SIGNING_KEY_ARNS": '["arn:aws:kms:us-west-2:000000000000:key/test-signing-key"]',
}


@pytest.fixture
def identity_tables(dynamo_tables: None, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """The package's `refresh-tokens` and `login-attempts` tables, beside the product's."""
    from webbpulse.identity.storage import TABLES as IDENTITY_TABLES

    from app.common.db.dynamo.client import get_client

    for key, value in IDENTITY_ENVIRONMENT.items():
        monkeypatch.setenv(key, value)
    client = get_client()
    for spec in IDENTITY_TABLES:
        if spec.logical_name in (REFRESH_TOKENS_TABLE, LOGIN_ATTEMPTS_TABLE):
            client.create_table(**spec.create_table_request(settings.dynamodb_table_prefix))
    yield


@pytest.fixture
def workspace(identity_tables: None, repositories: Any) -> str:
    """A Business workspace, so its log can be read, with an admin and a member."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    repositories.workspaces.set_billing(WORKSPACE, plan="business")
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    make_user(repositories, MEMBER, "member@example.com", "Mo Member")
    return WORKSPACE


@pytest.fixture
def store(identity_tables: None) -> AuditedRefreshTokenStore:
    """The audited refresh token store, naming every OAuth client `Claude`."""
    return refresh_token_store(settings, client_names=lambda client_id: "Claude")


@pytest.fixture
def sessions(store: AuditedRefreshTokenStore) -> SessionService:
    """The package's session service over the audited store, as the router builds it."""
    return SessionService(IdentitySettings(), store)  # pyright: ignore[reportCallIssue]


@pytest.fixture
def attempts(identity_tables: None) -> AuditedLoginAttemptStore:
    """The audited login attempt store."""
    return login_attempt_store(settings)


def rows(repositories: Any, workspace_id: str = WORKSPACE, **filters: Any) -> list[Any]:
    """The events the log answers, newest first."""
    page = audit.list_page(repositories, workspace_id, **filters)
    assert page.available
    return page.events


def test_the_three_events_are_in_the_catalogue() -> None:
    """The settings filter and the MCP tool's enum both read the catalogue."""
    assert {"session.created", "session.revoked", "auth.sign_in_failed"} <= set(audit.EVENT_TYPES)


def test_a_sign_in_records_how_and_from_where(workspace: str, sessions: SessionService, repositories: Any) -> None:
    """A new family is the sign-in, recorded with its method, client, address and user agent."""
    issued = sessions.start_family(
        MEMBER, device="desktop", ip="203.0.113.7", user_agent=CHROME_ON_MAC, amr=("pwd", "otp")
    )

    events = rows(repositories, event="session.created")
    assert len(events) == 1
    event = events[0]
    assert event.actor_id == MEMBER
    assert event.source == "web"
    assert event.ip == "203.0.113.7"
    assert event.amr == ["pwd", "otp"]
    assert event.target_type == "session"
    assert event.target_id == issued.family_id
    assert event.after is not None
    assert event.after["method"] == ["pwd", "otp"]
    assert event.after["device"] == "desktop"
    assert event.after["platform"] == "macOS"
    assert event.after["browser"] == "Chrome"
    assert event.target_label == "Chrome on macOS"


def test_a_sign_in_lands_in_every_workspace_of_the_member(
    workspace: str, sessions: SessionService, repositories: Any
) -> None:
    """A session is the person's, so each workspace they belong to sees it."""
    make_workspace(repositories, OTHER_WORKSPACE, "other", OWNER)
    repositories.workspaces.set_billing(OTHER_WORKSPACE, plan="business")
    add_member(repositories, OTHER_WORKSPACE, MEMBER, "member")

    sessions.start_family(MEMBER, device="desktop", ip="203.0.113.7")

    assert len(rows(repositories, WORKSPACE, event="session.created")) == 1
    assert len(rows(repositories, OTHER_WORKSPACE, event="session.created")) == 1


def test_an_mcp_session_lands_only_in_its_workspace_with_the_client_name(
    workspace: str, sessions: SessionService, repositories: Any
) -> None:
    """An MCP family is bound to one workspace, and the row names the client."""
    make_workspace(repositories, OTHER_WORKSPACE, "other", OWNER)
    repositories.workspaces.set_billing(OTHER_WORKSPACE, plan="business")
    add_member(repositories, OTHER_WORKSPACE, MEMBER, "member")

    sessions.start_family(MEMBER, device=f"mcp:client-1:{WORKSPACE}", ip="203.0.113.7")

    events = rows(repositories, WORKSPACE, event="session.created")
    assert len(events) == 1
    assert events[0].source == "mcp"
    assert events[0].target_label == "Claude"
    assert events[0].after is not None
    assert events[0].after["client_name"] == "Claude"
    assert events[0].after["client_id"] == "client-1"
    assert rows(repositories, OTHER_WORKSPACE, event="session.created") == []


def test_a_refresh_records_nothing(workspace: str, sessions: SessionService, repositories: Any) -> None:
    """Rotation writes a later generation, which keeps the log's volume to one row per sign-in."""
    issued = sessions.start_family(MEMBER, device="desktop", ip="203.0.113.7")
    first = sessions.rotate(issued.token, ip="203.0.113.7")
    assert first.issued is not None
    second = sessions.rotate(first.issued.token, ip="203.0.113.7")
    assert second.issued is not None

    assert len(rows(repositories)) == 1


def test_signing_out_records_the_owner_ending_the_session(
    workspace: str, sessions: SessionService, repositories: Any
) -> None:
    """Outside a request the person whose session it was is the one who ended it."""
    issued = sessions.start_family(MEMBER, device="desktop", ip="203.0.113.7")
    sessions.revoke_family(issued.family_id)

    events = rows(repositories, event="session.revoked")
    assert len(events) == 1
    assert events[0].actor_id == MEMBER
    assert events[0].target_id == issued.family_id
    assert events[0].after is not None
    assert events[0].after["user_id"] == MEMBER


def test_revoking_a_spent_session_again_records_nothing(
    workspace: str, sessions: SessionService, repositories: Any
) -> None:
    """Only the call that ended a live session writes a row."""
    issued = sessions.start_family(MEMBER, device="desktop", ip="203.0.113.7")
    sessions.revoke_family(issued.family_id)
    sessions.revoke_family(issued.family_id)

    assert len(rows(repositories, event="session.revoked")) == 1


def test_a_revocation_on_someones_behalf_names_them(
    workspace: str, sessions: SessionService, repositories: Any
) -> None:
    """An admin ending a member's session is the actor, with the reason they gave."""
    issued = sessions.start_family(MEMBER, device="desktop", ip="203.0.113.7")
    with revoked_by(Revoker(id=ADMIN, ip="198.51.100.4", reason="connected_app_revoked")):
        sessions.revoke_family(issued.family_id)

    events = rows(repositories, event="session.revoked", actor_id=ADMIN)
    assert len(events) == 1
    assert events[0].ip == "198.51.100.4"
    assert events[0].after is not None
    assert events[0].after["reason"] == "connected_app_revoked"
    assert events[0].after["user_id"] == MEMBER


def test_signing_out_everywhere_records_each_other_session(
    workspace: str, sessions: SessionService, repositories: Any
) -> None:
    """Every live family but the kept one gets its own row."""
    kept = sessions.start_family(MEMBER, device="desktop", ip="203.0.113.7")
    phone = sessions.start_family(MEMBER, device="mobile", ip="203.0.113.8")
    laptop = sessions.start_family(MEMBER, device="desktop", ip="203.0.113.9")

    sessions.revoke_all_for_user(MEMBER, except_family_id=kept.family_id)

    revoked = {event.target_id for event in rows(repositories, event="session.revoked")}
    assert revoked == {phone.family_id, laptop.family_id}


def test_signing_out_other_sessions_records_each_with_its_reason(
    workspace: str, sessions: SessionService, repositories: Any
) -> None:
    """The revoke-others route writes one row per ended session, naming why."""
    kept = sessions.start_family(MEMBER, device="desktop", ip="203.0.113.7")
    phone = sessions.start_family(MEMBER, device="mobile", ip="203.0.113.8")
    laptop = sessions.start_family(MEMBER, device="desktop", ip="203.0.113.9")

    token = _request.set(
        CapturedRequest(path="/api/auth/sessions/revoke-others", ip="203.0.113.7", user_agent=CHROME_ON_MAC)
    )
    try:
        sessions.revoke_all_for_user(MEMBER, except_family_id=kept.family_id)
    finally:
        _request.reset(token)

    events = rows(repositories, event="session.revoked")
    assert {event.target_id for event in events} == {phone.family_id, laptop.family_id}
    for event in events:
        assert event.actor_id == MEMBER
        assert event.ip == "203.0.113.7"
        assert event.after is not None
        assert event.after["reason"] == "sign_out_others"


def test_a_directory_revocation_lands_in_a_workspace_the_person_has_left(
    workspace: str, sessions: SessionService, repositories: Any
) -> None:
    """Deprovisioning removes the membership first, so the revoker names the workspace."""
    sessions.start_family(MEMBER, device="desktop", ip="203.0.113.7")
    repositories.memberships.delete(WORKSPACE, MEMBER)

    with revoked_by(Revoker(id="scim", kind="system", source="scim", workspace_ids=(WORKSPACE,))):
        sessions.revoke_all_for_user(MEMBER)

    events = rows(repositories, event="session.revoked", actor_id="scim")
    assert len(events) == 1
    assert events[0].source == "scim"


def test_a_failed_password_for_a_member_is_recorded(
    workspace: str, attempts: AuditedLoginAttemptStore, repositories: Any
) -> None:
    """The failure names the account it was against and the address it came from."""
    attempts.record(
        new_attempt(email_key("member@example.com"), "failure", user_id=MEMBER, ip="203.0.113.7", user_agent="desktop")
    )
    attempts.record(new_attempt(ip_key("203.0.113.7"), "failure", user_id=MEMBER, ip="203.0.113.7"))

    events = rows(repositories, event="auth.sign_in_failed", actor_id=MEMBER)
    assert len(events) == 1
    assert events[0].ip == "203.0.113.7"
    assert events[0].after == {"method": "password", "device": "desktop"}


def test_a_failed_second_factor_is_recorded(
    workspace: str, attempts: AuditedLoginAttemptStore, repositories: Any
) -> None:
    """A wrong code after a right password is a failed sign-in too."""
    attempts.record(new_attempt(mfa_key(MEMBER), "failure", user_id=MEMBER, ip="203.0.113.7"))

    events = rows(repositories, event="auth.sign_in_failed")
    assert len(events) == 1
    assert events[0].after is not None
    assert events[0].after["method"] == "second_factor"


def test_failures_are_rate_limited_per_account(
    workspace: str, attempts: AuditedLoginAttemptStore, repositories: Any
) -> None:
    """A burst of failures writes a few rows, not one per guess."""
    for _ in range(FAILURES_PER_WINDOW + 5):
        attempts.record(new_attempt(email_key("member@example.com"), "failure", user_id=MEMBER, ip="203.0.113.7"))

    assert len(rows(repositories, event="auth.sign_in_failed")) == FAILURES_PER_WINDOW


def test_an_unknown_address_records_nothing(
    workspace: str, attempts: AuditedLoginAttemptStore, repositories: Any
) -> None:
    """With no account there is no workspace to tell, and the log never confirms an address."""
    attempts.record(new_attempt(email_key("nobody@example.com"), "failure", ip="203.0.113.7"))
    attempts.record(new_attempt(email_key("member@example.com"), "locked", ip="203.0.113.7"))
    attempts.record(new_attempt(email_key("member@example.com"), "success", user_id=MEMBER, ip="203.0.113.7"))

    assert rows(repositories) == []
