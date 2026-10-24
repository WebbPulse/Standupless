"""Personal notifications held for a linked chat account and flushed as one dispatch job.

The views image never reaches Slack, so these tests stop at the job the flush
queues: `queue_chat_digest` is patched to record each batch it would send to the
dispatch queue.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common.chat_digests import CHAT_DIGEST_JOB, CHAT_KINDS, ChatDigest, queue_chat_digest
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.chat_routes import ChatRoute
from app.common.db.dynamo.notify_digests import CHAT_DIGEST_WINDOW, DIGEST_WINDOW
from app.domains.views.consumers import chat_digest as chat_module
from app.domains.views.consumers.chat_digest import flush_due_chats
from app.domains.views.consumers.notify import handle_record
from tests.domains.helpers import MEMBER, OWNER, sign_in
from tests.domains.views.conftest import seed_issue
from tests.domains.views.test_notify_consumer import inbox_of
from tests.domains.views.test_notify_email import assignment


@pytest.fixture
def queued(monkeypatch: pytest.MonkeyPatch) -> list[ChatDigest]:
    """Every chat batch the flush would queue, in order."""
    sent: list[ChatDigest] = []

    def record(digest: ChatDigest, **_: Any) -> bool:
        """Keep one batch instead of enqueueing it."""
        sent.append(digest)
        return True

    monkeypatch.setattr(chat_module, "queue_chat_digest", record)
    return sent


def _link(repositories: Any, workspace: str, user_id: str = MEMBER, **fields: Any) -> ChatRoute:
    """Store one member's Slack route, as linking in settings does."""
    values: dict[str, Any] = {
        "workspace_id": workspace,
        "user_id": user_id,
        "provider": "slack",
        "external_user_id": "UMEMBER",
        "external_team_id": "T0SLACK01",
        "linked_at": utc_now(),
    }
    values.update(fields)
    return repositories.inbox.chat_routes.put(ChatRoute(**values))


def _flush(repositories: Any) -> int:
    """Flush every held chat window as if they had all closed."""
    return flush_due_chats(repositories, now=datetime.now(timezone.utc) + timedelta(hours=1))


def test_the_chat_window_is_shorter_than_the_email_window() -> None:
    """Chat batches a burst briefly, then sends, well before the email digest would."""
    assert CHAT_DIGEST_WINDOW < DIGEST_WINDOW


def test_a_linked_member_gets_one_batch_with_the_issue_and_the_line(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any, queued: list[ChatDigest]
) -> None:
    """An assignment reaches the inbox at once and the linked member's chat once the window closes."""
    _link(repositories, workspace)
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Ship chat", assignee_id=MEMBER)

    handle_record(repositories, assignment(workspace, issue["id"]))

    assert len(inbox_of(repositories, workspace, MEMBER)) == 1
    assert queued == []
    assert _flush(repositories) == 1
    [digest] = queued
    assert (digest.workspace_id, digest.recipient_id) == (workspace, MEMBER)
    [group] = digest.groups
    assert issue["key"] in group.label
    assert group.url.endswith(f"/issues/{issue['key']}")
    assert len(group.lines) == 1
    assert digest.inbox_url

    assert _flush(repositories) == 0


def test_nothing_is_held_without_a_working_link(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any, queued: list[ChatDigest]
) -> None:
    """No route, or a broken one, holds nothing for chat while the inbox row is still written."""
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Quiet", assignee_id=MEMBER)
    handle_record(repositories, assignment(workspace, issue["id"]))

    _link(repositories, workspace, broken_at=utc_now(), broken_reason="messages_tab_disabled")
    other = seed_issue(issues_client, workspace, title="Still quiet", assignee_id=MEMBER)
    handle_record(repositories, assignment(workspace, other["id"]))

    assert len(inbox_of(repositories, workspace, MEMBER)) == 2
    assert _flush(repositories) == 0
    assert queued == []


def test_the_chat_switch_turns_one_kind_off(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any, queued: list[ChatDigest]
) -> None:
    """A kind with chat off stays in the inbox and email but is not sent to chat."""
    _link(repositories, workspace)
    repositories.users.update(
        MEMBER, notification_preferences={"assigned": {"in_app": True, "email": True, "chat": False}}
    )
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Muted", assignee_id=MEMBER)

    handle_record(repositories, assignment(workspace, issue["id"]))

    assert len(inbox_of(repositories, workspace, MEMBER)) == 1
    assert _flush(repositories) == 0


def test_chat_alone_still_sends_with_the_inbox_and_email_off(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any, queued: list[ChatDigest]
) -> None:
    """Chat is its own channel: a member who only wants chat for a kind still gets it there."""
    _link(repositories, workspace)
    repositories.users.update(MEMBER, notification_preferences={"assigned": {"in_app": False, "email": False}})
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Chat only", assignee_id=MEMBER)

    handle_record(repositories, assignment(workspace, issue["id"]))

    assert _flush(repositories) == 1


def test_unlinking_during_the_window_sends_nothing(
    issues_client: TestClient, workspace: str, repositories: Any, statuses: Any, queued: list[ChatDigest]
) -> None:
    """The flush checks the route again, so an unlink before the window closes drops the batch."""
    _link(repositories, workspace)
    sign_in(issues_client, OWNER)
    issue = seed_issue(issues_client, workspace, title="Gone", assignee_id=MEMBER)
    handle_record(repositories, assignment(workspace, issue["id"]))

    repositories.inbox.chat_routes.delete(workspace, MEMBER, "slack")

    assert _flush(repositories) == 0
    assert queued == []


def test_the_standup_digest_and_review_requests_stay_out_of_chat() -> None:
    """Those two kinds are in app or email only."""
    assert "standup_digest" not in CHAT_KINDS
    assert "review_requested" not in CHAT_KINDS
    assert "assigned" in CHAT_KINDS


def test_a_batch_is_queued_on_the_dispatch_queue_as_a_chat_job(monkeypatch: pytest.MonkeyPatch) -> None:
    """The job carries its kind and the whole batch, scoped to the workspace."""
    from app.common.core.config import settings

    monkeypatch.setattr(settings, "WEBHOOK_DISPATCH_QUEUE_URL", "https://sqs.test/dispatch")
    sent: list[tuple[str, Any]] = []
    digest = ChatDigest(workspace_id="W1", recipient_id=MEMBER, window=60)

    assert queue_chat_digest(digest, send=lambda url, envelope: sent.append((url, envelope))) is True
    [(url, envelope)] = sent
    assert url == "https://sqs.test/dispatch"
    assert envelope.payload["kind"] == CHAT_DIGEST_JOB
    assert envelope.payload["recipient_id"] == MEMBER

    monkeypatch.setattr(settings, "WEBHOOK_DISPATCH_QUEUE_URL", "")
    assert queue_chat_digest(digest, send=lambda *_: None) is False


def test_a_purge_forgets_the_chat_routes(workspace: str, repositories: Any) -> None:
    """Deleting a member's inbox also deletes which chat account they linked."""
    _link(repositories, workspace)
    repositories.inbox.delete_all(workspace, MEMBER)
    assert repositories.inbox.chat_routes.list(workspace, MEMBER) == []
