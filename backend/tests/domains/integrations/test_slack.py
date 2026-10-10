"""The Slack App: install, the signed receivers, unfurls, the command, the form and bot delivery.

No request reaches Slack. `api.call`, `api.exchange_code` and `commands.respond` are
patched at the boundary, so every Web API call the code makes is recorded and
answered from a script, and every request Slack would send is built here and signed
with the test signing secret exactly as Slack signs it.
"""

from __future__ import annotations

import json
import time
from typing import Any, Iterator, Mapping
from urllib.parse import parse_qs, urlencode, urlparse

import pytest
from fastapi.testclient import TestClient

from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.channels import ChannelDestination, channel_key, new_channel_id
from app.common.db.dynamo.slack import SlackInstallation
from app.domains.integrations.install_state import mint_state
from app.domains.integrations.outbound.payloads import Links
from app.domains.integrations.slack import api, commands, install, people, signature, transport
from app.domains.integrations.slack.api import SlackError
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER, make_workspace, sign_in
from tests.domains.integrations.conftest import OTHER_TEAM, OTHER_WORKSPACE, TEAM, WORKSPACE

SIGNING_SECRET = "a-test-slack-signing-secret"

SLACK_TEAM = "T0SLACK01"

BOT_TOKEN = "xoxb-test-bot-token-not-real"

CHANNELS_PATH = f"/api/workspaces/{WORKSPACE}/teams/{TEAM}/webhooks/channels"

SLACK_USERS = {
    "UOWNER": {"email": "owner@example.com"},
    "UGUEST": {"email": "guest@example.com"},
    "USTRANGER": {"email": "stranger@example.com"},
    "UUNCONFIRMED": {"email": "member@example.com", "is_email_confirmed": False},
}


class FakeSlack:
    """Answers Web API calls from a script and records each one."""

    def __init__(self) -> None:
        """Start with no calls and the default answers."""
        self.calls: list[tuple[str, str, dict[str, Any]]] = []
        self.errors: dict[str, str] = {}
        self.responded: list[tuple[str, dict[str, Any]]] = []

    def call(self, method: str, token: str, payload: Mapping[str, Any] | None = None) -> dict[str, Any]:
        """Record one call, then answer it or raise the error scripted for its method."""
        body = dict(payload or {})
        self.calls.append((method, token, body))
        if method in self.errors:
            raise SlackError(self.errors[method])
        if method == "users.info":
            user = SLACK_USERS.get(str(body.get("user", "")))
            if user is None:
                raise SlackError("user_not_found")
            confirmed = user.get("is_email_confirmed", True)
            return {"ok": True, "user": {"is_email_confirmed": confirmed, "profile": {"email": user["email"]}}}
        if method == "conversations.list":
            return {
                "ok": True,
                "channels": [
                    {"id": "C0ENG", "name": "eng", "is_private": False},
                    {"id": "C0SECRET", "name": "secret", "is_private": True, "is_member": False},
                    {"id": "C0OPS", "name": "ops", "is_private": True, "is_member": True},
                ],
            }
        if method == "chat.getPermalink":
            return {"ok": True, "permalink": "https://acme.slack.com/archives/C0ENG/p1"}
        return {"ok": True}

    def methods(self) -> list[str]:
        """The methods called, in order."""
        return [method for method, _, _ in self.calls]

    def last(self, method: str) -> dict[str, Any]:
        """The payload of the latest call of one method."""
        return [body for name, _, body in self.calls if name == method][-1]


@pytest.fixture
def slack_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """A configured Slack App for one test."""
    monkeypatch.setenv("SLACK_CLIENT_ID", "1111.2222")
    monkeypatch.setenv("SLACK_CLIENT_SECRET", "a-test-slack-client-secret")
    monkeypatch.setenv("SLACK_SIGNING_SECRET", SIGNING_SECRET)


@pytest.fixture
def slack(monkeypatch: pytest.MonkeyPatch, slack_env: None) -> FakeSlack:
    """Stand in for every call to Slack."""
    fake = FakeSlack()
    monkeypatch.setattr(api, "call", fake.call)

    def record_response(url: str, payload: Mapping[str, Any]) -> bool:
        """Keep what would have been posted to a response url."""
        fake.responded.append((url, dict(payload)))
        return True

    monkeypatch.setattr(commands, "respond", record_response)
    return fake


@pytest.fixture
def slack_client(client: TestClient, slack: FakeSlack) -> Iterator[TestClient]:
    """The integrations client with the Slack App configured and Slack faked."""
    yield client


def _answer(team: str = SLACK_TEAM) -> dict[str, Any]:
    """An `oauth.v2.access` answer for one Slack team."""
    return {
        "ok": True,
        "access_token": BOT_TOKEN,
        "token_type": "bot",
        "scope": ",".join(api.BOT_SCOPES),
        "bot_user_id": "UBOT",
        "app_id": "A0APP",
        "team": {"id": team, "name": "Acme Slack"},
    }


@pytest.fixture
def installed(repositories: Any, workspace: str, github_env: None, slack: FakeSlack) -> SlackInstallation:
    """The Slack App installed in the test workspace."""
    return install.bind(repositories, WORKSPACE, OWNER, _answer())


def _signed(body: bytes, *, timestamp: int | None = None, secret: str = SIGNING_SECRET) -> dict[str, str]:
    """The headers Slack sends with one body."""
    stamp = str(int(time.time()) if timestamp is None else timestamp)
    return {"x-slack-request-timestamp": stamp, "x-slack-signature": signature.sign(secret, stamp, body)}


def _event(client: TestClient, envelope: Mapping[str, Any], **kwargs: Any) -> Any:
    """Post one signed Events API request."""
    body = json.dumps(envelope).encode()
    headers = {"content-type": "application/json", **_signed(body, **kwargs)}
    return client.post("/api/slack/events", content=body, headers=headers)


def _form(client: TestClient, path: str, fields: Mapping[str, str]) -> Any:
    """Post one signed form encoded request."""
    body = urlencode(fields).encode()
    headers = {"content-type": "application/x-www-form-urlencoded", **_signed(body)}
    return client.post(path, content=body, headers=headers)


def _command(client: TestClient, text: str, user: str = "UOWNER") -> Any:
    """Send `/standupless <text>` as one Slack user."""
    fields = {
        "command": "/standupless",
        "text": text,
        "team_id": SLACK_TEAM,
        "user_id": user,
        "trigger_id": "trigger-1",
        "response_url": "https://hooks.slack.com/commands/T0/1/x",
    }
    return _form(client, "/api/slack/commands", fields)


def _interaction(client: TestClient, payload: Mapping[str, Any]) -> Any:
    """Send one interactivity payload."""
    return _form(client, "/api/slack/interactions", {"payload": json.dumps(payload)})


def _slack_destination(
    repositories: Any, *, team_id: str = TEAM, slack_team_id: str = SLACK_TEAM
) -> ChannelDestination:
    """Store one enabled destination that posts through the bot."""
    channel_id = new_channel_id()
    now = utc_now()
    destination = ChannelDestination(
        workspace_id=WORKSPACE,
        github_key=channel_key(channel_id),
        channel_id=channel_id,
        team_id=team_id,
        provider="slack",
        label="eng",
        events=["issue_created"],
        enabled=True,
        created_by=OWNER,
        created_at=now,
        updated_at=now,
        transport="slack_app",
        slack_channel_id="C0ENG",
        slack_team_id=slack_team_id,
        url_hint="#eng",
    )
    repositories.github.channels.create(destination)
    return destination


def test_a_signature_verifies_only_for_the_secret_and_inside_five_minutes() -> None:
    """The v0 scheme: the right secret and a fresh timestamp pass, anything else is refused."""
    now = 1_700_000_000
    body = b"token=x&text=help"
    good = signature.sign(SIGNING_SECRET, str(now), body)
    signature.verify(SIGNING_SECRET, str(now), good, body, now=now + 299)
    for secret, stamp, sent, at in (
        ("another-secret", str(now), good, now),
        (SIGNING_SECRET, str(now), good, now + 301),
        (SIGNING_SECRET, str(now), good.replace("v0=", "v1="), now),
        (SIGNING_SECRET, None, good, now),
        (SIGNING_SECRET, "soon", good, now),
        ("", str(now), good, now),
    ):
        with pytest.raises(signature.SignatureRejected):
            signature.verify(secret, stamp, sent, body, now=at)


def test_every_public_route_is_off_without_credentials(client: TestClient, workspace: str) -> None:
    """With no Slack App in the environment the receivers answer 404 and the install link 409."""
    for method, path in (
        ("GET", "/api/slack/oauth/callback"),
        ("POST", "/api/slack/events"),
        ("POST", "/api/slack/commands"),
        ("POST", "/api/slack/interactions"),
    ):
        assert client.request(method, path, follow_redirects=False).status_code == 404, path
    sign_in(client, OWNER)
    connection = client.get(f"/api/workspaces/{WORKSPACE}/slack")
    assert connection.status_code == 200
    assert connection.json()["configured"] is False
    refused = client.get(f"/api/workspaces/{WORKSPACE}/slack/install-url")
    assert refused.status_code == 409
    assert "NOT_CONFIGURED" in refused.text


def test_an_admin_gets_an_install_link_and_a_member_does_not(slack_client: TestClient, workspace: str) -> None:
    """The link carries the client id, the bot scopes, the redirect and a signed state."""
    sign_in(slack_client, ADMIN)
    response = slack_client.get(f"/api/workspaces/{WORKSPACE}/slack/install-url", params={"team_id": TEAM})
    assert response.status_code == 200
    url = urlparse(response.json()["url"])
    query = parse_qs(url.query)
    assert url.netloc == "slack.com"
    assert query["client_id"] == ["1111.2222"]
    assert query["scope"] == [",".join(api.BOT_SCOPES)]
    assert query["redirect_uri"][0].endswith("/api/slack/oauth/callback")
    assert query["state"][0]

    sign_in(slack_client, MEMBER)
    assert slack_client.get(f"/api/workspaces/{WORKSPACE}/slack/install-url").status_code == 403


def _callback(client: TestClient, **params: str) -> tuple[str, dict[str, list[str]]]:
    """Follow Slack's redirect into the callback, answering where it sends the browser on to."""
    response = client.get("/api/slack/oauth/callback", params=params, follow_redirects=False)
    assert response.status_code == 302
    location = urlparse(response.headers["location"])
    return location.path, parse_qs(location.query)


def test_an_install_binds_the_slack_team_and_seals_the_token(
    slack_client: TestClient, workspace: str, repositories: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The happy path ends on the team's settings page with the token stored only sealed."""
    monkeypatch.setattr(api, "exchange_code", lambda code: _answer())
    state, _ = mint_state(WORKSPACE, ADMIN, audience=install.STATE_AUDIENCE, extra={"team_id": TEAM})

    path, query = _callback(slack_client, code="a-code", state=state)

    assert path == "/w/acme/team/ABC/settings"
    assert query["slack"] == ["installed"]
    installation = repositories.github.slack.get(WORKSPACE)
    assert installation is not None
    assert installation.slack_team_id == SLACK_TEAM
    assert installation.installed_by == ADMIN
    assert BOT_TOKEN not in installation.model_dump_json()
    assert install.token_for(installation) == BOT_TOKEN
    assert repositories.github.slack.installation_for_team(SLACK_TEAM) is not None

    replay_path, replay = _callback(slack_client, code="a-code", state=state)
    assert replay["slack"] == ["invalid_state"]
    assert replay_path == "/w/acme/team/ABC/settings"

    sign_in(slack_client, MEMBER)
    connection = slack_client.get(f"/api/workspaces/{WORKSPACE}/slack").json()
    assert connection["installed"] is True
    assert connection["slack_team_name"] == "Acme Slack"
    assert "token" not in json.dumps(connection)


def test_a_denied_or_forged_install_binds_nothing(
    slack_client: TestClient, workspace: str, repositories: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A refusal on Slack's consent screen or a state this product never signed changes nothing."""
    monkeypatch.setattr(api, "exchange_code", lambda code: _answer())
    state, _ = mint_state(WORKSPACE, ADMIN, audience=install.STATE_AUDIENCE)
    path, query = _callback(slack_client, error="access_denied", state=state)
    assert (path, query["slack"]) == ("/w/acme/settings", ["denied"])

    github_state, _ = mint_state(WORKSPACE, ADMIN)
    _, forged = _callback(slack_client, code="a-code", state=github_state)
    assert forged["slack"] == ["invalid_state"]
    assert repositories.github.slack.get(WORKSPACE) is None


def test_a_slack_team_bound_elsewhere_is_refused(
    slack_client: TestClient, installed: SlackInstallation, repositories: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """One Slack team serves one workspace, so a second workspace cannot take it over."""
    make_workspace(repositories, OTHER_WORKSPACE, "other", OWNER)
    monkeypatch.setattr(api, "exchange_code", lambda code: _answer())
    state, _ = mint_state(OTHER_WORKSPACE, OWNER, audience=install.STATE_AUDIENCE)
    _, query = _callback(slack_client, code="a-code", state=state)
    assert query["slack"] == ["slack_team_taken"]
    assert repositories.github.slack.get(OTHER_WORKSPACE) is None
    assert repositories.github.slack.bound_workspace(SLACK_TEAM) == WORKSPACE


def test_a_request_slack_did_not_sign_is_refused(slack_client: TestClient, installed: SlackInstallation) -> None:
    """An unsigned, mis-signed or stale request is a 401 and its body is never acted on."""
    challenge = {"type": "url_verification", "challenge": "abc"}
    assert slack_client.post("/api/slack/events", json=challenge).status_code == 401
    assert _event(slack_client, challenge, secret="another-secret").status_code == 401
    assert _event(slack_client, challenge, timestamp=int(time.time()) - 600).status_code == 401
    unsigned = slack_client.post("/api/slack/commands", data={"text": "help", "team_id": SLACK_TEAM})
    assert unsigned.status_code == 401


def test_the_url_verification_challenge_is_echoed(slack_client: TestClient) -> None:
    """Slack's check of the request URL gets its challenge back."""
    response = _event(slack_client, {"type": "url_verification", "challenge": "abc123"})
    assert response.status_code == 200
    assert response.json() == {"challenge": "abc123"}


def test_an_uninstall_forgets_the_team_and_turns_off_its_channels(
    slack_client: TestClient, installed: SlackInstallation, repositories: Any
) -> None:
    """`app_uninstalled` removes the installation and disables every bot destination, once."""
    destination = _slack_destination(repositories)
    envelope = {
        "type": "event_callback",
        "team_id": SLACK_TEAM,
        "event_id": "Ev01",
        "event": {"type": "app_uninstalled"},
    }
    assert _event(slack_client, envelope).json() == {"ok": True}
    assert repositories.github.slack.get(WORKSPACE) is None
    stored = repositories.github.channels.get(WORKSPACE, destination.channel_id)
    assert stored is not None and stored.enabled is False
    assert _event(slack_client, envelope).json()["duplicate"] is True


def test_a_revoked_user_token_keeps_the_install(
    slack_client: TestClient, installed: SlackInstallation, repositories: Any
) -> None:
    """`tokens_revoked` only forgets the install when the bot token is among them."""
    user_only = {
        "type": "event_callback",
        "team_id": SLACK_TEAM,
        "event_id": "Ev02",
        "event": {"type": "tokens_revoked", "tokens": {"oauth": ["U1"]}},
    }
    _event(slack_client, user_only)
    assert repositories.github.slack.get(WORKSPACE) is not None
    bot = {**user_only, "event_id": "Ev03", "event": {"type": "tokens_revoked", "tokens": {"bot": ["UBOT"]}}}
    _event(slack_client, bot)
    assert repositories.github.slack.get(WORKSPACE) is None


def test_a_pasted_issue_link_is_unfurled_unless_its_team_is_private(
    slack_client: TestClient,
    installed: SlackInstallation,
    repositories: Any,
    issue: Any,
    hidden_issue: Any,
    slack: FakeSlack,
) -> None:
    """A link to a visible issue gets a card, while a private team's issue and a foreign link do not."""
    repositories.memberships.set_team_private(WORKSPACE, OTHER_TEAM, True)
    links = Links(repositories, WORKSPACE)
    visible = links.issue("ABC-1")
    private = links.issue("XYZ-1")
    envelope = {
        "type": "event_callback",
        "team_id": SLACK_TEAM,
        "event_id": "Ev04",
        "event": {
            "type": "link_shared",
            "channel": "C0ENG",
            "message_ts": "1.2",
            "unfurl_id": "U-1",
            "source": "conversations_history",
            "links": [{"url": visible}, {"url": private}, {"url": "https://example.com/w/acme/issues/ABC-1"}],
        },
    }
    assert _event(slack_client, envelope).status_code == 200
    payload = slack.last("chat.unfurl")
    assert list(payload["unfurls"]) == [visible]
    assert payload["unfurl_id"] == "U-1"
    card = json.dumps(payload["unfurls"][visible])
    assert "ABC-1" in card and "An issue" in card


def test_the_command_shows_help_and_an_issue_the_person_can_see(
    slack_client: TestClient, installed: SlackInstallation, issue: Any, hidden_issue: Any
) -> None:
    """Help needs no account; a key shows the card only to a member who can see that team."""
    helped = _command(slack_client, "help").json()
    assert helped["response_type"] == "ephemeral"
    assert "create" in helped["text"]

    shown = _command(slack_client, "abc-1").json()
    assert shown["text"] == "ABC-1"
    assert "An issue" in json.dumps(shown["blocks"])

    hidden = _command(slack_client, "XYZ-1", user="UGUEST").json()
    assert "No issue" in hidden["text"]
    assert "blocks" not in hidden


def test_a_slack_person_without_a_confirmed_matching_account_is_not_linked(
    slack_client: TestClient, installed: SlackInstallation, issue: Any
) -> None:
    """An unknown email and an unconfirmed one both read as not linked."""
    for user in ("USTRANGER", "UUNCONFIRMED", "UNOBODY"):
        reply = _command(slack_client, "ABC-1", user=user).json()
        assert reply["text"] == commands.NOT_LINKED, user


def test_a_command_from_a_slack_team_with_no_install_is_turned_away(slack_client: TestClient, workspace: str) -> None:
    """A signed command from a Slack team nobody bound says so instead of acting."""
    reply = _command(slack_client, "ABC-1").json()
    assert "not connected" in reply["text"]


def test_create_opens_the_form_with_the_teams_the_person_can_write(
    slack_client: TestClient, installed: SlackInstallation, slack: FakeSlack
) -> None:
    """`create <title>` opens the modal prefilled, offering only teams the person belongs to."""
    response = _command(slack_client, "create Fix the login redirect", user="UGUEST")
    assert response.status_code == 200
    view = slack.last("views.open")["view"]
    assert view["callback_id"] == commands.CREATE_CALLBACK
    title = view["blocks"][1]["element"]
    assert title["initial_value"] == "Fix the login redirect"
    options = view["blocks"][0]["element"]["options"]
    assert [option["value"] for option in options] == [TEAM]


def _submission(team_id: str, title: str, *, user: str = "UOWNER", permalink: str = "") -> dict[str, Any]:
    """The `view_submission` payload of the create issue form."""
    values = {
        commands.TEAM_BLOCK: {commands.TEAM_BLOCK: {"selected_option": {"value": team_id}}},
        commands.TITLE_BLOCK: {commands.TITLE_BLOCK: {"value": title}},
        commands.DESCRIPTION_BLOCK: {commands.DESCRIPTION_BLOCK: {"value": "Steps to reproduce"}},
    }
    return {
        "type": "view_submission",
        "team": {"id": SLACK_TEAM},
        "user": {"id": user},
        "view": {
            "callback_id": commands.CREATE_CALLBACK,
            "private_metadata": json.dumps({"permalink": permalink}),
            "state": {"values": values},
        },
    }


def test_submitting_the_form_creates_the_issue_as_that_person(
    slack_client: TestClient, installed: SlackInstallation, repositories: Any
) -> None:
    """The issue lands in the picked team, written by the member, with the message link appended."""
    permalink = "https://acme.slack.com/archives/C0ENG/p1"
    response = _interaction(slack_client, _submission(TEAM, "Login loops", permalink=permalink))
    assert response.status_code == 200
    reply = response.json()
    assert reply["response_action"] == "update"
    assert "ABC-" in json.dumps(reply["view"])
    rows = repositories.issues.list_for_team(WORKSPACE, TEAM)[0]
    created = [row for row in rows if row.title == "Login loops"]
    assert len(created) == 1
    assert created[0].created_by == OWNER
    assert created[0].body is not None and permalink in created[0].body


def test_the_form_refuses_a_team_the_person_cannot_write_or_an_empty_title(
    slack_client: TestClient, installed: SlackInstallation
) -> None:
    """A team outside the person's reach and a blank title keep the form open with an error."""
    outside = _interaction(slack_client, _submission(OTHER_TEAM, "Sneaky", user="UGUEST")).json()
    assert outside["response_action"] == "errors"
    assert commands.TEAM_BLOCK in outside["errors"]
    blank = _interaction(slack_client, _submission(TEAM, "   ")).json()
    assert blank["response_action"] == "errors"
    assert commands.TITLE_BLOCK in blank["errors"]


def test_the_message_shortcut_opens_the_form_from_the_message(
    slack_client: TestClient, installed: SlackInstallation, slack: FakeSlack
) -> None:
    """The first line becomes the title, the message the description, and its link rides along."""
    payload = {
        "type": "message_action",
        "callback_id": commands.SHORTCUT_CALLBACK,
        "team": {"id": SLACK_TEAM},
        "user": {"id": "UOWNER"},
        "trigger_id": "trigger-2",
        "response_url": "https://hooks.slack.com/actions/T0/1/x",
        "channel": {"id": "C0ENG"},
        "message": {"text": "\nCheckout fails on Safari\nSeen twice today", "ts": "1.2"},
    }
    assert _interaction(slack_client, payload).status_code == 200
    view = slack.last("views.open")["view"]
    assert view["blocks"][1]["element"]["initial_value"] == "Checkout fails on Safari"
    assert "Seen twice today" in view["blocks"][2]["element"]["initial_value"]
    assert json.loads(view["private_metadata"])["permalink"].startswith("https://acme.slack.com/")

    stranger = {**payload, "user": {"id": "USTRANGER"}}
    _interaction(slack_client, stranger)
    assert slack.responded[-1][1]["text"] == commands.NOT_LINKED


def test_a_channel_can_post_through_the_installed_app(
    slack_client: TestClient, installed: SlackInstallation, repositories: Any
) -> None:
    """A team admin picks a Slack channel, and the destination stores no URL at all."""
    sign_in(slack_client, ADMIN)
    listed = slack_client.get(f"/api/workspaces/{WORKSPACE}/teams/{TEAM}/webhooks/slack-channels")
    assert listed.status_code == 200
    assert [row["id"] for row in listed.json()] == ["C0ENG", "C0OPS"]

    created = slack_client.post(
        CHANNELS_PATH,
        json={"slack_channel_id": "C0ENG", "slack_channel_name": "eng", "events": ["issue_created"]},
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["transport"] == "slack_app"
    assert body["slack_channel_id"] == "C0ENG"
    assert body["url_hint"] == "#eng"
    stored = repositories.github.channels.get(WORKSPACE, body["id"])
    assert stored is not None and stored.url_ciphertext == ""

    webhook = {"url": "https://hooks.slack.com/services/T/B/x"}
    repointed = slack_client.patch(f"{CHANNELS_PATH}/{body['id']}", json=webhook)
    assert repointed.status_code == 422
    assert "SLACK_APP_CHANNEL" in repointed.text


def test_a_slack_channel_needs_the_app_and_exactly_one_target(slack_client: TestClient, workspace: str) -> None:
    """Without an install the picker is a 404 and a create is refused, and a body naming both targets is invalid."""
    sign_in(slack_client, ADMIN)
    assert slack_client.get(f"/api/workspaces/{WORKSPACE}/teams/{TEAM}/webhooks/slack-channels").status_code == 404
    refused = slack_client.post(CHANNELS_PATH, json={"slack_channel_id": "C0ENG", "events": ["issue_created"]})
    assert refused.status_code == 422
    assert "SLACK_NOT_INSTALLED" in refused.text
    both = {"url": "https://hooks.slack.com/services/T/B/x", "slack_channel_id": "C0ENG", "events": ["issue_created"]}
    assert slack_client.post(CHANNELS_PATH, json=both).status_code == 422
    assert slack_client.post(CHANNELS_PATH, json={"events": ["issue_created"]}).status_code == 422


def test_the_bot_posts_to_the_destination_channel(
    installed: SlackInstallation, repositories: Any, slack: FakeSlack
) -> None:
    """A rendered message goes to `chat.postMessage` with the channel set and unfurls off."""
    destination = _slack_destination(repositories)
    response = transport.post(repositories, destination, json.dumps({"text": "hello", "blocks": []}))
    assert response.status_code == 200
    method, token, payload = slack.calls[-1]
    assert (method, token) == ("chat.postMessage", BOT_TOKEN)
    assert payload["channel"] == "C0ENG"
    assert payload["text"] == "hello"
    assert payload["unfurl_links"] is False


@pytest.mark.parametrize(
    ("error", "status"),
    [
        ("channel_not_found", 404),
        ("not_in_channel", 404),
        ("token_revoked", 410),
        ("invalid_auth", 410),
        ("ratelimited", 429),
        ("unreachable", 0),
        ("msg_too_long", 400),
    ],
)
def test_a_slack_refusal_maps_onto_webhook_semantics(
    installed: SlackInstallation, repositories: Any, slack: FakeSlack, error: str, status: int
) -> None:
    """Gone channels and revoked tokens disable, rate limits and outages retry, anything else fails once."""
    slack.errors["chat.postMessage"] = error
    destination = _slack_destination(repositories)
    response = transport.post(repositories, destination, json.dumps({"text": "hello"}))
    assert response.status_code == status
    assert BOT_TOKEN not in (response.error or "")


def test_a_destination_from_another_slack_team_is_gone(
    installed: SlackInstallation, repositories: Any, slack: FakeSlack
) -> None:
    """A destination bound to a Slack team the workspace no longer holds answers 410 without calling Slack."""
    destination = _slack_destination(repositories, slack_team_id="T0OTHER")
    assert transport.post(repositories, destination, "{}").status_code == 410
    assert "chat.postMessage" not in slack.methods()


def test_disconnecting_revokes_the_token_and_turns_off_bot_channels(
    slack_client: TestClient, installed: SlackInstallation, repositories: Any, slack: FakeSlack
) -> None:
    """An admin's disconnect revokes, forgets and disables; a second one is a 404; a member cannot."""
    destination = _slack_destination(repositories)
    sign_in(slack_client, MEMBER)
    assert slack_client.delete(f"/api/workspaces/{WORKSPACE}/slack").status_code == 403
    sign_in(slack_client, ADMIN)
    assert slack_client.delete(f"/api/workspaces/{WORKSPACE}/slack").status_code == 204
    assert "auth.revoke" in slack.methods()
    assert repositories.github.slack.get(WORKSPACE) is None
    assert repositories.github.slack.bound_workspace(SLACK_TEAM) == ""
    stored = repositories.github.channels.get(WORKSPACE, destination.channel_id)
    assert stored is not None and stored.enabled is False
    assert slack_client.delete(f"/api/workspaces/{WORKSPACE}/slack").status_code == 404


def test_the_guest_role_is_kept_for_a_slack_person(installed: SlackInstallation, repositories: Any) -> None:
    """A guest acting from Slack carries the guest role and only their own teams."""
    context = people.context_for(repositories, installed, "UGUEST")
    assert context.user_id == GUEST
    assert context.role == "guest"
    assert context.team_ids == (TEAM,)
