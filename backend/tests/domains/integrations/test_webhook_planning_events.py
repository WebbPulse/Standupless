"""Outbound webhooks for documents, initiatives, initiative updates, customers and customer requests.

Each type is checked for the shape of its body, the teams it is filed under, and
the private team rule: a workspace-wide webhook never hears a private team's row,
and a team webhook hears it only while its creator can read the team.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from app.common.db.dynamo.base import utc_now
from app.common.customer_fields import legacy_tier_id
from app.common.db.dynamo.customers import Customer, CustomerRequest
from app.common.db.dynamo.documents import Document, DocumentBody, ParentKind
from app.common.db.dynamo.github import ORIGINAL_RESOURCE_TYPES, WebhookEndpoint, webhook_key
from app.common.db.dynamo.planning import (
    Initiative,
    InitiativeUpdateRow,
    Project,
    initiative_key,
    initiative_update_key,
    project_key,
)
from app.domains.integrations.consumers import stream
from app.domains.integrations.outbound import delivery, payloads
from tests.domains.helpers import add_team_member, sign_in
from tests.domains.integrations.conftest import OTHER_TEAM, OWNER, TEAM, WORKSPACE
from tests.domains.integrations.test_webhook_delivery import make_endpoint, one_delivery, record


@pytest.fixture
def jobs(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """Capture every attempt job instead of sending it to SQS."""
    captured: list[dict[str, Any]] = []

    def enqueue(queue_url: str, envelope: Any, **kwargs: Any) -> str:
        """Keep the payload of one queued job."""
        captured.append(dict(envelope.payload))
        return "message-id"

    monkeypatch.setattr(delivery, "enqueue", enqueue)
    return captured


def planning(event: str, new: Any = None, old: Any = None, event_id: str = "evt-1") -> dict[str, Any]:
    """One planning stream record from model rows or plain images."""
    return record(event, _image(new), _image(old), table="planning", event_id=event_id)


def _image(row: Any) -> dict[str, Any] | None:
    """A stored row as the stream image carries it."""
    if row is None:
        return None
    return row.model_dump(mode="json") if hasattr(row, "model_dump") else dict(row)


def targeted(jobs: list[dict[str, Any]]) -> set[str]:
    """The webhooks the captured jobs go to."""
    return {job["webhook_id"] for job in jobs}


def body_of(repositories: Any, endpoint: WebhookEndpoint) -> dict[str, Any]:
    """The JSON body of the one delivery logged for `endpoint`."""
    return json.loads(one_delivery(repositories, endpoint).body)


def store_project(repositories: Any, team_ids: list[str]) -> Project:
    """Store one project, which a document under it reads for its teams."""
    return repositories.planning.create_project(
        Project(
            workspace_id=WORKSPACE,
            planning_key=project_key("P1"),
            project_id="P1",
            team_ids=team_ids,
            name="Launch",
            created_by=OWNER,
        )
    )


def store_initiative(repositories: Any, team_id: str | None) -> Initiative:
    """Store one initiative led by `team_id`, or workspace level for `None`."""
    return repositories.planning.create_initiative(
        Initiative(
            workspace_id=WORKSPACE,
            planning_key=initiative_key("N1"),
            initiative_id="N1",
            name="Grow",
            team_id=team_id,
            created_by=OWNER,
        )
    )


def store_document(
    repositories: Any, parent_kind: ParentKind = "team", parent_id: str = TEAM, body: str = "# Plan"
) -> Document:
    """Store one document with its body, the way the create route writes it."""
    now = utc_now()
    document = Document(
        workspace_id=WORKSPACE,
        document_id="D1",
        parent_kind=parent_kind,
        parent_id=parent_id,
        title="Plan",
        author_id=OWNER,
        updated_by=OWNER,
        created_at=now,
        updated_at=now,
    )
    repositories.documents.create(
        document,
        DocumentBody(workspace_id=WORKSPACE, document_id="D1", parent_kind=parent_kind, parent_id=parent_id, body=body),
    )
    return document


def private_team(repositories: Any) -> None:
    """Make `TEAM` private with the webhooks' creator inside it."""
    repositories.memberships.set_team_private(WORKSPACE, TEAM, True)
    add_team_member(repositories, WORKSPACE, TEAM, OWNER, "admin")


def test_a_stored_endpoint_without_a_list_never_gains_the_new_types() -> None:
    """A row written before these types existed reads as the six it was created with."""
    endpoint = WebhookEndpoint(
        workspace_id=WORKSPACE,
        github_key=webhook_key("W1"),
        webhook_id="W1",
        url="https://example.test/hook",
        secret_salt="salt",
        created_by=OWNER,
        created_at=utc_now(),
        updated_at=utc_now(),
    )

    assert endpoint.resource_types == list(ORIGINAL_RESOURCE_TYPES)
    assert "documents" not in endpoint.resource_types


def test_the_webhook_routes_accept_the_new_types(
    client: Any, repositories: Any, workspace: str, public_dns: None
) -> None:
    """Creating a webhook for each new type validates, and an unknown type still does not."""
    sign_in(client, OWNER)
    wanted = ["documents", "initiatives", "initiative_updates", "customers", "customer_requests"]

    created = client.post(
        f"/api/workspaces/{WORKSPACE}/webhooks",
        json={"url": "https://example.test/hook", "label": "Receiver", "resource_types": wanted},
    )
    refused = client.post(
        f"/api/workspaces/{WORKSPACE}/webhooks",
        json={"url": "https://example.test/hook", "label": "Receiver", "resource_types": ["documentz"]},
    )

    assert created.status_code == 201, created.text
    assert sorted(created.json()["resource_types"]) == sorted(wanted)
    assert refused.status_code == 422


def test_a_document_describes_its_content_and_its_projects_teams(repositories: Any, workspace: str) -> None:
    """A project's document is filed under every team of the project, with its Markdown as `content`."""
    store_project(repositories, [TEAM, OTHER_TEAM])
    document = store_document(repositories, "project", "P1")

    event = payloads.describe(repositories, payloads.DOCUMENT, "INSERT", _image(document) or {}, {})

    assert event is not None and event.event_type == "Document" and event.action == "create"
    assert event.resource_type == "documents"
    assert event.team_ids == (TEAM, OTHER_TEAM)
    assert event.data["id"] == "D1"
    assert event.data["title"] == "Plan"
    assert event.data["content"] == "# Plan"
    assert event.data["parentKind"] == "project"
    assert event.data["projectId"] == "P1"
    assert event.data["initiativeId"] is None
    assert event.data["creatorId"] == OWNER
    assert event.url.endswith("/documents/D1")
    assert "terms" not in event.data


@pytest.mark.parametrize(("lead", "teams"), [(TEAM, (TEAM,)), (None, ())])
def test_an_initiatives_document_takes_the_initiatives_lead_team(
    repositories: Any, workspace: str, lead: str | None, teams: tuple[str, ...]
) -> None:
    """A document under an initiative is its lead team's, or workspace wide when there is none."""
    store_initiative(repositories, lead)
    document = store_document(repositories, "initiative", "N1")

    event = payloads.describe(repositories, payloads.DOCUMENT, "INSERT", _image(document) or {}, {})

    assert event is not None
    assert event.team_ids == teams
    assert event.data["initiativeId"] == "N1"


def test_a_document_whose_parent_is_gone_is_withheld(repositories: Any, workspace: str) -> None:
    """With the project unreadable its teams are unknown, so nothing is sent rather than sending it workspace wide."""
    document = store_document(repositories, "project", "P-gone")

    assert payloads.describe(repositories, payloads.DOCUMENT, "INSERT", _image(document) or {}, {}) is None


def test_a_private_teams_document_reaches_only_that_teams_webhooks(
    repositories: Any, workspace: str, github_env: None, jobs: list[dict[str, Any]]
) -> None:
    """A workspace-wide webhook and another team's webhook skip it; the team's own webhook hears it."""
    wide = make_endpoint(repositories, resource_types=["documents"])
    same_team = make_endpoint(repositories, team_id=TEAM, resource_types=["documents"])
    other_team = make_endpoint(repositories, team_id=OTHER_TEAM, resource_types=["documents"])
    private_team(repositories)
    document = store_document(repositories)

    stream.handle_record(repositories, planning("INSERT", document))

    assert targeted(jobs) == {same_team.webhook_id}
    assert body_of(repositories, same_team)["data"]["teamId"] == TEAM
    for endpoint in (wide, other_team):
        assert repositories.github.list_deliveries(WORKSPACE, endpoint.webhook_id) == []


def test_a_private_teams_document_skips_a_team_webhook_whose_creator_left(
    repositories: Any, workspace: str, github_env: None, jobs: list[dict[str, Any]]
) -> None:
    """A team webhook set up by someone who cannot read the private team sends nothing."""
    make_endpoint(repositories, team_id=TEAM, resource_types=["documents"])
    repositories.memberships.set_team_private(WORKSPACE, TEAM, True)
    document = store_document(repositories)

    stream.handle_record(repositories, planning("INSERT", document))

    assert jobs == []


def test_a_document_edit_sends_an_update_and_a_search_terms_rewrite_sends_nothing(
    repositories: Any, workspace: str, github_env: None, jobs: list[dict[str, Any]]
) -> None:
    """A body edit moves `updatedAt`, which is news; terms alone are internal."""
    endpoint = make_endpoint(repositories, resource_types=["documents"])
    document = store_document(repositories)
    edited = document.model_copy(update={"updated_at": utc_now(), "title": "Plan B"})
    reindexed = edited.model_copy(update={"terms": ["plan"]})

    stream.handle_record(repositories, planning("MODIFY", edited, document, event_id="e"))
    stream.handle_record(repositories, planning("MODIFY", reindexed, edited, event_id="t"))

    assert targeted(jobs) == {endpoint.webhook_id}
    body = body_of(repositories, endpoint)
    assert body["action"] == "update"
    assert body["updatedFrom"]["title"] == "Plan"
    assert "updatedAt" in body["updatedFrom"]


def test_a_moved_document_sends_one_update_to_both_parents_teams(
    repositories: Any, workspace: str, github_env: None, jobs: list[dict[str, Any]]
) -> None:
    """The new summary is skipped, and the old one's removal reads as an update from the old parent."""
    old_team = make_endpoint(repositories, team_id=TEAM, resource_types=["documents"])
    new_team = make_endpoint(repositories, team_id=OTHER_TEAM, resource_types=["documents"])
    document = store_document(repositories)
    moved = document.model_copy(update={"parent_id": OTHER_TEAM, "planning_key": "", "updated_at": utc_now()})
    moved.model_post_init(None)
    repositories.documents.move(
        document,
        moved,
        DocumentBody(workspace_id=WORKSPACE, document_id="D1", parent_kind="team", parent_id=OTHER_TEAM, body="# Plan"),
    )

    stream.handle_record(repositories, planning("INSERT", moved, event_id="in"))
    stream.handle_record(repositories, planning("REMOVE", None, document, event_id="out"))

    assert targeted(jobs) == {old_team.webhook_id, new_team.webhook_id}
    body = body_of(repositories, new_team)
    assert body["action"] == "update"
    assert body["data"]["teamId"] == OTHER_TEAM
    assert body["updatedFrom"]["parentId"] == TEAM


def test_a_deleted_document_sends_a_remove_without_content(
    repositories: Any, workspace: str, github_env: None, jobs: list[dict[str, Any]]
) -> None:
    """Once the body row is gone the removal is a delete, not a move."""
    endpoint = make_endpoint(repositories, resource_types=["documents"])
    document = store_document(repositories)
    repositories.documents.delete(WORKSPACE, document)

    stream.handle_record(repositories, planning("REMOVE", None, document))

    body = body_of(repositories, endpoint)
    assert body["action"] == "remove"
    assert body["data"]["content"] is None


def test_an_initiative_describes_itself_and_its_lead_team(repositories: Any, workspace: str) -> None:
    """The lead team files it, and the URL is the initiative page."""
    initiative = store_initiative(repositories, TEAM)

    event = payloads.describe(repositories, payloads.INITIATIVE, "INSERT", _image(initiative) or {}, {})

    assert event is not None and event.event_type == "Initiative"
    assert event.team_ids == (TEAM,)
    assert event.data["id"] == "N1"
    assert event.data["name"] == "Grow"
    assert event.data["teamId"] == TEAM
    assert event.data["status"] == "planned"
    assert event.data["creatorId"] == OWNER
    assert "/initiatives/" in event.url
    assert "sortOrder" not in event.data


def test_a_workspace_level_initiative_reaches_only_workspace_wide_webhooks(
    repositories: Any, workspace: str, github_env: None, jobs: list[dict[str, Any]]
) -> None:
    """No lead team means no team webhook hears it."""
    wide = make_endpoint(repositories, resource_types=["initiatives"])
    make_endpoint(repositories, team_id=TEAM, resource_types=["initiatives"])
    initiative = store_initiative(repositories, None)

    stream.handle_record(repositories, planning("INSERT", initiative))

    assert targeted(jobs) == {wide.webhook_id}


def test_an_initiative_moved_to_another_lead_team_reaches_both_teams(repositories: Any, workspace: str) -> None:
    """An update is filed under the team it left as well as the one it joined."""
    initiative = store_initiative(repositories, TEAM)
    moved = initiative.model_copy(update={"team_id": OTHER_TEAM})

    event = payloads.describe(
        repositories, payloads.INITIATIVE, "MODIFY", _image(moved) or {}, _image(initiative) or {}
    )

    assert event is not None
    assert set(event.team_ids) == {TEAM, OTHER_TEAM}
    assert event.updated_from == {"teamId": TEAM}


def test_a_private_teams_initiative_skips_workspace_wide_webhooks(
    repositories: Any, workspace: str, github_env: None, jobs: list[dict[str, Any]]
) -> None:
    """A private lead team keeps the initiative to its own webhooks."""
    make_endpoint(repositories, resource_types=["initiatives"])
    same_team = make_endpoint(repositories, team_id=TEAM, resource_types=["initiatives"])
    private_team(repositories)
    initiative = store_initiative(repositories, TEAM)

    stream.handle_record(repositories, planning("INSERT", initiative))

    assert targeted(jobs) == {same_team.webhook_id}


def _initiative_update() -> InitiativeUpdateRow:
    """One posted update on initiative N1."""
    return InitiativeUpdateRow(
        workspace_id=WORKSPACE,
        planning_key=initiative_update_key("N1", "U1"),
        update_id="U1",
        initiative_id="N1",
        body="On track",
        health="on_track",
        author_id=OWNER,
    )


def test_an_initiative_update_describes_its_initiative_and_link(repositories: Any, workspace: str) -> None:
    """The teams and name come off the initiative row."""
    store_initiative(repositories, TEAM)

    event = payloads.describe(
        repositories, payloads.INITIATIVE_UPDATE, "INSERT", _image(_initiative_update()) or {}, {}
    )

    assert event is not None and event.event_type == "InitiativeUpdate"
    assert event.resource_type == "initiative_updates"
    assert event.team_ids == (TEAM,)
    assert event.data["id"] == "U1"
    assert event.data["initiativeId"] == "N1"
    assert event.data["initiativeName"] == "Grow"
    assert event.data["userId"] == OWNER
    assert event.data["body"] == "On track"
    assert event.data["health"] == "on_track"
    assert event.url.endswith("?tab=updates#update-U1")
    assert "snapshot" not in event.data


def test_an_initiative_update_whose_initiative_is_gone_is_withheld(repositories: Any, workspace: str) -> None:
    """Without the initiative its team is unknown, so a private team's update cannot leak."""
    event = payloads.describe(
        repositories, payloads.INITIATIVE_UPDATE, "REMOVE", {}, _image(_initiative_update()) or {}
    )

    assert event is None


def test_a_private_teams_initiative_update_reaches_only_that_teams_webhooks(
    repositories: Any, workspace: str, github_env: None, jobs: list[dict[str, Any]]
) -> None:
    """The initiative's private lead team keeps its updates off workspace-wide webhooks."""
    make_endpoint(repositories, resource_types=["initiative_updates"])
    same_team = make_endpoint(repositories, team_id=TEAM, resource_types=["initiative_updates"])
    make_endpoint(repositories, team_id=TEAM, resource_types=["initiatives"])
    private_team(repositories)
    store_initiative(repositories, TEAM)

    stream.handle_record(repositories, planning("INSERT", _initiative_update()))

    assert targeted(jobs) == {same_team.webhook_id}
    assert body_of(repositories, same_team)["type"] == "InitiativeUpdate"


def _customer() -> Customer:
    """One customer row."""
    return Customer(workspace_id=WORKSPACE, customer_id="C1", name="Acme", domains=["acme.test"], created_by=OWNER)


def test_a_customer_reaches_only_workspace_wide_webhooks(
    repositories: Any, workspace: str, github_env: None, jobs: list[dict[str, Any]]
) -> None:
    """A customer belongs to no team, so a team webhook never hears it."""
    wide = make_endpoint(repositories, resource_types=["customers"])
    make_endpoint(repositories, team_id=TEAM, resource_types=["customers"])

    stream.handle_record(repositories, planning("INSERT", _customer()))

    assert targeted(jobs) == {wide.webhook_id}
    body = body_of(repositories, wide)
    assert body["type"] == "Customer"
    assert body["data"]["id"] == "C1"
    assert body["data"]["name"] == "Acme"
    assert body["data"]["domains"] == ["acme.test"]
    assert body["url"].endswith("/customers/C1")


def test_a_customer_carries_its_status_and_tier_ids(repositories: Any, workspace: str) -> None:
    """A configured customer names its ids, and a legacy row derives them from its strings."""
    configured = Customer(
        workspace_id=WORKSPACE, customer_id="C1", name="Acme", status_id="active", tier_id="T1", created_by=OWNER
    )
    legacy = Customer(
        workspace_id=WORKSPACE, customer_id="C2", name="Beta", status="trial", tier="Gold", created_by=OWNER
    )

    first = payloads.describe(repositories, payloads.CUSTOMER, "INSERT", _image(configured) or {}, {})
    second = payloads.describe(repositories, payloads.CUSTOMER, "INSERT", _image(legacy) or {}, {})

    assert first is not None and (first.data["statusId"], first.data["tierId"]) == ("active", "T1")
    assert second is not None and (second.data["statusId"], second.data["tierId"]) == ("trial", legacy_tier_id("Gold"))


def _request(team_ids: list[str] | None = None, **fields: Any) -> CustomerRequest:
    """One customer request on issue I1, its customer copy."""
    return CustomerRequest(
        workspace_id=WORKSPACE,
        request_id="R1",
        customer_id="C1",
        target_kind="issue",
        target_id="I1",
        team_ids=[TEAM] if team_ids is None else team_ids,
        body="We need this",
        author_id=OWNER,
        **fields,
    )


def test_a_customer_request_describes_itself_and_its_targets_teams(repositories: Any, workspace: str) -> None:
    """The request carries the teams of the issue it names."""
    copy = _request().as_target_copy()

    event = payloads.describe(repositories, payloads.CUSTOMER_REQUEST, "INSERT", _image(copy) or {}, {})

    assert event is not None and event.event_type == "CustomerNeed"
    assert event.resource_type == "customer_requests"
    assert event.team_ids == (TEAM,)
    assert event.data["id"] == "R1"
    assert event.data["customerId"] == "C1"
    assert event.data["targetKind"] == "issue"
    assert event.data["targetId"] == "I1"
    assert event.data["body"] == "We need this"
    assert event.data["important"] is False
    assert event.url.endswith("/customers/C1")


def test_a_customer_request_is_sent_once_through_its_target_copy(
    repositories: Any, workspace: str, github_env: None, jobs: list[dict[str, Any]]
) -> None:
    """The customer copy of the same write is not sent a second time."""
    endpoint = make_endpoint(repositories, resource_types=["customer_requests"])
    row = repositories.customers.add_request(_request())

    stream.handle_record(repositories, planning("INSERT", row, event_id="customer"))
    stream.handle_record(repositories, planning("INSERT", row.as_target_copy(), event_id="target"))

    assert targeted(jobs) == {endpoint.webhook_id}
    assert body_of(repositories, endpoint)["action"] == "create"


def test_a_private_teams_customer_request_reaches_only_that_teams_webhooks(
    repositories: Any, workspace: str, github_env: None, jobs: list[dict[str, Any]]
) -> None:
    """A request on a private team's issue never reaches a workspace-wide or other team webhook."""
    make_endpoint(repositories, resource_types=["customer_requests"])
    make_endpoint(repositories, team_id=OTHER_TEAM, resource_types=["customer_requests"])
    same_team = make_endpoint(repositories, team_id=TEAM, resource_types=["customer_requests"])
    private_team(repositories)

    stream.handle_record(repositories, planning("INSERT", _request().as_target_copy()))

    assert targeted(jobs) == {same_team.webhook_id}


def test_a_request_moved_to_another_target_sends_one_update(
    repositories: Any, workspace: str, github_env: None, jobs: list[dict[str, Any]]
) -> None:
    """The new target copy is skipped and the old one's removal reads as an update to both teams."""
    old_team = make_endpoint(repositories, team_id=TEAM, resource_types=["customer_requests"])
    new_team = make_endpoint(repositories, team_id=OTHER_TEAM, resource_types=["customer_requests"])
    repositories.customers.create(_customer())
    previous = repositories.customers.add_request(_request())
    edited = previous.model_copy(update={"target_id": "I2", "team_ids": [OTHER_TEAM], "updated_at": utc_now()})
    stored = repositories.customers.replace_request(previous, edited)

    stream.handle_record(repositories, planning("INSERT", stored.as_target_copy(), event_id="in"))
    stream.handle_record(repositories, planning("REMOVE", None, previous.as_target_copy(), event_id="out"))

    assert targeted(jobs) == {old_team.webhook_id, new_team.webhook_id}
    body = body_of(repositories, new_team)
    assert body["action"] == "update"
    assert body["data"]["targetId"] == "I2"
    assert body["updatedFrom"]["targetId"] == "I1"


def test_a_request_moved_to_another_customer_and_target_still_reads_as_an_update(
    repositories: Any, workspace: str, github_env: None, jobs: list[dict[str, Any]]
) -> None:
    """With both moved in one edit the request is found in the workspace's list, not reported removed."""
    endpoint = make_endpoint(repositories, resource_types=["customer_requests"])
    repositories.customers.create(_customer())
    repositories.customers.create(_customer().model_copy(update={"customer_id": "C2", "planning_key": "customer#C2"}))
    previous = repositories.customers.add_request(_request())
    edited = previous.model_copy(update={"customer_id": "C2", "target_id": "I2", "updated_at": utc_now()})
    repositories.customers.replace_request(previous, edited)

    stream.handle_record(repositories, planning("REMOVE", None, previous.as_target_copy()))

    body = body_of(repositories, endpoint)
    assert body["action"] == "update"
    assert body["updatedFrom"] == {"customerId": "C1", "targetId": "I1"}


def test_a_deleted_request_and_a_merged_customers_requests_read_as_remove_and_update(
    repositories: Any, workspace: str, github_env: None, jobs: list[dict[str, Any]]
) -> None:
    """A delete takes the request away, and a merge rewrites the target copy's customer in place."""
    endpoint = make_endpoint(repositories, resource_types=["customer_requests"])
    repositories.customers.create(_customer())
    row = repositories.customers.add_request(_request())
    merged = row.as_target_copy().model_copy(update={"customer_id": "C2"})
    repositories.customers.delete_request(row)

    stream.handle_record(repositories, planning("MODIFY", merged, row.as_target_copy(), event_id="merge"))
    stream.handle_record(repositories, planning("REMOVE", None, row.as_target_copy(), event_id="delete"))

    actions = sorted(
        json.loads(delivery_row.body)["action"]
        for delivery_row in repositories.github.list_deliveries(WORKSPACE, endpoint.webhook_id)
    )
    assert actions == ["remove", "update"]
