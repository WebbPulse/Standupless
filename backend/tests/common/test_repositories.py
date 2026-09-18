"""The M1 repositories, against real tables in moto.

Driven against real indexes rather than stubs, because the properties that
matter here are the ones only DynamoDB enforces: a conditional write losing a
race, a GSI answering only its own partition, and an atomic counter.
"""

from __future__ import annotations

from typing import Any

import pytest
from webbpulse.dynamodb import ConditionFailed

WORKSPACE = "01JB00000000000000000000WS"

OTHER_WORKSPACE = "01JB0000000000000000000WS2"

PROJECT = "01JB000000000000000000PRJ1"

USER = "01JB000000000000000000USR1"

OTHER_USER = "01JB000000000000000000USR2"


def test_a_slug_is_unique_across_workspaces(repositories: Any) -> None:
    """The second create loses the conditional write rather than overwriting."""
    from app.common.db.dynamo.workspaces import Workspace

    repositories.workspaces.create(Workspace(id=WORKSPACE, name="Acme", slug="acme"))

    with pytest.raises(ConditionFailed):
        repositories.workspaces.create(Workspace(id=OTHER_WORKSPACE, name="Other", slug="acme"))


def test_a_workspace_is_found_by_slug(repositories: Any) -> None:
    """The slug index answers the lookup the create path checks against."""
    from app.common.db.dynamo.workspaces import Workspace

    repositories.workspaces.create(Workspace(id=WORKSPACE, name="Acme", slug="acme"))

    found = repositories.workspaces.get_by_slug("acme")

    assert found is not None
    assert found.id == WORKSPACE


def test_workspaces_for_a_user_span_tenants_but_nothing_else(repositories: Any) -> None:
    """The user index is the one index keyed by user, and it carries only memberships."""
    from app.common.db.dynamo.memberships import Membership, workspace_member_key

    for workspace_id in (WORKSPACE, OTHER_WORKSPACE):
        repositories.memberships.put(
            Membership(
                workspace_id=workspace_id,
                member_key=workspace_member_key(USER),
                user_id=USER,
                role="member",
            )
        )
    repositories.memberships.put(
        Membership(
            workspace_id=WORKSPACE,
            member_key=workspace_member_key(OTHER_USER),
            user_id=OTHER_USER,
            role="member",
        )
    )

    rows = repositories.memberships.list_workspaces_for_user(USER)

    assert {row.workspace_id for row in rows} == {WORKSPACE, OTHER_WORKSPACE}


def test_project_memberships_are_told_apart_from_workspace_ones(repositories: Any) -> None:
    """One table holds both grains, distinguished by the sort key prefix."""
    from app.common.db.dynamo.memberships import (
        Membership,
        project_member_key,
        workspace_member_key,
    )

    repositories.memberships.put(
        Membership(
            workspace_id=WORKSPACE,
            member_key=workspace_member_key(USER),
            user_id=USER,
            role="guest",
        )
    )
    repositories.memberships.put(
        Membership(
            workspace_id=WORKSPACE,
            member_key=project_member_key(PROJECT, USER),
            user_id=USER,
            role="admin",
            project_id=PROJECT,
        )
    )

    assert repositories.memberships.get(WORKSPACE, USER).role == "guest"
    assert repositories.memberships.get_project_membership(WORKSPACE, PROJECT, USER).role == "admin"
    assert [row.user_id for row in repositories.memberships.list_members(WORKSPACE)] == [USER]


def test_owners_are_counted_for_the_last_owner_rule(repositories: Any) -> None:
    """The count the member routes hold the last-owner invariant with."""
    from app.common.db.dynamo.memberships import Membership, workspace_member_key

    repositories.memberships.put(
        Membership(
            workspace_id=WORKSPACE,
            member_key=workspace_member_key(USER),
            user_id=USER,
            role="owner",
        )
    )
    assert repositories.memberships.count_owners(WORKSPACE) == 1

    repositories.memberships.put(
        Membership(
            workspace_id=WORKSPACE,
            member_key=workspace_member_key(OTHER_USER),
            user_id=OTHER_USER,
            role="owner",
        )
    )
    assert repositories.memberships.count_owners(WORKSPACE) == 2


def test_an_invite_is_found_only_by_its_hash(repositories: Any) -> None:
    """The token index is what accept reads, and the raw token is never stored."""
    from app.common.db.dynamo.invites import (
        Invite,
        default_expiry,
        hash_token,
        new_invite_id,
        new_invite_token,
    )

    token = new_invite_token()
    repositories.invites.create(
        Invite(
            workspace_id=WORKSPACE,
            invite_id=new_invite_id(),
            email="new@example.com",
            role="member",
            invited_by=USER,
            token_hash=hash_token(token),
            expires_at=default_expiry(),
        )
    )

    assert repositories.invites.get_by_token_hash(hash_token(token)) is not None
    assert repositories.invites.get_by_token_hash(hash_token("wrong")) is None


def test_an_expired_invite_reports_itself_expired(repositories: Any) -> None:
    """Expiry is checked in the model, because a TTL delete is not prompt."""
    from datetime import datetime, timedelta, timezone

    from app.common.db.dynamo.invites import Invite, hash_token, new_invite_id

    invite = Invite(
        workspace_id=WORKSPACE,
        invite_id=new_invite_id(),
        email="new@example.com",
        role="member",
        invited_by=USER,
        token_hash=hash_token("t"),
        expires_at=datetime.now(timezone.utc) - timedelta(days=1),
    )

    assert invite.is_expired()


def test_a_key_prefix_is_unique_within_a_workspace_only(repositories: Any) -> None:
    """The index hash key is a workspace composite, so two tenants never collide."""
    from app.common.db.dynamo.projects import Project

    repositories.projects.create(Project(workspace_id=WORKSPACE, project_id=PROJECT, name="Apollo", key_prefix="APO"))

    with pytest.raises(ConditionFailed):
        repositories.projects.create(
            Project(workspace_id=WORKSPACE, project_id="other", name="Other", key_prefix="APO")
        )

    other = repositories.projects.create(
        Project(workspace_id=OTHER_WORKSPACE, project_id="other", name="Other", key_prefix="APO")
    )
    assert other.key_prefix == "APO"


def test_a_project_update_leaves_the_key_attributes_alone(repositories: Any) -> None:
    """A SET alias must never collide with the condition's own generated alias.

    Boto3 mints its own `#n0` for an `Attr` condition, so reusing that prefix in
    the SET clause wrote the new value into the wrong attribute entirely.
    """
    from app.common.db.dynamo.projects import Project

    repositories.projects.create(Project(workspace_id=WORKSPACE, project_id=PROJECT, name="Apollo", key_prefix="APO"))

    updated = repositories.projects.update(WORKSPACE, PROJECT, name="Renamed")

    assert updated is not None
    assert updated.name == "Renamed"
    assert updated.project_id == PROJECT
    assert updated.key_prefix == "APO"


def test_updating_a_missing_project_answers_none(repositories: Any) -> None:
    """The conditional update is what turns a missing row into a 404, not a write."""
    assert repositories.projects.update(WORKSPACE, "nope", name="x") is None


def test_the_default_statuses_are_seeded_once_per_project(repositories: Any) -> None:
    """The seed the contract fixes, scoped to one project of one workspace."""
    seeded = repositories.project_config.seed_statuses(WORKSPACE, PROJECT)

    assert [(row.name, row.category, row.position) for row in seeded] == [
        ("Backlog", "backlog", 0),
        ("Todo", "unstarted", 1),
        ("In Progress", "started", 2),
        ("Done", "completed", 3),
        ("Cancelled", "cancelled", 4),
    ]
    assert len(repositories.project_config.list_statuses(WORKSPACE, PROJECT)) == 5
    assert repositories.project_config.list_statuses(OTHER_WORKSPACE, PROJECT) == []


def test_statuses_and_labels_share_a_table_without_mixing(repositories: Any) -> None:
    """The sort key prefix is what keeps one list out of the other."""
    from app.common.db.dynamo.project_config import Label, label_key, new_config_id

    repositories.project_config.seed_statuses(WORKSPACE, PROJECT)
    label_id = new_config_id()
    repositories.project_config.create_label(
        Label(
            workspace_id=WORKSPACE,
            config_key=label_key(PROJECT, label_id),
            project_id=PROJECT,
            label_id=label_id,
            name="bug",
            color="#ff0000",
        )
    )

    assert len(repositories.project_config.list_statuses(WORKSPACE, PROJECT)) == 5
    assert [row.label_id for row in repositories.project_config.list_labels(WORKSPACE, PROJECT)] == [label_id]


def test_deleting_a_project_config_clears_both_kinds(repositories: Any) -> None:
    """A project delete must leave nothing behind that nothing can reach."""
    repositories.project_config.seed_statuses(WORKSPACE, PROJECT)

    removed = repositories.project_config.delete_for_project(WORKSPACE, PROJECT)

    assert removed == 5
    assert repositories.project_config.list_statuses(WORKSPACE, PROJECT) == []


def test_issue_numbers_are_allocated_atomically_and_never_reused(repositories: Any) -> None:
    """The counter is an atomic ADD, so two allocations never answer the same number."""
    first = repositories.counters.allocate_issue_number(WORKSPACE, PROJECT)
    second = repositories.counters.allocate_issue_number(WORKSPACE, PROJECT)

    assert (first, second) == (1, 2)
    assert repositories.counters.peek_issue_number(WORKSPACE, PROJECT) == 2


def test_counters_are_scoped_to_one_workspace(repositories: Any) -> None:
    """Two tenants numbering the same project id must not share a sequence."""
    repositories.counters.allocate_issue_number(WORKSPACE, PROJECT)

    assert repositories.counters.allocate_issue_number(OTHER_WORKSPACE, PROJECT) == 1


def test_an_idempotency_key_is_claimed_once(repositories: Any) -> None:
    """The second claim of a live key loses, which is what short-circuits a retry."""
    assert repositories.idempotency.claim(WORKSPACE, "invite", "abc") is True
    assert repositories.idempotency.claim(WORKSPACE, "invite", "abc") is False


def test_an_idempotency_key_is_scoped_to_its_workspace(repositories: Any) -> None:
    """The table has no tenant partition, so the key carries the workspace itself."""
    repositories.idempotency.claim(WORKSPACE, "invite", "abc")

    assert repositories.idempotency.claim(OTHER_WORKSPACE, "invite", "abc") is True


def test_users_are_fetched_in_one_batch(repositories: Any) -> None:
    """The member list joins against this, so a missing row is skipped not fatal."""
    from app.common.db.dynamo.users import User

    repositories.users.create(User(id=USER, email="one@example.com"))

    found = repositories.users.get_many([USER, OTHER_USER])

    assert set(found) == {USER}
