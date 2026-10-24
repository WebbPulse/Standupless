"""The Asana API importer, driven end to end against the fake Asana REST API.

Every test points `asana_import.client_factory` at `FakeAsana`, which answers from
a recorded Asana workspace through an in-process transport, so no request leaves
the test and no real token is used. With no queue configured an import runs
inline, so most tests start one through the route and read what it wrote back;
the queued tests drive the consumer a message at a time. What these tests watch:
each Asana field lands where it belongs, sections or a chosen single choice field
set the status, subtasks become sub-issues, lists are followed page by page, a
rate limit is waited out, a second import updates what the first wrote, the
sealed token is deleted whenever a job ends, and the token never appears in a log
line, the job object, an audit row, a stored row or an answer.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient
from webbpulse.audit import AuditQuery

from app.common import issue_import, linear_import
from app.domains.integrations import asana_api, asana_import
from app.domains.integrations.asana_api import AsanaClient
from app.domains.integrations.consumers import import_jobs
from app.domains.integrations.mcp.transport import INSUFFICIENT_SCOPE
from tests.domains.helpers import ADMIN, MEMBER, OWNER, sign_in
from tests.domains.integrations.asana_fake import (
    ARCHIVED_GID,
    FAKE_TOKEN,
    PROJECT_GID,
    STAGE_FIELD_GID,
    FakeAsana,
)
from tests.domains.integrations.conftest import OTHER_TEAM, TEAM, WORKSPACE, sqs_record
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal

BUCKET = "standupless-test-imports"

QUEUE = "https://sqs.us-west-2.amazonaws.com/1/issue-import"

WRONG_TOKEN = "2/1100000000000001/1700000000000002:wrongasanatoken111111111"

PLAN = "1400000000000001"

VENUE = "1400000000000002"

DOMAIN = "1400000000000003"

OUTLINE = "1400000000000011"

LEGAL = "1400000000000012"


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
def queued(monkeypatch: pytest.MonkeyPatch, bucket: str, enqueued: list[tuple[str, Any]]) -> list[tuple[str, Any]]:
    """An import queue configured, with every page message captured instead of sent."""
    from app.common.core.config import settings

    monkeypatch.setattr(settings, "ISSUE_IMPORT_QUEUE_URL", QUEUE, raising=False)
    return enqueued


@pytest.fixture
def sleeps() -> list[float]:
    """Every pause the Asana client took, recorded instead of slept."""
    return []


@pytest.fixture
def asana(monkeypatch: pytest.MonkeyPatch, sleeps: list[float], workspace: str) -> FakeAsana:
    """The recorded Asana workspace, answering every Asana client the code builds."""
    fake = FakeAsana()
    monkeypatch.setattr(
        asana_import,
        "client_factory",
        lambda token: AsanaClient(token=token, transport=fake.transport(), sleep=sleeps.append),
    )
    return fake


def choice(**overrides: Any) -> dict[str, Any]:
    """One project choice: the recorded project into the test team, with any overrides."""
    return {"project_gid": PROJECT_GID, "team_id": TEAM, **overrides}


def start_body(token: str = FAKE_TOKEN, **overrides: Any) -> dict[str, Any]:
    """The request that imports the recorded project into the test team."""
    return {"token": token, "projects": [choice(**overrides)]}


def start(client: TestClient, token: str = FAKE_TOKEN, **overrides: Any) -> Any:
    """Start an import of the recorded project as the admin and answer the response."""
    sign_in(client, ADMIN)
    return client.post(f"/api/workspaces/{WORKSPACE}/imports/asana", json=start_body(token, **overrides))


def imported(repositories: Any, fake: FakeAsana, gid: str) -> Any:
    """The Standupless issue one recorded Asana task became."""
    task = fake.task(gid)
    return repositories.issues.get(WORKSPACE, asana_import.asana_row_id(WORKSPACE, "task", gid, task["created_at"]))


def team_issues(repositories: Any, team_id: str = TEAM) -> list[Any]:
    """Every issue in one team."""
    return repositories.issues.read_team_newest(WORKSPACE, team_id, below=None, max_items=100)


def statuses(repositories: Any) -> dict[str, str]:
    """The test team's status ids by name."""
    return {status.name: status.status_id for status in repositories.team_config.list_statuses(WORKSPACE, TEAM)}


def status_name(repositories: Any, status_id: str) -> str:
    """The name of one of the test team's statuses."""
    return next(name for name, found in statuses(repositories).items() if found == status_id)


def key_stored(import_id: str) -> bool:
    """Whether the sealed token of one import is still in the bucket."""
    import boto3

    listing = boto3.client("s3", region_name="us-west-2").list_objects_v2(
        Bucket=BUCKET, Prefix=linear_import.key_key(WORKSPACE, import_id)
    )
    return bool(listing.get("Contents"))


def every_stored_row() -> str:
    """Every DynamoDB row of every table, as one string a token could be searched for in."""
    from app.common.db.dynamo.client import get_client

    client = get_client()
    rows: list[Any] = []
    for name in client.list_tables()["TableNames"]:
        rows.extend(client.scan(TableName=name).get("Items", []))
    return json.dumps(rows, default=str)


def every_stored_object() -> str:
    """Every object in the import bucket but the sealed tokens, as one string."""
    import boto3

    s3 = boto3.client("s3", region_name="us-west-2")
    parts = []
    for item in s3.list_objects_v2(Bucket=BUCKET).get("Contents", []):
        if not item["Key"].endswith(linear_import.KEY_FILE):
            parts.append(s3.get_object(Bucket=BUCKET, Key=item["Key"])["Body"].read().decode())
    return "\n".join(parts)


def drain(repositories: Any, queued: list[tuple[str, Any]], *, limit: int = 50) -> None:
    """Run every queued page message in order, including the ones each page queues."""
    handled = 0
    while handled < len(queued) and handled < limit:
        import_jobs.handle_record(repositories, sqs_record(dict(queued[handled][1].payload)))
        handled += 1


def test_the_projects_a_token_can_read_are_listed(client: TestClient, asana: FakeAsana) -> None:
    """The admin pastes a token and sees the Asana projects it reads, and nothing is stored."""
    sign_in(client, ADMIN)

    response = client.post(f"/api/workspaces/{WORKSPACE}/imports/asana/projects", json={"token": f" {FAKE_TOKEN} "})

    assert response.status_code == 200, response.text
    assert response.json() == {
        "items": [
            {
                "gid": PROJECT_GID,
                "name": "Website relaunch",
                "workspace_gid": "1000000000000001",
                "workspace_name": "Acme",
                "team_name": "Marketing",
                "archived": False,
                "completed": False,
                "url": "https://app.asana.com/0/1200000000000001/1200000000000001",
            },
            {
                "gid": ARCHIVED_GID,
                "name": "Old archive",
                "workspace_gid": "1000000000000001",
                "workspace_name": "Acme",
                "team_name": None,
                "archived": True,
                "completed": True,
                "url": "https://app.asana.com/0/1200000000000002/1200000000000002",
            },
        ]
    }
    assert all(request.authorized for request in asana.requests)
    assert asana.paths() == ["/users/me", "/projects"]


def test_a_refused_token_is_a_400_that_never_repeats_the_token(
    client: TestClient, bucket: str, asana: FakeAsana
) -> None:
    """A token Asana refuses answers a plain refusal, and starting with it writes nothing."""
    sign_in(client, ADMIN)

    listed = client.post(f"/api/workspaces/{WORKSPACE}/imports/asana/projects", json={"token": WRONG_TOKEN})
    previewed = client.post(f"/api/workspaces/{WORKSPACE}/imports/asana/preview", json=start_body(WRONG_TOKEN))
    started = client.post(f"/api/workspaces/{WORKSPACE}/imports/asana", json=start_body(WRONG_TOKEN))

    for response in (listed, previewed, started):
        assert response.status_code == 400
        assert response.json()["error_code"] == "ASANA_TOKEN_REFUSED"
        assert WRONG_TOKEN not in response.text
    assert issue_import.list_jobs(WORKSPACE) == []


@pytest.mark.parametrize("route", ["imports/asana/projects", "imports/asana/preview", "imports/asana"])
def test_only_an_owner_or_admin_may_import_from_asana(
    client: TestClient, bucket: str, asana: FakeAsana, route: str
) -> None:
    """A member is refused before Asana is ever asked."""
    sign_in(client, MEMBER)

    response = client.post(f"/api/workspaces/{WORKSPACE}/{route}", json=start_body())

    assert response.status_code == 403
    assert asana.requests == []


def test_the_preview_shows_where_each_section_lands_and_writes_nothing(
    client: TestClient, repositories: Any, bucket: str, asana: FakeAsana
) -> None:
    """Sections map by name, then by what the name means, then to the default, and the fields are offered."""
    sign_in(client, ADMIN)
    ids = statuses(repositories)

    response = client.post(f"/api/workspaces/{WORKSPACE}/imports/asana/preview", json=start_body())

    assert response.status_code == 200, response.text
    [preview] = response.json()["projects"]
    assert (preview["project_gid"], preview["name"], preview["team_id"]) == (PROJECT_GID, "Website relaunch", TEAM)
    assert (preview["task_count"], preview["completed_count"]) == (5, 1)
    assert preview["create_project"] is True
    assert preview["status_field_gid"] is None
    assert preview["sections"] == ["To do", "Doing", "Waiting on legal", "Done"]
    assert [(plan["source"], plan["status_name"]) for plan in preview["statuses"]] == [
        ("To do", "Todo"),
        ("Doing", "In Progress"),
        ("Waiting on legal", "Backlog"),
        ("Done", "Done"),
    ]
    assert preview["statuses"][0]["status_id"] == ids["Todo"]
    assert preview["status_fields"] == [
        {"gid": "1300000000000001", "name": "Priority", "options": ["High", "Low"]},
        {"gid": STAGE_FIELD_GID, "name": "Stage", "options": ["Backlog", "Shipping"]},
    ]
    assert team_issues(repositories) == []
    assert issue_import.list_jobs(WORKSPACE) == []


def test_the_preview_follows_a_chosen_status_field_and_overrides(
    client: TestClient, repositories: Any, bucket: str, asana: FakeAsana
) -> None:
    """A chosen single choice field replaces the sections, and an override wins over the name."""
    sign_in(client, ADMIN)
    ids = statuses(repositories)
    body = start_body(status_field_gid=STAGE_FIELD_GID, statuses={"Shipping": ids["In Progress"]})

    response = client.post(f"/api/workspaces/{WORKSPACE}/imports/asana/preview", json=body)

    assert response.status_code == 200, response.text
    [preview] = response.json()["projects"]
    assert (preview["status_field_gid"], preview["status_field_name"]) == (STAGE_FIELD_GID, "Stage")
    assert preview["sections"] == []
    assert [(plan["source"], plan["status_name"]) for plan in preview["statuses"]] == [
        ("Backlog", "Backlog"),
        ("Shipping", "In Progress"),
    ]


def test_a_plan_without_custom_fields_still_previews(
    client: TestClient, repositories: Any, bucket: str, asana: FakeAsana
) -> None:
    """Asana's payment required answer for custom fields means none, not a failure."""
    asana.payment_required = True
    sign_in(client, ADMIN)

    response = client.post(f"/api/workspaces/{WORKSPACE}/imports/asana/preview", json=start_body())

    assert response.status_code == 200, response.text
    assert response.json()["projects"][0]["status_fields"] == []


def test_a_project_or_mapping_that_does_not_fit_is_a_422(
    client: TestClient, repositories: Any, bucket: str, asana: FakeAsana
) -> None:
    """An unknown or repeated project, a field that is not single choice, or a status the team lacks starts nothing."""
    sign_in(client, ADMIN)
    bodies = [
        {"token": FAKE_TOKEN, "projects": [choice(project_gid="1299999999999999")]},
        {"token": FAKE_TOKEN, "projects": [choice(), choice()]},
        {"token": FAKE_TOKEN, "projects": [choice(project_gid="../users/me")]},
        {"token": FAKE_TOKEN, "projects": []},
        start_body(status_field_gid="1300000000000003"),
        start_body(statuses={"Doing": "01JB0000000000000000NOSUCH"}),
    ]

    for body in bodies:
        for route in ("imports/asana/preview", "imports/asana"):
            response = client.post(f"/api/workspaces/{WORKSPACE}/{route}", json=body)
            assert response.status_code == 422, (body, response.text)
            assert FAKE_TOKEN not in response.text
    assert issue_import.list_jobs(WORKSPACE) == []
    assert team_issues(repositories) == []


def test_an_import_carries_every_task_field(
    client: TestClient, repositories: Any, bucket: str, asana: FakeAsana
) -> None:
    """Name, notes, section, priority, tags, people, dates, the project and the Asana link land."""
    response = start(client)

    assert response.status_code == 202, response.text
    job = response.json()
    assert (job["kind"], job["status"], job["preset"]) == ("asana", "completed", "asana_api")
    plan, venue, domain = (imported(repositories, asana, gid) for gid in (PLAN, VENUE, DOMAIN))
    assert sorted(issue.key for issue in team_issues(repositories)) == ["ABC-1", "ABC-2", "ABC-3", "ABC-4", "ABC-5"]
    assert plan.title == "Write the launch plan"
    assert plan.body == "Draft the plan and share it with the team."
    assert plan.external_ref == f"Asana {PLAN} https://app.asana.com/0/1200000000000001/{PLAN}"
    assert plan.import_batch_id == job["import_id"]
    assert [status_name(repositories, issue.status_id) for issue in (plan, venue, domain)] == [
        "In Progress",
        "Backlog",
        "Done",
    ]
    assert [issue.priority for issue in (plan, venue, domain)] == ["high", "low", "none"]
    assert (plan.start_date, plan.due_date, domain.due_date) == ("2026-09-10", "2026-09-30", "2026-09-05")
    assert (plan.assignee_id, plan.created_by) == (MEMBER, MEMBER)
    assert (venue.assignee_id, venue.created_by) == (None, ADMIN)
    assert plan.created_at.isoformat().startswith("2026-09-01T09:00")
    labels = {label.label_id: label for label in repositories.team_config.list_labels(WORKSPACE, TEAM)}
    assert sorted(labels[label_id].name for label_id in plan.label_ids) == ["Docs", "Launch"]
    launch = next(labels[label_id] for label_id in plan.label_ids if labels[label_id].name == "Launch")
    docs = next(labels[label_id] for label_id in plan.label_ids if labels[label_id].name == "Docs")
    assert launch.color == "#31a24c"
    assert docs.color == issue_import.label_color("Docs")
    assert venue.label_ids == [launch.label_id]
    [project] = repositories.planning.list_projects(WORKSPACE)
    created = "2026-08-01T09:00:00.000Z"
    assert project.project_id == asana_import.asana_row_id(WORKSPACE, "project", PROJECT_GID, created)
    assert (project.name, project.description) == ("Website relaunch", "Ship the new site before the conference.")
    assert (project.status, project.lead_id, project.start_date, project.target_date) == (
        "in_progress",
        MEMBER,
        "2026-09-01",
        "2026-10-31",
    )
    assert project.team_ids == [TEAM]
    assert all(issue.project_id == project.project_id for issue in team_issues(repositories))
    problems = {(problem["field"], problem["message"]) for problem in job["problems"]}
    assert ("assignee", f"Asana task {VENUE}: the assignee is not a member, left unassigned") in problems


def test_subtasks_become_sub_issues_and_comments_come_across(
    client: TestClient, repositories: Any, bucket: str, asana: FakeAsana
) -> None:
    """Subtasks, nested ones included, hang off the top level task, and comments keep author and time."""
    job = start(client).json()

    plan, outline, legal = (imported(repositories, asana, gid) for gid in (PLAN, OUTLINE, LEGAL))
    assert (outline.parent_id, legal.parent_id) == (plan.issue_id, plan.issue_id)
    assert status_name(repositories, outline.status_id) == "Backlog"
    assert status_name(repositories, legal.status_id) == "Done"
    assert outline.created_by == MEMBER
    comments = sorted(
        repositories.comments.iter_for_issue(WORKSPACE, plan.issue_id), key=lambda comment: comment.created_at
    )
    assert [(comment.author_id, comment.body) for comment in comments] == [
        (MEMBER, "First draft is up."),
        ("asana:Riley Stranger", "Looks good to me."),
    ]
    assert comments[0].created_at.isoformat().startswith("2026-09-02T10:00")
    assert all(comment.import_batch_id == job["import_id"] for comment in comments)
    [outline_comment] = repositories.comments.iter_for_issue(WORKSPACE, outline.issue_id)
    assert outline_comment.body == "Started on the outline."
    assert job["counts"] == {"projects": 1, "issues_created": 5, "labels": 2, "comments": 3, "sub_issues": 2}
    assert (job["created_count"], job["linked_count"], job["labels_created"]) == (5, 2, 2)
    assert job["phase"] is None
    assert job["phase_index"] == job["phase_count"] == 2


def test_a_chosen_status_field_and_overrides_set_the_status(
    client: TestClient, repositories: Any, bucket: str, asana: FakeAsana
) -> None:
    """With the Stage field chosen, its options decide, an override wins, and a completed task is done."""
    ids = statuses(repositories)

    job = start(
        client,
        status_field_gid=STAGE_FIELD_GID,
        statuses={"Shipping": ids["Todo"]},
        create_project=False,
    ).json()

    assert job["status"] == "completed", job
    plan, venue, domain = (imported(repositories, asana, gid) for gid in (PLAN, VENUE, DOMAIN))
    assert [status_name(repositories, issue.status_id) for issue in (plan, venue, domain)] == [
        "Todo",
        "Backlog",
        "Done",
    ]
    assert repositories.planning.list_projects(WORKSPACE) == []
    assert plan.project_id is None
    assert job["asana_projects"][0]["status_field_name"] == "Stage"


def test_no_account_or_invite_is_made_for_unmatched_people(
    client: TestClient, repositories: Any, bucket: str, asana: FakeAsana
) -> None:
    """Placeholder authors stand in for people Asana knows and the workspace does not."""
    members_before = {member.user_id for member in repositories.memberships.list_members(WORKSPACE)}

    start(client)

    assert {member.user_id for member in repositories.memberships.list_members(WORKSPACE)} == members_before
    assert repositories.invites.list_for_workspace(WORKSPACE) == []


def test_lists_are_followed_page_by_page(
    client: TestClient,
    repositories: Any,
    bucket: str,
    asana: FakeAsana,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With one record a page, the tasks and every nested list are read to the end."""
    monkeypatch.setattr(asana_import, "PAGE_SIZE", 1)
    monkeypatch.setattr(asana_api, "PAGE_LIMIT", 1)

    job = start(client).json()

    assert job["status"] == "completed"
    task_pages = [request.params.get("offset") for request in asana.requests if request.path == "/tasks"]
    assert task_pages == [None, "1", "2"]
    stories = f"/tasks/{PLAN}/stories"
    story_pages = [request.params.get("offset") for request in asana.requests if request.path == stories]
    assert story_pages == [None, "1", "2"]
    assert len(team_issues(repositories)) == 5
    plan = imported(repositories, asana, PLAN)
    assert len(repositories.comments.iter_for_issue(WORKSPACE, plan.issue_id)) == 2
    assert job["counts"]["sub_issues"] == 2


def test_a_rate_limit_is_waited_out(
    client: TestClient, repositories: Any, bucket: str, asana: FakeAsana, sleeps: list[float]
) -> None:
    """A 429 with a Retry-After pauses that long and retries, and the import still completes."""
    asana.rate_limit_next = 2

    job = start(client).json()

    assert job["status"] == "completed"
    assert sleeps == [2.0, 2.0]
    assert len(team_issues(repositories)) == 5


def test_a_rate_limit_that_never_lifts_is_a_502(client: TestClient, asana: FakeAsana, sleeps: list[float]) -> None:
    """After every retry the admin hears Asana is not answering, without the wait running forever."""
    asana.rate_limit_next = 100
    sign_in(client, ADMIN)

    response = client.post(f"/api/workspaces/{WORKSPACE}/imports/asana/projects", json={"token": FAKE_TOKEN})

    assert response.status_code == 502
    assert response.json()["error_code"] == "ASANA_UNAVAILABLE"
    assert len(sleeps) == asana_api.MAX_ATTEMPTS - 1


def test_a_second_import_updates_instead_of_duplicating(
    client: TestClient, repositories: Any, bucket: str, asana: FakeAsana
) -> None:
    """Running the import again finds every row it wrote by its Asana gid and updates it in place."""
    first = start(client).json()
    keys = sorted(issue.key for issue in team_issues(repositories))
    before = imported(repositories, asana, PLAN)
    asana.task(PLAN)["name"] = "Write the launch plan, renamed"

    second = start(client).json()

    assert second["import_id"] != first["import_id"]
    assert second["status"] == "completed"
    assert second["counts"]["issues_updated"] == 5
    assert second["counts"].get("issues_created", 0) == 0
    assert second["counts"].get("labels", 0) == 0
    assert second["updated_count"] == 5
    assert sorted(issue.key for issue in team_issues(repositories)) == keys
    plan = imported(repositories, asana, PLAN)
    assert plan.issue_id == before.issue_id
    assert plan.title == "Write the launch plan, renamed"
    assert plan.external_ref == before.external_ref
    assert len(repositories.comments.iter_for_issue(WORKSPACE, plan.issue_id)) == 2
    assert len(repositories.planning.list_projects(WORKSPACE)) == 1
    names = sorted(label.name for label in repositories.team_config.list_labels(WORKSPACE, TEAM))
    assert names == ["Docs", "Launch"]


def test_tasks_imported_into_another_team_are_left_there(
    client: TestClient, repositories: Any, bucket: str, asana: FakeAsana
) -> None:
    """Importing the same project into a second team warns instead of moving or duplicating its issues."""
    start(client)

    second = start(client, team_id=OTHER_TEAM).json()

    assert second["status"] == "completed", second
    assert team_issues(repositories, OTHER_TEAM) == []
    assert len(team_issues(repositories)) == 5
    problems = {(problem["field"], problem["message"]) for problem in second["problems"]}
    assert ("team", f"Asana task {PLAN}: imported before into another team, left there") in problems
    [project] = repositories.planning.list_projects(WORKSPACE)
    assert project.team_ids == [TEAM, OTHER_TEAM]


def test_the_queue_runs_an_asana_import_a_step_at_a_time(
    client: TestClient, repositories: Any, queued: list[tuple[str, Any]], asana: FakeAsana
) -> None:
    """Each step queues the next, the job reports its phase, and the last step deletes the token."""
    job = start(client).json()
    assert job["status"] == "queued"
    assert job["phase"] == "project"
    assert key_stored(job["import_id"])

    import_jobs.handle_record(repositories, sqs_record(dict(queued[0][1].payload)))
    middle = client.get(f"/api/workspaces/{WORKSPACE}/imports/{job['import_id']}").json()
    assert middle["status"] == "running"
    assert middle["phase"] == "tasks"
    assert (middle["phase_index"], middle["phase_count"]) == (1, 2)

    drain(repositories, queued)

    done = issue_import.load_job(WORKSPACE, job["import_id"])
    assert done is not None
    assert done.status == "completed"
    assert done.counts["issues_created"] == 5
    assert not key_stored(job["import_id"])
    [notice] = [dict(row) for row in repositories.inbox.list(WORKSPACE, ADMIN).items]
    assert notice["issue_title"] == "Imported 5 issues from Asana"


def test_a_cancelled_import_stops_and_deletes_the_token(
    client: TestClient, repositories: Any, queued: list[tuple[str, Any]], asana: FakeAsana
) -> None:
    """Cancelling keeps what was written, deletes the token, and the queued steps write nothing more."""
    job = start(client).json()
    import_jobs.handle_record(repositories, sqs_record(dict(queued[0][1].payload)))

    response = client.post(f"/api/workspaces/{WORKSPACE}/imports/{job['import_id']}/cancel")

    assert response.status_code == 200, response.text
    assert response.json()["status"] == "cancelled"
    assert not key_stored(job["import_id"])
    drain(repositories, queued)
    stored = issue_import.load_job(WORKSPACE, job["import_id"])
    assert stored is not None
    assert stored.status == "cancelled"
    assert len(repositories.planning.list_projects(WORKSPACE)) == 1
    assert team_issues(repositories) == []


def test_a_token_revoked_mid_import_fails_the_job_and_deletes_the_token(
    client: TestClient, repositories: Any, queued: list[tuple[str, Any]], asana: FakeAsana
) -> None:
    """Asana refusing the token part way through fails the job at once rather than retrying."""
    job = start(client).json()
    asana.tokens.clear()

    import_jobs.handle_record(repositories, sqs_record(dict(queued[0][1].payload)))

    stored = issue_import.load_job(WORKSPACE, job["import_id"])
    assert stored is not None
    assert (stored.status, stored.error) == ("failed", "AsanaAuthFailed")
    assert not key_stored(job["import_id"])
    assert len(queued) == 1
    [notice] = [dict(row) for row in repositories.inbox.list(WORKSPACE, ADMIN).items]
    assert notice["issue_title"] == "The import from Asana failed"


def test_a_job_whose_token_is_gone_fails(
    client: TestClient, repositories: Any, queued: list[tuple[str, Any]], asana: FakeAsana
) -> None:
    """A step that cannot open the sealed token fails the job instead of running without one."""
    job = start(client).json()
    linear_import.delete_key(WORKSPACE, job["import_id"])

    import_jobs.handle_record(repositories, sqs_record(dict(queued[0][1].payload)))

    stored = issue_import.load_job(WORKSPACE, job["import_id"])
    assert stored is not None
    assert (stored.status, stored.error) == ("failed", "KeyGone")


def test_a_sealed_token_opens_only_under_its_own_purpose(workspace: str, bucket: str, github_env: None) -> None:
    """An Asana token sealed for one import never opens as a Linear key, nor beside another import."""
    import boto3

    first, other = "01JB0000000000000000IMPRT1", "01JB0000000000000000IMPRT2"
    linear_import.seal_key(WORKSPACE, first, FAKE_TOKEN, purpose=asana_import.SEAL_PURPOSE)
    s3 = boto3.client("s3", region_name="us-west-2")
    sealed = s3.get_object(Bucket=BUCKET, Key=linear_import.key_key(WORKSPACE, first))["Body"].read()
    s3.put_object(Bucket=BUCKET, Key=linear_import.key_key(WORKSPACE, other), Body=sealed)

    assert FAKE_TOKEN.encode() not in sealed
    assert linear_import.open_key(WORKSPACE, first, purpose=asana_import.SEAL_PURPOSE) == FAKE_TOKEN
    with pytest.raises(linear_import.KeyGone):
        linear_import.open_key(WORKSPACE, first)
    with pytest.raises(linear_import.KeyGone):
        linear_import.open_key(WORKSPACE, other, purpose=asana_import.SEAL_PURPOSE)


def test_one_import_runs_per_workspace(client: TestClient, queued: list[tuple[str, Any]], asana: FakeAsana) -> None:
    """A second import waits while the first is still queued."""
    start(client)

    response = start(client)

    assert response.status_code == 409


def test_the_token_never_reaches_a_log_the_job_an_audit_row_or_stored_data(
    client: TestClient,
    repositories: Any,
    queued: list[tuple[str, Any]],
    asana: FakeAsana,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Through a whole import, a failed one and a refused token, the token appears nowhere it could leak."""
    caplog.set_level(logging.DEBUG)
    sign_in(client, ADMIN)
    listed = client.post(f"/api/workspaces/{WORKSPACE}/imports/asana/projects", json={"token": FAKE_TOKEN})
    previewed = client.post(f"/api/workspaces/{WORKSPACE}/imports/asana/preview", json=start_body())
    started = start(client)
    status = client.get(f"/api/workspaces/{WORKSPACE}/imports/{started.json()['import_id']}")
    drain(repositories, queued)
    listing = client.get(f"/api/workspaces/{WORKSPACE}/imports")
    refused = client.post(f"/api/workspaces/{WORKSPACE}/imports/asana/projects", json={"token": WRONG_TOKEN})
    second = start(client)
    asana.tokens.clear()
    drain(repositories, queued)

    assert second.status_code == 202
    logged = caplog.text + "\n".join(json.dumps(vars(record), default=str) for record in caplog.records)
    answered = "\n".join(response.text for response in (listed, previewed, started, status, listing, refused, second))
    audited = "\n".join(repr(row) for row in repositories.audit.list_events(WORKSPACE, AuditQuery()).events)
    for secret in (FAKE_TOKEN, WRONG_TOKEN):
        assert secret not in logged
        assert secret not in answered
        assert secret not in audited
        assert secret not in every_stored_row()
        assert secret not in every_stored_object()
    assert not key_stored(started.json()["import_id"])
    assert not key_stored(second.json()["import_id"])
    [row, *_] = repositories.audit.list_events(WORKSPACE, AuditQuery(action="import.started")).events
    assert row.target.label == "Asana"
    assert row.after == {"preset": "asana_api", "projects": [{"project_gid": PROJECT_GID, "team_id": TEAM}]}


def test_the_mcp_tools_list_preview_start_follow_and_cancel_an_import(
    client: TestClient, repositories: Any, queued: list[tuple[str, Any]], asana: FakeAsana
) -> None:
    """An agent with an admin's key lists Asana projects, previews, starts an import, reads it and cancels it."""
    secret = mint_for(repositories, OWNER, ("settings:read", "settings:write", "admin"))
    projects = [{"project_gid": PROJECT_GID, "team_id": "ABC"}]

    listed = answer(tool(client, secret, "list_asana_projects", {"token": FAKE_TOKEN}))
    previewed = answer(tool(client, secret, "preview_asana_import", {"token": FAKE_TOKEN, "projects": projects}))
    started = answer(tool(client, secret, "import_asana_workspace", {"token": FAKE_TOKEN, "projects": projects}))
    status = answer(tool(client, secret, "get_workspace_import", {"import_id": started["import_id"]}))
    cancelled = answer(tool(client, secret, "cancel_workspace_import", {"import_id": started["import_id"]}))
    bad_token = refusal(tool(client, secret, "list_asana_projects", {"token": WRONG_TOKEN}))
    unknown = refusal(
        tool(
            client,
            secret,
            "preview_asana_import",
            {"token": FAKE_TOKEN, "projects": [{"project_gid": "1299999999999999", "team_id": "ABC"}]},
        )
    )

    assert [project["gid"] for project in listed["projects"]] == [PROJECT_GID, ARCHIVED_GID]
    assert [plan["status_name"] for plan in previewed["projects"][0]["statuses"]] == [
        "Todo",
        "In Progress",
        "Backlog",
        "Done",
    ]
    assert (started["kind"], started["status"], started["team_id"]) == ("asana", "queued", TEAM)
    assert started["asana_projects"][0]["project_gid"] == PROJECT_GID
    assert status["import_id"] == started["import_id"]
    assert cancelled["status"] == "cancelled"
    assert not key_stored(started["import_id"])
    assert "refused" in bad_token
    assert WRONG_TOKEN not in bad_token
    assert "not readable" in unknown
    [row] = repositories.audit.list_events(WORKSPACE, AuditQuery(action="import.started")).events
    assert row.target.label == "Asana"
    assert row.after == {"preset": "asana_api", "projects": [{"project_gid": PROJECT_GID, "team_id": TEAM}]}


def test_a_member_key_cannot_import_over_mcp(
    client: TestClient, repositories: Any, bucket: str, asana: FakeAsana
) -> None:
    """The tools check the same admin capability the routes do."""
    secret = mint_for(repositories, MEMBER, ("settings:read", "settings:write", "admin"))

    refused = tool(client, secret, "list_asana_projects", {"token": FAKE_TOKEN})

    assert refused.json()["error"]["code"] == INSUFFICIENT_SCOPE
    assert asana.requests == []


def test_asana_row_ids_are_stable_and_distinct() -> None:
    """The same Asana record always maps to the same id, and never to a Linear record's or another kind's."""
    when = "2026-09-01T09:00:00.000Z"
    first = asana_import.asana_row_id(WORKSPACE, "task", PLAN, when)

    assert first == asana_import.asana_row_id(WORKSPACE, "task", int(PLAN), when)
    assert len(first) == 26
    assert first != asana_import.asana_row_id(WORKSPACE, "comment", PLAN, when)
    assert first != linear_import.linear_row_id(WORKSPACE, "issue", PLAN, when)
    assert first != asana_import.asana_row_id("01JB00000000000000000WS2", "task", PLAN, when)
