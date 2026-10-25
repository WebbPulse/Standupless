"""The customer statuses and tiers a workspace admin sets up in settings.

The properties worth holding are that a workspace that never edited its lists
reads the five old statuses and one tier per tier string in use, that customers
written before the lists keep their status and tier without a migration, that
guests read neither list and only an admin edits them, that names are unique per
list, that reordering renumbers the rest, that deleting an entry customers hold
asks for a replacement and moves them, that every edit is audited, and that a
customer takes a status or tier by id or by name and refuses an unknown one.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient
from webbpulse.audit import AuditQuery

from app.common.customer_fields import legacy_tier_id
from app.common.db.dynamo.customers import Customer
from tests.domains.helpers import ADMIN, GUEST, MEMBER, sign_in
from tests.domains.planning.conftest import WORKSPACE


def _base(workspace: str) -> str:
    """The workspace's customers API root."""
    return f"/api/workspaces/{workspace}/customers"


def _legacy(repositories: Any, name: str, *, status: str | None = None, tier: str | None = None) -> Customer:
    """Store a customer the way rows were written before the lists, with plain status and tier strings."""
    return repositories.customers.create(
        Customer(workspace_id=WORKSPACE, name=name, status=status, tier=tier, created_by=ADMIN)
    )


def _list(client: TestClient, workspace: str, kind: str) -> list[dict[str, Any]]:
    """One list as the route answers it."""
    response = client.get(f"{_base(workspace)}/{kind}")
    assert response.status_code == 200, response.text
    return response.json()[kind]


def _add(client: TestClient, workspace: str, kind: str, **payload: Any) -> dict[str, Any]:
    """Add one entry, failing loudly on a refusal."""
    response = client.post(f"{_base(workspace)}/{kind}", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def _actions(repositories: Any, action: str) -> list[Any]:
    """The audit events of one action."""
    return repositories.audit.list_events(WORKSPACE, AuditQuery(action=action)).events


def test_an_unedited_workspace_reads_the_seeded_lists(client: TestClient, repositories: Any, workspace: str) -> None:
    """The five old statuses, and one tier per distinct tier string in use, ignoring case."""
    _legacy(repositories, "Acme", status="trial", tier="Enterprise")
    _legacy(repositories, "Beta", tier="enterprise ")
    _legacy(repositories, "Gamma", tier="Startup")
    sign_in(client, MEMBER)

    statuses = _list(client, workspace, "statuses")
    tiers = _list(client, workspace, "tiers")

    assert [(row["id"], row["name"], row["position"]) for row in statuses] == [
        ("lead", "Lead", 0),
        ("trial", "Trial", 1),
        ("active", "Active", 2),
        ("paused", "Paused", 3),
        ("churned", "Churned", 4),
    ]
    assert next(row["customer_count"] for row in statuses if row["id"] == "trial") == 1
    assert [(row["id"], row["name"], row["customer_count"]) for row in tiers] == [
        (legacy_tier_id("Enterprise"), "Enterprise", 2),
        (legacy_tier_id("Startup"), "Startup", 1),
    ]
    assert repositories.customers.list_fields(WORKSPACE, "customer_status") == []


def test_a_legacy_customer_reads_its_status_and_tier(client: TestClient, repositories: Any, workspace: str) -> None:
    """A row with plain strings maps onto the entries at read time, and keeps doing so once the lists are stored."""
    legacy = _legacy(repositories, "Acme", status="paused", tier="Gold")
    sign_in(client, ADMIN)
    url = f"{_base(workspace)}/{legacy.customer_id}"

    before = client.get(url).json()
    _add(client, workspace, "tiers", name="Silver")
    after = client.get(url).json()

    for body in (before, after):
        assert (body["status_id"], body["status"], body["status_name"]) == ("paused", "paused", "Paused")
        assert (body["tier_id"], body["tier"]) == (legacy_tier_id("Gold"), "Gold")
    assert [row["name"] for row in _list(client, workspace, "tiers")] == ["Gold", "Silver"]


def test_guests_read_no_list_and_only_admins_edit(client: TestClient, workspace: str) -> None:
    """A guest is refused even the read, and a member reads but cannot add, edit or delete."""
    sign_in(client, GUEST)
    assert client.get(f"{_base(workspace)}/statuses").status_code == 403
    assert client.get(f"{_base(workspace)}/tiers").status_code == 403

    sign_in(client, MEMBER)
    assert client.get(f"{_base(workspace)}/tiers").status_code == 200
    assert client.post(f"{_base(workspace)}/tiers", json={"name": "Gold"}).status_code == 403
    assert client.patch(f"{_base(workspace)}/statuses/lead", json={"name": "Prospect"}).status_code == 403
    assert client.delete(f"{_base(workspace)}/statuses/lead").status_code == 403


def test_an_admin_adds_renames_recolours_and_reorders(client: TestClient, repositories: Any, workspace: str) -> None:
    """Names are unique per list ignoring case, and a move renumbers the rest."""
    sign_in(client, ADMIN)
    gold = _add(client, workspace, "tiers", name="Gold", color="#F2C94C")
    silver = _add(client, workspace, "tiers", name="Silver")
    bronze = _add(client, workspace, "tiers", name="Bronze", position=0)

    assert gold["color"] == "#f2c94c"
    assert [row["name"] for row in _list(client, workspace, "tiers")] == ["Bronze", "Gold", "Silver"]
    assert client.post(f"{_base(workspace)}/tiers", json={"name": " gold "}).status_code == 409
    assert client.post(f"{_base(workspace)}/statuses", json={"name": "Gold"}).status_code == 201
    assert client.post(f"{_base(workspace)}/tiers", json={"name": "Teal", "color": "teal"}).status_code == 422

    renamed = client.patch(f"{_base(workspace)}/tiers/{silver['id']}", json={"name": "Platinum", "color": None})
    assert renamed.status_code == 200, renamed.text
    assert client.patch(f"{_base(workspace)}/tiers/{silver['id']}", json={"name": "GOLD"}).status_code == 409
    moved = client.patch(f"{_base(workspace)}/tiers/{bronze['id']}", json={"position": 2})
    assert moved.status_code == 200, moved.text
    assert client.patch(f"{_base(workspace)}/tiers/nope", json={"name": "X"}).status_code == 404

    tiers = _list(client, workspace, "tiers")
    assert [(row["name"], row["position"]) for row in tiers] == [("Gold", 0), ("Platinum", 1), ("Bronze", 2)]
    recoloured = client.patch(f"{_base(workspace)}/statuses/active", json={"color": "#000000"})
    assert recoloured.json()["color"] == "#000000"
    assert len(_actions(repositories, "customer_tier.created")) == 3
    assert len(_actions(repositories, "customer_tier.updated")) == 2
    assert len(_actions(repositories, "customer_status.updated")) == 1


def test_deleting_a_held_entry_asks_for_a_replacement(client: TestClient, repositories: Any, workspace: str) -> None:
    """An entry customers hold needs another to move them onto, and an unheld one just goes."""
    legacy = _legacy(repositories, "Acme", status="trial")
    sign_in(client, ADMIN)
    held = client.post(_base(workspace), json={"name": "Beta", "status": "Trial"}).json()

    refused = client.delete(f"{_base(workspace)}/statuses/trial")
    assert refused.status_code == 422, refused.text
    assert client.delete(f"{_base(workspace)}/statuses/trial?replacement_id=trial").status_code == 422
    assert client.delete(f"{_base(workspace)}/statuses/trial?replacement_id=nope").status_code == 422
    assert client.delete(f"{_base(workspace)}/statuses/trial?replacement_id=active").status_code == 204
    assert client.delete(f"{_base(workspace)}/statuses/lead").status_code == 204

    for customer_id in (legacy.customer_id, held["customer_id"]):
        body = client.get(f"{_base(workspace)}/{customer_id}").json()
        assert (body["status_id"], body["status_name"]) == ("active", "Active")
    statuses = _list(client, workspace, "statuses")
    assert [(row["id"], row["position"]) for row in statuses] == [("active", 0), ("paused", 1), ("churned", 2)]
    deleted = _actions(repositories, "customer_status.deleted")
    assert {event.target.id for event in deleted} == {"trial", "lead"}


def test_an_emptied_list_stays_empty(client: TestClient, workspace: str) -> None:
    """Once the seeded entries are stored, deleting them all does not bring the defaults back."""
    sign_in(client, ADMIN)
    for row in _list(client, workspace, "statuses"):
        assert client.delete(f"{_base(workspace)}/statuses/{row['id']}").status_code == 204

    assert _list(client, workspace, "statuses") == []
    assert client.post(_base(workspace), json={"name": "Acme", "status": "lead"}).status_code == 422


def test_a_customer_takes_a_status_and_tier_by_id_or_name(client: TestClient, workspace: str) -> None:
    """Ids and names both resolve, an unknown value or a disagreeing pair is refused, and null clears."""
    sign_in(client, ADMIN)
    gold = _add(client, workspace, "tiers", name="Gold")
    sign_in(client, MEMBER)

    by_name = client.post(_base(workspace), json={"name": "Acme", "status": "Active", "tier": "gold"})
    assert by_name.status_code == 201, by_name.text
    created = by_name.json()
    assert (created["status_id"], created["status_name"]) == ("active", "Active")
    assert (created["tier_id"], created["tier"]) == (gold["id"], "Gold")

    url = f"{_base(workspace)}/{created['customer_id']}"
    by_id = client.patch(url, json={"status_id": "paused", "tier_id": None})
    assert by_id.status_code == 200, by_id.text
    assert (by_id.json()["status_id"], by_id.json()["tier_id"], by_id.json()["tier"]) == ("paused", None, None)

    assert client.patch(url, json={"tier": "Diamond"}).status_code == 422
    assert client.patch(url, json={"status_id": "nope"}).status_code == 422
    assert client.patch(url, json={"status_id": "active", "status": "Paused"}).status_code == 422
    assert client.post(_base(workspace), json={"name": "Beta", "tier": "Diamond"}).status_code == 422
    assert client.patch(url, json={"status": None}).json()["status_id"] is None
