"""The list fold routes: each person's folded groups and hidden columns on a list that is not a saved view.

Nothing is folded until a person folds something, a write replaces the whole
set, an empty set keeps no row, the folds are the caller's alone, and the
account purge takes them.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.helpers import GUEST, MEMBER, OWNER, sign_in

LIST_KEY = "team:01M3KD7Y2K4GA0P5ZQ82SYR39A:active"


def path(workspace: str) -> str:
    """The list fold route of one workspace."""
    return f"/api/workspaces/{workspace}/views/folds"


def test_nothing_is_folded_at_first(client: TestClient, workspace: str) -> None:
    """A person who never folded anything on a list reads an empty set."""
    sign_in(client, MEMBER)
    response = client.get(path(workspace), params={"list_key": LIST_KEY})
    assert response.status_code == 200, response.text
    assert response.json() == {"list_key": LIST_KEY, "collapsed_groups": []}


def test_a_write_replaces_the_set_and_is_the_callers_alone(client: TestClient, workspace: str) -> None:
    """Folds follow the person, drop repeats, and another member reads none of them."""
    sign_in(client, MEMBER)
    first = client.put(path(workspace), json={"list_key": LIST_KEY, "collapsed_groups": ["a", "lane/b", "a"]})
    assert first.status_code == 200, first.text
    assert first.json()["collapsed_groups"] == ["a", "lane/b"]
    client.put(path(workspace), json={"list_key": LIST_KEY, "collapsed_groups": ["hidden:c"]})

    assert client.get(path(workspace), params={"list_key": LIST_KEY}).json()["collapsed_groups"] == ["hidden:c"]
    assert client.get(path(workspace), params={"list_key": "cycle:other"}).json()["collapsed_groups"] == []
    sign_in(client, OWNER)
    assert client.get(path(workspace), params={"list_key": LIST_KEY}).json()["collapsed_groups"] == []


def test_an_empty_set_keeps_no_row(client: TestClient, workspace: str, repositories: Any) -> None:
    """Unfolding everything removes the stored row."""
    sign_in(client, MEMBER)
    client.put(path(workspace), json={"list_key": LIST_KEY, "collapsed_groups": ["a"]})
    assert repositories.views.get_list_folds(workspace, MEMBER, LIST_KEY) is not None

    cleared = client.put(path(workspace), json={"list_key": LIST_KEY, "collapsed_groups": []})

    assert cleared.json()["collapsed_groups"] == []
    assert repositories.views.get_list_folds(workspace, MEMBER, LIST_KEY) is None


def test_a_guest_keeps_folds_too(client: TestClient, workspace: str) -> None:
    """Folding is reading, so a guest's lists remember their folds as a member's do."""
    sign_in(client, GUEST)
    response = client.put(path(workspace), json={"list_key": "mine-assigned", "collapsed_groups": ["done"]})
    assert response.status_code == 200, response.text


def test_malformed_keys_and_oversized_sets_are_refused(client: TestClient, workspace: str) -> None:
    """The list key has a fixed shape, and the set has a cap on its size and on each key."""
    sign_in(client, MEMBER)
    assert client.get(path(workspace), params={"list_key": "bad#key"}).status_code == 422
    assert client.put(path(workspace), json={"list_key": "", "collapsed_groups": []}).status_code == 422
    assert client.put(path(workspace), json={"list_key": LIST_KEY, "collapsed_groups": ["k" * 301]}).status_code == 422
    too_many = [f"g{n}" for n in range(501)]
    assert client.put(path(workspace), json={"list_key": LIST_KEY, "collapsed_groups": too_many}).status_code == 422


def test_the_account_purge_takes_a_members_folds(workspace: str, repositories: Any) -> None:
    """Deleting one member's folds leaves everyone else's."""
    repositories.views.set_list_folds(workspace, MEMBER, LIST_KEY, ["a"])
    repositories.views.set_list_folds(workspace, MEMBER, "cycle:one", ["b"])
    repositories.views.set_list_folds(workspace, OWNER, LIST_KEY, ["c"])

    assert repositories.views.delete_list_folds_for_user(workspace, MEMBER) == 2
    assert repositories.views.get_list_folds(workspace, MEMBER, LIST_KEY) is None
    owner = repositories.views.get_list_folds(workspace, OWNER, LIST_KEY)
    assert owner is not None and owner.collapsed == ["c"]
