"""The Jira API importer, driven end to end against the fake Jira Cloud REST API.

Every test points `jira_import.client_factory` at `FakeJira`, which answers from a
recorded Jira site through an in-process transport, so no request leaves the test
and no real credential is used. With no queue configured an import runs inline,
so most tests start one through the route and read what it wrote back; the
queued tests drive the consumer a message at a time. What these tests watch:
each Jira field lands where it belongs, statuses map by name and then by Jira's
status category, epics become projects or parents, sprints become cycles,
sub-tasks become sub-issues, issue links become relations, searches are followed
page by page, a rate limit is waited out, a second import updates what the
first wrote, the sealed credentials are deleted whenever a job ends, and the API
token never appears in a log line, the job object, an audit row, a stored row
or an answer.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient
from webbpulse.audit import AuditQuery

from app.common import issue_import, linear_import
from app.domains.integrations import jira_api, jira_import
from app.domains.integrations.consumers import import_jobs
from app.domains.integrations.jira_api import JiraClient
from app.domains.integrations.mcp.transport import INSUFFICIENT_SCOPE
from tests.domains.helpers import ADMIN, MEMBER, OWNER, sign_in
from tests.domains.integrations.conftest import OTHER_TEAM, TEAM, WORKSPACE, sqs_record
from tests.domains.integrations.jira_fake import FAKE_EMAIL, FAKE_TOKEN, SITE, FakeJira
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal

BUCKET = "standupless-test-imports"

QUEUE = "https://sqs.us-west-2.amazonaws.com/1/issue-import"

WRONG_TOKEN = "fake-jira-api-token-wrong-0002"

ROUTE = f"/api/workspaces/{WORKSPACE}/imports/jira"

AUDITED = {
    "preset": "jira_api",
    "projects": [{"site_url": SITE, "project_key": "ENG", "jql": False, "team_id": TEAM}],
}


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
    """Every pause the Jira client took, recorded instead of slept."""
    return []


@pytest.fixture
def jira(monkeypatch: pytest.MonkeyPatch, sleeps: list[float], workspace: str) -> FakeJira:
    """The recorded Jira site, answering every Jira client the code builds."""
    fake = FakeJira()
    monkeypatch.setattr(
        jira_import,
        "client_factory",
        lambda site, email, token: JiraClient(
            url=site, email=email, token=token, transport=fake.transport(), sleep=sleeps.append
        ),
    )
    return fake


@pytest.fixture
def pointed(repositories: Any) -> None:
    """The test team on the Fibonacci scale, so story points land as estimates."""
    repositories.teams.update(WORKSPACE, TEAM, estimate_scale="fibonacci")


def signin(token: str = FAKE_TOKEN) -> dict[str, str]:
    """The site and credentials every request carries."""
    return {"site_url": "acme-example.atlassian.net", "email": FAKE_EMAIL, "token": token}


def choice(**overrides: Any) -> dict[str, Any]:
    """One project choice: the recorded ENG project into the test team, with any overrides."""
    return {"project_key": "ENG", "team_id": TEAM, **overrides}


def start_body(token: str = FAKE_TOKEN, **overrides: Any) -> dict[str, Any]:
    """The request that imports the recorded project into the test team."""
    return {**signin(token), "projects": [choice(**overrides)]}


def start(client: TestClient, token: str = FAKE_TOKEN, **overrides: Any) -> Any:
    """Start an import of the recorded project as the admin and answer the response."""
    sign_in(client, ADMIN)
    return client.post(ROUTE, json=start_body(token, **overrides))


def imported(repositories: Any, fake: FakeJira, key: str) -> Any:
    """The Standupless issue one recorded Jira issue became."""
    issue = fake.issue(key)
    row_id = jira_import.jira_row_id(WORKSPACE, "issue", issue["id"], issue["fields"]["created"])
    return repositories.issues.get(WORKSPACE, row_id)


def team_issues(repositories: Any, team_id: str = TEAM) -> list[Any]:
    """Every issue in one team."""
    return repositories.issues.read_team_newest(WORKSPACE, team_id, below=None, max_items=100)


def statuses(repositories: Any) -> dict[str, str]:
    """The test team's status ids by name."""
    return {status.name: status.status_id for status in repositories.team_config.list_statuses(WORKSPACE, TEAM)}


def status_name(repositories: Any, status_id: str) -> str:
    """The name of one of the test team's statuses."""
    return next(name for name, found in statuses(repositories).items() if found == status_id)


def label_names(repositories: Any, issue: Any) -> list[str]:
    """The names of one issue's labels, sorted."""
    labels = {label.label_id: label.name for label in repositories.team_config.list_labels(WORKSPACE, TEAM)}
    return sorted(labels[label_id] for label_id in issue.label_ids)


def problems(job: dict[str, Any]) -> set[tuple[str, str]]:
    """A job's warnings as field and message pairs."""
    return {(problem["field"], problem["message"]) for problem in job["problems"]}


def key_stored(import_id: str) -> bool:
    """Whether the sealed credentials of one import are still in the bucket."""
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
    """Every object in the import bucket but the sealed credentials, as one string."""
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


def test_the_projects_an_account_can_browse_are_listed(client: TestClient, jira: FakeJira) -> None:
    """The admin enters a site, email and token and sees the Jira projects, and nothing is stored."""
    sign_in(client, ADMIN)

    response = client.post(f"{ROUTE}/projects", json={**signin(), "token": f" {FAKE_TOKEN} "})

    assert response.status_code == 200, response.text
    assert response.json() == {
        "site_url": SITE,
        "items": [
            {
                "id": "10000",
                "key": "ENG",
                "name": "Payments",
                "project_type": "software",
                "team_managed": False,
                "archived": False,
                "url": f"{SITE}/browse/ENG",
            },
            {
                "id": "10100",
                "key": "OPS",
                "name": "Operations",
                "project_type": "business",
                "team_managed": True,
                "archived": False,
                "url": f"{SITE}/browse/OPS",
            },
        ],
    }
    assert all(request.authorized for request in jira.requests)
    assert jira.paths() == ["/rest/api/3/myself", "/rest/api/3/project/search"]


def test_refused_credentials_are_a_400_that_never_repeat_the_token(
    client: TestClient, bucket: str, jira: FakeJira
) -> None:
    """Credentials Jira refuses answer a plain refusal, and starting with them writes nothing."""
    sign_in(client, ADMIN)

    listed = client.post(f"{ROUTE}/projects", json=signin(WRONG_TOKEN))
    previewed = client.post(f"{ROUTE}/preview", json=start_body(WRONG_TOKEN))
    started = client.post(ROUTE, json=start_body(WRONG_TOKEN))

    for response in (listed, previewed, started):
        assert response.status_code == 400
        assert response.json()["error_code"] == "JIRA_CREDENTIALS_REFUSED"
        assert WRONG_TOKEN not in response.text
    assert issue_import.list_jobs(WORKSPACE) == []


@pytest.mark.parametrize(
    "site", ["https://evil.example.com", "http://acme-example.atlassian.net", "https://acme.atlassian.net.evil.io"]
)
def test_a_site_that_is_not_jira_cloud_is_refused_before_any_request(
    client: TestClient, bucket: str, jira: FakeJira, site: str
) -> None:
    """Only an `https://<site>.atlassian.net` site is ever asked, so the credentials cannot go elsewhere."""
    sign_in(client, ADMIN)

    for route, body in ((f"{ROUTE}/projects", signin()), (f"{ROUTE}/preview", start_body()), (ROUTE, start_body())):
        response = client.post(route, json={**body, "site_url": site})
        assert response.status_code == 422, response.text
    assert jira.requests == []


@pytest.mark.parametrize("route", ["imports/jira/projects", "imports/jira/preview", "imports/jira"])
def test_only_an_owner_or_admin_may_import_from_jira(
    client: TestClient, bucket: str, jira: FakeJira, route: str
) -> None:
    """A member is refused before Jira is ever asked."""
    sign_in(client, MEMBER)

    response = client.post(f"/api/workspaces/{WORKSPACE}/{route}", json=start_body())

    assert response.status_code == 403
    assert jira.requests == []


def test_the_preview_shows_where_each_status_lands_and_writes_nothing(
    client: TestClient, repositories: Any, bucket: str, jira: FakeJira
) -> None:
    """Statuses map by name, then by Jira's status category, and the story point and sprint fields are found."""
    sign_in(client, ADMIN)
    ids = statuses(repositories)

    response = client.post(f"{ROUTE}/preview", json=start_body())

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["site_url"] == SITE
    [preview] = body["projects"]
    assert (preview["project_key"], preview["name"], preview["team_id"]) == ("ENG", "Payments", TEAM)
    assert (preview["issue_count"], preview["done_count"]) == (5, 2)
    assert preview["epics_as"] == "projects"
    assert (preview["estimate_field"], preview["sprint_field"]) == ("Story point estimate", "Sprint")
    assert [(plan["source"], plan["category"], plan["status_name"]) for plan in preview["statuses"]] == [
        ("To Do", "new", "Todo"),
        ("In Progress", "indeterminate", "In Progress"),
        ("Done", "done", "Done"),
        ("In Review", "indeterminate", "In Progress"),
    ]
    assert preview["statuses"][0]["status_id"] == ids["Todo"]
    assert team_issues(repositories) == []
    assert issue_import.list_jobs(WORKSPACE) == []


def test_the_preview_follows_overrides_and_a_jql_filter(
    client: TestClient, repositories: Any, bucket: str, jira: FakeJira
) -> None:
    """An override wins over the name, and a filter narrows what is counted while dropping its ORDER BY."""
    sign_in(client, ADMIN)
    ids = statuses(repositories)
    body = start_body(jql="labels = payments ORDER BY created DESC", statuses={"In Review": ids["Backlog"]})

    response = client.post(f"{ROUTE}/preview", json=body)

    assert response.status_code == 200, response.text
    [preview] = response.json()["projects"]
    assert (preview["name"], preview["jql"]) == ("Payments (filtered)", "labels = payments")
    assert (preview["issue_count"], preview["done_count"]) == (2, 0)
    plans = {plan["source"]: plan["status_name"] for plan in preview["statuses"]}
    assert plans["In Review"] == "Backlog"
    assert 'project = "ENG" AND (labels = payments)' in jira.requests[-1].body["jql"]


def test_a_jql_filter_alone_maps_every_site_status(
    client: TestClient, repositories: Any, bucket: str, jira: FakeJira
) -> None:
    """With no project, the filter names the issues and the site's statuses are the ones to map."""
    sign_in(client, ADMIN)

    response = client.post(f"{ROUTE}/preview", json={**signin(), "projects": [{"jql": "labels = bug-bash", "team_id": TEAM}]})

    assert response.status_code == 200, response.text
    [preview] = response.json()["projects"]
    assert (preview["project_key"], preview["name"], preview["issue_count"]) == (None, "JQL filter", 1)
    assert [plan["source"] for plan in preview["statuses"]] == ["To Do", "In Progress", "In Review", "Done"]


def test_a_project_or_mapping_that_does_not_fit_is_a_422(
    client: TestClient, repositories: Any, bucket: str, jira: FakeJira
) -> None:
    """An unknown or repeated project, a refused filter, an empty choice, or a status the team lacks starts nothing."""
    sign_in(client, ADMIN)
    bodies = [
        {**signin(), "projects": [choice(project_key="NOPE")]},
        {**signin(), "projects": [choice(), choice()]},
        {**signin(), "projects": [choice(project_key="../myself")]},
        {**signin(), "projects": []},
        {**signin(), "projects": [{"team_id": TEAM}]},
        start_body(jql="summary ~ checkout"),
        start_body(epics_as="initiatives"),
        start_body(statuses={"Done": "01JB0000000000000000NOSUCH"}),
    ]

    for body in bodies:
        for route in (f"{ROUTE}/preview", ROUTE):
            response = client.post(route, json=body)
            assert response.status_code == 422, (body, response.text)
            assert FAKE_TOKEN not in response.text
    assert issue_import.list_jobs(WORKSPACE) == []
    assert team_issues(repositories) == []


def test_an_import_carries_every_issue_field(
    client: TestClient, repositories: Any, bucket: str, jira: FakeJira, pointed: None
) -> None:
    """Summary, description, status, priority, type, labels, people, dates, points, sprint, epic and link land."""
    response = start(client)

    assert response.status_code == 202, response.text
    job = response.json()
    assert (job["kind"], job["status"], job["preset"]) == ("jira", "completed", "jira_api")
    story, subtask, bug, task = (imported(repositories, jira, key) for key in ("ENG-2", "ENG-3", "ENG-4", "ENG-5"))
    assert [issue.key for issue in (story, subtask, bug, task)] == ["ABC-1", "ABC-2", "ABC-3", "ABC-4"]
    assert len(team_issues(repositories)) == 4
    assert story.title == "Add saved cards"
    assert story.body == (
        "## Goal\n\nLet buyers keep a card **on file**.\n\n- Tokenise\n- Store\n\n```python\nsave(card)\n```"
    )
    assert bug.body == "Seen by @Mel Member on 2026-09-21"
    assert task.body == "Plain text from an older client."
    assert subtask.body is None
    assert story.external_ref == f"Jira ENG-2 {SITE}/browse/ENG-2"
    assert story.import_batch_id == job["import_id"]
    assert [status_name(repositories, issue.status_id) for issue in (story, subtask, bug, task)] == [
        "In Progress",
        "Done",
        "Todo",
        "Done",
    ]
    assert [issue.priority for issue in (story, subtask, bug, task)] == ["high", "low", "urgent", "low"]
    assert (story.due_date, bug.due_date) == ("2026-10-01", None)
    assert (story.assignee_id, story.created_by) == (MEMBER, ADMIN)
    assert (subtask.assignee_id, subtask.created_by) == (None, MEMBER)
    assert (bug.assignee_id, bug.created_by) == (None, ADMIN)
    assert task.assignee_id == ADMIN
    assert story.created_at.isoformat().startswith("2026-09-01T10:00")
    assert label_names(repositories, story) == ["Story", "payments"]
    assert label_names(repositories, bug) == ["Bug", "bug-bash", "payments"]
    assert label_names(repositories, subtask) == ["Sub-task"]
    assert (story.estimate, bug.estimate, task.estimate) == ("3", "5", None)
    [project] = repositories.planning.list_projects(WORKSPACE)
    assert project.project_id == jira_import.jira_row_id(WORKSPACE, "epic", "10001", None)
    assert (project.name, project.description) == ("Checkout revamp", "Rebuild the checkout flow.")
    assert (project.status, project.lead_id, project.target_date) == ("in_progress", MEMBER, "2026-11-30")
    assert project.team_ids == [TEAM]
    assert story.project_id == project.project_id
    assert (subtask.project_id, bug.project_id) == (None, None)
    [cycle] = repositories.planning.list_cycles(WORKSPACE, TEAM)[0]
    assert (cycle.name, cycle.start_date, cycle.end_date, cycle.goal) == (
        "Sprint 2",
        "2026-09-15",
        "2026-09-28",
        "Ship saved cards",
    )
    assert story.cycle_id == cycle.cycle_id
    assert bug.cycle_id is None
    warned = problems(job)
    assert ("assignee", "ENG-3: the assignee is not a member or hides their email, left unassigned") in warned
    assert ("cycle", "ENG-4: the sprint has no dates yet, left out of a cycle") in warned


def test_sub_tasks_links_and_comments_come_across(
    client: TestClient, repositories: Any, bucket: str, jira: FakeJira
) -> None:
    """A sub-task hangs off its parent, links become relations, and comments keep author, time and markdown."""
    job = start(client).json()

    story, subtask, bug, task = (imported(repositories, jira, key) for key in ("ENG-2", "ENG-3", "ENG-4", "ENG-5"))
    assert subtask.parent_id == story.issue_id
    assert story.parent_id is None
    assert repositories.relations.get(WORKSPACE, story.issue_id, "blocks", bug.issue_id) is not None
    assert repositories.relations.get(WORKSPACE, bug.issue_id, "blocked_by", story.issue_id) is not None
    assert repositories.relations.get(WORKSPACE, bug.issue_id, "relates_to", task.issue_id) is not None
    assert repositories.relations.get(WORKSPACE, task.issue_id, "relates_to", bug.issue_id) is not None
    comments = sorted(
        repositories.comments.iter_for_issue(WORKSPACE, story.issue_id), key=lambda comment: comment.created_at
    )
    assert [(comment.author_id, comment.body) for comment in comments] == [
        (MEMBER, "First cut is [up](https://example.com/pr/1)"),
        ("jira:Riley Stranger", "Looks good to me."),
        (ADMIN, "Merging."),
    ]
    assert comments[0].created_at.isoformat().startswith("2026-09-02T11:00")
    assert all(comment.import_batch_id == job["import_id"] for comment in comments)
    [bug_comment] = repositories.comments.iter_for_issue(WORKSPACE, bug.issue_id)
    assert bug_comment.body == "Repro steps attached."
    assert job["counts"] == {
        "projects": 1,
        "issues_created": 4,
        "labels": 6,
        "cycles": 1,
        "comments": 4,
        "sub_issues": 1,
        "relations": 2,
    }
    assert (job["created_count"], job["linked_count"], job["labels_created"]) == (4, 1, 6)
    assert job["phase"] is None
    assert job["phase_index"] == job["phase_count"] == 3


def test_epics_can_become_parents_instead_of_projects(
    client: TestClient, repositories: Any, bucket: str, jira: FakeJira
) -> None:
    """With parents chosen, an epic is an issue its children hang off, and a sub-task one level deeper is refused."""
    job = start(client, epics_as="parents").json()

    assert job["status"] == "completed", job
    epic, story, subtask = (imported(repositories, jira, key) for key in ("ENG-1", "ENG-2", "ENG-3"))
    assert repositories.planning.list_projects(WORKSPACE) == []
    assert len(team_issues(repositories)) == 5
    assert label_names(repositories, epic) == ["Epic"]
    assert story.parent_id == epic.issue_id
    assert story.project_id is None
    assert subtask.parent_id is None
    assert ("parent", "ENG-3: the Jira parent cannot be its parent here, left without one") in problems(job)
    assert job["jira_projects"][0]["epics_as"] == "parents"


def test_no_account_or_invite_is_made_for_unmatched_people(
    client: TestClient, repositories: Any, bucket: str, jira: FakeJira
) -> None:
    """Placeholder authors stand in for people Jira knows and the workspace does not."""
    members_before = {member.user_id for member in repositories.memberships.list_members(WORKSPACE)}

    start(client)

    assert {member.user_id for member in repositories.memberships.list_members(WORKSPACE)} == members_before
    assert repositories.invites.list_for_workspace(WORKSPACE) == []


def test_searches_and_comments_are_followed_page_by_page(
    client: TestClient,
    repositories: Any,
    bucket: str,
    jira: FakeJira,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With two issues a page and one comment a page, every issue and comment is read to the end."""
    monkeypatch.setattr(jira_import, "PAGE_SIZE", 2)
    monkeypatch.setattr(jira_import, "SCAN_PAGE_SIZE", 2)
    monkeypatch.setattr(jira_api, "PAGE_LIMIT", 1)

    job = start(client).json()

    assert job["status"] == "completed", job
    searched = jira.searches()
    assert '(project = "ENG") ORDER BY id ASC' in searched
    assert '(project = "ENG") AND id > 10002 ORDER BY id ASC' in searched
    assert '(project = "ENG") AND id > 10004 ORDER BY id ASC' in searched
    comment_pages = [
        request.params.get("startAt") for request in jira.requests if request.path == "/rest/api/3/issue/10002/comment"
    ]
    assert comment_pages == ["0", "1", "2"]
    assert len(team_issues(repositories)) == 4
    story = imported(repositories, jira, "ENG-2")
    assert len(repositories.comments.iter_for_issue(WORKSPACE, story.issue_id)) == 3
    assert (job["counts"]["sub_issues"], job["counts"]["relations"]) == (1, 2)


def test_a_rate_limit_is_waited_out(
    client: TestClient, repositories: Any, bucket: str, jira: FakeJira, sleeps: list[float]
) -> None:
    """A 429 with a Retry-After pauses that long and retries, and the import still completes."""
    jira.rate_limit_next = 2

    job = start(client).json()

    assert job["status"] == "completed"
    assert sleeps == [3.0, 3.0]
    assert len(team_issues(repositories)) == 4


def test_a_server_error_is_retried(
    client: TestClient, repositories: Any, bucket: str, jira: FakeJira, sleeps: list[float]
) -> None:
    """A 503 is retried with a growing pause rather than failing the import."""
    jira.unavailable_next = 2

    job = start(client).json()

    assert job["status"] == "completed"
    assert sleeps == [2.0, 4.0]


def test_a_rate_limit_that_never_lifts_is_a_502(client: TestClient, jira: FakeJira, sleeps: list[float]) -> None:
    """After every retry the admin hears Jira is not answering, without the wait running forever."""
    jira.rate_limit_next = 100
    sign_in(client, ADMIN)

    response = client.post(f"{ROUTE}/projects", json=signin())

    assert response.status_code == 502
    assert response.json()["error_code"] == "JIRA_UNAVAILABLE"
    assert len(sleeps) == jira_api.MAX_ATTEMPTS - 1


def test_a_second_import_updates_instead_of_duplicating(
    client: TestClient, repositories: Any, bucket: str, jira: FakeJira
) -> None:
    """Running the import again finds every row it wrote by its Jira id and updates it in place."""
    first = start(client).json()
    keys = sorted(issue.key for issue in team_issues(repositories))
    before = imported(repositories, jira, "ENG-2")
    jira.issue("ENG-2")["fields"]["summary"] = "Add saved cards, renamed"
    jira.issue("ENG-1")["fields"]["summary"] = "Checkout revamp, renamed"

    second = start(client).json()

    assert second["import_id"] != first["import_id"]
    assert second["status"] == "completed"
    assert second["counts"]["issues_updated"] == 4
    assert second["counts"].get("issues_created", 0) == 0
    assert second["counts"].get("labels", 0) == 0
    assert second["counts"].get("relations", 0) == 0
    assert second["counts"].get("sub_issues", 0) == 0
    assert second["updated_count"] == 4
    assert sorted(issue.key for issue in team_issues(repositories)) == keys
    story = imported(repositories, jira, "ENG-2")
    assert story.issue_id == before.issue_id
    assert story.title == "Add saved cards, renamed"
    assert story.external_ref == before.external_ref
    assert len(repositories.comments.iter_for_issue(WORKSPACE, story.issue_id)) == 3
    [project] = repositories.planning.list_projects(WORKSPACE)
    assert project.name == "Checkout revamp, renamed"
    assert len(repositories.planning.list_cycles(WORKSPACE, TEAM)[0]) == 1
    names = sorted(label.name for label in repositories.team_config.list_labels(WORKSPACE, TEAM))
    assert names == ["Bug", "Story", "Sub-task", "Task", "bug-bash", "payments"]


def test_issues_imported_into_another_team_are_left_there(
    client: TestClient, repositories: Any, bucket: str, jira: FakeJira
) -> None:
    """Importing the same project into a second team warns instead of moving or duplicating its issues."""
    start(client)

    second = start(client, team_id=OTHER_TEAM).json()

    assert second["status"] == "completed", second
    assert team_issues(repositories, OTHER_TEAM) == []
    assert len(team_issues(repositories)) == 4
    assert ("team", "ENG-2: imported before into another team, left there") in problems(second)
    [project] = repositories.planning.list_projects(WORKSPACE)
    assert project.team_ids == [TEAM, OTHER_TEAM]


def test_the_queue_runs_a_jira_import_a_step_at_a_time(
    client: TestClient, repositories: Any, queued: list[tuple[str, Any]], jira: FakeJira
) -> None:
    """Each step queues the next, the job reports its phase, and the last step deletes the credentials."""
    job = start(client).json()
    assert job["status"] == "queued"
    assert job["phase"] == "epics"
    assert key_stored(job["import_id"])

    import_jobs.handle_record(repositories, sqs_record(dict(queued[0][1].payload)))
    middle = client.get(f"/api/workspaces/{WORKSPACE}/imports/{job['import_id']}").json()
    assert middle["status"] == "running"
    assert middle["phase"] == "issues"
    assert (middle["phase_index"], middle["phase_count"]) == (1, 3)

    drain(repositories, queued)

    done = issue_import.load_job(WORKSPACE, job["import_id"])
    assert done is not None
    assert done.status == "completed"
    assert done.counts["issues_created"] == 4
    assert done.counts["relations"] == 2
    assert not key_stored(job["import_id"])
    [notice] = [dict(row) for row in repositories.inbox.list(WORKSPACE, ADMIN).items]
    assert notice["issue_title"] == "Imported 4 issues from Jira"


def test_a_cancelled_import_stops_and_deletes_the_credentials(
    client: TestClient, repositories: Any, queued: list[tuple[str, Any]], jira: FakeJira
) -> None:
    """Cancelling keeps what was written, deletes the credentials, and the queued steps write nothing more."""
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


def test_a_token_revoked_mid_import_fails_the_job_and_deletes_the_credentials(
    client: TestClient, repositories: Any, queued: list[tuple[str, Any]], jira: FakeJira
) -> None:
    """Jira refusing the token part way through fails the job at once rather than retrying."""
    job = start(client).json()
    jira.accounts.clear()

    import_jobs.handle_record(repositories, sqs_record(dict(queued[0][1].payload)))

    stored = issue_import.load_job(WORKSPACE, job["import_id"])
    assert stored is not None
    assert (stored.status, stored.error) == ("failed", "JiraAuthFailed")
    assert not key_stored(job["import_id"])
    assert len(queued) == 1
    [notice] = [dict(row) for row in repositories.inbox.list(WORKSPACE, ADMIN).items]
    assert notice["issue_title"] == "The import from Jira failed"


def test_a_job_whose_credentials_are_gone_fails(
    client: TestClient, repositories: Any, queued: list[tuple[str, Any]], jira: FakeJira
) -> None:
    """A step that cannot open the sealed credentials fails the job instead of running without them."""
    job = start(client).json()
    linear_import.delete_key(WORKSPACE, job["import_id"])

    import_jobs.handle_record(repositories, sqs_record(dict(queued[0][1].payload)))

    stored = issue_import.load_job(WORKSPACE, job["import_id"])
    assert stored is not None
    assert (stored.status, stored.error) == ("failed", "KeyGone")


def test_sealed_credentials_open_only_under_their_own_purpose(workspace: str, bucket: str, github_env: None) -> None:
    """Jira credentials sealed for one import never open as a Linear key, nor beside another import."""
    import boto3

    first, other = "01JB0000000000000000IMPRT1", "01JB0000000000000000IMPRT2"
    sealed_value = jira_import.Credentials(email=FAKE_EMAIL, token=FAKE_TOKEN).sealed()
    linear_import.seal_key(WORKSPACE, first, sealed_value, purpose=jira_import.SEAL_PURPOSE)
    s3 = boto3.client("s3", region_name="us-west-2")
    sealed = s3.get_object(Bucket=BUCKET, Key=linear_import.key_key(WORKSPACE, first))["Body"].read()
    s3.put_object(Bucket=BUCKET, Key=linear_import.key_key(WORKSPACE, other), Body=sealed)

    assert FAKE_TOKEN.encode() not in sealed
    assert FAKE_EMAIL.encode() not in sealed
    opened = jira_import.Credentials.opened(
        linear_import.open_key(WORKSPACE, first, purpose=jira_import.SEAL_PURPOSE)
    )
    assert (opened.email, opened.token) == (FAKE_EMAIL, FAKE_TOKEN)
    assert FAKE_TOKEN not in repr(opened)
    with pytest.raises(linear_import.KeyGone):
        linear_import.open_key(WORKSPACE, first)
    with pytest.raises(linear_import.KeyGone):
        linear_import.open_key(WORKSPACE, other, purpose=jira_import.SEAL_PURPOSE)
    with pytest.raises(linear_import.KeyGone):
        jira_import.Credentials.opened("not json")


def test_one_import_runs_per_workspace(client: TestClient, queued: list[tuple[str, Any]], jira: FakeJira) -> None:
    """A second import waits while the first is still queued."""
    start(client)

    response = start(client)

    assert response.status_code == 409


def test_the_token_never_reaches_a_log_the_job_an_audit_row_or_stored_data(
    client: TestClient,
    repositories: Any,
    queued: list[tuple[str, Any]],
    jira: FakeJira,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Through a whole import, a failed one and refused credentials, the token appears nowhere it could leak."""
    caplog.set_level(logging.DEBUG)
    sign_in(client, ADMIN)
    listed = client.post(f"{ROUTE}/projects", json=signin())
    previewed = client.post(f"{ROUTE}/preview", json=start_body())
    started = start(client)
    status = client.get(f"/api/workspaces/{WORKSPACE}/imports/{started.json()['import_id']}")
    drain(repositories, queued)
    listing = client.get(f"/api/workspaces/{WORKSPACE}/imports")
    refused = client.post(f"{ROUTE}/projects", json=signin(WRONG_TOKEN))
    second = start(client)
    jira.accounts.clear()
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
    assert row.target.label == "Jira"
    assert row.after == AUDITED


def test_the_mcp_tools_list_preview_start_follow_and_cancel_an_import(
    client: TestClient, repositories: Any, queued: list[tuple[str, Any]], jira: FakeJira
) -> None:
    """An agent with an admin's key lists Jira projects, previews, starts an import, reads it and cancels it."""
    secret = mint_for(repositories, OWNER, ("settings:read", "settings:write", "admin"))
    projects = [{"project_key": "ENG", "team_id": "ABC"}]

    listed = answer(tool(client, secret, "list_jira_projects", signin()))
    previewed = answer(tool(client, secret, "preview_jira_import", {**signin(), "projects": projects}))
    started = answer(tool(client, secret, "import_jira_workspace", {**signin(), "projects": projects}))
    status = answer(tool(client, secret, "get_workspace_import", {"import_id": started["import_id"]}))
    cancelled = answer(tool(client, secret, "cancel_workspace_import", {"import_id": started["import_id"]}))
    bad_token = refusal(tool(client, secret, "list_jira_projects", signin(WRONG_TOKEN)))
    bad_site = refusal(tool(client, secret, "list_jira_projects", {**signin(), "site_url": "https://example.com"}))
    unknown = refusal(
        tool(
            client,
            secret,
            "preview_jira_import",
            {**signin(), "projects": [{"project_key": "NOPE", "team_id": "ABC"}]},
        )
    )

    assert listed["site_url"] == SITE
    assert [project["key"] for project in listed["projects"]] == ["ENG", "OPS"]
    assert [plan["status_name"] for plan in previewed["projects"][0]["statuses"]] == [
        "Todo",
        "In Progress",
        "Done",
        "In Progress",
    ]
    assert (started["kind"], started["status"], started["team_id"]) == ("jira", "queued", TEAM)
    assert started["jira_projects"][0]["project_key"] == "ENG"
    assert status["import_id"] == started["import_id"]
    assert cancelled["status"] == "cancelled"
    assert not key_stored(started["import_id"])
    assert "refused" in bad_token
    assert WRONG_TOKEN not in bad_token
    assert "Jira Cloud site" in bad_site
    assert "not one this account can browse" in unknown
    [row] = repositories.audit.list_events(WORKSPACE, AuditQuery(action="import.started")).events
    assert row.target.label == "Jira"
    assert row.after == AUDITED


def test_a_member_key_cannot_import_over_mcp(client: TestClient, repositories: Any, bucket: str, jira: FakeJira) -> None:
    """The tools check the same admin capability the routes do."""
    secret = mint_for(repositories, MEMBER, ("settings:read", "settings:write", "admin"))

    refused = tool(client, secret, "list_jira_projects", signin())

    assert refused.json()["error"]["code"] == INSUFFICIENT_SCOPE
    assert jira.requests == []


def test_jira_row_ids_are_stable_and_distinct() -> None:
    """The same Jira record always maps to the same id, and never to a Linear record's or another kind's."""
    when = "2026-09-01T10:00:00.000+0000"
    first = jira_import.jira_row_id(WORKSPACE, "issue", "10002", when)

    assert first == jira_import.jira_row_id(WORKSPACE, "issue", 10002, when)
    assert len(first) == 26
    assert first != jira_import.jira_row_id(WORKSPACE, "comment", "10002", when)
    assert first != linear_import.linear_row_id(WORKSPACE, "issue", "10002", when)
    assert first != jira_import.jira_row_id("01JB00000000000000000WS2", "issue", "10002", when)


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("acme-example.atlassian.net", SITE),
        ("https://Acme-Example.atlassian.net/", SITE),
        ("https://acme-example.atlassian.net/jira", SITE),
    ],
)
def test_a_jira_cloud_site_is_normalised(value: str, expected: str) -> None:
    """A pasted site, with or without a scheme or trailing path, becomes the bare site URL."""
    assert jira_api.site_url(value) == expected


@pytest.mark.parametrize(
    "value",
    [
        "https://acme-example.atlassian.net:8443",
        "https://user:pass@acme-example.atlassian.net",
        "https://acme-example.atlassian.net/rest/api/3",
        "https://atlassian.net",
        "ftp://acme-example.atlassian.net",
    ],
)
def test_anything_but_a_jira_cloud_site_is_refused(value: str) -> None:
    """A port, user info, a path, a bare domain or another scheme never becomes a site to send credentials to."""
    with pytest.raises(jira_api.InvalidSite):
        jira_api.site_url(value)
