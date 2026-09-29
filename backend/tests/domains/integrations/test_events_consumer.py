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
from app.common.db.dynamo.team_config import Status, Transition, new_config_id, status_key, transition_key
from app.domains.integrations.consumers import events
from tests.domains.integrations.conftest import (
    INSTALLATION_ID,
    REPOSITORY_FULL_NAME,
    REPOSITORY_ID,
    TEAM,
    WORKSPACE,
    PullRequestCommits,
    seed_issue,
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
    updated_at: str | None = None,
    base: str = "main",
) -> dict[str, Any]:
    """One `pull_request` delivery, in the shape the receiver enqueues it."""
    pull_request: dict[str, Any] = {
        "number": 7,
        "node_id": "PR_node",
        "title": title,
        "body": body,
        "state": state,
        "merged": merged,
        "draft": draft,
        "html_url": "https://github.com/WebbPulse/standupless/pull/7",
        "head": {"ref": branch, "sha": "deadbeef"},
        "base": {"ref": base, "sha": "cafebabe"},
        "user": {"login": "someone"},
    }
    if updated_at is not None:
        pull_request["updated_at"] = updated_at
    return {
        "event": "pull_request",
        "delivery": "d1",
        "body": {
            "action": action,
            "installation": {"id": int(INSTALLATION_ID)},
            "repository": {"id": int(REPOSITORY_ID), "full_name": REPOSITORY_FULL_NAME},
            "pull_request": pull_request,
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


def test_a_key_in_the_title_alone_links_and_writes_back(
    repositories: Any,
    installed: str,
    issue: Any,
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """A branch and body that name nothing still link through the title."""
    events.handle_record(
        repositories,
        sqs_record(pull_request_event(title="ABC-1 Update README.md", branch="asdf", body="")),
    )

    assert len(repositories.github.list_links_for_issue(WORKSPACE, issue.issue_id).items) == 1
    assert [envelope.payload["keys"] for _url, envelope in enqueued] == [["ABC-1"]]


def test_a_key_in_the_branch_alone_links(
    repositories: Any,
    installed: str,
    issue: Any,
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """Linear's other source: a branch cut from the issue links without any text."""
    events.handle_record(
        repositories,
        sqs_record(pull_request_event(title="Update README.md", branch="someone/abc-1-readme")),
    )

    assert len(repositories.github.list_links_for_issue(WORKSPACE, issue.issue_id).items) == 1


def test_a_key_in_the_title_and_body_links_and_writes_back_once(
    repositories: Any,
    installed: str,
    issue: Any,
    status_ids: dict[str, str],
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """One issue named in the title, the body and the branch is one link and one key."""
    events.handle_record(
        repositories,
        sqs_record(
            pull_request_event(
                action="closed",
                merged=True,
                state="closed",
                title="ABC-1 a change",
                body="Fixes ABC-1",
                branch="abc-1-change",
            )
        ),
    )

    links = repositories.github.list_links_for_issue(WORKSPACE, issue.issue_id).items
    assert len(links) == 1
    assert links[0]["magic_word"] == "fixes"
    assert len(enqueued) == 1
    assert enqueued[0][1].payload["keys"] == ["ABC-1"]
    moved = repositories.issues.get(WORKSPACE, issue.issue_id)
    assert moved is not None
    assert moved.status_id == status_ids["completed"]


def test_a_key_added_to_the_title_of_an_open_pull_request_links_and_starts_the_issue(
    repositories: Any,
    installed: str,
    issue: Any,
    status_ids: dict[str, str],
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """An `edited` title is how a late key arrives, and it counts as the pull request opening."""
    events.handle_record(repositories, sqs_record(pull_request_event(title="Update README.md")))
    assert repositories.github.list_links_for_issue(WORKSPACE, issue.issue_id).items == []

    events.handle_record(repositories, sqs_record(pull_request_event(action="edited", title="ABC-1 Update README.md")))

    assert len(repositories.github.list_links_for_issue(WORKSPACE, issue.issue_id).items) == 1
    moved = repositories.issues.get(WORKSPACE, issue.issue_id)
    assert moved is not None
    assert moved.status_id == status_ids["started"]
    assert [envelope.payload["keys"] for _url, envelope in enqueued] == [["ABC-1"]]


def test_an_edit_of_an_already_linked_pull_request_does_not_move_the_issue_again(
    repositories: Any,
    installed: str,
    issue: Any,
    status_ids: dict[str, str],
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """Retitling a linked pull request refreshes the link and leaves the status alone."""
    events.handle_record(repositories, sqs_record(pull_request_event()))
    current = repositories.issues.get(WORKSPACE, issue.issue_id)
    assert current is not None
    repositories.issues.replace(current.model_copy(update={"status_id": status_ids["backlog"]}))

    events.handle_record(repositories, sqs_record(pull_request_event(action="edited", title="ABC-1 renamed")))

    links = repositories.github.list_links_for_issue(WORKSPACE, issue.issue_id).items
    assert len(links) == 1
    assert links[0]["pr_title"] == "ABC-1 renamed"
    unchanged = repositories.issues.get(WORKSPACE, issue.issue_id)
    assert unchanged is not None
    assert unchanged.status_id == status_ids["backlog"]


def test_a_key_added_to_the_title_of_a_draft_links_without_moving(
    repositories: Any,
    installed: str,
    issue: Any,
    status_ids: dict[str, str],
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """A draft stays put on edit exactly as it does on open."""
    before = repositories.issues.get(WORKSPACE, issue.issue_id)
    assert before is not None

    events.handle_record(repositories, sqs_record(pull_request_event(action="edited", draft=True)))

    assert len(repositories.github.list_links_for_issue(WORKSPACE, issue.issue_id).items) == 1
    after = repositories.issues.get(WORKSPACE, issue.issue_id)
    assert after is not None
    assert after.status_id == before.status_id


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
    from tests.domains.integrations.conftest import FakeInstallationClient

    fake = FakeInstallationClient({"app_id": 123456, "account": {"login": "WebbPulse", "type": "Organization"}}, [])
    monkeypatch.setattr(github_api, "app_client", fake.open)

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


def github_time(minutes: int) -> str:
    """A GitHub `updated_at` `minutes` from now, at GitHub's one second resolution."""
    return (utc_now() + timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%SZ")


def stored_link(repositories: Any, issue: Any) -> dict[str, Any]:
    """The one link row of the seeded issue."""
    links = repositories.github.list_links_for_issue(WORKSPACE, issue.issue_id).items
    assert len(links) == 1
    return dict(links[0])


def writebacks(enqueued: list[tuple[str, Any]]) -> int:
    """How many write-back jobs were queued."""
    return sum(1 for _url, envelope in enqueued if envelope.payload.get("kind") == "github.writeback")


def test_a_redriven_open_after_the_merge_leaves_the_link_merged(
    repositories: Any,
    installed: str,
    issue: Any,
    status_ids: dict[str, str],
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """The DLQ redrive case: an old `opened` replayed after the merge changes nothing.

    The merge has no magic word, so it moves nothing, and the replay carries no
    `occurred_at`, so only the link's ordering guard stands between it and a move
    to the started status.
    """
    events.handle_record(
        repositories,
        sqs_record(pull_request_event(action="closed", merged=True, state="closed", updated_at=github_time(-1))),
    )
    assert writebacks(enqueued) == 1

    events.handle_record(repositories, sqs_record(pull_request_event(updated_at=github_time(-30))))

    assert stored_link(repositories, issue)["pr_state"] == "merged"
    moved = repositories.issues.get(WORKSPACE, issue.issue_id)
    assert moved is not None
    assert moved.status_id == status_ids["backlog"]
    assert writebacks(enqueued) == 1


def test_an_older_close_arriving_after_a_reopen_is_ignored(
    repositories: Any,
    installed: str,
    issue: Any,
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """Out of order: the reopen is newer, so the close delivered after it loses."""
    events.handle_record(repositories, sqs_record(pull_request_event(action="reopened", updated_at=github_time(-1))))
    events.handle_record(
        repositories,
        sqs_record(pull_request_event(action="closed", state="closed", updated_at=github_time(-2))),
    )

    assert stored_link(repositories, issue)["pr_state"] == "open"


def test_a_newer_reopen_moves_a_closed_link_back_to_open(
    repositories: Any,
    installed: str,
    issue: Any,
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """A close is terminal only against older deliveries, since GitHub can reopen one."""
    events.handle_record(
        repositories,
        sqs_record(pull_request_event(action="closed", state="closed", updated_at=github_time(-2))),
    )
    events.handle_record(repositories, sqs_record(pull_request_event(action="reopened", updated_at=github_time(-1))))

    assert stored_link(repositories, issue)["pr_state"] == "open"


def test_a_same_second_delivery_may_move_forward_but_not_back(
    repositories: Any,
    installed: str,
    issue: Any,
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """On a tie the further state wins, whichever order the two arrive in."""
    stamp = github_time(-1)
    events.handle_record(repositories, sqs_record(pull_request_event(action="edited", updated_at=stamp)))
    events.handle_record(
        repositories,
        sqs_record(pull_request_event(action="closed", merged=True, state="closed", updated_at=stamp)),
    )
    assert stored_link(repositories, issue)["pr_state"] == "merged"

    events.handle_record(repositories, sqs_record(pull_request_event(action="edited", updated_at=stamp)))
    assert stored_link(repositories, issue)["pr_state"] == "merged"


def test_a_merge_is_terminal_on_a_link_written_before_the_stamp(
    repositories: Any,
    installed: str,
    issue: Any,
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """A row from before the ordering stamp orders behind any delivery, but keeps its merge."""
    events.handle_record(
        repositories,
        sqs_record(pull_request_event(action="closed", merged=True, state="closed", updated_at=github_time(-5))),
    )
    link = stored_link(repositories, issue)
    repositories.github._repository.put({key: value for key, value in link.items() if key != "pr_updated_ms"})

    events.handle_record(repositories, sqs_record(pull_request_event(updated_at=github_time(-1))))
    assert stored_link(repositories, issue)["pr_state"] == "merged"


def add_rule(repositories: Any, trigger: str, status_id: str, branch_pattern: str = "") -> None:
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


@pytest.fixture
def preset(repositories: Any, workspace: str, status_ids: dict[str, str]) -> dict[str, str]:
    """The recommended preset on the seeded team, with an In Review and an On Staging status."""
    named: dict[str, str] = {}
    for position, name in ((30, "In Review"), (31, "On Staging")):
        status_id = new_config_id()
        repositories.team_config.create_status(
            Status(
                workspace_id=workspace,
                config_key=status_key(TEAM, status_id),
                team_id=TEAM,
                status_id=status_id,
                name=name,
                category="started",
                position=position,
            )
        )
        named[name] = status_id
    named["Done"] = status_ids["completed"]
    add_rule(repositories, "pr_opened", named["In Review"])
    add_rule(repositories, "pr_ready_for_review", named["In Review"])
    add_rule(repositories, "pr_merged", named["On Staging"], "staging")
    add_rule(repositories, "pr_merged", named["Done"], "main")
    return named


def merged_event(title: str, *, base: str, body: str = "") -> dict[str, Any]:
    """A merge delivery into `base`."""
    return pull_request_event(action="closed", merged=True, state="closed", title=title, body=body, base=base)


def status_of(repositories: Any, issue_id: str) -> str:
    """One issue's current status id."""
    row = repositories.issues.get(WORKSPACE, issue_id)
    assert row is not None
    return str(row.status_id)


def test_an_opened_pull_request_moves_the_issue_to_in_review(
    repositories: Any,
    installed: str,
    issue: Any,
    preset: dict[str, str],
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """The branch-agnostic `pr_opened` rule holds whatever the target branch."""
    events.handle_record(repositories, sqs_record(pull_request_event(base="staging")))

    assert status_of(repositories, issue.issue_id) == preset["In Review"]


def test_a_merge_into_staging_moves_the_issue_to_on_staging(
    repositories: Any,
    installed: str,
    issue: Any,
    preset: dict[str, str],
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """A rule for `staging` picks the status for a merge into that branch."""
    events.handle_record(repositories, sqs_record(merged_event("ABC-1 a change", base="staging")))

    assert status_of(repositories, issue.issue_id) == preset["On Staging"]


def test_a_fixes_merge_into_staging_does_not_close_the_issue(
    repositories: Any,
    installed: str,
    issue: Any,
    preset: dict[str, str],
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """A magic word into a non-final branch lands in that branch's status."""
    events.handle_record(repositories, sqs_record(merged_event("Fixes ABC-1", base="staging")))

    assert status_of(repositories, issue.issue_id) == preset["On Staging"]


def test_a_merge_into_main_moves_the_issue_to_done(
    repositories: Any,
    installed: str,
    issue: Any,
    preset: dict[str, str],
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """A rule for `main` closes on a merge into it."""
    events.handle_record(repositories, sqs_record(merged_event("ABC-1 a change", base="main")))

    assert status_of(repositories, issue.issue_id) == preset["Done"]


def test_a_merge_into_an_unnamed_branch_moves_nothing(
    repositories: Any,
    installed: str,
    issue: Any,
    preset: dict[str, str],
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """With only branch rules for a trigger, a branch none of them name keeps the status."""
    before = status_of(repositories, issue.issue_id)

    events.handle_record(repositories, sqs_record(merged_event("Fixes ABC-1", base="feature/x")))

    assert status_of(repositories, issue.issue_id) == before


def test_a_branch_rule_beats_a_rule_for_any_branch(
    repositories: Any,
    installed: str,
    issue: Any,
    status_ids: dict[str, str],
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """The specific rule wins whatever order the rules were stored in."""
    add_rule(repositories, "pr_merged", status_ids["completed"])
    add_rule(repositories, "pr_merged", status_ids["started"], "release/*")

    events.handle_record(repositories, sqs_record(merged_event("ABC-1 a change", base="release/1.2")))

    assert status_of(repositories, issue.issue_id) == status_ids["started"]


def test_a_promotion_moves_every_issue_its_commits_name_to_done(
    repositories: Any,
    workspace: str,
    installed: str,
    issue: Any,
    preset: dict[str, str],
    pr_commits: PullRequestCommits,
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """Keys only in the commit messages, well past one page of them, still move on a merge into main."""
    second = seed_issue(repositories, workspace, TEAM, "01JB0000000000000000000IS7", "ABC", 2)
    pr_commits.messages = [f"chore: routine change {index}" for index in range(260)]
    pr_commits.messages[3] = "ABC-1 First change (#10)"
    pr_commits.messages[255] = "Fix the thing\n\nFixes ABC-2"

    events.handle_record(
        repositories,
        sqs_record(merged_event("Promote staging to main", base="main", body="Release of the week.")),
    )

    assert status_of(repositories, issue.issue_id) == preset["Done"]
    assert status_of(repositories, second.issue_id) == preset["Done"]
    assert pr_commits.calls == [
        {
            "installation_id": INSTALLATION_ID,
            "repository_id": REPOSITORY_ID,
            "number": "7",
            "base_sha": "cafebabe",
            "head_sha": "deadbeef",
        }
    ]


def test_an_unreadable_commit_list_still_applies_the_title(
    repositories: Any,
    installed: str,
    issue: Any,
    preset: dict[str, str],
    pr_commits: PullRequestCommits,
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """A repository GitHub no longer shows reads as no commits rather than failing the delivery."""
    from webbpulse.integrations.github import GitHubNotFound

    pr_commits.error = GitHubNotFound("gone")

    events.handle_record(repositories, sqs_record(merged_event("ABC-1 a change", base="main")))

    assert status_of(repositories, issue.issue_id) == preset["Done"]


def test_a_rate_limited_commit_list_retries_the_record(
    repositories: Any,
    installed: str,
    issue: Any,
    preset: dict[str, str],
    pr_commits: PullRequestCommits,
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """A rate limit raises before any write, so the queue redelivers the whole record."""
    from webbpulse.integrations.github import GitHubRateLimited

    pr_commits.error = GitHubRateLimited("slow down")
    before = status_of(repositories, issue.issue_id)

    with pytest.raises(GitHubRateLimited):
        events.handle_record(repositories, sqs_record(merged_event("ABC-1 a change", base="main")))

    assert status_of(repositories, issue.issue_id) == before
    assert repositories.github.list_links_for_issue(WORKSPACE, issue.issue_id).items == []


def test_a_team_on_the_defaults_never_reads_the_commits(
    repositories: Any,
    installed: str,
    issue: Any,
    pr_commits: PullRequestCommits,
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """A commit key carries no magic word, so a default team has no use for the list."""
    events.handle_record(repositories, sqs_record(merged_event("Fixes ABC-1", base="main")))

    assert pr_commits.calls == []


def test_an_opened_promotion_does_not_read_the_commits(
    repositories: Any,
    installed: str,
    issue: Any,
    preset: dict[str, str],
    pr_commits: PullRequestCommits,
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """Only a merge reads the commit list, so opening a promotion moves no shipped issue back to review."""
    pr_commits.messages = ["ABC-1 First change"]

    events.handle_record(repositories, sqs_record(pull_request_event(title="Promote staging", base="main")))

    assert pr_commits.calls == []
    assert status_of(repositories, issue.issue_id) != preset["In Review"]


def place(repositories: Any, issue: Any, status_id: str) -> None:
    """Put one issue in a status before the delivery under test was raised."""
    row = repositories.issues.get(WORKSPACE, issue.issue_id)
    assert row is not None
    repositories.issues.replace(
        row.model_copy(update={"status_id": status_id, "updated_at": utc_now() - timedelta(hours=1)})
    )


def test_an_opened_promotion_carrying_fixes_keys_leaves_staged_issues_on_staging(
    repositories: Any,
    workspace: str,
    installed: str,
    issue: Any,
    preset: dict[str, str],
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """A promotion naming shipped work moves none of it back to In Review, Done included."""
    second = seed_issue(repositories, workspace, TEAM, "01JB0000000000000000000IS7", "ABC", 2)
    place(repositories, issue, preset["On Staging"])
    place(repositories, second, preset["Done"])

    events.handle_record(
        repositories,
        sqs_record(
            pull_request_event(
                title="Promote staging to main", body="Fixes ABC-1\nFixes ABC-2", branch="promote/2026-09-28-a"
            )
        ),
    )

    assert status_of(repositories, issue.issue_id) == preset["On Staging"]
    assert status_of(repositories, second.issue_id) == preset["Done"]
    assert len(repositories.github.list_links_for_issue(WORKSPACE, issue.issue_id).items) == 1


def test_a_promotion_ready_for_review_or_edited_leaves_staged_issues(
    repositories: Any,
    installed: str,
    issue: Any,
    preset: dict[str, str],
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """Readying a draft or typing a key into an open pull request is held to the same rule."""
    place(repositories, issue, preset["On Staging"])

    events.handle_record(
        repositories, sqs_record(pull_request_event(action="edited", title="Promote", body="Fixes ABC-1"))
    )
    events.handle_record(
        repositories, sqs_record(pull_request_event(action="ready_for_review", title="Promote", body="Fixes ABC-1"))
    )

    assert status_of(repositories, issue.issue_id) == preset["On Staging"]


def test_a_merged_promotion_carrying_fixes_keys_moves_staged_issues_to_done(
    repositories: Any,
    installed: str,
    issue: Any,
    preset: dict[str, str],
    pr_commits: PullRequestCommits,
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """The merge into main is a forward move, so it still lands."""
    place(repositories, issue, preset["On Staging"])

    events.handle_record(repositories, sqs_record(merged_event("Promote", base="main", body="Fixes ABC-1")))

    assert status_of(repositories, issue.issue_id) == preset["Done"]


def test_a_late_merge_into_staging_leaves_a_done_issue_done(
    repositories: Any,
    installed: str,
    issue: Any,
    preset: dict[str, str],
    pr_commits: PullRequestCommits,
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """A merge moves forward only, so a staging merge never reopens a shipped issue."""
    place(repositories, issue, preset["Done"])

    events.handle_record(repositories, sqs_record(merged_event("Fixes ABC-1", base="staging")))

    assert status_of(repositories, issue.issue_id) == preset["Done"]


def test_an_opened_pull_request_still_moves_an_issue_forward_within_its_category(
    repositories: Any,
    installed: str,
    issue: Any,
    preset: dict[str, str],
    status_ids: dict[str, str],
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """In Progress to In Review is a later position in the same category, so it moves."""
    place(repositories, issue, status_ids["started"])

    events.handle_record(repositories, sqs_record(pull_request_event(base="staging")))

    assert status_of(repositories, issue.issue_id) == preset["In Review"]


def test_a_closed_pull_request_rule_may_still_move_an_issue_back(
    repositories: Any,
    installed: str,
    issue: Any,
    status_ids: dict[str, str],
    enqueued: list[tuple[str, Any]],
    github_env: None,
) -> None:
    """An abandoned pull request is not held to the forward-only rule."""
    add_rule(repositories, "pr_closed", status_ids["unstarted"])
    place(repositories, issue, status_ids["started"])

    events.handle_record(repositories, sqs_record(pull_request_event(action="closed", state="closed")))

    assert status_of(repositories, issue.issue_id) == status_ids["unstarted"]
