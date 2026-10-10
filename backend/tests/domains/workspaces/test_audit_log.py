"""The workspace audit log: what is recorded, who may read it, and the plan gate.

Events are recorded on every plan, so these hold that a write path leaves its row
whatever the plan, that only an owner or admin reads the log, that a plan without
the audit log answers `available: false` rather than the rows, and that the
filters and the CSV download return only what was asked for.
"""

from __future__ import annotations

import csv
import io
from datetime import UTC, datetime, timedelta
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient
from webbpulse.dynamodb import new_ulid

from app.common import audit
from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.db.dynamo.audit import AuditEvent
from tests.domains.helpers import ADMIN, MEMBER, OWNER, add_member, make_user, make_workspace, sign_in

WORKSPACE = "01JB00000000000000000000WS"

LOG = f"/api/workspaces/{WORKSPACE}/audit-log"


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client for the workspaces application, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["workspaces"])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def workspace(repositories: Any) -> str:
    """A Business workspace with an admin and a member beside its owner."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    repositories.workspaces.set_billing(WORKSPACE, plan="business")
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    make_user(repositories, OWNER, "owner@example.com", "Olive Owner")
    make_user(repositories, ADMIN, "admin@example.com", "Adam Admin")
    make_user(repositories, MEMBER, "member@example.com", "Mo Member")
    return WORKSPACE


def events(client: TestClient, **params: Any) -> list[dict[str, Any]]:
    """The events one read of the log answers."""
    response = client.get(LOG, params=params)
    assert response.status_code == 200, response.text
    return response.json()["events"]


def test_a_role_change_is_recorded_with_before_and_after(client: TestClient, workspace: str) -> None:
    sign_in(client, OWNER)
    assert client.patch(f"/api/workspaces/{WORKSPACE}/members/{MEMBER}", json={"role": "admin"}).status_code == 200

    rows = events(client, event="member.role_changed")

    assert len(rows) == 1
    row = rows[0]
    assert row["actor_id"] == OWNER
    assert row["actor_name"] == "Olive Owner"
    assert row["target_id"] == MEMBER
    assert row["before"] == {"role": "member"}
    assert row["after"] == {"role": "admin"}
    assert row["event_label"] == "Member role changed"


def test_a_rename_records_only_the_changed_settings(client: TestClient, workspace: str) -> None:
    sign_in(client, ADMIN)
    assert client.patch(f"/api/workspaces/{WORKSPACE}", json={"name": "Renamed"}).status_code == 200

    rows = events(client, event="workspace.updated")

    assert len(rows) == 1
    assert rows[0]["before"] == {"name": "Acme"}
    assert rows[0]["after"] == {"name": "Renamed"}


def test_creating_and_revoking_an_api_key_are_both_recorded(client: TestClient, workspace: str) -> None:
    sign_in(client, MEMBER)
    created = client.post(f"/api/workspaces/{WORKSPACE}/api-keys", json={"name": "CI", "scopes": ["issues:read"]})
    assert created.status_code == 201, created.text
    key_id = created.json()["key_id"]
    assert client.delete(f"/api/workspaces/{WORKSPACE}/api-keys/{key_id}").status_code == 204
    assert client.delete(f"/api/workspaces/{WORKSPACE}/api-keys/{key_id}").status_code == 204

    sign_in(client, ADMIN)
    kinds = sorted(row["event"] for row in events(client, actor_id=MEMBER))

    assert kinds == ["api_key.created", "api_key.revoked"]


def test_a_removal_is_recorded(client: TestClient, workspace: str) -> None:
    sign_in(client, ADMIN)
    assert client.delete(f"/api/workspaces/{WORKSPACE}/members/{MEMBER}").status_code == 204

    rows = events(client, event="member.removed")

    assert [row["target_id"] for row in rows] == [MEMBER]


def test_the_filters_narrow_by_actor_and_event(client: TestClient, workspace: str, repositories: Any) -> None:
    audit.record_system(repositories, WORKSPACE, "plan.changed", actor_id="stripe")
    audit.record_system(repositories, WORKSPACE, "team.created", actor_id=ADMIN, actor_kind="user", source="web")
    sign_in(client, OWNER)

    assert [row["event"] for row in events(client, actor_id="stripe")] == ["plan.changed"]
    assert [row["actor_id"] for row in events(client, event="team.created")] == [ADMIN]
    assert events(client, actor_id=MEMBER) == []


def test_the_date_range_bounds_the_log(client: TestClient, workspace: str, repositories: Any) -> None:
    old = datetime.now(UTC) - timedelta(days=40)
    recent = datetime.now(UTC) - timedelta(days=2)
    for moment, event in ((old, "team.created"), (recent, "team.deleted")):
        repositories.audit.record(
            AuditEvent(
                workspace_id=WORKSPACE, audit_id=new_ulid(moment), event=event, actor_id=OWNER, created_at=moment
            )
        )
    sign_in(client, OWNER)
    week_ago = (datetime.now(UTC) - timedelta(days=7)).isoformat()

    assert [row["event"] for row in events(client, since=week_ago)] == ["team.deleted"]
    assert [row["event"] for row in events(client, until=week_ago)] == ["team.created"]
    assert events(client, since=week_ago, until=week_ago) == []


def test_the_cursor_pages_through_the_log(client: TestClient, workspace: str, repositories: Any) -> None:
    for _ in range(5):
        audit.record_system(repositories, WORKSPACE, "plan.changed")
    sign_in(client, OWNER)

    first = client.get(LOG, params={"limit": 3}).json()
    second = client.get(LOG, params={"limit": 3, "cursor": first["next_cursor"]}).json()

    assert len(first["events"]) == 3
    assert len(second["events"]) == 2
    assert second["next_cursor"] is None
    seen = {row["audit_id"] for row in first["events"] + second["events"]}
    assert len(seen) == 5


def test_a_member_may_not_read_the_log(client: TestClient, workspace: str) -> None:
    sign_in(client, MEMBER)
    assert client.get(LOG).status_code == 403
    assert client.get(f"{LOG}/export").status_code == 403


def test_a_plan_without_the_audit_log_still_records_but_does_not_read(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    repositories.workspaces.set_billing(WORKSPACE, plan="free")
    sign_in(client, OWNER)
    assert client.patch(f"/api/workspaces/{WORKSPACE}", json={"name": "Renamed"}).status_code == 200

    body = client.get(LOG).json()
    assert body["available"] is False
    assert body["events"] == []
    assert {row["key"] for row in body["event_types"]} == set(audit.EVENT_TYPES)
    export = client.get(f"{LOG}/export")
    assert export.status_code == 403
    assert export.json()["error_code"] == "PLAN_FEATURE_UNAVAILABLE"
    rows, _ = repositories.audit.list_events(WORKSPACE)
    assert [row.event for row in rows] == ["workspace.updated"]


def test_the_csv_download_carries_every_row_and_defuses_formulas(
    client: TestClient, workspace: str, repositories: Any
) -> None:
    audit.record_system(repositories, WORKSPACE, "team.created", target_label="=HYPERLINK(1)")
    audit.record_system(repositories, WORKSPACE, "plan.changed", before={"plan": "free"}, after={"plan": "business"})
    sign_in(client, ADMIN)

    response = client.get(f"{LOG}/export")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert "audit-log.csv" in response.headers["content-disposition"]
    rows = {row["event"]: row for row in csv.DictReader(io.StringIO(response.text))}
    assert set(rows) == {"plan.changed", "team.created"}
    assert rows["plan.changed"]["after"] == '{"plan": "business"}'
    assert rows["team.created"]["target_label"] == "'=HYPERLINK(1)"


def test_another_workspace_s_log_is_not_reachable(client: TestClient, workspace: str, repositories: Any) -> None:
    other = "01JB00000000000000000000OT"
    make_workspace(repositories, other, "other", MEMBER)
    audit.record_system(repositories, other, "plan.changed")
    sign_in(client, OWNER)

    assert events(client) == []
    assert client.get(f"/api/workspaces/{other}/audit-log").status_code == 404


def test_an_unknown_event_name_is_refused_at_the_call_site(repositories: Any, workspace: str) -> None:
    with pytest.raises(ValueError):
        audit.record_system(repositories, WORKSPACE, "made.up")


def test_the_purge_deletes_the_log(repositories: Any, workspace: str) -> None:
    audit.record_system(repositories, WORKSPACE, "plan.changed")
    audit.record_system(repositories, WORKSPACE, "team.created")

    repositories.audit.delete_for_workspace(WORKSPACE)

    assert repositories.audit.list_events(WORKSPACE) == ([], None)


def test_a_row_ages_out_a_year_after_it_was_written(repositories: Any, workspace: str) -> None:
    written = audit.record_system(repositories, WORKSPACE, "plan.changed")

    assert written is not None
    expected = int((written.created_at + timedelta(days=365)).timestamp())
    assert written.expires_at == expected
