"""Emoji reaction intake: the team setting and the `reaction_added` events it files issues from.

Slack is faked at `api.call` as in `test_slack.py`, and reactions arrive through
the signed events route, so each test runs the routing a deployed function runs.
"""

from __future__ import annotations

from typing import Any, Iterator, Mapping

import pytest
from fastapi.testclient import TestClient

from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.slack import SlackInstallation
from app.common.db.dynamo.team_config import default_triage_settings
from app.domains.integrations.slack import api, commands, install, reactions
from tests.domains.helpers import ADMIN, MEMBER, OWNER, sign_in
from tests.domains.integrations.conftest import OTHER_TEAM, TEAM, WORKSPACE
from tests.domains.integrations.test_slack import SLACK_TEAM, FakeSlack, _answer, _event

CHANNEL = "C0ENG"

MESSAGE_TS = "1700000000.000200"

PERMALINK = "https://acme.slack.com/archives/C0ENG/p1"

INTAKE = f"/api/workspaces/{WORKSPACE}/teams/{TEAM}/webhooks/slack-intake"

OTHER_INTAKE = f"/api/workspaces/{WORKSPACE}/teams/{OTHER_TEAM}/webhooks/slack-intake"


class ReactionSlack(FakeSlack):
    """The shared Slack fake, also answering `reactions.get` with one scripted message."""

    def __init__(self) -> None:
        """Start with a plain message that is not in a thread."""
        super().__init__()
        self.message: dict[str, Any] = {
            "type": "message",
            "text": "Checkout fails on Safari\nSteps below",
            "ts": MESSAGE_TS,
        }

    def call(self, method: str, token: str, payload: Mapping[str, Any] | None = None) -> dict[str, Any]:
        """Answer a reactions lookup with the scripted message and defer the rest."""
        if method == "reactions.get" and method not in self.errors:
            self.calls.append((method, token, dict(payload or {})))
            return {"ok": True, "type": "message", "channel": CHANNEL, "message": dict(self.message)}
        return super().call(method, token, payload)


@pytest.fixture
def slack(monkeypatch: pytest.MonkeyPatch) -> ReactionSlack:
    """A configured Slack App with every call faked."""
    monkeypatch.setenv("SLACK_CLIENT_ID", "1111.2222")
    monkeypatch.setenv("SLACK_CLIENT_SECRET", "a-test-slack-client-secret")
    monkeypatch.setenv("SLACK_SIGNING_SECRET", "a-test-slack-signing-secret")
    fake = ReactionSlack()
    monkeypatch.setattr(api, "call", fake.call)
    monkeypatch.setattr(commands, "respond", lambda url, payload: True)
    return fake


@pytest.fixture
def installed(repositories: Any, workspace: str, github_env: None, slack: ReactionSlack) -> SlackInstallation:
    """The Slack App installed in the test workspace."""
    return install.bind(repositories, WORKSPACE, OWNER, _answer())


@pytest.fixture
def slack_client(client: TestClient, installed: SlackInstallation) -> Iterator[TestClient]:
    """The integrations client with the Slack App installed, signed in as the workspace admin."""
    sign_in(client, ADMIN)
    yield client


@pytest.fixture
def intake_on(slack_client: TestClient) -> TestClient:
    """The team filing messages reacted to with `:ticket:` in `#eng`, turned on by the admin."""
    response = slack_client.put(INTAKE, json={"emoji": "ticket", "channel_ids": [CHANNEL]})
    assert response.status_code == 200, response.text
    return slack_client


def _reaction(
    event_id: str, *, user: str = "UOWNER", reaction: str = "ticket", channel: str = CHANNEL, ts: str = MESSAGE_TS
) -> dict[str, Any]:
    """One `reaction_added` envelope on a message."""
    event = {
        "type": "reaction_added",
        "user": user,
        "reaction": reaction,
        "item": {"type": "message", "channel": channel, "ts": ts},
        "item_user": "UAUTHOR",
        "event_ts": "1700000001.000100",
    }
    return {"type": "event_callback", "team_id": SLACK_TEAM, "event_id": event_id, "event": event}


def _issues(repositories: Any, team_id: str = TEAM) -> list[Issue]:
    """Every issue in one team."""
    rows = repositories.issues.list_for_team(WORKSPACE, team_id).items
    found = [repositories.issues.get(WORKSPACE, str(row["issue_id"])) for row in rows]
    return [issue for issue in found if issue is not None]


def _logged(repositories: Any, action: str) -> list[Any]:
    """The workspace's audit entries of one kind."""
    from webbpulse.audit import AuditQuery

    return repositories.audit.list_events(WORKSPACE, AuditQuery(action=action)).events


def test_the_setting_is_off_by_default_then_turned_on_and_off(
    slack_client: TestClient, slack: ReactionSlack, repositories: Any
) -> None:
    """A team starts off; an admin picks an emoji and channels, the bot joins them, and the change is audited."""
    first = slack_client.get(INTAKE).json()
    assert first["configured"] is True and first["installed"] is True
    assert first["enabled"] is False and first["emoji"] is None and first["channel_ids"] == []
    assert first["reinstall"] is False

    response = slack_client.put(INTAKE, json={"emoji": ":Ticket::skin-tone-3:", "channel_ids": [CHANNEL, CHANNEL]})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["enabled"] is True and body["emoji"] == "ticket" and body["channel_ids"] == [CHANNEL]
    assert slack.last("conversations.join") == {"channel": CHANNEL}
    assert _logged(repositories, "slack_intake.updated")

    assert slack_client.delete(INTAKE).status_code == 204
    assert slack_client.get(INTAKE).json()["enabled"] is False
    assert slack_client.delete(INTAKE).status_code == 404
    assert _logged(repositories, "slack_intake.disabled")


def test_only_a_team_admin_changes_the_setting(intake_on: TestClient) -> None:
    """A member reads the setting and cannot change or remove it."""
    sign_in(intake_on, MEMBER)
    assert intake_on.get(INTAKE).json()["emoji"] == "ticket"
    assert intake_on.put(INTAKE, json={"emoji": "bug", "channel_ids": [CHANNEL]}).status_code == 403
    assert intake_on.delete(INTAKE).status_code == 403


def test_an_unreadable_emoji_or_channel_list_is_refused(slack_client: TestClient) -> None:
    """The emoji has to be a Slack emoji name and at least one Slack channel id is required."""
    assert slack_client.put(INTAKE, json={"emoji": "not an emoji!", "channel_ids": [CHANNEL]}).status_code == 422
    assert slack_client.put(INTAKE, json={"emoji": "ticket", "channel_ids": []}).status_code == 422
    assert slack_client.put(INTAKE, json={"emoji": "ticket", "channel_ids": ["eng"]}).status_code == 422


def test_one_emoji_in_one_channel_files_into_one_team(intake_on: TestClient) -> None:
    """A second team cannot claim the same emoji in a channel the first already listens in."""
    clash = intake_on.put(OTHER_INTAKE, json={"emoji": "ticket", "channel_ids": [CHANNEL, "C0OPS"]})
    assert clash.status_code == 409
    other_emoji = intake_on.put(OTHER_INTAKE, json={"emoji": "bug", "channel_ids": [CHANNEL]})
    assert other_emoji.status_code == 200


def test_turning_it_on_needs_slack_connected(client: TestClient, workspace: str, slack: ReactionSlack) -> None:
    """Without an installation the setting reads as not installed and cannot be turned on."""
    sign_in(client, ADMIN)
    read = client.get(INTAKE).json()
    assert read["installed"] is False and read["enabled"] is False
    assert client.put(INTAKE, json={"emoji": "ticket", "channel_ids": [CHANNEL]}).status_code == 409


def test_a_reaction_files_the_message_once_and_replies_in_its_thread(
    intake_on: TestClient, slack: ReactionSlack, repositories: Any
) -> None:
    """The message becomes one issue written by the reacting member, linked back and paired with its thread."""
    assert _event(intake_on, _reaction("Ev1")).status_code == 200
    filed = _issues(repositories)
    assert len(filed) == 1
    issue = filed[0]
    assert issue.title == "Checkout fails on Safari"
    assert issue.created_by == OWNER
    assert PERMALINK in (issue.body or "") and "Steps below" in (issue.body or "")
    assert issue.in_triage is False
    reply = slack.last("chat.postMessage")
    assert reply["channel"] == CHANNEL and reply["thread_ts"] == MESSAGE_TS
    assert "Tracking this in Standupless" in reply["text"]
    assert repositories.github.slack_threads.get_link(WORKSPACE, CHANNEL, MESSAGE_TS, issue.issue_id) is not None

    assert _event(intake_on, _reaction("Ev2", user="USTRANGER")).status_code == 200
    assert _event(intake_on, _reaction("Ev3")).status_code == 200
    assert len(_issues(repositories)) == 1


def test_a_reaction_by_someone_without_an_account_files_as_the_admin(intake_on: TestClient, repositories: Any) -> None:
    """A Slack person with no Standupless member behind them still files the message, as the admin who turned it on."""
    assert _event(intake_on, _reaction("Ev1", user="USTRANGER")).status_code == 200
    filed = _issues(repositories)
    assert len(filed) == 1 and filed[0].created_by == ADMIN


AUTHOR_PROFILE = {
    "ok": True,
    "user": {
        "id": "UAUTHOR",
        "name": "pat",
        "is_email_confirmed": True,
        "profile": {
            "real_name": "Pat Requester",
            "display_name": "patr",
            "image_72": "https://avatars.example.com/pat-72.png",
            "email": "pat@example.com",
        },
    },
}


class AuthorSlack(ReactionSlack):
    """The reaction fake with a message written by a Slack person who has no Standupless seat."""

    def call(self, method: str, token: str, payload: Mapping[str, Any] | None = None) -> dict[str, Any]:
        """Describe the message's author on `users.info` and defer the rest."""
        if method == "users.info" and dict(payload or {}).get("user") == "UAUTHOR":
            self.calls.append((method, token, dict(payload or {})))
            return AUTHOR_PROFILE
        return super().call(method, token, payload)


def test_a_reaction_keeps_the_messages_author_as_the_requester(
    intake_on: TestClient, slack: ReactionSlack, repositories: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The author with no seat is kept by name, handle, avatar and Slack id, and their address is not kept."""
    author = AuthorSlack()
    author.message["user"] = "UAUTHOR"
    monkeypatch.setattr(api, "call", author.call)

    assert _event(intake_on, _reaction("Ev1")).status_code == 200

    [issue] = _issues(repositories)
    requester = issue.requester
    assert requester is not None
    assert requester.source == "slack"
    assert requester.name == "Pat Requester"
    assert requester.handle == "patr"
    assert requester.avatar_url == "https://avatars.example.com/pat-72.png"
    assert requester.external_id == "UAUTHOR"
    assert requester.user_id is None
    assert "pat@example.com" not in requester.model_dump_json()


def test_a_message_by_a_member_links_the_requester_to_that_member(
    intake_on: TestClient, slack: ReactionSlack, repositories: Any
) -> None:
    """An author whose confirmed Slack address is a member's is kept as that member."""
    slack.message["user"] = "UOWNER"
    slack.message["text"] = "Owner wrote this"

    assert _event(intake_on, _reaction("Ev1", user="USTRANGER")).status_code == 200

    [issue] = _issues(repositories)
    assert issue.requester is not None
    assert issue.requester.external_id == "UOWNER"
    assert issue.requester.user_id == OWNER


def test_a_message_with_no_readable_author_has_no_requester(intake_on: TestClient, repositories: Any) -> None:
    """A message without an author, or one Slack cannot describe, files with no requester."""
    assert _event(intake_on, _reaction("Ev1")).status_code == 200

    [issue] = _issues(repositories)
    assert issue.requester is None


def test_a_reply_in_a_thread_pairs_with_the_parent_thread(
    intake_on: TestClient, slack: ReactionSlack, repositories: Any
) -> None:
    """A reaction on a thread reply files the reply, and the bot answers in the thread it belongs to."""
    reply_ts = "1700000000.000300"
    slack.message = {"type": "message", "text": "Also broken on iOS", "ts": reply_ts, "thread_ts": MESSAGE_TS}
    assert _event(intake_on, _reaction("Ev1", ts=reply_ts)).status_code == 200
    assert [issue.title for issue in _issues(repositories)] == ["Also broken on iOS"]
    assert slack.last("chat.postMessage")["thread_ts"] == MESSAGE_TS


def test_a_team_with_triage_on_files_into_triage(intake_on: TestClient, repositories: Any) -> None:
    """The issue waits in the team's triage inbox when the team triages."""
    repositories.team_config.put_triage_settings(
        default_triage_settings(WORKSPACE, TEAM).model_copy(update={"enabled": True})
    )
    assert _event(intake_on, _reaction("Ev1")).status_code == 200
    assert [issue.in_triage for issue in _issues(repositories)] == [True]


def test_other_emoji_other_channels_and_the_bot_file_nothing(
    intake_on: TestClient, slack: ReactionSlack, repositories: Any
) -> None:
    """Only the team's emoji in its channels files anything, and a skin tone still counts as the emoji."""
    assert _event(intake_on, _reaction("Ev1", reaction="eyes")).status_code == 200
    assert _event(intake_on, _reaction("Ev2", channel="C0OPS")).status_code == 200
    assert _event(intake_on, _reaction("Ev3", user="UBOT")).status_code == 200
    file_event = _reaction("Ev4")
    file_event["event"]["item"] = {"type": "file", "file": "F0FILE"}
    assert _event(intake_on, file_event).status_code == 200
    assert "reactions.get" not in slack.methods()
    assert _issues(repositories) == []

    assert _event(intake_on, _reaction("Ev5", reaction="ticket::skin-tone-2")).status_code == 200
    assert len(_issues(repositories)) == 1


def test_a_message_slack_will_not_show_can_be_filed_later(
    intake_on: TestClient, slack: ReactionSlack, repositories: Any
) -> None:
    """When Slack refuses the message lookup nothing is filed, and the next reaction tries again."""
    slack.errors["reactions.get"] = "channel_not_found"
    assert _event(intake_on, _reaction("Ev1")).status_code == 200
    assert _issues(repositories) == []
    del slack.errors["reactions.get"]
    assert _event(intake_on, _reaction("Ev2")).status_code == 200
    assert len(_issues(repositories)) == 1


def test_an_installation_without_the_reactions_scope_asks_for_a_reinstall(
    slack_client: TestClient, installed: SlackInstallation, repositories: Any
) -> None:
    """An App added before intake existed lacks `reactions:read`, and the setting says to reconnect."""
    older = installed.model_copy(update={"scopes": [scope for scope in installed.scopes if scope != "reactions:read"]})
    assert reactions.needs_reinstall(older) is True
    assert reactions.needs_reinstall(installed) is False
    assert slack_client.get(INTAKE).json()["reinstall"] is False


def test_a_purged_team_loses_its_setting(intake_on: TestClient, repositories: Any) -> None:
    """Purging a team removes its reaction intake row."""
    assert repositories.github.slack_intake.delete_team(WORKSPACE, TEAM) is True
    assert repositories.github.slack_intake.get(WORKSPACE, TEAM) is None


ASK_TS = "1700000100.000100"


def _posted(
    event_id: str, *, user: str = "UOWNER", channel: str = CHANNEL, ts: str = ASK_TS, **extra: Any
) -> dict[str, Any]:
    """One `message` envelope: a new top-level message in a channel unless `extra` says otherwise."""
    event = {
        "type": "message",
        "channel": channel,
        "channel_type": "channel",
        "user": user,
        "text": "Can someone look at the deploy?\nIt hangs",
        "ts": ts,
        **extra,
    }
    return {"type": "event_callback", "team_id": SLACK_TEAM, "event_id": event_id, "event": event}


@pytest.fixture
def asks_on(slack_client: TestClient) -> TestClient:
    """The team filing every top-level message in `#eng`, with `:ticket:` as its emoji."""
    response = slack_client.put(
        INTAKE, json={"emoji": "ticket", "channel_ids": [CHANNEL], "message_channel_ids": [CHANNEL]}
    )
    assert response.status_code == 200, response.text
    assert response.json()["message_channel_ids"] == [CHANNEL]
    return slack_client


@pytest.mark.parametrize(
    ("extra", "taken"),
    [
        ({}, True),
        ({"subtype": "file_share"}, True),
        ({"thread_ts": ASK_TS}, True),
        ({"thread_ts": "1700000000.000001"}, False),
        ({"subtype": "thread_broadcast", "thread_ts": "1700000000.000001"}, False),
        ({"subtype": "channel_join"}, False),
        ({"subtype": "message_changed"}, False),
        ({"subtype": "message_deleted"}, False),
        ({"subtype": "bot_message"}, False),
        ({"bot_id": "B0BOT"}, False),
        ({"app_id": "A0APP"}, False),
        ({"hidden": True}, False),
        ({"channel_type": "im", "channel": "D0DM"}, False),
        ({"user": ""}, False),
        ({"ts": ""}, False),
    ],
)
def test_only_a_persons_new_top_level_message_is_taken(extra: dict[str, Any], taken: bool) -> None:
    """Thread replies, edits, joins, bot and app posts and direct messages are left alone."""
    assert reactions.message_wanted(_posted("Ev1", **extra)["event"]) is taken


def test_every_message_mode_files_each_new_message_once_and_acknowledges_it(
    asks_on: TestClient, slack: ReactionSlack, repositories: Any
) -> None:
    """A top-level message becomes one issue paired with its thread, and the bot reacts with the team's emoji."""
    assert _event(asks_on, _posted("Ev1")).status_code == 200
    [issue] = _issues(repositories)
    assert issue.title == "Can someone look at the deploy?"
    assert issue.created_by == OWNER
    assert "It hangs" in (issue.body or "") and PERMALINK in (issue.body or "")
    assert slack.last("reactions.add") == {"channel": CHANNEL, "timestamp": ASK_TS, "name": "ticket"}
    reply = slack.last("chat.postMessage")
    assert reply["channel"] == CHANNEL and reply["thread_ts"] == ASK_TS
    assert repositories.github.slack_threads.get_link(WORKSPACE, CHANNEL, ASK_TS, issue.issue_id) is not None
    claim = repositories.github.slack_intake.get_claim(WORKSPACE, CHANNEL, ASK_TS, TEAM)
    assert claim is not None and claim.state == "filed" and claim.issue_id == issue.issue_id

    assert _event(asks_on, _posted("Ev2")).status_code == 200
    assert _event(asks_on, _reaction("Ev3", ts=ASK_TS)).status_code == 200
    assert len(_issues(repositories)) == 1
    assert slack.methods().count("reactions.add") == 1
    assert "reactions.get" not in slack.methods()


def test_every_message_mode_skips_replies_bots_and_joins(
    asks_on: TestClient, slack: ReactionSlack, repositories: Any
) -> None:
    """Only a person's new top-level message files anything, and the bot's own posts never do."""
    assert _event(asks_on, _posted("Ev1", ts="1700000100.000200", thread_ts=MESSAGE_TS)).status_code == 200
    assert _event(asks_on, _posted("Ev2", user="UBOT")).status_code == 200
    assert _event(asks_on, _posted("Ev3", bot_id="B0BOT")).status_code == 200
    assert _event(asks_on, _posted("Ev4", subtype="channel_join")).status_code == 200
    assert _event(asks_on, _posted("Ev5", subtype="message_changed")).status_code == 200
    assert _issues(repositories) == []
    assert "reactions.add" not in slack.methods()


def test_a_reaction_mode_channel_files_no_plain_message(
    intake_on: TestClient, slack: ReactionSlack, repositories: Any
) -> None:
    """Without every message mode a new message waits for the emoji, which still files it."""
    assert _event(intake_on, _posted("Ev1", channel=CHANNEL)).status_code == 200
    assert _event(intake_on, _posted("Ev2", channel="C0OPS")).status_code == 200
    assert _issues(repositories) == []
    assert "reactions.add" not in slack.methods()


def test_a_message_from_someone_without_an_account_files_as_the_admin(asks_on: TestClient, repositories: Any) -> None:
    """An author with no Standupless member still files their ask, written as the admin who turned it on."""
    assert _event(asks_on, _posted("Ev1", user="USTRANGER")).status_code == 200
    [issue] = _issues(repositories)
    assert issue.created_by == ADMIN


def test_an_acknowledgement_slack_refuses_still_files_once(
    asks_on: TestClient, slack: ReactionSlack, repositories: Any
) -> None:
    """A refused reaction leaves the filed issue and its claim in place."""
    slack.errors["reactions.add"] = "missing_scope"
    assert _event(asks_on, _posted("Ev1")).status_code == 200
    assert _event(asks_on, _posted("Ev2")).status_code == 200
    assert len(_issues(repositories)) == 1


def test_every_message_mode_needs_the_channel_and_one_team_per_channel(asks_on: TestClient) -> None:
    """A message channel has to be picked as well, and a second team cannot file every message in it too."""
    refused = asks_on.put(
        OTHER_INTAKE, json={"emoji": "bug", "channel_ids": ["C0OPS"], "message_channel_ids": [CHANNEL]}
    )
    assert refused.status_code == 422
    clash = asks_on.put(OTHER_INTAKE, json={"emoji": "bug", "channel_ids": [CHANNEL], "message_channel_ids": [CHANNEL]})
    assert clash.status_code == 409
    reaction_only = asks_on.put(OTHER_INTAKE, json={"emoji": "bug", "channel_ids": [CHANNEL]})
    assert reaction_only.status_code == 200


def test_every_message_mode_asks_for_a_reinstall_without_the_reaction_write_scope(
    asks_on: TestClient, installed: SlackInstallation
) -> None:
    """An App added before acknowledgements existed lacks `reactions:write`, which only every message mode needs."""
    older = installed.model_copy(update={"scopes": [scope for scope in installed.scopes if scope != "reactions:write"]})
    assert reactions.needs_reinstall(older) is False
    assert reactions.needs_reinstall(older, every_message=True) is True
    assert asks_on.get(INTAKE).json()["reinstall"] is False
