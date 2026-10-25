"""A team's cycles as an iCalendar feed, and the per-person token that opens it.

A calendar app subscribing to a URL sends no session, so the URL carries a feed
token. The token names the person it was minted for and a random secret; only a
SHA-256 hash of the whole token is stored, one row per person and team, so
minting again overwrites the hash and the old URL stops working at once. The
person's access is decided again on every fetch, so leaving the workspace or a
private team closes the feed without anyone revoking it.

The body is built by hand rather than through a library, because the output must
be deterministic for the same rows: events are ordered by start date and id, and
`DTSTAMP` is the cycle's own last update rather than the time of the request.
Text is escaped and lines folded at 75 octets per RFC 5545.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable, Iterable, Optional
from urllib.parse import quote

from app.common.api.dependencies.authz import AuthzContext
from app.common.change_source import SYSTEM
from app.common.db.dynamo.memberships import WORKSPACE_ROLES
from app.common.db.dynamo.planning import Cycle, CycleFeed
from app.common.db.dynamo.teams import Team

PAST_CYCLES = 3
"""How many completed cycles the feed keeps, most recent first."""

TOKEN_BYTES = 32
"""The random part of a feed token, in bytes before encoding."""

TOKEN_SEPARATOR = "."
"""What splits the person's id from the secret in a token, never produced by `token_urlsafe`."""

LINE_OCTETS = 75
"""The longest content line RFC 5545 allows before folding, in octets."""

PRODUCT_ID = "-//Standupless//Cycle calendar//EN"


def mint_token(user_id: str) -> str:
    """A fresh feed token for one person: their id, then a random secret."""
    return f"{user_id}{TOKEN_SEPARATOR}{secrets.token_urlsafe(TOKEN_BYTES)}"


def hash_token(token: str) -> str:
    """The stored form of a feed token."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def token_user(token: str) -> Optional[str]:
    """The person a token names, or `None` when it is not shaped like one."""
    user_id, separator, secret = token.partition(TOKEN_SEPARATOR)
    if not separator or not user_id or not secret:
        return None
    return user_id


def token_matches(feed: Optional[CycleFeed], token: str) -> bool:
    """Whether a presented token is the one a stored feed was minted with, in constant time."""
    if feed is None:
        return False
    return hmac.compare_digest(feed.token_hash, hash_token(token))


def reader_context(repositories: Any, workspace_id: str, user_id: str) -> Optional[AuthzContext]:
    """The context one person reads under outside a request, or `None` when they may not.

    `None` when the person is gone, disabled or no longer a workspace member, so a
    feed closes with their access.
    """
    user = repositories.users.get(user_id)
    if user is None or user.disabled or user.purging_at is not None:
        return None
    membership = repositories.memberships.get(workspace_id, user_id)
    if membership is None or membership.role not in WORKSPACE_ROLES:
        return None
    private = repositories.memberships.list_private_team_ids(workspace_id)
    team_ids: tuple[str, ...] = ()
    if membership.role == "guest" or private:
        team_ids = tuple(
            row.team_id
            for row in repositories.memberships.list_team_memberships_for_user(workspace_id, user_id)
            if row.team_id is not None
        )
    return AuthzContext(
        workspace_id=workspace_id,
        user_id=user_id,
        role=membership.role,
        team_ids=team_ids,
        private_team_ids=private,
        source=SYSTEM,
    )


def feed_context(repositories: Any, workspace_id: str, team_id: str, token: str) -> Optional[AuthzContext]:
    """The context a feed fetch reads under, or `None` for any refusal alike.

    Unknown, malformed and revoked tokens, a person who has left, and a team they
    can no longer see all answer `None`, so the anonymous caller cannot tell them
    apart.
    """
    user_id = token_user(token)
    if user_id is None:
        return None
    feed = repositories.planning.get_cycle_feed(workspace_id, team_id, user_id)
    if not token_matches(feed, token):
        return None
    context = reader_context(repositories, workspace_id, user_id)
    if context is None or not context.can_see_team(team_id):
        return None
    if repositories.teams.get(workspace_id, team_id) is None:
        return None
    return context


def feed_url(api_base_url: str, workspace_id: str, team_id: str, token: str) -> str:
    """The subscription URL for one token, the token riding in the query."""
    path = f"/api/workspaces/{quote(workspace_id, safe='')}/teams/{quote(team_id, safe='')}/cycles.ics"
    return f"{api_base_url}{path}?token={quote(token, safe='')}"


def feed_cycles(cycles: Iterable[Cycle], today: str) -> list[Cycle]:
    """The cycles a feed shows: the last few completed, the current and every upcoming one.

    Cancelled cycles are left out, and the result is ordered by start date then id.
    """
    live = [cycle for cycle in cycles if not cycle.cancelled]
    past = sorted(
        (cycle for cycle in live if cycle.end_date < today),
        key=lambda cycle: (cycle.end_date, cycle.start_date, cycle.cycle_id),
    )[-PAST_CYCLES:]
    rest = [cycle for cycle in live if cycle.end_date >= today]
    return sorted(past + rest, key=lambda cycle: (cycle.start_date, cycle.cycle_id))


def escape_text(value: str) -> str:
    """One TEXT value escaped per RFC 5545: backslash, semicolon, comma and newlines."""
    escaped = value.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,")
    return escaped.replace("\r\n", "\\n").replace("\r", "\\n").replace("\n", "\\n")


def fold_line(line: str) -> str:
    """One content line folded at 75 octets, never splitting a UTF-8 character.

    Continuation lines start with one space, which counts toward their own limit.
    """
    parts: list[str] = []
    current = ""
    size = 0
    limit = LINE_OCTETS
    for character in line:
        width = len(character.encode("utf-8"))
        if size + width > limit:
            parts.append(current)
            current = " "
            size = 1
        current += character
        size += width
    parts.append(current)
    return "\r\n".join(parts)


def cycle_summary(cycle: Cycle) -> str:
    """What an event is titled: the cycle's name, else its number."""
    name = (cycle.name or "").strip()
    if name:
        return name
    if cycle.number is not None:
        return f"Cycle {cycle.number}"
    return "Cycle"


def _stamp(value: datetime) -> str:
    """One instant in the UTC form `DTSTAMP` takes."""
    aware = value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
    return aware.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _day(value: str) -> str:
    """One ISO date in the basic form a `VALUE=DATE` property takes."""
    return date.fromisoformat(value).strftime("%Y%m%d")


def _exclusive_end(value: str) -> str:
    """The day after an inclusive end date, since an all-day `DTEND` is exclusive."""
    return (date.fromisoformat(value) + timedelta(days=1)).strftime("%Y%m%d")


def build_calendar(team: Team, cycles: Iterable[Cycle], link_for: Callable[[Cycle], str]) -> str:
    """The feed body: one all-day event per cycle, CRLF terminated throughout."""
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        f"PRODID:{PRODUCT_ID}",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        f"X-WR-CALNAME:{escape_text(f'{team.name} cycles')}",
    ]
    for cycle in cycles:
        link = link_for(cycle)
        goal = (cycle.goal or "").strip()
        description = f"{goal}\n\n{link}" if goal else link
        lines.extend(
            [
                "BEGIN:VEVENT",
                f"UID:cycle-{cycle.cycle_id}@standupless.dev",
                f"DTSTAMP:{_stamp(cycle.updated_at)}",
                f"DTSTART;VALUE=DATE:{_day(cycle.start_date)}",
                f"DTEND;VALUE=DATE:{_exclusive_end(cycle.end_date)}",
                f"SUMMARY:{escape_text(cycle_summary(cycle))}",
                f"DESCRIPTION:{escape_text(description)}",
                f"URL:{link}",
                "TRANSP:TRANSPARENT",
                "END:VEVENT",
            ]
        )
    lines.append("END:VCALENDAR")
    return "".join(f"{fold_line(line)}\r\n" for line in lines)
