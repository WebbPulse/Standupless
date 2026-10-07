"""Triage routes: a team's waiting issues, the per-team counts, and accept, decline, duplicate and snooze.

Registered ahead of the issue routes so `/issues/triage` is not read as an issue
id. Every action holds the caller to write access on the issue's own team and
answers the issue as it now stands.
"""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Path, Query
from webbpulse.http import CursorPage

from app.common import issue_triage
from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.issues import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    IssueListRead,
    IssueRead,
    TriageAccept,
    TriageDecline,
    TriageDuplicate,
    TriageSnooze,
    TriageSummaryRead,
)
from app.common.issue_keys import current

router = APIRouter()


@router.get("/{workspace_id}/issues/triage", response_model=IssueListRead)
def list_triage(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    team_id: Annotated[str, Query(min_length=1)],
    snoozed: Annotated[bool, Query()] = False,
    cursor: Annotated[Optional[str], Query()] = None,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
) -> CursorPage[IssueRead]:
    """One page of a team's triage inbox, newest filed first.

    Snoozed issues stay out until their time passes; `snoozed=true` lists only them.
    """
    rows, next_cursor = issue_triage.list_triage(
        repositories, context, team_id, snoozed=snoozed, cursor=cursor, limit=limit
    )
    return IssueListRead(items=[IssueRead.from_row(issue) for issue in rows], next_cursor=next_cursor)


@router.get("/{workspace_id}/issues/triage/summary", response_model=TriageSummaryRead)
def triage_summary(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> TriageSummaryRead:
    """Each visible team with triage on and how many issues wait in it, for the sidebar badges."""
    return TriageSummaryRead(teams=issue_triage.triage_summary(repositories, context))


@router.post("/{workspace_id}/issues/{issue_id}/triage/accept", response_model=IssueRead)
def accept_issue(
    issue_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    payload: Optional[TriageAccept] = None,
) -> IssueRead:
    """Accept a waiting issue into the team, in the named status or the team's first unstarted one."""
    accepted = issue_triage.accept(repositories, context, issue_id, payload or TriageAccept())
    return IssueRead.from_row(current(repositories.teams, accepted))


@router.post("/{workspace_id}/issues/{issue_id}/triage/decline", response_model=IssueRead)
def decline_issue(
    issue_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    payload: Optional[TriageDecline] = None,
) -> IssueRead:
    """Decline a waiting issue to the team's cancelled status, with an optional reason kept in history."""
    declined = issue_triage.decline(repositories, context, issue_id, payload or TriageDecline())
    return IssueRead.from_row(current(repositories.teams, declined))


@router.post("/{workspace_id}/issues/{issue_id}/triage/duplicate", response_model=IssueRead)
def duplicate_issue(
    payload: TriageDuplicate,
    issue_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> IssueRead:
    """Close a waiting issue as a duplicate of another, linking the two."""
    closed = issue_triage.mark_duplicate(repositories, context, issue_id, payload)
    return IssueRead.from_row(current(repositories.teams, closed))


@router.post("/{workspace_id}/issues/{issue_id}/triage/snooze", response_model=IssueRead)
def snooze_issue(
    payload: TriageSnooze,
    issue_id: Annotated[str, Path(min_length=1)],
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> IssueRead:
    """Hide a waiting issue from the inbox until a moment, or bring it back with `until: null`."""
    snoozed = issue_triage.snooze(repositories, context, issue_id, payload)
    return IssueRead.from_row(current(repositories.teams, snoozed))
