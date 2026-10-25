"""The public route a notification email's unsubscribe links open.

Driven without a session, the way a signed out reader or a mail client's RFC 8058
one-click request reaches it, covering each action, the Undo, and the refusals
that answer the same neutral page.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta
from html import unescape
from typing import Any, Iterator
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.email_unsubscribe import (
    ISSUE,
    KIND,
    PROJECT,
    PULSE_DIGEST_KIND,
    UNSUBSCRIBE_PATH,
    UNSUBSCRIBE_TOKEN_TTL,
    mint_unsubscribe_token,
)
from tests.domains.helpers import MEMBER, OWNER, add_member, make_user, make_workspace

WORKSPACE = "01JB00000000000000000000WS"
ISSUE_ID = "01JB0000000000000000ISSUE1"
TEAM_ID = "01JB00000000000000000TEAM1"
PROJECT_ID = "01JB000000000000000PROJECT"


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client for the identity application, bound to the mocked tables and never signed in."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["identity"])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def seeded(repositories: Any) -> Any:
    """A workspace with an owner and a member who follows one issue."""
    make_user(repositories, OWNER, "owner@example.com", "Olive")
    make_user(repositories, MEMBER, "member@example.com", "Mel")
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    add_member(repositories, WORKSPACE, MEMBER, "member")
    repositories.subscriptions.subscribe(WORKSPACE, ISSUE_ID, TEAM_ID, MEMBER, "assigned")
    return repositories


def token(action: str, target: str, **extra: Any) -> str:
    """A stop token for the member."""
    return mint_unsubscribe_token(user_id=MEMBER, workspace_id=WORKSPACE, action=action, target=target, **extra)


def undo_token(html: str) -> str:
    """The token the page's Undo button posts back."""
    match = re.search(r'action="([^"]+)"', html)
    assert match is not None, "the page offers no button"
    return parse_qs(urlsplit(unescape(match.group(1))).query)["token"][0]


def test_get_confirms_without_changing_anything(client: TestClient, seeded: Any) -> None:
    """A mail scanner fetching the link leaves the subscription alone."""
    response = client.get(UNSUBSCRIBE_PATH, params={"token": token(ISSUE, ISSUE_ID, label="ENG-1")})
    assert response.status_code == 200
    assert "Unsubscribe from issue ENG-1" in response.text
    assert 'method="post"' in response.text
    assert response.headers["cache-control"] == "no-store"
    assert seeded.subscriptions.get(WORKSPACE, ISSUE_ID, MEMBER) is not None


def test_post_unsubscribes_from_an_issue_and_undo_restores_it(client: TestClient, seeded: Any) -> None:
    """One-click removes the subscription, and Undo puts back its team and reason."""
    response = client.post(UNSUBSCRIBE_PATH, params={"token": token(ISSUE, ISSUE_ID)})
    assert response.status_code == 200
    assert seeded.subscriptions.get(WORKSPACE, ISSUE_ID, MEMBER) is None

    undone = client.post(UNSUBSCRIBE_PATH, params={"token": undo_token(response.text)})
    assert undone.status_code == 200
    restored = seeded.subscriptions.get(WORKSPACE, ISSUE_ID, MEMBER)
    assert restored is not None
    assert (restored.team_id, restored.reason) == (TEAM_ID, "assigned")


def test_post_ignores_the_one_click_body(client: TestClient, seeded: Any) -> None:
    """A mail client's `List-Unsubscribe=One-Click` form body applies the same change."""
    response = client.post(
        UNSUBSCRIBE_PATH,
        params={"token": token(ISSUE, ISSUE_ID)},
        content="List-Unsubscribe=One-Click",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    assert response.status_code == 200
    assert seeded.subscriptions.get(WORKSPACE, ISSUE_ID, MEMBER) is None


def test_a_second_post_is_not_an_error(client: TestClient, seeded: Any) -> None:
    """Applying a stop twice answers the done page without an Undo."""
    client.post(UNSUBSCRIBE_PATH, params={"token": token(ISSUE, ISSUE_ID)})
    again = client.post(UNSUBSCRIBE_PATH, params={"token": token(ISSUE, ISSUE_ID)})
    assert again.status_code == 200
    assert 'method="post"' not in again.text


def test_post_unfollows_a_project_and_undo_follows_again(client: TestClient, seeded: Any) -> None:
    """The project link records an explicit unfollow, which stops project update email."""
    response = client.post(UNSUBSCRIBE_PATH, params={"token": token(PROJECT, PROJECT_ID)})
    assert response.status_code == 200
    assert seeded.planning.get_pulse_follow(WORKSPACE, MEMBER, "project", PROJECT_ID) is False

    client.post(UNSUBSCRIBE_PATH, params={"token": undo_token(response.text)})
    assert seeded.planning.get_pulse_follow(WORKSPACE, MEMBER, "project", PROJECT_ID) is True


def test_post_turns_off_one_kind_and_undo_turns_it_back_on(client: TestClient, seeded: Any) -> None:
    """The kind link moves exactly one email switch, kept sparse once restored."""
    response = client.post(UNSUBSCRIBE_PATH, params={"token": token(KIND, "commented")})
    assert response.status_code == 200
    user = seeded.users.get(MEMBER)
    assert user.wants_notification("commented", "email") is False

    client.post(UNSUBSCRIBE_PATH, params={"token": undo_token(response.text)})
    restored = seeded.users.get(MEMBER)
    assert restored.wants_notification("commented", "email") is True
    assert "commented" not in restored.notification_preferences


def test_post_turns_off_the_pulse_digest_and_undo_restores_the_cadence(client: TestClient, seeded: Any) -> None:
    """The Pulse digest is a cadence, so Undo puts back the one the person had."""
    seeded.users.update(MEMBER, pulse_digest="weekly")
    response = client.post(UNSUBSCRIBE_PATH, params={"token": token(KIND, PULSE_DIGEST_KIND)})
    assert response.status_code == 200
    assert seeded.users.get(MEMBER).pulse_digest == "off"

    client.post(UNSUBSCRIBE_PATH, params={"token": undo_token(response.text)})
    assert seeded.users.get(MEMBER).pulse_digest == "weekly"


def test_the_undo_link_confirms_on_get(client: TestClient, seeded: Any) -> None:
    """An undo token opened by a fetch only asks."""
    response = client.post(UNSUBSCRIBE_PATH, params={"token": token(ISSUE, ISSUE_ID)})
    page = client.get(UNSUBSCRIBE_PATH, params={"token": undo_token(response.text)})
    assert page.status_code == 200
    assert "Undo unsubscribe" in page.text
    assert seeded.subscriptions.get(WORKSPACE, ISSUE_ID, MEMBER) is None


def _assert_neutral(response: Any) -> None:
    """The one page every unusable token gets, which names nobody."""
    assert response.status_code == 400
    assert "This link has expired" in response.text
    assert "/workspaces" in response.text
    assert "member@example.com" not in response.text


@pytest.mark.parametrize("method", ["get", "post"])
def test_a_tampered_token_gets_the_neutral_page(client: TestClient, seeded: Any, method: str) -> None:
    """A broken signature changes nothing on either method."""
    bad = token(ISSUE, ISSUE_ID)[:-4] + "abcd"
    _assert_neutral(getattr(client, method)(UNSUBSCRIBE_PATH, params={"token": bad}))
    assert seeded.subscriptions.get(WORKSPACE, ISSUE_ID, MEMBER) is not None


def test_a_missing_token_gets_the_neutral_page(client: TestClient, seeded: Any) -> None:
    """No token is the same refusal."""
    _assert_neutral(client.post(UNSUBSCRIBE_PATH))


def test_an_expired_token_gets_the_neutral_page(client: TestClient, seeded: Any) -> None:
    """An old forwarded email stops working."""
    stale = token(ISSUE, ISSUE_ID, now=datetime.now(UTC) - UNSUBSCRIBE_TOKEN_TTL - timedelta(hours=1))
    _assert_neutral(client.post(UNSUBSCRIBE_PATH, params={"token": stale}))
    assert seeded.subscriptions.get(WORKSPACE, ISSUE_ID, MEMBER) is not None


def test_a_removed_member_gets_the_neutral_page(client: TestClient, seeded: Any) -> None:
    """Revoking workspace access revokes the links mailed under it."""
    stop = token(KIND, "commented")
    seeded.memberships.remove_user(WORKSPACE, MEMBER)
    _assert_neutral(client.post(UNSUBSCRIBE_PATH, params={"token": stop}))


def test_a_suspended_member_gets_the_neutral_page(client: TestClient, seeded: Any) -> None:
    """A suspended member's links stop working too."""
    stop = token(KIND, "commented")
    seeded.memberships.set_suspended(WORKSPACE, MEMBER, suspended_by=OWNER)
    _assert_neutral(client.post(UNSUBSCRIBE_PATH, params={"token": stop}))


def test_a_disabled_user_gets_the_neutral_page(client: TestClient, seeded: Any) -> None:
    """A disabled account's links stop working."""
    stop = token(KIND, "commented")
    seeded.users.update(MEMBER, disabled=True)
    _assert_neutral(client.post(UNSUBSCRIBE_PATH, params={"token": stop}))
    assert seeded.users.get(MEMBER).wants_notification("commented", "email") is True


def test_an_unknown_kind_gets_the_neutral_page(client: TestClient, seeded: Any) -> None:
    """A signed token for a kind the product does not send changes nothing."""
    _assert_neutral(client.post(UNSUBSCRIBE_PATH, params={"token": token(KIND, "not_a_kind")}))
