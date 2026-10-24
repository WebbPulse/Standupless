"""Personal notifications as Slack direct messages: the member's link, the post and its failures.

Slack is faked at `api.call` as in `test_slack.py`, with `users.lookupByEmail`
answered from the same script of Slack people, so linking, rendering and every
refusal path run without reaching Slack.
"""

from __future__ import annotations

from typing import Any, Iterator, Mapping

import pytest
from fastapi.testclient import TestClient

from app.common.chat_digests import CHAT_DIGEST_JOB, ChatDigest, ChatDigestGroup
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.chat_routes import ChatRoute
from app.common.db.dynamo.slack import SlackInstallation
from app.domains.integrations.consumers import dispatch
from app.domains.integrations.slack import api, direct, install
from app.domains.integrations.slack.api import SlackError
from tests.domains.helpers import MEMBER, OWNER, sign_in
from tests.domains.integrations.conftest import WORKSPACE, sqs_record
from tests.domains.integrations.test_slack import BOT_TOKEN, SLACK_TEAM, FakeSlack, _answer

LINK_PATH = f"/api/workspaces/{WORKSPACE}/slack/me"

PEOPLE = {
    "member@example.com": {"id": "UMEMBER", "is_email_confirmed": True},
    "owner@example.com": {"id": "UOWNER", "is_email_confirmed": False},
}


class DirectSlack(FakeSlack):
    """The shared Slack fake, also answering `users.lookupByEmail` and scripting retryable failures."""

    def __init__(self) -> None:
        """Start with no scripted outages."""
        super().__init__()
        self.statuses: dict[str, int] = {}

    def call(self, method: str, token: str, payload: Mapping[str, Any] | None = None) -> dict[str, Any]:
        """Answer the lookup from `PEOPLE`, raise any scripted HTTP failure, and defer the rest."""
        body = dict(payload or {})
        if method in self.statuses:
            self.calls.append((method, token, body))
            raise SlackError(self.errors.get(method, "server_error"), status_code=self.statuses[method])
        if method == "users.lookupByEmail" and method not in self.errors:
            self.calls.append((method, token, body))
            email = str(body.get("email", ""))
            person = PEOPLE.get(email)
            if person is None:
                raise SlackError("users_not_found")
            return {
                "ok": True,
                "user": {
                    "id": person["id"],
                    "is_email_confirmed": person["is_email_confirmed"],
                    "profile": {"email": email},
                },
            }
        return super().call(method, token, payload)


@pytest.fixture
def slack(monkeypatch: pytest.MonkeyPatch) -> DirectSlack:
    """A configured Slack App with every call faked."""
    monkeypatch.setenv("SLACK_CLIENT_ID", "1111.2222")
    monkeypatch.setenv("SLACK_CLIENT_SECRET", "a-test-slack-client-secret")
    monkeypatch.setenv("SLACK_SIGNING_SECRET", "a-test-slack-signing-secret")
    fake = DirectSlack()
    monkeypatch.setattr(api, "call", fake.call)
    return fake


@pytest.fixture
def bound(repositories: Any, workspace: str, github_env: None, slack: DirectSlack) -> SlackInstallation:
    """The Slack App installed in the test workspace, with every member's email confirmed."""
    for user_id in (OWNER, MEMBER):
        repositories.users.update(user_id, email_verified=True)
    return install.bind(repositories, WORKSPACE, OWNER, _answer())


@pytest.fixture
def member_client(client: TestClient, bound: SlackInstallation) -> Iterator[TestClient]:
    """The integrations client signed in as the plain member."""
    sign_in(client, MEMBER)
    yield client


def _route(repositories: Any, **fields: Any) -> ChatRoute:
    """Store the member's Slack route directly, for the send tests."""
    values: dict[str, Any] = {
        "workspace_id": WORKSPACE,
        "user_id": MEMBER,
        "provider": "slack",
        "external_user_id": "UMEMBER",
        "external_team_id": SLACK_TEAM,
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
                label="ABC-1 Fix <the> login",
                url="https://staging.standupless.dev/w/acme/issues/ABC-1",
                lines=["Olive commented & asked <@U0BOSS>"],
            )
        ],
    }
    values.update(fields)
    return ChatDigest(**values)


def test_linking_finds_the_slack_account_with_the_confirmed_email(
    member_client: TestClient, repositories: Any, slack: DirectSlack
) -> None:
    """A link reads unlinked, then names the Slack user after the lookup, then is gone after an unlink."""
    before = member_client.get(LINK_PATH)
    assert before.status_code == 200, before.text
    assert before.json()["linked"] is False
    assert before.json()["available"] is True

    linked = member_client.put(LINK_PATH)
    assert linked.status_code == 200, linked.text
    assert linked.json()["linked"] is True
    assert linked.json()["slack_user_id"] == "UMEMBER"
    assert linked.json()["problem"] is None
    assert slack.last("users.lookupByEmail") == {"email": "member@example.com"}
    route = repositories.inbox.chat_routes.get(WORKSPACE, MEMBER, "slack")
    assert route is not None and route.external_team_id == SLACK_TEAM

    removed = member_client.delete(LINK_PATH)
    assert removed.status_code == 204
    assert repositories.inbox.chat_routes.get(WORKSPACE, MEMBER, "slack") is None
    assert member_client.delete(LINK_PATH).status_code == 404


def test_a_link_is_refused_without_a_confirmed_matching_account(
    client: TestClient, repositories: Any, bound: SlackInstallation, slack: DirectSlack
) -> None:
    """An unconfirmed Slack email, an unverified Standupless email and an unknown one all answer 409."""
    sign_in(client, OWNER)
    refused = client.put(LINK_PATH)
    assert refused.status_code == 409, refused.text
    assert "SLACK_USER_NOT_FOUND" in refused.text

    repositories.users.update(MEMBER, email_verified=False)
    sign_in(client, MEMBER)
    unverified = client.put(LINK_PATH)
    assert unverified.status_code == 409
    assert "EMAIL_UNVERIFIED" in unverified.text
    assert repositories.inbox.chat_routes.list(WORKSPACE, MEMBER) == []


def test_a_link_needs_an_installed_app(
    client: TestClient, repositories: Any, workspace: str, github_env: None, slack: DirectSlack
) -> None:
    """Without an installation the read says unavailable and a link answers 404."""
    sign_in(client, MEMBER)
    read = client.get(LINK_PATH)
    assert read.json() == {
        "configured": True,
        "available": False,
        "linked": False,
        "slack_user_id": None,
        "slack_team_name": None,
        "linked_at": None,
        "problem": None,
    }
    assert client.put(LINK_PATH).status_code == 404


def test_a_batch_posts_once_to_the_member_with_escaped_text(
    bound: SlackInstallation, repositories: Any, slack: DirectSlack
) -> None:
    """The post goes to the Slack user, escapes member text, and a redelivered job posts nothing more."""
    _route(repositories)
    assert direct.send(repositories, _digest()) is True
    body = slack.last("chat.postMessage")
    assert body["channel"] == "UMEMBER"
    assert body["unfurl_links"] is False
    section = body["blocks"][0]["text"]["text"]
    assert "Fix &lt;the&gt; login" in section
    assert "&amp; asked &lt;@U0BOSS&gt;" in section
    assert "<@U0BOSS>" not in section
    assert "Acme" in body["blocks"][-1]["elements"][0]["text"]
    assert slack.calls[-1][1] == BOT_TOKEN

    assert direct.send(repositories, _digest()) is False
    assert slack.methods().count("chat.postMessage") == 1


def test_a_long_batch_points_at_the_inbox_for_the_rest(bound: SlackInstallation, repositories: Any) -> None:
    """The footer counts what the message left out, and the fallback text counts it all."""
    rendered = direct.render(_digest(more=4))
    assert "4 more in your inbox." in rendered["blocks"][-1]["elements"][0]["text"]
    assert rendered["text"] == "5 Standupless notifications"


@pytest.mark.parametrize("code", ["messages_tab_disabled", "user_not_found", "token_revoked"])
def test_a_refusal_no_retry_fixes_breaks_the_route(
    bound: SlackInstallation, repositories: Any, slack: DirectSlack, code: str
) -> None:
    """The route stops delivering with the reason, and the next batch is not posted."""
    _route(repositories)
    slack.errors["chat.postMessage"] = code
    assert direct.send(repositories, _digest()) is False
    route = repositories.inbox.chat_routes.get(WORKSPACE, MEMBER, "slack")
    assert route is not None and route.broken_reason == code
    assert repositories.inbox.chat_routes.active(WORKSPACE, MEMBER) == []

    slack.calls.clear()
    assert direct.send(repositories, _digest(window=1_790_000_120)) is False
    assert "chat.postMessage" not in slack.methods()


def test_a_rate_limit_raises_and_releases_the_window(
    bound: SlackInstallation, repositories: Any, slack: DirectSlack
) -> None:
    """A retryable answer raises for the queue, and the retry posts because the claim was released."""
    _route(repositories)
    slack.errors["chat.postMessage"] = "ratelimited"
    slack.statuses["chat.postMessage"] = 429
    with pytest.raises(SlackError):
        direct.send(repositories, _digest())
    assert repositories.inbox.chat_routes.active(WORKSPACE, MEMBER) != []

    del slack.errors["chat.postMessage"]
    del slack.statuses["chat.postMessage"]
    assert direct.send(repositories, _digest()) is True


def test_a_route_from_another_slack_team_is_broken_without_a_post(
    bound: SlackInstallation, repositories: Any, slack: DirectSlack
) -> None:
    """A reinstall into a different Slack team never delivers to the Slack user linked before it."""
    _route(repositories, external_team_id="T0OTHER")
    assert direct.send(repositories, _digest()) is False
    assert "chat.postMessage" not in slack.methods()
    route = repositories.inbox.chat_routes.get(WORKSPACE, MEMBER, "slack")
    assert route is not None and route.broken_reason == direct.TEAM_CHANGED


def test_the_dispatch_consumer_sends_a_queued_batch(
    bound: SlackInstallation, repositories: Any, slack: DirectSlack
) -> None:
    """A `chat.digest` job off the dispatch queue becomes one post, and a malformed one is dropped."""
    _route(repositories)
    job = {"kind": CHAT_DIGEST_JOB, **_digest().model_dump(mode="json")}
    dispatch.handle_record(repositories, sqs_record(job))
    assert slack.methods().count("chat.postMessage") == 1

    dispatch.handle_record(repositories, sqs_record({"kind": CHAT_DIGEST_JOB, "window": "soon"}))
    assert slack.methods().count("chat.postMessage") == 1


def test_a_broken_link_shows_its_problem_and_relinking_clears_it(member_client: TestClient, repositories: Any) -> None:
    """Settings name the reason, and a fresh link starts delivering again."""
    _route(repositories)
    repositories.inbox.chat_routes.mark_broken(WORKSPACE, MEMBER, "slack", "messages_tab_disabled")
    assert member_client.get(LINK_PATH).json()["problem"] == "messages_tab_disabled"

    relinked = member_client.put(LINK_PATH)
    assert relinked.status_code == 200
    assert relinked.json()["problem"] is None
    assert repositories.inbox.chat_routes.active(WORKSPACE, MEMBER) != []
