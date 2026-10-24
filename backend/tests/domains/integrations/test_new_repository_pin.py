"""Repositories created after an install that covers every repository of its account.

GitHub sends no `installation_repositories` event for them, so the stored rows
learn of one from its first delivery, and a pin that misses the rows asks GitHub
whether the installation can see it before refusing.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.domains.integrations import github_issues
from app.domains.integrations.consumers import events
from tests.domains.helpers import ADMIN
from tests.domains.integrations.conftest import INSTALLATION_ID, TEAM, WORKSPACE, sqs_record
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal

NEW_ID = "1431798864"

NEW_FULL_NAME = "WebbPulse/WebbPulse-Site"


def cover_every_repository(repositories: Any) -> None:
    """Record the installation as covering every repository of its account."""
    installation = repositories.github.get_installation(WORKSPACE)
    repositories.github.put_installation(installation.model_copy(update={"repository_selection": "all"}))


def new_repository(*, owner: str = "WebbPulse", private: bool = True) -> dict[str, Any]:
    """The new repository as GitHub's repository object describes it."""
    name = NEW_FULL_NAME.split("/", 1)[1]
    return {
        "id": int(NEW_ID),
        "full_name": f"{owner}/{name}",
        "name": name,
        "owner": {"login": owner},
        "private": private,
        "default_branch": "main",
    }


class FakeGitHub:
    """What the patched repository read answers, and every reference it was asked for."""

    def __init__(self, answer: dict[str, Any] | None) -> None:
        """Answer `answer`, or a not found when it is `None`."""
        self.answer = answer
        self.asked: list[str] = []

    def get_repository(self, token: str, reference: str, **_: Any) -> dict[str, Any]:
        """Record the reference and answer the repository, or raise not found."""
        assert token == "token"
        self.asked.append(reference)
        if self.answer is None:
            raise github_issues.GitHubNotFound("GET answered 404")
        return self.answer


@pytest.fixture
def github(monkeypatch: pytest.MonkeyPatch) -> FakeGitHub:
    """A patched GitHub that sees the new repository."""
    fake = FakeGitHub(new_repository())
    monkeypatch.setattr(github_issues, "installation_token", lambda installation_id: "token")
    monkeypatch.setattr(github_issues, "get_repository", fake.get_repository)
    return fake


def pin(client: TestClient, repositories: Any, reference: str) -> Any:
    """Pin `reference` to the test team through the MCP tool, answering the raw response."""
    secret = mint_for(repositories, ADMIN, ("teams:write",))
    return tool(client, secret, "pin_team_repository", {"team_id": TEAM, "repository": reference})


@pytest.mark.parametrize("reference", [NEW_FULL_NAME, NEW_FULL_NAME.lower(), NEW_ID])
def test_a_pin_finds_a_repository_created_after_an_all_install(
    client: TestClient, repositories: Any, installed: str, github: FakeGitHub, reference: str
) -> None:
    """A miss reads the repository from GitHub, stores its row and pins it."""
    cover_every_repository(repositories)

    pinned = answer(pin(client, repositories, reference))

    row = repositories.github.get_repository(WORKSPACE, NEW_ID)
    assert github.asked == [reference]
    assert pinned["pinned_repositories"] == [NEW_FULL_NAME]
    assert row.team_id == TEAM
    assert row.full_name == NEW_FULL_NAME
    assert row.installation_id == INSTALLATION_ID


def test_a_selected_install_is_not_asked(
    client: TestClient, repositories: Any, installed: str, github: FakeGitHub
) -> None:
    """An installation covering chosen repositories learns them from its events, so a miss is refused."""
    text = refusal(pin(client, repositories, NEW_FULL_NAME))

    assert "cannot see" in text
    assert github.asked == []
    assert repositories.github.get_repository(WORKSPACE, NEW_ID) is None


def test_a_public_repository_of_another_account_is_refused(
    client: TestClient, repositories: Any, installed: str, github: FakeGitHub
) -> None:
    """An installation token reads any public repository, so the owner must be the installation's account."""
    cover_every_repository(repositories)
    github.answer = new_repository(owner="someone-else", private=False)

    text = refusal(pin(client, repositories, "someone-else/WebbPulse-Site"))

    assert "cannot see" in text
    assert repositories.github.get_repository(WORKSPACE, NEW_ID) is None


def test_a_repository_github_does_not_find_is_refused(
    client: TestClient, repositories: Any, installed: str, github: FakeGitHub
) -> None:
    """A not found from GitHub answers the same refusal as before."""
    cover_every_repository(repositories)
    github.answer = None

    text = refusal(pin(client, repositories, NEW_FULL_NAME))

    assert "cannot see" in text
    assert github.asked == [NEW_FULL_NAME]


def repository_delivery(action: str) -> dict[str, Any]:
    """One `repository` delivery for the new repository."""
    return {
        "event": "repository",
        "delivery": f"new-{action}",
        "body": {"action": action, "installation": {"id": int(INSTALLATION_ID)}, "repository": new_repository()},
    }


def test_a_created_delivery_stores_the_row_on_an_all_install(repositories: Any, installed: str) -> None:
    """The `repository` created event is how the rows learn a new repository without a call to GitHub."""
    cover_every_repository(repositories)

    events.handle_record(repositories, sqs_record(repository_delivery("created")))

    row = repositories.github.get_repository(WORKSPACE, NEW_ID)
    assert row is not None
    assert row.full_name == NEW_FULL_NAME
    assert row.team_id is None


def test_a_delivery_keeps_the_pin_of_a_stored_row(repositories: Any, installed: str) -> None:
    """A second delivery for a stored repository changes nothing a person set."""
    cover_every_repository(repositories)
    events.handle_record(repositories, sqs_record(repository_delivery("created")))
    repositories.github.set_repository_team(WORKSPACE, NEW_ID, TEAM)

    events.handle_record(repositories, sqs_record(repository_delivery("edited")))

    assert repositories.github.get_repository(WORKSPACE, NEW_ID).team_id == TEAM


@pytest.mark.parametrize(("selection", "action"), [("selected", "created"), ("all", "deleted")])
def test_a_delivery_stores_nothing_outside_an_all_install_or_for_a_deleted_repository(
    repositories: Any, installed: str, selection: str, action: str
) -> None:
    """A selected install learns its repositories from its own events, and a deleted repository is gone."""
    if selection == "all":
        cover_every_repository(repositories)

    events.handle_record(repositories, sqs_record(repository_delivery(action)))

    assert repositories.github.get_repository(WORKSPACE, NEW_ID) is None
