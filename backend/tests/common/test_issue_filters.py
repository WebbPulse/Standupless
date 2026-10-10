"""The shared issue filter, held directly rather than through a route.

The list route and the MCP search tool both run this one filter, so its rules are
pinned here once: values in a field are ORed, fields are ANDed, `none` matches the
unset field, `me` is the caller, and a `_not` field excludes.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timezone
from typing import Any

import pytest

from app.common.db.dynamo.issues import Issue
from app.common.issue_filters import IssueFilter, UnknownStatusCategory, build_issue_filter

CALLER = "01JB0000000000000000CALLER"


def _issue(**fields: Any) -> Issue:
    """One in-memory issue with only the fields a test cares about set."""
    base: dict[str, Any] = {
        "workspace_id": "ws",
        "team_id": "team",
        "key": "ABC-1",
        "number": 1,
        "title": "An issue",
        "status_id": "todo",
        "created_by": CALLER,
    }
    base.update(fields)
    return Issue(**base)


def test_an_empty_filter_matches_everything() -> None:
    """No filter is no narrowing, including for an issue with every field unset."""
    assert IssueFilter().matches(_issue())


def test_values_within_a_field_are_ored() -> None:
    """Repeated values are any-of, which is what `k=a&k=b` means to every client."""
    wanted = build_issue_filter(user_id=CALLER, status_id=["todo", "doing"])

    assert wanted.matches(_issue(status_id="todo"))
    assert wanted.matches(_issue(status_id="doing"))
    assert not wanted.matches(_issue(status_id="done"))


def test_fields_are_anded() -> None:
    """Two fields both have to hold."""
    wanted = build_issue_filter(user_id=CALLER, status_id="todo", priority="urgent")

    assert wanted.matches(_issue(status_id="todo", priority="urgent"))
    assert not wanted.matches(_issue(status_id="todo", priority="low"))


def test_a_scalar_value_reads_as_a_one_item_list() -> None:
    """A saved view holding a string expands the same as one holding a list."""
    assert build_issue_filter(user_id=CALLER, status_id="todo") == build_issue_filter(
        user_id=CALLER, status_id=["todo"]
    )


@pytest.mark.parametrize("field", ["assignee_id", "project_id", "cycle_id", "parent_id"])
def test_none_matches_the_unset_field(field: str) -> None:
    """`none` is unassigned, no project, no cycle or top level."""
    wanted = build_issue_filter(user_id=CALLER, **{field: "none"})

    assert wanted.matches(_issue())
    assert not wanted.matches(_issue(**{field: "x"}))


def test_none_combines_with_ids() -> None:
    """`none` is one value among the others, so "mine or unassigned" is one filter."""
    wanted = build_issue_filter(user_id=CALLER, assignee_id=["me", "none"])

    assert wanted.matches(_issue(assignee_id=CALLER))
    assert wanted.matches(_issue())
    assert not wanted.matches(_issue(assignee_id="someone"))


def test_priority_none_is_the_literal_priority() -> None:
    """Priority is never unset, so `none` there is the stored value `none`."""
    wanted = build_issue_filter(user_id=CALLER, priority="none")

    assert wanted.matches(_issue(priority="none"))
    assert not wanted.matches(_issue(priority="high"))


def test_labels_are_any_of_and_none_means_unlabelled() -> None:
    """A label filter matches an issue carrying any one of the labels."""
    wanted = build_issue_filter(user_id=CALLER, label_id=["bug", "none"])

    assert wanted.matches(_issue(label_ids=["bug", "ui"]))
    assert wanted.matches(_issue(label_ids=[]))
    assert not wanted.matches(_issue(label_ids=["ui"]))


def test_negations_exclude() -> None:
    """A `_not` field drops any issue matching one of its values."""
    wanted = build_issue_filter(user_id=CALLER, status_id_not=["done"], label_id_not=["wontfix"])

    assert wanted.matches(_issue(status_id="todo", label_ids=["bug"]))
    assert not wanted.matches(_issue(status_id="done"))
    assert not wanted.matches(_issue(label_ids=["bug", "wontfix"]))


def test_label_not_none_means_labelled() -> None:
    """Excluding `none` from labels keeps only issues that carry one."""
    wanted = build_issue_filter(user_id=CALLER, label_id_not="none")

    assert wanted.matches(_issue(label_ids=["bug"]))
    assert not wanted.matches(_issue(label_ids=[]))


def test_status_category_reads_the_category_map() -> None:
    """A category filter is judged through the status's category, and the US spelling is accepted."""
    wanted = build_issue_filter(user_id=CALLER, status_category=["started", "canceled"])
    categories = {"todo": "unstarted", "doing": "started", "dropped": "cancelled"}

    assert wanted.needs_categories
    assert wanted.matches(_issue(status_id="doing"), categories)
    assert wanted.matches(_issue(status_id="dropped"), categories)
    assert not wanted.matches(_issue(status_id="todo"), categories)
    assert not wanted.matches(_issue(status_id="unknown"), categories)


def test_an_unknown_category_is_refused() -> None:
    """A misspelt category raises rather than matching nothing."""
    with pytest.raises(UnknownStatusCategory):
        build_issue_filter(user_id=CALLER, status_category="finished")


def test_due_bounds_are_strict_and_need_a_date() -> None:
    """`due_before` and `due_after` exclude the bound itself and undated issues."""
    wanted = build_issue_filter(user_id=CALLER, due_after="2026-01-01", due_before="2026-02-01")

    assert wanted.matches(_issue(due_date="2026-01-15"))
    assert not wanted.matches(_issue(due_date="2026-02-01"))
    assert not wanted.matches(_issue())


def test_the_fingerprint_moves_with_the_filter_and_ignores_value_order() -> None:
    """A cursor is bound to the filter, but not to how its values were ordered."""
    first = build_issue_filter(user_id=CALLER, status_id=["a", "b"])
    same = build_issue_filter(user_id=CALLER, status_id=["b", "a"])
    other = build_issue_filter(user_id=CALLER, status_id=["a"])

    assert first.fingerprint() == same.fingerprint()
    assert first.fingerprint() != other.fingerprint()


def test_creator_me_is_the_caller_and_its_negation_excludes() -> None:
    """Created by me keeps the caller's issues, and the negated form drops them."""
    mine = _issue(created_by=CALLER)
    theirs = _issue(created_by="01JB00000000000000000OTHER")

    wanted = build_issue_filter(user_id=CALLER, creator_id="me")
    excluded = build_issue_filter(user_id=CALLER, creator_id_not="me")

    assert wanted.matches(mine) and not wanted.matches(theirs)
    assert excluded.matches(theirs) and not excluded.matches(mine)


def test_an_archived_issue_is_hidden_unless_asked_for() -> None:
    """Lists and boards leave archived issues out, and the flag brings them back."""
    archived = _issue(archived_at=datetime(2026, 9, 1, tzinfo=timezone.utc))

    assert not IssueFilter().matches(archived)
    assert IssueFilter().matches(_issue())
    assert build_issue_filter(user_id=CALLER, include_archived=True).matches(archived)


def test_the_fingerprint_moves_with_include_archived() -> None:
    """A cursor cut without archived issues is not reused for a list that has them."""
    hidden = build_issue_filter(user_id=CALLER)
    shown = build_issue_filter(user_id=CALLER, include_archived=True)

    assert hidden.fingerprint() != shown.fingerprint()


def test_estimate_none_matches_only_the_unestimated() -> None:
    """`none` is the issue with no estimate, and a blank estimate reads as none too."""
    wanted = build_issue_filter(user_id=CALLER, estimate="none")

    assert wanted.matches(_issue())
    assert wanted.matches(_issue(estimate=" "))
    assert not wanted.matches(_issue(estimate="M"))
    assert not wanted.matches(_issue(estimate="0"))


def test_estimate_takes_one_value_or_several_in_any_case() -> None:
    """One estimate narrows to it, several are any-of, and `m` is `M`."""
    one = build_issue_filter(user_id=CALLER, estimate="m")
    several = build_issue_filter(user_id=CALLER, estimate=["S", "M", "none"])

    assert one.matches(_issue(estimate="M"))
    assert not one.matches(_issue(estimate="L"))
    assert not one.matches(_issue())
    assert several.matches(_issue(estimate="S"))
    assert several.matches(_issue())
    assert not several.matches(_issue(estimate="XL"))


def test_estimate_not_excludes_and_none_leaves_out_the_unestimated() -> None:
    """The negation drops the named estimates, and `none` there keeps only estimated issues."""
    no_large = build_issue_filter(user_id=CALLER, estimate_not=["L", "XL"])
    estimated = build_issue_filter(user_id=CALLER, estimate_not="none")

    assert no_large.matches(_issue(estimate="M"))
    assert no_large.matches(_issue())
    assert not no_large.matches(_issue(estimate="xl"))
    assert estimated.matches(_issue(estimate="3"))
    assert not estimated.matches(_issue())


def test_team_id_in_keeps_only_the_named_teams() -> None:
    """Several teams are any-of, so a workspace view can narrow to a few of them."""
    wanted = build_issue_filter(user_id=CALLER, team_id_in=["team", "other"])

    assert wanted.matches(_issue(team_id="team"))
    assert wanted.matches(_issue(team_id="other"))
    assert not wanted.matches(_issue(team_id="third"))


def test_team_id_not_excludes_the_named_teams() -> None:
    """The none-of form leaves every other team in."""
    wanted = build_issue_filter(user_id=CALLER, team_id_not=["team"])

    assert not wanted.matches(_issue(team_id="team"))
    assert wanted.matches(_issue(team_id="other"))


def test_created_bounds_compare_by_day_and_exclude_the_bound() -> None:
    """After and before are exclusive days, and both together are a window."""
    wanted = build_issue_filter(user_id=CALLER, created_after="2026-10-01", created_before="2026-10-05")

    assert not wanted.matches(_issue(created_at=datetime(2026, 10, 1, 23, 0, tzinfo=timezone.utc)))
    assert wanted.matches(_issue(created_at=datetime(2026, 10, 2, 0, 1, tzinfo=timezone.utc)))
    assert wanted.matches(_issue(created_at=datetime(2026, 10, 4, 12, 0, tzinfo=timezone.utc)))
    assert not wanted.matches(_issue(created_at=datetime(2026, 10, 5, 0, 0, tzinfo=timezone.utc)))


def test_updated_bounds_take_a_full_timestamp_as_its_day() -> None:
    """A bound sent as a timestamp is read as its day, so a client may send either."""
    wanted = build_issue_filter(user_id=CALLER, updated_after="2026-10-01T18:30:00Z")

    assert not wanted.matches(_issue(updated_at=datetime(2026, 10, 1, 20, 0, tzinfo=timezone.utc)))
    assert wanted.matches(_issue(updated_at=datetime(2026, 10, 2, 8, 0, tzinfo=timezone.utc)))


def test_new_filters_move_the_fingerprint() -> None:
    """A cursor cut under one team or date window does not carry over to another."""
    plain = build_issue_filter(user_id=CALLER)

    assert build_issue_filter(user_id=CALLER, team_id_in="team").fingerprint() != plain.fingerprint()
    assert build_issue_filter(user_id=CALLER, created_after="2026-10-01").fingerprint() != plain.fingerprint()


def test_is_blocked_reads_the_open_blocker_count() -> None:
    """Blocked means an open blocker counts on the row, so no extra read is needed."""
    blocked = build_issue_filter(user_id=CALLER, is_blocked="true")
    unblocked = build_issue_filter(user_id=CALLER, is_blocked=False)

    assert blocked.matches(_issue(blocked_by_open_count=1))
    assert not blocked.matches(_issue())
    assert unblocked.matches(_issue())
    assert not unblocked.matches(_issue(blocked_by_open_count=2))


def test_is_blocking_needs_an_open_issue_with_a_blocks_link() -> None:
    """A completed or cancelled blocker no longer blocks anything."""
    wanted = build_issue_filter(user_id=CALLER, is_blocking="true")
    linked = IssueFilter(is_blocking=True, relation_ids={"blocks": frozenset({"A"})})
    categories = {"todo": "unstarted", "done": "completed"}

    assert wanted.needs_relations and wanted.needs_categories
    assert linked.matches(_issue(issue_id="A"), categories)
    assert not linked.matches(_issue(issue_id="A", status_id="done"), categories)
    assert not linked.matches(_issue(issue_id="B"), categories)


def test_has_relation_is_any_of_the_named_types() -> None:
    """Each named type is ORed, read from the resolved link index."""
    wanted = build_issue_filter(user_id=CALLER, has_relation=["relates_to", "duplicate_of"])
    resolved = IssueFilter(
        has_relations=wanted.has_relations,
        relation_ids={"relates_to": frozenset({"A"}), "blocks": frozenset({"B"})},
    )

    assert resolved.matches(_issue(issue_id="A"))
    assert not resolved.matches(_issue(issue_id="B"))


@pytest.mark.parametrize(
    ("field", "value"),
    [("is_blocked", "maybe"), ("is_blocking", ["true", "false"]), ("has_relation", "parent_of")],
)
def test_relation_filters_refuse_values_outside_their_set(field: str, value: Any) -> None:
    """A typo is refused rather than quietly matching nothing."""
    with pytest.raises(UnknownStatusCategory):
        build_issue_filter(user_id=CALLER, **{field: value})


def test_the_link_index_does_not_move_the_fingerprint() -> None:
    """A cursor stays valid while links change between pages."""
    wanted = build_issue_filter(user_id=CALLER, has_relation="blocks")

    assert wanted.fingerprint() == replace(wanted, relation_ids={"blocks": frozenset({"A"})}).fingerprint()
    assert wanted.fingerprint() != build_issue_filter(user_id=CALLER).fingerprint()
