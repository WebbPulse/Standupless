"""The My issues filters: created by, subscribed by and assigned to the caller.

Each reads a keyed index rather than fanning out across teams, so the properties
worth holding are the ones an index read could lose: a row from a team the caller
cannot see stays hidden, a row from another workspace never appears, and nobody can
ask for someone else's subscriptions.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.helpers import GUEST, MEMBER, OWNER, make_team, make_workspace, sign_in
from tests.domains.issues.conftest import OTHER_TEAM, create_issue

SECOND_WORKSPACE = "01JB0000000000000000000WS2"

SECOND_TEAM = "01JB000000000000000000PRJ9"


def _ids(body: Any) -> "set[str]":
    """The ids of a list response as a set, since these assert membership."""
    return {row["id"] for row in body["issues"]}


def _list(client: TestClient, workspace: str, **params: Any) -> Any:
    """One list call, failing loudly on anything but a 200."""
    response = client.get(f"/api/workspaces/{workspace}/issues", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def test_creator_me_lists_only_what_the_caller_created(client: TestClient, workspace: str, statuses: Any) -> None:
    """Created by me spans every team and leaves out anyone else's issues."""
    sign_in(client, OWNER)
    mine = create_issue(client, workspace, title="Mine")
    mine_there = create_issue(client, workspace, team_id=OTHER_TEAM, title="Mine elsewhere")
    sign_in(client, MEMBER)
    create_issue(client, workspace, title="Theirs")

    sign_in(client, OWNER)
    listed = _list(client, workspace, creator_id="me")

    assert _ids(listed) == {mine["id"], mine_there["id"]}


def test_creator_not_excludes_the_caller(client: TestClient, workspace: str, statuses: Any) -> None:
    """The negated form runs on the fan-out path and keeps everyone else's rows."""
    sign_in(client, OWNER)
    create_issue(client, workspace, title="Mine")
    sign_in(client, MEMBER)
    theirs = create_issue(client, workspace, title="Theirs")

    sign_in(client, OWNER)
    listed = _list(client, workspace, creator_id_not="me")

    assert _ids(listed) == {theirs["id"]}


def test_subscriber_me_lists_what_the_caller_follows(client: TestClient, workspace: str, statuses: Any) -> None:
    """Creating subscribes the creator, and following by hand adds to the list."""
    sign_in(client, OWNER)
    followed = create_issue(client, workspace, title="Followed")
    create_issue(client, workspace, title="Not followed")
    sign_in(client, MEMBER)
    own = create_issue(client, workspace, title="Own")
    assert client.put(f"/api/workspaces/{workspace}/issues/{followed['id']}/subscribers/me").status_code == 200

    listed = _list(client, workspace, subscriber_id="me")

    assert _ids(listed) == {followed["id"], own["id"]}


def test_subscriber_filter_combines_with_other_filters(client: TestClient, workspace: str, statuses: Any) -> None:
    """The keyed read narrows the rows, and the other filters still apply on top."""
    sign_in(client, OWNER)
    create_issue(client, workspace, title="Low", priority="low")
    urgent = create_issue(client, workspace, title="Urgent", priority="urgent")

    listed = _list(client, workspace, subscriber_id="me", priority="urgent")

    assert _ids(listed) == {urgent["id"]}


def test_subscriber_id_only_accepts_the_caller(client: TestClient, workspace: str, statuses: Any) -> None:
    """Whom someone else follows is theirs, so naming another user is refused."""
    sign_in(client, OWNER)

    response = client.get(f"/api/workspaces/{workspace}/issues", params={"subscriber_id": MEMBER})

    assert response.status_code == 422
    assert _list(client, workspace, subscriber_id=OWNER)["issues"] == []


def test_a_guest_sees_no_keyed_row_from_a_team_they_are_outside(
    client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """A subscription, authorship or assignment in a hidden team does not leak the issue.

    The hidden row is rewritten as the guest's own straight in the table, the shape
    left behind when a guest loses a team after working in it.
    """
    sign_in(client, GUEST)
    visible = create_issue(client, workspace, title="Visible", assignee_id=GUEST)
    sign_in(client, OWNER)
    hidden = create_issue(client, workspace, team_id=OTHER_TEAM, title="Hidden")
    row = repositories.issues.get(workspace, hidden["id"])
    repositories.issues.replace(row.model_copy(update={"created_by": GUEST, "assignee_id": GUEST}))
    repositories.subscriptions.subscribe(workspace, hidden["id"], OTHER_TEAM, GUEST, "manual")

    sign_in(client, GUEST)

    assert _ids(_list(client, workspace, subscriber_id="me")) == {visible["id"]}
    assert _ids(_list(client, workspace, creator_id="me")) == {visible["id"]}
    assert _ids(_list(client, workspace, assignee_id="me")) == {visible["id"]}


def test_keyed_reads_never_cross_a_workspace(
    client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """The index range key is the workspace, so another tenant's rows stay out."""
    make_workspace(repositories, SECOND_WORKSPACE, "other", OWNER)
    make_team(repositories, SECOND_WORKSPACE, SECOND_TEAM, "OTH")
    sign_in(client, OWNER)
    here = create_issue(client, workspace, title="Here", assignee_id=OWNER)
    elsewhere = create_issue(client, SECOND_WORKSPACE, team_id=SECOND_TEAM, title="Elsewhere", assignee_id=OWNER)

    for params in ({"creator_id": "me"}, {"subscriber_id": "me"}, {"assignee_id": "me"}):
        assert _ids(_list(client, workspace, **params)) == {here["id"]}
        assert _ids(_list(client, SECOND_WORKSPACE, **params)) == {elsewhere["id"]}


def test_keyed_lists_page_with_a_cursor(client: TestClient, workspace: str, statuses: Any) -> None:
    """A keyed read pages like the fan-out, without repeating or dropping a row."""
    sign_in(client, OWNER)
    created = {create_issue(client, workspace, title=f"Issue {index}")["id"] for index in range(5)}

    first = _list(client, workspace, creator_id="me", limit=2)
    seen = _ids(first)
    cursor = first["next_cursor"]
    while cursor:
        page = _list(client, workspace, creator_id="me", limit=2, cursor=cursor)
        assert not seen & _ids(page)
        seen |= _ids(page)
        cursor = page["next_cursor"]

    assert seen == created


def test_a_cursor_from_one_mode_does_not_serve_another(client: TestClient, workspace: str, statuses: Any) -> None:
    """The subscribed list and the full list are different sets, so a carried cursor restarts."""
    sign_in(client, OWNER)
    for index in range(3):
        create_issue(client, workspace, title=f"Issue {index}")
    cursor = _list(client, workspace, subscriber_id="me", limit=1)["next_cursor"]

    carried = _list(client, workspace, limit=1, cursor=cursor)

    assert carried["issues"] == _list(client, workspace, limit=1)["issues"]
