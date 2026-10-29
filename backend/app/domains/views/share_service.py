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
from app.common.core.config import settings
from app.common.db.dynamo.comments import Comment
from app.common.db.dynamo.issues import PRIORITY_ORDER, Issue, as_issue
from app.common.db.dynamo.memberships import WORKSPACE_ROLES
from app.common.db.dynamo.share_links import ShareLinkView
from app.common.db.dynamo.team_config import STATUS_CATEGORIES, Label, Status
from app.common.db.dynamo.users import User
from app.common.db.dynamo.views import SavedView
from app.common.estimates import estimate_points, is_unestimated
from app.common.filter_resolution import resolve_issue_filter
from app.common.issue_filters import IssueFilter, UnknownStatusCategory, build_issue_filter
from app.common.issue_keys import current_all
from app.common.issue_rules import unprocessable
from app.common.media_tokens import mint_media_token, referenced_attachments
from app.common.plan_features import Feature, has_feature
from app.common.saved_views import invalid_filter
from app.common.sla import sla_breach_key
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
    normalize_filter,
    unknown_filter_keys,
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


def resolve_link(repositories: Repositories, token: str) -> ShareLinkView:
    """The usable link one token names, or the shared 404.

    The package answers `None` for every refusal alike, whether the token is
    malformed, unknown, revoked or expired, and that is deliberately preserved
    here: the reader is anonymous, and telling the four apart would say whether a
    guessed token ever existed.

    A link opens only while the person who minted it can still see its team: they
    must still be a workspace member, and a guest creator or a link into a private
    team also needs their membership in that team. A link made by someone since
    removed, or made while the team was open, stops working without anyone having
    to revoke it.

    A view or filter link also opens only while the workspace's plan includes the
    public roadmap, so a downgrade closes it as a revoke would and an upgrade
    opens it again. Issue links open on every plan.
    """
    record = verify_share_token(token, repositories.share_links)
    if record is None:
        raise share_not_found()
    link = ShareLinkView(record)
    if not _creator_can_see_team(repositories, link):
        raise share_not_found()
    if not _plan_serves(repositories, link):
        raise share_not_found()
    return link


def _plan_serves(repositories: Repositories, link: ShareLinkView) -> bool:
    """Whether the workspace's plan lets this link open: always for an issue, with the public roadmap otherwise."""
    if link.target_type == "issue":
        return True
    return has_feature(repositories.workspaces.get(link.workspace_id), Feature.PUBLIC_ROADMAP)


def _creator_can_see_team(repositories: Repositories, link: ShareLinkView) -> bool:
    """Whether the link's creator still holds the access the link was minted under."""
    membership = repositories.memberships.get(link.workspace_id, link.created_by)
    if membership is None or membership.role not in WORKSPACE_ROLES:
        return False
    needs_team = membership.role == "guest" or repositories.memberships.is_private_team(link.workspace_id, link.team_id)
    if needs_team:
        team_membership = repositories.memberships.get_team_membership(link.workspace_id, link.team_id, link.created_by)
        return team_membership is not None
    return True


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
    return SharedStatus(name=row.name, category=row.category, color=row.color, icon=row.icon)


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


def shared_media(workspace_id: str, issue_id: str, bodies: Iterable[str]) -> dict[str, str]:
    """Media tokens for the attachments a shared issue's bodies embed.

    Every token is bound to the issue the link names, never to an issue a body
    mentions, so an embed copied from another issue resolves to nothing: the content
    route looks the attachment up under the token's issue. An environment with no
    signing key answers no tokens, and the page shows the embeds as unavailable
    rather than failing the whole read.
    """
    if not settings.SECRET_KEY:
        return {}
    return {
        attachment_id: mint_media_token(workspace_id, issue_id, attachment_id)
        for attachment_id in referenced_attachments(workspace_id, bodies)
    }


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
    about the creator. A project view lists no issues, so it has nothing to share.
    """
    if view.lists_projects:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "error_code": "VALIDATION_ERROR",
                "message": "Only a view of issues can be shared",
            },
        )
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

PERSONAL_FILTER_FIELDS: tuple[str, ...] = ("subscriber_id", "subscriber_id_not")
"""Filter keys a shared link refuses, because they need the viewer's own index.

What a person follows is read from their subscriptions, which an anonymous reader
has none of and which the link's creator did not choose to publish.
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
    raw = normalize_filter(dict(value or {})) or {}
    bad = unknown_filter_keys(raw) + malformed_filter_keys(raw)
    bad += [key for key in PERSONAL_FILTER_FIELDS if raw.get(key) is not None]
    if _groups_personal(raw.get("groups")):
        bad.append("groups")
    if bad:
        raise invalid_filter(sorted(set(bad)))
    if raw.get("team_id") not in (None, team_id):
        raise unprocessable("A shared filter must stay inside the team it is shared from")

    snapshot: dict[str, Any] = {}
    for key, entry in raw.items():
        if entry is None or key == "team_id":
            continue
        if key == "groups":
            if not _groups_bounded(entry):
                raise invalid_filter([key])
        elif not _values_bounded(entry):
            raise invalid_filter([key])
        snapshot[key] = entry
    snapshot["team_id"] = team_id
    try:
        shared_issue_filter(snapshot, created_by="")
    except UnknownStatusCategory as exc:
        raise invalid_filter(["status_category"]) from exc
    return snapshot


def _values_bounded(entry: Any) -> bool:
    """Whether one stored filter value stays within the snapshot's count and length bounds."""
    values = [entry] if isinstance(entry, str) else list(entry)
    return len(values) <= MAX_FILTER_VALUES and all(len(item) <= MAX_FILTER_VALUE_LENGTH for item in values)


def _groups_personal(groups: Any) -> bool:
    """Whether any condition group, at any depth, names a personal key a shared link refuses."""
    if not isinstance(groups, list):
        return False
    return any(
        isinstance(group, dict)
        and (any(group.get(key) is not None for key in PERSONAL_FILTER_FIELDS) or _groups_personal(group.get("groups")))
        for group in groups
    )


def _groups_bounded(entry: Any) -> bool:
    """Whether every value in every condition group, nested ones included, stays within the snapshot's bounds."""
    return all(
        _groups_bounded(item) if key == "groups" else _values_bounded(item)
        for group in entry
        for key, item in group.items()
        if item is not None
    )


def shared_issue_filter(value: Mapping[str, Any], *, created_by: str) -> IssueFilter:
    """The issue filter one shared listing applies.

    `me` resolves to the person who published the link, because an anonymous
    reader has no identity of their own and the link shows what its creator
    published. `team_id` is dropped: the team comes off the link, never the filter.
    """
    keys = {
        key: entry
        for key, entry in value.items()
        if key in FILTER_FIELDS and key != "team_id" and key not in PERSONAL_FILTER_FIELDS
    }
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

    wanted = resolve_issue_filter(repositories, workspace_id, [team_id], wanted)
    categories: dict[str, str] = {}
    ranks: dict[str, tuple[int, int]] = {}
    if wanted.needs_categories or sort == "status_asc":
        statuses = repositories.team_config.list_statuses(workspace_id, team_id)
        categories = {row.status_id: row.category for row in statuses}
        ranks = {row.status_id: (_category_rank(row.category), row.position) for row in statuses}

    matched = [issue for issue in rows if not issue.private and wanted.matches(issue, categories)]
    ordered = merge_sorted(matched, shared_sort_key(sort, ranks), descending=shared_sort_descending(sort))
    chosen = ordered[start : start + limit]
    return chosen, start + len(chosen) < len(ordered)


def _category_rank(category: str) -> int:
    """Where one status category sits on a board, an unknown one after every known one."""
    return STATUS_CATEGORIES.index(category) if category in STATUS_CATEGORIES else len(STATUS_CATEGORIES)


def _status_rank(issue: Issue, ranks: Mapping[str, tuple[int, int]]) -> tuple[int, int]:
    """Where one issue's status sits on its team's board, triage first and a vanished status last."""
    if issue.in_triage:
        return (-1, 0)
    return ranks.get(issue.status_id, (len(STATUS_CATEGORIES), 0))


def shared_sort_key(sort: str, ranks: Optional[Mapping[str, tuple[int, int]]] = None) -> Callable[[Issue], Any]:
    """The key one saved sort orders a shared listing by.

    The same meaning the member issue list gives each sort, spelled here because
    the issues domain is not importable from this one. `ranks` maps the team's
    status ids to their board place for the status sort.
    """
    if sort == "created_desc":
        return lambda issue: (issue.created_at, issue.issue_id)
    if sort == "key_asc":
        return lambda issue: (issue.team_id, issue.number)
    if sort == "priority_desc":
        return lambda issue: (-PRIORITY_ORDER.get(issue.priority, 4), issue.created_at, issue.issue_id)
    if sort == "due_asc":
        return lambda issue: (issue.due_date is None, issue.due_date or "", issue.issue_id)
    if sort == "sla_asc":
        return sla_breach_key
    if sort == "manual":
        return lambda issue: (issue.sort_order is None, issue.sort_order or "", issue.issue_id)
    if sort == "status_asc":
        held = ranks or {}
        return lambda issue: (_status_rank(issue, held), PRIORITY_ORDER.get(issue.priority, 4), issue.issue_id)
    if sort == "start_asc":
        return lambda issue: (issue.start_date is None, issue.start_date or "", issue.issue_id)
    if sort == "estimate_desc":
        return lambda issue: (not is_unestimated(issue.estimate), estimate_points(issue.estimate), issue.issue_id)
    if sort == "links_desc":
        return lambda issue: (issue.relation_count, issue.updated_at, issue.team_id, -issue.number)
    return lambda issue: (issue.updated_at, issue.issue_id)


def shared_sort_descending(sort: str) -> bool:
    """Whether one saved sort reads newest or highest first."""
    return sort not in ("key_asc", "due_asc", "sla_asc", "manual", "status_asc", "start_asc")


DEFAULT_SORT: SortField = "updated_desc"
"""The sort a shared listing falls back to when its source carries none."""


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
