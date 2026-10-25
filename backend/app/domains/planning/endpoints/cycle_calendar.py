"""Cycle calendar routes: mint, read and revoke a feed, and the feed itself.

The three management routes are ordinary signed in routes on the cycles prefix,
registered ahead of the cycle id routes so `calendar-feed` is never read as an
id. The feed route carries no authorization dependency, because a calendar app
sends no session: the token in its query is the credential, it is in
`PUBLIC_ROUTES` in the route contract test, and every refusal is the same 404.
The token rides in the query rather than the path because only paths are logged.
"""

from __future__ import annotations

from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, Depends, Path, Query, Response, status

from app.common.api.dependencies.authz import AuthzContext, Capability, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.planning import CycleCalendarFeedCreate, CycleCalendarFeedRead
from app.common.core.config import settings
from app.common.cycle_calendar import build_calendar, feed_context, feed_cycles, feed_url, hash_token, mint_token
from app.common.db.dynamo.planning import Cycle, CycleFeed
from app.common.planning_rules import not_found, require_team_reader
from app.common.team_time import local_date, timezone_of

router = APIRouter()

CALENDAR_MEDIA_TYPE = "text/calendar; charset=utf-8"

FEED_MAX_AGE = 300
"""How long a calendar app may reuse a fetched feed, in seconds."""


@router.get("/{workspace_id}/cycles/calendar-feed", response_model=CycleCalendarFeedRead)
def read_cycle_calendar_feed(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    team_id: Annotated[str, Query()],
) -> CycleCalendarFeedRead:
    """Whether the caller holds a cycle calendar feed for one team, never its URL."""
    require_team_reader(repositories, context, team_id)
    feed = repositories.planning.get_cycle_feed(context.workspace_id, team_id, context.user_id)
    return CycleCalendarFeedRead(
        team_id=team_id,
        active=feed is not None,
        created_at=feed.created_at if feed is not None else None,
    )


@router.post("/{workspace_id}/cycles/calendar-feed", response_model=CycleCalendarFeedRead)
def mint_cycle_calendar_feed(
    payload: CycleCalendarFeedCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
) -> CycleCalendarFeedRead:
    """Mint the caller's feed URL for one team, revoking any URL minted before.

    The answer is the only place the token ever appears; the row keeps its hash.
    """
    require_team_reader(repositories, context, payload.team_id)
    token = mint_token(context.user_id)
    feed = repositories.planning.put_cycle_feed(
        CycleFeed(
            workspace_id=context.workspace_id,
            team_id=payload.team_id,
            user_id=context.user_id,
            token_hash=hash_token(token),
        )
    )
    return CycleCalendarFeedRead(
        team_id=payload.team_id,
        active=True,
        created_at=feed.created_at,
        url=feed_url(settings.api_base_url, context.workspace_id, payload.team_id, token),
    )


@router.delete("/{workspace_id}/cycles/calendar-feed", status_code=status.HTTP_204_NO_CONTENT)
def revoke_cycle_calendar_feed(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path()],
    team_id: Annotated[str, Query()],
) -> Response:
    """Revoke the caller's feed for one team; revoking none is not an error."""
    require_team_reader(repositories, context, team_id)
    repositories.planning.delete_cycle_feed(context.workspace_id, team_id, context.user_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get(
    "/{workspace_id}/teams/{team_id}/cycles.ics",
    response_class=Response,
    responses={200: {"content": {"text/calendar": {}}, "description": "The team's cycles as iCalendar."}},
)
def read_cycle_calendar(
    repositories: Annotated[Repositories, Depends(get_repositories)],
    workspace_id: Annotated[str, Path(min_length=1)],
    team_id: Annotated[str, Path(min_length=1)],
    token: Annotated[str, Query(min_length=1, max_length=256)],
) -> Response:
    """A team's cycles as an iCalendar feed, on a feed token.

    The last three completed cycles, the current one and every upcoming one, each
    an all-day event. The token's owner must still be able to read the team.
    """
    context = feed_context(repositories, workspace_id, team_id, token)
    if context is None:
        raise not_found()
    team = repositories.teams.get(workspace_id, team_id)
    workspace = repositories.workspaces.get(workspace_id)
    if team is None or workspace is None:
        raise not_found()

    base = f"{settings.frontend_base_url}/w/{quote(workspace.slug, safe='')}/team/{quote(team.key_prefix, safe='')}"

    def link_for(cycle: Cycle) -> str:
        """The cycle's page in the app."""
        return f"{base}/cycles/{quote(cycle.cycle_id, safe='')}"

    cycles = feed_cycles(
        repositories.planning.list_for_roadmap(workspace_id, team_id), local_date(timezone_of(team)).isoformat()
    )
    return Response(
        content=build_calendar(team, cycles, link_for),
        media_type=CALENDAR_MEDIA_TYPE,
        headers={
            "Cache-Control": f"private, max-age={FEED_MAX_AGE}",
            "Content-Disposition": 'inline; filename="cycles.ics"',
        },
    )
