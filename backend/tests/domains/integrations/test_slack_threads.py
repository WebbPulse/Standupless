"""Comments synced both ways between an issue and the Slack thread it was created from.

Slack is faked at `api.call` as in `test_slack.py`. A pairing is made through the
form a message shortcut opens, a Slack reply arrives through the signed events
route, and a Standupless reply crosses through the comments stream and the
dispatch consumer, so each test runs the routing a deployed function runs.
"""

from __future__ import annotations

import json
import time
from typing import Any, Iterator, Mapping

import pytest
from fastapi.testclient import TestClient

from app.common.db.dynamo.base import as_item
from app.common.db.dynamo.comments import Comment, build_comment
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.slack import SlackInstallation
from app.domains.integrations.consumers import dispatch
from app.domains.integrations.slack import api, commands, install, threads
from app.domains.integrations.slack.api import SlackError
from tests.domains.helpers import ADMIN, MEMBER, OWNER, sign_in
from tests.domains.integrations.conftest import TEAM, WORKSPACE, sqs_record
from tests.domains.integrations.test_issue_sync import stream_record
from tests.domains.integrations.test_slack import SLACK_TEAM, FakeSlack, _answer, _event, _interaction, _submission

CHANNEL = "C0ENG"

THREAD_TS = "1700000000.000100"


class ThreadSlack(FakeSlack):
    """The shared Slack fake, also naming people by display name and answering posts with a `ts`."""

    def __init__(self) -> None:
        """Start numbering posted messages from one."""
        super().__init__()
        self.posted = 0

    def call(self, method: str, token: str, payload: Mapping[str, Any] | None = None) -> dict[str, Any]:
        """Answer a post with a fresh `ts`, a lookup of `UDANA` with a display name, and defer the rest."""
        body = dict(payload or {})
        if method == "chat.postMessage" and method not in self.errors:
            self.calls.append((method, token, body))
            self.posted += 1
            return {"ok": True, "ts": f"1800000000.{self.posted:06d}"}
        if method == "users.info" and body.get("user") == "UDANA":
            self.calls.append((method, token, body))
            profile = {"display_name": "Dana", "email": "dana@elsewhere.example"}
            return {"ok": True, "user": {"is_email_confirmed": True, "profile": profile}}
        return super().call(method, token, payload)


@pytest.fixture
def slack(monkeypatch: pytest.MonkeyPatch) -> ThreadSlack:
    """A configured Slack App with every call faked."""
    monkeypatch.setenv("SLACK_CLIENT_ID", "1111.2222")
    monkeypatch.setenv("SLACK_CLIENT_SECRET", "a-test-slack-client-secret")
    monkeypatch.setenv("SLACK_SIGNING_SECRET", "a-test-slack-signing-secret")
    fake = ThreadSlack()
    monkeypatch.setattr(api, "call", fake.call)
    monkeypatch.setattr(commands, "respond", lambda url, payload: True)
    return fake


@pytest.fixture
def installed(repositories: Any, workspace: str, github_env: None, slack: ThreadSlack) -> SlackInstallation:
    """The Slack App installed in the test workspace."""
    return install.bind(repositories, WORKSPACE, OWNER, _answer())


@pytest.fixture
def slack_client(client: TestClient, installed: SlackInstallation) -> Iterator[TestClient]:
    """The integrations client with the Slack App installed and Slack faked."""
    yield client


def _from_message(title: str, *, channel_id: str = CHANNEL, thread_ts: str = THREAD_TS) -> dict[str, Any]:
    """The form submission a message shortcut's form sends, carrying the message's thread."""
    payload = _submission(TEAM, title, permalink="https://acme.slack.com/archives/C0ENG/p1")
    metadata = {
        "permalink": "https://acme.slack.com/archives/C0ENG/p1",
        "channel_id": channel_id,
        "thread_ts": thread_ts,
    }
    payload["view"]["private_metadata"] = json.dumps(metadata)
    return payload


def _created(repositories: Any, title: str) -> Issue:
    """The one issue in the team with this title."""
    rows = [row for row in repositories.issues.list_for_team(WORKSPACE, TEAM).items if row.get("title") == title]
    assert len(rows) == 1
    issue = repositories.issues.get(WORKSPACE, str(rows[0]["issue_id"]))
    assert issue is not None
    return issue


@pytest.fixture
def paired(slack_client: TestClient, repositories: Any) -> Issue:
    """An issue created from a Slack message, paired with the message's thread."""
    assert _interaction(slack_client, _from_message("Checkout fails on Safari")).status_code == 200
    return _created(repositories, "Checkout fails on Safari")


def _comments(repositories: Any, issue: Issue) -> list[Comment]:
    """Every comment on the issue, oldest first."""
    return sorted(repositories.comments.iter_for_issue(WORKSPACE, issue.issue_id), key=lambda row: row.created_at)


def _root(repositories: Any, issue: Issue) -> Comment:
    """The comment the issue's Slack thread is synced under."""
    roots = [row for row in _comments(repositories, issue) if row.slack_thread is not None]
    assert len(roots) == 1
    return roots[0]


def _later() -> str:
    """A Slack `ts` a moment after now, so the reply postdates the pairing."""
    return f"{time.time() + 5:.6f}"


def _reply(event_id: str, *, user: str = "UOWNER", text: str = "Seen it on iOS too", **fields: Any) -> dict[str, Any]:
    """One `message` event: a reply in the paired thread."""
    event: dict[str, Any] = {
        "type": "message",
        "channel": CHANNEL,
        "user": user,
        "text": text,
        "ts": _later(),
        "thread_ts": THREAD_TS,
    }
    event.update(fields)
    return {"type": "event_callback", "team_id": SLACK_TEAM, "event_id": event_id, "event": event}


def _push(repositories: Any, comment: Comment) -> None:
    """Run the job the stream record of `comment` queues."""
    job = {
        "kind": threads.THREAD_COMMENT_JOB,
        "workspace_id": WORKSPACE,
        "issue_id": comment.issue_id,
        "comment_id": comment.comment_id,
    }
    dispatch.handle_record(repositories, sqs_record(job))


def _member_reply(repositories: Any, issue: Issue, root: Comment, body: str = "Fix is behind a flag") -> Comment:
    """A reply by the member under `root`, written in Standupless."""
    return repositories.comments.create(
        build_comment(WORKSPACE, issue.issue_id, TEAM, MEMBER, body, parent_comment_id=root.comment_id)
    )


def _thread_posts(slack: ThreadSlack) -> list[dict[str, Any]]:
    """Every post the bot made into the paired thread."""
    return [
        body
        for method, _, body in slack.calls
        if method == "chat.postMessage" and body.get("channel") == CHANNEL and body.get("thread_ts") == THREAD_TS
    ]


def test_an_issue_created_from_a_message_is_paired_with_its_thread(
    paired: Issue, repositories: Any, slack: ThreadSlack
) -> None:
    """The bot joins, replies in the thread with the issue link, and one root comment carries the mark."""
    assert "conversations.join" in slack.methods()
    posts = _thread_posts(slack)
    assert len(posts) == 1
    assert "ABC-" in posts[0]["text"] and "Checkout fails on Safari" in posts[0]["text"]
    assert "/w/acme/issues/ABC-" in posts[0]["text"]

    root = _root(repositories, paired)
    assert root.source == "slack"
    assert root.author_id == OWNER
    assert root.slack_thread is not None
    assert root.slack_thread.channel_id == CHANNEL
    assert root.slack_thread.thread_ts == THREAD_TS
    assert root.slack_thread.slack_team_id == SLACK_TEAM
    assert root.slack_thread.permalink == "https://acme.slack.com/archives/C0ENG/p1"
    links = repositories.github.slack_threads.links_for_thread(WORKSPACE, CHANNEL, THREAD_TS)
    assert [link.issue_id for link in links] == [paired.issue_id]
    assert links[0].root_comment_id == root.comment_id


def test_a_thread_slack_will_not_reply_in_is_not_paired(
    slack_client: TestClient, repositories: Any, slack: ThreadSlack
) -> None:
    """The issue is still created, but with no root comment and no pairing."""
    slack.errors["chat.postMessage"] = "not_in_channel"
    assert _interaction(slack_client, _from_message("Private thread issue")).json()["response_action"] == "update"
    issue = _created(repositories, "Private thread issue")
    assert _comments(repositories, issue) == []
    assert repositories.github.slack_threads.links_for_thread(WORKSPACE, CHANNEL, THREAD_TS) == []


def test_a_form_opened_from_the_command_pairs_nothing(
    slack_client: TestClient, repositories: Any, slack: ThreadSlack
) -> None:
    """A form with no message behind it has no thread to pair with."""
    _interaction(slack_client, _submission(TEAM, "From the command"))
    issue = _created(repositories, "From the command")
    assert _comments(repositories, issue) == []
    assert _thread_posts(slack) == []


def test_the_message_shortcut_carries_the_thread_into_the_form(slack_client: TestClient, slack: ThreadSlack) -> None:
    """A reply's own thread is used, and a top level message starts its own."""
    payload = {
        "type": "message_action",
        "callback_id": commands.SHORTCUT_CALLBACK,
        "team": {"id": SLACK_TEAM},
        "user": {"id": "UOWNER"},
        "trigger_id": "trigger-2",
        "response_url": "https://hooks.slack.com/actions/T0/1/x",
        "channel": {"id": CHANNEL},
        "message": {"text": "Checkout fails", "ts": "1700000000.000200", "thread_ts": THREAD_TS},
    }
    _interaction(slack_client, payload)
    metadata = json.loads(slack.last("views.open")["view"]["private_metadata"])
    assert metadata["channel_id"] == CHANNEL and metadata["thread_ts"] == THREAD_TS

    payload["message"] = {"text": "Checkout fails", "ts": "1700000000.000300"}
    _interaction(slack_client, payload)
    metadata = json.loads(slack.last("views.open")["view"]["private_metadata"])
    assert metadata["thread_ts"] == "1700000000.000300"


def test_a_slack_reply_lands_once_as_the_matching_members_comment(
    slack_client: TestClient, paired: Issue, repositories: Any
) -> None:
    """The reply nests under the root as the member, and a redelivery or a second event id adds nothing."""
    envelope = _reply("EvR1", text="Seen on <https://example.com/ios|iOS> &amp; Android")
    assert _event(slack_client, envelope).json() == {"ok": True}
    root = _root(repositories, paired)
    replies = [row for row in _comments(repositories, paired) if row.parent_comment_id == root.comment_id]
    assert len(replies) == 1
    assert replies[0].author_id == OWNER
    assert replies[0].source == "slack"
    assert replies[0].body == "Seen on [iOS](https://example.com/ios) & Android"

    assert _event(slack_client, envelope).json()["duplicate"] is True
    assert _event(slack_client, {**envelope, "event_id": "EvR2"}).json() == {"ok": True}
    replies = [row for row in _comments(repositories, paired) if row.parent_comment_id == root.comment_id]
    assert len(replies) == 1


def test_a_slack_reply_from_someone_without_an_account_carries_their_slack_name(
    slack_client: TestClient, paired: Issue, repositories: Any
) -> None:
    """No member matches, so the comment is attributed to the Slack display name."""
    _event(slack_client, _reply("EvD1", user="UDANA", text="Same here"))
    root = _root(repositories, paired)
    replies = [row for row in _comments(repositories, paired) if row.parent_comment_id == root.comment_id]
    assert [row.author_id for row in replies] == ["slack:Dana"]


@pytest.mark.parametrize(
    "fields",
    [
        {"user": "UBOT"},
        {"bot_id": "B0OTHER"},
        {"app_id": "A0OTHER"},
        {"subtype": "message_changed"},
        {"subtype": "channel_join"},
        {"thread_ts": None},
        {"thread_ts": "1700000000.999999"},
        {"channel": "C0OTHER"},
    ],
)
def test_bot_posts_edits_and_unpaired_messages_do_not_cross(
    slack_client: TestClient, paired: Issue, repositories: Any, slack: ThreadSlack, fields: dict[str, Any]
) -> None:
    """The bot's own posts, other apps, non-reply subtypes and other threads all stay in Slack."""
    before = len(_comments(repositories, paired))
    envelope = _reply("EvX1", **fields)
    if envelope["event"].get("thread_ts") is None:
        envelope["event"].pop("thread_ts")
    assert _event(slack_client, envelope).json() == {"ok": True}
    assert len(_comments(repositories, paired)) == before
    assert len(_thread_posts(slack)) == 1


def test_a_reply_written_before_the_pairing_is_ignored(
    paired: Issue, repositories: Any, installed: SlackInstallation
) -> None:
    """A late redelivery of a reply older than the pairing does not land."""
    event = _reply("EvOld", ts="1600000000.000100")["event"]
    assert threads.receive(repositories, installed, event) == 0


def test_a_standupless_reply_is_posted_to_the_thread_once(
    paired: Issue, repositories: Any, slack: ThreadSlack, enqueued: list[tuple[str, Any]]
) -> None:
    """The stream queues the member's reply, the job posts it naming them, and a retry posts nothing."""
    root = _root(repositories, paired)
    reply = _member_reply(repositories, paired, root, "Fix is behind <the> [flag](https://example.com/flag)")
    assert threads.queue_reply(repositories, stream_record("INSERT", as_item(reply)))
    assert enqueued and enqueued[-1][1].payload["kind"] == threads.THREAD_COMMENT_JOB

    _push(repositories, reply)
    posts = _thread_posts(slack)
    assert len(posts) == 2
    assert posts[-1]["text"].startswith("*Mel Member* commented in Standupless:")
    assert "&lt;the&gt;" in posts[-1]["text"]
    assert "<https://example.com/flag|flag>" in posts[-1]["text"]

    _push(repositories, reply)
    assert len(_thread_posts(slack)) == 2


def test_a_reply_from_slack_and_a_reply_elsewhere_are_never_posted(
    slack_client: TestClient, paired: Issue, repositories: Any, slack: ThreadSlack, enqueued: list[tuple[str, Any]]
) -> None:
    """A comment written from Slack does not echo back, and an unsynced thread's reply stays put."""
    _event(slack_client, _reply("EvE1"))
    root = _root(repositories, paired)
    from_slack = [row for row in _comments(repositories, paired) if row.parent_comment_id == root.comment_id][0]
    assert not threads.queue_reply(repositories, stream_record("INSERT", as_item(from_slack)))
    _push(repositories, from_slack)

    other_root = repositories.comments.create(build_comment(WORKSPACE, paired.issue_id, TEAM, MEMBER, "Unrelated"))
    elsewhere = _member_reply(repositories, paired, other_root)
    assert not threads.queue_reply(repositories, stream_record("INSERT", as_item(elsewhere)))
    assert not threads.queue_reply(repositories, stream_record("INSERT", as_item(root)))
    _push(repositories, elsewhere)
    assert len(_thread_posts(slack)) == 1


def test_a_rate_limited_post_is_retried(paired: Issue, repositories: Any, slack: ThreadSlack) -> None:
    """A transient refusal raises for the queue and frees the claim, so the retry posts."""
    root = _root(repositories, paired)
    reply = _member_reply(repositories, paired, root)
    slack.errors["chat.postMessage"] = "ratelimited"
    with pytest.raises(SlackError):
        _push(repositories, reply)
    assert slack.posted == 1
    del slack.errors["chat.postMessage"]
    _push(repositories, reply)
    assert slack.posted == 2
    _push(repositories, reply)
    assert slack.posted == 2


def test_an_uninstall_stops_the_sync_and_clears_the_mark(
    slack_client: TestClient, paired: Issue, repositories: Any, slack: ThreadSlack
) -> None:
    """Every pairing goes and the root keeps its text without the mark, so nothing crosses after."""
    root = _root(repositories, paired)
    uninstall = {
        "type": "event_callback",
        "team_id": SLACK_TEAM,
        "event_id": "EvU1",
        "event": {"type": "app_uninstalled"},
    }
    assert _event(slack_client, uninstall).json() == {"ok": True}
    assert repositories.github.slack_threads.links_for_thread(WORKSPACE, CHANNEL, THREAD_TS) == []
    cleared = repositories.comments.get(WORKSPACE, paired.issue_id, root.comment_id)
    assert cleared is not None and cleared.slack_thread is None and cleared.body == root.body

    reply = _member_reply(repositories, paired, cleared)
    assert not threads.queue_reply(repositories, stream_record("INSERT", as_item(reply)))
    _push(repositories, reply)
    assert len(_thread_posts(slack)) == 1


def test_disconnecting_slack_forgets_the_pairings(slack_client: TestClient, paired: Issue, repositories: Any) -> None:
    """An admin's disconnect clears the pairings as an uninstall does."""
    sign_in(slack_client, ADMIN)
    assert slack_client.delete(f"/api/workspaces/{WORKSPACE}/slack").status_code == 204
    assert repositories.github.slack_threads.list_links(WORKSPACE) == []
    root = [row for row in _comments(repositories, paired) if row.source == "slack"][0]
    assert root.slack_thread is None


def test_slack_text_converts_both_ways(installed: SlackInstallation, slack: ThreadSlack) -> None:
    """Links, mentions and entities read as Markdown, and Markdown reads back as inert Slack text."""
    assert threads.from_slack("<@UDANA> see <#C0ENG|eng> and <!here>", installed) == "@Dana see #eng and @here"
    assert threads.from_slack("<https://example.com>", installed) == "https://example.com"
    assert threads.to_slack("<!channel> & [docs](https://example.com/docs)") == (
        "&lt;!channel&gt; &amp; <https://example.com/docs|docs>"
    )
