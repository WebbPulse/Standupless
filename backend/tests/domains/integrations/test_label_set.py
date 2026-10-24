"""The workspace label set pushed to every repository the installation can see.

Pushes run through the dispatch consumer, label changes through the stream
consumer's handler and repository additions through the events consumer, so each
test takes the routing a deployed function takes. Every GitHub call is patched at
`github_issues` with a fake holding each repository's labels the way GitHub would.
"""

from __future__ import annotations

from typing import Any

import pytest
from boto3.dynamodb.types import TypeSerializer
from fastapi.testclient import TestClient
from webbpulse.audit import AuditQuery

from app.common.db.dynamo.base import as_item, utc_now
from app.common.db.dynamo.github import (
    LabelSetSetting,
    LabelSync,
    Repository_,
    TeamSync,
    label_sync_key,
    repo_key,
    team_sync_key,
)
from app.common.db.dynamo.team_config import WORKSPACE_SCOPE, Label, label_key, workspace_label_key
from app.domains.integrations import label_set, label_sync
from app.domains.integrations.consumers import dispatch, events, stream
from tests.domains.helpers import ADMIN, MEMBER, sign_in
from tests.domains.integrations.conftest import (
    INSTALLATION_ID,
    REPOSITORY_FULL_NAME,
    REPOSITORY_ID,
    TEAM,
    WORKSPACE,
    sqs_record,
)
from tests.domains.integrations.test_label_sync import FakeLabels

SERIALIZER = TypeSerializer()

SECOND_REPOSITORY = "9002"

PUBLIC_REPOSITORY = "9003"


class FakeRepositories:
    """Every repository's labels, each held by its own `FakeLabels`, with an optional error on listing."""

    def __init__(self) -> None:
        """Start every repository empty."""
        self.repositories: dict[str, FakeLabels] = {}
        self.list_error: Exception | None = None

    def of(self, repository_id: str) -> FakeLabels:
        """The labels of one repository."""
        return self.repositories.setdefault(repository_id, FakeLabels())

    def installation_token(self, installation_id: str) -> str:
        """A placeholder token."""
        return "ghs_test"

    def list_labels(self, token: str, repository_id: str, **kwargs: Any) -> list[dict[str, Any]]:
        """Every label one repository holds, or the configured error."""
        if self.list_error is not None:
            raise self.list_error
        return self.of(repository_id).list_labels(token, repository_id, **kwargs)

    def create_label(self, token: str, repository_id: str, *args: Any, **kwargs: Any) -> bool:
        """Add a label to one repository."""
        return self.of(repository_id).create_label(token, repository_id, *args, **kwargs)

    def update_label(self, token: str, repository_id: str, *args: Any, **kwargs: Any) -> bool:
        """Change a label of one repository."""
        return self.of(repository_id).update_label(token, repository_id, *args, **kwargs)

    def delete_label(self, token: str, repository_id: str, *args: Any, **kwargs: Any) -> None:
        """Remove a label from one repository."""
        self.of(repository_id).delete_label(token, repository_id, *args, **kwargs)


@pytest.fixture
def github(monkeypatch: pytest.MonkeyPatch) -> FakeRepositories:
    """Patch every GitHub call the label writes make."""
    fake = FakeRepositories()
    for name in ("installation_token", "list_labels", "create_label", "update_label", "delete_label"):
        monkeypatch.setattr(label_sync.github_issues, name, getattr(fake, name))
    return fake


@pytest.fixture
def queued(monkeypatch: pytest.MonkeyPatch) -> list[tuple[dict[str, Any], int]]:
    """Every label set page queued, with the delay it was queued under."""
    sent: list[tuple[dict[str, Any], int]] = []

    def record(name: str, payload: dict[str, Any], workspace_id: str, *, delay_seconds: int = 0) -> None:
        """Capture one queued page."""
        sent.append((dict(payload), delay_seconds))

    monkeypatch.setattr(label_set, "_enqueue", record)
    return sent


@pytest.fixture
def repos(repositories: Any, installed: str, github_env: None) -> list[str]:
    """The installation's repository plus a second private one and a public one."""
    for repository_id, private in ((SECOND_REPOSITORY, True), (PUBLIC_REPOSITORY, False)):
        repositories.github.put_repository(
            Repository_(
                workspace_id=WORKSPACE,
                github_key=repo_key(repository_id),
                repository_id=repository_id,
                installation_id=INSTALLATION_ID,
                full_name=f"WebbPulse/repo-{repository_id}",
                name=f"repo-{repository_id}",
                private=private,
                linked_at=utc_now(),
            )
        )
    return [REPOSITORY_ID, SECOND_REPOSITORY, PUBLIC_REPOSITORY]


def turn_on(repositories: Any, *, include_public: bool = False) -> None:
    """Turn the workspace label set on."""
    repositories.github.put_label_set(
        LabelSetSetting(workspace_id=WORKSPACE, enabled=True, include_public=include_public, updated_by=ADMIN)
    )


def add_workspace_label(repositories: Any, label_id: str, name: str, color: str, **fields: Any) -> Label:
    """Add one workspace label every team inherits."""
    return repositories.team_config.create_label(
        Label(
            workspace_id=WORKSPACE,
            config_key=workspace_label_key(label_id),
            label_id=label_id,
            name=name,
            color=color,
            scope=WORKSPACE_SCOPE,
            **fields,
        )
    )


def push(repositories: Any, **job: Any) -> None:
    """Run one label set page through the dispatch consumer."""
    dispatch.handle_record(
        repositories, sqs_record({"kind": label_set.LABEL_SET_JOB, "workspace_id": WORKSPACE, "after": "", **job})
    )


def test_the_push_writes_workspace_labels_to_every_private_repository(
    repositories: Any, repos: list[str], github: FakeRepositories, queued: list[Any]
) -> None:
    """Each private repository gets every workspace label, public ones are left out, and a rerun writes nothing."""
    turn_on(repositories)
    add_workspace_label(repositories, "ws-bug", "bug", "#ff0000", description="Something broke")
    add_workspace_label(repositories, "ws-area", "Area", "#000000", is_group=True)
    add_workspace_label(repositories, "ws-api", "api", "#00ff00", parent_id="ws-area")

    push(repositories)

    for repository_id in (REPOSITORY_ID, SECOND_REPOSITORY):
        assert github.of(repository_id).labels["bug"] == {
            "name": "bug",
            "color": "ff0000",
            "description": "Something broke",
        }
        assert "area/api" in github.of(repository_id).labels
        rows = repositories.github.list_label_syncs(WORKSPACE, repository_id)
        assert {row.label_id for row in rows} == {"ws-bug", "ws-api"}
        assert all(row.team_id == "" and row.created for row in rows)
    assert github.of(PUBLIC_REPOSITORY).calls == []
    assert queued == []

    for fake in github.repositories.values():
        fake.calls.clear()
    push(repositories)
    assert all(fake.calls == [] for fake in github.repositories.values())


def test_public_repositories_are_included_when_the_admin_says_so(
    repositories: Any, repos: list[str], github: FakeRepositories, queued: list[Any]
) -> None:
    """With public repositories included, the public one carries the labels too."""
    turn_on(repositories, include_public=True)
    add_workspace_label(repositories, "ws-bug", "bug", "#ff0000")

    push(repositories)

    assert "bug" in github.of(PUBLIC_REPOSITORY).labels


def test_a_repository_a_team_syncs_labels_with_is_left_to_that_team(
    repositories: Any, repos: list[str], github: FakeRepositories, queued: list[Any]
) -> None:
    """The team's reconcile owns its repository's labels, so the push writes nothing there."""
    repositories.github.put_team_sync(
        TeamSync(
            workspace_id=WORKSPACE,
            github_key=team_sync_key(TEAM),
            team_id=TEAM,
            repository_id=REPOSITORY_ID,
            full_name=REPOSITORY_FULL_NAME,
            created_by=ADMIN,
        )
    )
    turn_on(repositories)
    add_workspace_label(repositories, "ws-bug", "bug", "#ff0000")

    push(repositories)

    assert github.of(REPOSITORY_ID).calls == []
    assert "bug" in github.of(SECOND_REPOSITORY).labels


def test_a_deleted_workspace_label_is_removed_only_where_standupless_created_it(
    repositories: Any, repos: list[str], github: FakeRepositories, queued: list[Any]
) -> None:
    """A label adopted by name stays on GitHub when its workspace label goes; a created one is deleted."""
    github.of(REPOSITORY_ID).labels["bug"] = {"name": "bug", "color": "cccccc", "description": None}
    turn_on(repositories)
    add_workspace_label(repositories, "ws-bug", "bug", "#ff0000")

    push(repositories)
    assert repositories.github.list_label_syncs(WORKSPACE, REPOSITORY_ID)[0].created is False
    repositories.team_config.delete_workspace_label(WORKSPACE, "ws-bug")
    push(repositories)

    assert "bug" in github.of(REPOSITORY_ID).labels
    assert "bug" not in github.of(SECOND_REPOSITORY).labels
    assert ("delete", "bug") in github.of(SECOND_REPOSITORY).calls
    assert repositories.github.list_label_syncs(WORKSPACE, REPOSITORY_ID) == []
    assert repositories.github.list_label_syncs(WORKSPACE, SECOND_REPOSITORY) == []


def test_a_team_label_row_is_never_deleted_by_the_push(
    repositories: Any, repos: list[str], github: FakeRepositories, queued: list[Any]
) -> None:
    """A row a team once wrote for its own label is not the push's to forget."""
    repositories.team_config.create_label(
        Label(
            workspace_id=WORKSPACE,
            config_key=label_key(TEAM, "team-only"),
            team_id=TEAM,
            label_id="team-only",
            name="team-only",
            color="#123456",
        )
    )
    github.of(SECOND_REPOSITORY).labels["team-only"] = {"name": "team-only", "color": "123456", "description": ""}
    repositories.github.save_label_sync(
        LabelSync(
            workspace_id=WORKSPACE,
            github_key=label_sync_key(SECOND_REPOSITORY, "team-only"),
            team_id=TEAM,
            repository_id=SECOND_REPOSITORY,
            label_id="team-only",
            name="team-only",
            color="123456",
            created=True,
        )
    )
    turn_on(repositories)

    push(repositories)

    assert "team-only" in github.of(SECOND_REPOSITORY).labels
    assert [row.label_id for row in repositories.github.list_label_syncs(WORKSPACE, SECOND_REPOSITORY)] == ["team-only"]


def test_a_page_hands_the_rest_to_the_next_page(
    repositories: Any,
    repos: list[str],
    github: FakeRepositories,
    queued: list[tuple[dict[str, Any], int]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With one repository a page, each page writes one and queues the next after it."""
    monkeypatch.setattr(label_set, "PAGE_SIZE", 1)
    turn_on(repositories)
    add_workspace_label(repositories, "ws-bug", "bug", "#ff0000")

    push(repositories)

    assert "bug" in github.of(REPOSITORY_ID).labels
    assert SECOND_REPOSITORY not in github.repositories
    assert queued == [
        (
            {"kind": label_set.LABEL_SET_JOB, "workspace_id": WORKSPACE, "after": REPOSITORY_ID},
            label_set.NEXT_PAGE_DELAY,
        )
    ]

    push(repositories, after=REPOSITORY_ID)

    assert "bug" in github.of(SECOND_REPOSITORY).labels
    assert len(queued) == 1


def test_a_rate_limit_queues_the_same_page_until_github_resets(
    repositories: Any, repos: list[str], github: FakeRepositories, queued: list[tuple[dict[str, Any], int]]
) -> None:
    """A rate limit stops the page and queues it again, held back as long as GitHub asked."""
    turn_on(repositories)
    add_workspace_label(repositories, "ws-bug", "bug", "#ff0000")
    github.list_error = label_sync.github_issues.GitHubRateLimited("slow down", retry_after=120)

    push(repositories)

    assert queued == [({"kind": label_set.LABEL_SET_JOB, "workspace_id": WORKSPACE, "after": ""}, 121)]


def test_a_repository_github_refuses_is_skipped(
    repositories: Any,
    repos: list[str],
    github: FakeRepositories,
    queued: list[Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A repository the App can no longer reach does not stop the rest of the page."""
    turn_on(repositories)
    add_workspace_label(repositories, "ws-bug", "bug", "#ff0000")
    listing = github.list_labels

    def refuse_first(token: str, repository_id: str, **kwargs: Any) -> list[dict[str, Any]]:
        """Refuse the first repository as a removed one would be."""
        if repository_id == REPOSITORY_ID:
            raise label_sync.github_issues.GitHubNotFound("gone")
        return listing(token, repository_id, **kwargs)

    monkeypatch.setattr(label_sync.github_issues, "list_labels", refuse_first)

    push(repositories)

    assert "bug" in github.of(SECOND_REPOSITORY).labels
    assert queued == []


def test_nothing_is_pushed_while_the_set_is_off(
    repositories: Any, repos: list[str], github: FakeRepositories, queued: list[Any]
) -> None:
    """A page queued before the admin turned the set off writes nothing."""
    add_workspace_label(repositories, "ws-bug", "bug", "#ff0000")

    push(repositories)

    assert github.repositories == {}


def _record(before: Label | None, after: Label | None) -> dict[str, Any]:
    """One team configuration stream record for a label row."""
    images: dict[str, Any] = {}
    if after is not None:
        images["NewImage"] = {key: SERIALIZER.serialize(value) for key, value in as_item(after).items()}
    if before is not None:
        images["OldImage"] = {key: SERIALIZER.serialize(value) for key, value in as_item(before).items()}
    return {"eventName": "MODIFY" if before and after else "INSERT", "dynamodb": images}


def test_a_workspace_label_change_queues_a_push_when_the_set_is_on(
    repositories: Any, repos: list[str], queued: list[tuple[dict[str, Any], int]]
) -> None:
    """Creating a workspace label queues a push from the first repository; a team label does not."""
    label = add_workspace_label(repositories, "ws-bug", "bug", "#ff0000")
    assert stream.queue_label_sync(repositories, _record(None, label)) == 0

    turn_on(repositories)
    assert stream.queue_label_sync(repositories, _record(None, label)) == 1
    assert queued == [({"kind": label_set.LABEL_SET_JOB, "workspace_id": WORKSPACE, "after": ""}, 0)]

    team_label = Label(
        workspace_id=WORKSPACE, config_key=label_key(TEAM, "t"), team_id=TEAM, label_id="t", name="t", color="#000000"
    )
    stream.queue_label_sync(repositories, _record(None, team_label))
    assert len(queued) == 1


def test_an_added_repository_gets_the_set(
    repositories: Any, repos: list[str], queued: list[tuple[dict[str, Any], int]]
) -> None:
    """A repository added to the installation queues a push of that repository alone."""
    turn_on(repositories)

    events.handle_record(
        repositories,
        sqs_record(
            {
                "event": "installation_repositories",
                "delivery": "d-added",
                "body": {
                    "action": "added",
                    "installation": {"id": int(INSTALLATION_ID)},
                    "repository_selection": "selected",
                    "repositories_added": [{"id": 9010, "full_name": "WebbPulse/new", "name": "new"}],
                    "repositories_removed": [],
                },
            }
        ),
    )

    assert queued == [
        (
            {"kind": label_set.LABEL_SET_JOB, "workspace_id": WORKSPACE, "after": "", "repository_ids": ["9010"]},
            0,
        )
    ]


def test_an_admin_turns_the_set_on_and_the_installation_read_shows_it(
    client: TestClient, repositories: Any, installed: str, queued: list[tuple[dict[str, Any], int]]
) -> None:
    """Turning the set on queues the first push and is recorded; turning it off queues nothing."""
    sign_in(client, ADMIN)
    url = f"/api/workspaces/{WORKSPACE}/github/installation/label-set"

    response = client.put(url, json={"enabled": True})

    assert response.status_code == 200
    assert response.json() == {"enabled": True, "include_public": False, "queued": True}
    assert len(queued) == 1
    body = client.get(f"/api/workspaces/{WORKSPACE}/github/installation").json()
    assert body["label_set"] == {"enabled": True, "include_public": False, "queued": False}
    logged = repositories.audit.list_events(WORKSPACE, AuditQuery(action="github.label_set_updated")).events
    assert [dict(row.after or {}) for row in logged] == [{"enabled": True}]

    response = client.put(url, json={"enabled": False})

    assert response.json()["queued"] is False
    assert len(queued) == 1


def test_only_an_admin_with_an_installation_sets_the_label_set(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """A member is refused, and a workspace with no installation answers 404."""
    url = f"/api/workspaces/{WORKSPACE}/github/installation/label-set"
    sign_in(client, MEMBER)
    assert client.put(url, json={"enabled": True}).status_code == 403

    sign_in(client, ADMIN)
    assert client.put(url, json={"enabled": True}).status_code == 404
