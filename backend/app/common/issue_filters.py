"""The issue list's filter set, shared by the list route and the MCP search tool.

Held in `common` rather than in the issues domain because the MCP tool runs in the
integrations image, which must not import another domain's code, and two copies of
what `assignee_id=none` means would drift. Filtering is applied in the application
after the key query: every filter here is set membership, a negation or a prefix,
none of which an index can express across a team without a GSI per field.
"""

from __future__ import annotations

import hashlib
import inspect
import json
from dataclasses import dataclass, field, fields
from datetime import datetime
from typing import Any, Iterable, Iterator, Mapping, Optional

from app.common.customer_index import CustomerIndex, customer_match
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.relations import LINK_TYPES
from app.common.db.dynamo.team_config import STATUS_CATEGORIES
from app.common.estimates import is_unestimated
from app.common.issue_rules import TRIAGE_STATUS_ID, shown_status_id
from app.common.sla import SLA_STATUSES
from app.common.sla import sla_status as issue_sla_status

NONE = "none"
"""The value that matches an unset field, so "unassigned" is a filter like any other."""

ME = "me"
"""The value that means the caller, resolved from the authorization context."""

CATEGORY_ALIASES: dict[str, str] = {"canceled": "cancelled"}
"""Spellings accepted for a category, because clients carry both and neither is wrong."""

BOOLEAN_VALUES: dict[str, bool] = {"true": True, "false": False}
"""The spellings a boolean filter takes, since a saved view stores every value as text."""

MATCH_MODES: tuple[str, ...] = ("all", "any")
"""How a filter combines its conditions: every one must hold, or at least one."""

MAX_FILTER_GROUPS = 10
"""The most condition groups one filter carries, far past what a person builds by hand."""

MAX_GROUP_DEPTH = 2
"""How deep groups nest: a group may hold groups of its own, and those hold only conditions.

The second level is what lets "any of: this, that, (both of these)" be said under a
list's fixed scope, which always ANDs, by wrapping the person's own conditions in
one group.
"""

GROUP_EXCLUDED_KEYS: frozenset[str] = frozenset(
    {
        "team_id",
        "groups",
        "match",
        "include_archived",
        "archived_only",
        "include_triage",
        "triage_only",
        "q",
    }
)
"""Wire keys a condition group cannot carry: scope and visibility belong to the whole filter."""

GROUP_NESTABLE_KEYS: frozenset[str] = frozenset({"match", "groups"})
"""The structural keys a group still carries for itself: its own match and, one level down, groups."""

FilterValues = frozenset[Optional[str]]


class UnknownStatusCategory(ValueError):
    """A status category outside the fixed five, raised so the caller can 422 on it."""


class UnknownSlaStatus(UnknownStatusCategory):
    """An SLA status outside the fixed four, a subclass so every category catch 422s on it too."""


class InvalidFilterValue(UnknownStatusCategory):
    """A relation or boolean filter value outside its fixed set, 422ed like a category."""


def _boolean(name: str, raw: object) -> Optional[bool]:
    """One boolean filter from a bool or its text spelling, `None` when absent."""
    if raw is None or raw == "" or raw == []:
        return None
    if isinstance(raw, list):
        if len(raw) != 1:
            raise InvalidFilterValue(f"{name} must be true or false")
        raw = raw[0]
    if isinstance(raw, bool):
        return raw
    value = BOOLEAN_VALUES.get(str(raw).strip().lower())
    if value is None:
        raise InvalidFilterValue(f"{name} must be true or false")
    return value


def _relation_types(raw: Iterable[str] | str | None) -> FilterValues:
    """Relation types for `has_relation`, refusing any outside the four a link may take."""
    values = _values(raw, nullable=False)
    for value in values:
        if value not in LINK_TYPES:
            raise InvalidFilterValue(f"has_relation must be one of: {', '.join(LINK_TYPES)}")
    return values


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


def _comma_split(raw: Iterable[str] | str | None) -> FilterValues:
    """A fixed-vocabulary filter's values with any comma list split into its items.

    Only for filters whose values are a fixed set of words, such as status
    categories, where no value can hold a comma, so `completed,cancelled` reads as
    the two categories an agent meant rather than one unknown value.
    """
    values = _values(raw, nullable=False)
    return frozenset(part.strip() for value in values for part in str(value).split(",") if part.strip())


def _categories(raw: Iterable[str] | str | None, *, name: str = "status_category") -> FilterValues:
    """Status categories normalised to the stored spelling, refusing unknown ones.

    Refused rather than matched against nothing, because a misspelt category would
    otherwise read as a filter that happens to have no results. A comma list is
    taken as several categories. `name` is the filter the refusal names.
    """
    normalised: set[Optional[str]] = set()
    for value in _comma_split(raw):
        candidate = CATEGORY_ALIASES.get(str(value).lower(), str(value).lower())
        if candidate not in STATUS_CATEGORIES:
            raise UnknownStatusCategory(
                f"{name} must be one or more of: {', '.join(STATUS_CATEGORIES)}, as a list or comma separated"
            )
        normalised.add(candidate)
    return frozenset(normalised)


def _sla_statuses(raw: Iterable[str] | str | None) -> FilterValues:
    """SLA statuses lower cased, refusing unknown ones for the same reason as categories."""
    normalised: set[Optional[str]] = set()
    for value in _comma_split(raw):
        candidate = str(value).lower()
        if candidate not in SLA_STATUSES:
            raise UnknownSlaStatus(f"sla_status must be one of: {', '.join(SLA_STATUSES)}")
        normalised.add(candidate)
    return frozenset(normalised)


def _match_mode(raw: object, *, name: str = "match") -> str:
    """A match mode from its wire spelling, `all` when absent, refusing any other word."""
    if raw is None or raw == "":
        return "all"
    value = str(raw).strip().lower()
    if value not in MATCH_MODES:
        raise InvalidFilterValue(f"{name} must be one of: {', '.join(MATCH_MODES)}")
    return value


def _text(raw: object) -> Optional[str]:
    """A free text condition trimmed and lower cased, `None` when blank."""
    if raw is None:
        return None
    if isinstance(raw, list):
        raw = " ".join(str(item) for item in raw if item is not None)
    value = str(raw).strip().lower()
    return value or None


def parse_groups(raw: object) -> list[dict[str, Any]]:
    """Condition groups from a list of objects or its JSON text, refusing anything else.

    A query string carries the groups as one JSON array, a saved view and the MCP
    tool as the list itself, so both spellings land here and mean the same.
    """
    if raw is None or raw == "" or raw == []:
        return []
    if isinstance(raw, list) and len(raw) == 1 and isinstance(raw[0], str):
        raw = raw[0]
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError as exc:
            raise InvalidFilterValue("groups must be a JSON array of condition objects") from exc
    if not isinstance(raw, list) or not all(isinstance(item, dict) for item in raw):
        raise InvalidFilterValue("groups must be a list of condition objects")
    if len(raw) > MAX_FILTER_GROUPS:
        raise InvalidFilterValue(f"groups holds at most {MAX_FILTER_GROUPS} groups")
    for item in raw:
        bad = sorted(key for key in item if key in GROUP_EXCLUDED_KEYS - GROUP_NESTABLE_KEYS)
        if bad:
            raise InvalidFilterValue(f"a filter group cannot carry: {', '.join(bad)}")
    return [dict(item) for item in raw]


def subscribed_by_caller(subscriber_id: object, match: object, user_id: str) -> bool:
    """Whether a subscriber condition is exactly "subscribed by me" at the top of an `all` filter.

    That one case reads the caller's own subscription index instead of every team,
    which is what the My issues tab asks for; any other subscriber condition is
    matched after the read like the rest of the filter.
    """
    if subscriber_id is None or str(match or "all").strip().lower() != "all":
        return False
    values = _values(subscriber_id if isinstance(subscriber_id, (str, list, tuple)) else None, nullable=False)
    return len(values) == 1 and next(iter(values)) in (ME, user_id)


@dataclass(frozen=True)
class IssueFilter:
    """Every filter one list request carries, each as a set of accepted values.

    Archived issues are left out unless `include_archived` is set, the way a
    Linear list hides them until its display options ask for them, and
    `archived_only` keeps nothing but them, the way Linear's archive view does. Issues
    awaiting triage are left out the same way unless `include_triage` is set, or
    the status filter names the synthetic triage status, and `triage_only` keeps
    nothing but them. An issue in triage matches the status filters as that
    synthetic status rather than its hidden one. An empty set
    means the filter is absent. Values within one field are ORed and
    fields are ANDed, which is what repeated query keys mean to every client, and a
    `_not` field excludes any issue matching one of its values. `sla_statuses`
    is read against the clock at match time, so a delta sync by `updated_since`
    does not resend an issue whose SLA status moved only because time passed.

    `match` decides how the conditions combine: `all` ANDs them, the default every
    older filter means, and `any` keeps an issue meeting at least one. Each of
    `groups` is a nested filter with its own `match`, counted as one condition of
    this one, which is how "status is Todo and (label is Bug or priority is
    Urgent)" is said. Visibility, archived and triage, is decided only here, at
    the top, so a group never brings back an issue the list hides.
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
    label_ids_all: FilterValues = field(default_factory=frozenset)
    priorities: FilterValues = field(default_factory=frozenset)
    priorities_not: FilterValues = field(default_factory=frozenset)
    parent_ids: FilterValues = field(default_factory=frozenset)
    parent_ids_not: FilterValues = field(default_factory=frozenset)
    has_sub_issues: Optional[bool] = None
    subscriber_ids: FilterValues = field(default_factory=frozenset)
    subscriber_ids_not: FilterValues = field(default_factory=frozenset)
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
    completed_before: Optional[str] = None
    completed_after: Optional[str] = None
    content: Optional[str] = None
    content_not: Optional[str] = None
    query: Optional[str] = None
    include_archived: bool = False
    archived_only: bool = False
    include_triage: bool = False
    triage_only: bool = False
    is_blocked: Optional[bool] = None
    is_blocking: Optional[bool] = None
    has_relations: FilterValues = field(default_factory=frozenset)
    customer_ids: FilterValues = field(default_factory=frozenset)
    customer_ids_not: FilterValues = field(default_factory=frozenset)
    match: str = "all"
    groups: tuple[IssueFilter, ...] = ()
    relation_ids: Optional[Mapping[str, frozenset[str]]] = field(default=None, compare=False)
    subscribed_issue_ids: Optional[Mapping[str, frozenset[str]]] = field(default=None, compare=False)
    customer_index: Optional[CustomerIndex] = field(default=None, compare=False)

    @property
    def named_team_ids(self) -> frozenset[str]:
        """Every team a team filter asks for by name, in this filter or any of its groups."""
        own = frozenset(team_id for team_id in self.team_ids if team_id is not None)
        return own.union(*(group.named_team_ids for group in self.groups))

    @property
    def needs_categories(self) -> bool:
        """Whether matching needs each status's category, which costs a config read."""
        own = bool(
            self.status_categories or self.status_categories_not or self.completed_before or self.completed_after
        )
        return own or any(group.needs_categories for group in self.groups)

    @property
    def needs_relations(self) -> bool:
        """Whether matching needs the workspace's links, which costs one relations read."""
        own = bool(self.has_relations)
        return own or any(group.needs_relations for group in self.groups)

    @property
    def needs_customers(self) -> bool:
        """Whether matching needs the workspace's customer requests, which costs one planning query."""
        own = bool(self.customer_ids or self.customer_ids_not)
        return own or any(group.needs_customers for group in self.groups)

    @property
    def needs_cycles(self) -> bool:
        """Whether a cycle value must be checked or resolved against the teams' cycles."""
        own = bool(self.cycle_ids - {None} or self.cycle_ids_not - {None})
        return own or any(group.needs_cycles for group in self.groups)

    @property
    def subscribers(self) -> frozenset[str]:
        """Every person a subscriber condition names, here or in a group, whose subscriptions must be read."""
        own = {value for value in self.subscriber_ids | self.subscriber_ids_not if value is not None}
        for group in self.groups:
            own |= group.subscribers
        return frozenset(own)

    def _names_triage(self) -> bool:
        """Whether a status condition here or in a group names the synthetic triage status."""
        return TRIAGE_STATUS_ID in self.status_ids or any(group._names_triage() for group in self.groups)

    def _subscribed(self, user_id: str, issue_id: str) -> bool:
        """Whether one person subscribes to one issue, from the resolved subscription index."""
        return issue_id in (self.subscribed_issue_ids or {}).get(user_id, frozenset())

    def _linked(self, relation_type: str, issue_id: str) -> bool:
        """Whether one issue holds a link of one type, from the resolved link index."""
        return issue_id in (self.relation_ids or {}).get(relation_type, frozenset())

    def fingerprint(self) -> str:
        """A short stable digest of the filter, for binding a cursor to it.

        An offset cursor is only meaningful against the set it was cut from, so a
        cursor carried over to a different filter must decode as a fresh start.
        """
        encoded = json.dumps(self._canonical(), sort_keys=True).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()[:16]

    def _canonical(self) -> dict[str, Any]:
        """The filter as plain JSON values, groups included, for the fingerprint."""
        canonical: dict[str, Any] = {}
        for item in fields(self):
            if item.name in ("relation_ids", "subscribed_issue_ids", "customer_index"):
                continue
            value = getattr(self, item.name)
            if isinstance(value, frozenset):
                canonical[item.name] = sorted((entry or "" for entry in value), key=str)
            elif item.name == "groups":
                canonical[item.name] = [group._canonical() for group in value]
            else:
                canonical[item.name] = value
        return canonical

    def matches(self, issue: Issue, categories: Mapping[str, str] | None = None) -> bool:
        """Whether one issue survives the filter: visible, then its conditions combined by `match`.

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
        elif issue.in_triage and not (self.include_triage or self._names_triage()):
            return False
        return self.conditions_hold(issue, categories)

    def conditions_hold(self, issue: Issue, categories: Mapping[str, str] | None = None) -> bool:
        """Whether this filter's conditions and groups hold for one issue, visibility aside.

        Under `all` every condition must hold; under `any` one is enough, and a
        filter with no condition at all holds for every issue either way.
        """
        results = self._conditions(issue, categories or {})
        if self.match == "any":
            seen = False
            for result in results:
                if result:
                    return True
                seen = True
            return not seen
        return all(results)

    def _conditions(self, issue: Issue, categories: Mapping[str, str]) -> Iterator[bool]:
        """One result per condition this filter carries, groups last, lazily so `all` and `any` stop early."""
        if self.team_ids or self.team_ids_not:
            yield _included(self.team_ids, self.team_ids_not, issue.team_id)
        if self.status_ids or self.status_ids_not:
            yield _included(self.status_ids, self.status_ids_not, shown_status_id(issue))
        category = categories.get(issue.status_id)
        if self.status_categories or self.status_categories_not:
            yield _included(self.status_categories, self.status_categories_not, category)
        if self.assignee_ids or self.assignee_ids_not:
            yield _included(self.assignee_ids, self.assignee_ids_not, issue.assignee_id)
        if self.creator_ids or self.creator_ids_not:
            yield _included(self.creator_ids, self.creator_ids_not, issue.created_by)
        if self.label_ids or self.label_ids_not:
            yield _labels_included(self.label_ids, self.label_ids_not, issue.label_ids)
        if self.label_ids_all:
            yield _labels_all(self.label_ids_all, issue.label_ids)
        if self.priorities or self.priorities_not:
            yield _included(self.priorities, self.priorities_not, issue.priority)
        if self.parent_ids or self.parent_ids_not:
            yield _included(self.parent_ids, self.parent_ids_not, issue.parent_id)
        if self.has_sub_issues is not None:
            yield (issue.progress.total > 0) == self.has_sub_issues
        if self.subscriber_ids or self.subscriber_ids_not:
            yield self._subscribers_hold(issue.issue_id)
        if self.cycle_ids or self.cycle_ids_not:
            yield _included(self.cycle_ids, self.cycle_ids_not, issue.cycle_id)
        if self.project_ids or self.project_ids_not:
            yield _included(self.project_ids, self.project_ids_not, issue.project_id)
        if self.project_milestone_ids or self.project_milestone_ids_not:
            yield _included(self.project_milestone_ids, self.project_milestone_ids_not, issue.project_milestone_id)
        if self.estimates or self.estimates_not:
            yield _included(self.estimates, self.estimates_not, estimate_value(issue.estimate))
        if self.sla_statuses:
            yield issue_sla_status(issue) in self.sla_statuses
        if self.due_before or self.due_after:
            yield _due_within(issue.due_date, self.due_after, self.due_before)
        if self.created_after or self.created_before:
            yield _within(issue.created_at, self.created_after, self.created_before)
        if self.updated_after or self.updated_before:
            yield _within(issue.updated_at, self.updated_after, self.updated_before)
        if self.completed_after or self.completed_before:
            yield category == "completed" and _within(
                issue.completed_at or issue.updated_at, self.completed_after, self.completed_before
            )
        if self.is_blocked is not None:
            yield (issue.blocked_by_open_count > 0) == self.is_blocked
        if self.is_blocking is not None:
            yield (issue.blocking_count > 0) == self.is_blocking
        if self.has_relations:
            yield any(kind is not None and self._linked(kind, issue.issue_id) for kind in self.has_relations)
        if self.customer_ids or self.customer_ids_not:
            index = self.customer_index
            held = index.customer_ids("issue", issue.issue_id) if index else frozenset()
            important = index.important_count("issue", issue.issue_id) if index else 0
            yield customer_match(self.customer_ids, self.customer_ids_not, held, important)
        if self.content or self.content_not:
            yield _content_matches(self.content, self.content_not, issue)
        if self.query and self.query.strip():
            yield _query_matches(self.query, issue)
        for group in self.groups:
            yield group.conditions_hold(issue, categories)

    def _subscribers_hold(self, issue_id: str) -> bool:
        """The subscriber condition: one of the wanted people subscribes, none of the unwanted does."""
        if self.subscriber_ids and not any(
            person is not None and self._subscribed(person, issue_id) for person in self.subscriber_ids
        ):
            return False
        return not any(person is not None and self._subscribed(person, issue_id) for person in self.subscriber_ids_not)


def _due_within(due_date: Optional[str], after: Optional[str], before: Optional[str]) -> bool:
    """A due date against exclusive bounds; an issue with no due date meets no bound."""
    if not due_date:
        return False
    if before and not due_date < before:
        return False
    if after and not due_date > after:
        return False
    return True


def _labels_all(wanted: FilterValues, label_ids: list[str]) -> bool:
    """Whether an issue carries every wanted label, `None` standing for "no labels"."""
    present = set(label_ids)
    if None in wanted and present:
        return False
    return {value for value in wanted if value is not None} <= present


def _content_matches(content: Optional[str], content_not: Optional[str], issue: Issue) -> bool:
    """The content condition: a case insensitive substring of the title or the description."""
    haystack = f"{issue.title}\n{issue.body or ''}".lower()
    if content and content not in haystack:
        return False
    if content_not and content_not in haystack:
        return False
    return True


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
    label_id_all: Iterable[str] | str | None = None,
    priority: Iterable[str] | str | None = None,
    priority_not: Iterable[str] | str | None = None,
    parent_id: Iterable[str] | str | None = None,
    parent_id_not: Iterable[str] | str | None = None,
    has_sub_issues: object = None,
    subscriber_id: Iterable[str] | str | None = None,
    subscriber_id_not: Iterable[str] | str | None = None,
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
    completed_before: Optional[str] = None,
    completed_after: Optional[str] = None,
    content: object = None,
    content_not: object = None,
    q: Optional[str] = None,
    include_archived: bool = False,
    archived_only: bool = False,
    include_triage: bool = False,
    triage_only: bool = False,
    is_blocked: object = None,
    is_blocking: object = None,
    has_relation: Iterable[str] | str | None = None,
    customer_id: Iterable[str] | str | None = None,
    customer_id_not: Iterable[str] | str | None = None,
    match: object = None,
    groups: object = None,
) -> IssueFilter:
    """An `IssueFilter` from the list's wire names, sentinels resolved.

    Keyword names match the query parameters and the saved view filter keys, so a
    stored filter can be splatted straight in. `team_id_in` and `team_id_not`
    narrow the teams a list already fanned out over, which is how a workspace
    view says "these teams" or "every team but these". Raises `UnknownStatusCategory` for a
    category outside the fixed five, and its `UnknownSlaStatus` subclass for an
    SLA status outside the fixed four. `is_blocked` and `is_blocking` take a bool
    or `true` and `false`, and `has_relation` a link type, each refused with
    `InvalidFilterValue` otherwise. `customer_id` keeps the issues one of the
    named customers asked for, and `customer_id_not` drops them, `none` standing
    for an issue no customer asked for and `important` for one with an important
    request. Relative cycles, the link index and the
    subscription index are resolved later, by `resolve_issue_filter`, because each
    needs a read. `groups` takes a list of condition objects, or its JSON text,
    each built by these same names plus its own `match`; a group naming a key
    outside them is refused with `InvalidFilterValue`.
    """
    return IssueFilter(
        team_ids=_values(team_id_in, nullable=False),
        team_ids_not=_values(team_id_not, nullable=False),
        status_ids=_values(status_id, nullable=False),
        status_ids_not=_values(status_id_not, nullable=False),
        status_categories=_categories(status_category),
        status_categories_not=_categories(status_category_not, name="status_category_not"),
        assignee_ids=_values(assignee_id, me=user_id),
        assignee_ids_not=_values(assignee_id_not, me=user_id),
        creator_ids=_values(creator_id, me=user_id, nullable=False),
        creator_ids_not=_values(creator_id_not, me=user_id, nullable=False),
        label_ids=_values(label_id),
        label_ids_not=_values(label_id_not),
        label_ids_all=_values(label_id_all),
        priorities=_values(priority, nullable=False),
        priorities_not=_values(priority_not, nullable=False),
        parent_ids=_values(parent_id),
        parent_ids_not=_values(parent_id_not),
        has_sub_issues=_boolean("has_sub_issues", has_sub_issues),
        subscriber_ids=_values(subscriber_id, me=user_id, nullable=False),
        subscriber_ids_not=_values(subscriber_id_not, me=user_id, nullable=False),
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
        completed_before=_day(completed_before),
        completed_after=_day(completed_after),
        content=_text(content),
        content_not=_text(content_not),
        query=q or None,
        include_archived=bool(include_archived),
        archived_only=bool(archived_only),
        include_triage=bool(include_triage),
        triage_only=bool(triage_only),
        is_blocked=_boolean("is_blocked", is_blocked),
        is_blocking=_boolean("is_blocking", is_blocking),
        has_relations=_relation_types(has_relation),
        customer_ids=_values(customer_id),
        customer_ids_not=_values(customer_id_not),
        match=_match_mode(match),
        groups=tuple(_group_filter(user_id, item) for item in parse_groups(groups)),
    )


def _group_filter(user_id: str, raw: Mapping[str, Any]) -> IssueFilter:
    """One condition group as a filter, refusing keys the group cannot carry and groups nested too deep."""
    unknown = sorted(key for key in raw if key not in GROUP_KEYS)
    if unknown:
        raise InvalidFilterValue(f"a filter group cannot carry: {', '.join(unknown)}")
    if any(inner.get("groups") not in (None, "", []) for inner in parse_groups(raw.get("groups"))):
        raise InvalidFilterValue(f"filter groups nest at most {MAX_GROUP_DEPTH} levels deep")
    return build_issue_filter(user_id=user_id, **{key: value for key, value in raw.items() if value is not None})


GROUP_KEYS: frozenset[str] = frozenset(
    name
    for name in inspect.signature(build_issue_filter).parameters
    if name != "user_id" and name not in GROUP_EXCLUDED_KEYS - GROUP_NESTABLE_KEYS
)
"""Every wire key a condition group may carry: the filter's own names, less scope and visibility."""
