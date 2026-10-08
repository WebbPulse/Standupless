"""The dispatch consumer: write-back to GitHub, and routing of outbound webhook jobs.

Every GitHub call is patched at the `github_issues` boundary, so no test here opens a
socket and a test that started making a real call would fail on the missing patch
rather than reaching api.github.com.
"""

from __future__ import annotations

from typing import Any

import pytest
from webbpulse.integrations.github import GitHubError

from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.github import IssueLink, link_key
from app.domains.integrations.consumers import dispatch
from tests.domains.integrations.conftest import (
    INSTALLATION_ID,
    REPOSITORY_FULL_NAME,
    REPOSITORY_ID,
    WORKSPACE,
    sqs_record,
)


class FakeGithub:
    """Records what would have been sent to GitHub, and answers with fixed ids.

    Stands in for the `github_issues` calls the write-back makes, so `clients`
    counts installation tokens minted: a job with nothing to write must not mint
    one, because minting is what exchanges the App JWT for an installation token.
    """

    def __init__(self) -> None:
        """Start with nothing recorded."""
        self.clients = 0
        self.installations: list[str] = []
        self.comments: list[tuple[str, int, str]] = []
        self.updates: list[tuple[str, str, str]] = []
        self.check_runs: list[tuple[str, str]] = []
        self.summaries: list[str] = []

    def installation_token(self, installation_id: str) -> str:
        """Count one token minted for a unit of work."""
        self.clients += 1
        self.installations.append(str(installation_id))
        return "ghs_test"

    def create_comment(self, token: str, repository_id: str, number: int, body: str) -> dict[str, Any]:
        """Record a posted comment."""
        self.comments.append((repository_id, number, body))
        return {"id": 501, "body": body}

    def update_comment(self, token: str, repository_id: str, comment_id: str, body: str) -> dict[str, Any]:
        """Record an edited comment."""
        self.updates.append((repository_id, comment_id, body))
        return {"id": 1, "body": body}

    def create_check_run(
        self,
        token: str,
        repository_id: str,
        *,
        name: str,
        head_sha: str,
        conclusion: str,
        title: str,
        summary: str,
    ) -> dict[str, Any]:
        """Record a set check run."""
        assert name == "Standupless"
        assert conclusion == "success"
        self.check_runs.append((repository_id, head_sha))
        self.summaries.append(summary)
        return {"id": 601, "status": "completed", "conclusion": conclusion}


@pytest.fixture
def github(monkeypatch: pytest.MonkeyPatch) -> FakeGithub:
    """Hand the dispatcher a fake wherever it would call GitHub."""
    fake = FakeGithub()
    for name in ("installation_token", "create_comment", "update_comment", "create_check_run"):
        monkeypatch.setattr(dispatch.github_issues, name, getattr(fake, name))
    return fake


def writeback_job(link_ids: list[str], *, keys: list[str] | None = None) -> dict[str, Any]:
    """One write-back job, as the events consumer enqueues it."""
    return {
        "kind": "github.writeback",
        "workspace_id": WORKSPACE,
        "repository_id": REPOSITORY_ID,
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
    assert github.comments[0][0] == REPOSITORY_ID
    assert github.check_runs == [(REPOSITORY_ID, "deadbeef")]
    assert github.installations == [INSTALLATION_ID]
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

    def refuse(*args: Any, **kwargs: Any) -> dict[str, Any]:
        """Answer the way the client does when GitHub is unavailable."""
        raise GitHubError("unavailable", method="POST", path="/comments", status_code=502)

    monkeypatch.setattr(dispatch.github_issues, "create_comment", refuse)

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
    monkeypatch.setattr(type(getattr(repositories, table)), method, refuse)
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


def status_name(repositories: Any, issue: Any) -> str:
    """The name of the status one issue is in."""
    statuses = repositories.team_config.list_statuses(WORKSPACE, issue.team_id)
    return next(status.name for status in statuses if status.status_id == issue.status_id)


def test_a_public_repository_gets_keys_and_statuses_but_no_titles(
    repositories: Any,
    installed: str,
    issue: Any,
    github: FakeGithub,
    github_env: None,
    frontend: str,
) -> None:
    """A public pull request never carries what a team wrote in its issues."""
    repositories.issues.replace(issue.model_copy(update={"title": "A secret plan"}))
    repositories.github.set_repository_private(WORKSPACE, REPOSITORY_ID, False)
    link_id = put_link(repositories, issue.issue_id, comment_id=None, check_run_id=None)

    dispatch.handle_record(repositories, sqs_record(writeback_job([link_id])))

    body = github.comments[0][2]
    assert "secret" not in body
    assert body.splitlines()[2] == f"- [ABC-1]({frontend}/w/acme/issues/ABC-1) {status_name(repositories, issue)}"
    assert github.summaries == [body]


def test_a_delivery_that_says_public_withholds_titles_before_the_row_catches_up(
    repositories: Any,
    installed: str,
    issue: Any,
    github: FakeGithub,
    github_env: None,
    frontend: str,
) -> None:
    """The job's own visibility wins when it says public, whatever the stored row still holds."""
    link_id = put_link(repositories, issue.issue_id, comment_id=None, check_run_id=None)
    job = {**writeback_job([link_id]), "repository_private": False}

    dispatch.handle_record(repositories, sqs_record(job))

    assert issue.title not in github.comments[0][2]


def test_a_repository_with_no_stored_row_gets_no_titles(
    repositories: Any,
    installed: str,
    issue: Any,
    github: FakeGithub,
    github_env: None,
    frontend: str,
) -> None:
    """An unknown repository is treated as public."""
    repositories.github.delete_repository(WORKSPACE, REPOSITORY_ID)
    link_id = put_link(repositories, issue.issue_id, comment_id=None, check_run_id=None)

    dispatch.handle_record(repositories, sqs_record(writeback_job([link_id])))

    assert issue.title not in github.comments[0][2]


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


def test_a_write_back_without_a_repository_id_calls_nothing(
    repositories: Any,
    installed: str,
    issue: Any,
    github: FakeGithub,
    github_env: None,
) -> None:
    """A job queued before jobs carried the id is dropped rather than addressed by a name that may be stale."""
    link_id = put_link(repositories, issue.issue_id, comment_id=None, check_run_id=None)
    job = writeback_job([link_id])
    del job["repository_id"]

    dispatch.handle_record(repositories, sqs_record(job))

    assert github.clients == 0
    assert github.comments == []


def test_a_legacy_deliver_job_is_dropped(repositories: Any, workspace: str, github_env: None) -> None:
    """A `webhook.deliver` job queued before the delivery log existed is logged and dropped.

    Raising would hand it back to SQS until it reached the dead letter queue, for a
    job no current code can act on.
    """
    job = {"kind": "webhook.deliver", "workspace_id": WORKSPACE, "event": "issue.created", "payload": {}}

    dispatch.handle_record(repositories, sqs_record(job))


def test_an_attempt_job_is_routed_to_the_delivery_attempt(
    repositories: Any,
    workspace: str,
    github_env: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A `webhook.attempt` job reaches `run_attempt` with its payload intact."""
    from app.domains.integrations.outbound.delivery import ATTEMPT_JOB

    seen: list[Any] = []
    monkeypatch.setattr(dispatch, "run_attempt", lambda repos, job, **kwargs: seen.append(dict(job)) or "delivered")
    job = {"kind": ATTEMPT_JOB, "workspace_id": WORKSPACE, "webhook_id": "w", "delivery_id": "d", "attempt": 1}

    dispatch.handle_record(repositories, sqs_record(job))

    assert seen and seen[0]["delivery_id"] == "d"
