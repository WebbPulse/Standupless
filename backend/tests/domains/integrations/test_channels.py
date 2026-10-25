"""Team channel notifications: the allowlist, sealing, formatting, filtering, delivery and routes.

No request leaves the test. Queue sends are captured, and the sender is a fake that
records what it was handed, so the URL a destination opens can be checked without
it ever being stored or returned in the clear.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Any, Mapping

import pytest
from boto3.dynamodb.types import TypeSerializer
from fastapi.testclient import TestClient
from webbpulse.dynamodb import table_name
from webbpulse.events.webhooks import WebhookResponse

from app.common.core.config import settings
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.channels import ChannelDestination, ChannelScope, channel_key, new_channel_id
from app.common.db.dynamo.planning import (
    Cycle,
    Initiative,
    Project,
    cycle_key,
    initiative_key,
    initiative_update_key,
    project_key,
    project_update_key,
)
from app.domains.integrations.channels import delivery, events, urls
from app.domains.integrations.channels.messages import EVENT_COLORS, ChannelMessage, discord_body, render, slack_body
from app.domains.integrations.consumers import dispatch, stream
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER, add_team_member, sign_in
from tests.domains.integrations.conftest import OTHER_TEAM, TEAM, WORKSPACE, sqs_record

SERIALIZER = TypeSerializer()

SLACK_URL = "https://hooks.slack.com/services/T0001/B0002/abcdEFGHijkl1234"

DISCORD_URL = "https://discord.com/api/webhooks/123456789012345678/tok-en_WXYZ"

PATH = f"/api/workspaces/{WORKSPACE}/teams/{TEAM}/webhooks/channels"


@dataclass
class Queue:
    """What the code under test queued, with the delay each job asked for."""

    jobs: list[dict[str, Any]] = field(default_factory=list)
    delays: list[int | None] = field(default_factory=list)


@pytest.fixture
def queue(monkeypatch: pytest.MonkeyPatch, github_env: None) -> Queue:
    """Capture every channel attempt job instead of sending it to SQS."""
    captured = Queue()

    def record_job(queue_url: str, envelope: Any, **kwargs: Any) -> str:
        """Keep the payload and the delay of one queued job."""
        captured.jobs.append(dict(envelope.payload))
        captured.delays.append(kwargs.get("delay_seconds"))
        return "message-id"

    monkeypatch.setattr(delivery, "enqueue", record_job)
    import app.domains.integrations.outbound.delivery as outbound

    monkeypatch.setattr(outbound, "enqueue", record_job)
    return captured


class FakeSender:
    """A sender answering from a script of responses and recording each request."""

    def __init__(self, *responses: WebhookResponse) -> None:
        """Answer with `responses` in order, repeating the last one."""
        self.responses = list(responses) or [WebhookResponse(status_code=200, body="ok")]
        self.sent: list[tuple[str, bytes, dict[str, str]]] = []

    def post(self, url: str, *, body: bytes, headers: Any, timeout: float) -> WebhookResponse:
        """Record one request and answer with the next scripted response."""
        self.sent.append((url, body, dict(headers)))
        return self.responses.pop(0) if len(self.responses) > 1 else self.responses[0]


@pytest.fixture
def sender(monkeypatch: pytest.MonkeyPatch) -> FakeSender:
    """Replace the pinned HTTPS sender the channel delivery uses."""
    fake = FakeSender()
    monkeypatch.setattr(delivery, "PinnedHttpsSender", lambda *a, **k: fake)
    return fake


def make_channel(
    repositories: Any,
    *,
    url: str = SLACK_URL,
    events_: list[str] | None = None,
    team_id: str = TEAM,
    enabled: bool = True,
) -> ChannelDestination:
    """Store one destination the way the create route would."""
    accepted = urls.classify(url)
    channel_id = new_channel_id()
    sealed = urls.sealed_fields(WORKSPACE, channel_id, accepted.url)
    destination = ChannelDestination(
        workspace_id=WORKSPACE,
        github_key=channel_key(channel_id),
        channel_id=channel_id,
        team_id=team_id,
        provider=accepted.provider,
        label="#eng",
        events=events_ if events_ is not None else ["issue_created"],
        enabled=enabled,
        created_by=OWNER,
        url_ciphertext=sealed["url_ciphertext"],
        url_nonce=sealed["url_nonce"],
        url_salt=sealed["url_salt"],
        url_scheme=sealed["url_scheme"],
        url_hint=sealed["url_hint"],
    )
    return repositories.github.channels.create(destination)


def record(
    event: str,
    new: Mapping[str, Any] | None,
    old: Mapping[str, Any] | None = None,
    *,
    table: str = "issues",
    event_id: str = "evt-1",
) -> dict[str, Any]:
    """One DynamoDB stream record in the shape Lambda delivers it."""
    dynamodb: dict[str, Any] = {"ApproximateCreationDateTime": 1790000000}
    if new is not None:
        dynamodb["NewImage"] = {key: SERIALIZER.serialize(value) for key, value in new.items()}
    if old is not None:
        dynamodb["OldImage"] = {key: SERIALIZER.serialize(value) for key, value in old.items()}
    arn = f"arn:aws:dynamodb:us-west-2:1:table/{table_name(table, settings.dynamodb_table_prefix)}/stream/x"
    return {"eventID": event_id, "eventName": event, "eventSourceARN": arn, "dynamodb": dynamodb}


def statuses(repositories: Any) -> dict[str, str]:
    """The team's status ids by category, first of each."""
    found: dict[str, str] = {}
    for row in repositories.team_config.list_statuses(WORKSPACE, TEAM):
        found.setdefault(row.category, row.status_id)
    return found


def issue_image(repositories: Any, **fields: Any) -> dict[str, Any]:
    """One issue row as a stream image carries it."""
    return {
        "workspace_id": WORKSPACE,
        "issue_id": "01JB0000000000000000000IS1",
        "team_id": TEAM,
        "key": "ABC-1",
        "number": 1,
        "title": "Fix <the> *login*",
        "status_id": statuses(repositories)["backlog"],
        "created_by": OWNER,
        "created_at": "2026-09-26T00:00:00+00:00",
        "updated_at": "2026-09-26T00:00:00+00:00",
        **fields,
    }


def delivery_body(repositories: Any, job: Mapping[str, Any]) -> dict[str, Any]:
    """The rendered body of the delivery one queued job is for."""
    row = repositories.github.channels.get_delivery(WORKSPACE, job["channel_id"], job["delivery_id"])
    assert row is not None
    return json.loads(row.body)


@pytest.mark.parametrize(
    ("url", "provider"),
    [
        (SLACK_URL, "slack"),
        (DISCORD_URL, "discord"),
        ("https://discordapp.com/api/webhooks/1/abc", "discord"),
        ("  https://HOOKS.slack.com/services/T/B/x  ", "slack"),
    ],
)
def test_the_allowlist_accepts_slack_and_discord_webhooks(url: str, provider: str) -> None:
    """Only the two providers' webhook paths are accepted, the old Discord host included."""
    assert urls.classify(url).provider == provider


@pytest.mark.parametrize(
    "url",
    [
        "http://hooks.slack.com/services/T/B/x",
        "https://hooks.slack.com.evil.test/services/T/B/x",
        "https://evil.test/services/T/B/x",
        "https://hooks.slack.com/workflows/T/B/x",
        "https://hooks.slack.com:8443/services/T/B/x",
        "https://user:pass@hooks.slack.com/services/T/B/x",
        "https://hooks.slack.com/services/T/B/x?redirect=1",
        "https://discord.com/api/channels/1/messages",
        "https://discord.com/api/webhooks/not-a-number/token",
        "https://169.254.169.254/latest/meta-data",
        "",
    ],
)
def test_the_allowlist_refuses_everything_else(url: str) -> None:
    """Another host, scheme, port, path or a query is refused, which is the SSRF guard."""
    with pytest.raises(urls.ChannelUrlRejected) as caught:
        urls.classify(url)
    assert url.strip() == "" or url not in str(caught.value)


def test_the_mask_shows_the_host_and_last_four_only() -> None:
    """The hint tells two URLs apart without carrying the token."""
    assert urls.mask(SLACK_URL) == "hooks.slack.com/…1234"
    assert urls.mask(DISCORD_URL) == "discord.com/…WXYZ"


def test_a_sealed_url_opens_only_on_its_own_row(repositories: Any, github_env: None) -> None:
    """The ciphertext holds no plaintext and is bound to its workspace and channel id."""
    destination = make_channel(repositories)
    stored = repositories.github._repository.get(
        {"workspace_id": WORKSPACE, "github_key": channel_key(destination.channel_id)}
    )

    assert SLACK_URL not in json.dumps(dict(stored), default=str)
    assert urls.open_url(destination) == SLACK_URL
    with pytest.raises(Exception):
        urls.open_url(destination.model_copy(update={"channel_id": new_channel_id()}))


def test_slack_messages_use_block_kit_and_escape_what_people_wrote() -> None:
    """The key, title, link and actor are in the blocks, with `<`, `>` and `&` entity encoded."""
    message = ChannelMessage(
        event="issue_created",
        subject="Fix <!channel> & stuff",
        url="https://app.test/issues/ABC-1",
        summary="Olive created this issue.",
        actor="Olive <Owner>",
        key="ABC-1",
    )

    body = slack_body(message)
    text = json.dumps(body)

    expected = "*<https://app.test/issues/ABC-1|ABC-1 Fix &lt;!channel&gt; &amp;"
    assert body["blocks"][0]["text"]["text"].startswith(expected)
    assert "<!channel>" not in text
    assert body["blocks"][-1]["elements"][0]["text"] == "by Olive &lt;Owner&gt;"
    assert body["unfurl_links"] is False


def test_discord_messages_use_one_embed_that_mentions_nobody() -> None:
    """The embed carries the title, link, author and colour, and no mention can parse."""
    message = ChannelMessage(
        event="comment_created",
        subject="Fix login",
        url="https://app.test/issues/ABC-1",
        summary="Olive commented.",
        actor="Olive",
        key="ABC-1",
        detail="@everyone look at **this**",
        fields=(("Status", "To *Do*"),),
    )

    body = discord_body(message)
    embed = body["embeds"][0]

    assert body["allowed_mentions"] == {"parse": []}
    assert embed["title"] == "ABC-1 Fix login"
    assert embed["url"] == "https://app.test/issues/ABC-1"
    assert embed["author"] == {"name": "Olive"}
    assert "\\@everyone" in embed["description"] and "\\*\\*this\\*\\*" in embed["description"]
    assert embed["fields"][0]["value"] == "To \\*Do\\*"


def test_render_picks_the_provider_shape() -> None:
    """Slack gets blocks and Discord gets embeds from the same message."""
    message = ChannelMessage(event="test", subject="Hi", url="", summary="Test")

    assert "blocks" in json.loads(render("slack", message))
    assert "embeds" in json.loads(render("discord", message))


def test_a_destination_gets_the_first_event_it_wants() -> None:
    """One record posts one message per destination, the most specific it subscribes to."""
    destination = ChannelDestination(
        workspace_id=WORKSPACE,
        github_key="channel#x",
        channel_id="x",
        team_id=TEAM,
        provider="slack",
        events=["issue_status_changed", "issue_completed"],
        url_ciphertext="",
        url_nonce="",
        url_salt="",
        url_scheme="",
        created_by=OWNER,
    )

    assert destination.wants(("issue_completed", "issue_status_changed")) == "issue_completed"
    assert destination.wants(("issue_created",)) is None
    assert destination.model_copy(update={"enabled": False}).wants(("issue_completed",)) is None


def test_a_new_issue_posts_to_the_channels_that_want_it(repositories: Any, workspace: str, queue: Queue) -> None:
    """A subscribed channel of the team gets one message, others none, and a redelivery lands on the same row."""
    wanted = make_channel(repositories, events_=["issue_created"])
    make_channel(repositories, events_=["comment_created"])
    make_channel(repositories, events_=["issue_created"], team_id=OTHER_TEAM)
    make_channel(repositories, events_=["issue_created"], enabled=False)
    image = issue_image(repositories)

    stream.handle_record(repositories, record("INSERT", image))
    stream.handle_record(repositories, record("INSERT", image))

    assert {job["channel_id"] for job in queue.jobs} == {wanted.channel_id}
    assert len({job["delivery_id"] for job in queue.jobs}) == 1
    body = delivery_body(repositories, queue.jobs[0])
    section = body["blocks"][0]["text"]["text"]
    assert "ABC-1 Fix &lt;the&gt; *login*" in section
    assert "/w/acme/issues/ABC-1|" in section
    assert body["blocks"][-1]["elements"][0]["text"] == "by Olive Owner"


def test_a_private_teams_channel_posts_only_while_its_creator_reads_the_team(
    repositories: Any, workspace: str, queue: Queue
) -> None:
    """A channel set up from outside a private team posts nothing until its creator joins the team."""
    channel = make_channel(repositories, events_=["issue_created"])
    repositories.memberships.set_team_private(WORKSPACE, TEAM, True)
    image = issue_image(repositories)

    stream.handle_record(repositories, record("INSERT", image))
    assert queue.jobs == []

    add_team_member(repositories, WORKSPACE, TEAM, OWNER, "member")
    stream.handle_record(repositories, record("INSERT", image, event_id="evt-2"))
    assert {job["channel_id"] for job in queue.jobs} == {channel.channel_id}


def test_completing_an_issue_posts_completed_rather_than_a_status_change(
    repositories: Any, workspace: str, queue: Queue
) -> None:
    """A channel that wants both gets the one completion message; a status-only one gets the move."""
    both = make_channel(repositories, events_=["issue_status_changed", "issue_completed"])
    moves = make_channel(repositories, events_=["issue_status_changed"], url=DISCORD_URL)
    old = issue_image(repositories)
    new = issue_image(repositories, status_id=statuses(repositories)["completed"], updated_by=ADMIN)

    stream.handle_record(repositories, record("MODIFY", new, old))

    by_channel = {job["channel_id"]: job for job in queue.jobs}
    assert set(by_channel) == {both.channel_id, moves.channel_id}
    store = repositories.github.channels
    completed = store.get_delivery(WORKSPACE, both.channel_id, by_channel[both.channel_id]["delivery_id"])
    moved = store.get_delivery(WORKSPACE, moves.channel_id, by_channel[moves.channel_id]["delivery_id"])
    assert completed is not None and completed.event == "issue_completed"
    assert moved is not None and moved.event == "issue_status_changed"
    assert "Adam Admin" in json.loads(moved.body)["embeds"][0]["author"]["name"]


def test_an_edit_that_moves_nothing_posts_nothing(repositories: Any, workspace: str, queue: Queue) -> None:
    """A title edit is not one of the events, so no channel hears of it."""
    make_channel(repositories, events_=["issue_status_changed", "issue_assigned", "issue_completed"])
    old = issue_image(repositories)

    stream.handle_record(repositories, record("MODIFY", {**old, "title": "Renamed"}, old))

    assert queue.jobs == []


def test_assigning_an_issue_names_the_assignee(repositories: Any, workspace: str, queue: Queue) -> None:
    """A new assignee is announced with their name."""
    channel = make_channel(repositories, events_=["issue_assigned"])
    old = issue_image(repositories)

    stream.handle_record(repositories, record("MODIFY", {**old, "assignee_id": MEMBER, "updated_by": OWNER}, old))

    assert len(queue.jobs) == 1 and queue.jobs[0]["channel_id"] == channel.channel_id
    assert "to Mel Member" in json.dumps(delivery_body(repositories, queue.jobs[0]))


def test_a_comment_posts_with_its_issue_and_an_excerpt(
    repositories: Any, workspace: str, issue: Any, queue: Queue
) -> None:
    """A new comment carries the issue's key and title and a quote of the body."""
    make_channel(repositories, events_=["comment_created"])
    comment = {
        "workspace_id": WORKSPACE,
        "ws_issue": f"{WORKSPACE}#{issue.issue_id}",
        "comment_id": "C1",
        "issue_id": issue.issue_id,
        "team_id": TEAM,
        "body": "Looks good to me",
        "author_id": MEMBER,
        "created_at": "2026-09-26T00:00:00+00:00",
    }

    stream.handle_record(repositories, record("INSERT", comment, table="comments"))

    assert len(queue.jobs) == 1
    text = json.dumps(delivery_body(repositories, queue.jobs[0]))
    assert "ABC-1 An issue" in text and "&gt;Looks good to me" not in text and ">Looks good to me" in text


def test_a_project_update_posts_to_its_projects_teams(repositories: Any, workspace: str, queue: Queue) -> None:
    """The update reaches the channels of every team its project belongs to, with its health."""
    repositories.planning.create_project(
        Project(
            workspace_id=WORKSPACE,
            planning_key=project_key("P1"),
            project_id="P1",
            team_ids=[TEAM],
            name="Launch",
            created_by=OWNER,
        )
    )
    make_channel(repositories, events_=["project_update_posted"], url=DISCORD_URL)
    update = {
        "workspace_id": WORKSPACE,
        "planning_key": project_update_key("P1", "U1"),
        "kind": "project_update",
        "project_id": "P1",
        "update_id": "U1",
        "author_id": OWNER,
        "body": "Slipping a week",
        "health": "at_risk",
        "created_at": "2026-09-20T12:00:00+00:00",
    }

    stream.handle_record(repositories, record("INSERT", update, table="planning"))

    assert len(queue.jobs) == 1
    embed = delivery_body(repositories, queue.jobs[0])["embeds"][0]
    assert embed["title"] == "Launch"
    assert embed["fields"] == [{"name": "Health", "value": "At risk", "inline": True}]
    assert embed["url"].endswith("?tab=updates#update-U1")


def test_a_project_update_carries_its_progress_report(repositories: Any, workspace: str, queue: Queue) -> None:
    """The report follows the body as plain lines, and a hidden one is left out."""
    repositories.planning.create_project(
        Project(
            workspace_id=WORKSPACE,
            planning_key=project_key("P1"),
            project_id="P1",
            team_ids=[TEAM],
            name="Launch",
            created_by=OWNER,
        )
    )
    make_channel(repositories, events_=["project_update_posted"], url=DISCORD_URL)
    snapshot = {"measure": "issues", "completed": 8, "total": 20, "percent": 40, "milestones": []}
    update = {
        "workspace_id": WORKSPACE,
        "planning_key": project_update_key("P1", "U1"),
        "kind": "project_update",
        "project_id": "P1",
        "update_id": "U1",
        "author_id": OWNER,
        "body": "Slipping a week",
        "health": "at_risk",
        "created_at": "2026-09-20T12:00:00+00:00",
        "snapshot": snapshot,
    }

    stream.handle_record(repositories, record("INSERT", update, table="planning"))
    stream.handle_record(
        repositories,
        record(
            "INSERT",
            {**update, "update_id": "U2", "planning_key": project_update_key("P1", "U2"), "hide_details": True},
            table="planning",
            event_id="evt-2",
        ),
    )

    shown, hidden = (delivery_body(repositories, job)["embeds"][0]["description"] for job in queue.jobs)
    assert "Slipping a week" in shown and r"Progress 40% \(8 of 20 issues\)" in shown
    assert "Slipping a week" in hidden and "Progress" not in hidden


def test_a_due_project_update_is_announced_once(repositories: Any, workspace: str, queue: Queue) -> None:
    """The reminder hook posts to the teams that opted in, and a rerun with the same seed posts nothing more."""
    repositories.planning.create_project(
        Project(
            workspace_id=WORKSPACE,
            planning_key=project_key("P1"),
            project_id="P1",
            team_ids=[TEAM],
            name="Launch",
            created_by=OWNER,
        )
    )
    make_channel(repositories, events_=["project_update_due"])

    due = datetime(2026, 10, 6, tzinfo=UTC)

    assert events.announce_project_update_due(repositories, WORKSPACE, "P1", seed="P1#2026-10-06", due_at=due) == 1
    events.announce_project_update_due(repositories, WORKSPACE, "P1", seed="P1#2026-10-06", due_at=due)

    assert len({job["delivery_id"] for job in queue.jobs}) == 1
    fake = FakeSender()
    assert [delivery.run_attempt(repositories, job, sender=fake) for job in queue.jobs][-1] == "duplicate"
    assert len(fake.sent) == 1


def test_the_dispatch_consumer_announces_a_queued_update_due_once(
    repositories: Any, workspace: str, queue: Queue
) -> None:
    """The reminder sweep's queued job posts to the opted in channel, and a redelivery posts nothing more."""
    repositories.planning.create_project(
        Project(
            workspace_id=WORKSPACE,
            planning_key=project_key("P1"),
            project_id="P1",
            team_ids=[TEAM],
            name="Launch",
            created_by=OWNER,
        )
    )
    make_channel(repositories, events_=["project_update_due"])
    job = {
        "kind": "channel.project_update_due",
        "workspace_id": WORKSPACE,
        "project_id": "P1",
        "due_at": "2026-10-06T00:00:00+00:00",
    }

    dispatch.handle_record(repositories, sqs_record(job))
    dispatch.handle_record(repositories, sqs_record(job))
    dispatch.handle_record(repositories, sqs_record({**job, "due_at": "not a date"}))

    assert len({queued["delivery_id"] for queued in queue.jobs}) == 1


STANDUP_DAY = date(2026, 10, 6)


def standup_note(repositories: Any, day: date = STANDUP_DAY) -> None:
    """Leave the guest's note on the team's digest of `day`, which gives the digest content."""
    repositories.team_config.put_standup_note(WORKSPACE, TEAM, day.isoformat(), GUEST, "Shipped the importer.")


def test_a_standup_digest_posts_once_per_channel_and_date(repositories: Any, workspace: str, queue: Queue) -> None:
    """A digest with content posts to the opted in channel, and a second announcement posts nothing more."""
    make_channel(repositories, events_=["standup_digest"], url=DISCORD_URL)
    make_channel(repositories, events_=["issue_created"])
    standup_note(repositories)

    assert events.announce_standup_digest(repositories, WORKSPACE, TEAM, STANDUP_DAY) == 1
    events.announce_standup_digest(repositories, WORKSPACE, TEAM, STANDUP_DAY)

    assert len({job["delivery_id"] for job in queue.jobs}) == 1
    embed = delivery_body(repositories, queue.jobs[0])["embeds"][0]
    assert embed["title"] == "ABC Abc standup"
    assert embed["url"].endswith("/team/ABC/standup?date=2026-10-06")
    assert "Gus Guest\\: left a note" in embed["description"]
    fake = FakeSender()
    assert [delivery.run_attempt(repositories, job, sender=fake) for job in queue.jobs][-1] == "duplicate"
    assert len(fake.sent) == 1


def test_each_digest_date_posts_its_own_message(repositories: Any, workspace: str, queue: Queue) -> None:
    """The seed is the team and date, so the next day's digest is a new post."""
    make_channel(repositories, events_=["standup_digest"])
    standup_note(repositories)
    standup_note(repositories, date(2026, 10, 7))

    events.announce_standup_digest(repositories, WORKSPACE, TEAM, STANDUP_DAY)
    events.announce_standup_digest(repositories, WORKSPACE, TEAM, date(2026, 10, 7))

    assert len({job["delivery_id"] for job in queue.jobs}) == 2


def test_an_empty_standup_digest_posts_nothing(repositories: Any, workspace: str, queue: Queue) -> None:
    """A digest with nothing in it is not posted, and a channel that did not opt in gets nothing."""
    make_channel(repositories, events_=["standup_digest"])

    assert events.announce_standup_digest(repositories, WORKSPACE, TEAM, STANDUP_DAY) == 0

    standup_note(repositories)
    make_channel(repositories, events_=["issue_created"], team_id=OTHER_TEAM)
    assert events.announce_standup_digest(repositories, WORKSPACE, OTHER_TEAM, STANDUP_DAY) == 0
    assert queue.jobs == []


def test_a_standup_message_counts_sections_and_lists_people() -> None:
    """The post carries a total per non-empty section and one line per person."""
    from app.common.standup import StandupDigest, StandupItem, StandupPerson

    item = StandupItem(issue_id="I1", key="ABC-1", title="One", status_id="S1")
    moment = datetime(2026, 10, 6, 9, tzinfo=UTC)
    digest = StandupDigest(
        team_id=TEAM,
        team_key="ABC",
        team_name="Abc",
        date="2026-10-06",
        cadence="daily",
        timezone="UTC",
        send_time="09:00",
        window_start=moment,
        window_end=moment,
        generated_at=moment,
        people=[
            StandupPerson(user_id="U1", display_name="Ann", completed=[item], blocked=[item]),
            StandupPerson(user_id="U2", display_name="Bo"),
        ],
    )

    message = events.standup_message(digest, "https://app.test", moment)

    assert message is not None
    assert message.summary == "Daily standup for Tue Oct 6, 2026."
    assert message.fields == (("Completed", "1"), ("Blocked", "1"))
    assert message.detail == "Ann: 1 completed, 1 blocked"
    assert events.standup_message(digest.model_copy(update={"people": digest.people[1:]}), "", moment) is None


def test_the_dispatch_consumer_posts_a_queued_standup_once(repositories: Any, workspace: str, queue: Queue) -> None:
    """The digest sweep's queued job posts to the opted in channel, and a redelivery posts nothing more."""
    make_channel(repositories, events_=["standup_digest"])
    standup_note(repositories)
    job = {"kind": "channel.standup_digest", "workspace_id": WORKSPACE, "team_id": TEAM, "date": "2026-10-06"}

    dispatch.handle_record(repositories, sqs_record(job))
    dispatch.handle_record(repositories, sqs_record(job))
    dispatch.handle_record(repositories, sqs_record({**job, "date": "not a date"}))
    dispatch.handle_record(repositories, sqs_record({**job, "team_id": ""}))

    assert len({queued["delivery_id"] for queued in queue.jobs}) == 1


def _scheduled(repositories: Any, queue: Queue, **channel: Any) -> tuple[ChannelDestination, dict[str, Any]]:
    """One destination with one scheduled message, and the job for its first attempt."""
    destination = make_channel(repositories, **channel)
    message = ChannelMessage(event="issue_created", subject="Hi", url="https://app.test", summary="Hello")
    assert delivery.schedule(repositories, destination, "issue_created", message, seed="s")
    return destination, queue.jobs[-1]


def test_an_attempt_posts_the_body_to_the_opened_url(repositories: Any, workspace: str, queue: Queue) -> None:
    """The URL is opened only for the request, and the delivery and destination record the result."""
    destination, job = _scheduled(repositories, queue)
    fake = FakeSender()

    assert delivery.run_attempt(repositories, job, sender=fake) == "delivered"
    assert delivery.run_attempt(repositories, job, sender=fake) == "duplicate"

    assert len(fake.sent) == 1
    url, body, headers = fake.sent[0]
    assert url == SLACK_URL and headers["Content-Type"] == "application/json"
    assert "blocks" in json.loads(body)
    assert SLACK_URL not in json.dumps(job)
    refreshed = repositories.github.channels.get(WORKSPACE, destination.channel_id)
    assert refreshed is not None and refreshed.last_status == 200


def test_a_transient_failure_is_retried_with_backoff(repositories: Any, workspace: str, queue: Queue) -> None:
    """A 500 or a 429 queues the next attempt with the webhooks' delay, and the destination stays on."""
    destination, job = _scheduled(repositories, queue)

    assert delivery.run_attempt(repositories, job, sender=FakeSender(WebhookResponse(status_code=429))) == "retrying"

    assert queue.jobs[-1]["attempt"] == 2 and queue.delays[-1] == 60
    refreshed = repositories.github.channels.get(WORKSPACE, destination.channel_id)
    assert refreshed is not None and refreshed.enabled


def test_a_gone_webhook_disables_the_channel_and_tells_the_team_admins_once(
    repositories: Any, workspace: str, queue: Queue
) -> None:
    """A 410 turns the destination off with a reason and writes one inbox notice per admin."""
    destination, job = _scheduled(repositories, queue)
    second = delivery.schedule(
        repositories,
        destination,
        "issue_created",
        ChannelMessage(event="issue_created", subject="Again", url="", summary="Again"),
        seed="t",
    )
    assert second

    gone = FakeSender(WebhookResponse(status_code=410))
    assert dispatch.handle_record(repositories, sqs_record(job)) is None
    assert delivery.run_attempt(repositories, queue.jobs[-1], sender=gone) in ("disabled", "skipped")

    refreshed = repositories.github.channels.get(WORKSPACE, destination.channel_id)
    assert refreshed is not None and refreshed.enabled is False
    assert refreshed.disabled_reason and "410" in refreshed.disabled_reason
    for user_id in (OWNER, ADMIN):
        rows = repositories.inbox.list(WORKSPACE, user_id).items
        notices = [row for row in rows if row["kind"] == "channel_disabled"]
        assert len(notices) == 1
        assert notices[0]["issue_key"] == "ABC" and "#eng" in notices[0]["issue_title"]
    assert [row for row in repositories.inbox.list(WORKSPACE, MEMBER).items if row["kind"] == "channel_disabled"] == []


def test_a_404_disables_through_the_dispatch_consumer(
    repositories: Any, workspace: str, queue: Queue, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The dispatch consumer routes the channel job kind to the attempt handler."""
    destination, job = _scheduled(repositories, queue)
    monkeypatch.setattr(delivery, "PinnedHttpsSender", lambda *a, **k: FakeSender(WebhookResponse(status_code=404)))

    dispatch.handle_record(repositories, sqs_record(job))

    refreshed = repositories.github.channels.get(WORKSPACE, destination.channel_id)
    assert refreshed is not None and refreshed.enabled is False and refreshed.last_status == 404


def test_a_disabled_channel_skips_its_queued_attempts(repositories: Any, workspace: str, queue: Queue) -> None:
    """An attempt queued before the channel was turned off ends without a request."""
    destination, job = _scheduled(repositories, queue)
    repositories.github.channels.update(WORKSPACE, destination.channel_id, enabled=False)
    fake = FakeSender()

    assert delivery.run_attempt(repositories, job, sender=fake) == "skipped"
    assert fake.sent == []


def test_routes_never_return_the_url(client: TestClient, workspace: str, repositories: Any) -> None:
    """Create and list answer with the masked tail, and the stored row holds only ciphertext."""
    sign_in(client, ADMIN)

    payload = {"url": SLACK_URL, "label": " #eng ", "events": ["issue_completed", "issue_created"]}
    created = client.post(PATH, json=payload)
    listed = client.get(PATH)

    assert created.status_code == 201, created.text
    body = created.json()
    assert body["url_hint"] == "hooks.slack.com/…1234"
    assert body["provider"] == "slack" and body["label"] == "#eng"
    assert body["events"] == ["issue_created", "issue_completed"]
    assert SLACK_URL not in created.text and SLACK_URL not in listed.text
    assert "abcdEFGH" not in listed.text
    assert [row["channel_id"] for row in listed.json()] == [body["channel_id"]]


def test_an_off_list_url_is_a_422(client: TestClient, workspace: str) -> None:
    """A URL that is not a Slack or Discord webhook is refused with the unsafe URL code."""
    sign_in(client, ADMIN)

    response = client.post(PATH, json={"url": "https://evil.test/hook", "events": ["issue_created"]})

    assert response.status_code == 422
    assert "UNSAFE_URL" in response.text


def test_an_empty_or_unknown_event_filter_is_a_422(client: TestClient, workspace: str) -> None:
    """The filter must name at least one known event."""
    sign_in(client, ADMIN)

    assert client.post(PATH, json={"url": SLACK_URL, "events": []}).status_code == 422
    assert client.post(PATH, json={"url": SLACK_URL, "events": ["issue_deleted"]}).status_code == 422


@pytest.mark.parametrize("caller", [MEMBER, GUEST])
def test_only_team_admins_manage_channels(client: TestClient, workspace: str, caller: str) -> None:
    """A member or guest who does not administer the team is refused."""
    sign_in(client, caller)

    assert client.get(PATH).status_code in (403, 404)
    assert client.post(PATH, json={"url": SLACK_URL, "events": ["issue_created"]}).status_code in (403, 404)


def test_reenabling_clears_the_auto_disable_and_a_new_url_reseals(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    """Turning a disabled channel back on drops the notice; a replaced URL changes provider and hint."""
    sign_in(client, ADMIN)
    created = client.post(PATH, json={"url": SLACK_URL, "events": ["issue_created"]}).json()
    channel_id = created["channel_id"]
    repositories.github.channels.disable(WORKSPACE, channel_id, reason="gone", status=410)

    enabled = client.patch(f"{PATH}/{channel_id}", json={"enabled": True})
    moved = client.patch(f"{PATH}/{channel_id}", json={"url": DISCORD_URL})

    assert enabled.status_code == 200 and enabled.json()["enabled"] is True
    assert enabled.json()["disabled_reason"] is None
    assert moved.json()["provider"] == "discord" and moved.json()["url_hint"] == "discord.com/…WXYZ"
    stored = repositories.github.channels.get(WORKSPACE, channel_id)
    assert stored is not None and urls.open_url(stored) == DISCORD_URL


def test_the_test_button_posts_now_and_reports_without_disabling(
    client: TestClient, workspace: str, repositories: Any, sender: FakeSender
) -> None:
    """A test message lands with the team's name; a 404 answer is reported, not acted on."""
    sign_in(client, ADMIN)
    channel_id = client.post(PATH, json={"url": DISCORD_URL, "events": ["issue_created"]}).json()["channel_id"]

    ok = client.post(f"{PATH}/{channel_id}/test")
    sender.responses = [WebhookResponse(status_code=404)]
    gone = client.post(f"{PATH}/{channel_id}/test")

    assert ok.status_code == 200 and ok.json() == {"delivered": True, "status_code": 200, "error": None}
    assert gone.json() == {"delivered": False, "status_code": 404, "error": "HTTP 404"}
    assert sender.sent[0][0] == DISCORD_URL
    assert "Abc" in json.loads(sender.sent[0][1])["embeds"][0]["title"]
    stored = repositories.github.channels.get(WORKSPACE, channel_id)
    assert stored is not None and stored.enabled is True and stored.last_status == 404


def test_deleting_a_channel_removes_it(client: TestClient, workspace: str, repositories: Any) -> None:
    """A deleted channel is gone, and a second delete or a foreign team's path is a 404."""
    sign_in(client, ADMIN)
    channel_id = client.post(PATH, json={"url": SLACK_URL, "events": ["issue_created"]}).json()["channel_id"]
    other = f"/api/workspaces/{WORKSPACE}/teams/{OTHER_TEAM}/webhooks/channels/{channel_id}"

    assert client.delete(other).status_code == 404
    assert client.delete(f"{PATH}/{channel_id}").status_code == 204
    assert client.delete(f"{PATH}/{channel_id}").status_code == 404
    assert repositories.github.channels.get(WORKSPACE, channel_id) is None


def test_a_team_has_a_generous_channel_ceiling(
    client: TestClient, workspace: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Past the ceiling a create is refused with a code the form can show."""
    from app.domains.integrations.channels import manage

    monkeypatch.setattr(manage, "MAX_CHANNELS_PER_TEAM", 1)
    sign_in(client, ADMIN)

    assert client.post(PATH, json={"url": SLACK_URL, "events": ["issue_created"]}).status_code == 201
    refused = client.post(PATH, json={"url": SLACK_URL, "events": ["issue_created"]})
    assert refused.status_code == 422 and "LIMIT_REACHED" in refused.text


def test_the_team_purge_removes_its_channels(repositories: Any, workspace: str, github_env: None) -> None:
    """A purged team leaves no destination behind."""
    make_channel(repositories)
    make_channel(repositories, team_id=OTHER_TEAM)

    removed = repositories.github.channels.delete_team(WORKSPACE, TEAM)

    assert removed == 1
    assert [row.team_id for row in repositories.github.channels.list(WORKSPACE)] == [OTHER_TEAM]


def test_a_missing_key_refuses_to_seal(monkeypatch: pytest.MonkeyPatch) -> None:
    """Without a master key a URL is not stored at all rather than stored weakly."""
    from app.common.core import config

    monkeypatch.setattr(type(config.settings), "WEBHOOK_SIGNING_KEY", property(lambda self: ""))

    with pytest.raises(urls.ChannelKeyMissing):
        urls.sealed_fields(WORKSPACE, "c", SLACK_URL)


def test_delivery_rows_expire(repositories: Any, workspace: str, queue: Queue) -> None:
    """Every delivery row carries a TTL, so the log does not grow forever."""
    _, job = _scheduled(repositories, queue)
    row = repositories.github.channels.get_delivery(WORKSPACE, job["channel_id"], job["delivery_id"])

    assert row is not None and row.expires_at > int(utc_now().timestamp())


def app_channel(
    repositories: Any,
    *,
    scope: ChannelScope = "workspace",
    team_id: str = "",
    team_ids: list[str] | None = None,
    slack_channel_id: str = "C0ENG",
    events_: list[str] | None = None,
) -> ChannelDestination:
    """Store one destination that posts through the Slack App, team or workspace scoped."""
    channel_id = new_channel_id()
    destination = ChannelDestination(
        workspace_id=WORKSPACE,
        github_key=channel_key(channel_id),
        channel_id=channel_id,
        team_id=team_id,
        scope=scope,
        team_ids=team_ids or [],
        provider="slack",
        label="eng",
        events=events_ if events_ is not None else ["issue_created"],
        enabled=True,
        created_by=OWNER,
        transport="slack_app",
        slack_channel_id=slack_channel_id,
        slack_team_id="T0SLACK01",
        url_hint=f"#{slack_channel_id}",
    )
    return repositories.github.channels.create(destination)


def test_a_workspace_channel_follows_every_open_team_or_the_ones_it_names(
    repositories: Any, workspace: str, queue: Queue
) -> None:
    """An all teams channel gets every team's issue; a filtered one only its teams'."""
    everywhere = app_channel(repositories, slack_channel_id="C0ALL")
    filtered = app_channel(repositories, slack_channel_id="C0XYZ", team_ids=[OTHER_TEAM])

    stream.handle_record(repositories, record("INSERT", issue_image(repositories)))
    assert {job["channel_id"] for job in queue.jobs} == {everywhere.channel_id}

    other = issue_image(repositories, team_id=OTHER_TEAM, issue_id="01JB0000000000000000000IS2", key="XYZ-1")
    stream.handle_record(repositories, record("INSERT", other, event_id="evt-2"))
    assert sorted(job["channel_id"] for job in queue.jobs) == sorted(
        [everywhere.channel_id, everywhere.channel_id, filtered.channel_id]
    )


def test_an_all_teams_channel_skips_a_private_team_unless_it_is_named(
    repositories: Any, workspace: str, queue: Queue
) -> None:
    """Making a team private keeps it out of every all teams channel; naming it, by a member, lets it in."""
    everywhere = app_channel(repositories, slack_channel_id="C0ALL")
    named = app_channel(repositories, slack_channel_id="C0ABC", team_ids=[TEAM])
    repositories.memberships.set_team_private(WORKSPACE, TEAM, True)
    add_team_member(repositories, WORKSPACE, TEAM, OWNER, "member")

    stream.handle_record(repositories, record("INSERT", issue_image(repositories)))

    assert {job["channel_id"] for job in queue.jobs} == {named.channel_id}
    assert everywhere.channel_id not in {job["channel_id"] for job in queue.jobs}


def test_a_channel_a_team_and_the_workspace_both_follow_posts_once(
    repositories: Any, workspace: str, queue: Queue
) -> None:
    """The team's destination wins, and the workspace one for the same Slack channel is skipped, redelivery too."""
    team_row = app_channel(repositories, scope="team", team_id=TEAM)
    app_channel(repositories)
    image = issue_image(repositories)

    stream.handle_record(repositories, record("INSERT", image))
    stream.handle_record(repositories, record("INSERT", image))

    assert {job["channel_id"] for job in queue.jobs} == {team_row.channel_id}


def test_a_project_update_reaches_a_workspace_channel_once(repositories: Any, workspace: str, queue: Queue) -> None:
    """A project on two teams posts its update once to a workspace channel following both."""
    repositories.planning.create_project(
        Project(
            workspace_id=WORKSPACE,
            planning_key=project_key("P2"),
            project_id="P2",
            team_ids=[TEAM, OTHER_TEAM],
            name="Launch",
            created_by=OWNER,
        )
    )
    channel = app_channel(repositories, events_=["project_update_posted"])
    update = {
        "workspace_id": WORKSPACE,
        "planning_key": project_update_key("P2", "U2"),
        "kind": "project_update",
        "project_id": "P2",
        "update_id": "U2",
        "author_id": OWNER,
        "body": "On track",
        "health": "on_track",
        "created_at": "2026-09-20T12:00:00+00:00",
    }

    stream.handle_record(repositories, record("INSERT", update, table="planning"))

    assert [job["channel_id"] for job in queue.jobs] == [channel.channel_id]


def test_purging_a_team_unfollows_it_from_workspace_channels(
    repositories: Any, workspace: str, github_env: None
) -> None:
    """The purged team leaves every followed list, and a channel left following nothing turns off."""
    shared = app_channel(repositories, team_ids=[TEAM, OTHER_TEAM])
    only = app_channel(repositories, slack_channel_id="C0ABC", team_ids=[TEAM])
    everywhere = app_channel(repositories, slack_channel_id="C0ALL")

    repositories.github.channels.delete_team(WORKSPACE, TEAM)

    kept = repositories.github.channels.get(WORKSPACE, shared.channel_id)
    emptied = repositories.github.channels.get(WORKSPACE, only.channel_id)
    untouched = repositories.github.channels.get(WORKSPACE, everywhere.channel_id)
    assert kept is not None and kept.team_ids == [OTHER_TEAM] and kept.enabled is True
    assert emptied is not None and emptied.team_ids == [] and emptied.enabled is False
    assert untouched is not None and untouched.enabled is True


def initiative(repositories: Any, *, lead: str | None = None, project_teams: tuple[list[str], ...] = ()) -> str:
    """Store one initiative led by `lead`, holding one project per entry of `project_teams`."""
    stored = repositories.planning.create_initiative(
        Initiative(
            workspace_id=WORKSPACE,
            planning_key=initiative_key("I1"),
            initiative_id="I1",
            name="Grow revenue",
            team_id=lead,
            created_by=OWNER,
        )
    )
    for index, team_ids in enumerate(project_teams):
        project_id = f"P{index + 1}"
        repositories.planning.create_project(
            Project(
                workspace_id=WORKSPACE,
                planning_key=project_key(project_id),
                project_id=project_id,
                team_ids=team_ids,
                name=f"Project {index + 1}",
                created_by=OWNER,
                initiative_id=stored.initiative_id,
            )
        )
    return stored.initiative_id


def initiative_update(initiative_id: str = "I1", update_id: str = "U1", **fields: Any) -> dict[str, Any]:
    """One initiative update row as the planning stream image carries it."""
    return {
        "workspace_id": WORKSPACE,
        "planning_key": initiative_update_key(initiative_id, update_id),
        "kind": "initiative_update",
        "initiative_id": initiative_id,
        "update_id": update_id,
        "author_id": OWNER,
        "body": "Ahead of plan",
        "health": "on_track",
        "created_at": "2026-10-20T12:00:00+00:00",
        **fields,
    }


def test_an_initiative_update_reaches_every_team_of_its_projects_and_a_workspace_channel_once(
    repositories: Any, workspace: str, queue: Queue
) -> None:
    """Each project team's channel posts once with the health, a workspace channel once, and a redelivery adds nothing."""
    initiative(repositories, project_teams=([TEAM], [TEAM, OTHER_TEAM]))
    ours = make_channel(repositories, events_=["initiative_update_posted"], url=DISCORD_URL)
    theirs = make_channel(repositories, events_=["initiative_update_posted"], team_id=OTHER_TEAM)
    wide = app_channel(repositories, events_=["initiative_update_posted"])
    make_channel(repositories, events_=["project_update_posted"])

    stream.handle_record(repositories, record("INSERT", initiative_update(), table="planning"))
    stream.handle_record(repositories, record("INSERT", initiative_update(), table="planning"))

    assert sorted({job["channel_id"] for job in queue.jobs}) == sorted(
        [ours.channel_id, theirs.channel_id, wide.channel_id]
    )
    assert len({(job["channel_id"], job["delivery_id"]) for job in queue.jobs}) == 3
    embed = delivery_body(repositories, next(job for job in queue.jobs if job["channel_id"] == ours.channel_id))[
        "embeds"
    ][0]
    assert embed["title"] == "Grow revenue"
    assert embed["fields"] == [{"name": "Health", "value": "On track", "inline": True}]
    assert embed["author"] == {"name": "Olive Owner"}
    assert "I1" in embed["url"] and "U1" in embed["url"]


def test_a_private_lead_team_keeps_its_initiative_update(repositories: Any, workspace: str, queue: Queue) -> None:
    """An initiative led by a private team posts only to that team's channel, never a project team's."""
    initiative(repositories, lead=TEAM, project_teams=([OTHER_TEAM],))
    repositories.memberships.set_team_private(WORKSPACE, TEAM, True)
    add_team_member(repositories, WORKSPACE, TEAM, OWNER, "member")
    ours = make_channel(repositories, events_=["initiative_update_posted"])
    make_channel(repositories, events_=["initiative_update_posted"], team_id=OTHER_TEAM)
    app_channel(repositories, events_=["initiative_update_posted"])

    stream.handle_record(repositories, record("INSERT", initiative_update(), table="planning"))

    assert [job["channel_id"] for job in queue.jobs] == [ours.channel_id]


def test_a_teamless_initiative_update_reaches_only_all_teams_workspace_channels(
    repositories: Any, workspace: str, queue: Queue
) -> None:
    """With no lead team and no project, a workspace channel set to every team posts and a filtered one does not."""
    initiative(repositories)
    wide = app_channel(repositories, events_=["initiative_update_posted"])
    app_channel(repositories, slack_channel_id="C0XYZ", team_ids=[OTHER_TEAM], events_=["initiative_update_posted"])
    make_channel(repositories, events_=["initiative_update_posted"])

    stream.handle_record(repositories, record("INSERT", initiative_update(), table="planning"))
    stream.handle_record(
        repositories, record("MODIFY", initiative_update(body="Edited"), initiative_update(), table="planning")
    )

    assert [job["channel_id"] for job in queue.jobs] == [wide.channel_id]


def test_an_update_of_a_deleted_initiative_posts_nothing(repositories: Any, workspace: str, queue: Queue) -> None:
    """The initiative is read when the update is announced, and a missing one ends it."""
    app_channel(repositories, events_=["initiative_update_posted"])

    stream.handle_record(repositories, record("INSERT", initiative_update("GONE"), table="planning"))

    assert queue.jobs == []


def cycle(repositories: Any, **fields: Any) -> Cycle:
    """Store one cycle of TEAM."""
    values: dict[str, Any] = {
        "workspace_id": WORKSPACE,
        "planning_key": cycle_key(TEAM, "C1"),
        "cycle_id": "C1",
        "team_id": TEAM,
        "name": "Sprint 4",
        "start_date": "2026-10-05",
        "end_date": "2026-10-18",
        "goal": "Ship channels",
        "created_by": OWNER,
        **fields,
    }
    return repositories.planning.create_cycle(Cycle(**values))


def test_a_cycle_completion_posts_its_counts_once(repositories: Any, workspace: str, queue: Queue) -> None:
    """The scope, completed and rolled over counts are fields, and a repeat of the same moment posts nothing more."""
    cycle(repositories)
    channel = make_channel(repositories, events_=["cycle_completed"], url=DISCORD_URL)
    make_channel(repositories, events_=["cycle_started"])
    counts = {"scope": 9, "completed": 6, "rolled_over": 3}

    assert events.announce_cycle(repositories, WORKSPACE, TEAM, "C1", "cycle_completed", "2026-10-18", counts) == 1
    events.announce_cycle(repositories, WORKSPACE, TEAM, "C1", "cycle_completed", "2026-10-18", {"scope": 1})

    assert {job["channel_id"] for job in queue.jobs} == {channel.channel_id}
    assert len({job["delivery_id"] for job in queue.jobs}) == 1
    embed = delivery_body(repositories, queue.jobs[0])["embeds"][0]
    assert embed["title"].endswith("Sprint 4")
    assert embed["color"] == EVENT_COLORS["cycle_completed"]
    assert embed["fields"] == [
        {"name": "Scope", "value": "9", "inline": True},
        {"name": "Completed", "value": "6", "inline": True},
        {"name": "Rolled over", "value": "3", "inline": True},
    ]


def test_a_cycle_start_posts_its_dates_and_goal_to_slack(repositories: Any, workspace: str, queue: Queue) -> None:
    """The Slack body names the cycle and carries the dates and the goal."""
    cycle(repositories)
    make_channel(repositories, events_=["cycle_started"])

    assert events.announce_cycle(repositories, WORKSPACE, TEAM, "C1", "cycle_started", "2026-10-05") == 1

    text = json.dumps(delivery_body(repositories, queue.jobs[0]))
    assert "Sprint 4" in text and "2026-10-05 to 2026-10-18" in text and "Ship channels" in text


@pytest.mark.parametrize(
    ("event", "day", "fields"),
    [
        ("cycle_started", "2026-10-04", {}),
        ("cycle_completed", "2026-10-17", {}),
        ("cycle_started", "2026-10-05", {"cancelled": True}),
        ("cycle_finished", "2026-10-18", {}),
    ],
)
def test_a_cycle_whose_moment_does_not_match_posts_nothing(
    repositories: Any, workspace: str, queue: Queue, event: str, day: str, fields: dict[str, Any]
) -> None:
    """A date that is not the cycle's own, a cancelled cycle, or an unknown event posts nothing."""
    cycle(repositories, **fields)
    make_channel(repositories, events_=["cycle_started", "cycle_completed"])

    assert events.announce_cycle(repositories, WORKSPACE, TEAM, "C1", event, day) == 0
    assert queue.jobs == []


def test_the_dispatch_consumer_posts_a_queued_cycle_completion_once(
    repositories: Any, workspace: str, queue: Queue
) -> None:
    """The cycle close's queued job posts once however often it arrives, and a malformed one is dropped."""
    cycle(repositories)
    make_channel(repositories, events_=["cycle_completed"], url=DISCORD_URL)
    job = {
        "kind": "channel.cycle",
        "event": "cycle_completed",
        "workspace_id": WORKSPACE,
        "team_id": TEAM,
        "cycle_id": "C1",
        "date": "2026-10-18",
        "scope": 4,
        "completed": 3,
        "rolled_over": 1,
    }

    dispatch.handle_record(repositories, sqs_record(job))
    dispatch.handle_record(repositories, sqs_record(job))
    dispatch.handle_record(repositories, sqs_record({**job, "date": "not a date"}))
    dispatch.handle_record(repositories, sqs_record({**job, "cycle_id": ""}))

    assert len({queued["delivery_id"] for queued in queue.jobs}) == 1
    fields = delivery_body(repositories, queue.jobs[0])["embeds"][0]["fields"]
    assert [field["value"] for field in fields] == ["4", "3", "1"]


def test_the_new_events_are_selectable_and_coloured() -> None:
    """The three events are in the filter list and carry their own colours."""
    from app.common.db.dynamo.channels import CHANNEL_EVENTS

    for event in ("initiative_update_posted", "cycle_started", "cycle_completed"):
        assert event in CHANNEL_EVENTS
        assert event in EVENT_COLORS
