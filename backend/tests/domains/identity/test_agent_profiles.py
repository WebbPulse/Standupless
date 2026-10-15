"""The account routes over the caller's private agent profiles.

The settings page reads them with a session and the CLI with a personal API key, so
both are driven here, along with the refusals that keep a profile its owner's alone.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient
from webbpulse.audit import AuditActor

from app.common import agent_profiles
from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.db.dynamo.api_keys import service_subject
from tests.domains.helpers import ADMIN, MEMBER, OWNER, add_member, make_user, make_workspace, sign_in

WORKSPACE = "01JB00000000000000000000WS"

ACTOR = AuditActor(id=MEMBER, kind="user", source="mcp")


@pytest.fixture(autouse=True)
def master_key(monkeypatch: pytest.MonkeyPatch) -> None:
    """A master key for sealing, as the app secret carries in a deployed function."""
    monkeypatch.setenv("WEBHOOK_SIGNING_KEY", "dGVzdC1zaWduaW5nLWtleS1ub3QtYS1yZWFsLW9uZQ==")


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client for the identity application, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["identity"])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def seeded(repositories: Any) -> Any:
    """A workspace with an owner, an admin and a member, and two versions of the member's profile."""
    make_user(repositories, OWNER, "owner@example.com", "Olive")
    make_user(repositories, ADMIN, "admin@example.com", "Adam")
    make_user(repositories, MEMBER, "member@example.com", "Mel")
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    for content in ("first", "second"):
        agent_profiles.save_profile(
            repositories,
            MEMBER,
            "laptop",
            [{"root": "home", "path": ".claude/CLAUDE.md", "content": content}],
            f"{content} note",
            ACTOR,
        )
    return repositories


def mint(repositories: Any, user_id: str, scopes: tuple[str, ...]) -> str:
    """A personal API key in the workspace, returning its plaintext."""
    from webbpulse.identity.api_keys import mint as mint_key

    return mint_key(
        user_id=user_id,
        tenant_id=WORKSPACE,
        scopes=scopes,
        name="cli",
        store=repositories.api_keys,
        created_by=user_id,
    ).plaintext


def bearer(secret: str) -> dict[str, str]:
    """The header a CLI sends its key in."""
    return {"Authorization": f"Bearer {secret}"}


def test_the_owner_lists_profiles_and_versions(client: TestClient, seeded: Any) -> None:
    sign_in(client, MEMBER)

    listed = client.get("/api/users/me/agent-profiles").json()
    versions = client.get("/api/users/me/agent-profiles/laptop/versions").json()

    assert [row["name"] for row in listed["profiles"]] == ["laptop"]
    assert listed["profiles"][0]["latest_version"] == 2
    assert listed["versions_kept"] == agent_profiles.VERSIONS_KEPT
    assert [row["version"] for row in versions["versions"]] == [2, 1]
    assert versions["versions"][0]["note"] == "second note"
    assert "content" not in str(versions)


def test_a_restore_answers_the_files_and_lands_on_the_trail(client: TestClient, seeded: Any) -> None:
    sign_in(client, MEMBER)

    latest = client.get("/api/users/me/agent-profiles/laptop").json()
    older = client.get("/api/users/me/agent-profiles/laptop", params={"version": 1}).json()
    activity = client.get("/api/users/me/agent-profiles/activity").json()

    assert latest["files"] == [{"root": "home", "path": ".claude/CLAUDE.md", "content": "second"}]
    assert older["files"][0]["content"] == "first"
    assert sorted(row["event"] for row in activity["events"]) == [
        "agent_profile.restored",
        "agent_profile.restored",
        "agent_profile.saved",
        "agent_profile.saved",
    ]


def test_another_person_and_an_admin_see_nothing(client: TestClient, seeded: Any) -> None:
    for person in (OWNER, ADMIN):
        sign_in(client, person)

        assert client.get("/api/users/me/agent-profiles").json()["profiles"] == []
        assert client.get("/api/users/me/agent-profiles/laptop").status_code == 404
        assert client.delete("/api/users/me/agent-profiles/laptop").status_code == 404
        assert client.get("/api/users/me/agent-profiles/activity").json()["events"] == []

    assert seeded.agent_profiles.get_head(MEMBER, "laptop") is not None


def test_delete_removes_the_profile(client: TestClient, seeded: Any) -> None:
    sign_in(client, MEMBER)

    assert client.delete("/api/users/me/agent-profiles/laptop").status_code == 204
    assert client.get("/api/users/me/agent-profiles").json()["profiles"] == []
    assert client.get("/api/users/me/agent-profiles/laptop").status_code == 404


def test_a_personal_key_with_settings_read_restores(client: TestClient, seeded: Any) -> None:
    secret = mint(seeded, MEMBER, ("settings:read",))

    response = client.get("/api/users/me/agent-profiles/laptop", headers=bearer(secret))
    refused = client.delete("/api/users/me/agent-profiles/laptop", headers=bearer(secret))

    assert response.status_code == 200
    assert response.json()["version"] == 2
    assert refused.status_code == 403
    assert refused.json()["error_code"] == "INSUFFICIENT_SCOPE"


def test_a_key_without_the_settings_scope_is_refused(client: TestClient, seeded: Any) -> None:
    secret = mint(seeded, MEMBER, ("issues:read",))

    response = client.get("/api/users/me/agent-profiles", headers=bearer(secret))

    assert response.status_code == 403
    assert response.json()["error_code"] == "INSUFFICIENT_SCOPE"


def test_a_workspace_key_is_refused(client: TestClient, seeded: Any) -> None:
    secret = mint(seeded, service_subject(WORKSPACE), ("settings:read",))

    response = client.get("/api/users/me/agent-profiles", headers=bearer(secret))

    assert response.status_code == 403


def test_an_anonymous_caller_is_refused(client: TestClient, seeded: Any) -> None:
    assert client.get("/api/users/me/agent-profiles").status_code == 401


def test_deleting_the_account_removes_its_profiles(
    client: TestClient, seeded: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.common import team_purge
    from app.domains.identity import account_revocation

    monkeypatch.setattr(team_purge, "request_account_purge", lambda user_id: True)
    monkeypatch.setattr(account_revocation, "_revoke_refresh_families", lambda user_id: 0)
    monkeypatch.setattr(account_revocation, "_revoke_connected_apps", lambda user_id: 0)
    from webbpulse.identity.email import RecordingEmailSender

    from app.common.email import reset_email_sender

    reset_email_sender(RecordingEmailSender())
    sign_in(client, MEMBER)

    try:
        response = client.post("/api/users/me/deletion", json={"confirm_email": "member@example.com"})
    finally:
        reset_email_sender(None)

    assert response.status_code == 204
    assert seeded.agent_profiles.list_heads(MEMBER) == []
