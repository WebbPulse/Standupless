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
from datetime import datetime
from typing import Iterable, Mapping, Optional

from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.team_config import STATUS_CATEGORIES
from app.common.estimates import is_unestimated
from app.common.sla import SLA_STATUSES
from app.common.sla import sla_status as issue_sla_status

NONE = "none"
"""The value that matches an unset field, so "unassigned" is a filter like any other."""

ME = "me"
"""The value that means the caller, resolved from the authorization context."""

CATEGORY_ALIASES: dict[str, str] = {"canceled": "cancelled"}
"""Spellings accepted for a category, because clients carry both and neither is wrong."""

FilterValues = frozenset[Optional[str]]


class UnknownStatusCategory(ValueError):
    """A status category outside the fixed five, raised so the caller can 422 on it."""


class UnknownSlaStatus(UnknownStatusCategory):
    """An SLA status outside the fixed four, a subclass so every category catch 422s on it too."""


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


def _sla_statuses(raw: Iterable[str] | str | None) -> FilterValues:
    """SLA statuses lower cased, refusing unknown ones for the same reason as categories."""
    normalised: set[Optional[str]] = set()
    for value in _values(raw, nullable=False):
        candidate = str(value).lower()
        if candidate not in SLA_STATUSES:
            raise UnknownSlaStatus(f"sla_status must be one of: {', '.join(SLA_STATUSES)}")
        normalised.add(candidate)
    return frozenset(normalised)


@dataclass(frozen=True)
class IssueFilter:
    """Every filter one list request carries, each as a set of accepted values.

    Archived issues are left out unless `include_archived` is set, the way a
    Linear list hides them until its display options ask for them, and
    `archived_only` keeps nothing but them, the way Linear's archive view does. Issues
    awaiting triage are left out the same way unless `include_triage` is set, and
    `triage_only` keeps nothing but them. An empty set
    means the filter is absent. Values within one field are ORed and
    fields are ANDed, which is what repeated query keys mean to every client, and a
    `_not` field excludes any issue matching one of its values. `sla_statuses`
    is read against the clock at match time, so a delta sync by `updated_since`
    does not resend an issue whose SLA status moved only because time passed.
    """

    team_ids: FilterValues = field(default_factory=frozenset)
    team_ids_not: FilterValues = field(default_factory=frozenset)
    status_ids: FilterValues = field(default_factory=frozenset)
    status_ids_not: FilterValues = field(default_factory=frozenset)
    status_categories: FilterValues = field(default_factory=frozenset)
    status_categories_not: FilterValues = field(default_factory=frozenset)
    assignee_ids: FilterValues = field(default_factory=frozenset)
    assignee_ids_not: FilterValues = field(default_factory=frozenset)
    creator_ids: FilterValues = field(default_factory=frozenset)
    creator_ids_not: FilterValues = field(default_factory=frozenset)
    label_ids: FilterValues = field(default_factory=frozenset)
    label_ids_not: FilterValues = field(default_factory=frozenset)
    priorities: FilterValues = field(default_factory=frozenset)
    priorities_not: FilterValues = field(default_factory=frozenset)
    parent_ids: FilterValues = field(default_factory=frozenset)
    cycle_ids: FilterValues = field(default_factory=frozenset)
    cycle_ids_not: FilterValues = field(default_factory=frozenset)
    project_ids: FilterValues = field(default_factory=frozenset)
    project_ids_not: FilterValues = field(default_factory=frozenset)
    project_milestone_ids: FilterValues = field(default_factory=frozenset)
    project_milestone_ids_not: FilterValues = field(default_factory=frozenset)
    estimates: FilterValues = field(default_factory=frozenset)
    estimates_not: FilterValues = field(default_factory=frozenset)
    sla_statuses: FilterValues = field(default_factory=frozenset)
    due_before: Optional[str] = None
    due_after: Optional[str] = None
    created_before: Optional[str] = None
    created_after: Optional[str] = None
    updated_before: Optional[str] = None
    updated_after: Optional[str] = None
    query: Optional[str] = None
    include_archived: bool = False
    archived_only: bool = False
    include_triage: bool = False
    triage_only: bool = False

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
        if self.archived_only:
            if issue.archived_at is None:
                return False
        elif issue.archived_at is not None and not self.include_archived:
            return False
        if self.triage_only:
            if not issue.in_triage:
                return False
        elif issue.in_triage and not self.include_triage:
            return False
        if not _included(self.team_ids, self.team_ids_not, issue.team_id):
            return False
        if not _included(self.status_ids, self.status_ids_not, issue.status_id):
            return False
        if self.needs_categories:
            category = (categories or {}).get(issue.status_id)
            if not _included(self.status_categories, self.status_categories_not, category):
                return False
        if not _included(self.assignee_ids, self.assignee_ids_not, issue.assignee_id):
            return False
        if not _included(self.creator_ids, self.creator_ids_not, issue.created_by):
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
        if not _included(self.project_milestone_ids, self.project_milestone_ids_not, issue.project_milestone_id):
            return False
        if not _included(self.estimates, self.estimates_not, estimate_value(issue.estimate)):
            return False
        if self.sla_statuses and issue_sla_status(issue) not in self.sla_statuses:
            return False
        if self.due_before and not (issue.due_date and issue.due_date < self.due_before):
            return False
        if self.due_after and not (issue.due_date and issue.due_date > self.due_after):
            return False
        if not _within(issue.created_at, self.created_after, self.created_before):
            return False
        if not _within(issue.updated_at, self.updated_after, self.updated_before):
            return False
        return _query_matches(self.query, issue)


def _within(moment: datetime, after: Optional[str], before: Optional[str]) -> bool:
    """One timestamp's calendar day against an exclusive after and before day.

    Compared by UTC day rather than instant, the way the due date bounds are, so
    "created after 2026-10-01" means from the 2nd whatever the hour.
    """
    day = moment.date().isoformat()
    if after and not day > after:
        return False
    if before and not day < before:
        return False
    return True


def _day(value: Optional[str]) -> Optional[str]:
    """A date bound reduced to its `YYYY-MM-DD` day, so a full timestamp bound still compares by day."""
    if not value:
        return None
    text = str(value).strip()[:10]
    return text or None


def _included(wanted: FilterValues, unwanted: FilterValues, value: Optional[str]) -> bool:
    """One scalar field against its any-of set and its none-of set."""
    if wanted and value not in wanted:
        return False
    if unwanted and value in unwanted:
        return False
    return True


def estimate_value(value: Optional[str]) -> Optional[str]:
    """One estimate as the filter compares it: `None` when unset, else upper case.

    Upper case so `m` finds a t-shirt `M`; numbers are untouched by it. A blank
    estimate counts as unset, the same rule `is_unestimated` gives the rollups.
    """
    if is_unestimated(value):
        return None
    return str(value).strip().upper()


def _estimates(raw: Iterable[str] | str | None) -> FilterValues:
    """Estimate filter values normalised the way `estimate_value` reads an issue, `none` as unset."""
    return frozenset(None if value is None else estimate_value(value) for value in _values(raw))


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
    team_id_in: Iterable[str] | str | None = None,
    team_id_not: Iterable[str] | str | None = None,
    status_id: Iterable[str] | str | None = None,
    status_id_not: Iterable[str] | str | None = None,
    status_category: Iterable[str] | str | None = None,
    status_category_not: Iterable[str] | str | None = None,
    assignee_id: Iterable[str] | str | None = None,
    assignee_id_not: Iterable[str] | str | None = None,
    creator_id: Iterable[str] | str | None = None,
    creator_id_not: Iterable[str] | str | None = None,
    label_id: Iterable[str] | str | None = None,
    label_id_not: Iterable[str] | str | None = None,
    priority: Iterable[str] | str | None = None,
    priority_not: Iterable[str] | str | None = None,
    parent_id: Iterable[str] | str | None = None,
    cycle_id: Iterable[str] | str | None = None,
    cycle_id_not: Iterable[str] | str | None = None,
    project_id: Iterable[str] | str | None = None,
    project_id_not: Iterable[str] | str | None = None,
    project_milestone_id: Iterable[str] | str | None = None,
    project_milestone_id_not: Iterable[str] | str | None = None,
    estimate: Iterable[str] | str | None = None,
    estimate_not: Iterable[str] | str | None = None,
    sla_status: Iterable[str] | str | None = None,
    due_before: Optional[str] = None,
    due_after: Optional[str] = None,
    created_before: Optional[str] = None,
    created_after: Optional[str] = None,
    updated_before: Optional[str] = None,
    updated_after: Optional[str] = None,
    q: Optional[str] = None,
    include_archived: bool = False,
    archived_only: bool = False,
    include_triage: bool = False,
    triage_only: bool = False,
) -> IssueFilter:
    """An `IssueFilter` from the list's wire names, sentinels resolved.

    Keyword names match the query parameters and the saved view filter keys, so a
    stored filter can be splatted straight in. `team_id_in` and `team_id_not`
    narrow the teams a list already fanned out over, which is how a workspace
    view says "these teams" or "every team but these". Raises `UnknownStatusCategory` for a
    category outside the fixed five, and its `UnknownSlaStatus` subclass for an
    SLA status outside the fixed four.
    """
    return IssueFilter(
        team_ids=_values(team_id_in, nullable=False),
        team_ids_not=_values(team_id_not, nullable=False),
        status_ids=_values(status_id, nullable=False),
        status_ids_not=_values(status_id_not, nullable=False),
        status_categories=_categories(status_category),
        status_categories_not=_categories(status_category_not),
        assignee_ids=_values(assignee_id, me=user_id),
        assignee_ids_not=_values(assignee_id_not, me=user_id),
        creator_ids=_values(creator_id, me=user_id, nullable=False),
        creator_ids_not=_values(creator_id_not, me=user_id, nullable=False),
        label_ids=_values(label_id),
        label_ids_not=_values(label_id_not),
        priorities=_values(priority, nullable=False),
        priorities_not=_values(priority_not, nullable=False),
        parent_ids=_values(parent_id),
        cycle_ids=_values(cycle_id),
        cycle_ids_not=_values(cycle_id_not),
        project_ids=_values(project_id),
        project_ids_not=_values(project_id_not),
        project_milestone_ids=_values(project_milestone_id),
        project_milestone_ids_not=_values(project_milestone_id_not),
        estimates=_estimates(estimate),
        estimates_not=_estimates(estimate_not),
        sla_statuses=_sla_statuses(sla_status),
        due_before=due_before or None,
        due_after=due_after or None,
        created_before=_day(created_before),
        created_after=_day(created_after),
        updated_before=_day(updated_before),
        updated_after=_day(updated_after),
        query=q or None,
        include_archived=bool(include_archived),
        archived_only=bool(archived_only),
        include_triage=bool(include_triage),
        triage_only=bool(triage_only),
    )
