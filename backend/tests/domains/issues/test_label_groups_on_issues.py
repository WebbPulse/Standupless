"""The one label per group rule on the issue write path.

A group itself never sits on an issue, a full label set naming two labels of
one group is refused, and a bulk add of a grouped label swaps out its sibling
rather than failing, as picking a second label of a group does in Linear. A
group that allows multiple labels takes several of them on one issue.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.common.db.dynamo.team_config import Label, label_key, new_config_id
from tests.domains.helpers import OWNER, sign_in
from tests.domains.issues.conftest import TEAM, create_issue


def _label(
    repositories: Any,
    workspace: str,
    name: str,
    *,
    is_group: bool = False,
    parent_id: str | None = None,
    allow_multiple: bool = False,
) -> str:
    """Seed one label or group on `TEAM` and answer its id."""
    label_id = new_config_id()
    repositories.team_config.create_label(
        Label(
            workspace_id=workspace,
            config_key=label_key(TEAM, label_id),
            team_id=TEAM,
            label_id=label_id,
            name=name,
            color="#00ff00",
            is_group=is_group,
            allow_multiple=allow_multiple,
            parent_id=parent_id,
        )
    )
    return label_id


def _create(client: TestClient, workspace: str, label_ids: list[str]) -> Any:
    """Post one issue with `label_ids` and answer the raw response."""
    return client.post(
        f"/api/workspaces/{workspace}/issues", json={"team_id": TEAM, "title": "An issue", "label_ids": label_ids}
    )


def test_a_group_cannot_sit_on_an_issue(client: TestClient, workspace: str, statuses: Any, repositories: Any) -> None:
    """Naming the group itself is a 422 that says to pick one of its labels."""
    sign_in(client, OWNER)
    group = _label(repositories, workspace, "Area", is_group=True)
    response = _create(client, workspace, [group])
    assert response.status_code == 422
    assert "Area is a label group" in response.json()["message"]


def test_two_labels_of_one_group_are_refused(
    client: TestClient, workspace: str, statuses: Any, repositories: Any
) -> None:
    """A create or patch naming two children of a group is a 422, and one child of each group is fine."""
    sign_in(client, OWNER)
    area = _label(repositories, workspace, "Area", is_group=True)
    frontend = _label(repositories, workspace, "Frontend", parent_id=area)
    backend = _label(repositories, workspace, "Backend", parent_id=area)
    plain = _label(repositories, workspace, "Bug")

    refused = _create(client, workspace, [frontend, backend])
    assert refused.status_code == 422
    assert "one label from the Area group" in refused.json()["message"]

    created = create_issue(client, workspace, label_ids=[frontend, plain])
    patched = client.patch(
        f"/api/workspaces/{workspace}/issues/{created['id']}", json={"label_ids": [frontend, backend]}
    )
    assert patched.status_code == 422


def test_a_bulk_add_swaps_the_sibling(client: TestClient, workspace: str, statuses: Any, repositories: Any) -> None:
    """Adding a grouped label to issues that carry its sibling replaces the sibling and keeps the rest."""
    sign_in(client, OWNER)
    area = _label(repositories, workspace, "Area", is_group=True)
    frontend = _label(repositories, workspace, "Frontend", parent_id=area)
    backend = _label(repositories, workspace, "Backend", parent_id=area)
    plain = _label(repositories, workspace, "Bug")
    first = create_issue(client, workspace, label_ids=[frontend, plain])
    second = create_issue(client, workspace, label_ids=[])

    response = client.patch(
        f"/api/workspaces/{workspace}/issues",
        json={"issue_ids": [first["id"], second["id"]], "patch": {"add_label_ids": [backend]}},
    )
    assert response.status_code == 200, response.text
    labels = {row["id"]: row["label_ids"] for row in response.json()["issues"]}
    assert labels[first["id"]] == [plain, backend]
    assert labels[second["id"]] == [backend]


def test_a_multi_select_group_takes_several_labels(
    client: TestClient, workspace: str, statuses: Any, repositories: Any
) -> None:
    """A create, patch and bulk add naming two labels of a multi-select group keep both."""
    sign_in(client, OWNER)
    area = _label(repositories, workspace, "Area", is_group=True, allow_multiple=True)
    frontend = _label(repositories, workspace, "Frontend", parent_id=area)
    backend = _label(repositories, workspace, "Backend", parent_id=area)
    infra = _label(repositories, workspace, "Infra", parent_id=area)

    created = _create(client, workspace, [frontend, backend])
    assert created.status_code == 201, created.text
    assert created.json()["label_ids"] == [frontend, backend]

    response = client.patch(
        f"/api/workspaces/{workspace}/issues",
        json={"issue_ids": [created.json()["id"]], "patch": {"add_label_ids": [infra]}},
    )
    assert response.status_code == 200, response.text
    assert response.json()["issues"][0]["label_ids"] == [frontend, backend, infra]


def test_turning_multi_select_off_keeps_labels_until_the_next_edit(
    client: TestClient, workspace: str, statuses: Any, repositories: Any
) -> None:
    """Switching a group back to exclusive leaves issues as they are and holds their next label edit to one."""
    sign_in(client, OWNER)
    area = _label(repositories, workspace, "Area", is_group=True, allow_multiple=True)
    frontend = _label(repositories, workspace, "Frontend", parent_id=area)
    backend = _label(repositories, workspace, "Backend", parent_id=area)
    plain = _label(repositories, workspace, "Bug")
    issue = create_issue(client, workspace, label_ids=[frontend, backend])

    switched = client.patch(f"/api/workspaces/{workspace}/teams/{TEAM}/labels/{area}", json={"allow_multiple": False})
    assert switched.status_code == 200, switched.text
    assert switched.json()["allow_multiple"] is False

    read = client.get(f"/api/workspaces/{workspace}/issues/{issue['id']}")
    assert read.json()["label_ids"] == [frontend, backend]

    refused = client.patch(
        f"/api/workspaces/{workspace}/issues/{issue['id']}", json={"label_ids": [frontend, backend, plain]}
    )
    assert refused.status_code == 422
    assert "one label from the Area group" in refused.json()["message"]


def test_allow_multiple_is_only_for_groups(
    client: TestClient, workspace: str, statuses: Any, repositories: Any
) -> None:
    """A create or patch setting allow_multiple on a plain label is a 422, and a group stores it."""
    sign_in(client, OWNER)
    url = f"/api/workspaces/{workspace}/teams/{TEAM}/labels"
    refused = client.post(url, json={"name": "Bug", "color": "#ff0000", "allow_multiple": True})
    assert refused.status_code == 422
    group = client.post(url, json={"name": "Area", "color": "#ff0000", "is_group": True, "allow_multiple": True})
    assert group.status_code == 201, group.text
    assert group.json()["allow_multiple"] is True
    plain = _label(repositories, workspace, "Docs")
    patched = client.patch(f"{url}/{plain}", json={"allow_multiple": True})
    assert patched.status_code == 422
