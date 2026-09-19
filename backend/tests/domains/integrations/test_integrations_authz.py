"""Authorization boundaries on every workspace scoped integrations route.

The rule these pin is the one from the M1 contract: a caller outside a workspace
sees 404 and never 403, because a 403 would confirm that the workspace exists. A
member who is inside the workspace but lacks the role sees 403, which tells them
nothing they did not already know.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from tests.domains.helpers import ADMIN, GUEST, MEMBER, OUTSIDER, OWNER, sign_in, sign_out
from tests.domains.integrations.conftest import OTHER_PROJECT, PROJECT, WORKSPACE

ADMIN_ROUTES: tuple[tuple[str, str], ...] = (
    ("GET", f"/api/workspaces/{WORKSPACE}/github/install-url"),
    ("GET", f"/api/workspaces/{WORKSPACE}/github/installation"),
    ("GET", f"/api/workspaces/{WORKSPACE}/github/repositories"),
    ("GET", f"/api/workspaces/{WORKSPACE}/webhooks"),
)


@pytest.mark.parametrize(("method", "path"), ADMIN_ROUTES)
def test_an_outsider_sees_404_on_every_admin_route(
    client: TestClient,
    workspace: str,
    method: str,
    path: str,
) -> None:
    """Someone with no membership must not learn the workspace exists."""
    sign_in(client, OUTSIDER)

    response = client.request(method, path)

    assert response.status_code == 404


@pytest.mark.parametrize(("method", "path"), ADMIN_ROUTES)
def test_a_member_is_refused_on_every_admin_route(
    client: TestClient,
    workspace: str,
    method: str,
    path: str,
) -> None:
    """A member is inside the workspace, so the refusal is a 403 rather than a 404."""
    sign_in(client, MEMBER)

    response = client.request(method, path)

    assert response.status_code == 403


@pytest.mark.parametrize(("method", "path"), ADMIN_ROUTES)
def test_an_unauthenticated_caller_is_refused(
    client: TestClient,
    workspace: str,
    method: str,
    path: str,
) -> None:
    """No claims at all is a 401, before any workspace is resolved."""
    sign_out(client)

    response = client.request(method, path)

    assert response.status_code == 401


def test_an_admin_reaches_the_install_url(client: TestClient, workspace: str) -> None:
    """The role that may install the App gets a url bound to a signed state."""
    sign_in(client, ADMIN)

    response = client.get(f"/api/workspaces/{WORKSPACE}/github/install-url")

    assert response.status_code == 200
    assert "state=" in response.json()["url"]


def test_the_install_state_is_bound_to_the_workspace_that_minted_it(
    client: TestClient,
    workspace: str,
) -> None:
    """The state names the workspace, which is what the callback trusts over the query.

    Without this the callback would have to believe a query parameter, and anyone
    who could install the App could attach it to a workspace they do not administer.
    """
    from urllib.parse import parse_qs, urlparse

    from app.domains.integrations.install_state import read_state

    sign_in(client, ADMIN)
    url = client.get(f"/api/workspaces/{WORKSPACE}/github/install-url").json()["url"]
    state = parse_qs(urlparse(url).query)["state"][0]

    claims = read_state(state)

    assert claims["workspace_id"] == WORKSPACE
    assert claims["user_id"] == ADMIN


def test_a_tampered_install_state_is_rejected(client: TestClient, workspace: str) -> None:
    """Editing the workspace inside the state breaks the signature, so it is refused."""
    from app.domains.integrations.install_state import StateError, read_state

    with pytest.raises(StateError):
        read_state("not-a-signed-state")


def test_a_guest_cannot_read_links_on_an_issue_outside_their_projects(
    client: TestClient,
    workspace: str,
    hidden_issue: Any,
) -> None:
    """An issue in a project the guest is outside of is a 404, not an empty list.

    An empty list would confirm the id exists, which is the leak the project check
    on this route is there to close.
    """
    sign_in(client, GUEST)

    response = client.get(f"/api/workspaces/{WORKSPACE}/issues/{hidden_issue.issue_id}/github-links")

    assert response.status_code == 404


def test_a_guest_can_read_links_on_an_issue_in_their_project(
    client: TestClient,
    workspace: str,
    issue: Any,
) -> None:
    """A project membership is enough to read that project's links."""
    sign_in(client, GUEST)

    response = client.get(f"/api/workspaces/{WORKSPACE}/issues/{issue.issue_id}/github-links")

    assert response.status_code == 200
    assert response.json()["items"] == []


def test_an_unknown_issue_is_404(client: TestClient, workspace: str) -> None:
    """A missing issue answers the same way a hidden one does."""
    sign_in(client, OWNER)

    response = client.get(f"/api/workspaces/{WORKSPACE}/issues/01JB000000000000000000NONE/github-links")

    assert response.status_code == 404


def test_a_guest_cannot_write_transition_rules(client: TestClient, workspace: str) -> None:
    """Configuring a project is a project admin action, not a member one."""
    sign_in(client, GUEST)

    response = client.post(
        f"/api/workspaces/{WORKSPACE}/projects/{PROJECT}/github-transitions",
        json={"trigger": "pr_opened", "status_id": "whatever"},
    )

    assert response.status_code == 403


def test_a_guest_cannot_read_transition_rules_of_a_project_they_are_outside(
    client: TestClient,
    workspace: str,
) -> None:
    """A project the guest holds no membership in is a 404 by its id."""
    sign_in(client, GUEST)

    response = client.get(f"/api/workspaces/{WORKSPACE}/projects/{OTHER_PROJECT}/github-transitions")

    assert response.status_code == 404


def test_an_admin_can_configure_transition_rules(client: TestClient, workspace: str, repositories: Any) -> None:
    """A workspace admin administers every project, so the rule is created."""
    statuses = repositories.project_config.list_statuses(WORKSPACE, PROJECT)
    sign_in(client, ADMIN)

    response = client.post(
        f"/api/workspaces/{WORKSPACE}/projects/{PROJECT}/github-transitions",
        json={"trigger": "pr_merged", "status_id": statuses[-1].status_id},
    )

    assert response.status_code == 201
    assert response.json()["trigger"] == "pr_merged"


def test_a_transition_rule_cannot_name_a_status_of_another_project(
    client: TestClient,
    workspace: str,
    repositories: Any,
) -> None:
    """A status id from a different project is refused rather than stored.

    Storing it would leave a rule that silently never fires, and would let one
    project's configuration reference another's rows.
    """
    other_statuses = repositories.project_config.list_statuses(WORKSPACE, OTHER_PROJECT)
    sign_in(client, ADMIN)

    response = client.post(
        f"/api/workspaces/{WORKSPACE}/projects/{PROJECT}/github-transitions",
        json={"trigger": "pr_merged", "status_id": other_statuses[0].status_id},
    )

    assert response.status_code == 422
