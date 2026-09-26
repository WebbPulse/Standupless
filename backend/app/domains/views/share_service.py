"""The reads behind a share token, and the projections that bound them.

Everything an anonymous reader is ever shown passes through this module, which is
why the projections live here rather than in the route: a route that built its own
response could quietly include a field, and there would be no single place to read
to find out what a token exposes.

Each projection takes stored rows and answers a public shape. None of them accept
an `AuthzContext`, because there is no caller to decide against: the token already
decided, and the only question left is what the one row it named contains.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Callable, Iterable, Mapping, Optional

from fastapi import HTTPException, status
from webbpulse.identity.share_tokens import verify_share_token

from app.common.api.dependencies.repositories import Repositories
from app.common.api.pagination import merge_sorted
from app.common.db.dynamo.comments import Comment
from app.common.db.dynamo.issues import PRIORITY_ORDER, Issue, as_issue
from app.common.db.dynamo.share_links import ShareLinkView
from app.common.db.dynamo.team_config import Label, Status
from app.common.db.dynamo.users import User
from app.common.db.dynamo.views import SavedView
from app.common.issue_filters import IssueFilter, UnknownStatusCategory, build_issue_filter
from app.common.issue_keys import current_all
from app.domains.views.schemas.share import (
    MAX_FILTER_VALUE_LENGTH,
    MAX_FILTER_VALUES,
    PriorityField,
    SharedComment,
    SharedIssue,
    SharedIssueSummary,
    SharedLabel,
    SharedStatus,
)
from app.domains.views.schemas.view import (
    FILTER_FIELDS,
    SortField,
    malformed_filter_keys,
    unknown_filter_keys,
)
from app.domains.views.service import invalid_filter, unprocessable

NOT_FOUND = {"error_code": "NOT_FOUND", "message": "Resource not found"}

MAX_SHARED_COMMENTS = 200

ANONYMOUS_NAME = "Unknown"
"""What stands in for a display name that is missing or blank.

A blank would render as an empty byline, and the user's id or email must never be
the fallback: substituting either would turn a share into a way to read the
membership of the workspace it came from.
"""


def share_not_found() -> HTTPException:
    """The 404 every failed share read answers, whatever actually went wrong.

    Absent, revoked, expired and pointing at a deleted row are one answer, because
    the caller is anonymous and telling them apart would say whether a guessed
    token ever existed.
    """
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)


def resolve_link(repositories: Repositories, token: str) -> ShareLinkView:
    """The usable link one token names, or the shared 404.

    The package answers `None` for every refusal alike, whether the token is
    malformed, unknown, revoked or expired, and that is deliberately preserved
    here: the reader is anonymous, and telling the four apart would say whether a
    guessed token ever existed.
    """
    record = verify_share_token(token, repositories.share_links)
    if record is None:
        raise share_not_found()
    return ShareLinkView(record)


def display_name(user: Optional[User]) -> str:
    """One person's display name for a public byline, never an id or an address."""
    if user is None:
        return ANONYMOUS_NAME
    name = (user.display_name or "").strip()
    return name or ANONYMOUS_NAME


def status_read(row: Optional[Status]) -> Optional[SharedStatus]:
    """A status as a public reader sees it, or `None` when it has been deleted."""
    if row is None:
        return None
    return SharedStatus(name=row.name, category=row.category, color=_status_color(row))


def label_reads(rows: Iterable[Label]) -> list[SharedLabel]:
    """Labels as a public reader sees them, names and colors only."""
    return [SharedLabel(name=row.name, color=row.color) for row in rows]


def comment_reads(comments: Iterable[Comment], authors: dict[str, User]) -> list[SharedComment]:
    """A shared issue's comments, oldest first, with display names for bylines.

    Replies are flattened into the same list rather than nested, because the public
    page renders a conversation and the parent id is an identifier the reader has
    no other use for.
    """
    ordered = sorted(comments, key=lambda row: row.created_at)
    return [
        SharedComment(
            author_name=display_name(authors.get(row.author_id)),
            body=row.body,
            created_at=row.created_at,
        )
        for row in ordered
    ]


def issue_read(
    issue: Issue,
    *,
    status_row: Optional[Status],
    labels: Iterable[Label],
    assignee: Optional[User],
    comments: list[SharedComment],
) -> SharedIssue:
    """One issue as a public reader sees it, with nothing that reaches a second row.

    `parent_id`, `cycle_id`, `project_id` and `progress` are all dropped: each
    names another row the token did not grant, and a reader who learned an id would
    have learned something the capability did not include.
    """
    return SharedIssue(
        issue_key=issue.key,
        title=issue.title,
        body=issue.body or "",
        status=status_read(status_row),
        priority=_priority(issue.priority),
        labels=label_reads(labels),
        estimate=_estimate(issue.estimate),
        start_date=_as_date(issue.start_date),
        due_date=_as_date(issue.due_date),
        assignee_name=display_name(assignee) if assignee is not None else None,
        created_at=issue.created_at,
        updated_at=issue.updated_at,
        comments=comments,
    )


def issue_summary(
    issue: Issue,
    *,
    status_row: Optional[Status],
    assignee: Optional[User],
) -> SharedIssueSummary:
    """One row of a shared view's listing, the summary fields only."""
    return SharedIssueSummary(
        issue_key=issue.key,
        title=issue.title,
        status=status_read(status_row),
        priority=_priority(issue.priority),
        assignee_name=display_name(assignee) if assignee is not None else None,
        updated_at=issue.updated_at,
    )


def shareable_view(view: SavedView) -> str:
    """The team a view may be shared under, or a 422 naming why it may not.

    A personal view whose filter spans every team the creator can see has no
    bound that survives their membership changing: the same link would widen when
    they joined a team and narrow when they left. A view scoped to one team
    is bounded by that team, which is a fact about the workspace rather than
    about the creator.
    """
    if not view.team_id:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "error_code": "VALIDATION_ERROR",
                "message": "Only a view scoped to one team can be shared",
            },
        )
    return view.team_id


SHARED_READ_WINDOW = 1000
"""The most issues one shared listing reads from its team before filtering.

The offset cursor is stamped rather than signed, so an anonymous caller can hand
back any offset they like. Capping the read keeps the work behind one request
bounded whatever cursor arrives, at the cost of a shared listing covering only a
team's newest thousand issues.
"""

SHARED_FAN_OUT_MULTIPLIER = 4
"""How much more than the requested page a shared listing reads before filtering."""


def snapshot_filter(team_id: str, value: Mapping[str, Any] | None) -> dict[str, Any]:
    """A filter a `filter` link may carry, validated and pinned to its team.

    Refused with `INVALID_FILTER` for the same unknown and malformed keys a saved
    view is, and with a 422 for a `team_id` naming another team, so the snapshot
    can never widen past the team the creator was checked against. Every value
    list and string is bounded, because the snapshot is stored on the token row
    and replayed on every anonymous read.
    """
    raw = dict(value or {})
    bad = unknown_filter_keys(raw) + malformed_filter_keys(raw)
    if bad:
        raise invalid_filter(sorted(set(bad)))
    if raw.get("team_id") not in (None, team_id):
        raise unprocessable("A shared filter must stay inside the team it is shared from")

    snapshot: dict[str, Any] = {}
    for key, entry in raw.items():
        if entry is None or key == "team_id":
            continue
        values = [entry] if isinstance(entry, str) else list(entry)
        if len(values) > MAX_FILTER_VALUES or any(len(item) > MAX_FILTER_VALUE_LENGTH for item in values):
            raise invalid_filter([key])
        snapshot[key] = entry
    snapshot["team_id"] = team_id
    try:
        shared_issue_filter(snapshot, created_by="")
    except UnknownStatusCategory as exc:
        raise invalid_filter(["status_category"]) from exc
    return snapshot


def shared_issue_filter(value: Mapping[str, Any], *, created_by: str) -> IssueFilter:
    """The issue filter one shared listing applies.

    `me` resolves to the person who published the link, because an anonymous
    reader has no identity of their own and the link shows what its creator
    published. `team_id` is dropped: the team comes off the link, never the filter.
    """
    keys = {key: entry for key, entry in value.items() if key in FILTER_FIELDS and key != "team_id"}
    return build_issue_filter(user_id=created_by, **keys)


def shared_issues(
    repositories: Repositories,
    *,
    workspace_id: str,
    team_id: str,
    wanted: IssueFilter,
    sort: str,
    offset: int,
    limit: int,
) -> tuple[list[Issue], bool]:
    """One page of a team's issues a shared filter selects, and whether more follow.

    Read the same way the member issue list reads one team, over-fetched and then
    filtered and sorted, but capped at `SHARED_READ_WINDOW` so a crafted offset
    cannot make an anonymous request read a whole team.
    """
    start = min(max(offset, 0), SHARED_READ_WINDOW)
    window = min((start + limit) * SHARED_FAN_OUT_MULTIPLIER, SHARED_READ_WINDOW)
    page = repositories.issues.list_for_team(workspace_id, team_id, limit=window)
    rows = current_all(repositories.teams, (as_issue(item) for item in page.items))

    categories: dict[str, str] = {}
    if wanted.needs_categories:
        categories = {
            row.status_id: row.category for row in repositories.team_config.list_statuses(workspace_id, team_id)
        }

    matched = [issue for issue in rows if wanted.matches(issue, categories)]
    ordered = merge_sorted(matched, shared_sort_key(sort), descending=shared_sort_descending(sort))
    chosen = ordered[start : start + limit]
    return chosen, start + len(chosen) < len(ordered)


def shared_sort_key(sort: str) -> Callable[[Issue], Any]:
    """The key one saved sort orders a shared listing by.

    The same meaning the member issue list gives each sort, spelled here because
    the issues domain is not importable from this one.
    """
    if sort == "created_desc":
        return lambda issue: (issue.created_at, issue.issue_id)
    if sort == "key_asc":
        return lambda issue: (issue.team_id, issue.number)
    if sort == "priority_desc":
        return lambda issue: (-PRIORITY_ORDER.get(issue.priority, 4), issue.updated_at)
    if sort == "due_asc":
        return lambda issue: (issue.due_date is None, issue.due_date or "", issue.issue_id)
    if sort == "manual":
        return lambda issue: (issue.sort_order is None, issue.sort_order or "", issue.issue_id)
    return lambda issue: (issue.updated_at, issue.issue_id)


def shared_sort_descending(sort: str) -> bool:
    """Whether one saved sort reads newest or highest first."""
    return sort not in ("key_asc", "due_asc", "manual")


DEFAULT_SORT: SortField = "updated_desc"
"""The sort a shared listing falls back to when its source carries none."""


def _status_color(row: Status) -> str:
    """A status color, falling back to a neutral when the row carries none.

    The stored status has a category but no color of its own, so the category is
    what the public page renders from; the fallback keeps the field present rather
    than optional on the wire.
    """
    return str(getattr(row, "color", "") or "").strip() or "gray"


_PRIORITIES: tuple[PriorityField, ...] = ("none", "urgent", "high", "medium", "low")
"""The five priorities a public response may carry, as the literal type itself.

Typed rather than left as strings so the membership test below narrows for the type
checker as well as at runtime, which is what lets `_priority` promise the literal
without a suppression.
"""


def _priority(value: str) -> PriorityField:
    """A stored priority narrowed to the five the public shape allows.

    Returns the literal type rather than `str`, so a sixth priority reaching the
    table fails here rather than serialising into a public response.
    """
    candidate = (value or "none").strip().lower()
    for allowed in _PRIORITIES:
        if candidate == allowed:
            return allowed
    return "none"


def _estimate(value: Optional[str]) -> Optional[float]:
    """A stored estimate as a number, or `None` when it is absent or not numeric.

    Stored as a string because the scale is per team and includes non-numeric
    scales; the public shape carries a number, so anything that will not parse is
    omitted rather than rendered as text a client would have to interpret.
    """
    if not value:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _as_date(value: Optional[str]) -> Optional[date]:
    """A stored ISO date as a date, or `None` when absent or unparseable."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(value).date()
    except ValueError:
        return None
