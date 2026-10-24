"""Personal notifications as Discord direct messages: the settings link, the post and its failures.

Discord is faked at `api.bot`, `api.exchange_code` and `api.current_user` as in
`test_discord.py`, with the DM channel open answered with a channel id, so the
link, rendering and every refusal path run without reaching Discord.
"""

from __future__ import annotations

from typing import Any, Iterator
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi.testclient import TestClient

from app.common.chat_digests import CHAT_DIGEST_JOB, ChatDigest, ChatDigestGroup
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.chat_routes import ChatRoute
from app.common.db.dynamo.discord import DiscordInstallation
from app.domains.integrations.consumers import dispatch
from app.domains.integrations.discord import api, direct, install, people
from app.domains.integrations.discord.api import DiscordError
from tests.domains.helpers import MEMBER, OWNER, sign_in
from tests.domains.integrations.conftest import WORKSPACE, sqs_record
from tests.domains.integrations.test_discord import (
    APPLICATION_ID,
    BOT_TOKEN,
    GUILD,
    PUBLIC_KEY,
    FakeDiscord,
    _link,
    people_claims,
)

LINK_PATH = f"/api/workspaces/{WORKSPACE}/discord/me"

DM_CHANNEL = "1500000000000000001"


class DirectDiscord(FakeDiscord):
    """The shared Discord fake, also answering the DM channel open with a channel id."""

    def bot(self, method: str, path: str, payload: Any = None) -> Any:
        """Answer `POST /users/@me/channels` with a channel, deferring every other call."""
        answer = super().bot(method, path, payload)
        if method == "POST" and path == "/users/@me/channels":
            return {"id": DM_CHANNEL, "type": 1}
        return answer

    def posts(self) -> list[Any]:
        """The message bodies posted to the DM channel, in order."""
        return [payload for name, path, payload in self.calls if path == f"/channels/{DM_CHANNEL}/messages"]


@pytest.fixture
def discord(monkeypatch: pytest.MonkeyPatch) -> DirectDiscord:
    """A configured Discord App whose every call, DM channels included, goes to a fake."""
    monkeypatch.setenv("DISCORD_APPLICATION_ID", APPLICATION_ID)
    monkeypatch.setenv("DISCORD_PUBLIC_KEY", PUBLIC_KEY)
    monkeypatch.setenv("DISCORD_CLIENT_SECRET", "a-test-discord-client-secret")
    monkeypatch.setenv("DISCORD_BOT_TOKEN", BOT_TOKEN)
    fake = DirectDiscord()
    monkeypatch.setattr(api, "bot", fake.bot)
    monkeypatch.setattr(api, "exchange_code", fake.exchange_code)
    monkeypatch.setattr(api, "current_user", fake.current_user)
    return fake


@pytest.fixture
def installed(repositories: Any, workspace: str, discord: DirectDiscord) -> DiscordInstallation:
    """The Discord App installed in the test workspace, with every member's email confirmed."""
    for user_id in (OWNER, MEMBER):
        repositories.users.update(user_id, email_verified=True)
    return install.bind(repositories, WORKSPACE, OWNER, discord.exchange_code("a-code"))


@pytest.fixture
def member_client(client: TestClient, installed: DiscordInstallation) -> Iterator[TestClient]:
    """The integrations client signed in as the plain member."""
    sign_in(client, MEMBER)
    yield client


def _route(repositories: Any, **fields: Any) -> ChatRoute:
    """Store the member's Discord route directly, for the send tests."""
    values: dict[str, Any] = {
        "workspace_id": WORKSPACE,
        "user_id": MEMBER,
        "provider": "discord",
        "external_user_id": "D_MEMBER",
        "external_team_id": GUILD,
        "linked_at": utc_now(),
    }
    values.update(fields)
    return repositories.inbox.chat_routes.put(ChatRoute(**values))


def _digest(**fields: Any) -> ChatDigest:
    """One window of the member's notifications about one issue."""
    values: dict[str, Any] = {
        "workspace_id": WORKSPACE,
        "recipient_id": MEMBER,
        "window": 1_790_000_000,
        "workspace_name": "Acme",
        "inbox_url": "https://staging.standupless.dev/w/acme/inbox",
        "groups": [
            ChatDigestGroup(
                label="ABC-1 Fix *the* login",
                url="https://staging.standupless.dev/w/acme/issues/ABC-1",
                lines=["Olive commented and asked @everyone"],
            )
        ],
    }
    values.update(fields)
    return ChatDigest(**values)


def _settings_callback(client: TestClient, **params: str) -> tuple[str, dict[str, list[str]]]:
    """Ask for the member's consent link and follow Discord's redirect back, answering where it lands."""
    started = client.get(f"{LINK_PATH}/link-url")
    assert started.status_code == 200, started.text
    consent = parse_qs(urlparse(started.json()["url"]).query)
    assert consent["scope"] == ["identify"]
    response = client.get(
        "/api/discord/oauth/callback", params={"state": consent["state"][0], **params}, follow_redirects=False
    )
    assert response.status_code == 302, response.text
    location = urlparse(response.headers["location"])
    return location.path, parse_qs(location.query)


def test_a_member_links_from_settings_with_identify_alone(
    member_client: TestClient, repositories: Any, discord: DirectDiscord
) -> None:
    """The read starts unlinked, the consent returns to settings linked, and an unlink forgets it."""
    before = member_client.get(LINK_PATH)
    assert before.status_code == 200, before.text
    assert before.json()["available"] is True
    assert before.json()["linked"] is False

    discord.person = "D_STRANGER"
    path, query = _settings_callback(member_client, code="a-code")
    assert path.endswith("/settings/notifications")
    assert query["discord_dm"] == ["linked"]

    after = member_client.get(LINK_PATH).json()
    assert after["linked"] is True
    assert after["discord_user_id"] == "D_STRANGER"
    assert after["guild_name"] == "Acme Discord"
    assert after["problem"] is None
    link = repositories.github.discord.get_link(WORKSPACE, "D_STRANGER")
    assert link is not None and link.user_id == MEMBER

    removed = member_client.delete(LINK_PATH)
    assert removed.status_code == 204
    assert repositories.inbox.chat_routes.get(WORKSPACE, MEMBER, "discord") is None
    assert repositories.github.discord.get_link(WORKSPACE, "D_STRANGER") is None
    assert member_client.delete(LINK_PATH).status_code == 404


def test_a_settings_link_returns_its_refusal_to_settings(
    member_client: TestClient, repositories: Any, discord: DirectDiscord
) -> None:
    """A cancelled consent and a member without a confirmed email each land back on settings, unlinked."""
    _, denied = _settings_callback(member_client, error="access_denied")
    assert denied["discord_dm"] == ["denied"]

    repositories.users.update(MEMBER, email_verified=False)
    _, unverified = _settings_callback(member_client, code="a-code")
    assert unverified["discord_dm"] == ["unverified_email"]
    assert repositories.inbox.chat_routes.list(WORKSPACE, MEMBER) == []


def test_a_link_url_needs_an_installed_app(
    client: TestClient, repositories: Any, workspace: str, discord: DirectDiscord
) -> None:
    """Without an installation the read says unavailable and no consent link is handed out."""
    sign_in(client, MEMBER)
    assert client.get(LINK_PATH).json() == {
        "configured": True,
        "available": False,
        "linked": False,
        "discord_user_id": None,
        "guild_name": None,
        "linked_at": None,
        "problem": None,
    }
    assert client.get(f"{LINK_PATH}/link-url").status_code == 404


def test_a_command_link_also_routes_direct_messages(
    installed: DiscordInstallation, repositories: Any, discord: DirectDiscord
) -> None:
    """Linking from a Discord command writes the same route, and moving the account moves the route."""
    _link(repositories, installed, discord, "D_OWNER")
    route = repositories.inbox.chat_routes.get(WORKSPACE, OWNER, "discord")
    assert route is not None and route.external_user_id == "D_OWNER" and route.external_team_id == GUILD

    discord.person = "D_OWNER"
    url, _ = people.settings_link_url(installed, MEMBER)
    people.complete_link(repositories, people_claims(parse_qs(urlparse(url).query)["state"][0]), "a-token")
    assert repositories.inbox.chat_routes.get(WORKSPACE, OWNER, "discord") is None
    moved = repositories.inbox.chat_routes.get(WORKSPACE, MEMBER, "discord")
    assert moved is not None and moved.external_user_id == "D_OWNER"


def test_a_batch_opens_the_dm_and_posts_once_with_escaped_text(
    installed: DiscordInstallation, repositories: Any, discord: DirectDiscord
) -> None:
    """The bot opens the member's DM, posts one embed that mentions nobody, and a redelivery posts nothing."""
    _route(repositories)
    assert direct.send(repositories, _digest()) is True
    assert ("POST", "/users/@me/channels", {"recipient_id": "D_MEMBER"}) in discord.calls
    [body] = discord.posts()
    assert body["allowed_mentions"] == {"parse": []}
    embed = body["embeds"][0]
    assert embed["title"] == "1 Standupless notification"
    assert "Fix \\*the\\* login" in embed["description"]
    assert "(https://staging.standupless.dev/w/acme/issues/ABC-1)" in embed["description"]
    assert embed["footer"]["text"] == "Acme"

    assert direct.send(repositories, _digest()) is False
    assert len(discord.posts()) == 1


def test_a_long_batch_points_at_the_inbox_for_the_rest() -> None:
    """The description counts what the message left out, and the title counts it all."""
    embed = direct.render(_digest(more=4))["embeds"][0]
    assert "4 more in your inbox." in embed["description"]
    assert embed["title"] == "5 Standupless notifications"
    crowded = _digest(groups=[ChatDigestGroup(label="ABC-2", url="", lines=["y" * 300] * 40)])
    assert len(direct.render(crowded)["embeds"][0]["description"]) <= direct.DESCRIPTION_LIMIT


@pytest.mark.parametrize(
    ("error", "reason"),
    [
        (DiscordError(403, 50007), "discord_50007"),
        (DiscordError(400, 50033), "discord_50033"),
        (DiscordError(404, 10013), "discord_10013"),
        (DiscordError(403), "discord_403"),
    ],
)
def test_a_refusal_no_retry_fixes_breaks_the_route(
    installed: DiscordInstallation, repositories: Any, discord: DirectDiscord, error: DiscordError, reason: str
) -> None:
    """The route stops delivering with the reason, and the next batch opens nothing."""
    _route(repositories)
    discord.errors[("POST", f"/channels/{DM_CHANNEL}/messages")] = error
    assert direct.send(repositories, _digest()) is False
    route = repositories.inbox.chat_routes.get(WORKSPACE, MEMBER, "discord")
    assert route is not None and route.broken_reason == reason
    assert repositories.inbox.chat_routes.active(WORKSPACE, MEMBER) == []

    discord.calls.clear()
    assert direct.send(repositories, _digest(window=1_790_000_120)) is False
    assert discord.calls == []


@pytest.mark.parametrize("status", [429, 500, 401])
def test_a_retryable_refusal_raises_and_releases_the_window(
    installed: DiscordInstallation, repositories: Any, discord: DirectDiscord, status: int
) -> None:
    """A rate limit, an outage or a refused bot token raises for the queue, and the retry posts."""
    _route(repositories)
    discord.errors[("POST", "/users/@me/channels")] = DiscordError(status)
    with pytest.raises(DiscordError):
        direct.send(repositories, _digest())
    assert repositories.inbox.chat_routes.active(WORKSPACE, MEMBER) != []

    discord.errors.clear()
    assert direct.send(repositories, _digest()) is True


def test_a_route_from_another_server_or_an_uninstall_is_broken_without_a_post(
    installed: DiscordInstallation, repositories: Any, discord: DirectDiscord, member_client: TestClient
) -> None:
    """A reinstall into another server never delivers to the person linked before, and settings say why."""
    _route(repositories, external_team_id="1200000000000000009")
    assert member_client.get(LINK_PATH).json()["problem"] == direct.GUILD_CHANGED
    assert direct.send(repositories, _digest()) is False
    assert discord.posts() == []
    route = repositories.inbox.chat_routes.get(WORKSPACE, MEMBER, "discord")
    assert route is not None and route.broken_reason == direct.GUILD_CHANGED

    _route(repositories)
    repositories.github.discord.delete(WORKSPACE)
    assert member_client.get(LINK_PATH).json()["problem"] == direct.UNINSTALLED


def test_the_dispatch_consumer_sends_a_queued_batch(
    installed: DiscordInstallation, repositories: Any, discord: DirectDiscord
) -> None:
    """A `chat.digest` job off the dispatch queue becomes one Discord post."""
    _route(repositories)
    job = {"kind": CHAT_DIGEST_JOB, **_digest().model_dump(mode="json")}
    dispatch.handle_record(repositories, sqs_record(job))
    assert len(discord.posts()) == 1
