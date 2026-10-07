"""Issue labels carried onto linked pull requests, end to end through the consumers.

GitHub is faked at the `github_issues` boundary. The fake keeps the pull
request's labels and the repository's labels, so each test asserts on what the
pull request carries after a job rather than on the calls that got it there.
"""

from __future__ import annotations

from typing import Any

import pytest
from boto3.dynamodb.types import TypeSerializer

from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.github import IssueLink, link_key
from app.common.db.dynamo.team_config import Label, label_key
from app.domains.integrations import pr_labels
from app.domains.integrations.consumers import dispatch, events, stream
from tests.domains.integrations.conftest import (
    APP_SLUG,
    INSTALLATION_ID,
    REPOSITORY_FULL_NAME,
    REPOSITORY_ID,
    TEAM,
    WORKSPACE,
    seed_issue,
    sqs_record,
)
from tests.domains.integrations.test_events_consumer import pull_request_event

SECOND_ISSUE = "01JB0000000000000000000IS3"
SERIALIZER = TypeSerializer()


class FakeLabels:
    """A pull request and a repository as GitHub would hold their labels."""

    def __init__(self) -> None:
        """Start with an open pull request carrying one label a person put on it."""
        self.state = "open"
        self.on_pr: list[str] = ["needs review"]
        self.repository: dict[str, str] = {"needs review": "ededed"}
        self.created: list[tuple[str, str]] = []
        self.removed: list[str] = []
        self.tokens = 0

    def installation_token(self, installation_id: str) -> str:
        """Count one token minted."""
        assert installation_id == INSTALLATION_ID
        self.tokens += 1
        return "ghs_test"

    def get_issue(self, token: str, repository_id: str, number: int) -> dict[str, Any]:
        """The pull request as the issues API answers it."""
        assert repository_id == REPOSITORY_ID
        return {"number": number, "state": self.state, "labels": [{"name": name} for name in self.on_pr]}

    def create_label(self, token: str, repository_id: str, name: str, color: str) -> bool:
        """Create a repository label unless one of that name exists."""
        if name.lower() in {key.lower() for key in self.repository}:
            return False
        self.repository[name] = color
        self.created.append((name, color))
        return True

    def add_labels(self, token: str, repository_id: str, number: int, names: list[str]) -> None:
        """Add labels the repository has, refusing one it lacks the way GitHub would."""
        for name in names:
            assert name in self.repository, name
            if name not in self.on_pr:
                self.on_pr.append(name)

    def remove_label(self, token: str, repository_id: str, number: int, name: str) -> None:
        """Take one label off the pull request."""
        self.removed.append(name)
        self.on_pr = [label for label in self.on_pr if label != name]


@pytest.fixture
def labels_github(monkeypatch: pytest.MonkeyPatch) -> FakeLabels:
    """Route the label sync's GitHub calls to the fake."""
    fake = FakeLabels()
    for name in ("installation_token", "get_issue", "create_label", "add_labels", "remove_label"):
        monkeypatch.setattr(pr_labels.github_issues, name, getattr(fake, name))
    return fake


def make_label(repositories: Any, label_id: str, name: str, color: str = "#5E6AD2") -> str:
    """Store one team label and answer its id."""
    repositories.team_config.create_label(
        Label(
            workspace_id=WORKSPACE,
            config_key=label_key(TEAM, label_id),
            team_id=TEAM,
            label_id=label_id,
            name=name,
            color=color,
        )
    )
    return label_id


def set_labels(repositories: Any, issue: Any, label_ids: list[str]) -> Any:
    """Give an issue exactly these labels."""
    current = repositories.issues.get(WORKSPACE, issue.issue_id)
    updated = current.model_copy(update={"label_ids": label_ids})
    repositories.issues.replace(updated)
    return updated


def put_link(repositories: Any, issue_id: str, *, applied: list[str] | None = None, **fields: Any) -> str:
    """Store one link of the pull request `PR_node` to an issue."""
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
            repository_id=REPOSITORY_ID,
            pr_number=7,
            pr_updated_ms=1000,
            applied_labels=applied or [],
            linked_at=utc_now(),
            updated_at=utc_now(),
            **fields,
        )
    )
    return link_id


def run_job(repositories: Any) -> None:
    """Run one label sync job for `PR_node` through the dispatch consumer."""
    job = {"kind": pr_labels.PR_LABELS_JOB, "workspace_id": WORKSPACE, "pr_node_id": "PR_node"}
    dispatch.handle_record(repositories, sqs_record(job))


def label_jobs(enqueued: list[tuple[str, Any]]) -> list[dict[str, Any]]:
    """The label sync jobs among everything enqueued."""
    return [envelope.payload for _url, envelope in enqueued if envelope.payload.get("kind") == pr_labels.PR_LABELS_JOB]


def test_the_job_adds_the_issue_labels_creating_missing_ones_with_their_color(
    repositories: Any, installed: str, issue: Any, labels_github: FakeLabels, github_env: None
) -> None:
    """A label the repository lacks is created in the Standupless color, then applied and recorded."""
    set_labels(repositories, issue, [make_label(repositories, "L1", "Bug", "#E5484D")])
    link_id = put_link(repositories, issue.issue_id)

    run_job(repositories)

    assert labels_github.on_pr == ["needs review", "Bug"]
    assert labels_github.created == [("Bug", "#E5484D")]
    stored = repositories.github.get_link(WORKSPACE, link_id)
    assert stored.applied_labels == ["Bug"]


def test_the_job_unions_labels_across_linked_issues(
    repositories: Any, installed: str, issue: Any, labels_github: FakeLabels, github_env: None
) -> None:
    """Two linked issues contribute every label either carries, and each link records the set."""
    second = seed_issue(repositories, WORKSPACE, TEAM, SECOND_ISSUE, "ABC", 2)
    bug = make_label(repositories, "L1", "Bug")
    ui = make_label(repositories, "L2", "UI")
    set_labels(repositories, issue, [bug])
    set_labels(repositories, second, [bug, ui])
    first_link = put_link(repositories, issue.issue_id)
    second_link = put_link(repositories, second.issue_id)

    run_job(repositories)

    assert sorted(labels_github.on_pr) == ["Bug", "UI", "needs review"]
    for link_id in (first_link, second_link):
        assert repositories.github.get_link(WORKSPACE, link_id).applied_labels == ["Bug", "UI"]


def test_the_job_removes_only_labels_it_applied_that_no_issue_carries(
    repositories: Any, installed: str, issue: Any, labels_github: FakeLabels, github_env: None
) -> None:
    """A label a person added stays, and an applied label still carried by an issue stays."""
    bug = make_label(repositories, "L1", "Bug")
    make_label(repositories, "L2", "UI")
    make_label(repositories, "L3", "needs review")
    set_labels(repositories, issue, [bug])
    labels_github.on_pr = ["needs review", "Bug", "UI"]
    labels_github.repository.update({"Bug": "aaaaaa", "UI": "bbbbbb"})
    link_id = put_link(repositories, issue.issue_id, applied=["Bug", "UI"])

    run_job(repositories)

    assert labels_github.on_pr == ["needs review", "Bug"]
    assert labels_github.removed == ["UI"]
    assert repositories.github.get_link(WORKSPACE, link_id).applied_labels == ["Bug"]


def test_a_label_already_on_the_pull_request_is_not_claimed(
    repositories: Any, installed: str, issue: Any, labels_github: FakeLabels, github_env: None
) -> None:
    """A wanted label a person had already put on is left theirs, so it survives the issue losing it."""
    set_labels(repositories, issue, [make_label(repositories, "L1", "needs review")])
    link_id = put_link(repositories, issue.issue_id)

    run_job(repositories)
    assert repositories.github.get_link(WORKSPACE, link_id).applied_labels == []

    set_labels(repositories, issue, [])
    run_job(repositories)
    assert labels_github.on_pr == ["needs review"]


@pytest.mark.parametrize("state", ["closed", "merged"])
def test_a_finished_pull_request_is_left_alone(
    repositories: Any, installed: str, issue: Any, labels_github: FakeLabels, github_env: None, state: str
) -> None:
    """Closed and merged pull requests are not touched, and no token is minted."""
    set_labels(repositories, issue, [make_label(repositories, "L1", "Bug")])
    put_link(repositories, issue.issue_id, pr_state=state)

    run_job(repositories)

    assert labels_github.tokens == 0
    assert labels_github.on_pr == ["needs review"]


def test_a_pull_request_github_reports_closed_is_left_alone(
    repositories: Any, installed: str, issue: Any, labels_github: FakeLabels, github_env: None
) -> None:
    """GitHub's own state is checked before any write, in case the close delivery has not landed."""
    set_labels(repositories, issue, [make_label(repositories, "L1", "Bug")])
    put_link(repositories, issue.issue_id)
    labels_github.state = "closed"

    run_job(repositories)

    assert labels_github.on_pr == ["needs review"]
    assert labels_github.created == []


def test_a_team_with_the_setting_off_is_left_alone(
    repositories: Any, installed: str, issue: Any, labels_github: FakeLabels, github_env: None
) -> None:
    """Turning the team setting off stops the sync without a GitHub call."""
    set_labels(repositories, issue, [make_label(repositories, "L1", "Bug")])
    put_link(repositories, issue.issue_id)
    repositories.teams.update(WORKSPACE, TEAM, sync_pr_labels=False)

    run_job(repositories)

    assert labels_github.tokens == 0
    assert labels_github.on_pr == ["needs review"]


def test_editing_a_key_out_removes_the_labels_that_issue_alone_brought(
    repositories: Any,
    installed: str,
    issue: Any,
    labels_github: FakeLabels,
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """An edit naming one issue fewer detaches its link, and the job sheds that issue's labels."""
    second = seed_issue(repositories, WORKSPACE, TEAM, SECOND_ISSUE, "ABC", 2)
    bug = make_label(repositories, "L1", "Bug")
    ui = make_label(repositories, "L2", "UI")
    set_labels(repositories, issue, [bug])
    set_labels(repositories, second, [ui])

    events.handle_record(
        repositories,
        sqs_record(pull_request_event(title="ABC-1 ABC-2 a change", updated_at="2026-10-01T00:00:00Z")),
    )
    assert len(label_jobs(enqueued)) == 1
    run_job(repositories)
    assert sorted(labels_github.on_pr) == ["Bug", "UI", "needs review"]

    events.handle_record(
        repositories,
        sqs_record(pull_request_event(action="edited", title="ABC-1 a change", updated_at="2026-10-01T00:01:00Z")),
    )
    assert repositories.github.get_link(WORKSPACE, f"PR_node#{second.issue_id}").detached
    run_job(repositories)

    assert sorted(labels_github.on_pr) == ["Bug", "needs review"]
    assert labels_github.removed == ["UI"]


def test_editing_every_key_out_removes_every_applied_label(
    repositories: Any,
    installed: str,
    issue: Any,
    labels_github: FakeLabels,
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """A pull request that names no issue any more still sheds what the App applied."""
    set_labels(repositories, issue, [make_label(repositories, "L1", "Bug")])
    events.handle_record(repositories, sqs_record(pull_request_event(updated_at="2026-10-01T00:00:00Z")))
    run_job(repositories)
    assert "Bug" in labels_github.on_pr

    events.handle_record(
        repositories,
        sqs_record(pull_request_event(action="edited", title="a change", updated_at="2026-10-01T00:01:00Z")),
    )
    assert len(label_jobs(enqueued)) == 2
    run_job(repositories)

    assert labels_github.on_pr == ["needs review"]


def test_a_late_delivery_does_not_detach_a_link_a_newer_one_named(
    repositories: Any, installed: str, issue: Any, enqueued: list[tuple[str, Any]], github_env: None
) -> None:
    """The detach is ordered on the pull request's own stamp, like the link write."""
    events.handle_record(repositories, sqs_record(pull_request_event(updated_at="2026-10-01T00:05:00Z")))
    events.handle_record(
        repositories,
        sqs_record(pull_request_event(action="edited", title="a change", updated_at="2026-10-01T00:01:00Z")),
    )

    assert not repositories.github.get_link(WORKSPACE, f"PR_node#{issue.issue_id}").detached


@pytest.mark.parametrize("action", ["labeled", "unlabeled", "closed"])
def test_label_and_close_deliveries_queue_no_label_sync(
    repositories: Any, installed: str, issue: Any, enqueued: list[tuple[str, Any]], github_env: None, action: str
) -> None:
    """The job's own label writes come back as `labeled` and `unlabeled`, which queue nothing."""
    events.handle_record(repositories, sqs_record(pull_request_event(action=action)))

    assert label_jobs(enqueued) == []


def test_a_delivery_the_app_sent_queues_no_label_sync(
    repositories: Any, installed: str, issue: Any, enqueued: list[tuple[str, Any]], github_env: None
) -> None:
    """A delivery whose sender is the App's own bot is an echo and queues nothing."""
    record = pull_request_event(action="edited")
    record["body"]["sender"] = {"login": f"{APP_SLUG}[bot]"}

    events.handle_record(repositories, sqs_record(record))

    assert label_jobs(enqueued) == []


@pytest.mark.parametrize("action", ["opened", "edited", "synchronize", "reopened", "ready_for_review"])
def test_linked_pull_request_deliveries_queue_a_label_sync(
    repositories: Any, installed: str, issue: Any, enqueued: list[tuple[str, Any]], github_env: None, action: str
) -> None:
    """Opening, editing, pushing to, reopening or readying a linked pull request queues one job."""
    events.handle_record(repositories, sqs_record(pull_request_event(action=action)))

    assert label_jobs(enqueued) == [
        {"kind": pr_labels.PR_LABELS_JOB, "workspace_id": WORKSPACE, "pr_node_id": "PR_node"}
    ]


def stream_record(old: dict[str, Any], new: dict[str, Any]) -> dict[str, Any]:
    """One issues table MODIFY record, as the stream consumer reads it."""
    return {
        "eventName": "MODIFY",
        "dynamodb": {
            "OldImage": {key: SERIALIZER.serialize(value) for key, value in old.items()},
            "NewImage": {key: SERIALIZER.serialize(value) for key, value in new.items()},
        },
    }


def test_an_issue_label_change_queues_a_sync_for_each_open_linked_pull_request(
    repositories: Any, installed: str, issue: Any, enqueued: list[tuple[str, Any]], github_env: None
) -> None:
    """Open links queue one job per pull request; merged and detached links queue none."""
    put_link(repositories, issue.issue_id)
    repositories.github.put_link(
        IssueLink(
            workspace_id=WORKSPACE,
            github_key=link_key(f"PR_merged#{issue.issue_id}"),
            ws_issue=f"{WORKSPACE}#{issue.issue_id}",
            link_id=f"PR_merged#{issue.issue_id}",
            issue_id=issue.issue_id,
            issue_key="ABC-1",
            repository_full_name=REPOSITORY_FULL_NAME,
            pr_number=8,
            pr_state="merged",
        )
    )
    base = {"workspace_id": WORKSPACE, "issue_id": issue.issue_id, "team_id": TEAM}

    queued = stream.queue_pr_labels(
        repositories, stream_record({**base, "label_ids": []}, {**base, "label_ids": ["L1"]})
    )

    assert queued == 1
    assert [job["pr_node_id"] for job in label_jobs(enqueued)] == ["PR_node"]


def test_an_issue_write_that_keeps_its_labels_queues_nothing(
    repositories: Any, installed: str, issue: Any, enqueued: list[tuple[str, Any]], github_env: None
) -> None:
    """Only a change to `label_ids` queues a label sync."""
    put_link(repositories, issue.issue_id)
    base = {"workspace_id": WORKSPACE, "issue_id": issue.issue_id, "team_id": TEAM, "label_ids": ["L1"]}

    assert stream.queue_pr_labels(repositories, stream_record({**base, "title": "a"}, {**base, "title": "b"})) == 0
    assert label_jobs(enqueued) == []


def test_a_team_with_the_setting_off_queues_nothing_from_the_stream(
    repositories: Any, installed: str, issue: Any, enqueued: list[tuple[str, Any]], github_env: None
) -> None:
    """The team setting is checked before any link is read."""
    put_link(repositories, issue.issue_id)
    repositories.teams.update(WORKSPACE, TEAM, sync_pr_labels=False)
    base = {"workspace_id": WORKSPACE, "issue_id": issue.issue_id, "team_id": TEAM}

    queued = stream.queue_pr_labels(
        repositories, stream_record({**base, "label_ids": []}, {**base, "label_ids": ["L1"]})
    )

    assert queued == 0


def make_grouped(
    repositories: Any, label_id: str, name: str, *, is_group: bool = False, parent_id: str | None = None
) -> str:
    """Store one team label or group and answer its id."""
    repositories.team_config.create_label(
        Label(
            workspace_id=WORKSPACE,
            config_key=label_key(TEAM, label_id),
            team_id=TEAM,
            label_id=label_id,
            name=name,
            color="#5E6AD2",
            is_group=is_group,
            parent_id=parent_id,
        )
    )
    return label_id


def test_a_grouped_label_is_named_group_slash_child(
    repositories: Any, installed: str, issue: Any, labels_github: FakeLabels, github_env: None
) -> None:
    """A label in a group reaches GitHub as `Group/Child`, and the group itself never does."""
    make_grouped(repositories, "G1", "Area", is_group=True)
    set_labels(repositories, issue, [make_grouped(repositories, "L1", "Frontend", parent_id="G1")])
    link_id = put_link(repositories, issue.issue_id)

    run_job(repositories)

    assert labels_github.on_pr == ["needs review", "Area/Frontend"]
    assert repositories.github.get_link(WORKSPACE, link_id).applied_labels == ["Area/Frontend"]


def test_regrouping_a_label_swaps_its_github_name(
    repositories: Any, installed: str, issue: Any, labels_github: FakeLabels, github_env: None
) -> None:
    """Moving a label into a group replaces the bare name the App applied with the path, and a rerun changes nothing."""
    make_grouped(repositories, "G1", "Area", is_group=True)
    set_labels(repositories, issue, [make_grouped(repositories, "L1", "Frontend")])
    put_link(repositories, issue.issue_id)
    run_job(repositories)
    assert labels_github.on_pr == ["needs review", "Frontend"]

    repositories.team_config.update_label(WORKSPACE, TEAM, "L1", parent_id="G1")
    run_job(repositories)
    assert labels_github.on_pr == ["needs review", "Area/Frontend"]
    assert labels_github.removed == ["Frontend"]

    run_job(repositories)
    assert labels_github.on_pr == ["needs review", "Area/Frontend"]
    assert labels_github.removed == ["Frontend"]


def test_github_names_fall_back_to_the_child_past_the_length_limit() -> None:
    """A path longer than GitHub allows uses the bare child name."""
    from app.common.labels import github_label_names

    group = Label(
        workspace_id=WORKSPACE,
        config_key="g",
        team_id=TEAM,
        label_id="G",
        name="G" * 45,
        color="#000000",
        is_group=True,
    )
    child = Label(
        workspace_id=WORKSPACE, config_key="c", team_id=TEAM, label_id="C", name="Child", color="#000000", parent_id="G"
    )
    short = Label(workspace_id=WORKSPACE, config_key="s", team_id=TEAM, label_id="S", name="Bug", color="#000000")
    assert github_label_names([group, child, short]) == {"C": "Child", "S": "Bug"}
