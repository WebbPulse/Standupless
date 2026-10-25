"""Customers and the requests they make for issues and projects.

The properties worth holding are that guests reach no customer data, that any
other member creates, edits and merges customers while only the creator or an
admin deletes one, that domains are normalised and claimed by one customer at a
time, that a request is filed through an issue or project the caller may write
on and listed on both the target and the customer, that request counts follow
what the caller can see, that a merge moves requests and domains without
overwriting the survivor, that deleting a customer takes its requests, that a
customer carries a status from a fixed set, and that a request is edited,
marked important and moved only by a writer on both the old and new target.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.helpers import ADMIN, GUEST, MEMBER, OWNER, sign_in
from tests.domains.planning.conftest import OTHER_TEAM, TEAM, seed_issue, seed_project


def _base(workspace: str) -> str:
    """The workspace's API root."""
    return f"/api/workspaces/{workspace}"


def _customer(client: TestClient, workspace: str, **payload: Any) -> "dict[str, Any]":
    """Create one customer through the route, failing loudly on a refusal."""
    body: "dict[str, Any]" = {"name": "Acme"}
    body.update(payload)
    response = client.post(f"{_base(workspace)}/customers", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def _request(
    client: TestClient, workspace: str, kind: str, target_id: str, customer_id: str, body: str = ""
) -> "dict[str, Any]":
    """File one request through the target's route, failing loudly on a refusal."""
    response = client.post(
        f"{_base(workspace)}/{kind}s/{target_id}/customer-requests",
        json={"customer_id": customer_id, "body": body},
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_a_customer_round_trips(client: TestClient, workspace: str) -> None:
    """Create, read, list and edit, with domains normalised and the caller's rights."""
    sign_in(client, MEMBER)

    created = _customer(
        client,
        workspace,
        name="  Acme  ",
        domains=["https://www.Acme.com/pricing", "acme.io", "acme.com"],
        tier="Enterprise",
        owner_id=OWNER,
        revenue=1200000,
        size=250,
    )

    assert created["name"] == "Acme"
    assert created["domains"] == ["acme.com", "acme.io"]
    assert (created["tier"], created["owner_id"], created["revenue"], created["size"]) == (
        "Enterprise",
        OWNER,
        1200000,
        250,
    )
    assert created["request_count"] == 0
    assert (created["can_edit"], created["can_delete"]) == (True, True)
    customer_id = created["customer_id"]

    read = client.get(f"{_base(workspace)}/customers/{customer_id}")
    assert read.status_code == 200, read.text
    assert read.json()["name"] == "Acme"

    edited = client.patch(f"{_base(workspace)}/customers/{customer_id}", json={"tier": None, "size": 300})
    assert edited.status_code == 200, edited.text
    assert (edited.json()["tier"], edited.json()["size"], edited.json()["revenue"]) == (None, 300, 1200000)

    _customer(client, workspace, name="beta corp")
    listed = client.get(f"{_base(workspace)}/customers")
    assert listed.status_code == 200, listed.text
    assert [row["name"] for row in listed.json()["customers"]] == ["Acme", "beta corp"]


def test_customer_input_is_checked(client: TestClient, workspace: str) -> None:
    """Blank names, bad domains, negative amounts and unknown owners are refused."""
    sign_in(client, MEMBER)
    base = f"{_base(workspace)}/customers"

    assert client.post(base, json={"name": "   "}).status_code == 422
    assert client.post(base, json={"name": "Acme", "domains": ["not a domain"]}).status_code == 422
    assert client.post(base, json={"name": "Acme", "revenue": -1}).status_code == 422
    assert client.post(base, json={"name": "Acme", "owner_id": "01JB0000000000000000NOBODY"}).status_code == 422
    customer_id = _customer(client, workspace)["customer_id"]
    assert client.patch(f"{base}/{customer_id}", json={"name": None}).status_code == 422


def test_a_domain_belongs_to_one_customer(client: TestClient, workspace: str) -> None:
    """A second customer cannot claim a domain another already holds."""
    sign_in(client, MEMBER)
    _customer(client, workspace, domains=["acme.com"])
    other = _customer(client, workspace, name="Other")

    taken = client.post(f"{_base(workspace)}/customers", json={"name": "Copy", "domains": ["ACME.com"]})
    claimed = client.patch(f"{_base(workspace)}/customers/{other['customer_id']}", json={"domains": ["acme.com"]})

    assert taken.status_code == 409, taken.text
    assert claimed.status_code == 409, claimed.text


def test_guests_reach_no_customer_data(client: TestClient, issues_client: TestClient, workspace: str) -> None:
    """A guest is refused every customer route, even on an issue in their own team."""
    sign_in(client, MEMBER)
    customer_id = _customer(client, workspace)["customer_id"]
    sign_in(issues_client, MEMBER)
    issue = seed_issue(issues_client, workspace)
    sign_in(client, GUEST)

    assert client.get(f"{_base(workspace)}/customers").status_code == 403
    assert client.post(f"{_base(workspace)}/customers", json={"name": "Nope"}).status_code == 403
    assert client.get(f"{_base(workspace)}/customers/{customer_id}").status_code == 403
    assert client.get(f"{_base(workspace)}/issues/{issue['id']}/customer-requests").status_code == 403
    filed = client.post(f"{_base(workspace)}/issues/{issue['id']}/customer-requests", json={"customer_id": customer_id})
    assert filed.status_code == 403


def test_requests_list_on_the_target_and_the_customer(
    client: TestClient, issues_client: TestClient, workspace: str
) -> None:
    """A request filed on an issue and one on a project show on both sides, newest first."""
    sign_in(client, MEMBER)
    sign_in(issues_client, MEMBER)
    customer_id = _customer(client, workspace)["customer_id"]
    issue = seed_issue(issues_client, workspace, title="Export to CSV")
    project_id = seed_project(client, workspace)["project_id"]

    on_issue = _request(client, workspace, "issue", issue["id"], customer_id, "We need CSV by Q4")
    on_project = _request(client, workspace, "project", project_id, customer_id)

    assert on_issue["customer_name"] == "Acme"
    assert (on_issue["target_kind"], on_issue["target_key"], on_issue["target_title"]) == (
        "issue",
        issue["key"],
        "Export to CSV",
    )
    assert on_issue["body"] == "We need CSV by Q4"
    assert on_issue["author_id"] == MEMBER
    assert on_issue["can_delete"] is True
    assert (on_project["target_kind"], on_project["target_title"]) == ("project", "Launch")

    issue_rows = client.get(f"{_base(workspace)}/issues/{issue['id']}/customer-requests").json()["requests"]
    project_rows = client.get(f"{_base(workspace)}/projects/{project_id}/customer-requests").json()["requests"]
    customer_rows = client.get(f"{_base(workspace)}/customers/{customer_id}/requests").json()["requests"]

    assert [row["request_id"] for row in issue_rows] == [on_issue["request_id"]]
    assert [row["request_id"] for row in project_rows] == [on_project["request_id"]]
    assert [row["request_id"] for row in customer_rows] == [on_project["request_id"], on_issue["request_id"]]
    assert client.get(f"{_base(workspace)}/customers/{customer_id}").json()["request_count"] == 2


def test_a_request_names_a_real_customer(client: TestClient, issues_client: TestClient, workspace: str) -> None:
    """An unknown customer is a 422 and an unknown issue a 404."""
    sign_in(client, MEMBER)
    sign_in(issues_client, MEMBER)
    issue = seed_issue(issues_client, workspace)
    customer_id = _customer(client, workspace)["customer_id"]

    unknown_customer = client.post(
        f"{_base(workspace)}/issues/{issue['id']}/customer-requests",
        json={"customer_id": "01JB00000000000000000NOCUST"},
    )
    unknown_issue = client.post(
        f"{_base(workspace)}/issues/01JB0000000000000000NOISSUE/customer-requests",
        json={"customer_id": customer_id},
    )

    assert unknown_customer.status_code == 422, unknown_customer.text
    assert unknown_issue.status_code == 404, unknown_issue.text


def test_only_the_author_or_an_admin_removes_a_request(
    client: TestClient, issues_client: TestClient, workspace: str
) -> None:
    """Another member is refused, the author and an admin are not."""
    sign_in(client, MEMBER)
    sign_in(issues_client, MEMBER)
    customer_id = _customer(client, workspace)["customer_id"]
    issue = seed_issue(issues_client, workspace)
    first = _request(client, workspace, "issue", issue["id"], customer_id)
    second = _request(client, workspace, "issue", issue["id"], customer_id)
    base = f"{_base(workspace)}/customers/{customer_id}/requests"

    sign_in(client, OWNER)
    assert client.delete(f"{base}/{first['request_id']}").status_code == 204
    sign_in(client, MEMBER)
    assert client.delete(f"{base}/{second['request_id']}").status_code == 204
    assert client.delete(f"{base}/{second['request_id']}").status_code == 404
    assert client.get(f"{_base(workspace)}/issues/{issue['id']}/customer-requests").json()["requests"] == []


def test_another_member_cannot_remove_a_request(client: TestClient, issues_client: TestClient, workspace: str) -> None:
    """A plain member who did not file a request may not remove it."""
    sign_in(client, ADMIN)
    sign_in(issues_client, ADMIN)
    customer_id = _customer(client, workspace)["customer_id"]
    issue = seed_issue(issues_client, workspace)
    filed = _request(client, workspace, "issue", issue["id"], customer_id)

    sign_in(client, MEMBER)
    refused = client.delete(f"{_base(workspace)}/customers/{customer_id}/requests/{filed['request_id']}")

    assert refused.status_code == 403, refused.text


def test_only_the_creator_or_an_admin_deletes_a_customer(
    client: TestClient, issues_client: TestClient, workspace: str
) -> None:
    """Deleting a customer takes its requests with it."""
    sign_in(client, ADMIN)
    sign_in(issues_client, ADMIN)
    customer = _customer(client, workspace)
    issue = seed_issue(issues_client, workspace)
    _request(client, workspace, "issue", issue["id"], customer["customer_id"])
    url = f"{_base(workspace)}/customers/{customer['customer_id']}"

    sign_in(client, MEMBER)
    listed = client.get(f"{_base(workspace)}/customers").json()["customers"]
    assert listed[0]["can_delete"] is False
    assert client.delete(url).status_code == 403
    sign_in(client, ADMIN)
    assert client.delete(url).status_code == 204

    assert client.get(url).status_code == 404
    assert client.get(f"{_base(workspace)}/issues/{issue['id']}/customer-requests").json()["requests"] == []


def test_a_merge_moves_requests_and_keeps_the_survivor(
    client: TestClient, issues_client: TestClient, workspace: str
) -> None:
    """The survivor gains requests and domains and fills only its empty fields."""
    sign_in(client, MEMBER)
    sign_in(issues_client, MEMBER)
    source = _customer(client, workspace, name="Acme Inc", domains=["acme.io"], tier="Startup", size=40)
    target = _customer(client, workspace, name="Acme", domains=["acme.com"], tier="Enterprise")
    issue = seed_issue(issues_client, workspace)
    filed = _request(client, workspace, "issue", issue["id"], source["customer_id"], "Please")

    merged = client.post(
        f"{_base(workspace)}/customers/{source['customer_id']}/merge",
        json={"into_customer_id": target["customer_id"]},
    )

    assert merged.status_code == 200, merged.text
    body = merged.json()
    assert body["customer_id"] == target["customer_id"]
    assert body["domains"] == ["acme.com", "acme.io"]
    assert (body["tier"], body["size"]) == ("Enterprise", 40)
    assert body["request_count"] == 1
    assert client.get(f"{_base(workspace)}/customers/{source['customer_id']}").status_code == 404
    rows = client.get(f"{_base(workspace)}/issues/{issue['id']}/customer-requests").json()["requests"]
    assert [(row["request_id"], row["customer_id"]) for row in rows] == [(filed["request_id"], target["customer_id"])]


def test_a_customer_cannot_merge_into_itself(client: TestClient, workspace: str) -> None:
    """Merging a customer into itself is refused rather than deleting it."""
    sign_in(client, MEMBER)
    customer_id = _customer(client, workspace)["customer_id"]

    refused = client.post(f"{_base(workspace)}/customers/{customer_id}/merge", json={"into_customer_id": customer_id})

    assert refused.status_code == 422, refused.text
    assert client.get(f"{_base(workspace)}/customers/{customer_id}").status_code == 200


def test_counts_follow_what_the_caller_can_see(
    client: TestClient, issues_client: TestClient, repositories: Any, workspace: str
) -> None:
    """A request on an issue that is gone stops counting and stops listing."""
    sign_in(client, MEMBER)
    sign_in(issues_client, MEMBER)
    customer_id = _customer(client, workspace)["customer_id"]
    kept = seed_issue(issues_client, workspace, team_id=OTHER_TEAM)
    gone = seed_issue(issues_client, workspace)
    _request(client, workspace, "issue", kept["id"], customer_id)
    _request(client, workspace, "issue", gone["id"], customer_id)

    repositories.issues.delete(workspace, gone["id"])

    assert client.get(f"{_base(workspace)}/customers/{customer_id}").json()["request_count"] == 1
    rows = client.get(f"{_base(workspace)}/customers/{customer_id}/requests").json()["requests"]
    assert [row["target_id"] for row in rows] == [kept["id"]]


def _edit(client: TestClient, workspace: str, request: "dict[str, Any]", **payload: Any) -> Any:
    """Patch one request through the customer's route."""
    return client.patch(
        f"{_base(workspace)}/customers/{request['customer_id']}/requests/{request['request_id']}", json=payload
    )


def test_a_customer_carries_a_status(client: TestClient, workspace: str) -> None:
    """Status is set on create, edited and cleared, and refused outside the fixed set."""
    sign_in(client, MEMBER)
    created = _customer(client, workspace, status="trial")
    url = f"{_base(workspace)}/customers/{created['customer_id']}"

    assert created["status"] == "trial"
    assert client.patch(url, json={"status": "active"}).json()["status"] == "active"
    assert client.patch(url, json={"status": None}).json()["status"] is None
    assert client.patch(url, json={"status": "dormant"}).status_code == 422
    assert client.post(f"{_base(workspace)}/customers", json={"name": "B", "status": "dormant"}).status_code == 422


def test_a_request_is_edited_and_marked_important(
    client: TestClient, issues_client: TestClient, workspace: str
) -> None:
    """Another member edits the quote, flags it important and the customer counts it."""
    sign_in(client, ADMIN)
    sign_in(issues_client, ADMIN)
    customer_id = _customer(client, workspace)["customer_id"]
    issue = seed_issue(issues_client, workspace)
    filed = _request(client, workspace, "issue", issue["id"], customer_id, "Soon please")
    assert (filed["important"], filed["can_edit"]) == (False, True)

    sign_in(client, MEMBER)
    edited = _edit(client, workspace, filed, body="By Q4", important=True)

    assert edited.status_code == 200, edited.text
    body = edited.json()
    assert (body["body"], body["important"], body["can_edit"]) == ("By Q4", True, True)
    assert body["updated_at"] is not None
    rows = client.get(f"{_base(workspace)}/issues/{issue['id']}/customer-requests").json()["requests"]
    assert [(row["body"], row["important"]) for row in rows] == [("By Q4", True)]
    read = client.get(f"{_base(workspace)}/customers/{customer_id}").json()
    assert (read["request_count"], read["important_count"]) == (1, 1)
    listed = client.get(f"{_base(workspace)}/customers").json()["customers"]
    assert listed[0]["important_count"] == 1


def test_a_request_moves_to_another_target_and_customer(
    client: TestClient, issues_client: TestClient, workspace: str
) -> None:
    """A move lists the request on the new target and customer and nowhere else."""
    sign_in(client, MEMBER)
    sign_in(issues_client, MEMBER)
    acme = _customer(client, workspace)["customer_id"]
    beta = _customer(client, workspace, name="Beta")["customer_id"]
    issue = seed_issue(issues_client, workspace)
    project_id = seed_project(client, workspace)["project_id"]
    filed = _request(client, workspace, "issue", issue["id"], acme, "Keep me")

    moved = _edit(client, workspace, filed, target_kind="project", target_id=project_id, customer_id=beta)

    assert moved.status_code == 200, moved.text
    body = moved.json()
    assert (body["request_id"], body["target_kind"], body["target_id"]) == (filed["request_id"], "project", project_id)
    assert (body["customer_id"], body["customer_name"], body["body"]) == (beta, "Beta", "Keep me")
    assert client.get(f"{_base(workspace)}/issues/{issue['id']}/customer-requests").json()["requests"] == []
    project_rows = client.get(f"{_base(workspace)}/projects/{project_id}/customer-requests").json()["requests"]
    assert [row["request_id"] for row in project_rows] == [filed["request_id"]]
    assert client.get(f"{_base(workspace)}/customers/{acme}/requests").json()["requests"] == []
    beta_rows = client.get(f"{_base(workspace)}/customers/{beta}/requests").json()["requests"]
    assert [row["request_id"] for row in beta_rows] == [filed["request_id"]]
    assert _edit(client, workspace, filed, important=True).status_code == 404


def test_a_request_edit_is_checked(client: TestClient, issues_client: TestClient, workspace: str) -> None:
    """A half move, an unknown customer, an unknown target and an unknown request are refused."""
    sign_in(client, MEMBER)
    sign_in(issues_client, MEMBER)
    customer_id = _customer(client, workspace)["customer_id"]
    issue = seed_issue(issues_client, workspace)
    filed = _request(client, workspace, "issue", issue["id"], customer_id)

    assert _edit(client, workspace, filed, target_kind="project").status_code == 422
    assert _edit(client, workspace, filed, target_id=issue["id"]).status_code == 422
    assert _edit(client, workspace, filed, customer_id="01JB00000000000000000NOCUST").status_code == 422
    missing = _edit(client, workspace, filed, target_kind="issue", target_id="01JB0000000000000000NOISSUE")
    assert missing.status_code == 404
    gone = {"customer_id": customer_id, "request_id": "01JB0000000000000000NOREQS"}
    assert _edit(client, workspace, gone, important=True).status_code == 404


def test_a_request_moves_only_between_targets_the_caller_writes(
    client: TestClient, issues_client: TestClient, repositories: Any, workspace: str
) -> None:
    """A guest is refused, and a private team outside the caller hides the old or new target."""
    sign_in(client, OWNER)
    sign_in(issues_client, OWNER)
    customer_id = _customer(client, workspace)["customer_id"]
    open_issue = seed_issue(issues_client, workspace, team_id=OTHER_TEAM)
    private_issue = seed_issue(issues_client, workspace)
    on_open = _request(client, workspace, "issue", open_issue["id"], customer_id)
    on_private = _request(client, workspace, "issue", private_issue["id"], customer_id)
    repositories.memberships.set_team_private(workspace, TEAM, True)

    sign_in(client, GUEST)
    assert _edit(client, workspace, on_private, important=True).status_code == 403

    sign_in(client, MEMBER)
    into_hidden = _edit(client, workspace, on_open, target_kind="issue", target_id=private_issue["id"])
    assert into_hidden.status_code == 404, into_hidden.text
    assert _edit(client, workspace, on_private, important=True).status_code == 404
    assert _edit(client, workspace, on_private, target_kind="issue", target_id=open_issue["id"]).status_code == 404
    rows = client.get(f"{_base(workspace)}/issues/{open_issue['id']}/customer-requests").json()["requests"]
    assert [row["request_id"] for row in rows] == [on_open["request_id"]]
