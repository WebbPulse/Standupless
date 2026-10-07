"""The workspaces routes, against real tables in moto.

These cover the contract's workspace, member and invite routes plus the tenancy
invariants design section 2 lists: a non-member gets 404 rather than 403, and the
last owner can neither leave nor be demoted.
"""

from __future__ import annotations

from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from tests.domains.helpers import (
    ADMIN,
    GUEST,
    MEMBER,
    OUTSIDER,
    OWNER,
    add_member,
    make_user,
    make_workspace,
    sign_in,
    sign_in_through_gate,
)

WORKSPACE = "01JB00000000000000000000WS"

OTHER_WORKSPACE = "01JB0000000000000000000WS2"


def signed_up(repositories: Any, *user_ids: str) -> None:
    """Give each caller the user row sign up writes, which creating and joining require."""
    for user_id in user_ids:
        make_user(repositories, user_id, f"{user_id.lower()}@example.com")


@pytest.fixture
def client(repositories: Any) -> Iterator[TestClient]:
    """A client for the workspaces application, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["workspaces"])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


def test_health_reads_nothing(client: TestClient) -> None:
    """The domain probe answers without touching a table."""
    response = client.get("/api/workspaces/health")
    assert response.status_code == 200
    assert response.json()["domain"] == "workspaces"


def test_an_anonymous_caller_is_refused(client: TestClient) -> None:
    """No claims means 401, not an empty list: the route fails closed."""
    response = client.get("/api/workspaces")
    assert response.status_code == 401
    assert response.json()["error_code"] == "NOT_AUTHENTICATED"


def test_a_new_account_sees_an_empty_list(client: TestClient) -> None:
    """A caller in no workspace gets the envelope with an empty list, not a 404."""
    sign_in(client, OWNER)
    response = client.get("/api/workspaces")
    assert response.status_code == 200
    assert response.json() == {"workspaces": []}


def test_the_staging_gate_shape_signs_a_caller_in(client: TestClient) -> None:
    """Claims the staging gate publishes under `authorizer.lambda` read like native ones."""
    sign_in_through_gate(client, OWNER)
    response = client.get("/api/workspaces")
    assert response.status_code == 200
    assert response.json() == {"workspaces": []}


def test_the_list_body_is_an_envelope_not_a_bare_array(client: TestClient) -> None:
    """The envelope is the contract the frontend reads, so it is pinned here."""
    sign_in(client, OWNER)
    body = client.get("/api/workspaces").json()
    assert isinstance(body, dict)
    assert list(body) == ["workspaces"]


def test_a_caller_sees_every_workspace_they_belong_to(client: TestClient, repositories: Any) -> None:
    """Membership, not ownership, is what puts a workspace in the list.

    The member is not the owner of either row, so an owner-based read would
    answer nothing and this is what catches that regression.
    """
    make_workspace(repositories, WORKSPACE, "mine", OWNER)
    make_workspace(repositories, OTHER_WORKSPACE, "theirs", OWNER)
    add_member(repositories, WORKSPACE, MEMBER, "member")
    sign_in(client, MEMBER)

    body = client.get("/api/workspaces").json()

    assert [row["id"] for row in body["workspaces"]] == [WORKSPACE]
    assert body["workspaces"][0]["role"] == "member"


def test_a_workspace_carries_the_fields_the_frontend_reads(client: TestClient, repositories: Any) -> None:
    """One row's field set, which the frontend `Workspace` type mirrors."""
    make_workspace(repositories, WORKSPACE, "mine", OWNER)
    sign_in(client, OWNER)

    row = client.get("/api/workspaces").json()["workspaces"][0]

    assert set(row) == {
        "id",
        "name",
        "slug",
        "plan",
        "created_at",
        "icon_url",
        "role",
        "deletion_scheduled_at",
        "deletion_scheduled_by",
        "purge_after",
        "accent_color",
    }
    assert row["id"] == WORKSPACE
    assert row["plan"] == "free"
    assert row["role"] == "owner"


def test_creating_a_workspace_makes_the_caller_its_owner(client: TestClient, repositories: Any) -> None:
    """A created workspace is immediately readable by its creator."""
    signed_up(repositories, OWNER)
    sign_in(client, OWNER)
    response = client.post("/api/workspaces", json={"name": "Acme", "slug": "acme"})

    assert response.status_code == 201
    assert response.json()["role"] == "owner"
    created = response.json()["id"]
    assert repositories.memberships.get(created, OWNER).role == "owner"


def test_a_duplicate_slug_is_a_conflict(client: TestClient, repositories: Any) -> None:
    """Slug uniqueness is enforced by the conditional write, surfaced as 409."""
    signed_up(repositories, OWNER)
    sign_in(client, OWNER)
    client.post("/api/workspaces", json={"name": "Acme", "slug": "acme"})
    response = client.post("/api/workspaces", json={"name": "Other", "slug": "acme"})

    assert response.status_code == 409


def test_a_bad_slug_is_rejected_before_the_table(client: TestClient) -> None:
    """The alphabet is held at the edge, so a bad slug names the field."""
    sign_in(client, OWNER)
    response = client.post("/api/workspaces", json={"name": "Acme", "slug": "Not A Slug"})
    assert response.status_code == 422


def test_a_non_member_gets_404_not_403(client: TestClient, repositories: Any) -> None:
    """The invariant: a caller outside a workspace cannot probe for its existence.

    A 403 would confirm the workspace is real, so every route inside it answers
    404 to someone who is not a member.
    """
    make_workspace(repositories, WORKSPACE, "mine", OWNER)
    sign_in(client, OUTSIDER)

    assert client.get(f"/api/workspaces/{WORKSPACE}").status_code == 404
    assert client.get(f"/api/workspaces/{WORKSPACE}/members").status_code == 404
    assert client.patch(f"/api/workspaces/{WORKSPACE}", json={"name": "x"}).status_code == 404


def test_a_member_cannot_rename_a_workspace(client: TestClient, repositories: Any) -> None:
    """Renaming is admin work, so a plain member is refused rather than 404."""
    make_workspace(repositories, WORKSPACE, "mine", OWNER)
    add_member(repositories, WORKSPACE, MEMBER, "member")
    sign_in(client, MEMBER)

    assert client.patch(f"/api/workspaces/{WORKSPACE}", json={"name": "x"}).status_code == 403


def test_an_admin_renames_and_schedules_deletion_but_a_member_does_neither(
    client: TestClient, repositories: Any
) -> None:
    """The capability split the contract states: deletion is an admin's, never a member's."""
    make_workspace(repositories, WORKSPACE, "mine", OWNER)
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")

    sign_in(client, MEMBER)
    assert client.patch(f"/api/workspaces/{WORKSPACE}", json={"name": "New"}).status_code == 403
    assert client.post(f"/api/workspaces/{WORKSPACE}/deletion", json={"confirm_name": "mine"}).status_code == 403

    sign_in(client, ADMIN)
    assert client.patch(f"/api/workspaces/{WORKSPACE}", json={"name": "New"}).status_code == 200
    assert client.post(f"/api/workspaces/{WORKSPACE}/deletion", json={"confirm_name": "New"}).status_code == 200


def test_an_admin_sets_and_resets_the_accent_color(client: TestClient, repositories: Any) -> None:
    """The accent is normalised on the way in, survives a rename, and null returns to the default."""
    make_workspace(repositories, WORKSPACE, "mine", OWNER)
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    sign_in(client, ADMIN)

    assert client.get(f"/api/workspaces/{WORKSPACE}").json()["accent_color"] is None
    set_response = client.patch(f"/api/workspaces/{WORKSPACE}", json={"accent_color": " 1F7AE0 "})
    assert set_response.status_code == 200
    assert set_response.json()["accent_color"] == "#1f7ae0"

    renamed = client.patch(f"/api/workspaces/{WORKSPACE}", json={"name": "Renamed"}).json()
    assert renamed["name"] == "Renamed"
    assert renamed["accent_color"] == "#1f7ae0"

    reset = client.patch(f"/api/workspaces/{WORKSPACE}", json={"accent_color": None}).json()
    assert reset["accent_color"] is None
    assert repositories.workspaces.get(WORKSPACE).accent_color is None

    sign_in(client, MEMBER)
    assert client.patch(f"/api/workspaces/{WORKSPACE}", json={"accent_color": "#123456"}).status_code == 403


@pytest.mark.parametrize("value", ["blue", "#12345", "#1234567", "#ggg000", "rgb(1,2,3)", ""])
def test_a_bad_accent_color_is_rejected(client: TestClient, repositories: Any, value: str) -> None:
    """Only a six digit hex color reaches the table, so the frontend never paints garbage."""
    make_workspace(repositories, WORKSPACE, "mine", OWNER)
    sign_in(client, OWNER)

    assert client.patch(f"/api/workspaces/{WORKSPACE}", json={"accent_color": value}).status_code == 422
    assert repositories.workspaces.get(WORKSPACE).accent_color is None


def test_members_are_listed_with_their_user_rows(client: TestClient, repositories: Any) -> None:
    """A member list joins the membership with the user row for display."""
    make_workspace(repositories, WORKSPACE, "mine", OWNER)
    make_user(repositories, OWNER, "owner@example.com", "Ada")
    sign_in(client, OWNER)

    members = client.get(f"/api/workspaces/{WORKSPACE}/members").json()["members"]

    assert len(members) == 1
    assert members[0]["user_id"] == OWNER
    assert members[0]["email"] == "owner@example.com"
    assert members[0]["display_name"] == "Ada"
    assert members[0]["role"] == "owner"


def test_only_an_owner_may_grant_ownership(client: TestClient, repositories: Any) -> None:
    """An admin manages members but cannot make one an owner."""
    make_workspace(repositories, WORKSPACE, "mine", OWNER)
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    sign_in(client, ADMIN)

    response = client.patch(f"/api/workspaces/{WORKSPACE}/members/{MEMBER}", json={"role": "owner"})

    assert response.status_code == 403


def test_the_last_owner_cannot_be_demoted(client: TestClient, repositories: Any) -> None:
    """A workspace with no owner could never be deleted or transferred again."""
    make_workspace(repositories, WORKSPACE, "mine", OWNER)
    sign_in(client, OWNER)

    response = client.patch(f"/api/workspaces/{WORKSPACE}/members/{OWNER}", json={"role": "admin"})

    assert response.status_code == 409


def test_the_last_owner_cannot_leave(client: TestClient, repositories: Any) -> None:
    """The invariant design section 2 names, asserted on the delete path too."""
    make_workspace(repositories, WORKSPACE, "mine", OWNER)
    sign_in(client, OWNER)

    response = client.delete(f"/api/workspaces/{WORKSPACE}/members/{OWNER}")

    assert response.status_code == 409
    assert repositories.memberships.get(WORKSPACE, OWNER) is not None


def test_an_owner_may_leave_once_another_owner_exists(client: TestClient, repositories: Any) -> None:
    """The last-owner rule counts owners, so a second one releases the first."""
    make_workspace(repositories, WORKSPACE, "mine", OWNER)
    add_member(repositories, WORKSPACE, ADMIN, "owner")
    sign_in(client, OWNER)

    assert client.delete(f"/api/workspaces/{WORKSPACE}/members/{OWNER}").status_code == 204
    assert repositories.memberships.get(WORKSPACE, OWNER) is None


def test_a_member_may_leave_but_not_remove_someone_else(client: TestClient, repositories: Any) -> None:
    """Leaving is a member's own right; removing another is admin work."""
    make_workspace(repositories, WORKSPACE, "mine", OWNER)
    add_member(repositories, WORKSPACE, MEMBER, "member")
    add_member(repositories, WORKSPACE, GUEST, "guest")
    sign_in(client, MEMBER)

    assert client.delete(f"/api/workspaces/{WORKSPACE}/members/{GUEST}").status_code == 403
    assert client.delete(f"/api/workspaces/{WORKSPACE}/members/{MEMBER}").status_code == 204


def test_an_invite_returns_its_token_exactly_once(client: TestClient, repositories: Any) -> None:
    """The create response is the only readable form of the token.

    Only the hash is stored, so the list route must never carry one back.
    """
    make_workspace(repositories, WORKSPACE, "mine", OWNER)
    sign_in(client, OWNER)

    created = client.post(
        f"/api/workspaces/{WORKSPACE}/invites",
        json={"email": "new@example.com", "role": "member"},
    )
    assert created.status_code == 201
    assert created.json()["token"]

    listed = client.get(f"/api/workspaces/{WORKSPACE}/invites").json()["invites"]
    assert len(listed) == 1
    assert "token" not in listed[0]


def test_an_invite_cannot_grant_ownership(client: TestClient, repositories: Any) -> None:
    """Ownership is granted to an existing member, never to an email address."""
    make_workspace(repositories, WORKSPACE, "mine", OWNER)
    sign_in(client, OWNER)

    response = client.post(
        f"/api/workspaces/{WORKSPACE}/invites",
        json={"email": "new@example.com", "role": "owner"},
    )

    assert response.status_code == 422


def test_a_member_cannot_read_or_create_invites(client: TestClient, repositories: Any) -> None:
    """Invites are admin work, so a member is refused both ways."""
    make_workspace(repositories, WORKSPACE, "mine", OWNER)
    add_member(repositories, WORKSPACE, MEMBER, "member")
    sign_in(client, MEMBER)

    assert client.get(f"/api/workspaces/{WORKSPACE}/invites").status_code == 403
    assert (
        client.post(
            f"/api/workspaces/{WORKSPACE}/invites",
            json={"email": "x@example.com", "role": "member"},
        ).status_code
        == 403
    )


def test_accepting_an_invite_creates_the_membership(client: TestClient, repositories: Any) -> None:
    """The token turns into a membership carrying the invited role."""
    make_workspace(repositories, WORKSPACE, "mine", OWNER)
    sign_in(client, OWNER)
    token = client.post(
        f"/api/workspaces/{WORKSPACE}/invites",
        json={"email": "new@example.com", "role": "guest"},
    ).json()["token"]

    signed_up(repositories, OUTSIDER)
    sign_in(client, OUTSIDER)
    response = client.post("/api/invites/accept", json={"token": token})

    assert response.status_code == 201
    assert response.json()["role"] == "guest"
    assert repositories.memberships.get(WORKSPACE, OUTSIDER).role == "guest"


def test_accepting_twice_is_idempotent_for_an_existing_member(client: TestClient, repositories: Any) -> None:
    """A second accept answers the existing membership rather than failing.

    The contract calls the route idempotent for an existing member, so a client
    retrying a request never sees an error it cannot act on.
    """
    make_workspace(repositories, WORKSPACE, "mine", OWNER)
    add_member(repositories, WORKSPACE, MEMBER, "member")
    sign_in(client, OWNER)
    token = client.post(
        f"/api/workspaces/{WORKSPACE}/invites",
        json={"email": "member@example.com", "role": "guest"},
    ).json()["token"]

    signed_up(repositories, MEMBER)
    sign_in(client, MEMBER)
    response = client.post("/api/invites/accept", json={"token": token})

    assert response.status_code == 201
    assert response.json()["role"] == "member"


def test_an_unknown_token_is_refused(client: TestClient, repositories: Any) -> None:
    """An unknown and an expired token answer alike, so neither can be probed."""
    signed_up(repositories, OUTSIDER)
    sign_in(client, OUTSIDER)
    response = client.post("/api/invites/accept", json={"token": "not-a-real-token"})

    assert response.status_code == 400
    assert response.json()["error_code"] == "INVALID_INVITE"


def test_accepting_an_invite_needs_a_signed_in_caller(client: TestClient) -> None:
    """The route has no workspace in its path, so it still fails closed."""
    response = client.post("/api/invites/accept", json={"token": "anything"})
    assert response.status_code == 401


@pytest.fixture
def recorder() -> Iterator[Any]:
    """A recording sender installed as the process-wide one for one test."""
    from webbpulse.identity.email import RecordingEmailSender

    from app.common.email import reset_email_sender

    sender = RecordingEmailSender()
    reset_email_sender(sender)
    yield sender
    reset_email_sender(None)


def test_an_invite_mails_the_accept_link(client: TestClient, repositories: Any, recorder: Any) -> None:
    """The invited address gets the link, and the token still comes back too.

    Mail is the convenient path, not the only one. An owner who can see the token
    can always hand it over themselves, which is what keeps the flow working while
    the account is still in the SES sandbox.
    """
    from app.common.core.config import settings

    make_workspace(repositories, WORKSPACE, "mine", OWNER)
    sign_in(client, OWNER)

    created = client.post(
        f"/api/workspaces/{WORKSPACE}/invites",
        json={"email": "new@example.com", "role": "member"},
    )

    assert created.status_code == 201
    token = created.json()["token"]
    assert token

    assert [message.to for message in recorder.sent] == ["new@example.com"]
    sent = recorder.sent[0]
    assert "Mine" in sent.subject
    assert f"{settings.frontend_base_url}/invites/accept?token={token}" in sent.text
    assert "—" not in sent.text and "—" not in sent.html


def test_an_invite_stands_when_the_mail_fails(client: TestClient, repositories: Any) -> None:
    """SES being down must not cost the owner the invite they just created."""
    from webbpulse.identity.email import RecordingEmailSender

    from app.common.email import reset_email_sender

    reset_email_sender(RecordingEmailSender(fail=True))
    try:
        make_workspace(repositories, WORKSPACE, "mine", OWNER)
        sign_in(client, OWNER)

        created = client.post(
            f"/api/workspaces/{WORKSPACE}/invites",
            json={"email": "new@example.com", "role": "member"},
        )
    finally:
        reset_email_sender(None)

    assert created.status_code == 201
    assert created.json()["token"]
    assert len(client.get(f"/api/workspaces/{WORKSPACE}/invites").json()["invites"]) == 1


def test_inviting_past_the_member_limit_is_refused(
    client: TestClient, repositories: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An invite is refused up front when the workspace already holds its member limit."""
    from app.common.plan_limits import PLAN_LIMIT_REACHED, PREVIEW_FREE_LIMITS, LimitedResource

    monkeypatch.setitem(PREVIEW_FREE_LIMITS, LimitedResource.MEMBERS, 1)
    make_workspace(repositories, WORKSPACE, "mine", OWNER)
    sign_in(client, OWNER)

    response = client.post(f"/api/workspaces/{WORKSPACE}/invites", json={"email": "new@example.com", "role": "member"})

    assert response.status_code == 403
    assert response.json()["error_code"] == PLAN_LIMIT_REACHED
    assert repositories.invites.list_for_workspace(WORKSPACE) == []


def test_inviting_past_the_pending_invite_limit_is_refused(
    client: TestClient, repositories: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Pending invites have their own limit, so one admin cannot mint them without bound."""
    from app.common.plan_limits import PLAN_LIMIT_REACHED, PREVIEW_FREE_LIMITS, LimitedResource

    monkeypatch.setitem(PREVIEW_FREE_LIMITS, LimitedResource.INVITES, 1)
    make_workspace(repositories, WORKSPACE, "mine", OWNER)
    sign_in(client, OWNER)
    path = f"/api/workspaces/{WORKSPACE}/invites"
    assert client.post(path, json={"email": "one@example.com", "role": "member"}).status_code == 201

    response = client.post(path, json={"email": "two@example.com", "role": "member"})

    assert response.status_code == 403
    assert response.json()["details"]["resource"] == "invites"
    assert response.json()["error_code"] == PLAN_LIMIT_REACHED


def test_accepting_an_invite_past_the_member_limit_is_refused(
    client: TestClient, repositories: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An invite minted before the workspace filled up cannot push it past its limit."""
    from app.common.plan_limits import PLAN_LIMIT_REACHED, PREVIEW_FREE_LIMITS, LimitedResource

    make_workspace(repositories, WORKSPACE, "mine", OWNER)
    sign_in(client, OWNER)
    token = client.post(
        f"/api/workspaces/{WORKSPACE}/invites",
        json={"email": "new@example.com", "role": "member"},
    ).json()["token"]
    monkeypatch.setitem(PREVIEW_FREE_LIMITS, LimitedResource.MEMBERS, 1)

    signed_up(repositories, OUTSIDER)
    sign_in(client, OUTSIDER)
    response = client.post("/api/invites/accept", json={"token": token})

    assert response.status_code == 403
    assert response.json()["error_code"] == PLAN_LIMIT_REACHED
    assert repositories.memberships.get(WORKSPACE, OUTSIDER) is None


def test_a_deleted_account_cannot_create_or_join(client: TestClient, repositories: Any) -> None:
    """A token issued before its account was deleted, or purged, neither creates nor joins a workspace."""
    make_workspace(repositories, WORKSPACE, "mine", OWNER)
    sign_in(client, OWNER)
    token = client.post(
        f"/api/workspaces/{WORKSPACE}/invites",
        json={"email": "new@example.com", "role": "member"},
    ).json()["token"]
    signed_up(repositories, OUTSIDER)
    repositories.users.mark_deleted(OUTSIDER)

    for subject in (OUTSIDER, GUEST):
        sign_in(client, subject)
        created = client.post("/api/workspaces", json={"name": "Gone", "slug": "gone"})
        joined = client.post("/api/invites/accept", json={"token": token})
        assert (created.status_code, joined.status_code) == (401, 401)
        assert created.json()["error_code"] == "ACCOUNT_DELETED"

    assert repositories.memberships.get(WORKSPACE, OUTSIDER) is None


def test_a_guest_invite_past_the_guest_allowance_is_refused(
    client: TestClient, repositories: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A pending guest invite holds a guest place, so a second one past the allowance is refused."""
    from app.common import plan_limits

    monkeypatch.setattr(plan_limits, "PREVIEW_FREE_GUESTS_PER_SEAT", 1)
    make_workspace(repositories, WORKSPACE, "mine", OWNER)
    sign_in(client, OWNER)
    path = f"/api/workspaces/{WORKSPACE}/invites"
    assert client.post(path, json={"email": "one@example.com", "role": "guest"}).status_code == 201

    refused = client.post(path, json={"email": "two@example.com", "role": "guest"})
    member = client.post(path, json={"email": "three@example.com", "role": "member"})

    assert refused.status_code == 403
    assert refused.json()["error_code"] == plan_limits.PLAN_LIMIT_REACHED
    assert refused.json()["details"]["resource"] == "guests"
    assert member.status_code == 201


def test_demoting_a_member_to_guest_respects_the_guest_allowance(
    client: TestClient, repositories: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The demoted member gives up a seat, so the allowance is judged without it."""
    from app.common import plan_limits

    monkeypatch.setattr(plan_limits, "PREVIEW_FREE_GUESTS_PER_SEAT", 1)
    make_workspace(repositories, WORKSPACE, "mine", OWNER)
    signed_up(repositories, OWNER, MEMBER, GUEST)
    add_member(repositories, WORKSPACE, MEMBER, "member")
    add_member(repositories, WORKSPACE, GUEST, "guest")
    sign_in(client, OWNER)

    response = client.patch(f"/api/workspaces/{WORKSPACE}/members/{MEMBER}", json={"role": "guest"})

    assert response.status_code == 403
    assert response.json()["details"]["resource"] == "guests"
    assert repositories.memberships.get(WORKSPACE, MEMBER).role == "member"


def test_accepting_a_guest_invite_past_the_allowance_is_refused(
    client: TestClient, repositories: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A guest invite minted before the guest places filled cannot push past them."""
    from app.common import plan_limits

    make_workspace(repositories, WORKSPACE, "mine", OWNER)
    signed_up(repositories, GUEST)
    add_member(repositories, WORKSPACE, GUEST, "guest")
    sign_in(client, OWNER)
    token = client.post(
        f"/api/workspaces/{WORKSPACE}/invites",
        json={"email": "new@example.com", "role": "guest"},
    ).json()["token"]
    monkeypatch.setattr(plan_limits, "PREVIEW_FREE_GUESTS_PER_SEAT", 1)

    signed_up(repositories, OUTSIDER)
    sign_in(client, OUTSIDER)
    response = client.post("/api/invites/accept", json={"token": token})

    assert response.status_code == 403
    assert response.json()["details"]["resource"] == "guests"
    assert repositories.memberships.get(WORKSPACE, OUTSIDER) is None


def test_an_admin_sets_the_project_update_cadence(client: TestClient, repositories: Any) -> None:
    """The default cadence starts weekly, an admin changes it alone, and only the offered values are taken."""
    make_workspace(repositories, WORKSPACE, "mine", OWNER)
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    path = f"/api/workspaces/{WORKSPACE}"

    sign_in(client, MEMBER)
    assert client.get(path).json()["project_update_interval_days"] == 7
    assert client.patch(path, json={"project_update_interval_days": 14}).status_code == 403

    sign_in(client, ADMIN)
    response = client.patch(path, json={"project_update_interval_days": 14})
    assert response.status_code == 200
    assert response.json()["project_update_interval_days"] == 14
    assert response.json()["name"] == "mine"
    assert client.patch(path, json={"project_update_interval_days": 10}).status_code == 422
    assert client.patch(path, json={"project_update_interval_days": 0}).json()["project_update_interval_days"] == 0
