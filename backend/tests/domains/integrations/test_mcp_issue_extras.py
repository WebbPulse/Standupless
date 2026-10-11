"""The issue extras MCP tools: removing a relation, following an issue, and bulk edits.

Each tool runs the same `app.common` path its REST route runs, so these tests hold
the MCP end of that contract: the happy path, the refusal a lower role gets from the
route, human identifiers such as ABC-12, names and emails, and the destructive hint.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common.api.schemas.issues import BULK_MAX_ISSUES
from app.common.api.schemas.teams import LabelCreate
from app.common.db.dynamo.issues import Issue
from app.common.labels import create_label
from app.domains.integrations.mcp.tools import TOOLS_BY_NAME
from tests.domains.helpers import GUEST, MEMBER, OWNER, add_team_member, make_team, make_workspace
from tests.domains.integrations.conftest import OTHER_TEAM, OTHER_WORKSPACE, TEAM, WORKSPACE, seed_issue
from tests.domains.integrations.mcp_isolation.issues import FOREIGN_TARGET
from tests.domains.integrations.mcp_isolation.issues import seed as isolation_seed
from tests.domains.integrations.test_mcp import tool
from tests.domains.integrations.test_mcp_tools import answer, mint_for, refusal, seed_planning

SECOND = "01JB0000000000000000000IE2"

THIRD = "01JB0000000000000000000IE3"

FOREIGN_TEAM = "01JB000000000000000000PRJ8"

FOREIGN_SOURCE = "01JB0000000000000000000IE8"

WRITE = ("issues:read", "issues:write")


@pytest.fixture
def second(repositories: Any, issue: Issue) -> Issue:
    """A second issue in the shared team, keyed `ABC-2`."""
    return seed_issue(repositories, WORKSPACE, TEAM, SECOND, "ABC", 2)


def _link(repositories: Any, source: Issue, relation_type: str, target: Issue) -> str:
    """Store one link between two issues, answering its id."""
    return repositories.relations.link(WORKSPACE, source.issue_id, relation_type, target.issue_id, OWNER).link_id


def test_delete_issue_relation_is_marked_destructive() -> None:
    """Clients are told the relation tool deletes something, and the others do not."""
    assert TOOLS_BY_NAME["delete_issue_relation"].descriptor()["annotations"]["destructiveHint"] is True
    for name in ("list_issue_subscribers", "subscribe_to_issue", "unsubscribe_from_issue", "bulk_update_issues"):
        assert TOOLS_BY_NAME[name].descriptor()["annotations"]["destructiveHint"] is False


def test_the_extras_declare_their_routes_scopes() -> None:
    """Each tool needs exactly what its REST route requires in `ROUTE_SCOPES`."""
    assert TOOLS_BY_NAME["delete_issue_relation"].scopes == ("issues:write",)
    assert TOOLS_BY_NAME["list_issue_subscribers"].scopes == ("issues:read",)
    assert TOOLS_BY_NAME["subscribe_to_issue"].scopes == ("issues:write",)
    assert TOOLS_BY_NAME["unsubscribe_from_issue"].scopes == ("issues:write",)
    assert TOOLS_BY_NAME["bulk_update_issues"].scopes == ("issues:write",)


def test_delete_issue_relation_by_id_removes_both_directions(
    client: TestClient, repositories: Any, issue: Issue, second: Issue
) -> None:
    """Naming the link id removes both rows, records the removal and clears the blocked count."""
    link_id = _link(repositories, issue, "blocks", second)
    repositories.issues.set_blocked_by_open_count(WORKSPACE, second.issue_id, 1)
    secret = mint_for(repositories, MEMBER, WRITE)

    removed = answer(
        tool(client, secret, "delete_issue_relation", {"issue_id": issue.issue_id, "relation_id": link_id})
    )

    assert removed["deleted"] is True
    assert removed["type"] == "blocks"
    assert repositories.relations.list_for_issue(WORKSPACE, issue.issue_id) == []
    assert repositories.relations.list_for_issue(WORKSPACE, second.issue_id) == []
    assert repositories.issues.get(WORKSPACE, second.issue_id).blocked_by_open_count == 0
    kinds = [row["kind"] for row in repositories.activity.list_for_issue(WORKSPACE, issue.issue_id).items]
    assert "link_removed" in kinds


def test_delete_issue_relation_takes_the_id_list_issue_relations_answers(
    client: TestClient, repositories: Any, issue: Issue, second: Issue
) -> None:
    """The listing's `relation_id` feeds the delete as is, and `link_id` repeats it."""
    _link(repositories, issue, "blocks", second)
    secret = mint_for(repositories, MEMBER, WRITE)

    listed = answer(tool(client, secret, "list_issue_relations", {"issue_id": issue.issue_id}))["relations"]
    removed = answer(
        tool(
            client,
            secret,
            "delete_issue_relation",
            {"issue_id": issue.issue_id, "relation_id": listed[0]["relation_id"]},
        )
    )

    assert listed[0]["link_id"] == listed[0]["relation_id"]
    assert removed["relation_id"] == listed[0]["relation_id"]
    assert repositories.relations.list_for_issue(WORKSPACE, issue.issue_id) == []


def test_delete_issue_relation_accepts_link_id_as_an_alias(
    client: TestClient, repositories: Any, issue: Issue, second: Issue
) -> None:
    """The deprecated `link_id` argument still names the relation."""
    link_id = _link(repositories, issue, "relates_to", second)
    secret = mint_for(repositories, MEMBER, WRITE)

    removed = answer(tool(client, secret, "delete_issue_relation", {"issue_id": issue.issue_id, "link_id": link_id}))

    assert removed["relation_id"] == link_id
    assert repositories.relations.list_for_issue(WORKSPACE, second.issue_id) == []


def test_delete_issue_relation_by_keys_and_type_from_either_side(
    client: TestClient, repositories: Any, issue: Issue, second: Issue
) -> None:
    """The pair is named by keys, and the inverse type read from the far side names the same link."""
    _link(repositories, issue, "blocks", second)
    _link(repositories, issue, "duplicate_of", second)
    secret = mint_for(repositories, MEMBER, WRITE)

    first = answer(
        tool(
            client,
            secret,
            "delete_issue_relation",
            {"issue_id": "ABC-2", "type": "blocked_by", "target_issue_id": "abc-1"},
        )
    )
    other = answer(
        tool(
            client,
            secret,
            "delete_issue_relation",
            {"issue_id": "ABC-1", "type": "duplicate_of", "target_issue_id": "ABC-2"},
        )
    )

    assert (first["issue_id"], first["type"]) == (second.issue_id, "blocked_by")
    assert (other["issue_id"], other["type"]) == (issue.issue_id, "duplicate_of")
    assert repositories.relations.list_for_issue(WORKSPACE, issue.issue_id) == []


def test_delete_issue_relation_refuses_an_absent_link_and_a_bad_request(
    client: TestClient, repositories: Any, issue: Issue, second: Issue
) -> None:
    """An unknown link is the route's not-found, and naming neither form is an argument error."""
    secret = mint_for(repositories, MEMBER, WRITE)

    missing = refusal(
        tool(
            client,
            secret,
            "delete_issue_relation",
            {"issue_id": "ABC-1", "type": "blocks", "target_issue_id": "ABC-2"},
        )
    )
    unnamed = refusal(tool(client, secret, "delete_issue_relation", {"issue_id": "ABC-1"}))
    wrong = refusal(
        tool(
            client,
            secret,
            "delete_issue_relation",
            {"issue_id": "ABC-1", "type": "parent_of", "target_issue_id": "ABC-2"},
        )
    )

    assert "Not found" in missing
    assert "relation_id" in unnamed
    assert "type must be one of" in wrong


def test_delete_issue_relation_refuses_a_guest_outside_the_team(
    client: TestClient, repositories: Any, hidden_issue: Issue
) -> None:
    """A guest outside the issue's team gets the route's not-found, and the link stays."""
    target = seed_issue(repositories, WORKSPACE, OTHER_TEAM, THIRD, "XYZ", 2)
    link_id = _link(repositories, hidden_issue, "relates_to", target)
    secret = mint_for(repositories, GUEST, WRITE)

    text = refusal(
        tool(client, secret, "delete_issue_relation", {"issue_id": hidden_issue.issue_id, "relation_id": link_id})
    )

    assert "Not found" in text
    assert len(repositories.relations.list_for_issue(WORKSPACE, hidden_issue.issue_id)) == 1


def test_delete_issue_relation_refuses_a_reader_who_may_not_write(
    client: TestClient, repositories: Any, hidden_issue: Issue
) -> None:
    """A guest who sees the team without a write role gets the route's 403, before any lookup."""
    add_team_member(repositories, WORKSPACE, OTHER_TEAM, GUEST, "viewer")
    target = seed_issue(repositories, WORKSPACE, OTHER_TEAM, THIRD, "XYZ", 2)
    _link(repositories, hidden_issue, "relates_to", target)
    secret = mint_for(repositories, GUEST, WRITE)

    text = refusal(
        tool(
            client,
            secret,
            "delete_issue_relation",
            {"issue_id": "XYZ-1", "type": "relates_to", "target_issue_id": "XYZ-2"},
        )
    )

    assert "may not write" in text
    assert len(repositories.relations.list_for_issue(WORKSPACE, hidden_issue.issue_id)) == 1


@pytest.fixture
def foreign_link(repositories: Any, workspace: str) -> str:
    """A second workspace the owner also belongs to, holding one link, answering its id."""
    make_workspace(repositories, OTHER_WORKSPACE, "other", OWNER)
    make_team(repositories, OTHER_WORKSPACE, FOREIGN_TEAM, "OTH")
    seed_issue(repositories, OTHER_WORKSPACE, FOREIGN_TEAM, FOREIGN_SOURCE, "OTH", 1)
    return isolation_seed(repositories, OTHER_WORKSPACE, FOREIGN_TEAM)["relation_id"]


def test_delete_issue_relation_leaves_another_workspaces_link(
    client: TestClient, repositories: Any, issue: Issue, foreign_link: str
) -> None:
    """Naming a foreign link from the home issue removes nothing in either workspace."""
    secret = mint_for(repositories, OWNER, WRITE)

    text = refusal(
        tool(
            client,
            secret,
            "delete_issue_relation",
            {"issue_id": issue.issue_id, "relation_id": foreign_link},
        )
    )

    assert "Not found" in text
    assert [row.target_issue_id for row in repositories.relations.list_for_issue(OTHER_WORKSPACE, FOREIGN_TARGET)]


def test_subscribe_list_and_unsubscribe_round_trip(client: TestClient, repositories: Any, issue: Issue) -> None:
    """Following by key adds the caller, listing names them, and leaving removes them, all idempotent."""
    secret = mint_for(repositories, MEMBER, WRITE)

    followed = answer(tool(client, secret, "subscribe_to_issue", {"issue_id": "abc-1"}))
    again = answer(tool(client, secret, "subscribe_to_issue", {"issue_id": "ABC-1"}))
    listed = answer(tool(client, secret, "list_issue_subscribers", {"issue_id": "ABC-1"}))
    left = answer(tool(client, secret, "unsubscribe_from_issue", {"issue_id": issue.issue_id}))
    left_again = answer(tool(client, secret, "unsubscribe_from_issue", {"issue_id": "ABC-1"}))

    assert followed["subscribed"] is True
    assert [row["user_id"] for row in again["subscribers"]] == [MEMBER]
    assert listed["subscribers"][0]["display_name"] == "Mel Member"
    assert listed["subscribers"][0]["reason"] == "manual"
    assert left["subscribed"] is False
    assert left_again["subscribers"] == []


def test_list_issue_subscribers_needs_only_read(client: TestClient, repositories: Any, issue: Issue) -> None:
    """Listing followers is a read, and a read-only key sees whether the caller follows."""
    repositories.subscriptions.subscribe(WORKSPACE, issue.issue_id, TEAM, OWNER, "creator")
    secret = mint_for(repositories, MEMBER, ("issues:read",))

    listed = answer(tool(client, secret, "list_issue_subscribers", {"issue_id": "ABC-1"}))

    assert [(row["user_id"], row["reason"]) for row in listed["subscribers"]] == [(OWNER, "creator")]
    assert listed["subscribed"] is False


def test_subscribe_and_unsubscribe_a_teammate_by_email(client: TestClient, repositories: Any, issue: Issue) -> None:
    """Naming `user_id` acts on that teammate, records `added_by` and writes both history rows."""
    secret = mint_for(repositories, MEMBER, WRITE)

    added = answer(tool(client, secret, "subscribe_to_issue", {"issue_id": "ABC-1", "user_id": "owner@example.com"}))
    stored = repositories.subscriptions.get(WORKSPACE, issue.issue_id, OWNER)
    removed = answer(tool(client, secret, "unsubscribe_from_issue", {"issue_id": "ABC-1", "user_id": OWNER}))

    assert [row["user_id"] for row in added["subscribers"]] == [OWNER]
    assert added["subscribed"] is False
    assert stored is not None and stored.added_by == MEMBER
    assert removed["subscribers"] == []
    kinds = [row["kind"] for row in repositories.activity.list_for_issue(WORKSPACE, issue.issue_id).items]
    assert "subscriber_added" in kinds
    assert "subscriber_removed" in kinds


def test_subscribing_a_teammate_who_cannot_see_the_issue_is_refused(
    client: TestClient, repositories: Any, hidden_issue: Issue
) -> None:
    """A guest outside the team cannot be added to its issue, and nothing is written."""
    secret = mint_for(repositories, MEMBER, WRITE)

    text = refusal(tool(client, secret, "subscribe_to_issue", {"issue_id": "XYZ-1", "user_id": GUEST}))

    assert "cannot see" in text
    assert repositories.subscriptions.get(WORKSPACE, hidden_issue.issue_id, GUEST) is None


@pytest.mark.parametrize("name", ["list_issue_subscribers", "subscribe_to_issue", "unsubscribe_from_issue"])
def test_subscriber_tools_refuse_a_guest_outside_the_team(
    client: TestClient, repositories: Any, hidden_issue: Issue, name: str
) -> None:
    """The routes answer not-found for an invisible issue, and so do the tools, writing nothing."""
    secret = mint_for(repositories, GUEST, WRITE)

    text = refusal(tool(client, secret, name, {"issue_id": "XYZ-1"}))

    assert "Not found" in text
    assert repositories.subscriptions.list_for_issue(WORKSPACE, hidden_issue.issue_id) == []


def test_bulk_update_issues_by_key_with_names_and_email(
    client: TestClient, repositories: Any, issue: Issue, second: Issue
) -> None:
    """Keys, a status name, label names, a cycle name, a project name and an email all resolve."""
    rows = seed_planning(repositories, WORKSPACE, TEAM, "Home")
    kept = create_label(repositories, WORKSPACE, TEAM, LabelCreate(name="Kept", color="#000000"))
    repositories.issues.replace(issue.model_copy(update={"label_ids": [kept.label_id]}))
    started = [row for row in repositories.team_config.list_statuses(WORKSPACE, TEAM) if row.category == "started"][0]
    secret = mint_for(repositories, MEMBER, WRITE)

    result = answer(
        tool(
            client,
            secret,
            "bulk_update_issues",
            {
                "issue_ids": ["ABC-1", "abc-2"],
                "status_id": started.name.upper(),
                "assignee_id": "member@example.com",
                "priority": "high",
                "add_label_ids": ["Home label"],
                "cycle_id": "Home cycle",
                "project_id": "Home project",
                "project_milestone_id": "Home milestone",
            },
        )
    )

    assert [row["issue_key"] for row in result["issues"]] == ["ABC-1", "ABC-2"]
    assert result["skipped"] == []
    for issue_id in (issue.issue_id, second.issue_id):
        stored = repositories.issues.get(WORKSPACE, issue_id)
        assert stored.status_id == started.status_id
        assert stored.assignee_id == MEMBER
        assert stored.priority == "high"
        assert rows["label_id"] in stored.label_ids
        assert stored.cycle_id == rows["cycle_id"]
        assert stored.project_id == rows["project_id"]
        assert stored.project_milestone_id == rows["milestone_id"]
    assert repositories.issues.get(WORKSPACE, issue.issue_id).label_ids == [kept.label_id, rows["label_id"]]


def test_bulk_update_issues_clears_with_null_and_archives(
    client: TestClient, repositories: Any, issue: Issue, second: Issue
) -> None:
    """An explicit null unassigns, an absent field is left alone, and archived archives the selection."""
    for row in (issue, second):
        repositories.issues.replace(row.model_copy(update={"assignee_id": MEMBER, "priority": "low"}))
    secret = mint_for(repositories, MEMBER, WRITE)

    answer(
        tool(
            client,
            secret,
            "bulk_update_issues",
            {"issue_ids": [issue.issue_id, "ABC-2"], "assignee_id": None, "archived": True},
        )
    )

    for issue_id in (issue.issue_id, second.issue_id):
        stored = repositories.issues.get(WORKSPACE, issue_id)
        assert stored.assignee_id is None
        assert stored.priority == "low"
        assert stored.archived_at is not None


def test_bulk_update_issues_is_all_or_nothing_for_a_guest(
    client: TestClient, repositories: Any, issue: Issue, hidden_issue: Issue
) -> None:
    """A guest naming one issue outside their team changes none, as the route's 404 does."""
    secret = mint_for(repositories, GUEST, WRITE)

    text = refusal(
        tool(
            client,
            secret,
            "bulk_update_issues",
            {"issue_ids": ["ABC-1", hidden_issue.issue_id], "priority": "urgent"},
        )
    )

    assert "Not found" in text
    assert repositories.issues.get(WORKSPACE, issue.issue_id).priority == "none"
    assert repositories.issues.get(WORKSPACE, hidden_issue.issue_id).priority == "none"


def test_bulk_update_issues_refuses_a_reader_who_may_not_write(
    client: TestClient, repositories: Any, hidden_issue: Issue
) -> None:
    """A guest who sees the team without a write role gets the route's 403."""
    add_team_member(repositories, WORKSPACE, OTHER_TEAM, GUEST, "viewer")
    secret = mint_for(repositories, GUEST, WRITE)

    text = refusal(tool(client, secret, "bulk_update_issues", {"issue_ids": ["XYZ-1"], "priority": "urgent"}))

    assert "may not write" in text
    assert repositories.issues.get(WORKSPACE, hidden_issue.issue_id).priority == "none"


def test_bulk_update_issues_holds_the_routes_limits(
    client: TestClient, repositories: Any, issue: Issue, second: Issue
) -> None:
    """Too many issues, a label both added and removed, and a value one team refuses all change nothing."""
    secret = mint_for(repositories, MEMBER, WRITE)

    too_many = refusal(
        tool(
            client,
            secret,
            "bulk_update_issues",
            {"issue_ids": [issue.issue_id] * (BULK_MAX_ISSUES + 1), "priority": "high"},
        )
    )
    overlap = refusal(
        tool(
            client,
            secret,
            "bulk_update_issues",
            {"issue_ids": ["ABC-1"], "add_label_ids": ["x"], "remove_label_ids": ["x"]},
        )
    )
    unknown = refusal(
        tool(
            client,
            secret,
            "bulk_update_issues",
            {"issue_ids": ["ABC-1", "ABC-2"], "priority": "high", "status_id": "No such status"},
        )
    )

    assert str(BULK_MAX_ISSUES) in too_many
    assert "both added and removed" in overlap
    assert unknown
    assert repositories.issues.get(WORKSPACE, issue.issue_id).priority == "none"
    assert repositories.issues.get(WORKSPACE, second.issue_id).priority == "none"


def test_move_issue_gives_a_new_key_and_the_old_one_keeps_answering(
    client: TestClient, repositories: Any, issue: Issue
) -> None:
    """Moving `ABC-1` by team key lands it as `XYZ-1`, and `get_issue` still finds it by `ABC-1`."""
    secret = mint_for(repositories, MEMBER, WRITE)

    moved = answer(tool(client, secret, "move_issue", {"issue_id": "ABC-1", "team_id": "XYZ"}))
    fetched = answer(tool(client, secret, "get_issue", {"issue_key": "ABC-1"}))

    assert TOOLS_BY_NAME["move_issue"].scopes == ("issues:write",)
    assert moved["issue_id"] == issue.issue_id
    assert moved["team_id"] == OTHER_TEAM
    assert moved["issue_key"] == "XYZ-1"
    assert fetched["issue_id"] == issue.issue_id
    assert fetched["issue_key"] == "XYZ-1"


def test_move_issue_refuses_a_guest_outside_the_target_team(
    client: TestClient, repositories: Any, issue: Issue
) -> None:
    """The guest writes only in `TEAM`, so the move refuses and the key is unchanged."""
    secret = mint_for(repositories, GUEST, WRITE)

    refusal(tool(client, secret, "move_issue", {"issue_id": "ABC-1", "team_id": OTHER_TEAM}))

    assert repositories.issues.get(WORKSPACE, issue.issue_id).team_id == TEAM


def _estimate(repositories: Any, row: Issue, estimate: Any) -> None:
    """Store `estimate` on one issue directly, past the team's scale check."""
    repositories.issues.replace(row.model_copy(update={"estimate": estimate}))


def test_list_and_search_filter_on_estimate_and_return_it(
    client: TestClient, repositories: Any, issue: Issue, second: Issue
) -> None:
    """`none`, one value and several values narrow the listing, and every row carries `estimate`."""
    third = seed_issue(repositories, WORKSPACE, TEAM, THIRD, "ABC", 3)
    _estimate(repositories, issue, "M")
    _estimate(repositories, second, "S")
    secret = mint_for(repositories, MEMBER, WRITE)

    def keys(name: str, **arguments: Any) -> set[str]:
        result = answer(tool(client, secret, name, {"team_id": TEAM, **arguments}))
        return {row["issue_key"] for row in result["issues"]}

    assert keys("list_issues", estimate="none") == {third.key}
    assert keys("list_issues", estimate="m") == {"ABC-1"}
    assert keys("search_issues", estimate=["S", "M"]) == {"ABC-1", "ABC-2"}
    assert keys("search_issues", estimate_not="none") == {"ABC-1", "ABC-2"}
    assert keys("list_issues", estimate_not=["M", "none"]) == {"ABC-2"}

    rows = answer(tool(client, secret, "list_issues", {"team_id": TEAM, "sort": "key_asc"}))["issues"]
    assert {row["issue_key"]: row["estimate"] for row in rows} == {"ABC-1": "M", "ABC-2": "S", "ABC-3": None}


def test_bulk_update_only_if_estimate_none_skips_the_estimated(
    client: TestClient, repositories: Any, issue: Issue, second: Issue
) -> None:
    """Only the unestimated issue is written, the estimated one comes back under skipped untouched."""
    _estimate(repositories, issue, "M")
    secret = mint_for(repositories, MEMBER, WRITE)

    result = answer(
        tool(
            client,
            secret,
            "bulk_update_issues",
            {"issue_ids": ["ABC-1", "ABC-2"], "estimate": None, "priority": "high", "only_if_estimate": "none"},
        )
    )

    assert [row["issue_key"] for row in result["issues"]] == ["ABC-2"]
    assert result["issues"][0]["estimate"] is None
    assert result["skipped"] == [issue.issue_id]
    assert repositories.issues.get(WORKSPACE, issue.issue_id).priority == "none"
    assert repositories.issues.get(WORKSPACE, issue.issue_id).estimate == "M"
    assert repositories.issues.get(WORKSPACE, second.issue_id).priority == "high"


def test_bulk_update_only_if_estimate_matches_a_value(
    client: TestClient, repositories: Any, issue: Issue, second: Issue
) -> None:
    """A named estimate writes the issues holding it and skips the unestimated one."""
    _estimate(repositories, second, "S")
    secret = mint_for(repositories, MEMBER, WRITE)

    result = answer(
        tool(
            client,
            secret,
            "bulk_update_issues",
            {"issue_ids": ["ABC-1", "ABC-2"], "priority": "low", "only_if_estimate": "s"},
        )
    )

    assert [row["issue_key"] for row in result["issues"]] == ["ABC-2"]
    assert result["issues"][0]["estimate"] == "S"
    assert result["skipped"] == [issue.issue_id]
    assert repositories.issues.get(WORKSPACE, issue.issue_id).priority == "none"


def test_bulk_update_only_if_estimate_skips_a_peer_write_in_between(
    client: TestClient, repositories: Any, issue: Issue, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An estimate set after the read fails the write condition, so the issue is skipped, not overwritten."""
    from app.common import issue_writes

    real = issue_writes.apply_patch

    def racing(repositories_: Any, context: Any, current: Issue, attributes: Any) -> Issue:
        _estimate(repositories, current, "L")
        return real(repositories_, context, current, attributes)

    monkeypatch.setattr(issue_writes, "apply_patch", racing)
    secret = mint_for(repositories, MEMBER, WRITE)

    result = answer(
        tool(
            client,
            secret,
            "bulk_update_issues",
            {"issue_ids": ["ABC-1"], "priority": "urgent", "only_if_estimate": "none"},
        )
    )

    assert result["issues"] == []
    assert result["skipped"] == [issue.issue_id]
    stored = repositories.issues.get(WORKSPACE, issue.issue_id)
    assert stored.estimate == "L"
    assert stored.priority == "none"
