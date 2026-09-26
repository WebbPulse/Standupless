"""The issue list's filter set, shared by the list route and the MCP search tool.

Held in `common` rather than in the issues domain because the MCP tool runs in the
integrations image, which must not import another domain's code, and two copies of
what `assignee_id=none` means would drift. Filtering is applied in the application
after the key query: every filter here is set membership, a negation or a prefix,
none of which an index can express across a team without a GSI per field.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field, fields
from typing import Iterable, Mapping, Optional

from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.team_config import STATUS_CATEGORIES

NONE = "none"
"""The value that matches an unset field, so "unassigned" is a filter like any other."""

ME = "me"
"""The value that means the caller, resolved from the authorization context."""

CATEGORY_ALIASES: dict[str, str] = {"canceled": "cancelled"}
"""Spellings accepted for a category, because clients carry both and neither is wrong."""

FilterValues = frozenset[Optional[str]]


class UnknownStatusCategory(ValueError):
    """A status category outside the fixed five, raised so the caller can 422 on it."""


def _values(raw: Iterable[str] | str | None, *, me: str | None = None, nullable: bool = True) -> FilterValues:
    """One filter's raw values as a set, with the sentinels resolved.

    A bare string is one value, so a saved view filter holding a scalar and one
    holding a list both expand the same way. `none` becomes `None` only where the
    field can be unset, which is why `status_id` and `priority` take it literally.
    """
    if raw is None:
        return frozenset()
    items = [raw] if isinstance(raw, str) else list(raw)
    resolved: set[Optional[str]] = set()
    for item in items:
        if item is None:
            continue
        value = str(item).strip()
        if not value:
            continue
        if nullable and value == NONE:
            resolved.add(None)
        elif me is not None and value == ME:
            resolved.add(me)
        else:
            resolved.add(value)
    return frozenset(resolved)


def _categories(raw: Iterable[str] | str | None) -> FilterValues:
    """Status categories normalised to the stored spelling, refusing unknown ones.

    Refused rather than matched against nothing, because a misspelt category would
    otherwise read as a filter that happens to have no results.
    """
    values = _values(raw, nullable=False)
    normalised: set[Optional[str]] = set()
    for value in values:
        candidate = CATEGORY_ALIASES.get(str(value).lower(), str(value).lower())
        if candidate not in STATUS_CATEGORIES:
            raise UnknownStatusCategory(f"status_category must be one of: {', '.join(STATUS_CATEGORIES)}")
        normalised.add(candidate)
    return frozenset(normalised)


@dataclass(frozen=True)
class IssueFilter:
    """Every filter one list request carries, each as a set of accepted values.

    An empty set means the filter is absent. Values within one field are ORed and
    fields are ANDed, which is what repeated query keys mean to every client, and a
    `_not` field excludes any issue matching one of its values.
    """

    status_ids: FilterValues = field(default_factory=frozenset)
    status_ids_not: FilterValues = field(default_factory=frozenset)
    status_categories: FilterValues = field(default_factory=frozenset)
    status_categories_not: FilterValues = field(default_factory=frozenset)
    assignee_ids: FilterValues = field(default_factory=frozenset)
    assignee_ids_not: FilterValues = field(default_factory=frozenset)
    label_ids: FilterValues = field(default_factory=frozenset)
    label_ids_not: FilterValues = field(default_factory=frozenset)
    priorities: FilterValues = field(default_factory=frozenset)
    priorities_not: FilterValues = field(default_factory=frozenset)
    parent_ids: FilterValues = field(default_factory=frozenset)
    cycle_ids: FilterValues = field(default_factory=frozenset)
    cycle_ids_not: FilterValues = field(default_factory=frozenset)
    project_ids: FilterValues = field(default_factory=frozenset)
    project_ids_not: FilterValues = field(default_factory=frozenset)
    due_before: Optional[str] = None
    due_after: Optional[str] = None
    query: Optional[str] = None

    @property
    def needs_categories(self) -> bool:
        """Whether matching needs each status's category, which costs a config read."""
        return bool(self.status_categories or self.status_categories_not)

    def fingerprint(self) -> str:
        """A short stable digest of the filter, for binding a cursor to it.

        An offset cursor is only meaningful against the set it was cut from, so a
        cursor carried over to a different filter must decode as a fresh start.
        """
        canonical = {
            item.name: sorted((value or "" for value in getattr(self, item.name)), key=str)
            if isinstance(getattr(self, item.name), frozenset)
            else getattr(self, item.name)
            for item in fields(self)
        }
        encoded = json.dumps(canonical, sort_keys=True).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()[:16]

    def matches(self, issue: Issue, categories: Mapping[str, str] | None = None) -> bool:
        """Whether one issue survives every filter.

        `categories` maps status id to category and is only read when a category
        filter is present; an unknown status matches no category rather than all.
        """
        if not _included(self.status_ids, self.status_ids_not, issue.status_id):
            return False
        if self.needs_categories:
            category = (categories or {}).get(issue.status_id)
            if not _included(self.status_categories, self.status_categories_not, category):
                return False
        if not _included(self.assignee_ids, self.assignee_ids_not, issue.assignee_id):
            return False
        if not _labels_included(self.label_ids, self.label_ids_not, issue.label_ids):
            return False
        if not _included(self.priorities, self.priorities_not, issue.priority):
            return False
        if self.parent_ids and issue.parent_id not in self.parent_ids:
            return False
        if not _included(self.cycle_ids, self.cycle_ids_not, issue.cycle_id):
            return False
        if not _included(self.project_ids, self.project_ids_not, issue.project_id):
            return False
        if self.due_before and not (issue.due_date and issue.due_date < self.due_before):
            return False
        if self.due_after and not (issue.due_date and issue.due_date > self.due_after):
            return False
        return _query_matches(self.query, issue)


def _included(wanted: FilterValues, unwanted: FilterValues, value: Optional[str]) -> bool:
    """One scalar field against its any-of set and its none-of set."""
    if wanted and value not in wanted:
        return False
    if unwanted and value in unwanted:
        return False
    return True


def _labels_included(wanted: FilterValues, unwanted: FilterValues, label_ids: list[str]) -> bool:
    """The label set against any-of and none-of, `None` standing for "no labels"."""
    present = set(label_ids)
    if wanted:
        hit = bool(present & wanted) or (None in wanted and not present)
        if not hit:
            return False
    if unwanted:
        if present & unwanted:
            return False
        if None in unwanted and not present:
            return False
    return True


def _query_matches(query: Optional[str], issue: Issue) -> bool:
    """The contract's `q`: a key or a title prefix, case insensitive."""
    if not query:
        return True
    needle = query.strip().lower()
    if not needle:
        return True
    return needle in issue.key.lower() or issue.title.lower().startswith(needle)


def build_issue_filter(
    *,
    user_id: str,
    status_id: Iterable[str] | str | None = None,
    status_id_not: Iterable[str] | str | None = None,
    status_category: Iterable[str] | str | None = None,
    status_category_not: Iterable[str] | str | None = None,
    assignee_id: Iterable[str] | str | None = None,
    assignee_id_not: Iterable[str] | str | None = None,
    label_id: Iterable[str] | str | None = None,
    label_id_not: Iterable[str] | str | None = None,
    priority: Iterable[str] | str | None = None,
    priority_not: Iterable[str] | str | None = None,
    parent_id: Iterable[str] | str | None = None,
    cycle_id: Iterable[str] | str | None = None,
    cycle_id_not: Iterable[str] | str | None = None,
    project_id: Iterable[str] | str | None = None,
    project_id_not: Iterable[str] | str | None = None,
    due_before: Optional[str] = None,
    due_after: Optional[str] = None,
    q: Optional[str] = None,
) -> IssueFilter:
    """An `IssueFilter` from the list's wire names, sentinels resolved.

    Keyword names match the query parameters and the saved view filter keys, so a
    stored filter can be splatted straight in. Raises `UnknownStatusCategory` for a
    category outside the fixed five.
    """
    return IssueFilter(
        status_ids=_values(status_id, nullable=False),
        status_ids_not=_values(status_id_not, nullable=False),
        status_categories=_categories(status_category),
        status_categories_not=_categories(status_category_not),
        assignee_ids=_values(assignee_id, me=user_id),
        assignee_ids_not=_values(assignee_id_not, me=user_id),
        label_ids=_values(label_id),
        label_ids_not=_values(label_id_not),
        priorities=_values(priority, nullable=False),
        priorities_not=_values(priority_not, nullable=False),
        parent_ids=_values(parent_id),
        cycle_ids=_values(cycle_id),
        cycle_ids_not=_values(cycle_id_not),
        project_ids=_values(project_id),
        project_ids_not=_values(project_id_not),
        due_before=due_before or None,
        due_after=due_after or None,
        query=q or None,
    )
