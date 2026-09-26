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
from webbpulse.integrations.github import CheckRun, CheckRunOutput, GitHubError, IssueComment

from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.github import IssueLink, WebhookEndpoint, link_key, new_webhook_id, webhook_key
from app.domains.integrations.consumers import dispatch
from tests.domains.integrations.conftest import (
    INSTALLATION_ID,
    OWNER,
    REPOSITORY_FULL_NAME,
    WORKSPACE,
    sqs_record,
)


class FakeGithub:
    """Records what would have been sent to GitHub, and answers with fixed ids.

    Stands in for the shared `GitHubAppClient`, so `clients` counts how many were
    opened: a job with nothing to write must not open one, because opening one is
    what exchanges the App JWT for an installation token.
    """

    def __init__(self) -> None:
        """Start with nothing recorded."""
        self.clients = 0
        self.installations: list[str] = []
        self.comments: list[tuple[str, int, str]] = []
        self.updates: list[tuple[str, str, str]] = []
        self.check_runs: list[tuple[str, str]] = []
        self.summaries: list[str] = []

    def open(self) -> FakeGithub:
        """Count one client opened for a unit of work."""
        self.clients += 1
        return self

    def __enter__(self) -> FakeGithub:
        """Enter the unit of work."""
        return self

    def __exit__(self, *exc: object) -> None:
        """Leave the unit of work; there is nothing to close."""

    def create_issue_comment(
        self, repository: str, issue_number: int, body: str, *, installation_id: str | None = None
    ) -> IssueComment:
        """Record a posted comment."""
        self.installations.append(str(installation_id))
        self.comments.append((repository, issue_number, body))
        return IssueComment(id=501, html_url="https://github.test/comment/501")

    def update_issue_comment(
        self, repository: str, comment_id: str, body: str, *, installation_id: str | None = None
    ) -> IssueComment:
        """Record an edited comment."""
        self.installations.append(str(installation_id))
        self.updates.append((repository, comment_id, body))
        return IssueComment(id=int(comment_id) if comment_id.isdigit() else 1, html_url="")

    def create_check_run(
        self,
        repository: str,
        *,
        name: str,
        head_sha: str,
        conclusion: str | None = None,
        output: CheckRunOutput | None = None,
        installation_id: str | None = None,
        **kwargs: Any,
    ) -> CheckRun:
        """Record a set check run."""
        assert name == "Standupless"
        assert conclusion == "success"
        self.installations.append(str(installation_id))
        self.check_runs.append((repository, head_sha))
        self.summaries.append(output.summary if output is not None else "")
        return CheckRun(id=601, status="completed", conclusion=conclusion, html_url="")


@pytest.fixture
def github(monkeypatch: pytest.MonkeyPatch) -> FakeGithub:
    """Hand the dispatcher a fake client wherever it would build a real one."""
    fake = FakeGithub()
    monkeypatch.setattr(dispatch.github_api, "app_client", fake.open)
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


def put_link(
    repositories: Any,
    issue_id: str,
    *,
    comment_id: str | None,
    check_run_id: str | None,
    issue_key: str = "ABC-1",
) -> str:
    """Store one link row in the state a previous write-back would have left."""
    link_id = f"PR_node#{issue_id}"
    repositories.github.put_link(
        IssueLink(
            workspace_id=WORKSPACE,
            github_key=link_key(link_id),
            ws_issue=f"{WORKSPACE}#{issue_id}",
            link_id=link_id,
            issue_id=issue_id,
            issue_key=issue_key,
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
    assert github.installations == [INSTALLATION_ID, INSTALLATION_ID]
    assert github.clients == 1


def test_a_github_error_raises_so_the_queue_retries_and_marks_nothing(
    repositories: Any,
    installed: str,
    issue: Any,
    github: FakeGithub,
    github_env: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A refused comment leaves the link unmarked and the message on the queue."""
    link_id = put_link(repositories, issue.issue_id, comment_id=None, check_run_id=None)

    def refuse(*args: Any, **kwargs: Any) -> IssueComment:
        """Answer the way the shared client does when GitHub is unavailable."""
        raise GitHubError("unavailable", method="POST", path="/comments", status_code=502)

    monkeypatch.setattr(github, "create_issue_comment", refuse)

    with pytest.raises(GitHubError):
        dispatch.handle_record(repositories, sqs_record(writeback_job([link_id])))

    link = repositories.github.get_link(WORKSPACE, link_id)
    assert link is not None
    assert link.comment_id is None
    assert link.check_run_id is None


@pytest.fixture
def frontend(monkeypatch: pytest.MonkeyPatch) -> str:
    """Pin the web app origin the comment links point at."""
    from app.common.core.config import settings

    monkeypatch.setattr(settings, "FRONTEND_URL", "https://app.example.test/", raising=False)
    return "https://app.example.test"


def test_the_comment_links_each_issue_to_its_page_with_its_title(
    repositories: Any,
    installed: str,
    issue: Any,
    github: FakeGithub,
    github_env: None,
    frontend: str,
) -> None:
    """Each key is a link to the issue page under the workspace slug, titled."""
    link_id = put_link(repositories, issue.issue_id, comment_id=None, check_run_id=None)

    dispatch.handle_record(repositories, sqs_record(writeback_job([link_id])))

    body = github.comments[0][2]
    assert body == f"Linked issues:\n\n- [ABC-1]({frontend}/w/acme/issues/ABC-1) An issue"


def test_the_check_run_summary_is_the_comment_body(
    repositories: Any,
    installed: str,
    issue: Any,
    github: FakeGithub,
    github_env: None,
    frontend: str,
) -> None:
    """The check run carries the same linked list the comment does."""
    link_id = put_link(repositories, issue.issue_id, comment_id=None, check_run_id=None)

    dispatch.handle_record(repositories, sqs_record(writeback_job([link_id])))

    assert github.summaries == [github.comments[0][2]]


def test_several_issues_are_listed_in_key_order(
    repositories: Any,
    installed: str,
    issue: Any,
    hidden_issue: Any,
    github: FakeGithub,
    github_env: None,
    frontend: str,
) -> None:
    """One list item per key, sorted, each with its own title."""
    first = put_link(repositories, issue.issue_id, comment_id=None, check_run_id=None)
    second = put_link(repositories, hidden_issue.issue_id, comment_id=None, check_run_id=None, issue_key="XYZ-1")

    dispatch.handle_record(repositories, sqs_record(writeback_job([second, first], keys=["XYZ-1", "ABC-1"])))

    lines = github.comments[0][2].splitlines()
    assert lines[2:] == [
        f"- [ABC-1]({frontend}/w/acme/issues/ABC-1) An issue",
        f"- [XYZ-1]({frontend}/w/acme/issues/XYZ-1) An issue",
    ]


def test_a_key_whose_issue_is_missing_still_links_without_a_title(
    repositories: Any,
    installed: str,
    github: FakeGithub,
    github_env: None,
    frontend: str,
) -> None:
    """An issue that cannot be read leaves its key linked and untitled."""
    link_id = put_link(repositories, "01JB0000000000000000000GON", comment_id=None, check_run_id=None)

    dispatch.handle_record(repositories, sqs_record(writeback_job([link_id])))

    assert github.comments[0][2].splitlines()[2] == f"- [ABC-1]({frontend}/w/acme/issues/ABC-1)"


@pytest.mark.parametrize("table", ["issues", "workspaces"])
def test_a_failed_read_raises_so_the_queue_retries_before_posting(
    repositories: Any,
    installed: str,
    issue: Any,
    github: FakeGithub,
    github_env: None,
    frontend: str,
    monkeypatch: pytest.MonkeyPatch,
    table: str,
) -> None:
    """A read error fails the record, so no untitled comment is posted and then skipped forever."""

    def refuse(*args: Any, **kwargs: Any) -> Any:
        """Fail the way a throttled read would."""
        raise RuntimeError("throttled")

    method = "get_many" if table == "issues" else "get"
    monkeypatch.setattr(getattr(repositories, table), method, refuse)
    link_id = put_link(repositories, issue.issue_id, comment_id=None, check_run_id=None)

    with pytest.raises(RuntimeError):
        dispatch.handle_record(repositories, sqs_record(writeback_job([link_id])))

    assert github.comments == []
    assert github.updates == []
    assert github.check_runs == []
    link = repositories.github.get_link(WORKSPACE, link_id)
    assert link is not None
    assert link.comment_id is None


def test_markdown_in_a_title_cannot_break_the_list(
    repositories: Any,
    installed: str,
    issue: Any,
    github: FakeGithub,
    github_env: None,
    frontend: str,
) -> None:
    """Links, mentions, emphasis and line breaks in a title render as plain text."""
    repositories.issues.replace(issue.model_copy(update={"title": "Fix [x](http://evil) @org/team\n- *bold* `code`"}))
    link_id = put_link(repositories, issue.issue_id, comment_id=None, check_run_id=None)

    dispatch.handle_record(repositories, sqs_record(writeback_job([link_id])))

    lines = github.comments[0][2].splitlines()
    assert len(lines) == 3
    assert lines[2] == (
        f"- [ABC-1]({frontend}/w/acme/issues/ABC-1) "
        r"Fix \[x\]\(http\://evil\) \@org/team \- \*bold\* \`code\`"
    )


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
    assert link.comment_id == "501"
    assert link.check_run_id == "601"


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
    assert github.clients == 0


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

    assert github.clients == 0


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
