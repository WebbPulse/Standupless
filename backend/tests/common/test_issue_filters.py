"""The shared issue filter, held directly rather than through a route.

The list route and the MCP search tool both run this one filter, so its rules are
pinned here once: values in a field are ORed, fields are ANDed, `none` matches the
unset field, `me` is the caller, and a `_not` field excludes.
"""

from __future__ import annotations

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
