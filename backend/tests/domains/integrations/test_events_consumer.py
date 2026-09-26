"""The github-events consumer, against real tables.

Driven through `handle_record` rather than through the consumer route, because the
route is the platform's own envelope handling and what is worth pinning here is
what one delivery does to the database.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest

from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.team_config import Transition, new_config_id, transition_key
from app.domains.integrations.consumers import events
from tests.domains.integrations.conftest import (
    INSTALLATION_ID,
    REPOSITORY_FULL_NAME,
    REPOSITORY_ID,
    TEAM,
    WORKSPACE,
    sqs_record,
)


def pull_request_event(
    *,
    action: str = "opened",
    title: str = "ABC-1 a change",
    body: str = "",
    branch: str = "work",
    merged: bool = False,
    draft: bool = False,
    state: str = "open",
) -> dict[str, Any]:
    """One `pull_request` delivery, in the shape the receiver enqueues it."""
    return {
        "event": "pull_request",
        "delivery": "d1",
        "body": {
            "action": action,
            "installation": {"id": int(INSTALLATION_ID)},
            "repository": {"id": int(REPOSITORY_ID), "full_name": REPOSITORY_FULL_NAME},
            "pull_request": {
                "number": 7,
                "node_id": "PR_node",
                "title": title,
                "body": body,
                "state": state,
                "merged": merged,
                "draft": draft,
                "html_url": "https://github.com/WebbPulse/standupless/pull/7",
                "head": {"ref": branch, "sha": "deadbeef"},
                "user": {"login": "someone"},
            },
        },
    }


@pytest.fixture
def status_ids(repositories: Any, workspace: str) -> dict[str, str]:
    """The seeded team's statuses, by category, for asserting on a transition."""
    statuses = repositories.team_config.list_statuses(workspace, TEAM)
    return {status.category: status.status_id for status in statuses}


def test_an_opened_pull_request_links_the_issue_it_names(
    repositories: Any,
    installed: str,
    issue: Any,
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """A key in the title produces a link row carrying the pull request's state."""
    events.handle_record(repositories, sqs_record(pull_request_event()))

    links = repositories.github.list_links_for_issue(WORKSPACE, issue.issue_id).items
    assert len(links) == 1
    assert links[0]["issue_key"] == "ABC-1"
    assert links[0]["pr_number"] == 7
    assert links[0]["pr_state"] == "open"


def test_an_opened_pull_request_moves_the_issue_to_the_default_started_status(
    repositories: Any,
    installed: str,
    issue: Any,
    status_ids: dict[str, str],
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """With no configured rules, `pr_opened` uses the design section 4 default."""
    events.handle_record(repositories, sqs_record(pull_request_event()))

    moved = repositories.issues.get(WORKSPACE, issue.issue_id)
    assert moved is not None
    assert moved.status_id == status_ids["started"]


def test_a_merge_without_a_magic_word_does_not_close_by_default(
    repositories: Any,
    installed: str,
    issue: Any,
    status_ids: dict[str, str],
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """A default team closes on merge only when the title or body says so."""
    events.handle_record(
        repositories,
        sqs_record(pull_request_event(action="closed", merged=True, state="closed", title="ABC-1 a change")),
    )

    moved = repositories.issues.get(WORKSPACE, issue.issue_id)
    assert moved is not None
    assert moved.status_id != status_ids["completed"]


def test_a_merge_with_a_magic_word_closes_the_issue(
    repositories: Any,
    installed: str,
    issue: Any,
    status_ids: dict[str, str],
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """`Fixes ABC-1` plus a merge is what the default rule acts on."""
    events.handle_record(
        repositories,
        sqs_record(pull_request_event(action="closed", merged=True, state="closed", title="Fixes ABC-1")),
    )

    moved = repositories.issues.get(WORKSPACE, issue.issue_id)
    assert moved is not None
    assert moved.status_id == status_ids["completed"]


def test_a_configured_rule_replaces_the_defaults(
    repositories: Any,
    installed: str,
    issue: Any,
    status_ids: dict[str, str],
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """A team with its own rules uses them alone, defaults included.

    A team that configured `pr_merged` and nothing else has deliberately said
    `pr_opened` moves nothing, so falling back per trigger would override a choice.
    """
    transition_id = new_config_id()
    repositories.team_config.create_transition(
        Transition(
            workspace_id=WORKSPACE,
            config_key=transition_key(TEAM, transition_id),
            team_id=TEAM,
            transition_id=transition_id,
            trigger="pr_merged",
            status_id=status_ids["completed"],
        )
    )

    events.handle_record(repositories, sqs_record(pull_request_event()))
    after_open = repositories.issues.get(WORKSPACE, issue.issue_id)
    assert after_open is not None
    assert after_open.status_id == status_ids["backlog"]

    events.handle_record(
        repositories,
        sqs_record(pull_request_event(action="closed", merged=True, state="closed", title="ABC-1 a change")),
    )
    after_merge = repositories.issues.get(WORKSPACE, issue.issue_id)
    assert after_merge is not None
    assert after_merge.status_id == status_ids["completed"]


def test_a_manual_status_change_after_the_event_is_not_overridden(
    repositories: Any,
    installed: str,
    issue: Any,
    status_ids: dict[str, str],
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """The guard that makes a late delivery a no-op rather than a regression.

    The issue is touched after the event was raised, so the queued transition must
    leave it where the person put it.
    """
    repositories.issues.replace(
        issue.model_copy(update={"status_id": status_ids["backlog"], "updated_at": utc_now() + timedelta(hours=1)})
    )

    events.handle_record(
        repositories,
        sqs_record(pull_request_event(), occurred_at=utc_now().isoformat()),
    )

    unchanged = repositories.issues.get(WORKSPACE, issue.issue_id)
    assert unchanged is not None
    assert unchanged.status_id == status_ids["backlog"]


def test_a_key_naming_a_team_the_repository_is_pinned_away_from_is_dropped(
    repositories: Any,
    installed: str,
    issue: Any,
    hidden_issue: Any,
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """A repository pinned to one team searches that team's prefix alone.

    Without this, `XYZ-1` in a repository belonging to one team would move an issue
    of a team that team was never given.
    """
    repositories.github.set_repository_team(WORKSPACE, REPOSITORY_ID, TEAM)

    events.handle_record(repositories, sqs_record(pull_request_event(title="XYZ-1 and ABC-1")))

    assert repositories.github.list_links_for_issue(WORKSPACE, hidden_issue.issue_id).items == []
    assert len(repositories.github.list_links_for_issue(WORKSPACE, issue.issue_id).items) == 1


def test_a_delivery_for_an_unknown_installation_is_dropped(
    repositories: Any,
    workspace: str,
    issue: Any,
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """No installation row means no workspace, and a delivery with no tenant does nothing.

    This is the fail-closed case: the consumer resolves the tenant from the
    installation id, so an id nothing owns must not fall back to any workspace.
    """
    events.handle_record(repositories, sqs_record(pull_request_event()))

    assert repositories.github.list_links_for_issue(WORKSPACE, issue.issue_id).items == []
    assert enqueued == []


def test_a_key_whose_issue_does_not_exist_links_nothing(
    repositories: Any,
    installed: str,
    workspace: str,
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """A branch naming a deleted or never created issue is simply not linked."""
    events.handle_record(repositories, sqs_record(pull_request_event(title="ABC-999 a change")))

    assert enqueued == []


def test_a_replayed_delivery_leaves_one_link(
    repositories: Any,
    installed: str,
    issue: Any,
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """Handling the same delivery twice is the state one delivery would have left.

    The receiver drops replays, but the queue can still deliver twice, so the
    consumer has to be idempotent on its own.
    """
    record = sqs_record(pull_request_event())
    events.handle_record(repositories, record)
    events.handle_record(repositories, record)

    assert len(repositories.github.list_links_for_issue(WORKSPACE, issue.issue_id).items) == 1


def test_a_write_back_job_is_enqueued_with_the_link_ids(
    repositories: Any,
    installed: str,
    issue: Any,
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """The dispatch job names the exact link rows it will mark, so the skip is exact."""
    events.handle_record(repositories, sqs_record(pull_request_event()))

    assert len(enqueued) == 1
    payload = enqueued[0][1].payload
    assert payload["kind"] == "github.writeback"
    assert payload["keys"] == ["ABC-1"]
    assert payload["link_ids"] == [f"PR_node#{issue.issue_id}"]


def test_a_push_records_activity_and_moves_nothing(
    repositories: Any,
    installed: str,
    issue: Any,
    status_ids: dict[str, str],
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """Commit messages contribute a mention, never a transition."""
    events.handle_record(
        repositories,
        sqs_record(
            {
                "event": "push",
                "delivery": "d2",
                "body": {
                    "installation": {"id": int(INSTALLATION_ID)},
                    "repository": {"id": int(REPOSITORY_ID), "full_name": REPOSITORY_FULL_NAME},
                    "commits": [
                        {
                            "id": "abc1234def5678",
                            "url": "https://github.com/acme/app/commit/abc1234def5678",
                            "message": "fixes ABC-1\n\nlonger body",
                        },
                        {"id": "ffff0000", "message": "chore: unrelated"},
                    ],
                },
            }
        ),
    )

    unchanged = repositories.issues.get(WORKSPACE, issue.issue_id)
    assert unchanged is not None
    assert unchanged.status_id == status_ids["backlog"]

    activity = repositories.activity.list_for_issue(WORKSPACE, issue.issue_id).items
    commits = [row for row in activity if row["field"] == "github_commit"]
    assert len(commits) == 1
    assert commits[0]["to_value"]["sha"] == "abc1234def5678"
    assert commits[0]["to_value"]["message"] == "fixes ABC-1"
    assert commits[0]["to_value"]["url"] == "https://github.com/acme/app/commit/abc1234def5678"


def test_an_uninstall_removes_the_installation(
    repositories: Any,
    installed: str,
    workspace: str,
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """Uninstalling the App in GitHub drops the rows that let deliveries resolve."""
    events.handle_record(
        repositories,
        sqs_record(
            {
                "event": "installation",
                "delivery": "d3",
                "body": {"action": "deleted", "installation": {"id": int(INSTALLATION_ID)}},
            }
        ),
    )

    assert repositories.github.get_installation(WORKSPACE) is None


def _installation_event(action: str, **extra: Any) -> dict[str, Any]:
    """One queued `installation` delivery for the bound installation."""
    return sqs_record(
        {
            "event": "installation",
            "delivery": f"d-{action}",
            "body": {"action": action, "installation": {"id": int(INSTALLATION_ID)}, **extra},
        }
    )


def test_a_suspension_is_recorded_and_lifted(
    repositories: Any,
    installed: str,
    workspace: str,
    github_env: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A suspended installation reads as suspended until GitHub says it is not."""
    from app.domains.integrations import github_api

    monkeypatch.setattr(
        github_api,
        "get_installation",
        lambda installation_id, **_: {"app_id": 123456, "account": {"login": "WebbPulse", "type": "Organization"}},
    )
    monkeypatch.setattr(github_api, "installation_repositories", lambda installation_id, **_: [])

    events.handle_record(repositories, _installation_event("suspend"))
    suspended = repositories.github.get_installation(WORKSPACE)
    assert suspended is not None
    assert suspended.suspended_at is not None

    events.handle_record(repositories, _installation_event("unsuspend"))
    lifted = repositories.github.get_installation(WORKSPACE)
    assert lifted is not None
    assert lifted.suspended_at is None


def test_a_repository_selection_change_is_recorded(
    repositories: Any,
    installed: str,
    workspace: str,
    github_env: None,
) -> None:
    """Switching the installation to every repository shows on the settings page."""
    events.handle_record(
        repositories,
        sqs_record(
            {
                "event": "installation_repositories",
                "delivery": "d-selection",
                "body": {
                    "action": "added",
                    "installation": {"id": int(INSTALLATION_ID)},
                    "repository_selection": "all",
                    "repositories_added": [{"id": 9002, "full_name": "WebbPulse/other", "name": "other"}],
                    "repositories_removed": [],
                },
            }
        ),
    )

    installation = repositories.github.get_installation(WORKSPACE)
    assert installation is not None
    assert installation.repository_selection == "all"
    assert repositories.github.get_repository(WORKSPACE, "9002") is not None


def test_a_retired_key_links_the_issue_under_its_current_key(
    repositories: Any,
    installed: str,
    issue: Any,
    status_ids: dict[str, str],
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """A branch naming the old prefix links and closes the renamed team's issue.

    The link row and the write-back job carry the key the issue has today, so the
    GitHub comment shows the key a reader can find.
    """
    repositories.teams.change_key_prefix(WORKSPACE, issue.team_id, "NEW")

    events.handle_record(
        repositories,
        sqs_record(
            pull_request_event(action="closed", merged=True, state="closed", title="Fixes ABC-1", branch="abc-1-fix")
        ),
    )

    links = repositories.github.list_links_for_issue(WORKSPACE, issue.issue_id).items
    assert [link["issue_key"] for link in links] == ["NEW-1"]
    assert enqueued[0][1].payload["keys"] == ["NEW-1"]
    moved = repositories.issues.get(WORKSPACE, issue.issue_id)
    assert moved is not None
    assert moved.status_id == status_ids["completed"]
