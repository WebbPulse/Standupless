"""The install round trip: GitHub sends the browser back and the installation is bound.

GitHub is patched at `github_api`, so these pin what the callback does with each
answer GitHub can give: which installation it trusts, which workspace it binds to,
and which outcome the settings page is sent back with.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi.testclient import TestClient

from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.github import Installation, install_key
from app.domains.integrations import github_api, github_oauth, install_state
from app.domains.integrations.install_state import mint_state
from tests.domains.helpers import ADMIN, OWNER, make_workspace, sign_in
from tests.domains.integrations.conftest import INSTALLATION_ID, OTHER_WORKSPACE, WORKSPACE, FakeInstallationClient

APP_ID = "123456"


def _stamp(delta: timedelta = timedelta()) -> str:
    """An ISO timestamp the way GitHub writes one, offset from now."""
    return (datetime.now(timezone.utc) + delta).strftime("%Y-%m-%dT%H:%M:%SZ")


@pytest.fixture
def github(monkeypatch: pytest.MonkeyPatch) -> FakeInstallationClient:
    """A fake GitHub answering for one fresh organization installation of this App."""
    fake = FakeInstallationClient(
        {
            "id": int(INSTALLATION_ID),
            "app_id": int(APP_ID),
            "account": {
                "login": "acme-corp",
                "type": "Organization",
                "avatar_url": "https://avatars.githubusercontent.com/u/1",
            },
            "repository_selection": "selected",
            "html_url": f"https://github.com/organizations/acme-corp/settings/installations/{INSTALLATION_ID}",
            "created_at": _stamp(),
            "updated_at": _stamp(),
            "suspended_at": None,
        },
        [
            {"id": 71, "full_name": "acme-corp/api", "name": "api", "private": True, "default_branch": "main"},
            {"id": 72, "full_name": "acme-corp/web", "name": "web", "private": False, "default_branch": "main"},
        ],
    )
    monkeypatch.setattr(github_api, "app_client", fake.open)
    return fake


def _callback(client: TestClient, **params: str) -> tuple[str, dict[str, list[str]]]:
    """Follow GitHub's redirect into the callback, answering the path and query it sends on to."""
    response = client.get("/api/github/callback", params=params, follow_redirects=False)
    assert response.status_code == 302
    location = urlparse(response.headers["location"])
    return location.path, parse_qs(location.query)


def _bind(repositories: Any, workspace_id: str) -> None:
    """Store the installation as already bound to one workspace."""
    repositories.github.create_installation(
        Installation(
            workspace_id=workspace_id,
            github_key=install_key(INSTALLATION_ID),
            installation_id=INSTALLATION_ID,
            account_login="acme-corp",
            installed_by=OWNER,
            installed_at=utc_now(),
        )
    )


def test_an_install_binds_to_the_workspace_and_lists_its_repositories(
    client: TestClient, workspace: str, repositories: Any, github: FakeInstallationClient
) -> None:
    """The happy path: bound, synced with an installation token, and sent back to settings."""
    state, _ = mint_state(WORKSPACE, ADMIN)

    path, query = _callback(client, installation_id=INSTALLATION_ID, setup_action="install", state=state)

    assert path == "/w/acme/settings"
    assert query["github"] == ["installed"]
    installation = repositories.github.get_installation(WORKSPACE)
    assert installation is not None
    assert installation.account_login == "acme-corp"
    assert installation.installed_by == ADMIN
    assert installation.avatar_url == "https://avatars.githubusercontent.com/u/1"
    names = sorted(row.full_name for row in repositories.github.list_repositories(WORKSPACE))
    assert names == ["acme-corp/api", "acme-corp/web"]
    assert github.listed == [INSTALLATION_ID]
    assert github.clients == 1


def test_a_state_is_redeemed_once(
    client: TestClient, workspace: str, repositories: Any, github: FakeInstallationClient
) -> None:
    """Replaying the same redirect from a browser history binds nothing a second time."""
    state, _ = mint_state(WORKSPACE, ADMIN)
    _callback(client, installation_id=INSTALLATION_ID, setup_action="install", state=state)
    repositories.github.delete_installation(WORKSPACE)

    path, query = _callback(client, installation_id=INSTALLATION_ID, setup_action="install", state=state)

    assert path == "/w/acme/settings"
    assert query["github"] == ["invalid_state"]
    assert repositories.github.get_installation(WORKSPACE) is None


def test_an_unsigned_state_is_refused(
    client: TestClient, workspace: str, repositories: Any, github: FakeInstallationClient
) -> None:
    """A forged state names no workspace the callback will trust."""
    path, query = _callback(client, installation_id=INSTALLATION_ID, setup_action="install", state="forged")

    assert path == "/workspaces"
    assert query["github"] == ["invalid_state"]
    assert repositories.github.installation_by_id(INSTALLATION_ID) is None


def test_an_installation_this_app_cannot_read_is_refused(
    client: TestClient, workspace: str, repositories: Any, github: FakeInstallationClient
) -> None:
    """A spoofed id GitHub answers 404 for is never written."""
    github.status = 404
    state, _ = mint_state(WORKSPACE, ADMIN)

    _, query = _callback(client, installation_id=INSTALLATION_ID, setup_action="install", state=state)

    assert query["github"] == ["not_found"]
    assert repositories.github.get_installation(WORKSPACE) is None


def test_an_installation_of_another_app_is_refused(
    client: TestClient, workspace: str, repositories: Any, github: FakeInstallationClient
) -> None:
    """The app id on the installation must be this App's."""
    github.installation["app_id"] = 999
    state, _ = mint_state(WORKSPACE, ADMIN)

    _, query = _callback(client, installation_id=INSTALLATION_ID, setup_action="install", state=state)

    assert query["github"] == ["not_found"]
    assert repositories.github.get_installation(WORKSPACE) is None


def test_an_installation_bound_elsewhere_is_refused(
    client: TestClient, workspace: str, repositories: Any, github: FakeInstallationClient
) -> None:
    """One installation feeds one workspace, so a second claim on it is turned away."""
    make_workspace(repositories, OTHER_WORKSPACE, "other", OWNER)
    _bind(repositories, OTHER_WORKSPACE)
    state, _ = mint_state(WORKSPACE, ADMIN)

    _, query = _callback(client, installation_id=INSTALLATION_ID, setup_action="install", state=state)

    assert query["github"] == ["taken"]
    assert repositories.github.get_installation(WORKSPACE) is None


def test_a_workspace_with_another_installation_is_refused(
    client: TestClient, workspace: str, repositories: Any, github: FakeInstallationClient
) -> None:
    """A workspace holds one installation, so a second is refused until the first is disconnected."""
    repositories.github.create_installation(
        Installation(
            workspace_id=WORKSPACE,
            github_key=install_key("1"),
            installation_id="1",
            account_login="someone-else",
            installed_by=OWNER,
            installed_at=utc_now(),
        )
    )
    state, _ = mint_state(WORKSPACE, ADMIN)

    _, query = _callback(client, installation_id=INSTALLATION_ID, setup_action="install", state=state)

    assert query["github"] == ["already_connected"]
    assert repositories.github.installation_by_id(INSTALLATION_ID) is None


def test_an_installation_older_than_the_state_is_refused(
    client: TestClient, workspace: str, repositories: Any, github: FakeInstallationClient
) -> None:
    """An unclaimed installation that was not made during this connect cannot be claimed by naming its id."""
    github.installation["created_at"] = _stamp(-timedelta(days=3))
    github.installation["updated_at"] = _stamp(-timedelta(days=3))
    state, _ = mint_state(WORKSPACE, ADMIN)

    _, query = _callback(client, installation_id=INSTALLATION_ID, setup_action="install", state=state)

    assert query["github"] == ["stale"]
    assert repositories.github.get_installation(WORKSPACE) is None


def test_an_update_during_the_connect_rebinds_an_existing_installation(
    client: TestClient, workspace: str, repositories: Any, github: FakeInstallationClient
) -> None:
    """Reconnecting an account that already has the App works when the selection was saved just now."""
    github.installation["created_at"] = _stamp(-timedelta(days=3))
    state, _ = mint_state(WORKSPACE, ADMIN)

    _, query = _callback(client, installation_id=INSTALLATION_ID, setup_action="update", state=state)

    assert query["github"] == ["installed"]
    assert repositories.github.get_installation(WORKSPACE) is not None


def test_an_update_from_github_refreshes_the_bound_installation(
    client: TestClient, workspace: str, repositories: Any, github: FakeInstallationClient
) -> None:
    """A selection change started on GitHub arrives with no state and only refreshes."""
    _bind(repositories, WORKSPACE)
    github.installation["repository_selection"] = "all"

    path, query = _callback(client, installation_id=INSTALLATION_ID, setup_action="update")

    assert path == "/w/acme/settings"
    assert query["github"] == ["updated"]
    installation = repositories.github.get_installation(WORKSPACE)
    assert installation is not None
    assert installation.repository_selection == "all"
    assert len(repositories.github.list_repositories(WORKSPACE)) == 2


def test_an_update_for_an_unbound_installation_binds_nothing(
    client: TestClient, workspace: str, repositories: Any, github: FakeInstallationClient
) -> None:
    """Without a state there is no workspace to bind to, so nothing is written."""
    path, query = _callback(client, installation_id=INSTALLATION_ID, setup_action="update")

    assert path == "/workspaces"
    assert query["github"] == ["unbound"]
    assert repositories.github.installation_by_id(INSTALLATION_ID) is None


def test_a_request_waits_for_an_organization_owner(
    client: TestClient, workspace: str, repositories: Any, github: FakeInstallationClient
) -> None:
    """A member who could only request the install is told it is pending."""
    state, _ = mint_state(WORKSPACE, ADMIN)

    _, query = _callback(client, setup_action="request", state=state)

    assert query["github"] == ["pending"]


def test_a_non_numeric_installation_id_is_refused(
    client: TestClient, workspace: str, repositories: Any, github: FakeInstallationClient
) -> None:
    """An installation id is a number, and anything else never reaches GitHub."""
    state, _ = mint_state(WORKSPACE, ADMIN)

    _, query = _callback(client, installation_id="../../etc", setup_action="install", state=state)

    assert query["github"] == ["error"]


def test_the_installation_read_names_where_to_manage_it(client: TestClient, workspace: str, installed: str) -> None:
    """The settings page links to the installation's own page on GitHub."""
    sign_in(client, ADMIN)

    body = client.get(f"/api/workspaces/{WORKSPACE}/github/installation").json()

    assert body["manage_url"] == f"https://github.com/organizations/WebbPulse/settings/installations/{INSTALLATION_ID}"
    assert body["suspended"] is False


def test_the_installation_read_says_when_no_app_exists(
    client: TestClient, workspace: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """With no App the read answers NOT_CONFIGURED, so the page can say so instead of offering a dead button."""
    from app.common.core.config import settings

    monkeypatch.setattr(settings, "GITHUB_APP_SLUG", "", raising=False)
    sign_in(client, ADMIN)

    response = client.get(f"/api/workspaces/{WORKSPACE}/github/installation")

    assert response.status_code == 503
    assert response.json()["error_code"] == "NOT_CONFIGURED"


@pytest.fixture
def authorization(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """A fake user authorization answering whether the person behind a code can reach an installation."""
    fake: dict[str, Any] = {"reachable": {INSTALLATION_ID}, "error": False, "calls": []}

    def user_can_reach(code: str, installation_id: str, **_: Any) -> bool:
        """Record the call and answer from the reachable set, or fail as GitHub would."""
        fake["calls"].append((code, installation_id))
        if fake["error"]:
            raise github_oauth.OAuthError("no answer")
        return installation_id in fake["reachable"]

    monkeypatch.setattr(github_oauth, "user_can_reach", user_can_reach)
    return fake


def _age(github: FakeInstallationClient, days: int = 3) -> None:
    """Make the fake installation one that existed well before any state was minted."""
    github.installation["created_at"] = _stamp(-timedelta(days=days))
    github.installation["updated_at"] = _stamp(-timedelta(days=days))


def test_an_install_with_user_authorization_binds_and_lands_on_settings(
    client: TestClient, workspace: str, repositories: Any, github: FakeInstallationClient, authorization: dict[str, Any]
) -> None:
    """The Callback URL path: the code is checked against the installation and the install is bound."""
    state, _ = mint_state(WORKSPACE, ADMIN)

    path, query = _callback(client, code="a-code", installation_id=INSTALLATION_ID, setup_action="install", state=state)

    assert path == "/w/acme/settings"
    assert query["github"] == ["installed"]
    assert authorization["calls"] == [("a-code", INSTALLATION_ID)]
    installation = repositories.github.get_installation(WORKSPACE)
    assert installation is not None
    assert installation.installed_by == ADMIN
    assert len(repositories.github.list_repositories(WORKSPACE)) == 2


def test_user_authorization_binds_an_installation_that_predates_the_state(
    client: TestClient, workspace: str, repositories: Any, github: FakeInstallationClient, authorization: dict[str, Any]
) -> None:
    """Connecting an account that already had the App needs no change on GitHub once GitHub vouches for the person."""
    _age(github)
    state, _ = mint_state(WORKSPACE, ADMIN)

    _, query = _callback(client, code="a-code", installation_id=INSTALLATION_ID, setup_action="update", state=state)

    assert query["github"] == ["installed"]
    assert repositories.github.get_installation(WORKSPACE) is not None


def test_an_installation_the_person_cannot_reach_is_refused(
    client: TestClient, workspace: str, repositories: Any, github: FakeInstallationClient, authorization: dict[str, Any]
) -> None:
    """A spoofed installation id is refused when GitHub says the person behind the code cannot reach it."""
    authorization["reachable"] = set()
    state, _ = mint_state(WORKSPACE, ADMIN)

    path, query = _callback(client, code="a-code", installation_id=INSTALLATION_ID, setup_action="install", state=state)

    assert path == "/w/acme/settings"
    assert query["github"] == ["not_yours"]
    assert repositories.github.installation_by_id(INSTALLATION_ID) is None


def test_no_answer_from_user_authorization_falls_back_to_freshness(
    client: TestClient, workspace: str, repositories: Any, github: FakeInstallationClient, authorization: dict[str, Any]
) -> None:
    """A fresh install still binds when the code exchange fails, and an old one is still refused."""
    authorization["error"] = True
    state, _ = mint_state(WORKSPACE, ADMIN)

    _, query = _callback(client, code="a-code", installation_id=INSTALLATION_ID, setup_action="install", state=state)

    assert query["github"] == ["installed"]

    repositories.github.delete_installation(WORKSPACE)
    _age(github)
    state, _ = mint_state(WORKSPACE, ADMIN)

    _, query = _callback(client, code="a-code", installation_id=INSTALLATION_ID, setup_action="install", state=state)

    assert query["github"] == ["stale"]


def test_an_update_with_user_authorization_refreshes_the_bound_installation(
    client: TestClient, workspace: str, repositories: Any, github: FakeInstallationClient, authorization: dict[str, Any]
) -> None:
    """Choosing repositories again through Connect GitHub updates the row already bound here."""
    _bind(repositories, WORKSPACE)
    github.installation["repository_selection"] = "all"
    state, _ = mint_state(WORKSPACE, ADMIN)

    _, query = _callback(client, code="a-code", installation_id=INSTALLATION_ID, setup_action="update", state=state)

    assert query["github"] == ["updated"]
    installation = repositories.github.get_installation(WORKSPACE)
    assert installation is not None
    assert installation.repository_selection == "all"
    assert installation.installed_by == OWNER


def test_a_reinstall_replaces_an_installation_github_no_longer_knows(
    client: TestClient, workspace: str, repositories: Any, github: FakeInstallationClient, authorization: dict[str, Any]
) -> None:
    """Uninstalling on GitHub then connecting again binds the new installation before the uninstall webhook lands."""
    repositories.github.create_installation(
        Installation(
            workspace_id=WORKSPACE,
            github_key=install_key("1"),
            installation_id="1",
            account_login="acme-corp",
            installed_by=OWNER,
            installed_at=utc_now(),
        )
    )
    github.missing.add("1")
    state, _ = mint_state(WORKSPACE, ADMIN)

    _, query = _callback(client, code="a-code", installation_id=INSTALLATION_ID, setup_action="install", state=state)

    assert query["github"] == ["installed"]
    installation = repositories.github.get_installation(WORKSPACE)
    assert installation is not None
    assert installation.installation_id == INSTALLATION_ID
    assert repositories.github.installation_by_id("1") is None


def test_an_expired_state_with_a_code_binds_nothing_and_names_the_workspace(
    client: TestClient,
    workspace: str,
    repositories: Any,
    github: FakeInstallationClient,
    authorization: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An admin who took too long is sent back to their own settings to start again, and the code is never spent."""
    monkeypatch.setattr(install_state, "STATE_TTL_SECONDS", -60)
    state, _ = mint_state(WORKSPACE, ADMIN)

    path, query = _callback(client, code="a-code", installation_id=INSTALLATION_ID, setup_action="install", state=state)

    assert path == "/w/acme/settings"
    assert query["github"] == ["invalid_state"]
    assert authorization["calls"] == []
    assert repositories.github.installation_by_id(INSTALLATION_ID) is None


def test_an_install_with_no_state_binds_nothing(
    client: TestClient, workspace: str, repositories: Any, github: FakeInstallationClient, authorization: dict[str, Any]
) -> None:
    """An owner approving a member's request comes back with no state, so nothing is bound and they are told how."""
    path, query = _callback(client, code="a-code", installation_id=INSTALLATION_ID, setup_action="install")

    assert path == "/workspaces"
    assert query["github"] == ["unbound"]
    assert authorization["calls"] == []
    assert repositories.github.installation_by_id(INSTALLATION_ID) is None
