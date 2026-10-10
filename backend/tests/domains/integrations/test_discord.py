"""The Discord App: install, account linking, the signed receiver, the commands, the form and bot delivery.

No request reaches Discord. `api.bot`, `api.exchange_code` and `api.current_user`
are patched at the boundary, so every call the code makes is recorded and answered
from a script, and every interaction Discord would send is built here and signed
with a test Ed25519 key exactly as Discord signs it.
"""

from __future__ import annotations

import hashlib
import json
import time
from typing import Any, Iterator, Mapping
from urllib.parse import parse_qs, urlparse

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from fastapi.testclient import TestClient

from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.channels import ChannelDestination, channel_key, new_channel_id
from app.common.db.dynamo.discord import DiscordInstallation
from app.domains.integrations.discord import api, commands, install, people, signature, transport
from app.domains.integrations.discord.api import DiscordError
from app.domains.integrations.install_state import mint_state, read_state
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER, make_workspace, sign_in
from tests.domains.integrations.conftest import OTHER_TEAM, OTHER_WORKSPACE, TEAM, WORKSPACE

PRIVATE_KEY = Ed25519PrivateKey.from_private_bytes(hashlib.sha256(b"standupless-test-discord").digest())

PUBLIC_KEY = PRIVATE_KEY.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw).hex()

APPLICATION_ID = "1100000000000000001"

GUILD = "1200000000000000001"

CHANNEL = "1300000000000000001"

MESSAGE = "1400000000000000001"

BOT_TOKEN = "a-test-discord-bot-token-not-real"

CHANNELS_PATH = f"/api/workspaces/{WORKSPACE}/teams/{TEAM}/webhooks/channels"

DISCORD_PEOPLE = {
    "D_OWNER": {"id": "D_OWNER", "email": "owner@example.com", "verified": True},
    "D_GUEST": {"id": "D_GUEST", "email": "guest@example.com", "verified": True},
    "D_STRANGER": {"id": "D_STRANGER", "email": "stranger@example.com", "verified": True},
    "D_UNVERIFIED": {"id": "D_UNVERIFIED", "email": "member@example.com", "verified": False},
}


class FakeDiscord:
    """Answers bot calls from a script and records each one."""

    def __init__(self) -> None:
        """Start with no calls and the default answers."""
        self.calls: list[tuple[str, str, Any]] = []
        self.errors: dict[tuple[str, str], DiscordError] = {}
        self.person = "D_OWNER"

    def bot(self, method: str, path: str, payload: Any = None) -> Any:
        """Record one call, then answer it or raise the error scripted for it."""
        self.calls.append((method, path, payload))
        for (wanted_method, prefix), error in self.errors.items():
            if method == wanted_method and path.startswith(prefix):
                raise error
        if method == "GET" and path.endswith("/channels"):
            return [
                {"id": "1300000000000000003", "name": "ops", "type": 0},
                {"id": CHANNEL, "name": "eng", "type": 0},
                {"id": "1300000000000000004", "name": "voice", "type": 2},
                {"id": "1300000000000000005", "name": "news", "type": 5},
            ]
        return {}

    def exchange_code(self, code: str) -> dict[str, Any]:
        """The token answer of an install or a link."""
        return {"access_token": "a-user-access-token", "guild": {"id": GUILD, "name": "Acme Discord"}}

    def current_user(self, access_token: str) -> dict[str, Any]:
        """The Discord person the scripted access token belongs to."""
        return dict(DISCORD_PEOPLE[self.person])

    def paths(self, method: str) -> list[str]:
        """The paths called with one method, in order."""
        return [path for name, path, _ in self.calls if name == method]


@pytest.fixture
def discord_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """A configured Discord App for one test."""
    monkeypatch.setenv("DISCORD_APPLICATION_ID", APPLICATION_ID)
    monkeypatch.setenv("DISCORD_PUBLIC_KEY", PUBLIC_KEY)
    monkeypatch.setenv("DISCORD_CLIENT_SECRET", "a-test-discord-client-secret")
    monkeypatch.setenv("DISCORD_BOT_TOKEN", BOT_TOKEN)


@pytest.fixture
def discord(monkeypatch: pytest.MonkeyPatch, discord_env: None) -> FakeDiscord:
    """Stand in for every call to Discord."""
    fake = FakeDiscord()
    monkeypatch.setattr(api, "bot", fake.bot)
    monkeypatch.setattr(api, "exchange_code", fake.exchange_code)
    monkeypatch.setattr(api, "current_user", fake.current_user)
    return fake


@pytest.fixture
def discord_client(client: TestClient, discord: FakeDiscord) -> Iterator[TestClient]:
    """The integrations client with the Discord App configured and Discord faked."""
    yield client


@pytest.fixture
def installed(repositories: Any, workspace: str, discord: FakeDiscord) -> DiscordInstallation:
    """The Discord App installed in the test workspace."""
    return install.bind(repositories, WORKSPACE, OWNER, discord.exchange_code("a-code"))


def _link(repositories: Any, installation: DiscordInstallation, discord: FakeDiscord, person: str) -> None:
    """Link one Discord person through the real consent callback."""
    discord.person = person
    state = parse_qs(urlparse(people.link_url(installation, person)).query)["state"][0]
    people.complete_link(repositories, people_claims(state), "a-user-access-token")


def people_claims(state: str) -> Mapping[str, Any]:
    """The claims a link state carries."""
    return read_state(state, audience=people.LINK_AUDIENCE)


@pytest.fixture
def linked(repositories: Any, installed: DiscordInstallation, discord: FakeDiscord) -> DiscordInstallation:
    """The owner and the guest linked to their Discord accounts."""
    _link(repositories, installed, discord, "D_OWNER")
    _link(repositories, installed, discord, "D_GUEST")
    return installed


def _signed(body: bytes, *, timestamp: int | None = None, key: Ed25519PrivateKey = PRIVATE_KEY) -> dict[str, str]:
    """The headers Discord sends with one body."""
    stamp = str(int(time.time()) if timestamp is None else timestamp)
    return {"x-signature-timestamp": stamp, "x-signature-ed25519": signature.sign(key, stamp, body)}


_counter = iter(range(1, 1_000_000))


def _interact(client: TestClient, payload: Mapping[str, Any], **kwargs: Any) -> Any:
    """Post one signed interaction, each with a fresh id."""
    body = json.dumps({"id": f"15{next(_counter):017d}", "guild_id": GUILD, **payload}).encode()
    headers = {"content-type": "application/json", **_signed(body, **kwargs)}
    return client.post("/api/discord/interactions", content=body, headers=headers)


def _member(user: str) -> dict[str, Any]:
    """The `member` block of an interaction from one Discord person."""
    return {"member": {"user": {"id": user}}}


def _slash(client: TestClient, subcommand: str, user: str = "D_OWNER", **values: str) -> dict[str, Any]:
    """Run `/standupless <subcommand>` as one Discord person, answering the reply data."""
    options = [{"type": 3, "name": name, "value": value} for name, value in values.items()]
    data = {"type": 1, "name": "standupless", "options": [{"type": 1, "name": subcommand, "options": options}]}
    response = _interact(client, {"type": 2, "data": data, "channel_id": CHANNEL, **_member(user)})
    assert response.status_code == 200, response.text
    return response.json()


def _discord_destination(repositories: Any, *, guild_id: str = GUILD) -> ChannelDestination:
    """Store one enabled destination that posts through the bot."""
    channel_id = new_channel_id()
    now = utc_now()
    destination = ChannelDestination(
        workspace_id=WORKSPACE,
        github_key=channel_key(channel_id),
        channel_id=channel_id,
        team_id=TEAM,
        provider="discord",
        label="eng",
        events=["issue_created"],
        enabled=True,
        created_by=OWNER,
        created_at=now,
        updated_at=now,
        transport="discord_app",
        discord_channel_id=CHANNEL,
        discord_guild_id=guild_id,
        url_hint="#eng",
    )
    repositories.github.channels.create(destination)
    return destination


def test_a_signature_verifies_only_for_the_key_and_inside_five_minutes() -> None:
    """The Ed25519 scheme: the right key and a fresh timestamp pass, anything else is refused."""
    now = 1_700_000_000
    body = b'{"type":1}'
    good = signature.sign(PRIVATE_KEY, str(now), body)
    signature.verify(PUBLIC_KEY, str(now), good, body, now=now + 299)
    other = Ed25519PrivateKey.from_private_bytes(hashlib.sha256(b"another").digest())
    for key, stamp, sent, at, sent_body in (
        (PUBLIC_KEY, str(now), good, now + 301, body),
        (PUBLIC_KEY, str(now), signature.sign(other, str(now), body), now, body),
        (PUBLIC_KEY, str(now), good, now, b'{"type":2}'),
        (PUBLIC_KEY, None, good, now, body),
        (PUBLIC_KEY, "soon", good, now, body),
        (PUBLIC_KEY, str(now), "not-hex", now, body),
        ("", str(now), good, now, body),
    ):
        with pytest.raises(signature.SignatureRejected):
            signature.verify(key, stamp, sent, sent_body, now=at)


def test_every_public_route_is_off_without_keys(client: TestClient, workspace: str) -> None:
    """With no Discord App in the environment the receivers answer 404 and the install link 409."""
    for method, path in (("GET", "/api/discord/oauth/callback"), ("POST", "/api/discord/interactions")):
        assert client.request(method, path, follow_redirects=False).status_code == 404, path
    sign_in(client, OWNER)
    connection = client.get(f"/api/workspaces/{WORKSPACE}/discord")
    assert connection.status_code == 200
    assert connection.json()["configured"] is False
    refused = client.get(f"/api/workspaces/{WORKSPACE}/discord/install-url")
    assert refused.status_code == 409
    assert "NOT_CONFIGURED" in refused.text


def test_an_admin_gets_an_install_link_and_a_member_does_not(discord_client: TestClient, workspace: str) -> None:
    """The link carries the application id, the bot scopes, the permissions, the redirect and a signed state."""
    sign_in(discord_client, ADMIN)
    response = discord_client.get(f"/api/workspaces/{WORKSPACE}/discord/install-url", params={"team_id": TEAM})
    assert response.status_code == 200
    url = urlparse(response.json()["url"])
    query = parse_qs(url.query)
    assert url.netloc == "discord.com"
    assert query["client_id"] == [APPLICATION_ID]
    assert query["scope"] == ["bot applications.commands"]
    assert query["permissions"] == [str(api.BOT_PERMISSIONS)]
    assert query["redirect_uri"][0].endswith("/api/discord/oauth/callback")
    assert query["state"][0]

    sign_in(discord_client, MEMBER)
    assert discord_client.get(f"/api/workspaces/{WORKSPACE}/discord/install-url").status_code == 403


def _callback(client: TestClient, **params: str) -> tuple[str, dict[str, list[str]]]:
    """Follow Discord's redirect into the callback, answering where it sends the browser on to."""
    response = client.get("/api/discord/oauth/callback", params=params, follow_redirects=False)
    assert response.status_code == 302
    location = urlparse(response.headers["location"])
    return location.path, parse_qs(location.query)


def test_an_install_binds_the_server_and_registers_the_commands(
    discord_client: TestClient, workspace: str, repositories: Any, discord: FakeDiscord
) -> None:
    """The happy path ends on the team's settings page, stores no credential and registers the commands."""
    state, _ = mint_state(WORKSPACE, ADMIN, audience=install.STATE_AUDIENCE, extra={"team_id": TEAM})

    path, query = _callback(discord_client, code="a-code", state=state)

    assert path == "/w/acme/team/ABC/settings"
    assert query["discord"] == ["installed"]
    installation = repositories.github.discord.get(WORKSPACE)
    assert installation is not None
    assert installation.guild_id == GUILD
    assert installation.installed_by == ADMIN
    assert "a-user-access-token" not in installation.model_dump_json()
    assert repositories.github.discord.installation_for_guild(GUILD) is not None
    assert discord.paths("PUT") == [f"/applications/{APPLICATION_ID}/commands"]
    assert discord.calls[-1][2] == list(commands.COMMANDS)

    replay_path, replay = _callback(discord_client, code="a-code", state=state)
    assert replay["discord"] == ["invalid_state"]
    assert replay_path == "/w/acme/team/ABC/settings"

    sign_in(discord_client, MEMBER)
    connection = discord_client.get(f"/api/workspaces/{WORKSPACE}/discord").json()
    assert connection["installed"] is True
    assert connection["guild_name"] == "Acme Discord"
    assert "token" not in json.dumps(connection)


def test_a_denied_or_forged_install_binds_nothing(
    discord_client: TestClient, workspace: str, repositories: Any
) -> None:
    """A refusal on Discord's consent screen or a state minted for another flow changes nothing."""
    state, _ = mint_state(WORKSPACE, ADMIN, audience=install.STATE_AUDIENCE)
    path, query = _callback(discord_client, error="access_denied", state=state)
    assert (path, query["discord"]) == ("/w/acme/settings", ["denied"])

    github_state, _ = mint_state(WORKSPACE, ADMIN)
    _, forged = _callback(discord_client, code="a-code", state=github_state)
    assert forged["discord"] == ["invalid_state"]
    assert repositories.github.discord.get(WORKSPACE) is None


def test_a_server_bound_elsewhere_is_refused(
    discord_client: TestClient, installed: DiscordInstallation, repositories: Any
) -> None:
    """One Discord server serves one workspace, so a second workspace cannot take it over."""
    make_workspace(repositories, OTHER_WORKSPACE, "other", OWNER)
    state, _ = mint_state(OTHER_WORKSPACE, OWNER, audience=install.STATE_AUDIENCE)
    _, query = _callback(discord_client, code="a-code", state=state)
    assert query["discord"] == ["discord_guild_taken"]
    assert repositories.github.discord.get(OTHER_WORKSPACE) is None
    assert repositories.github.discord.bound_workspace(GUILD) == WORKSPACE


def test_an_interaction_discord_did_not_sign_is_refused(
    discord_client: TestClient, installed: DiscordInstallation
) -> None:
    """An unsigned, mis-signed or stale interaction is a 401 and its body is never acted on."""
    ping = {"type": 1}
    assert discord_client.post("/api/discord/interactions", json=ping).status_code == 401
    other = Ed25519PrivateKey.from_private_bytes(hashlib.sha256(b"another").digest())
    assert _interact(discord_client, ping, key=other).status_code == 401
    assert _interact(discord_client, ping, timestamp=int(time.time()) - 600).status_code == 401


def test_a_ping_is_answered_with_a_pong(discord_client: TestClient) -> None:
    """Discord's check of the interactions endpoint gets its pong back."""
    response = _interact(discord_client, {"type": 1})
    assert response.status_code == 200
    assert response.json() == {"type": 1}


def test_help_needs_no_account_and_an_unknown_server_is_turned_away(
    discord_client: TestClient, installed: DiscordInstallation
) -> None:
    """Help answers anyone in a bound server, and a server nobody bound says so instead of acting."""
    helped = _slash(discord_client, "help", user="D_STRANGER")
    assert helped["type"] == 4
    assert helped["data"]["flags"] == commands.EPHEMERAL
    assert "/standupless create" in helped["data"]["content"]

    elsewhere = _interact(discord_client, {"type": 2, "guild_id": "1299999999999999999", "data": {"type": 1}})
    assert "not connected" in elsewhere.json()["data"]["content"]


def test_an_unlinked_person_gets_their_own_consent_link(
    discord_client: TestClient, installed: DiscordInstallation
) -> None:
    """A person with no link is answered with a link minted for their Discord id alone."""
    reply = _slash(discord_client, "show", user="D_STRANGER", key="ABC-1")
    content = reply["data"]["content"]
    assert "not linked" in content
    url = urlparse(content.rsplit(" ", 1)[-1])
    query = parse_qs(url.query)
    assert url.netloc == "discord.com"
    assert query["scope"] == ["identify email"]
    claims = people_claims(query["state"][0])
    assert claims["discord_user_id"] == "D_STRANGER"
    assert claims["guild_id"] == GUILD


def _link_callback(client: TestClient, installation: DiscordInstallation, person: str, **params: str) -> Any:
    """Follow one person's consent link back into the callback."""
    state = parse_qs(urlparse(people.link_url(installation, person)).query)["state"][0]
    return client.get("/api/discord/oauth/callback", params={"state": state, **params}, follow_redirects=False)


def test_linking_needs_the_same_account_a_verified_email_and_a_member(
    discord_client: TestClient, installed: DiscordInstallation, repositories: Any, discord: FakeDiscord
) -> None:
    """Only the account the link was minted for, with a verified email a member holds, is linked."""
    discord.person = "D_OWNER"
    linked = _link_callback(discord_client, installed, "D_OWNER", code="a-code")
    assert linked.status_code == 200
    assert "is linked" in linked.text
    link = repositories.github.discord.get_link(WORKSPACE, "D_OWNER")
    assert link is not None and link.user_id == OWNER

    discord.person = "D_GUEST"
    wrong = _link_callback(discord_client, installed, "D_STRANGER", code="a-code")
    assert wrong.status_code == 400 and "different Discord account" in wrong.text

    discord.person = "D_UNVERIFIED"
    unverified = _link_callback(discord_client, installed, "D_UNVERIFIED", code="a-code")
    assert unverified.status_code == 400 and "verified email" in unverified.text

    discord.person = "D_STRANGER"
    stranger = _link_callback(discord_client, installed, "D_STRANGER", code="a-code")
    assert stranger.status_code == 400 and "No member" in stranger.text

    denied = _link_callback(discord_client, installed, "D_STRANGER", error="access_denied")
    assert denied.status_code == 400 and "cancelled" in denied.text
    for person in ("D_GUEST", "D_UNVERIFIED", "D_STRANGER"):
        assert repositories.github.discord.get_link(WORKSPACE, person) is None


def test_a_link_stops_working_when_the_member_changes_email(linked: DiscordInstallation, repositories: Any) -> None:
    """The link resolves only while the member still holds the email it was made with."""
    assert people.context_for(repositories, linked, "D_OWNER").user_id == OWNER
    repositories.users.update(OWNER, email="renamed@example.com")
    with pytest.raises(people.NotLinked):
        people.context_for(repositories, linked, "D_OWNER")


def test_show_answers_an_issue_only_to_a_member_who_can_see_it(
    discord_client: TestClient, linked: DiscordInstallation, issue: Any, hidden_issue: Any
) -> None:
    """A key shows the card to a member who can see the team, and a guest outside it learns nothing."""
    shown = _slash(discord_client, "show", key="abc-1")
    embed = shown["data"]["embeds"][0]
    assert embed["title"].startswith("ABC-1 An issue")
    assert embed["url"].endswith("/issues/ABC-1")
    assert shown["data"]["allowed_mentions"] == {"parse": []}

    hidden = _slash(discord_client, "show", user="D_GUEST", key="XYZ-1")
    assert "No issue" in hidden["data"]["content"]
    assert "embeds" not in hidden["data"]


def _created(repositories: Any, team_id: str, title: str) -> list[Mapping[str, Any]]:
    """The issues of one team with one title."""
    return [row for row in repositories.issues.list_for_team(WORKSPACE, team_id).items if row.get("title") == title]


def test_create_files_an_issue_as_the_person_in_the_team_they_name(
    discord_client: TestClient, linked: DiscordInstallation, repositories: Any
) -> None:
    """With one writable team it is used, with several the person names one, and a team out of reach is refused."""
    guest = _slash(discord_client, "create", user="D_GUEST", title="Login loops")
    assert "Created [ABC-" in guest["data"]["content"]
    created = _created(repositories, TEAM, "Login loops")
    assert len(created) == 1 and created[0]["created_by"] == GUEST

    ambiguous = _slash(discord_client, "create", title="Pick one")
    assert "Pick a team" in ambiguous["data"]["content"]
    assert not _created(repositories, TEAM, "Pick one")

    named = _slash(discord_client, "create", title="Checkout fails", team="xyz", description="Seen twice")
    assert "Created [XYZ-" in named["data"]["content"]
    assert _created(repositories, OTHER_TEAM, "Checkout fails")[0]["created_by"] == OWNER

    outside = _slash(discord_client, "create", user="D_GUEST", title="Sneaky", team=OTHER_TEAM)
    assert "Created" not in outside["data"]["content"]
    assert not _created(repositories, OTHER_TEAM, "Sneaky")


def test_the_team_option_completes_to_the_teams_the_person_can_write(
    discord_client: TestClient, linked: DiscordInstallation
) -> None:
    """Autocomplete offers only writable teams matching what was typed."""
    option = {"type": 3, "name": "team", "value": "x", "focused": True}
    data = {"type": 1, "name": "standupless", "options": [{"type": 1, "name": "create", "options": [option]}]}
    owner = _interact(discord_client, {"type": 4, "data": data, **_member("D_OWNER")}).json()
    assert owner["type"] == 8
    assert [choice["value"] for choice in owner["data"]["choices"]] == [OTHER_TEAM]
    guest = _interact(discord_client, {"type": 4, "data": data, **_member("D_GUEST")}).json()
    assert guest["data"]["choices"] == []


def test_the_message_command_opens_a_form_and_its_submission_creates_the_issue(
    discord_client: TestClient, linked: DiscordInstallation, repositories: Any
) -> None:
    """The first line becomes the title, the message the description, and the message link rides along."""
    message = {"id": MESSAGE, "channel_id": CHANNEL, "content": "\nCheckout fails on Safari\nSeen twice today"}
    data = {"type": 3, "name": "Create issue", "target_id": MESSAGE, "resolved": {"messages": {MESSAGE: message}}}
    opened = _interact(discord_client, {"type": 2, "data": data, "channel_id": CHANNEL, **_member("D_GUEST")}).json()
    assert opened["type"] == 9
    form = opened["data"]
    fields = [row["components"][0] for row in form["components"]]
    assert fields[0]["value"] == "ABC"
    assert fields[1]["value"] == "Checkout fails on Safari"
    assert "Seen twice today" in fields[2]["value"]

    submitted = {
        "custom_id": form["custom_id"],
        "components": [
            {"type": 1, "components": [{"type": 4, "custom_id": field["custom_id"], "value": field["value"]}]}
            for field in fields
        ],
    }
    reply = _interact(discord_client, {"type": 5, "data": submitted, **_member("D_GUEST")}).json()
    assert "Created [ABC-" in reply["data"]["content"]
    created = _created(repositories, TEAM, "Checkout fails on Safari")
    assert len(created) == 1
    assert f"https://discord.com/channels/{GUILD}/{CHANNEL}/{MESSAGE}" in str(created[0].get("body") or "")

    stranger = _interact(discord_client, {"type": 2, "data": data, **_member("D_STRANGER")}).json()
    assert stranger["type"] == 4 and "not linked" in stranger["data"]["content"]


def test_a_repeated_interaction_is_handled_once(
    discord_client: TestClient, linked: DiscordInstallation, repositories: Any
) -> None:
    """The same interaction id arriving twice creates one issue."""
    options = [{"type": 3, "name": "title", "value": "Only once"}]
    data = {"type": 1, "name": "standupless", "options": [{"type": 1, "name": "create", "options": options}]}
    body = json.dumps({"id": "1599999999999999999", "guild_id": GUILD, "type": 2, "data": data, **_member("D_GUEST")})
    for _ in range(2):
        headers = {"content-type": "application/json", **_signed(body.encode())}
        discord_client.post("/api/discord/interactions", content=body, headers=headers)
    assert len(_created(repositories, TEAM, "Only once")) == 1


def test_a_channel_can_post_through_the_installed_app(
    discord_client: TestClient, installed: DiscordInstallation, repositories: Any
) -> None:
    """A team admin picks a text or announcement channel, and the destination stores no URL at all."""
    sign_in(discord_client, ADMIN)
    listed = discord_client.get(f"/api/workspaces/{WORKSPACE}/teams/{TEAM}/webhooks/discord-channels")
    assert listed.status_code == 200
    assert [row["name"] for row in listed.json()] == ["eng", "news", "ops"]

    created = discord_client.post(
        CHANNELS_PATH,
        json={"discord_channel_id": CHANNEL, "discord_channel_name": "eng", "events": ["issue_created"]},
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["transport"] == "discord_app"
    assert body["provider"] == "discord"
    assert body["discord_channel_id"] == CHANNEL
    assert body["url_hint"] == "#eng"
    stored = repositories.github.channels.get(WORKSPACE, body["channel_id"])
    assert stored is not None and stored.url_ciphertext == "" and stored.discord_guild_id == GUILD

    webhook = {"url": "https://discord.com/api/webhooks/1/x"}
    repointed = discord_client.patch(f"{CHANNELS_PATH}/{body['channel_id']}", json=webhook)
    assert repointed.status_code == 422
    assert "DISCORD_APP_CHANNEL" in repointed.text


def test_a_discord_channel_needs_the_app_and_exactly_one_target(discord_client: TestClient, workspace: str) -> None:
    """Without an install the picker is a 404 and a create is refused, and a body naming two targets is invalid."""
    sign_in(discord_client, ADMIN)
    picker = discord_client.get(f"/api/workspaces/{WORKSPACE}/teams/{TEAM}/webhooks/discord-channels")
    assert picker.status_code == 404
    refused = discord_client.post(CHANNELS_PATH, json={"discord_channel_id": CHANNEL, "events": ["issue_created"]})
    assert refused.status_code == 422
    assert "DISCORD_NOT_INSTALLED" in refused.text
    both = {"slack_channel_id": "C0ENG", "discord_channel_id": CHANNEL, "events": ["issue_created"]}
    assert discord_client.post(CHANNELS_PATH, json=both).status_code == 422
    not_digits = {"discord_channel_id": "general", "events": ["issue_created"]}
    assert discord_client.post(CHANNELS_PATH, json=not_digits).status_code == 422


def test_a_server_the_bot_left_is_forgotten_when_its_channels_are_listed(
    discord_client: TestClient, installed: DiscordInstallation, repositories: Any, discord: FakeDiscord
) -> None:
    """Discord sends no uninstall event, so the first call that finds the server gone forgets it."""
    destination = _discord_destination(repositories)
    discord.errors[("GET", f"/guilds/{GUILD}")] = DiscordError(404, api.UNKNOWN_GUILD)
    sign_in(discord_client, ADMIN)
    picker = discord_client.get(f"/api/workspaces/{WORKSPACE}/teams/{TEAM}/webhooks/discord-channels")
    assert picker.status_code == 404
    assert repositories.github.discord.get(WORKSPACE) is None
    stored = repositories.github.channels.get(WORKSPACE, destination.channel_id)
    assert stored is not None and stored.enabled is False


def test_the_bot_posts_to_the_destination_channel(
    installed: DiscordInstallation, repositories: Any, discord: FakeDiscord
) -> None:
    """A rendered message goes to the channel's messages with every mention off."""
    destination = _discord_destination(repositories)
    response = transport.post(repositories, destination, json.dumps({"embeds": [{"title": "hello"}]}))
    assert response.status_code == 200
    method, path, payload = discord.calls[-1]
    assert (method, path) == ("POST", f"/channels/{CHANNEL}/messages")
    assert payload["embeds"] == [{"title": "hello"}]
    assert payload["allowed_mentions"] == {"parse": []}


@pytest.mark.parametrize(
    ("status_code", "code", "expected"),
    [
        (404, api.UNKNOWN_CHANNEL, 404),
        (403, api.MISSING_ACCESS, 404),
        (403, api.MISSING_PERMISSIONS, 404),
        (401, 0, 0),
        (429, 0, 429),
        (0, 0, 0),
        (502, 0, 0),
        (400, 50035, 400),
    ],
)
def test_a_discord_refusal_maps_onto_webhook_semantics(
    installed: DiscordInstallation,
    repositories: Any,
    discord: FakeDiscord,
    status_code: int,
    code: int,
    expected: int,
) -> None:
    """Gone channels disable, rate limits, outages and a refused bot token retry, anything else fails once."""
    discord.errors[("POST", "/channels/")] = DiscordError(status_code, code)
    destination = _discord_destination(repositories)
    response = transport.post(repositories, destination, json.dumps({"embeds": []}))
    assert response.status_code == expected
    assert BOT_TOKEN not in (response.error or "")
    assert repositories.github.discord.get(WORKSPACE) is not None


def test_an_unknown_guild_on_post_forgets_the_install(
    installed: DiscordInstallation, repositories: Any, discord: FakeDiscord
) -> None:
    """A post that finds the server gone answers 410 and forgets the installation."""
    discord.errors[("POST", "/channels/")] = DiscordError(404, api.UNKNOWN_GUILD)
    destination = _discord_destination(repositories)
    assert transport.post(repositories, destination, "{}").status_code == 410
    assert repositories.github.discord.get(WORKSPACE) is None


def test_a_destination_from_another_server_is_gone(
    installed: DiscordInstallation, repositories: Any, discord: FakeDiscord
) -> None:
    """A destination bound to a server the workspace no longer holds answers 410 without calling Discord."""
    destination = _discord_destination(repositories, guild_id="1299999999999999999")
    assert transport.post(repositories, destination, "{}").status_code == 410
    assert discord.paths("POST") == []


def test_disconnecting_leaves_the_server_and_turns_off_bot_channels(
    discord_client: TestClient, linked: DiscordInstallation, repositories: Any, discord: FakeDiscord
) -> None:
    """An admin's disconnect leaves, forgets links and disables; a second one is a 404; a member cannot."""
    destination = _discord_destination(repositories)
    sign_in(discord_client, MEMBER)
    assert discord_client.delete(f"/api/workspaces/{WORKSPACE}/discord").status_code == 403
    sign_in(discord_client, ADMIN)
    assert discord_client.delete(f"/api/workspaces/{WORKSPACE}/discord").status_code == 204
    assert discord.paths("DELETE") == [f"/users/@me/guilds/{GUILD}"]
    assert repositories.github.discord.get(WORKSPACE) is None
    assert repositories.github.discord.bound_workspace(GUILD) == ""
    assert repositories.github.discord.get_link(WORKSPACE, "D_OWNER") is None
    stored = repositories.github.channels.get(WORKSPACE, destination.channel_id)
    assert stored is not None and stored.enabled is False
    assert discord_client.delete(f"/api/workspaces/{WORKSPACE}/discord").status_code == 404


def test_the_guest_role_is_kept_for_a_discord_person(linked: DiscordInstallation, repositories: Any) -> None:
    """A guest acting from Discord carries the guest role and only their own teams."""
    context = people.context_for(repositories, linked, "D_GUEST")
    assert context.user_id == GUEST
    assert context.role == "guest"
    assert context.team_ids == (TEAM,)
