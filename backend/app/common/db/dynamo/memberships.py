"""The `memberships` table: who belongs to a workspace, and to which teams.

One table holds both grains, told apart by the sort key prefix. `user#<uid>` is the
workspace membership carrying the workspace role, and `team#<pid>#user#<uid>` is
the team membership carrying the team role. Both are partitioned by
`workspace_id`, so no query can span tenants.

`private_team#<pid>` marks one team private. It lives here rather than on the
team row because this is the one table every function's authorization already
reads, so deciding visibility costs one more query on a table already granted
rather than a read of `teams` from functions that carry no grant on it. The
marker carries no `user_id`, so it never enters the user index.

`policy#auth` holds the workspace's authentication policy, here for the same reason:
authorization reads it on every request without a grant on another table.

The workspace membership also carries the person's own sidebar team order,
because it is the one row that is already per person and per workspace.

`user_id-workspace_id-index` answers "my workspaces" without a scan, which is what
replaced the workspaces table's `owner_user_id-index`.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Mapping

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import ConditionFailed, Repository

from app.common.db.dynamo.base import as_item, build_repository, delete_partition, utc_now
from app.common.db.dynamo.tables import MEMBERSHIPS

USER_INDEX = "user_id-workspace_id-index"

WorkspaceRole = Literal["owner", "admin", "member", "guest"]

TeamRole = Literal["admin", "member"]

WORKSPACE_ROLES: tuple[str, ...] = ("owner", "admin", "member", "guest")

TEAM_ROLES: tuple[str, ...] = ("admin", "member")


def workspace_member_key(user_id: str) -> str:
    """The sort key of a workspace membership."""
    return f"user#{user_id}"


def team_member_key(team_id: str, user_id: str) -> str:
    """The sort key of a team membership."""
    return f"team#{team_id}#user#{user_id}"


TEAM_MEMBER_PREFIX = "team#"

PRIVATE_TEAM_PREFIX = "private_team#"

AUTH_POLICY_KEY = "policy#auth"


class AuthPolicy(BaseModel):
    """A workspace's authentication policy. The default requires nothing."""

    require_two_factor: bool = False
    updated_at: datetime | None = None
    updated_by: str | None = None


MEMBERSHIP_SCAN_LIMIT = 100_000
"""The safety ceiling on one membership read, far above any plan's seats."""


def private_team_key(team_id: str) -> str:
    """The sort key of the marker that makes one team private."""
    return f"{PRIVATE_TEAM_PREFIX}{team_id}"


class Membership(BaseModel):
    """One person's membership of a workspace, or of a team inside it."""

    workspace_id: str
    member_key: str
    user_id: str
    role: str
    team_id: str | None = None
    joined_at: datetime = Field(default_factory=utc_now)
    team_order: list[str] = Field(default_factory=list)

    @property
    def is_team_membership(self) -> bool:
        """Whether this row grants a team rather than the workspace."""
        return self.team_id is not None


class MembershipRepository:
    """Reads and writes `memberships` rows, always workspace first.

    Every method but `list_workspaces_for_user` takes `workspace_id` first, and that
    one reads the user index, which is itself keyed by user and workspace, so no
    call can reach a row outside a named tenant.
    """

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = build_repository(MEMBERSHIPS, repository)

    def delete_workspace_rows(self, workspace_id: str) -> int:
        """Delete every row this table holds for one workspace, for the workspace purge."""
        return delete_partition(self._repository, MEMBERSHIPS, workspace_id)

    def get(self, workspace_id: str, user_id: str) -> Membership | None:
        """This user's workspace membership, or `None` when they are not a member."""
        if not workspace_id or not user_id:
            return None
        item = self._repository.get({"workspace_id": workspace_id, "member_key": workspace_member_key(user_id)})
        return _as_membership(item) if item is not None else None

    def get_team_membership(self, workspace_id: str, team_id: str, user_id: str) -> Membership | None:
        """This user's membership of one team, or `None`."""
        if not workspace_id or not team_id or not user_id:
            return None
        item = self._repository.get({"workspace_id": workspace_id, "member_key": team_member_key(team_id, user_id)})
        return _as_membership(item) if item is not None else None

    def put(self, membership: Membership) -> Membership:
        """Write one membership row, creating or replacing it."""
        self._repository.put(as_item(membership))
        return membership

    def put_action(self, membership: Membership) -> dict[str, Any]:
        """A transaction Put for one membership row, for a multi-table write.

        Used where a grant has to land with the thing it grants, so a partial
        write cannot leave a team nobody administers.
        """
        return self._repository.put_action(as_item(membership))

    def create_unique(self, membership: Membership) -> Membership:
        """Write one membership row only when none exists, raising `ConditionFailed`.

        Used where a duplicate would be a second owner row or a re-accepted invite,
        so the race loses rather than overwriting the existing role.
        """
        self._repository.put(as_item(membership), condition=Attr("member_key").not_exists())
        return membership

    def set_role(self, workspace_id: str, user_id: str, role: str) -> Membership | None:
        """Change a workspace member's role, or `None` when there is no such member.

        Conditional on the row existing, so this cannot create a membership by
        naming a user who was never invited.
        """
        key = {"workspace_id": workspace_id, "member_key": workspace_member_key(user_id)}
        try:
            item = self._repository.update(
                key,
                update_expression="SET #role = :role",
                expression_names={"#role": "role"},
                expression_values={":role": role},
                condition=Attr("member_key").exists(),
                return_values="ALL_NEW",
            )
        except ConditionFailed:
            return None
        return _as_membership(item) if item is not None else None

    def set_team_role(self, workspace_id: str, team_id: str, user_id: str, role: str) -> Membership:
        """Grant or change a team role, creating the row when it is absent."""
        membership = Membership(
            workspace_id=workspace_id,
            member_key=team_member_key(team_id, user_id),
            user_id=user_id,
            role=role,
            team_id=team_id,
        )
        existing = self.get_team_membership(workspace_id, team_id, user_id)
        if existing is not None:
            membership = membership.model_copy(update={"joined_at": existing.joined_at})
        return self.put(membership)

    def set_team_order(self, workspace_id: str, user_id: str, team_ids: list[str]) -> Membership | None:
        """Save a member's sidebar team order, or `None` when there is no such member.

        Conditional on the row existing, so saving an order cannot create a
        membership, and an update rather than a put, so the role is untouched.
        """
        key = {"workspace_id": workspace_id, "member_key": workspace_member_key(user_id)}
        try:
            item = self._repository.update(
                key,
                update_expression="SET #order = :order",
                expression_names={"#order": "team_order"},
                expression_values={":order": list(team_ids)},
                condition=Attr("member_key").exists(),
                return_values="ALL_NEW",
            )
        except ConditionFailed:
            return None
        return _as_membership(item) if item is not None else None

    def delete(self, workspace_id: str, user_id: str) -> bool:
        """Remove a workspace membership, reporting whether one was there."""
        if self.get(workspace_id, user_id) is None:
            return False
        self._repository.delete({"workspace_id": workspace_id, "member_key": workspace_member_key(user_id)})
        return True

    def delete_team_membership(self, workspace_id: str, team_id: str, user_id: str) -> bool:
        """Remove one team membership, reporting whether one was there."""
        if self.get_team_membership(workspace_id, team_id, user_id) is None:
            return False
        self._repository.delete({"workspace_id": workspace_id, "member_key": team_member_key(team_id, user_id)})
        return True

    def list_members(self, workspace_id: str, *, limit: int = MEMBERSHIP_SCAN_LIMIT) -> list[Membership]:
        """Every workspace membership of this tenant, oldest first.

        Team memberships are excluded by the `user#` key prefix, so the members
        list is the workspace grain alone.
        """
        if not workspace_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("member_key").begins_with("user#"),
            max_items=limit,
        )
        return sorted((_as_membership(item) for item in items), key=lambda row: row.joined_at)

    def list_team_members(
        self, workspace_id: str, team_id: str, *, limit: int = MEMBERSHIP_SCAN_LIMIT
    ) -> list[Membership]:
        """Every membership of one team, oldest first."""
        if not workspace_id or not team_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("member_key").begins_with(f"team#{team_id}#user#"),
            max_items=limit,
        )
        return sorted((_as_membership(item) for item in items), key=lambda row: row.joined_at)

    def list_all_team_memberships(self, workspace_id: str, *, limit: int = 5000) -> list[Membership]:
        """Every team membership in this workspace, read once for per-team counts."""
        if not workspace_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("member_key").begins_with(TEAM_MEMBER_PREFIX),
            max_items=limit,
        )
        return [_as_membership(item) for item in items]

    def delete_team_memberships(self, workspace_id: str, team_id: str, *, batch: int = 100) -> int:
        """Remove every membership of one team, a page at a time, returning how many went."""
        removed = 0
        while True:
            members = self.list_team_members(workspace_id, team_id, limit=batch)
            if not members:
                return removed
            removed += self._repository.delete_many(
                [{"workspace_id": workspace_id, "member_key": member.member_key} for member in members]
            )

    def list_team_memberships_for_user(
        self, workspace_id: str, user_id: str, *, limit: int = MEMBERSHIP_SCAN_LIMIT
    ) -> list[Membership]:
        """Every team this user is explicitly a member of, in this workspace.

        This is what a guest's visible team set is resolved from, so it queries
        `user_id-workspace_id-index` for this user's rows alone rather than reading
        every team membership in the tenant and filtering.
        """
        if not workspace_id or not user_id:
            return []
        items = self._repository.iter_query(
            Key("user_id").eq(user_id) & Key("workspace_id").eq(workspace_id),
            index_name=USER_INDEX,
            max_items=limit,
        )
        return [row for item in items if (row := _as_membership(item)).is_team_membership]

    def _team_membership_keys_for_user(self, workspace_id: str, user_id: str) -> list[dict[str, str]]:
        """This user's team membership keys read from the table itself, strongly consistent.

        A delete must not miss a row the index has not caught up with yet.
        """
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("member_key").begins_with(TEAM_MEMBER_PREFIX),
            filter_expression=Attr("user_id").eq(user_id),
            consistent=True,
        )
        return [{"workspace_id": workspace_id, "member_key": str(item["member_key"])} for item in items]

    def list_workspaces_for_user(self, user_id: str, *, limit: int = 200) -> list[Membership]:
        """Every workspace this user belongs to, through `user_id-workspace_id-index`.

        Team memberships carry the same `user_id`, so they are filtered out here
        rather than indexed separately: a user's team rows are bounded by their
        workspace count and the index stays one entry per membership.
        """
        if not user_id:
            return []
        items = self._repository.iter_query(
            Key("user_id").eq(user_id),
            index_name=USER_INDEX,
            max_items=limit,
        )
        return [row for item in items if not (row := _as_membership(item)).is_team_membership]

    def remove_user(self, workspace_id: str, user_id: str) -> int:
        """Delete this person's workspace membership and every team membership they hold in it.

        The account purge's verb, idempotent: a second run finds nothing to delete.
        """
        keys = self._team_membership_keys_for_user(workspace_id, user_id)
        keys.append({"workspace_id": workspace_id, "member_key": workspace_member_key(user_id)})
        return self._repository.delete_many(keys)

    def list_private_team_ids(self, workspace_id: str) -> tuple[str, ...]:
        """Every team of this workspace marked private, read once per request by authorization."""
        if not workspace_id:
            return ()
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("member_key").begins_with(PRIVATE_TEAM_PREFIX),
            max_items=5000,
        )
        return tuple(sorted(str(item["member_key"])[len(PRIVATE_TEAM_PREFIX) :] for item in items))

    def is_private_team(self, workspace_id: str, team_id: str) -> bool:
        """Whether one team is marked private, for a check made outside a request."""
        if not workspace_id or not team_id:
            return False
        return self._repository.get({"workspace_id": workspace_id, "member_key": private_team_key(team_id)}) is not None

    def private_team_item(self, workspace_id: str, team_id: str) -> dict[str, Any]:
        """The marker row that makes one team private."""
        return {
            "workspace_id": workspace_id,
            "member_key": private_team_key(team_id),
            "team_id": team_id,
            "private_since": utc_now().isoformat(),
        }

    def private_team_action(self, workspace_id: str, team_id: str) -> dict[str, Any]:
        """A transaction Put of the private marker, so a team is created private or not at all."""
        return self._repository.put_action(self.private_team_item(workspace_id, team_id))

    def set_team_private(self, workspace_id: str, team_id: str, private: bool) -> None:
        """Mark one team private or open it again. Both directions are idempotent."""
        if private:
            if not self.is_private_team(workspace_id, team_id):
                self._repository.put(self.private_team_item(workspace_id, team_id))
            return
        self._repository.delete({"workspace_id": workspace_id, "member_key": private_team_key(team_id)})

    def get_auth_policy(self, workspace_id: str) -> AuthPolicy:
        """The workspace's authentication policy, the permissive default when none is stored."""
        if not workspace_id:
            return AuthPolicy()
        item = self._repository.get({"workspace_id": workspace_id, "member_key": AUTH_POLICY_KEY})
        return AuthPolicy() if item is None else AuthPolicy.model_validate(item)

    def set_auth_policy(self, workspace_id: str, *, require_two_factor: bool, updated_by: str) -> AuthPolicy:
        """Store the workspace's authentication policy and return it."""
        policy = AuthPolicy(require_two_factor=require_two_factor, updated_at=utc_now(), updated_by=updated_by)
        self._repository.put(as_item(policy, workspace_id=workspace_id, member_key=AUTH_POLICY_KEY))
        return policy

    def count_owners(self, workspace_id: str) -> int:
        """How many workspace owners this tenant has.

        Read before a role change or a removal, because the last owner must not be
        able to leave a workspace nobody can then administer. Exact rather than
        capped: every page is read, filtered to owners server side.
        """
        if not workspace_id:
            return 0
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("member_key").begins_with("user#"),
            filter_expression=Attr("role").eq("owner"),
            consistent=True,
        )
        return sum(1 for _ in items)


def _as_membership(item: Mapping[str, Any]) -> Membership:
    """One stored item as a `Membership`."""
    return Membership.model_validate(dict(item))
