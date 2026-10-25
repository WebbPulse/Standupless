"""The cycle calendar feed: minting, revoking and reading a team's cycles as iCalendar.

The feed route takes no session, so these tests sign out before reading it and
hold that the token alone opens it, that a rotated, revoked or malformed token is
the same 404 as an unknown one, and that the person's access is decided again on
every fetch. The body tests hold the RFC 5545 details a calendar app depends on:
CRLF endings, escaped text, folded lines and an exclusive all-day end.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

from fastapi.testclient import TestClient

from app.common.cycle_calendar import escape_text, feed_cycles, fold_line, hash_token
from app.common.db.dynamo.planning import Cycle
from tests.domains.helpers import GUEST, MEMBER, OWNER, sign_in, sign_out
from tests.domains.planning.conftest import OTHER_TEAM, TEAM, seed_cycle

FEED = "/api/workspaces/{workspace}/cycles/calendar-feed"


def mint(client: TestClient, workspace: str, team: str = TEAM) -> "dict[str, Any]":
    """Mint a feed for the signed in caller, failing loudly on a refusal."""
    response = client.post(FEED.format(workspace=workspace), json={"team_id": team})
    assert response.status_code == 200, response.text
    return response.json()


def feed_path(url: str) -> str:
    """The path and query of a feed URL, which is what the test client requests."""
    parts = urlsplit(url)
    return f"{parts.path}?{parts.query}"


def unfold(body: str) -> "list[str]":
    """The logical content lines of an iCalendar body, folds undone."""
    return body.replace("\r\n ", "").split("\r\n")


def test_minting_returns_a_url_once_and_stores_only_its_hash(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """The URL is on the mint answer alone; the row holds a hash, never the token."""
    sign_in(client, MEMBER)
    minted = mint(client, workspace)

    assert minted["active"] is True
    token = minted["url"].split("token=", 1)[1]
    assert f"/api/workspaces/{workspace}/teams/{TEAM}/cycles.ics?token=" in minted["url"]

    stored = repositories.planning.get_cycle_feed(workspace, TEAM, MEMBER)
    assert stored is not None
    assert stored.token_hash == hash_token(token)
    assert token not in stored.model_dump_json()

    read = client.get(FEED.format(workspace=workspace), params={"team_id": TEAM})
    assert read.status_code == 200
    assert read.json()["active"] is True
    assert read.json()["url"] is None


def test_a_caller_without_a_feed_reads_inactive(client: TestClient, workspace: str) -> None:
    """Reading before minting answers inactive rather than an error."""
    sign_in(client, MEMBER)
    read = client.get(FEED.format(workspace=workspace), params={"team_id": TEAM})
    assert read.status_code == 200
    assert read.json() == {"team_id": TEAM, "active": False, "created_at": None, "url": None}


def test_the_feed_lists_the_teams_cycles_as_all_day_events(client: TestClient, workspace: str) -> None:
    """A signed out fetch with the token answers an iCalendar body of the cycles."""
    sign_in(client, OWNER)
    cycle = seed_cycle(
        client,
        workspace,
        name="Ship, then; rest",
        start_date="2099-01-01",
        end_date="2099-01-14",
        goal="Launch the engine\nand the docs",
    )
    minted = mint(client, workspace)
    sign_out(client)

    response = client.get(feed_path(minted["url"]))

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/calendar")
    assert response.headers["cache-control"].startswith("private")
    body = response.text
    assert body.startswith("BEGIN:VCALENDAR\r\n")
    assert body.endswith("END:VCALENDAR\r\n")
    assert "\n" not in body.replace("\r\n", "")
    lines = unfold(body)
    assert f"UID:cycle-{cycle['cycle_id']}@standupless.dev" in lines
    assert "DTSTART;VALUE=DATE:20990101" in lines
    assert "DTEND;VALUE=DATE:20990115" in lines
    assert "SUMMARY:Ship\\, then\\; rest" in lines
    description = next(line for line in lines if line.startswith("DESCRIPTION:"))
    assert description.startswith("DESCRIPTION:Launch the engine\\nand the docs\\n\\n")
    assert f"/w/acme/team/ABC/cycles/{cycle['cycle_id']}" in description


def test_the_feed_is_deterministic(client: TestClient, workspace: str) -> None:
    """Two fetches of unchanged cycles answer the same bytes."""
    sign_in(client, OWNER)
    seed_cycle(client, workspace, start_date="2099-02-01", end_date="2099-02-14")
    seed_cycle(client, workspace, name="Sprint two", start_date="2099-02-15", end_date="2099-02-28")
    minted = mint(client, workspace)
    sign_out(client)

    first = client.get(feed_path(minted["url"]))
    second = client.get(feed_path(minted["url"]))

    assert first.text == second.text
    lines = unfold(first.text)
    starts = [line for line in lines if line.startswith("DTSTART")]
    assert starts == ["DTSTART;VALUE=DATE:20990201", "DTSTART;VALUE=DATE:20990215"]


def test_the_feed_leaves_out_cancelled_cycles_and_old_ones(client: TestClient, workspace: str) -> None:
    """Only the last three completed cycles are kept, and a cancelled one never appears."""
    sign_in(client, OWNER)
    old = [
        seed_cycle(client, workspace, name=f"Old {index}", start_date=f"2020-0{index}-01", end_date=f"2020-0{index}-14")
        for index in range(1, 5)
    ]
    cancelled = seed_cycle(client, workspace, name="Dropped", start_date="2099-03-01", end_date="2099-03-14")
    patched = client.patch(
        f"/api/workspaces/{workspace}/cycles/{cancelled['cycle_id']}",
        json={"team_id": TEAM, "cancelled": True},
    )
    assert patched.status_code == 200, patched.text
    minted = mint(client, workspace)
    sign_out(client)

    body = client.get(feed_path(minted["url"])).text

    assert f"cycle-{old[0]['cycle_id']}@" not in body
    for kept in old[1:]:
        assert f"cycle-{kept['cycle_id']}@" in body
    assert f"cycle-{cancelled['cycle_id']}@" not in body


def test_a_wrong_or_malformed_token_is_not_found(client: TestClient, workspace: str) -> None:
    """Unknown, malformed and cross-team tokens all answer the same 404."""
    sign_in(client, MEMBER)
    minted = mint(client, workspace)
    sign_out(client)
    token = minted["url"].split("token=", 1)[1]
    path = f"/api/workspaces/{workspace}/teams/{TEAM}/cycles.ics"

    assert client.get(path, params={"token": f"{MEMBER}.wrong"}).status_code == 404
    assert client.get(path, params={"token": "no-separator"}).status_code == 404
    assert client.get(path).status_code == 422
    other = f"/api/workspaces/{workspace}/teams/{OTHER_TEAM}/cycles.ics"
    assert client.get(other, params={"token": token}).status_code == 404


def test_minting_again_revokes_the_old_url(client: TestClient, workspace: str) -> None:
    """Regenerating hands out a new URL and the old one stops working at once."""
    sign_in(client, MEMBER)
    first = mint(client, workspace)
    second = mint(client, workspace)
    sign_out(client)

    assert first["url"] != second["url"]
    assert client.get(feed_path(first["url"])).status_code == 404
    assert client.get(feed_path(second["url"])).status_code == 200


def test_revoking_closes_the_feed(client: TestClient, workspace: str) -> None:
    """After a delete the URL is a 404 and the read answers inactive."""
    sign_in(client, MEMBER)
    minted = mint(client, workspace)

    revoked = client.delete(FEED.format(workspace=workspace), params={"team_id": TEAM})
    assert revoked.status_code == 204
    assert client.delete(FEED.format(workspace=workspace), params={"team_id": TEAM}).status_code == 204
    read = client.get(FEED.format(workspace=workspace), params={"team_id": TEAM})
    assert read.json()["active"] is False

    sign_out(client)
    assert client.get(feed_path(minted["url"])).status_code == 404


def test_a_guest_cannot_mint_outside_their_team(client: TestClient, workspace: str) -> None:
    """A team the caller cannot see is not found, for minting as for reading."""
    sign_in(client, GUEST)
    response = client.post(FEED.format(workspace=workspace), json={"team_id": OTHER_TEAM})
    assert response.status_code == 404
    assert client.get(FEED.format(workspace=workspace), params={"team_id": OTHER_TEAM}).status_code == 404


def test_making_the_team_private_closes_a_non_members_feed(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """Access is decided on every fetch, so a team turning private closes the feed."""
    sign_in(client, MEMBER)
    minted = mint(client, workspace)
    sign_out(client)
    assert client.get(feed_path(minted["url"])).status_code == 200

    repositories.memberships.set_team_private(workspace, TEAM, True)

    assert client.get(feed_path(minted["url"])).status_code == 404


def test_leaving_the_workspace_closes_the_feed(client: TestClient, repositories: Any, workspace: str) -> None:
    """A person removed from the workspace no longer opens their old URL."""
    sign_in(client, MEMBER)
    minted = mint(client, workspace)
    sign_out(client)

    repositories.memberships.delete(workspace, MEMBER)

    assert client.get(feed_path(minted["url"])).status_code == 404


def test_escape_text_escapes_the_rfc_5545_specials() -> None:
    """Backslash, semicolon, comma and newlines are escaped, in that order."""
    assert escape_text("a\\b;c,d\ne\r\nf") == "a\\\\b\\;c\\,d\\ne\\nf"


def test_fold_line_keeps_every_line_within_75_octets() -> None:
    """Long lines fold with a leading space and never split a multi-byte character."""
    line = "DESCRIPTION:" + "é" * 100
    folded = fold_line(line)
    parts = folded.split("\r\n")
    assert len(parts) > 1
    assert all(len(part.encode("utf-8")) <= 75 for part in parts)
    assert all(part.startswith(" ") for part in parts[1:])
    assert "".join(part[1:] if index else part for index, part in enumerate(parts)) == line
    assert fold_line("SHORT") == "SHORT"


def test_feed_cycles_orders_and_trims() -> None:
    """Completed cycles beyond the last three drop off and the rest sort by start."""

    def cycle(cycle_id: str, start: str, end: str, cancelled: bool = False) -> Cycle:
        """One cycle row with only what the selection reads."""
        return Cycle(
            workspace_id="ws",
            planning_key=f"cycle#{cycle_id}",
            team_id="team",
            cycle_id=cycle_id,
            name=cycle_id,
            start_date=start,
            end_date=end,
            cancelled=cancelled,
            created_by="user",
        )

    rows = [
        cycle("next", "2026-02-01", "2026-02-14"),
        cycle("now", "2026-01-20", "2026-01-31"),
        cycle("p1", "2025-09-01", "2025-09-14"),
        cycle("p2", "2025-10-01", "2025-10-14"),
        cycle("p3", "2025-11-01", "2025-11-14"),
        cycle("p4", "2025-12-01", "2025-12-14"),
        cycle("gone", "2026-03-01", "2026-03-14", cancelled=True),
    ]

    chosen = [row.cycle_id for row in feed_cycles(rows, "2026-01-25")]

    assert chosen == ["p2", "p3", "p4", "now", "next"]
