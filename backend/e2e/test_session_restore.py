"""A full page load restores the session from the refresh cookie alone (STUP-210).

A reload drops the in-memory access token, so the web client's first call is
`/api/auth/refresh` carrying only the httpOnly cookie, exactly as it is once the access
token has expired. On staging the browser also sends the production cookie, which is
scoped to the parent domain, so the stage under test must issue its own cookie name and
must ignore a production one sent alongside it.
"""

from __future__ import annotations

from typing import Any

import pytest
from webbpulse.e2e.identity import login, refresh

WRITES = pytest.mark.e2e_writes

PRODUCTION_COOKIE_NAME = "wp_refresh"
"""The production refresh cookie, which a browser also sends to `api.staging.<domain>`."""

UNSUFFIXED_ENVIRONMENTS = frozenset({"production", "prod", "local", "test"})
"""The environments whose refresh cookie keeps the production name."""


@WRITES
def test_a_page_load_restores_the_session_beside_a_production_cookie(
    anon: Any, credentials: Any, e2e_env: Any
) -> None:
    """A cookie-only refresh, with a production cookie alongside, returns a working access token.

    Marked as writing because it signs in as the durable e2e user, which production does not
    have, so the read-only smoke skips it.
    """
    session = login(anon, credentials.email, credentials.password)
    own = dict(session.refresh_cookies)
    try:
        assert own, "signing in set no refresh cookie, so a page load has nothing to restore from."
        if e2e_env.environment.strip().lower() not in UNSUFFIXED_ENVIRONMENTS:
            assert PRODUCTION_COOKIE_NAME not in own, (
                f"{e2e_env.environment} issues the production cookie name {PRODUCTION_COOKIE_NAME!r}, "
                "so a production tab on the parent domain overwrites this stage's session."
            )
        session.refresh_cookies = {PRODUCTION_COOKIE_NAME: "a production token", **own}

        restored = refresh(session)

        assert restored.status_code == 200, (
            f"a page load's cookie-only refresh answered {restored.status_code}, which sends the "
            f"user to sign in: {restored.text[:300]}"
        )
        token = restored.json()["access_token"]
        me = anon.with_token(token).get("/api/users/me")
        assert me.status_code == 200, f"the restored access token was refused with {me.status_code}."
    finally:
        cookies = {name: value for name, value in session.refresh_cookies.items() if name in own}
        cookie = "; ".join(f"{name}={value}" for name, value in cookies.items())
        anon.post("/api/auth/logout", json={}, headers={"cookie": cookie})
