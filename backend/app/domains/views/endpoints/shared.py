"""The three anonymous routes a share token opens, and nothing else.

These carry no authorization dependency at all. The token in the path is the whole
credential, and every one of them is in `PUBLIC_ROUTES` in the route contract
fixture, so a fourth appearing there is a diff a reviewer has to accept.

The bound is structural rather than checked. None of these routes takes an issue
id, a view id, a team id or a workspace id, so a reader holding a token for one
issue has no way to name another: the only identifier they can supply is the token
itself, and it resolves to exactly one row.

The answer never depends on who is asking. A signed-in reader following a share
link gets the same body an anonymous one does, because a share that rendered
differently for a member would become a way to probe membership.
"""

from __future__ import annotations

from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, Path, Query

from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.pagination import decode_cursor, encode_cursor
from app.common.db.dynamo.issues import Issue
from app.common.db.dynamo.share_links import ShareLinkView
from app.common.issue_keys import current
from app.domains.views.schemas.share import (
    SharedIssue,
    SharedTarget,
    SharedViewPage,
)
from app.domains.views.share_service import (
    MAX_SHARED_COMMENTS,
    comment_reads,
    issue_read,
    issue_summary,
    resolve_link,
    share_not_found,
)

router = APIRouter(prefix="/api/shared", tags=["shared"])

DEFAULT_LIMIT = 50

MAX_LIMIT = 100


@router.get("/{token}", response_model=SharedTarget)
def read_shared_target(
    repositories: Annotated[Repositories, Depends(get_repositories)],
    token: str = Path(..., min_length=1),
) -> SharedTarget:
    """What one token resolves to, and the minimum needed to render a heading.

    Loaded first by the public page so the client knows which of the two follow-up
    reads to make. It answers names rather than ids, so learning that a token is
    valid teaches nothing that can be spent on another route.
    """
    link = resolve_link(repositories, token)
    workspace = repositories.workspaces.get(link.workspace_id)
    team = repositories.teams.get(link.workspace_id, link.team_id)

    return SharedTarget(
        target_type="view" if link.target_type == "view" else "issue",
        title=link.title,
        workspace_name=workspace.name if workspace is not None else "",
        team_name=team.name if team is not None else "",
        shared_at=link.created_at,
    )


@router.get("/{token}/issue", response_model=SharedIssue)
def read_shared_issue(
    repositories: Annotated[Repositories, Depends(get_repositories)],
    token: str = Path(..., min_length=1),
) -> SharedIssue:
    """The one issue a token names, with its comments.

    A token for a view answers the shared 404 rather than a 400, so the two kinds of
    token are indistinguishable to someone probing with a guessed value.
    """
    link = resolve_link(repositories, token)
    if link.target_type != "issue":
        raise share_not_found()

    issue = repositories.issues.get(link.workspace_id, link.target_id)
    if issue is None or issue.team_id != link.team_id:
        raise share_not_found()

    comments = repositories.comments.iter_for_issue(link.workspace_id, issue.issue_id, max_items=MAX_SHARED_COMMENTS)
    authors = repositories.users.get_many([comment.author_id for comment in comments])
    assignee = repositories.users.get(issue.assignee_id) if issue.assignee_id else None

    return issue_read(
        current(repositories.teams, issue),
        status_row=repositories.team_config.get_status(link.workspace_id, issue.team_id, issue.status_id),
        labels=_labels_for(repositories, link, issue),
        assignee=assignee,
        comments=comment_reads(comments, authors),
    )


@router.get("/{token}/view", response_model=SharedViewPage)
def read_shared_view(
    repositories: Annotated[Repositories, Depends(get_repositories)],
    token: str = Path(..., min_length=1),
    cursor: Optional[str] = Query(default=None),
    limit: int = Query(default=DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
) -> SharedViewPage:
    """One page of the issues a shared view selects, inside its one team.

    The team comes off the link rather than off the view, so a view edited to
    point somewhere else after the link was minted still reads the team the
    share was published against. That is what keeps a share's blast radius fixed at
    the moment a person decided to publish it.
    """
    link = resolve_link(repositories, token)
    if link.target_type != "view":
        raise share_not_found()

    view = repositories.views.get(link.workspace_id, _view_key_of(link))
    if view is None or view.team_id != link.team_id:
        raise share_not_found()

    scope = _cursor_scope(link)
    page = repositories.issues.list_for_team(
        link.workspace_id,
        link.team_id,
        limit=limit,
        start_key=decode_cursor(cursor, scope),
    )
    issues = [Issue.model_validate(dict(item)) for item in page.items]

    assignees = repositories.users.get_many([issue.assignee_id for issue in issues if issue.assignee_id])
    statuses = {
        status_row.status_id: status_row
        for status_row in repositories.team_config.list_statuses(link.workspace_id, link.team_id)
    }

    return SharedViewPage(
        issues=[
            issue_summary(
                current(repositories.teams, issue),
                status_row=statuses.get(issue.status_id),
                assignee=assignees.get(issue.assignee_id) if issue.assignee_id else None,
            )
            for issue in issues
        ],
        next_cursor=encode_cursor(page.last_evaluated_key, scope),
    )


def _cursor_scope(link: ShareLinkView) -> str:
    """The scope a shared view's cursors are stamped with.

    Keyed on the link itself, so a cursor minted under one share cannot be handed
    back on another. Without that a reader holding two tokens could page one
    share's listing using the other's boundary, which is the one way these routes
    could otherwise be made to cross between targets.
    """
    return f"shared:{link.token_hash}"


def _view_key_of(link: ShareLinkView) -> str:
    """The sort key the shared view is filed under.

    Only the team spelling is tried, because `shareable_view` refuses a personal
    view at create time: a view with no team has no bound that survives its
    creator's membership changing, so no link can name one.
    """
    from app.common.db.dynamo.views import team_view_key

    return team_view_key(link.team_id, link.target_id)


def _labels_for(repositories: Repositories, link: ShareLinkView, issue: Issue) -> list[Any]:
    """The label rows one shared issue carries, in the team's own order.

    Read from the team's label set and filtered to the issue's ids rather than
    fetched one by one, so the read is one query whatever the issue carries.
    """
    if not issue.label_ids:
        return []
    wanted = set(issue.label_ids)
    return [
        label
        for label in repositories.team_config.list_labels(link.workspace_id, link.team_id)
        if label.label_id in wanted
    ]
