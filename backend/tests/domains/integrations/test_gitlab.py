"""GitLab merge request linking: connecting a group or project, the receiver, and the consumer.

The one call to GitLab is replaced at `gitlab.api.fetch`, so nothing here leaves
the process. The consumer is driven through `handle_record`, the same entry the
queue reaches, so the link rows and the transitions are the ones a real delivery
would write.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Mapping

import pytest
from fastapi.testclient import TestClient
from webbpulse.audit import AuditQuery

from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.gitlab import GitlabConnection, gitlab_connection_key
from app.common.db.dynamo.team_config import Transition, new_config_id, transition_key
from app.domains.integrations.consumers import events
from app.domains.integrations.gitlab import api, tokens
from app.domains.integrations.gitlab import events as gitlab_events
from tests.domains.helpers import ADMIN, MEMBER, sign_in
from tests.domains.integrations.conftest import TEAM, WORKSPACE, sqs_record

TOKEN = "glpat-a-test-access-token-0000WXYZ"

CONNECTION = "01JB0000000000000000GLCONN"

SECRET = "a-test-gitlab-webhook-secret"

PROJECT_ID = 77

PROJECT_PATH = "acme/web"


class FakeGitlab:
    """Answers the scope read the way GitLab does, and records every request."""

    def __init__(self) -> None:
        """Start answering with a readable group."""
        self.status = 200
        self.record: dict[str, Any] = {
            "id": 1234,
            "full_path": "acme",
            "full_name": "Acme",
            "web_url": "https://gitlab.com/groups/acme",
        }
        self.calls: list[tuple[str, dict[str, str]]] = []

    def __call__(self, url: str, headers: Mapping[str, str]) -> tuple[int, str]:
        """Answer one read."""
        self.calls.append((url, dict(headers)))
        return self.status, json.dumps(self.record)


@pytest.fixture
def gitlab(monkeypatch: pytest.MonkeyPatch) -> FakeGitlab:
    """The GitLab every connection check reaches."""
    fake = FakeGitlab()
    monkeypatch.setattr(api, "fetch", fake)
    return fake


def _connect(client: TestClient, **overrides: Any) -> Any:
    """Connect the `acme` group as an admin."""
    sign_in(client, ADMIN)
    body = {"instance_url": "", "scope_kind": "group", "scope_path": "acme", "access_token": TOKEN, **overrides}
    return client.post(f"/api/workspaces/{WORKSPACE}/gitlab/connections", json=body)


def test_connecting_checks_the_token_and_shows_the_secret_once(
    client: TestClient, workspace: str, gitlab: FakeGitlab, repositories: Any, caplog: pytest.LogCaptureFixture
) -> None:
    """The token is checked against GitLab, sealed on the row, and never answered or logged."""
    caplog.set_level(logging.DEBUG)
    response = _connect(client)
    assert response.status_code == 201, response.text
    created = response.json()
    assert created["scope_path"] == "acme" and created["scope_id"] == "1234"
    assert created["instance_url"] == "https://gitlab.com"
    assert created["token_hint"] == "WXYZ"
    assert created["webhook_secret"]
    assert created["webhook_url"].endswith(f"/api/gitlab/webhooks/{WORKSPACE}/{created['connection_id']}")
    assert TOKEN not in response.text

    [(url, headers)] = gitlab.calls
    assert url == "https://gitlab.com/api/v4/groups/acme?with_projects=false"
    assert headers["PRIVATE-TOKEN"] == TOKEN

    stored = repositories.github.gitlab.get(WORKSPACE, created["connection_id"])
    assert stored is not None
    assert TOKEN not in json.dumps(stored.model_dump(mode="json"))
    assert created["webhook_secret"] not in json.dumps(stored.model_dump(mode="json"))
    assert tokens.open_token(stored) == TOKEN
    assert TOKEN not in caplog.text

    listed = client.get(f"/api/workspaces/{WORKSPACE}/gitlab/connections")
    assert listed.status_code == 200
    assert listed.json()["configured"] is True
    [row] = listed.json()["connections"]
    assert "webhook_secret" not in row
    assert TOKEN not in listed.text and created["webhook_secret"] not in listed.text

    [entry] = repositories.audit.list_events(WORKSPACE, AuditQuery(action="gitlab.connected")).events
    assert entry.actor.id == ADMIN and entry.target.id == created["connection_id"]
    assert TOKEN not in json.dumps(dict(entry.after or {}))


def test_a_project_connection_reads_the_project(client: TestClient, workspace: str, gitlab: FakeGitlab) -> None:
    """A project is read at the projects endpoint of a self-managed instance, its path kept."""
    gitlab.record = {"id": PROJECT_ID, "path_with_namespace": PROJECT_PATH, "name_with_namespace": "Acme / Web"}
    response = _connect(
        client, instance_url="https://code.example.com/gitlab/", scope_kind="project", scope_path=PROJECT_PATH
    )
    assert response.status_code == 201, response.text
    assert response.json()["instance_url"] == "https://code.example.com/gitlab"
    assert gitlab.calls[0][0] == "https://code.example.com/gitlab/api/v4/projects/acme%2Fweb"


@pytest.mark.parametrize(
    ("status_code", "error_code"),
    [(401, "GITLAB_TOKEN_REJECTED"), (404, "GITLAB_SCOPE_NOT_FOUND"), (403, "GITLAB_SCOPE_NOT_FOUND")],
)
def test_a_connection_gitlab_refuses_is_not_stored(
    client: TestClient, workspace: str, gitlab: FakeGitlab, repositories: Any, status_code: int, error_code: str
) -> None:
    """A rejected token or a scope the token cannot read is a 422 and leaves no row."""
    gitlab.status = status_code
    response = _connect(client)
    assert response.status_code == 422
    assert response.json()["error_code"] == error_code
    assert TOKEN not in response.text
    assert repositories.github.gitlab.list(WORKSPACE) == []


@pytest.mark.parametrize(
    "instance_url", ["http://gitlab.example.com", "https://127.0.0.1", "https://localhost", "https://x.com/?a=1"]
)
def test_an_unsafe_instance_is_refused_before_any_call(
    client: TestClient, workspace: str, gitlab: FakeGitlab, instance_url: str
) -> None:
    """An instance that is not public https is refused without GitLab being called."""
    response = _connect(client, instance_url=instance_url)
    assert response.status_code == 422
    assert response.json()["error_code"] == "GITLAB_INSTANCE_INVALID"
    assert gitlab.calls == []


def test_the_same_scope_cannot_be_connected_twice(client: TestClient, workspace: str, gitlab: FakeGitlab) -> None:
    """A second connection to the same group on the same instance is a conflict."""
    assert _connect(client).status_code == 201
    assert _connect(client).status_code == 409


def test_without_a_master_key_gitlab_cannot_be_connected(
    client: TestClient, workspace: str, gitlab: FakeGitlab, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An environment that cannot seal a token says so instead of storing one in plaintext."""
    monkeypatch.setattr(tokens, "configured", lambda: False)
    assert _connect(client).status_code == 409
    listed = client.get(f"/api/workspaces/{WORKSPACE}/gitlab/connections")
    assert listed.json()["configured"] is False
    assert gitlab.calls == []


def test_a_member_cannot_manage_connections(client: TestClient, workspace: str, gitlab: FakeGitlab) -> None:
    """Connections are workspace admin settings."""
    sign_in(client, MEMBER)
    base = f"/api/workspaces/{WORKSPACE}/gitlab/connections"
    assert client.get(base).status_code == 403
    body = {"scope_kind": "group", "scope_path": "acme", "access_token": TOKEN}
    assert client.post(base, json=body).status_code == 403
    assert gitlab.calls == []


def _deliver(
    client: TestClient,
    connection_id: str,
    secret: str,
    body: Mapping[str, Any] | None = None,
    *,
    event: str = "Merge Request Hook",
    uuid: str = "uuid-1",
) -> Any:
    """Post one delivery to a connection's receiver the way GitLab does."""
    return client.post(
        f"/api/gitlab/webhooks/{WORKSPACE}/{connection_id}",
        content=json.dumps(body if body is not None else merge_request()),
        headers={"X-Gitlab-Token": secret, "X-Gitlab-Event": event, "X-Gitlab-Event-UUID": uuid},
    )


def test_the_receiver_checks_the_secret_and_queues_a_merge_request_once(
    client: TestClient, workspace: str, gitlab: FakeGitlab, enqueued: list[tuple[str, Any]]
) -> None:
    """A wrong secret is 401, another hook is ignored, a replay is a duplicate, and one delivery is queued."""
    created = _connect(client).json()
    connection_id, secret = created["connection_id"], created["webhook_secret"]

    assert _deliver(client, connection_id, "wrong").status_code == 401
    assert _deliver(client, "01JB00000000000000000NOPE", secret).status_code == 401
    ignored = _deliver(client, connection_id, secret, event="Push Hook")
    assert ignored.status_code == 200 and ignored.json()["reason"] == "ignored"
    assert enqueued == []

    accepted = _deliver(client, connection_id, secret)
    assert accepted.status_code == 202
    [(_, envelope)] = enqueued
    assert envelope.name == "gitlab.merge_request"
    assert envelope.payload["workspace_id"] == WORKSPACE
    assert envelope.payload["connection_id"] == connection_id
    assert envelope.payload["body"]["object_kind"] == "merge_request"

    replay = _deliver(client, connection_id, secret)
    assert replay.status_code == 200 and replay.json()["reason"] == "duplicate"
    assert len(enqueued) == 1


def test_rotating_the_secret_retires_the_old_one(
    client: TestClient, workspace: str, gitlab: FakeGitlab, enqueued: list[tuple[str, Any]], repositories: Any
) -> None:
    """The new secret is shown once and the old one is refused from then on."""
    created = _connect(client).json()
    connection_id = created["connection_id"]
    rotated = client.post(f"/api/workspaces/{WORKSPACE}/gitlab/connections/{connection_id}/rotate-secret")
    assert rotated.status_code == 200, rotated.text
    fresh = rotated.json()["webhook_secret"]
    assert fresh and fresh != created["webhook_secret"]
    assert rotated.json()["secret_rotated_at"] is not None

    assert _deliver(client, connection_id, created["webhook_secret"]).status_code == 401
    assert _deliver(client, connection_id, fresh, uuid="uuid-2").status_code == 202
    [entry] = repositories.audit.list_events(WORKSPACE, AuditQuery(action="gitlab.secret_rotated")).events
    assert entry.target.id == connection_id


def test_disconnecting_stops_deliveries(
    client: TestClient, workspace: str, gitlab: FakeGitlab, enqueued: list[tuple[str, Any]], repositories: Any
) -> None:
    """A removed connection's row and sealed token are gone, and its receiver refuses deliveries."""
    created = _connect(client).json()
    connection_id = created["connection_id"]
    base = f"/api/workspaces/{WORKSPACE}/gitlab/connections/{connection_id}"
    assert client.delete(base).status_code == 204
    assert repositories.github.gitlab.get(WORKSPACE, connection_id) is None
    assert client.delete(base).status_code == 404
    assert _deliver(client, connection_id, created["webhook_secret"]).status_code == 401
    assert enqueued == []
    [entry] = repositories.audit.list_events(WORKSPACE, AuditQuery(action="gitlab.disconnected")).events
    assert entry.actor.id == ADMIN and entry.target.id == connection_id


def merge_request(
    *,
    action: str = "open",
    state: str = "opened",
    title: str = "ABC-1 a change",
    description: str = "",
    branch: str = "work",
    target: str = "main",
    draft: bool = False,
    updated_at: str = "2026-10-25 10:00:00 UTC",
    project_path: str = PROJECT_PATH,
    source_project_id: int = PROJECT_ID,
    changes: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """One merge request hook body, in the shape GitLab sends it."""
    return {
        "object_kind": "merge_request",
        "event_type": "merge_request",
        "user": {"username": "someone"},
        "project": {"id": PROJECT_ID, "path_with_namespace": project_path},
        "object_attributes": {
            "iid": 5,
            "title": title,
            "description": description,
            "source_branch": branch,
            "target_branch": target,
            "state": state,
            "action": action,
            "draft": draft,
            "url": f"https://gitlab.com/{project_path}/-/merge_requests/5",
            "source_project_id": source_project_id,
            "target_project_id": PROJECT_ID,
            "updated_at": updated_at,
        },
        "changes": dict(changes or {}),
    }


@pytest.fixture
def connection(repositories: Any, workspace: str) -> GitlabConnection:
    """A stored connection to the `acme` group on gitlab.com."""
    row = GitlabConnection(
        workspace_id=WORKSPACE,
        github_key=gitlab_connection_key(CONNECTION),
        connection_id=CONNECTION,
        instance_url="https://gitlab.com",
        scope_kind="group",
        scope_id="1234",
        scope_path="acme",
        token_ciphertext="sealed",
        token_nonce="nonce",
        token_salt="salt",
        token_scheme="test",
        webhook_secret_hash=tokens.secret_digest(SECRET),
        connected_by=ADMIN,
    )
    assert repositories.github.gitlab.create(row)
    return row


def _handle(repositories: Any, body: Mapping[str, Any]) -> None:
    """Run one queued merge request event through the consumer."""
    payload = {
        "event": "gitlab.merge_request",
        "workspace_id": WORKSPACE,
        "connection_id": CONNECTION,
        "delivery": "g1",
        "body": dict(body),
    }
    events.handle_record(repositories, sqs_record(payload))


def _links(repositories: Any, issue_id: str) -> list[dict[str, Any]]:
    """Every link row on one issue."""
    return list(repositories.github.list_links_for_issue(WORKSPACE, issue_id).items)


def _status(repositories: Any, issue_id: str) -> str:
    """One issue's current status id."""
    current = repositories.issues.get(WORKSPACE, issue_id)
    assert current is not None
    return current.status_id


@pytest.fixture
def status_ids(repositories: Any, workspace: str) -> dict[str, str]:
    """The seeded team's statuses, by category."""
    return {status.category: status.status_id for status in repositories.team_config.list_statuses(workspace, TEAM)}


def _add_rule(repositories: Any, trigger: str, status_id: str, branch_pattern: str = "") -> None:
    """Store one transition rule on the seeded team."""
    transition_id = new_config_id()
    repositories.team_config.create_transition(
        Transition(
            workspace_id=WORKSPACE,
            config_key=transition_key(TEAM, transition_id),
            team_id=TEAM,
            transition_id=transition_id,
            trigger=trigger,
            status_id=status_id,
            branch_pattern=branch_pattern,
        )
    )


def test_an_opened_merge_request_links_and_starts_the_issue(
    repositories: Any, connection: GitlabConnection, issue: Any, status_ids: dict[str, str], github_env: None
) -> None:
    """A key in the title links the merge request as a GitLab link and moves the issue to started."""
    _handle(repositories, merge_request())
    [link] = _links(repositories, issue.issue_id)
    assert link["provider"] == "gitlab"
    assert link["pr_number"] == 5 and link["pr_state"] == "open"
    assert link["repository_full_name"] == PROJECT_PATH
    assert link["head_ref"] == "work" and link["base_ref"] == "main"
    assert link["author_login"] == "someone"
    assert link["link_id"].startswith("gitlab_")
    assert _status(repositories, issue.issue_id) == status_ids["started"]


def test_the_link_reads_as_gitlab(
    client: TestClient, repositories: Any, connection: GitlabConnection, issue: Any, github_env: None
) -> None:
    """The issue's link list says which provider each link came from."""
    _handle(repositories, merge_request())
    sign_in(client, MEMBER)
    response = client.get(f"/api/workspaces/{WORKSPACE}/issues/{issue.issue_id}/github-links")
    assert response.status_code == 200, response.text
    [row] = response.json()["items"]
    assert row["provider"] == "gitlab"


def test_a_draft_links_without_moving_until_it_is_ready(
    repositories: Any, connection: GitlabConnection, issue: Any, status_ids: dict[str, str], github_env: None
) -> None:
    """A draft does not start the work, and leaving draft fires the ready for review rule."""
    _add_rule(repositories, "pr_ready_for_review", status_ids["started"])
    before = _status(repositories, issue.issue_id)
    _handle(repositories, merge_request(draft=True))
    [link] = _links(repositories, issue.issue_id)
    assert link["pr_state"] == "draft"
    assert _status(repositories, issue.issue_id) == before

    ready = merge_request(
        action="update",
        updated_at="2026-10-25 11:00:00 UTC",
        changes={"draft": {"previous": True, "current": False}},
    )
    _handle(repositories, ready)
    assert _status(repositories, issue.issue_id) == status_ids["started"]
    [link] = _links(repositories, issue.issue_id)
    assert link["pr_state"] == "open"


def test_a_merge_that_fixes_the_issue_completes_it(
    repositories: Any, connection: GitlabConnection, issue: Any, status_ids: dict[str, str], github_env: None
) -> None:
    """A merged merge request whose description says Fixes moves the issue to completed."""
    _handle(repositories, merge_request(description="Fixes ABC-1"))
    _handle(
        repositories,
        merge_request(action="merge", state="merged", description="Fixes ABC-1", updated_at="2026-10-25 12:00:00 UTC"),
    )
    [link] = _links(repositories, issue.issue_id)
    assert link["pr_state"] == "merged"
    assert _status(repositories, issue.issue_id) == status_ids["completed"]


def test_a_merge_without_a_magic_word_does_not_complete(
    repositories: Any, connection: GitlabConnection, issue: Any, status_ids: dict[str, str], github_env: None
) -> None:
    """A default team closes on merge only when the merge request says so, as on GitHub."""
    _handle(repositories, merge_request(action="merge", state="merged"))
    assert _status(repositories, issue.issue_id) != status_ids["completed"]


def test_a_closed_merge_request_is_recorded_closed(
    repositories: Any, connection: GitlabConnection, issue: Any, github_env: None
) -> None:
    """Closing without merging marks the link closed."""
    _handle(repositories, merge_request())
    _handle(repositories, merge_request(action="close", state="closed", updated_at="2026-10-25 12:00:00 UTC"))
    [link] = _links(repositories, issue.issue_id)
    assert link["pr_state"] == "closed"


def test_a_merge_follows_the_rule_for_its_target_branch(
    repositories: Any, connection: GitlabConnection, issue: Any, status_ids: dict[str, str], github_env: None
) -> None:
    """A per branch merge rule is picked by the branch the merge request targets."""
    _add_rule(repositories, "pr_merged", status_ids["started"], "staging")
    _add_rule(repositories, "pr_merged", status_ids["completed"], "main")
    _handle(repositories, merge_request(action="merge", state="merged", target="staging", title="Fixes ABC-1"))
    assert _status(repositories, issue.issue_id) == status_ids["started"]


def test_an_older_delivery_does_not_overwrite_a_newer_one(
    repositories: Any, connection: GitlabConnection, issue: Any, github_env: None
) -> None:
    """Links are ordered on the merge request's own updated time, so a late open cannot reopen a merge."""
    _handle(repositories, merge_request(action="merge", state="merged", updated_at="2026-10-25 12:00:00 UTC"))
    _handle(repositories, merge_request(updated_at="2026-10-25 09:00:00 UTC"))
    [link] = _links(repositories, issue.issue_id)
    assert link["pr_state"] == "merged"


def test_a_fork_merge_request_links_nothing(
    repositories: Any, connection: GitlabConnection, issue: Any, github_env: None
) -> None:
    """A merge request from another project's fork is ignored."""
    _handle(repositories, merge_request(source_project_id=999))
    assert _links(repositories, issue.issue_id) == []


def test_a_project_outside_the_connection_links_nothing(
    repositories: Any, connection: GitlabConnection, issue: Any, github_env: None
) -> None:
    """A project that is not under the connected group is not acted on."""
    _handle(repositories, merge_request(project_path="acme-other/web"))
    assert _links(repositories, issue.issue_id) == []


def test_a_removed_connection_links_nothing(
    repositories: Any, connection: GitlabConnection, issue: Any, github_env: None
) -> None:
    """A delivery queued before the connection was removed does nothing."""
    repositories.github.gitlab.delete(WORKSPACE, CONNECTION)
    _handle(repositories, merge_request())
    assert _links(repositories, issue.issue_id) == []


def test_removing_the_key_detaches_the_link(
    repositories: Any, connection: GitlabConnection, issue: Any, github_env: None
) -> None:
    """An edit that drops the key from the title and branch detaches the link."""
    _handle(repositories, merge_request())
    _handle(repositories, merge_request(action="update", title="a change", updated_at="2026-10-25 11:00:00 UTC"))
    [link] = _links(repositories, issue.issue_id)
    assert link.get("detached")


@pytest.mark.parametrize(
    ("action", "draft", "changes", "expected"),
    [
        ("open", False, {}, "pr_opened"),
        ("reopen", False, {}, "pr_opened"),
        ("open", True, {}, None),
        ("merge", False, {}, "pr_merged"),
        ("close", False, {}, "pr_closed"),
        ("update", False, {"draft": {"previous": True, "current": False}}, "pr_ready_for_review"),
        ("update", True, {"draft": {"previous": False, "current": True}}, None),
        ("update", False, {"title": {"previous": "a", "current": "b"}}, None),
        ("approved", False, {}, None),
    ],
)
def test_each_action_maps_to_its_trigger(
    action: str, draft: bool, changes: dict[str, Any], expected: str | None
) -> None:
    """GitLab's merge request actions map onto the GitHub triggers a team's rules name."""
    assert gitlab_events.trigger_for(action, draft=draft, changes=changes) == expected


def test_the_row_keeps_no_plaintext_secret(repositories: Any, connection: GitlabConnection) -> None:
    """Only the digest of the webhook secret is stored, and it matches in constant time."""
    stored = repositories.github.gitlab.get(WORKSPACE, CONNECTION)
    assert stored is not None
    assert SECRET not in json.dumps(stored.model_dump(mode="json"))
    assert tokens.secret_matches(stored, SECRET)
    assert not tokens.secret_matches(stored, "wrong")
    assert not tokens.secret_matches(stored, None)
    assert stored.connected_at <= utc_now()
