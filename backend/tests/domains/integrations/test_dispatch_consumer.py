"""The dispatch consumer: write-back to GitHub and outbound signed webhooks.

Every GitHub call is patched at the `github_api` boundary, so no test here opens a
socket and a test that started making a real call would fail on the missing patch
rather than reaching api.github.com.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from typing import Any

import pytest

from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.github import IssueLink, WebhookEndpoint, link_key, new_webhook_id, webhook_key
from app.domains.integrations.consumers import dispatch
from tests.domains.integrations.conftest import (
    OWNER,
    REPOSITORY_FULL_NAME,
    WORKSPACE,
    sqs_record,
)


class FakeGithub:
    """Records what would have been sent to GitHub, and answers with fixed ids."""

    def __init__(self) -> None:
        """Start with nothing recorded."""
        self.tokens: list[str] = []
        self.comments: list[tuple[str, int, str]] = []
        self.updates: list[tuple[str, str, str]] = []
        self.check_runs: list[tuple[str, str]] = []

    def installation_token(self, installation_id: str, **kwargs: Any) -> str:
        """Hand back a placeholder token without minting a real one."""
        self.tokens.append(installation_id)
        return "ghs_test_token"

    def create_comment(self, token: str, full_name: str, number: int, body: str, **kwargs: Any) -> str:
        """Record a posted comment."""
        self.comments.append((full_name, number, body))
        return "comment-1"

    def update_comment(self, token: str, full_name: str, comment_id: str, body: str, **kwargs: Any) -> None:
        """Record an edited comment."""
        self.updates.append((full_name, comment_id, body))

    def create_check_run(self, token: str, full_name: str, head_sha: str, **kwargs: Any) -> str:
        """Record a set check run."""
        self.check_runs.append((full_name, head_sha))
        return "check-1"


@pytest.fixture
def github(monkeypatch: pytest.MonkeyPatch) -> FakeGithub:
    """Patch every outbound GitHub call the dispatcher makes."""
    fake = FakeGithub()
    for name in ("installation_token", "create_comment", "update_comment", "create_check_run"):
        monkeypatch.setattr(dispatch.github_api, name, getattr(fake, name))
    return fake


def writeback_job(link_ids: list[str], *, keys: list[str] | None = None) -> dict[str, Any]:
    """One write-back job, as the events consumer enqueues it."""
    return {
        "kind": "github.writeback",
        "workspace_id": WORKSPACE,
        "repository_full_name": REPOSITORY_FULL_NAME,
        "pr_number": 7,
        "pr_node_id": "PR_node",
        "head_sha": "deadbeef",
        "keys": keys or ["ABC-1"],
        "link_ids": link_ids,
    }


def put_link(repositories: Any, issue_id: str, *, comment_id: str | None, check_run_id: str | None) -> str:
    """Store one link row in the state a previous write-back would have left."""
    link_id = f"PR_node#{issue_id}"
    repositories.github.put_link(
        IssueLink(
            workspace_id=WORKSPACE,
            github_key=link_key(link_id),
            ws_issue=f"{WORKSPACE}#{issue_id}",
            link_id=link_id,
            issue_id=issue_id,
            issue_key="ABC-1",
            repository_full_name=REPOSITORY_FULL_NAME,
            pr_number=7,
            comment_id=comment_id,
            check_run_id=check_run_id,
            linked_at=utc_now(),
            updated_at=utc_now(),
        )
    )
    return link_id


def test_a_write_back_comments_and_sets_the_check_run(
    repositories: Any,
    installed: str,
    issue: Any,
    github: FakeGithub,
    github_env: None,
) -> None:
    """A fresh link gets one comment listing the issues and one check run."""
    link_id = put_link(repositories, issue.issue_id, comment_id=None, check_run_id=None)

    dispatch.handle_record(repositories, sqs_record(writeback_job([link_id])))

    assert len(github.comments) == 1
    assert "ABC-1" in github.comments[0][2]
    assert github.check_runs == [(REPOSITORY_FULL_NAME, "deadbeef")]


def test_the_write_back_marks_the_link_with_what_it_posted(
    repositories: Any,
    installed: str,
    issue: Any,
    github: FakeGithub,
    github_env: None,
) -> None:
    """The ids are written back to the link, which is what makes the next run skip."""
    link_id = put_link(repositories, issue.issue_id, comment_id=None, check_run_id=None)

    dispatch.handle_record(repositories, sqs_record(writeback_job([link_id])))

    link = repositories.github.get_link(WORKSPACE, link_id)
    assert link is not None
    assert link.comment_id == "comment-1"
    assert link.check_run_id == "check-1"


def test_a_write_back_already_current_is_skipped(
    repositories: Any,
    installed: str,
    issue: Any,
    github: FakeGithub,
    github_env: None,
) -> None:
    """A link already carrying both ids does nothing, so a redelivery posts nothing.

    This is what stops GitHub's at-least-once delivery leaving a pull request with
    the same comment on it several times.
    """
    link_id = put_link(repositories, issue.issue_id, comment_id="comment-1", check_run_id="check-1")

    dispatch.handle_record(repositories, sqs_record(writeback_job([link_id])))

    assert github.comments == []
    assert github.updates == []
    assert github.check_runs == []
    assert github.tokens == []


def test_a_second_delivery_edits_the_comment_rather_than_posting_another(
    repositories: Any,
    installed: str,
    issue: Any,
    github: FakeGithub,
    github_env: None,
) -> None:
    """A link with a comment but no check run edits the comment it already posted."""
    link_id = put_link(repositories, issue.issue_id, comment_id="comment-1", check_run_id=None)

    dispatch.handle_record(repositories, sqs_record(writeback_job([link_id])))

    assert github.comments == []
    assert len(github.updates) == 1
    assert github.updates[0][1] == "comment-1"


def test_a_write_back_for_a_workspace_with_no_installation_does_nothing(
    repositories: Any,
    workspace: str,
    issue: Any,
    github: FakeGithub,
    github_env: None,
) -> None:
    """No installation means no token to mint, so the job stops before calling out."""
    link_id = put_link(repositories, issue.issue_id, comment_id=None, check_run_id=None)

    dispatch.handle_record(repositories, sqs_record(writeback_job([link_id])))

    assert github.tokens == []


def make_endpoint(repositories: Any, url: str, events: list[str], *, active: bool = True) -> WebhookEndpoint:
    """Store one outbound endpoint subscribed to `events`."""
    webhook_id = new_webhook_id()
    return repositories.github.create_endpoint(
        WebhookEndpoint(
            workspace_id=WORKSPACE,
            github_key=webhook_key(webhook_id),
            webhook_id=webhook_id,
            url=url,
            events=events,
            active=active,
            created_by=OWNER,
            created_at=utc_now(),
            updated_at=utc_now(),
        )
    )


class FakeSender:
    """A webhook sender that records the request instead of making it."""

    def __init__(self, status_code: int = 200) -> None:
        """Start with nothing sent, answering `status_code` to everything."""
        self.sent: list[tuple[str, bytes, dict[str, str]]] = []
        self.status_code = status_code

    def post(self, url: str, *, body: bytes, headers: Any, timeout: float) -> Any:
        """Record one delivery and answer with the configured status."""
        from webbpulse.events.webhooks import WebhookResponse

        self.sent.append((url, body, dict(headers)))
        return WebhookResponse(status_code=self.status_code, body="")


@pytest.fixture
def sender(monkeypatch: pytest.MonkeyPatch) -> FakeSender:
    """Replace the outbound HTTP sender, so no webhook leaves the test."""
    fake = FakeSender()
    monkeypatch.setattr(dispatch, "UrllibWebhookSender", lambda *args, **kwargs: fake)
    return fake


def deliver_job(event: str = "issue.created") -> dict[str, Any]:
    """One outbound webhook job."""
    return {
        "kind": "webhook.deliver",
        "workspace_id": WORKSPACE,
        "event": event,
        "payload": {"issue_id": "01JB0000000000000000000IS1", "key": "ABC-1"},
    }


def test_an_outbound_event_reaches_a_subscribed_endpoint(
    repositories: Any,
    workspace: str,
    sender: FakeSender,
    github_env: None,
) -> None:
    """An endpoint subscribed to the event receives the envelope."""
    endpoint = make_endpoint(repositories, "https://example.test/hook", ["issue.created"])

    dispatch.handle_record(repositories, sqs_record(deliver_job()))

    assert len(sender.sent) == 1
    assert sender.sent[0][0] == endpoint.url
    assert json.loads(sender.sent[0][1])["event"] == "issue.created"


def test_an_endpoint_not_subscribed_to_the_event_is_skipped(
    repositories: Any,
    workspace: str,
    sender: FakeSender,
    github_env: None,
) -> None:
    """Subscription is per event, so an endpoint only hears what it asked for."""
    make_endpoint(repositories, "https://example.test/hook", ["comment.created"])

    dispatch.handle_record(repositories, sqs_record(deliver_job("issue.created")))

    assert sender.sent == []


def test_an_inactive_endpoint_is_skipped(
    repositories: Any,
    workspace: str,
    sender: FakeSender,
    github_env: None,
) -> None:
    """Deactivating an endpoint stops deliveries without deleting its history."""
    make_endpoint(repositories, "https://example.test/hook", ["issue.created"], active=False)

    dispatch.handle_record(repositories, sqs_record(deliver_job()))

    assert sender.sent == []


def test_each_endpoint_is_signed_with_its_own_derived_key(
    repositories: Any,
    workspace: str,
    sender: FakeSender,
    github_env: None,
) -> None:
    """Two endpoints in one workspace get different signatures over the same body.

    Deriving per endpoint is what stops one receiver verifying, or forging, a
    payload meant for another endpoint of the same workspace.
    """
    make_endpoint(repositories, "https://one.test/hook", ["issue.created"])
    make_endpoint(repositories, "https://two.test/hook", ["issue.created"])

    dispatch.handle_record(repositories, sqs_record(deliver_job()))

    assert len(sender.sent) == 2
    signatures = {headers.get("X-Webhook-Signature") for _url, _body, headers in sender.sent}
    assert len(signatures) == 2


def test_the_signature_verifies_against_the_endpoints_derived_key(
    repositories: Any,
    workspace: str,
    sender: FakeSender,
    github_env: None,
) -> None:
    """A receiver holding the endpoint's key can verify what arrived.

    Recomputed here the way `webbpulse.events.webhooks` documents it, over the
    timestamp and the body together, so a change to either side fails this.
    """
    from app.domains.integrations.service import signing_key

    endpoint = make_endpoint(repositories, "https://example.test/hook", ["issue.created"])

    dispatch.handle_record(repositories, sqs_record(deliver_job()))

    _url, body, headers = sender.sent[0]
    timestamp = headers["X-Webhook-Timestamp"]
    message = f"{timestamp}.".encode() + body
    expected = hmac.new(signing_key(endpoint.webhook_id), message, hashlib.sha256).hexdigest()

    assert headers["X-Webhook-Signature"] == f"sha256={expected}"


def test_a_refused_delivery_raises_so_the_queue_retries(
    repositories: Any,
    workspace: str,
    monkeypatch: pytest.MonkeyPatch,
    github_env: None,
) -> None:
    """A non-2xx answer fails the record, which is what hands the retry to SQS."""
    fake = FakeSender(status_code=500)
    monkeypatch.setattr(dispatch, "UrllibWebhookSender", lambda *args, **kwargs: fake)
    make_endpoint(repositories, "https://example.test/hook", ["issue.created"])

    with pytest.raises(RuntimeError):
        dispatch.handle_record(repositories, sqs_record(deliver_job()))


def test_a_delivery_records_the_last_status_on_the_endpoint(
    repositories: Any,
    workspace: str,
    sender: FakeSender,
    github_env: None,
) -> None:
    """The endpoint row carries what happened, so an admin can see a broken receiver."""
    endpoint = make_endpoint(repositories, "https://example.test/hook", ["issue.created"])

    dispatch.handle_record(repositories, sqs_record(deliver_job()))

    stored = repositories.github.get_endpoint(WORKSPACE, endpoint.webhook_id)
    assert stored is not None
    assert stored.last_status == 200
