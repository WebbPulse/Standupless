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
from typing import Iterable, Optional

from fastapi import HTTPException, status

from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.comments import Comment
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.project_config import Label, Status
from app.common.db.dynamo.share_links import ShareLink
from app.common.db.dynamo.users import User
from app.common.db.dynamo.views import SavedView
from app.domains.views.schemas.share import (
    PriorityField,
    SharedComment,
    SharedIssue,
    SharedIssueSummary,
    SharedLabel,
    SharedStatus,
)

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


def resolve_link(repositories: Repositories, token: str) -> ShareLink:
    """The usable link one token names, or the shared 404."""
    link = repositories.share_links.resolve(token)
    if link is None:
        raise share_not_found()
    return link


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

    `parent_id`, `cycle_id`, `milestone_id` and `progress` are all dropped: each
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
    """The project a view may be shared under, or a 422 naming why it may not.

    A personal view whose filter spans every project the creator can see has no
    bound that survives their membership changing: the same link would widen when
    they joined a project and narrow when they left. A view scoped to one project
    is bounded by that project, which is a fact about the workspace rather than
    about the creator.
    """
    if not view.project_id:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "error_code": "VALIDATION_ERROR",
                "message": "Only a view scoped to one project can be shared",
            },
        )
    return view.project_id


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

    Stored as a string because the scale is per project and includes non-numeric
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
