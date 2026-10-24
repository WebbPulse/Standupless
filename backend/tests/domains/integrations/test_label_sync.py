"""Label definition sync between a team and the GitHub repository it syncs with.

Reconciles run through the dispatch consumer and GitHub renames through the
events consumer, so each test takes the routing a deployed function takes. Every
GitHub call is patched at `github_issues` with a fake that holds the
repository's labels the way GitHub would.
"""

from __future__ import annotations

from typing import Any

import pytest
from boto3.dynamodb.types import TypeSerializer

from app.common import team_workflow
from app.common.api.schemas.teams import LabelUpdate
from app.common.db.dynamo.base import as_item
from app.common.db.dynamo.github import IssueSync, TeamSync, issue_sync_key, team_sync_key
from app.common.db.dynamo.team_config import Label, label_key
from app.domains.integrations import label_sync
from app.domains.integrations.consumers import dispatch, events, stream
from tests.domains.helpers import ADMIN
from tests.domains.integrations.conftest import (
    APP_SLUG,
    INSTALLATION_ID,
    REPOSITORY_FULL_NAME,
    REPOSITORY_ID,
    TEAM,
    WORKSPACE,
    sqs_record,
)

SERIALIZER = TypeSerializer()


class FakeLabels:
    """A repository's labels as GitHub keeps them, keyed by lowered name, with every write recorded."""

    def __init__(self, *existing: dict[str, Any]) -> None:
        """Start with the labels the repository already has."""
        self.labels: dict[str, dict[str, Any]] = {str(entry["name"]).lower(): dict(entry) for entry in existing}
        self.calls: list[tuple[str, str]] = []

    def installation_token(self, installation_id: str) -> str:
        """A placeholder token."""
        return "ghs_test"

    def list_labels(self, token: str, repository_id: str, **_: Any) -> list[dict[str, Any]]:
        """Every label the repository holds."""
        return [dict(entry) for entry in self.labels.values()]

    def create_label(
        self, token: str, repository_id: str, name: str, color: str, *, description: str | None = None, **_: Any
    ) -> bool:
        """Add a label, answering False for a taken name as GitHub's 422 does."""
        if name.lower() in self.labels:
            return False
        self.labels[name.lower()] = {"name": name, "color": color.lstrip("#").lower(), "description": description}
        self.calls.append(("create", name))
        return True

    def update_label(
        self,
        token: str,
        repository_id: str,
        name: str,
        *,
        new_name: str | None = None,
        color: str | None = None,
        description: str | None = None,
        **_: Any,
    ) -> bool:
        """Rename, recolour or describe a label, answering False for one that is not there."""
        entry = self.labels.pop(name.lower(), None)
        if entry is None:
            return False
        if new_name is not None:
            entry["name"] = new_name
        if color is not None:
            entry["color"] = color.lstrip("#").lower()
        if description is not None:
            entry["description"] = description
        self.labels[str(entry["name"]).lower()] = entry
        self.calls.append(("update", f"{name}->{entry['name']}"))
        return True

    def delete_label(self, token: str, repository_id: str, name: str, **_: Any) -> None:
        """Remove a label, treating one already gone as removed."""
        self.labels.pop(name.lower(), None)
        self.calls.append(("delete", name))


def fake_labels(monkeypatch: pytest.MonkeyPatch, *existing: dict[str, Any]) -> FakeLabels:
    """Patch every GitHub call the label sync makes."""
    fake = FakeLabels(*existing)
    for name in ("installation_token", "list_labels", "create_label", "update_label", "delete_label"):
        monkeypatch.setattr(label_sync.github_issues, name, getattr(fake, name))
    return fake


def add_label(repositories: Any, label_id: str, name: str, color: str, **fields: Any) -> Label:
    """Give `TEAM` one label of its own."""
    return repositories.team_config.create_label(
        Label(
            workspace_id=WORKSPACE,
            config_key=label_key(TEAM, label_id),
            team_id=TEAM,
            label_id=label_id,
            name=name,
            color=color,
            **fields,
        )
    )


@pytest.fixture
def linked(repositories: Any, installed: str, github_env: None) -> TeamSync:
    """`TEAM` syncing both ways with the repository, labels included."""
    row = TeamSync(
        workspace_id=WORKSPACE,
        github_key=team_sync_key(TEAM),
        team_id=TEAM,
        repository_id=REPOSITORY_ID,
        full_name=REPOSITORY_FULL_NAME,
        created_by=ADMIN,
    )
    repositories.github.put_team_sync(row)
    return row


def reconcile(repositories: Any) -> None:
    """Run one label sync job for `TEAM` through the dispatch consumer."""
    job = {"kind": label_sync.LABEL_SYNC_JOB, "workspace_id": WORKSPACE, "team_id": TEAM}
    dispatch.handle_record(repositories, sqs_record(job))


def label_delivery(old: str, new: str, *, sender: str = "maintainer") -> dict[str, Any]:
    """One `label` delivery renaming a repository label, in the shape the receiver enqueues it."""
    return {
        "event": "label",
        "delivery": f"l-{old}-{new}",
        "body": {
            "action": "edited",
            "installation": {"id": int(INSTALLATION_ID)},
            "repository": {"id": int(REPOSITORY_ID), "full_name": REPOSITORY_FULL_NAME},
            "label": {"name": new, "color": "ff0000"},
            "changes": {"name": {"from": old}},
            "sender": {"login": sender},
        },
    }


def jobs_of(enqueued: list[tuple[str, Any]], kind: str) -> list[dict[str, Any]]:
    """The payloads of every queued job of one kind."""
    return [dict(envelope.payload) for _url, envelope in enqueued if envelope.payload.get("kind") == kind]


def link_issue(repositories: Any, issue_id: str, labels: list[str]) -> None:
    """A synced issue whose GitHub snapshot carries `labels`."""
    assert repositories.github.claim_issue_sync(
        IssueSync(
            workspace_id=WORKSPACE,
            github_key=issue_sync_key(issue_id),
            issue_id=issue_id,
            team_id=TEAM,
            repository_id=REPOSITORY_ID,
            full_name=REPOSITORY_FULL_NAME,
            number=12,
            github={"labels": labels},
        )
    )


def test_labels_are_created_or_adopted_with_colour_and_description(
    repositories: Any, linked: TeamSync, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A new name is created, an existing one of the same name is updated in place, and a rerun writes nothing."""
    github = fake_labels(monkeypatch, {"name": "Bug", "color": "cccccc", "description": None})
    add_label(repositories, "bug-label", "bug", "#ff0000", description="Something broke")
    add_label(repositories, "feature-label", "feature", "#00ff00")

    reconcile(repositories)

    assert github.labels["bug"] == {"name": "bug", "color": "ff0000", "description": "Something broke"}
    assert github.labels["feature"]["color"] == "00ff00"
    rows = {row.label_id: row for row in repositories.github.list_label_syncs(WORKSPACE, REPOSITORY_ID)}
    assert rows["bug-label"].created is False
    assert rows["feature-label"].created is True

    github.calls.clear()
    reconcile(repositories)
    assert github.calls == []


def test_a_rename_in_standupless_renames_the_repository_label(
    repositories: Any,
    linked: TeamSync,
    monkeypatch: pytest.MonkeyPatch,
    enqueued: list[tuple[str, Any]],
) -> None:
    """The label is renamed on GitHub rather than recreated, and issue snapshots follow the new name."""
    github = fake_labels(monkeypatch)
    add_label(repositories, "bug-label", "bug", "#ff0000")
    reconcile(repositories)
    link_issue(repositories, "01JB0000000000000000000IS1", ["bug", "outside"])
    before = repositories.team_config.get_label(WORKSPACE, TEAM, "bug-label")

    team_workflow.update_label(repositories, WORKSPACE, TEAM, "bug-label", LabelUpdate(name="defect", color="#0000ff"))
    after = repositories.team_config.get_label(WORKSPACE, TEAM, "bug-label")
    record = {
        "eventName": "MODIFY",
        "dynamodb": {
            "NewImage": {key: SERIALIZER.serialize(value) for key, value in as_item(after).items()},
            "OldImage": {key: SERIALIZER.serialize(value) for key, value in as_item(before).items()},
        },
    }
    assert stream.queue_label_sync(repositories, record) == 1
    assert jobs_of(enqueued, label_sync.LABEL_SYNC_JOB) == [
        {"kind": label_sync.LABEL_SYNC_JOB, "workspace_id": WORKSPACE, "team_id": TEAM}
    ]

    github.calls.clear()
    reconcile(repositories)

    assert github.calls == [("update", "bug->defect")]
    assert list(github.labels) == ["defect"]
    assert github.labels["defect"]["color"] == "0000ff"
    sync = repositories.github.get_issue_sync(WORKSPACE, "01JB0000000000000000000IS1")
    assert sync.github["labels"] == ["defect", "outside"]


def test_a_rename_on_github_renames_the_team_label(
    repositories: Any,
    linked: TeamSync,
    monkeypatch: pytest.MonkeyPatch,
    enqueued: list[tuple[str, Any]],
) -> None:
    """The team label keeps its id, so every issue still carries it, and the next reconcile writes nothing."""
    github = fake_labels(monkeypatch)
    add_label(repositories, "bug-label", "bug", "#ff0000")
    reconcile(repositories)
    link_issue(repositories, "01JB0000000000000000000IS1", ["bug"])

    github.update_label("ghs_test", REPOSITORY_ID, "bug", new_name="defect")
    events.handle_record(repositories, sqs_record(label_delivery("bug", "defect")))
    queued = jobs_of(enqueued, label_sync.LABEL_RENAME_JOB)
    assert len(queued) == 1
    dispatch.handle_record(repositories, sqs_record(queued[0]))

    label = repositories.team_config.get_label(WORKSPACE, TEAM, "bug-label")
    assert label.name == "defect"
    rows = repositories.github.list_label_syncs(WORKSPACE, REPOSITORY_ID)
    assert [(row.label_id, row.name) for row in rows] == [("bug-label", "defect")]
    assert repositories.github.get_issue_sync(WORKSPACE, "01JB0000000000000000000IS1").github["labels"] == ["defect"]

    github.calls.clear()
    reconcile(repositories)
    assert github.calls == []


def test_a_github_rename_of_a_grouped_label_keeps_it_in_its_group(
    repositories: Any,
    linked: TeamSync,
    monkeypatch: pytest.MonkeyPatch,
    enqueued: list[tuple[str, Any]],
) -> None:
    """`Area/api` renamed to `Area/backend` renames the child, and a rename out of the group is not carried."""
    github = fake_labels(monkeypatch)
    add_label(repositories, "area-group", "Area", "#123456", is_group=True)
    add_label(repositories, "api-label", "api", "#654321", parent_id="area-group")
    reconcile(repositories)
    assert list(github.labels) == ["area/api"]

    events.handle_record(repositories, sqs_record(label_delivery("Area/api", "Area/backend")))
    events.handle_record(repositories, sqs_record(label_delivery("Area/backend", "backend")))
    first, second = jobs_of(enqueued, label_sync.LABEL_RENAME_JOB)
    dispatch.handle_record(repositories, sqs_record(first))
    assert repositories.team_config.get_label(WORKSPACE, TEAM, "api-label").name == "backend"

    dispatch.handle_record(repositories, sqs_record(second))
    label = repositories.team_config.get_label(WORKSPACE, TEAM, "api-label")
    assert (label.name, label.parent_id) == ("backend", "area-group")


def test_the_apps_own_label_edit_is_not_carried_back(
    repositories: Any,
    linked: TeamSync,
    monkeypatch: pytest.MonkeyPatch,
    enqueued: list[tuple[str, Any]],
) -> None:
    """A rename the App made is the echo of a Standupless rename, so it queues nothing."""
    fake_labels(monkeypatch)
    add_label(repositories, "bug-label", "bug", "#ff0000")

    events.handle_record(repositories, sqs_record(label_delivery("bug", "defect", sender=f"{APP_SLUG}[bot]")))

    assert jobs_of(enqueued, label_sync.LABEL_RENAME_JOB) == []


def test_a_delete_removes_only_labels_standupless_created(
    repositories: Any, linked: TeamSync, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A label that was in the repository before the link is left there; one the sync created goes."""
    github = fake_labels(monkeypatch, {"name": "bug", "color": "ff0000", "description": None})
    add_label(repositories, "bug-label", "bug", "#ff0000")
    add_label(repositories, "feature-label", "feature", "#00ff00")
    reconcile(repositories)

    team_workflow.delete_label(repositories, WORKSPACE, TEAM, "bug-label")
    team_workflow.delete_label(repositories, WORKSPACE, TEAM, "feature-label")
    github.calls.clear()
    reconcile(repositories)

    assert github.calls == [("delete", "feature")]
    assert list(github.labels) == ["bug"]
    assert repositories.github.list_label_syncs(WORKSPACE, REPOSITORY_ID) == []


def test_nothing_is_written_without_label_sync(
    repositories: Any, linked: TeamSync, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A link with `sync_labels` off, or one way, leaves the repository's labels alone."""
    github = fake_labels(monkeypatch)
    add_label(repositories, "bug-label", "bug", "#ff0000")
    repositories.github.put_team_sync(linked.model_copy(update={"sync_labels": False}))
    reconcile(repositories)
    repositories.github.put_team_sync(linked.model_copy(update={"direction": "github_to_standupless"}))
    reconcile(repositories)

    assert github.calls == []
    assert github.labels == {}
