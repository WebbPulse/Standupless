"""The GitHub Issues importer, driven end to end against an in-process fake of GitHub's REST API.

Every test points `github_import.http_factory` at `FakeGitHub` through an httpx
mock transport and stubs the installation token, so no request leaves the test.
With no queue configured an import runs inline, so most tests start one through
the route and read what it wrote straight back; the queued test drives the
consumer a message at a time. What these tests watch: each GitHub field lands
where it belongs, pull requests are skipped, pages are followed until a short
one, a second import updates what the first wrote instead of duplicating it,
an issue the two way sync mirrors is left alone, and only a repository the
installation covers can be imported.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterator
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from fastapi.testclient import TestClient
from webbpulse.audit import AuditQuery
from webbpulse.identity.oauth import OAuthLinkRecord

from app.common import issue_import
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.github import IssueSync, issue_sync_key
from app.domains.integrations import github_import, github_issues
from app.domains.integrations.consumers import import_jobs
from app.domains.integrations.issue_sync import BACKLINK_MARKER
from app.domains.integrations.mcp.transport import INSUFFICIENT_SCOPE
from tests.domains.helpers import ADMIN, MEMBER, OWNER, sign_in
from tests.domains.integrations.conftest import (
    INSTALLATION_ID,
    REPOSITORY_FULL_NAME,
    REPOSITORY_ID,
    TEAM,
    WORKSPACE,
    seed_issue,
    sqs_record,
)
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal

BUCKET = "standupless-test-imports"

QUEUE = "https://sqs.us-west-2.amazonaws.com/1/issue-import"

TOKEN = "ghs_test_installation_token"

MEMBER_GITHUB_ID = 7001


def github_user(login: str, account_id: int, email: str | None = None) -> dict[str, Any]:
    """A GitHub user object as the REST API answers it."""
    return {"login": login, "id": account_id, "email": email, "type": "User"}


def github_issue(number: int, **fields: Any) -> dict[str, Any]:
    """One GitHub issue as the list call answers it, open and unlabelled unless told otherwise."""
    node: dict[str, Any] = {
        "id": 500000 + number,
        "number": number,
        "title": f"Issue {number}",
        "body": f"Body of issue {number}",
        "state": "open",
        "state_reason": None,
        "labels": [],
        "assignee": None,
        "assignees": [],
        "comments": 0,
        "user": github_user("someone-else", 9999),
        "created_at": f"2025-01-{number:02d}T10:00:00Z",
        "html_url": f"https://github.com/{REPOSITORY_FULL_NAME}/issues/{number}",
    }
    node.update(fields)
    return node


def github_comment(comment_id: int, body: str, user: dict[str, Any], created_at: str) -> dict[str, Any]:
    """One GitHub issue comment as the comment list call answers it."""
    return {"id": comment_id, "body": body, "user": user, "created_at": created_at}


@dataclass
class FakeGitHub:
    """GitHub's issue and comment list calls for one repository, recording every request."""

    issues: list[dict[str, Any]] = field(default_factory=list)
    comments: dict[int, list[dict[str, Any]]] = field(default_factory=dict)
    requests: list[httpx.Request] = field(default_factory=list)
    status: int | None = None

    def handle(self, request: httpx.Request) -> httpx.Response:
        """Answer one request the importer makes, or a 404 for anything else."""
        self.requests.append(request)
        if self.status is not None:
            return httpx.Response(self.status, json={"message": "refused"})
        url = urlparse(str(request.url))
        query = parse_qs(url.query)
        page = int(query.get("page", ["1"])[0])
        per_page = int(query.get("per_page", ["30"])[0])
        base = f"/repositories/{REPOSITORY_ID}/issues"
        if url.path == base:
            start = (page - 1) * per_page
            return httpx.Response(200, json=self.issues[start : start + per_page])
        if url.path.startswith(f"{base}/") and url.path.endswith("/comments"):
            number = int(url.path[len(base) + 1 : -len("/comments")])
            start = (page - 1) * per_page
            return httpx.Response(200, json=self.comments.get(number, [])[start : start + per_page])
        return httpx.Response(404, json={"message": "Not Found"})

    def issue_pages(self) -> list[int]:
        """The issue list pages read, in order."""
        return [
            int(parse_qs(urlparse(str(request.url)).query)["page"][0])
            for request in self.requests
            if urlparse(str(request.url)).path == f"/repositories/{REPOSITORY_ID}/issues"
        ]


@pytest.fixture
def bucket(monkeypatch: pytest.MonkeyPatch) -> Iterator[str]:
    """A live moto S3 bucket with the attachments setting pointed at it and no import queue."""
    import boto3
    from moto import mock_aws
    from webbpulse.storage import reset_client_cache

    from app.common.core.config import settings

    reset_client_cache()
    with mock_aws():
        boto3.client("s3", region_name="us-west-2").create_bucket(
            Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": "us-west-2"}
        )
        monkeypatch.setattr(settings, "ATTACHMENTS_BUCKET", BUCKET, raising=False)
        monkeypatch.setattr(settings, "AWS_REGION", "us-west-2", raising=False)
        monkeypatch.setattr(settings, "ISSUE_IMPORT_QUEUE_URL", "", raising=False)
        yield BUCKET
    reset_client_cache()


@pytest.fixture
def tokens(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Every installation a token was minted for, answered with a fixed test token."""
    minted: list[str] = []

    def mint(installation_id: str) -> str:
        """Record the installation and answer the test token."""
        minted.append(installation_id)
        return TOKEN

    monkeypatch.setattr(github_issues, "installation_token", mint)
    return minted


@pytest.fixture
def github(monkeypatch: pytest.MonkeyPatch, tokens: list[str], installed: str, bucket: str) -> FakeGitHub:
    """A fake GitHub the importer's client talks to, with the repository installed and a bucket ready."""
    fake = FakeGitHub()
    monkeypatch.setattr(
        github_import,
        "http_factory",
        lambda: httpx.Client(transport=httpx.MockTransport(fake.handle), follow_redirects=False),
    )
    return fake


def start(client: TestClient, repository_id: str = REPOSITORY_ID, team_id: str = TEAM) -> Any:
    """Start an import of the repository as the admin and answer the response."""
    sign_in(client, ADMIN)
    return client.post(
        f"/api/workspaces/{WORKSPACE}/imports/github", json={"repository_id": repository_id, "team_id": team_id}
    )


def imported(repositories: Any, node: dict[str, Any]) -> Any:
    """The Standupless issue one GitHub issue became."""
    issue_id = github_import.github_row_id(WORKSPACE, "issue", node["id"], node["created_at"])
    return repositories.issues.get(WORKSPACE, issue_id)


def team_issues(repositories: Any) -> list[Any]:
    """Every issue in the team."""
    return repositories.issues.read_team_newest(WORKSPACE, TEAM, below=None, max_items=200)


def category_of(repositories: Any, status_id: str) -> str:
    """The category of one of the team's statuses."""
    statuses = repositories.team_config.list_statuses(WORKSPACE, TEAM)
    return next(status.category for status in statuses if status.status_id == status_id)


def label_names(repositories: Any, label_ids: list[str]) -> set[str]:
    """The names of the team labels an issue carries."""
    labels = {label.label_id: label.name for label in repositories.team_config.list_labels(WORKSPACE, TEAM)}
    return {labels[label_id] for label_id in label_ids}


def comments_of(repositories: Any, issue_id: str) -> list[Any]:
    """Every comment on one issue, oldest first."""
    from app.common.db.dynamo.comments import Comment

    return [Comment.model_validate(row) for row in repositories.comments.list_for_issue(WORKSPACE, issue_id).items]


def link_github_account(repositories: Any, github_id: int, user_id: str) -> None:
    """Record that a workspace member linked one GitHub account."""
    repositories.oauth_links.put(
        OAuthLinkRecord(
            provider_subject=f"github#{github_id}",
            provider="github",
            subject=str(github_id),
            user_id=user_id,
            linked_at=utc_now().isoformat(),
        )
    )


def test_the_repositories_the_installation_covers_are_listed(client: TestClient, installed: str) -> None:
    """The admin sees the installation's repositories to choose from, and a member is refused."""
    sign_in(client, ADMIN)

    response = client.get(f"/api/workspaces/{WORKSPACE}/imports/github/repositories")

    assert response.status_code == 200, response.text
    assert response.json() == {
        "items": [{"repository_id": REPOSITORY_ID, "full_name": REPOSITORY_FULL_NAME, "private": True, "team_id": None}]
    }
    sign_in(client, MEMBER)
    assert client.get(f"/api/workspaces/{WORKSPACE}/imports/github/repositories").status_code == 403


def test_no_repositories_are_listed_without_an_installation(client: TestClient, workspace: str) -> None:
    """A workspace that never installed the App has nothing to import from."""
    sign_in(client, ADMIN)

    response = client.get(f"/api/workspaces/{WORKSPACE}/imports/github/repositories")

    assert response.status_code == 200
    assert response.json() == {"items": []}


def test_a_repository_the_installation_does_not_cover_is_refused(
    client: TestClient, repositories: Any, github: FakeGitHub
) -> None:
    """Only a repository the installation sees can be imported, and a refusal writes no job."""
    response = start(client, repository_id="424242")

    assert response.status_code == 422, response.text
    assert issue_import.list_jobs(WORKSPACE) == []
    assert github.requests == []


def test_a_member_cannot_start_a_github_import(client: TestClient, github: FakeGitHub) -> None:
    """Importing is an admin action."""
    sign_in(client, MEMBER)

    response = client.post(
        f"/api/workspaces/{WORKSPACE}/imports/github", json={"repository_id": REPOSITORY_ID, "team_id": TEAM}
    )

    assert response.status_code == 403
    assert issue_import.list_jobs(WORKSPACE) == []


def test_every_github_field_lands_where_it_belongs(
    client: TestClient, repositories: Any, github: FakeGitHub, tokens: list[str]
) -> None:
    """Title, body, state, labels, assignee, comments, dates and the source link all come across."""
    link_github_account(repositories, MEMBER_GITHUB_ID, MEMBER)
    linked = github_user("mel-gh", MEMBER_GITHUB_ID)
    stranger = github_user("stranger", 8123)
    open_issue = github_issue(
        1,
        labels=[{"name": "bug", "color": "d73a4a"}, {"name": "help wanted", "color": ""}],
        assignees=[linked],
        assignee=linked,
        user=linked,
        comments=3,
    )
    done = github_issue(2, state="closed", state_reason="completed")
    dropped = github_issue(3, state="closed", state_reason="not_planned")
    github.issues = [open_issue, done, dropped]
    github.comments[1] = [
        github_comment(9002, "Second, by a stranger", stranger, "2025-02-02T09:00:00Z"),
        github_comment(9001, "First, by the member", linked, "2025-02-01T09:00:00Z"),
        github_comment(
            9003, f"Synced with ABC-9 {BACKLINK_MARKER}", github_user("app[bot]", 1), "2025-02-03T09:00:00Z"
        ),
    ]

    response = start(client)

    assert response.status_code == 202, response.text
    body = response.json()
    assert body["status"] == "completed"
    assert body["kind"] == "github"
    assert body["file_name"] == REPOSITORY_FULL_NAME
    assert body["github_repository_id"] == REPOSITORY_ID
    assert body["created_count"] == 3
    assert tokens == [INSTALLATION_ID]
    assert all(request.headers["Authorization"] == f"Bearer {TOKEN}" for request in github.requests)

    first = imported(repositories, open_issue)
    assert first.title == "Issue 1"
    assert first.body == "Body of issue 1"
    assert first.team_id == TEAM
    assert first.assignee_id == MEMBER
    assert first.created_by == MEMBER
    assert first.created_at.isoformat().startswith("2025-01-01T10:00:00")
    assert first.external_ref == f"{REPOSITORY_FULL_NAME}#1 {open_issue['html_url']}"
    assert category_of(repositories, first.status_id) not in ("completed", "cancelled")
    assert label_names(repositories, first.label_ids) == {"bug", "help wanted"}
    colors = {label.name: label.color for label in repositories.team_config.list_labels(WORKSPACE, TEAM)}
    assert colors["bug"] == "#d73a4a"

    second = imported(repositories, done)
    assert category_of(repositories, second.status_id) == "completed"
    assert second.assignee_id is None
    assert second.created_by == ADMIN
    third = imported(repositories, dropped)
    assert category_of(repositories, third.status_id) == "cancelled"

    comments = comments_of(repositories, first.issue_id)
    assert [comment.body for comment in comments] == ["First, by the member", "Second, by a stranger"]
    assert comments[0].author_id == MEMBER
    assert comments[1].author_id == "github:stranger"
    assert comments[0].created_at.isoformat().startswith("2025-02-01T09:00:00")
    comment_reads = [request for request in github.requests if request.url.path.endswith("/comments")]
    assert [request.url.path for request in comment_reads] == [f"/repositories/{REPOSITORY_ID}/issues/1/comments"]


def test_assignees_match_by_email_then_login(client: TestClient, repositories: Any, github: FakeGitHub) -> None:
    """With no linked account a GitHub user is matched by email, then by a display name equal to the login."""
    by_email = github_issue(1, assignees=[github_user("whoever", 1234, "Member@Example.com")])
    by_login = github_issue(2, assignees=[github_user("Olive Owner", 5678)])
    nobody = github_issue(3, assignees=[github_user("unknown", 4321)])
    github.issues = [by_email, by_login, nobody]

    response = start(client)

    assert response.status_code == 202, response.text
    assert imported(repositories, by_email).assignee_id == MEMBER
    assert imported(repositories, by_login).assignee_id == OWNER
    assert imported(repositories, nobody).assignee_id is None
    job = issue_import.load_job(WORKSPACE, response.json()["import_id"])
    assert job is not None
    assert any("left unassigned" in problem.message for problem in job.problems)


def test_pull_requests_are_skipped(client: TestClient, repositories: Any, github: FakeGitHub) -> None:
    """A pull request shares the issue list but is never imported."""
    real = github_issue(1)
    pull = github_issue(2, pull_request={"url": "https://api.github.com/repos/x/y/pulls/2"})
    github.issues = [real, pull]

    response = start(client)

    assert response.status_code == 202, response.text
    assert response.json()["counts"]["pull_requests_skipped"] == 1
    assert imported(repositories, real) is not None
    assert imported(repositories, pull) is None
    assert len(team_issues(repositories)) == 1


def test_every_page_is_read_until_a_short_one(
    client: TestClient, repositories: Any, github: FakeGitHub, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Issues are read a page at a time, oldest first, and a short page ends the import."""
    monkeypatch.setattr(github_import, "PAGE_SIZE", 2)
    github.issues = [github_issue(number) for number in range(1, 6)]

    response = start(client)

    assert response.status_code == 202, response.text
    assert response.json()["status"] == "completed"
    assert github.issue_pages() == [1, 2, 3]
    assert sorted(issue.title for issue in team_issues(repositories)) == [f"Issue {n}" for n in range(1, 6)]
    numbers = {issue.title: issue.number for issue in team_issues(repositories)}
    assert numbers["Issue 1"] < numbers["Issue 5"]


def test_a_full_last_page_reads_one_empty_page_more(
    client: TestClient, repositories: Any, github: FakeGitHub, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When the issue count fills the last page exactly, one more read finds it empty and completes."""
    monkeypatch.setattr(github_import, "PAGE_SIZE", 2)
    github.issues = [github_issue(number) for number in range(1, 5)]

    response = start(client)

    assert response.json()["status"] == "completed"
    assert github.issue_pages() == [1, 2, 3]
    assert len(team_issues(repositories)) == 4


def test_a_second_import_updates_instead_of_duplicating(
    client: TestClient, repositories: Any, github: FakeGitHub
) -> None:
    """Running the import again finds what the first wrote and carries GitHub's edits onto it."""
    node = github_issue(1, comments=1)
    github.issues = [node]
    github.comments[1] = [github_comment(9001, "A comment", github_user("stranger", 8123), "2025-02-01T09:00:00Z")]

    first = start(client)
    assert first.json()["created_count"] == 1
    before = imported(repositories, node)

    node.update(title="Renamed on GitHub", state="closed", state_reason="completed")
    edited = github_comment(9001, "An edited comment", github_user("stranger", 8123), "2025-02-01T09:00:00Z")
    github.comments[1] = [edited]
    second = start(client)

    assert second.status_code == 202, second.text
    assert second.json()["created_count"] == 0
    assert second.json()["updated_count"] == 1
    issues = team_issues(repositories)
    assert len(issues) == 1
    after = imported(repositories, node)
    assert after.issue_id == before.issue_id
    assert after.number == before.number
    assert after.title == "Renamed on GitHub"
    assert category_of(repositories, after.status_id) == "completed"
    assert [comment.body for comment in comments_of(repositories, after.issue_id)] == ["An edited comment"]


def test_an_issue_the_sync_mirrors_is_left_to_the_sync(
    client: TestClient, repositories: Any, github: FakeGitHub
) -> None:
    """A GitHub issue already linked through two way sync is skipped rather than imported twice."""
    mirror = seed_issue(repositories, WORKSPACE, TEAM, "01JB0000000000000000000IS1", "ABC", 99)
    repositories.github.claim_issue_sync(
        IssueSync(
            workspace_id=WORKSPACE,
            github_key=issue_sync_key(mirror.issue_id),
            issue_id=mirror.issue_id,
            team_id=TEAM,
            repository_id=REPOSITORY_ID,
            full_name=REPOSITORY_FULL_NAME,
            number=1,
        )
    )
    synced = github_issue(1)
    fresh = github_issue(2)
    github.issues = [synced, fresh]

    response = start(client)

    assert response.status_code == 202, response.text
    assert response.json()["skipped_count"] == 1
    assert imported(repositories, synced) is None
    assert imported(repositories, fresh) is not None
    assert len(team_issues(repositories)) == 2


def test_a_refused_token_fails_the_job(client: TestClient, repositories: Any, github: FakeGitHub) -> None:
    """GitHub refusing the installation's token fails the import at once and tells the requester."""
    github.status = 403

    response = start(client)

    assert response.status_code == 202, response.text
    assert response.json()["status"] == "failed"
    assert team_issues(repositories) == []


def test_a_queued_import_runs_a_page_per_message(
    repositories: Any,
    client: TestClient,
    github: FakeGitHub,
    enqueued: list[tuple[str, Any]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With a queue configured, each message reads one page and queues the next until the import completes."""
    from app.common.core.config import settings

    monkeypatch.setattr(settings, "ISSUE_IMPORT_QUEUE_URL", QUEUE, raising=False)
    monkeypatch.setattr(github_import, "PAGE_SIZE", 2)
    github.issues = [github_issue(number) for number in range(1, 4)]

    response = start(client)
    assert response.status_code == 202, response.text
    assert response.json()["status"] == "queued"
    assert github.requests == []

    handled = 0
    while handled < len(enqueued) and handled < 10:
        import_jobs.handle_record(repositories, sqs_record(dict(enqueued[handled][1].payload)))
        handled += 1

    job = issue_import.load_job(WORKSPACE, response.json()["import_id"])
    assert job is not None
    assert job.status == "completed"
    assert job.created_count == 3
    assert github.issue_pages() == [1, 2]
    assert len(team_issues(repositories)) == 3


def test_the_mcp_tools_list_repositories_and_import_their_issues(
    client: TestClient, repositories: Any, github: FakeGitHub
) -> None:
    """An agent with an admin's key lists the installation's repositories, imports one and reads the job."""
    github.issues = [github_issue(1), github_issue(2)]
    secret = mint_for(repositories, OWNER, ("settings:read", "settings:write", "admin"))

    listed = answer(tool(client, secret, "list_github_import_repositories", {}))
    started = answer(tool(client, secret, "import_github_issues", {"repository_id": REPOSITORY_ID, "team_id": "ABC"}))
    status = answer(tool(client, secret, "get_workspace_import", {"import_id": started["import_id"]}))
    cancelled = answer(tool(client, secret, "cancel_workspace_import", {"import_id": started["import_id"]}))
    uncovered = refusal(tool(client, secret, "import_github_issues", {"repository_id": "424242", "team_id": TEAM}))

    assert listed == {
        "repositories": [
            {"repository_id": REPOSITORY_ID, "full_name": REPOSITORY_FULL_NAME, "private": True, "team_id": None}
        ]
    }
    assert (started["kind"], started["team_id"], started["status"]) == ("github", TEAM, "completed")
    assert status["import_id"] == started["import_id"]
    assert status["created_count"] == 2
    assert cancelled["status"] == "completed"
    assert "cannot see" in uncovered
    assert len(team_issues(repositories)) == 2
    [row] = repositories.audit.list_events(WORKSPACE, AuditQuery(action="import.started")).events
    assert row.target.label == REPOSITORY_FULL_NAME
    assert row.after == {"preset": "github_api", "team_id": TEAM, "repository_id": REPOSITORY_ID}


def test_a_member_key_cannot_import_github_issues_over_mcp(
    client: TestClient, repositories: Any, github: FakeGitHub
) -> None:
    """The tools check the same admin capability the routes do."""
    secret = mint_for(repositories, MEMBER, ("settings:read", "settings:write", "admin"))

    refused = tool(client, secret, "import_github_issues", {"repository_id": REPOSITORY_ID, "team_id": TEAM})

    assert refused.json()["error"]["code"] == INSUFFICIENT_SCOPE
    assert issue_import.list_jobs(WORKSPACE) == []
    assert github.requests == []
