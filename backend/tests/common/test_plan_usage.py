"""The plan usage counters: the lazy backfill, the recount, every path that frees a slot, guests, and the race.

Each workspace keeps one usage row per capped resource, moved in the same
transaction as the row that takes or frees the slot. These hold that the row is
seeded once from a real count, that every create and every freeing path moves it
by exactly one, that guests ride on the members and invites rows, and that two
creates racing for the last slot land exactly one.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any, Iterator, cast

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from webbpulse.identity.api_keys import mint

from app.common import plan_limits, plan_usage
from app.common.api.schemas.teams import TeamCreate
from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.counters import CounterRepository, PlanUsage
from app.common.db.dynamo.github import WebhookEndpoint, new_webhook_id, webhook_key
from app.common.db.dynamo.invites import Invite, hash_token, new_invite_token
from app.common.plan_limits import PLAN_LIMIT_REACHED, PREVIEW_FREE_LIMITS, LimitedResource
from app.common.team_writes import create_team, delete_team
from tests.domains.helpers import (
    ADMIN,
    GUEST,
    MEMBER,
    OUTSIDER,
    OWNER,
    add_member,
    add_team_member,
    make_team,
    make_user,
    make_workspace,
    sign_in,
)

WORKSPACE = "01JB00000000000000000000WS"

TEAM = "01JB000000000000000000PRJ1"

OTHER_TEAM = "01JB000000000000000000PRJ2"

OUTSIDER_EMAIL = f"{OUTSIDER.lower()}@example.com"


@pytest.fixture
def workspace(repositories: Any) -> str:
    """A free workspace with its owner as the only member."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    return WORKSPACE


@pytest.fixture
def client(repositories: Any, workspace: str) -> Iterator[TestClient]:
    """A client for the workspaces application, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["workspaces"])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


def signed_up(repositories: Any, *user_ids: str) -> None:
    """Give each caller the verified user row sign up writes, which joining requires."""
    for user_id in user_ids:
        make_user(repositories, user_id, f"{user_id.lower()}@example.com")
        repositories.users.update(user_id, email_verified=True)


def held(repositories: Any, resource: LimitedResource) -> tuple[int, int]:
    """The usage row's total and guest share for one resource, seeding it if needed."""
    row = plan_usage.usage(repositories, WORKSPACE, resource)
    return row.used, row.guests


def row_of(repositories: Any, resource: LimitedResource) -> PlanUsage:
    """The stored usage row, failing when it was never seeded."""
    row = repositories.counters.plan_usage(WORKSPACE, resource.value)
    assert row is not None
    return cast(PlanUsage, row)


def row_of_seeded(repositories: Any, resource: LimitedResource) -> PlanUsage:
    """Seed one resource's row from a count and answer it."""
    plan_usage.usage(repositories, WORKSPACE, resource)
    return row_of(repositories, resource)


def endpoint(team_id: str | None = None) -> WebhookEndpoint:
    """One outbound endpoint row, workspace wide unless a team is named."""
    webhook_id = new_webhook_id()
    return WebhookEndpoint(
        workspace_id=WORKSPACE,
        github_key=webhook_key(webhook_id),
        webhook_id=webhook_id,
        url="https://example.test/hook",
        team_id=team_id,
        resource_types=["issues"],
        created_by=ADMIN,
        created_at=utc_now(),
        updated_at=utc_now(),
    )


def add_webhook(repositories: Any, team_id: str | None = None) -> str:
    """Create one endpoint the way the route does, taking its slot, and answer its id."""
    row = endpoint(team_id)
    plan_usage.commit(
        repositories,
        WORKSPACE,
        [repositories.github.create_endpoint_action(row)],
        [plan_usage.Delta(LimitedResource.WEBHOOKS, 1)],
    )
    return row.webhook_id


def add_key(repositories: Any, user_id: str = MEMBER) -> Any:
    """Mint one key the way the route does, taking its slot, and answer its record."""
    minted = mint(user_id=user_id, tenant_id=WORKSPACE, scopes=["issues:read"], name="A key", created_by=user_id)
    plan_usage.commit(
        repositories,
        WORKSPACE,
        [repositories.api_keys.put_action(minted.record)],
        [plan_usage.Delta(LimitedResource.API_KEYS, 1)],
    )
    return minted.record


def store_invite(repositories: Any, email: str, role: str = "member", *, expired: bool = False) -> Invite:
    """Store one invite row directly, optionally already past its expiry."""
    row = Invite(
        workspace_id=WORKSPACE,
        email=email,
        role=role,
        invited_by=OWNER,
        token_hash=hash_token(new_invite_token()),
    )
    if expired:
        row.expires_at = utc_now() - timedelta(days=1)
    return cast(Invite, repositories.invites.create(row))


def refused(caught: pytest.ExceptionInfo[HTTPException]) -> dict[str, Any]:
    """The plan refusal's body, failing unless it is the stable 403."""
    assert caught.value.status_code == 403
    detail = cast(dict[str, Any], caught.value.detail)
    assert detail["error_code"] == PLAN_LIMIT_REACHED
    return detail


def test_the_first_write_seeds_the_row_from_a_count_once(repositories: Any, workspace: str) -> None:
    """The backfill is lazy and idempotent: a second seed never overwrites a counted row."""
    add_member(repositories, WORKSPACE, MEMBER, "member")
    add_member(repositories, WORKSPACE, GUEST, "guest")

    assert held(repositories, LimitedResource.MEMBERS) == (3, 1)
    assert repositories.counters.seed_plan_usage(WORKSPACE, LimitedResource.MEMBERS.value, 99) is False
    assert held(repositories, LimitedResource.MEMBERS) == (3, 1)


def test_each_count_reads_only_the_rows_that_hold_a_slot(repositories: Any, workspace: str) -> None:
    """Deleting teams, team memberships, expired invites and revoked keys hold no slot."""
    make_team(repositories, WORKSPACE, TEAM, "APO")
    make_team(repositories, WORKSPACE, OTHER_TEAM, "GEM")
    repositories.teams.mark_deleting(WORKSPACE, OTHER_TEAM)
    add_team_member(repositories, WORKSPACE, TEAM, MEMBER, "member")
    store_invite(repositories, "one@example.com", "guest")
    store_invite(repositories, "old@example.com", expired=True)
    repositories.github.create_endpoint(endpoint())
    repositories.github.create_endpoint(endpoint(TEAM))
    mint(user_id=MEMBER, tenant_id=WORKSPACE, scopes=["issues:read"], store=repositories.api_keys)
    gone = mint(user_id=MEMBER, tenant_id=WORKSPACE, scopes=["issues:read"], store=repositories.api_keys)
    repositories.api_keys.revoke_by_id(WORKSPACE, gone.record.key_id)

    assert plan_usage.count(repositories, WORKSPACE, LimitedResource.TEAMS) == (1, 0)
    assert plan_usage.count(repositories, WORKSPACE, LimitedResource.MEMBERS) == (1, 0)
    assert plan_usage.count(repositories, WORKSPACE, LimitedResource.INVITES) == (1, 1)
    assert plan_usage.count(repositories, WORKSPACE, LimitedResource.WEBHOOKS) == (2, 0)
    assert plan_usage.count(repositories, WORKSPACE, LimitedResource.API_KEYS) == (1, 0)


def test_a_refusal_recounts_a_drifted_row_before_it_stands(
    repositories: Any, workspace: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A row left high by a path that does not count heals the moment it would wrongly refuse."""
    monkeypatch.setitem(PREVIEW_FREE_LIMITS, LimitedResource.TEAMS, 2)
    make_team(repositories, WORKSPACE, TEAM, "APO")
    seen = row_of_seeded(repositories, LimitedResource.TEAMS)
    assert repositories.counters.reconcile_plan_usage(WORKSPACE, LimitedResource.TEAMS.value, seen, 2, 0)

    create_team(repositories, WORKSPACE, OWNER, TeamCreate(name="Gemini", key_prefix="GEM"))

    assert held(repositories, LimitedResource.TEAMS) == (2, 0)
    with pytest.raises(HTTPException) as caught:
        create_team(repositories, WORKSPACE, OWNER, TeamCreate(name="Mercury", key_prefix="MER"))
    assert refused(caught)["details"]["resource"] == "teams"


def test_two_racing_creates_at_the_last_slot_land_exactly_one(
    repositories: Any, workspace: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A create that read the row before a rival took the last slot is refused, not let through."""
    monkeypatch.setitem(PREVIEW_FREE_LIMITS, LimitedResource.TEAMS, 2)
    make_team(repositories, WORKSPACE, TEAM, "APO")
    plan_usage.usage(repositories, WORKSPACE, LimitedResource.TEAMS)
    original = CounterRepository.plan_usage
    raced: list[bool] = []

    def stale_then_race(self: CounterRepository, workspace_id: str, resource: str) -> PlanUsage | None:
        """Read the row, let a rival create land, then answer the stale read."""
        snapshot = original(self, workspace_id, resource)
        if not raced:
            raced.append(True)
            create_team(repositories, WORKSPACE, OWNER, TeamCreate(name="Gemini", key_prefix="GEM"))
        return snapshot

    monkeypatch.setattr(CounterRepository, "plan_usage", stale_then_race)

    with pytest.raises(HTTPException) as caught:
        create_team(repositories, WORKSPACE, OWNER, TeamCreate(name="Mercury", key_prefix="MER"))

    assert raced == [True]
    assert refused(caught)["details"] == {"resource": "teams", "limit": 2, "plan": "free"}
    assert repositories.teams.get_by_key_prefix(WORKSPACE, "GEM") is not None
    assert repositories.teams.get_by_key_prefix(WORKSPACE, "MER") is None
    assert repositories.teams.count_live(WORKSPACE) == 2
    assert row_of(repositories, LimitedResource.TEAMS).used == 2


def test_deleting_a_team_frees_its_slot_once(repositories: Any, workspace: str) -> None:
    """The tombstone and the decrement land together, so a repeated delete frees nothing more."""
    team = create_team(repositories, WORKSPACE, OWNER, TeamCreate(name="Gemini", key_prefix="GEM"))
    assert held(repositories, LimitedResource.TEAMS) == (1, 0)

    assert delete_team(repositories, WORKSPACE, team.team_id) is True
    assert held(repositories, LimitedResource.TEAMS) == (0, 0)

    delete_team(repositories, WORKSPACE, team.team_id)
    assert held(repositories, LimitedResource.TEAMS) == (0, 0)


def test_removing_a_member_frees_their_slot_and_guest_share(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """A removed guest gives back both the seat count and the guest share."""
    signed_up(repositories, OWNER, MEMBER, GUEST)
    add_member(repositories, WORKSPACE, MEMBER, "member")
    add_member(repositories, WORKSPACE, GUEST, "guest")
    assert held(repositories, LimitedResource.MEMBERS) == (3, 1)
    sign_in(client, OWNER)

    assert client.delete(f"/api/workspaces/{WORKSPACE}/members/{GUEST}").status_code == 204
    assert held(repositories, LimitedResource.MEMBERS) == (2, 0)

    assert client.delete(f"/api/workspaces/{WORKSPACE}/members/{MEMBER}").status_code == 204
    assert held(repositories, LimitedResource.MEMBERS) == (1, 0)
    assert client.delete(f"/api/workspaces/{WORKSPACE}/members/{MEMBER}").status_code == 404
    assert held(repositories, LimitedResource.MEMBERS) == (1, 0)


def test_a_role_change_moves_only_the_guest_share(client: TestClient, repositories: Any, workspace: str) -> None:
    """Becoming a guest and back changes who is a guest, never how many people there are."""
    signed_up(repositories, OWNER, MEMBER)
    add_member(repositories, WORKSPACE, MEMBER, "member")
    sign_in(client, OWNER)
    path = f"/api/workspaces/{WORKSPACE}/members/{MEMBER}"

    assert client.patch(path, json={"role": "guest"}).status_code == 200
    assert held(repositories, LimitedResource.MEMBERS) == (2, 1)

    assert client.patch(path, json={"role": "admin"}).status_code == 200
    assert held(repositories, LimitedResource.MEMBERS) == (2, 0)


def test_revoking_an_invite_frees_its_pending_slot(client: TestClient, repositories: Any, workspace: str) -> None:
    """An invite takes a pending slot when made and gives it back when revoked, guest share included."""
    signed_up(repositories, OWNER)
    sign_in(client, OWNER)
    created = client.post(f"/api/workspaces/{WORKSPACE}/invites", json={"email": "one@example.com", "role": "guest"})
    assert created.status_code == 201
    assert held(repositories, LimitedResource.INVITES) == (1, 1)

    path = f"/api/workspaces/{WORKSPACE}/invites/{created.json()['invite_id']}"
    assert client.delete(path).status_code == 204
    assert held(repositories, LimitedResource.INVITES) == (0, 0)
    client.delete(path)
    assert held(repositories, LimitedResource.INVITES) == (0, 0)


def test_revoking_an_expired_invite_leaves_the_row_alone(repositories: Any, workspace: str) -> None:
    """An expired invite was already counted out, so deleting it frees nothing a second time."""
    store_invite(repositories, "live@example.com")
    old = store_invite(repositories, "old@example.com", expired=True)
    assert held(repositories, LimitedResource.INVITES) == (1, 0)

    assert plan_usage.delete_invite(repositories, WORKSPACE, old.invite_id) is not None
    assert held(repositories, LimitedResource.INVITES) == (1, 0)


def test_accepting_a_guest_invite_moves_it_from_invites_to_members(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """Acceptance frees the pending slot and takes a member slot in one transaction, guest share with it."""
    signed_up(repositories, OWNER, OUTSIDER)
    sign_in(client, OWNER)
    token = client.post(
        f"/api/workspaces/{WORKSPACE}/invites", json={"email": OUTSIDER_EMAIL, "role": "guest"}
    ).json()["token"]
    assert held(repositories, LimitedResource.INVITES) == (1, 1)
    assert held(repositories, LimitedResource.MEMBERS) == (1, 0)

    sign_in(client, OUTSIDER)
    assert client.post("/api/invites/accept", json={"token": token}).status_code in (200, 201)

    assert held(repositories, LimitedResource.INVITES) == (0, 0)
    assert held(repositories, LimitedResource.MEMBERS) == (2, 1)


def test_an_existing_member_accepting_only_frees_the_invite(
    client: TestClient, repositories: Any, workspace: str
) -> None:
    """Someone already in the workspace takes no second seat, and the invite still goes."""
    signed_up(repositories, OWNER, OUTSIDER)
    sign_in(client, OWNER)
    token = client.post(
        f"/api/workspaces/{WORKSPACE}/invites", json={"email": OUTSIDER_EMAIL, "role": "member"}
    ).json()["token"]
    add_member(repositories, WORKSPACE, OUTSIDER, "member")
    assert held(repositories, LimitedResource.MEMBERS) == (1, 0)

    sign_in(client, OUTSIDER)
    client.post("/api/invites/accept", json={"token": token})

    assert held(repositories, LimitedResource.INVITES) == (0, 0)
    assert held(repositories, LimitedResource.MEMBERS) == (1, 0)


def test_a_guest_invite_past_the_allowance_counts_pending_guests(
    client: TestClient, repositories: Any, workspace: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Pending guest invites fill the allowance on the invites row, member invites do not."""
    monkeypatch.setattr(plan_limits, "PREVIEW_FREE_GUESTS_PER_SEAT", 1)
    signed_up(repositories, OWNER)
    sign_in(client, OWNER)
    path = f"/api/workspaces/{WORKSPACE}/invites"

    assert client.post(path, json={"email": "member@example.com", "role": "member"}).status_code == 201
    assert client.post(path, json={"email": "one@example.com", "role": "guest"}).status_code == 201
    second = client.post(path, json={"email": "two@example.com", "role": "guest"})

    assert second.status_code == 403
    assert second.json()["details"]["resource"] == "guests"
    assert held(repositories, LimitedResource.INVITES) == (2, 1)


def test_deleting_a_webhook_frees_its_slot_once(repositories: Any, workspace: str) -> None:
    """The endpoint and its slot go together, so a retried delete answers missing and frees nothing."""
    webhook_id = add_webhook(repositories)
    assert held(repositories, LimitedResource.WEBHOOKS) == (1, 0)

    assert plan_usage.delete_webhook(repositories, WORKSPACE, webhook_id) is True
    assert plan_usage.delete_webhook(repositories, WORKSPACE, webhook_id) is False
    assert held(repositories, LimitedResource.WEBHOOKS) == (0, 0)


def test_a_team_purge_frees_only_that_teams_webhooks(repositories: Any, workspace: str) -> None:
    """The team's endpoints go with it, each freeing a slot, while a workspace endpoint stays."""
    add_webhook(repositories)
    add_webhook(repositories, TEAM)
    add_webhook(repositories, TEAM)
    add_webhook(repositories, OTHER_TEAM)

    assert plan_usage.delete_team_webhooks(repositories, WORKSPACE, TEAM) == 2
    assert held(repositories, LimitedResource.WEBHOOKS) == (2, 0)


def test_revoking_an_api_key_frees_its_slot_once(client: TestClient, repositories: Any, workspace: str) -> None:
    """The route mints under the counter and a revoke frees the slot, a repeated revoke nothing more."""
    signed_up(repositories, OWNER)
    sign_in(client, OWNER)
    created = client.post(f"/api/workspaces/{WORKSPACE}/api-keys", json={"name": "A key", "scopes": ["issues:read"]})
    assert created.status_code == 201
    assert held(repositories, LimitedResource.API_KEYS) == (1, 0)

    path = f"/api/workspaces/{WORKSPACE}/api-keys/{created.json()['key_id']}"
    assert client.delete(path).status_code == 204
    assert client.delete(path).status_code == 204
    assert held(repositories, LimitedResource.API_KEYS) == (0, 0)


def test_minting_past_the_key_limit_is_refused(
    repositories: Any, workspace: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The conditional increment refuses the key past the plan's limit and stores nothing."""
    monkeypatch.setitem(PREVIEW_FREE_LIMITS, LimitedResource.API_KEYS, 1)
    add_key(repositories)

    with pytest.raises(HTTPException) as caught:
        add_key(repositories)

    assert refused(caught)["details"]["resource"] == "api_keys"
    assert plan_usage.count(repositories, WORKSPACE, LimitedResource.API_KEYS) == (1, 0)


def test_an_account_purge_releases_the_persons_keys_and_seat(repositories: Any, workspace: str) -> None:
    """A departing person's live keys and membership each free their slot, and their revoked keys go too."""
    add_member(repositories, WORKSPACE, MEMBER, "member")
    add_key(repositories, MEMBER)
    revoked = add_key(repositories, MEMBER)
    add_key(repositories, OWNER)
    assert plan_usage.revoke_api_key(repositories, WORKSPACE, revoked.key_hash) is True
    assert held(repositories, LimitedResource.API_KEYS) == (2, 0)
    assert held(repositories, LimitedResource.MEMBERS) == (2, 0)

    assert plan_usage.release_user_api_keys(repositories, MEMBER) == 2
    assert plan_usage.remove_membership(repositories, WORKSPACE, MEMBER) is not None

    assert held(repositories, LimitedResource.API_KEYS) == (1, 0)
    assert held(repositories, LimitedResource.MEMBERS) == (1, 0)
    assert plan_usage.remove_membership(repositories, WORKSPACE, MEMBER) is None
    assert held(repositories, LimitedResource.MEMBERS) == (1, 0)


def test_a_freeing_path_never_drives_a_row_below_zero(repositories: Any, workspace: str) -> None:
    """A row that undercounts is clamped at zero rather than refusing the delete."""
    webhook_id = add_webhook(repositories)
    seen = row_of(repositories, LimitedResource.WEBHOOKS)
    assert repositories.counters.reconcile_plan_usage(WORKSPACE, LimitedResource.WEBHOOKS.value, seen, 0, 0)

    assert plan_usage.delete_webhook(repositories, WORKSPACE, webhook_id) is True
    assert held(repositories, LimitedResource.WEBHOOKS) == (0, 0)
