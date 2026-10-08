"""The issue import routes and the paged job behind them.

With no queue configured an import runs inline, so most tests start one and read
the finished issues straight back. The queued tests point the setting at a queue
and capture what is enqueued, then drive the consumer page by page. What these
tests watch: the dry run reports per-row problems and writes nothing, an import
writes new keys with the source key kept and the bulk marker stamped, statuses
map by name then by category, assignees match by email, unknown labels are made
on the team, a page run twice writes each issue once, a page that keeps failing
fails the job, one import runs per workspace, and only an owner or admin may
import at all.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common import issue_import
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.team_config import Label, label_key
from app.domains.integrations.consumers import import_jobs
from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER, sign_in
from tests.domains.integrations.conftest import TEAM, WORKSPACE, sqs_record

BUCKET = "standupless-test-imports"

QUEUE = "https://sqs.us-west-2.amazonaws.com/1/issue-import"

CSV = (
    "Issue key,Summary,Status,Priority,Assignee,Labels,Labels,Created,Description\n"
    "PROJ-1,Fix login,In Progress,High,member@example.com,Bug,web,01/Sep/26 9:00 AM,Broken\n"
    "PROJ-2,Write docs,Closed,Low,nobody@example.com,docs,,,\n"
    "PROJ-3,,To Do,,,,,,\n"
    "PROJ-4,Plan launch,Waiting on legal,whenever,,bug,,,\n"
)


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
            Bucket=BUCKET,
            CreateBucketConfiguration={"LocationConstraint": "us-west-2"},
        )
        monkeypatch.setattr(settings, "ATTACHMENTS_BUCKET", BUCKET, raising=False)
        monkeypatch.setattr(settings, "AWS_REGION", "us-west-2", raising=False)
        monkeypatch.setattr(settings, "ISSUE_IMPORT_QUEUE_URL", "", raising=False)
        yield BUCKET
    reset_client_cache()


@pytest.fixture
def queued(monkeypatch: pytest.MonkeyPatch, bucket: str, enqueued: list[tuple[str, Any]]) -> list[tuple[str, Any]]:
    """An import queue configured, with every page message captured instead of sent."""
    from app.common.core.config import settings

    monkeypatch.setattr(settings, "ISSUE_IMPORT_QUEUE_URL", QUEUE, raising=False)
    return enqueued


@pytest.fixture
def bug_label(repositories: Any, workspace: str) -> Label:
    """A label the team already has, named in a different case than the file uses."""
    return repositories.team_config.create_label(
        Label(
            workspace_id=workspace,
            config_key=label_key(TEAM, "01JB0000000000000000LABL01"),
            team_id=TEAM,
            label_id="01JB0000000000000000LABL01",
            name="BUG",
            color="#d64545",
        )
    )


def body(csv: str = CSV, **fields: Any) -> dict[str, Any]:
    """The request both the dry run and the import take."""
    return {"team_id": TEAM, "preset": "jira", "csv": csv, "file_name": "jira.csv", **fields}


def imported(repositories: Any, import_id: str, line: int) -> Any:
    """The issue one line of one import became, or `None`."""
    return repositories.issues.get(WORKSPACE, issue_import.row_issue_id(import_id, line))


def team_issues(repositories: Any) -> list[Any]:
    """Every issue in the team."""
    return list(repositories.issues.list_for_team(WORKSPACE, TEAM, limit=100).items)


def status_name(repositories: Any, status_id: str) -> str:
    """The name of one of the team's statuses."""
    statuses = repositories.team_config.list_statuses(WORKSPACE, TEAM)
    return next(status.name for status in statuses if status.status_id == status_id)


def test_the_dry_run_reports_every_row_and_writes_nothing(
    client: TestClient, repositories: Any, workspace: str, bucket: str, bug_label: Label
) -> None:
    """The admin sees the mapping, the status landing places, new labels and each row's problems."""
    sign_in(client, ADMIN)

    response = client.post(f"/api/workspaces/{WORKSPACE}/imports/preview", json=body())

    assert response.status_code == 200, response.text
    preview = response.json()
    assert preview["total_rows"] == 4
    assert preview["importable_rows"] == 3
    assert preview["mapping"]["source_key"] == "Issue key"
    assert preview["new_labels"] == ["docs", "web"]
    statuses = {(row["source"], row["status_name"]) for row in preview["statuses"]}
    assert statuses == {("In Progress", "In Progress"), ("Closed", "Done"), ("Waiting on legal", "Backlog")}
    problems = {(problem["row"], problem["field"], problem["severity"]) for problem in preview["problems"]}
    assert (3, "assignee", "warning") in problems
    assert (4, "title", "error") in problems
    assert (5, "status", "warning") in problems
    assert (5, "priority", "warning") in problems
    first = preview["rows"][0]
    assert first["assignee_id"] == MEMBER
    assert first["source_key"] == "PROJ-1"
    assert team_issues(repositories) == []
    assert [label.name for label in repositories.team_config.list_labels(WORKSPACE, TEAM)] == ["BUG"]


def test_an_import_writes_new_keys_and_keeps_the_source_key(
    client: TestClient, repositories: Any, workspace: str, bucket: str, bug_label: Label
) -> None:
    """Each importable row becomes an issue in the team, marked as imported."""
    sign_in(client, ADMIN)

    response = client.post(f"/api/workspaces/{WORKSPACE}/imports", json=body())

    assert response.status_code == 202, response.text
    job = response.json()
    assert job["status"] == "completed"
    assert job["total_rows"] == 4
    assert job["processed_rows"] == 4
    assert job["created_count"] == 3
    assert job["skipped_count"] == 1
    assert job["labels_created"] == 2
    import_id = job["import_id"]

    first = imported(repositories, import_id, 2)
    assert first.key == "ABC-1"
    assert first.title == "Fix login"
    assert first.external_ref == "PROJ-1"
    assert first.import_batch_id == import_id
    assert first.priority == "high"
    assert first.assignee_id == MEMBER
    assert first.body == "Broken"
    assert first.created_at.isoformat().startswith("2026-09-01T09:00")
    assert status_name(repositories, first.status_id) == "In Progress"
    labels = {label.label_id: label.name for label in repositories.team_config.list_labels(WORKSPACE, TEAM)}
    assert [labels[label_id] for label_id in first.label_ids] == ["BUG", "web"]

    second = imported(repositories, import_id, 3)
    assert second.key == "ABC-2"
    assert second.assignee_id is None
    assert status_name(repositories, second.status_id) == "Done"

    assert imported(repositories, import_id, 4) is None
    fourth = imported(repositories, import_id, 5)
    assert fourth.key == "ABC-3"
    assert status_name(repositories, fourth.status_id) == "Backlog"
    assert len(team_issues(repositories)) == 3


def test_the_assignee_is_subscribed_and_the_requester_hears_once(
    client: TestClient, repositories: Any, workspace: str, bucket: str
) -> None:
    """An import tells its requester in the inbox rather than notifying per issue."""
    sign_in(client, ADMIN)

    import_id = client.post(f"/api/workspaces/{WORKSPACE}/imports", json=body()).json()["import_id"]

    first = imported(repositories, import_id, 2)
    assert repositories.subscriptions.user_ids(WORKSPACE, first.issue_id) == [MEMBER]
    inbox = [dict(row) for row in repositories.inbox.list(WORKSPACE, ADMIN).items]
    assert [(row["kind"], row["issue_key"]) for row in inbox] == [("import_ready", import_id)]
    assert inbox[0]["issue_title"] == "Imported 3 issues into Abc"
    assert [dict(row) for row in repositories.inbox.list(WORKSPACE, MEMBER).items] == []


def test_a_finished_import_reads_back_with_its_problems(client: TestClient, workspace: str, bucket: str) -> None:
    """The job keeps its row problems for the detail view and leaves them out of the list."""
    sign_in(client, OWNER)
    import_id = client.post(f"/api/workspaces/{WORKSPACE}/imports", json=body()).json()["import_id"]

    detail = client.get(f"/api/workspaces/{WORKSPACE}/imports/{import_id}")
    listing = client.get(f"/api/workspaces/{WORKSPACE}/imports")

    assert detail.status_code == 200
    assert detail.json()["problem_count"] == len(detail.json()["problems"]) > 0
    assert listing.status_code == 200
    [item] = listing.json()["items"]
    assert item["import_id"] == import_id
    assert item["problems"] == []
    assert item["problem_count"] == detail.json()["problem_count"]
    assert client.get(f"/api/workspaces/{WORKSPACE}/imports/01JB00000000000000000NOPE").status_code == 404


def test_a_mapping_override_is_honoured(client: TestClient, repositories: Any, workspace: str, bucket: str) -> None:
    """The admin can point a field at another column, or unmap it."""
    sign_in(client, ADMIN)
    csv = "Name,Summary,Status\nFrom name,From summary,Done\n"

    job = client.post(
        f"/api/workspaces/{WORKSPACE}/imports",
        json=body(csv, preset="generic", mapping={"title": "Name", "status": None}),
    ).json()

    issue = imported(repositories, job["import_id"], 2)
    assert issue.title == "From name"
    assert status_name(repositories, issue.status_id) == "Backlog"


@pytest.mark.parametrize(
    ("csv", "mapping"),
    [
        ("Status\nDone\n", None),
        ("Title\nOne\n", {"title": "Missing"}),
        (",\n", None),
    ],
)
@pytest.mark.parametrize("route", ["imports", "imports/preview"])
def test_a_file_that_cannot_be_imported_is_a_422(
    client: TestClient, workspace: str, bucket: str, csv: str, mapping: Any, route: str
) -> None:
    """No title column, a column the file lacks, or no header row is refused before anything is written."""
    sign_in(client, ADMIN)

    response = client.post(f"/api/workspaces/{WORKSPACE}/{route}", json=body(csv, preset="generic", mapping=mapping))

    assert response.status_code == 422, response.text


@pytest.mark.parametrize("subject", [MEMBER, GUEST])
def test_only_an_owner_or_admin_may_import(
    client: TestClient, repositories: Any, workspace: str, bucket: str, subject: str
) -> None:
    """Every import route is refused to members and guests."""
    sign_in(client, subject)

    assert client.post(f"/api/workspaces/{WORKSPACE}/imports/preview", json=body()).status_code == 403
    assert client.post(f"/api/workspaces/{WORKSPACE}/imports", json=body()).status_code == 403
    assert client.get(f"/api/workspaces/{WORKSPACE}/imports").status_code == 403
    assert client.get(f"/api/workspaces/{WORKSPACE}/imports/anything").status_code == 403
    assert team_issues(repositories) == []


def test_an_unknown_team_is_a_404(client: TestClient, workspace: str, bucket: str) -> None:
    """A team id that is not in the workspace reads as missing."""
    sign_in(client, ADMIN)

    response = client.post(f"/api/workspaces/{WORKSPACE}/imports", json=body(team_id="01JB0000000000000000NOTEAM"))

    assert response.status_code == 404


def test_a_second_import_waits_for_the_first(
    client: TestClient, workspace: str, bucket: str, queued: list[tuple[str, Any]]
) -> None:
    """One import runs per workspace at a time."""
    sign_in(client, ADMIN)
    first = client.post(f"/api/workspaces/{WORKSPACE}/imports", json=body())

    second = client.post(f"/api/workspaces/{WORKSPACE}/imports", json=body())

    assert first.status_code == 202
    assert first.json()["status"] == "queued"
    assert second.status_code == 409
    assert second.json()["error_code"] == "CONFLICT"


def test_a_stale_import_no_longer_blocks_a_new_one(
    client: TestClient, workspace: str, bucket: str, queued: list[tuple[str, Any]]
) -> None:
    """A job that stopped moving long ago does not hold the workspace forever."""
    sign_in(client, ADMIN)
    first = client.post(f"/api/workspaces/{WORKSPACE}/imports", json=body()).json()
    job = issue_import.load_job(WORKSPACE, first["import_id"])
    assert job is not None
    stale = job.model_copy(update={"updated_at": utc_now() - issue_import.STALE_AFTER * 2})
    issue_import._s3().put_object(
        Bucket=BUCKET,
        Key=issue_import.job_key(WORKSPACE, job.import_id),
        Body=stale.model_dump_json().encode(),
    )

    assert client.post(f"/api/workspaces/{WORKSPACE}/imports", json=body()).status_code == 202


def test_the_queue_runs_an_import_a_page_at_a_time(
    client: TestClient,
    repositories: Any,
    workspace: str,
    queued: list[tuple[str, Any]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Each page queues the next from where it stopped, and the last one completes the job."""
    monkeypatch.setattr(issue_import, "PAGE_SIZE", 2)
    sign_in(client, ADMIN)
    import_id = client.post(f"/api/workspaces/{WORKSPACE}/imports", json=body()).json()["import_id"]
    assert [envelope.payload["cursor"] for _, envelope in queued] == [0]
    assert queued[0][0] == QUEUE

    import_jobs.handle_record(repositories, sqs_record(dict(queued[0][1].payload)))
    middle = issue_import.load_job(WORKSPACE, import_id)
    assert middle is not None
    assert (middle.status, middle.cursor, middle.created_count) == ("running", 2, 2)
    assert [envelope.payload["cursor"] for _, envelope in queued] == [0, 2]

    import_jobs.handle_record(repositories, sqs_record(dict(queued[1][1].payload)))
    done = issue_import.load_job(WORKSPACE, import_id)
    assert done is not None
    assert (done.status, done.cursor, done.created_count, done.skipped_count) == ("completed", 4, 3, 1)
    assert len(queued) == 2
    assert len(team_issues(repositories)) == 3


def test_a_duplicate_page_message_writes_nothing(
    client: TestClient, repositories: Any, workspace: str, queued: list[tuple[str, Any]]
) -> None:
    """A message for a page the cursor has moved past is dropped."""
    sign_in(client, ADMIN)
    client.post(f"/api/workspaces/{WORKSPACE}/imports", json=body())
    message = sqs_record(dict(queued[0][1].payload))

    import_jobs.handle_record(repositories, message)
    import_jobs.handle_record(repositories, message)

    assert len(team_issues(repositories)) == 3
    assert len(queued) == 1


def test_a_page_run_again_writes_each_issue_once(
    client: TestClient, repositories: Any, workspace: str, queued: list[tuple[str, Any]]
) -> None:
    """A page that wrote its issues but crashed before moving the cursor finds them on the retry."""
    sign_in(client, ADMIN)
    import_id = client.post(f"/api/workspaces/{WORKSPACE}/imports", json=body()).json()["import_id"]
    issue_import.run_page(repositories, WORKSPACE, import_id, 0)
    job = issue_import.load_job(WORKSPACE, import_id)
    assert job is not None
    issue_import.save_job(job.model_copy(update={"status": "running", "cursor": 0, "created_count": 0}))

    issue_import.run_page(repositories, WORKSPACE, import_id, 0)

    issues = team_issues(repositories)
    assert sorted(issue["key"] for issue in issues) == ["ABC-1", "ABC-2", "ABC-3"]
    assert imported(repositories, import_id, 2).key == "ABC-1"


def test_a_failing_page_raises_so_the_queue_retries_it(
    client: TestClient,
    repositories: Any,
    workspace: str,
    queued: list[tuple[str, Any]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The error reaches the consumer, the attempt is counted, and the cursor stays put."""
    sign_in(client, ADMIN)
    import_id = client.post(f"/api/workspaces/{WORKSPACE}/imports", json=body()).json()["import_id"]

    def broken(*args: Any, **kwargs: Any) -> bool:
        """Fail every write."""
        raise RuntimeError("boom")

    monkeypatch.setattr(issue_import, "_write_issue", broken)

    with pytest.raises(RuntimeError):
        import_jobs.handle_record(repositories, sqs_record(dict(queued[0][1].payload)))

    job = issue_import.load_job(WORKSPACE, import_id)
    assert job is not None
    assert (job.status, job.cursor, job.page_attempts) == ("running", 0, 1)


def test_a_page_that_keeps_failing_fails_the_job(
    client: TestClient, repositories: Any, workspace: str, queued: list[tuple[str, Any]]
) -> None:
    """After the last attempt the job is failed and the requester is told."""
    sign_in(client, ADMIN)
    import_id = client.post(f"/api/workspaces/{WORKSPACE}/imports", json=body()).json()["import_id"]
    job = issue_import.load_job(WORKSPACE, import_id)
    assert job is not None
    issue_import.save_job(job.model_copy(update={"page_attempts": issue_import.MAX_PAGE_ATTEMPTS}))

    import_jobs.handle_record(repositories, sqs_record(dict(queued[0][1].payload)))

    failed = issue_import.load_job(WORKSPACE, import_id)
    assert failed is not None
    assert failed.status == "failed"
    assert failed.error == "PageRetriesExhausted"
    assert team_issues(repositories) == []
    inbox = [dict(row) for row in repositories.inbox.list(WORKSPACE, ADMIN).items]
    assert [row["kind"] for row in inbox] == ["import_failed"]


def test_a_record_without_a_page_is_ignored(repositories: Any, workspace: str, bucket: str) -> None:
    """A malformed message cannot start or stall an import."""
    import_jobs.handle_record(repositories, {"body": "not json"})
    import_jobs.handle_record(repositories, sqs_record({"workspace_id": WORKSPACE, "import_id": "x"}))

    assert team_issues(repositories) == []


def test_a_deployed_environment_without_a_queue_refuses(
    client: TestClient, workspace: str, bucket: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Production never runs a whole import inside a request."""
    from app.common.core.config import settings

    class Deployed:
        """The test settings, read as a deployed environment."""

        is_production = True

        def __getattr__(self, name: str) -> Any:
            """Every other setting as the tests set it."""
            return getattr(settings, name)

    monkeypatch.setattr(issue_import, "settings", Deployed())
    sign_in(client, ADMIN)

    response = client.post(f"/api/workspaces/{WORKSPACE}/imports", json=body())

    assert response.status_code == 503
    assert response.json()["error_code"] == "NOT_CONFIGURED"


def test_row_issue_ids_are_stable_and_distinct() -> None:
    """The same row of the same import always becomes the same id, and no two rows share one."""
    import_id = "01JB00000000000000000IMPRT"

    first = issue_import.row_issue_id(import_id, 2)

    assert first == issue_import.row_issue_id(import_id, 2)
    assert first != issue_import.row_issue_id(import_id, 3)
    assert len(first) == 26
    assert first.startswith(import_id[:10])


def test_the_first_edit_of_an_imported_issue_clears_the_marker(
    client: TestClient, repositories: Any, workspace: str, bucket: str
) -> None:
    """Once someone changes an imported issue it is announced like any other, and its source key stays."""
    sign_in(client, ADMIN)
    import_id = client.post(f"/api/workspaces/{WORKSPACE}/imports", json=body()).json()["import_id"]
    issue = imported(repositories, import_id, 2)

    repositories.issues.replace(issue.model_copy(update={"title": "Fix login for real"}))

    edited = imported(repositories, import_id, 2)
    assert edited.title == "Fix login for real"
    assert edited.import_batch_id is None
    assert edited.external_ref == "PROJ-1"
