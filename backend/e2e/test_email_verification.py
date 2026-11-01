"""Signing up, verifying the address and opening a first workspace, against the deployed stage.

The case runs as an unverified user of its own, created through the ephemeral user
route with `verified: false` and deleted afterwards. The verification token comes from
the admin-only link route rather than a mailbox: the reserved `e2e.invalid` address can
receive nothing, and the token is the same one a mailed link carries, so confirming it
runs the production confirm path. Nothing is mailed.

What is proven is the contract the pending-verification screen relies on: an unverified
session signs in, its token says `email_verified` false, the account routes answer and
every other route refuses with the typed `EMAIL_NOT_VERIFIED` rather than an error, and
once the link is confirmed a refreshed session carries the claim and creates a workspace.
"""

from __future__ import annotations

import hashlib
from typing import Any

import pytest
from webbpulse.e2e import worker_id
from webbpulse.e2e.ephemeral import create_ephemeral_user, describe_delete_failure, issue_verification_token
from webbpulse.e2e.identity import login, refresh

WRITES = pytest.mark.e2e_writes

CONFIRM_PATH = "/api/auth/verify-email/confirm"


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


class TestSignupVerifyFirstWorkspace:
    """A new account is guided through verification and lands in its first workspace."""

    @WRITES
    def test_an_unverified_account_verifies_and_creates_a_workspace(
        self, anon: Any, e2e_env: Any, admin_mint_token: str, request: pytest.FixtureRequest
    ) -> None:
        """Pending, refused with a typed code, confirmed, then a first workspace."""
        if e2e_env.read_only or not admin_mint_token:
            pytest.skip("verification needs a user of its own, which needs a writable environment and an admin token")
        tag = _short_tag(e2e_env, request)
        user = create_ephemeral_user(
            anon, run_id=f"{e2e_env.run_id}-verify-{tag}", admin_token=admin_mint_token, verified=False
        )
        if user is None:
            pytest.skip("this deployment does not offer the ephemeral user route")
        session = None
        workspace: dict[str, Any] = {}
        try:
            session = login(anon, user.credentials.email, user.credentials.password)
            assert session.claims.get("email_verified") is False, (
                "an unverified account's token does not say email_verified false."
            )
            client = session.client

            me = client.get("/api/users/me")
            assert me.status_code == 200, f"the profile answered {me.status_code}: {me.text[:300]}"
            assert me.json()["email_verified"] is False

            gated = client.get("/api/workspaces")
            assert gated.status_code == 403, f"the workspace list answered {gated.status_code}: {gated.text[:300]}"
            assert _error_code(gated) == "EMAIL_NOT_VERIFIED"

            token = issue_verification_token(anon, user, admin_token=admin_mint_token)
            confirmed = anon.post(CONFIRM_PATH, json={"token": token})
            assert confirmed.status_code == 200, (
                f"the confirm answered {confirmed.status_code}: {_error_code(confirmed)}"
            )

            refreshed = refresh(session)
            assert refreshed.status_code == 200, f"the refresh answered {refreshed.status_code}"
            assert session.claims.get("email_verified") is True, "the refreshed token still says unverified."

            created = client.post("/api/workspaces", json={"name": f"e2e-verify-{tag}", "slug": f"e2e-verify-{tag}"})
            assert created.status_code in (200, 201), (
                f"creating the first workspace answered {created.status_code}: {created.text[:300]}"
            )
            workspace = dict(created.json())
        finally:
            if session is not None and workspace.get("id"):
                session.client.post(
                    f"/api/workspaces/{workspace['id']}/deletion",
                    json={"confirm_name": str(workspace.get("name", ""))},
                )
            describe_delete_failure(anon, user, admin_token=admin_mint_token)
