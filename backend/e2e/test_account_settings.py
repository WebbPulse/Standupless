"""The personal account settings routes, driven against the deployed stage.

Each case runs as a user of its own, created through the ephemeral user route and
deleted afterwards, because a rename, a sign-in address change and a session revoke
all change the account they run as, and the session every other module shares must
not move under them.

A rename is proven end to end: the profile and the workspace member list both carry
the new handle, and the handle given up stays on the member row, which is what lets
a mention written under it keep resolving. The sign-in address change is proven up
to the mail: the refusals, a request the stage accepts, and a confirmation that will
not spend a link nobody issued. The accepted request is sent to the SES mailbox
simulator, which accepts the message without delivering it to anyone, so no real
mailbox is written to and no bounce reaches the sender's reputation. A stage that
sends no email does not mount the email routes, and those cases skip there.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

import pytest
from webbpulse.e2e import worker_id
from webbpulse.e2e.ephemeral import EphemeralUser, create_ephemeral_user, describe_delete_failure
from webbpulse.e2e.identity import IdentitySession, login

WRITES = pytest.mark.e2e_writes

SIMULATOR_DOMAIN = "simulator.amazonses.com"
"""The SES mailbox simulator, which accepts a message and delivers it nowhere."""


@dataclass
class Account:
    """A user of this case's own, signed in, with the workspace it owns."""

    user: EphemeralUser
    session: IdentitySession
    workspace: dict[str, Any]
    tag: str


def _error_code(response: Any) -> str:
    """The error code a refusal carries, read from the envelope or a bare `detail`."""
    try:
        body = response.json()
    except ValueError:
        return ""
    if not isinstance(body, dict):
        return ""
    detail = body.get("detail")
    if isinstance(detail, dict) and detail.get("error_code"):
        return str(detail["error_code"])
    return str(body.get("error_code", ""))


def _short_tag(e2e_env: Any, request: pytest.FixtureRequest) -> str:
    """A short, handle shaped tag unique to this run, worker and case."""
    raw = f"{e2e_env.run_id}-{worker_id(request.config)}-{request.node.nodeid}"
    return hashlib.sha256(raw.encode()).hexdigest()[:12]


@pytest.fixture
def account(anon: Any, e2e_env: Any, admin_mint_token: str, request: pytest.FixtureRequest) -> Iterator[Account]:
    """A fresh user signed in moments ago, owning one workspace, removed afterwards."""
    if e2e_env.read_only or not admin_mint_token:
        pytest.skip("account settings need a user of their own, which needs a writable environment and an admin token")
    tag = _short_tag(e2e_env, request)
    user = create_ephemeral_user(anon, run_id=f"{e2e_env.run_id}-acct-{tag}", admin_token=admin_mint_token)
    if user is None:
        pytest.skip("this deployment does not offer the ephemeral user route")
    workspace: dict[str, Any] = {}
    session: IdentitySession | None = None
    try:
        session = login(anon, user.credentials.email, user.credentials.password)
        created = session.client.post("/api/workspaces", json={"name": f"e2e-acct-{tag}", "slug": f"e2e-acct-{tag}"})
        assert created.status_code in (200, 201), (
            f"creating the workspace answered {created.status_code}: {created.text[:300]}"
        )
        workspace = dict(created.json())
        yield Account(user=user, session=session, workspace=workspace, tag=tag)
    finally:
        if session is not None and workspace.get("id"):
            session.client.post(
                f"/api/workspaces/{workspace['id']}/deletion",
                json={"confirm_name": str(workspace.get("name", ""))},
            )
        describe_delete_failure(anon, user, admin_token=admin_mint_token)


def _member_row(account: Account) -> dict[str, Any]:
    """The caller's own row in their workspace's member list."""
    response = account.session.client.get(f"/api/workspaces/{account.workspace['id']}/members")
    assert response.status_code == 200, f"the member list answered {response.status_code}: {response.text[:300]}"
    rows = [row for row in response.json()["members"] if row.get("user_id") == account.user.user_id]
    assert rows, "the caller is missing from their own workspace's member list."
    return dict(rows[0])


class TestProfileRename:
    """A rename shows everywhere at once and keeps the handle given up."""

    @WRITES
    def test_rename_shows_in_the_profile_and_the_member_list(self, account: Account) -> None:
        """The new name is read back from the profile and the member list without a new sign in."""
        first = f"e2e-a-{account.tag}"
        second = f"e2e-b-{account.tag}"
        client = account.session.client

        named = client.patch("/api/users/me/profile", json={"display_name": first, "full_name": "E2E  Person"})
        assert named.status_code == 200, f"the first rename answered {named.status_code}: {named.text[:300]}"
        assert named.json()["display_name"] == first
        assert named.json()["full_name"] == "E2E Person", "a full name was stored with its spacing untidied."

        renamed = client.patch("/api/users/me/profile", json={"display_name": second})
        assert renamed.status_code == 200, f"the second rename answered {renamed.status_code}: {renamed.text[:300]}"

        me = client.get("/api/users/me")
        assert me.status_code == 200
        assert me.json()["display_name"] == second
        assert me.json()["full_name"] == "E2E Person", "a rename cleared a field it was not given."

        row = _member_row(account)
        assert row["display_name"] == second, "the member list still shows the old name."
        assert first.lower() in [handle.lower() for handle in row.get("previous_handles", [])], (
            "the handle given up was not kept, so mentions written under it stop resolving."
        )

    @WRITES
    def test_a_handle_the_mention_parser_cannot_read_is_refused(self, account: Account) -> None:
        """A username with a space could never be mentioned, so it is refused rather than stored."""
        refused = account.session.client.patch("/api/users/me/profile", json={"display_name": "two words"})
        assert refused.status_code == 422, f"a spaced username answered {refused.status_code}: {refused.text[:300]}"

    def test_anonymous_rename_is_refused(self, anon: Any) -> None:
        """Nobody renames an account without signing in."""
        response = anon.patch("/api/users/me/profile", json={"display_name": "nobody"})
        assert response.status_code in (401, 403), f"an anonymous rename answered {response.status_code}."


class TestEmailChange:
    """Requesting and confirming a new sign-in address."""

    @staticmethod
    def _require_email_routes(response: Any) -> None:
        """Skip on a stage that sends no email, or once the runner's address is rate limited.

        A stage with no sender does not mount the email routes, so they answer the generic
        NOT_FOUND. The request route allows
        ten calls an hour from one address, which back to back runs from one runner can
        spend, and that limit is the route working rather than failing.
        """
        if response.status_code == 404 and _error_code(response) in ("", "NOT_FOUND"):
            pytest.skip("this stage sends no email, so the email change routes are not mounted")
        if response.status_code == 429:
            pytest.skip("the email change rate limit for this runner's address is spent for the hour")

    @WRITES
    def test_an_unchanged_address_is_refused_and_a_new_one_is_mailed(self, account: Account) -> None:
        """The current address is refused, and a new one is mailed a link.

        The account's address does not move, because nothing changes until the mailed
        link is spent, and this run never spends it. Malformed addresses are left to the
        unit suite, so a run spends as little of the hourly limit as it can.
        """
        client = account.session.client
        unchanged = client.post("/api/auth/email/change", json={"email": account.user.credentials.email})
        self._require_email_routes(unchanged)
        assert unchanged.status_code == 400, (
            f"the current address answered {unchanged.status_code}: {unchanged.text[:300]}"
        )
        assert _error_code(unchanged) == "EMAIL_UNCHANGED"

        target = f"success+{account.tag}@{SIMULATOR_DOMAIN}"
        sent = client.post("/api/auth/email/change", json={"email": target})
        self._require_email_routes(sent)
        assert sent.status_code == 200, f"a new address answered {sent.status_code}: {sent.text[:300]}"
        assert sent.json() == {"sent": True}

        me = client.get("/api/users/me")
        assert me.status_code == 200
        assert me.json()["email"].lower() == account.user.credentials.email.lower(), (
            "the sign-in address moved before the new mailbox was proven."
        )

    def test_a_link_nobody_issued_is_refused(self, anon: Any) -> None:
        """The confirm route is anonymous, so an invented token must be refused, not spent."""
        response = anon.post("/api/auth/email/change/confirm", json={"token": "not-a-real-token"})
        self._require_email_routes(response)
        assert response.status_code == 400, f"an invented link answered {response.status_code}: {response.text[:300]}"
        assert _error_code(response) == "INVALID_LINK"

    def test_anonymous_request_is_refused(self, anon: Any) -> None:
        """Only a signed in user asks to move a sign-in address."""
        response = anon.post("/api/auth/email/change", json={"email": f"success+anon@{SIMULATOR_DOMAIN}"})
        self._require_email_routes(response)
        assert response.status_code in (401, 403), f"an anonymous request answered {response.status_code}."


class TestSessions:
    """The session list and revoking another device."""

    @WRITES
    def test_list_marks_this_session_and_revokes_another(self, anon: Any, account: Account) -> None:
        """A second sign in shows in the list, can be revoked, and the current one cannot."""
        other = login(anon, account.user.credentials.email, account.user.credentials.password)
        client = account.session.client

        listed = client.get("/api/auth/sessions")
        assert listed.status_code == 200, f"the session list answered {listed.status_code}: {listed.text[:300]}"
        sessions = listed.json()["sessions"]
        assert len(sessions) >= 2, "a second sign in is missing from the session list."
        current = [row for row in sessions if row["current"]]
        assert len(current) == 1, f"expected one current session, found {len(current)}."
        for row in sessions:
            assert {
                "id",
                "device",
                "ip",
                "last_ip",
                "client",
                "platform",
                "browser",
                "client_id",
                "started_at",
                "last_active_at",
                "expires_at",
                "amr",
            } <= row.keys()

        own = client.delete(f"/api/auth/sessions/{current[0]['id']}")
        assert own.status_code == 400, f"revoking the current session answered {own.status_code}."
        assert _error_code(own) == "CURRENT_SESSION"

        from_other = other.client.get("/api/auth/sessions")
        assert from_other.status_code == 200
        other_id = next(row["id"] for row in from_other.json()["sessions"] if row["current"])

        revoked = client.delete(f"/api/auth/sessions/{other_id}")
        assert revoked.status_code == 200, (
            f"revoking another session answered {revoked.status_code}: {revoked.text[:300]}"
        )
        remaining = [row["id"] for row in client.get("/api/auth/sessions").json()["sessions"]]
        assert other_id not in remaining, "a revoked session is still listed."

        unknown = client.delete("/api/auth/sessions/not-a-session")
        assert unknown.status_code == 404, f"an unknown session answered {unknown.status_code}."

    @WRITES
    def test_signing_out_other_sessions_keeps_only_this_one(self, anon: Any, account: Account) -> None:
        """Every other sign in ends in one call, and the calling session stays signed in."""
        login(anon, account.user.credentials.email, account.user.credentials.password)
        login(anon, account.user.credentials.email, account.user.credentials.password)
        client = account.session.client

        before = client.get("/api/auth/sessions").json()["sessions"]
        assert len(before) >= 3, f"expected at least three sessions, found {len(before)}."

        response = client.post("/api/auth/sessions/revoke-others")
        assert response.status_code == 200, f"revoke-others answered {response.status_code}: {response.text[:300]}"
        assert response.json()["revoked"] >= 2

        after = client.get("/api/auth/sessions")
        assert after.status_code == 200, f"the current session was signed out: {after.status_code}."
        remaining = after.json()["sessions"]
        assert len(remaining) == 1 and remaining[0]["current"], "another session survived revoke-others."

    def test_anonymous_revoke_others_is_refused(self, anon: Any) -> None:
        """Signing out other sessions needs a session of its own."""
        response = anon.post("/api/auth/sessions/revoke-others")
        assert response.status_code in (401, 403), f"an anonymous revoke-others answered {response.status_code}."

    def test_anonymous_list_is_refused(self, anon: Any) -> None:
        """The list names devices and addresses, so it never answers without a session."""
        response = anon.get("/api/auth/sessions")
        assert response.status_code in (401, 403), f"an anonymous list answered {response.status_code}."
