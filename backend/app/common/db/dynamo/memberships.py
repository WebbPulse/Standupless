"""The `memberships` table: who belongs to a workspace, and to which projects.

One table holds both grains, told apart by the sort key prefix. `user#<uid>` is the
workspace membership carrying the workspace role, and `project#<pid>#user#<uid>` is
the project membership carrying the project role. Both are partitioned by
`workspace_id`, so no query can span tenants.

`user_id-workspace_id-index` answers "my workspaces" without a scan, which is what
replaced the workspaces table's `owner_user_id-index`.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Mapping

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import ConditionFailed, Repository

from app.common.db.dynamo.base import as_item, build_repository, utc_now
from app.common.db.dynamo.tables import MEMBERSHIPS

USER_INDEX = "user_id-workspace_id-index"

WorkspaceRole = Literal["owner", "admin", "member", "guest"]

ProjectRole = Literal["admin", "member"]

WORKSPACE_ROLES: tuple[str, ...] = ("owner", "admin", "member", "guest")

PROJECT_ROLES: tuple[str, ...] = ("admin", "member")


def workspace_member_key(user_id: str) -> str:
    """The sort key of a workspace membership."""
    return f"user#{user_id}"


def project_member_key(project_id: str, user_id: str) -> str:
    """The sort key of a project membership."""
    return f"project#{project_id}#user#{user_id}"


PROJECT_MEMBER_PREFIX = "project#"


class Membership(BaseModel):
    """One person's membership of a workspace, or of a project inside it."""

    workspace_id: str
    member_key: str
    user_id: str
    role: str
    project_id: str | None = None
    joined_at: datetime = Field(default_factory=utc_now)

    @property
    def is_project_membership(self) -> bool:
        """Whether this row grants a project rather than the workspace."""
        return self.project_id is not None


class MembershipRepository:
    """Reads and writes `memberships` rows, always workspace first.

    Every method but `list_workspaces_for_user` takes `workspace_id` first, and that
    one reads the user index, which is itself keyed by user and workspace, so no
    call can reach a row outside a named tenant.
    """

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = build_repository(MEMBERSHIPS, repository)

    def get(self, workspace_id: str, user_id: str) -> Membership | None:
        """This user's workspace membership, or `None` when they are not a member."""
        if not workspace_id or not user_id:
            return None
        item = self._repository.get({"workspace_id": workspace_id, "member_key": workspace_member_key(user_id)})
        return _as_membership(item) if item is not None else None

    def get_project_membership(self, workspace_id: str, project_id: str, user_id: str) -> Membership | None:
        """This user's membership of one project, or `None`."""
        if not workspace_id or not project_id or not user_id:
            return None
        item = self._repository.get(
            {"workspace_id": workspace_id, "member_key": project_member_key(project_id, user_id)}
        )
        return _as_membership(item) if item is not None else None

    def put(self, membership: Membership) -> Membership:
        """Write one membership row, creating or replacing it."""
        self._repository.put(as_item(membership))
        return membership

    def put_action(self, membership: Membership) -> dict[str, Any]:
        """A transaction Put for one membership row, for a multi-table write.

        Used where a grant has to land with the thing it grants, so a partial
        write cannot leave a project nobody administers.
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

    def set_project_role(self, workspace_id: str, project_id: str, user_id: str, role: str) -> Membership:
        """Grant or change a project role, creating the row when it is absent."""
        membership = Membership(
            workspace_id=workspace_id,
            member_key=project_member_key(project_id, user_id),
            user_id=user_id,
            role=role,
            project_id=project_id,
        )
        existing = self.get_project_membership(workspace_id, project_id, user_id)
        if existing is not None:
            membership = membership.model_copy(update={"joined_at": existing.joined_at})
        return self.put(membership)

    def delete(self, workspace_id: str, user_id: str) -> bool:
        """Remove a workspace membership, reporting whether one was there."""
        if self.get(workspace_id, user_id) is None:
            return False
        self._repository.delete({"workspace_id": workspace_id, "member_key": workspace_member_key(user_id)})
        return True

    def delete_project_membership(self, workspace_id: str, project_id: str, user_id: str) -> bool:
        """Remove one project membership, reporting whether one was there."""
        if self.get_project_membership(workspace_id, project_id, user_id) is None:
            return False
        self._repository.delete({"workspace_id": workspace_id, "member_key": project_member_key(project_id, user_id)})
        return True

    def list_members(self, workspace_id: str, *, limit: int = 200) -> list[Membership]:
        """Every workspace membership of this tenant, oldest first.

        Project memberships are excluded by the `user#` key prefix, so the members
        list is the workspace grain alone.
        """
        if not workspace_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("member_key").begins_with("user#"),
            max_items=limit,
        )
        return sorted((_as_membership(item) for item in items), key=lambda row: row.joined_at)

    def list_project_members(self, workspace_id: str, project_id: str, *, limit: int = 200) -> list[Membership]:
        """Every membership of one project, oldest first."""
        if not workspace_id or not project_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("member_key").begins_with(f"project#{project_id}#user#"),
            max_items=limit,
        )
        return sorted((_as_membership(item) for item in items), key=lambda row: row.joined_at)

    def list_project_memberships_for_user(
        self, workspace_id: str, user_id: str, *, limit: int = 200
    ) -> list[Membership]:
        """Every project this user is explicitly a member of, in this workspace.

        This is what a guest's visible project set is resolved from, so it filters
        on the user rather than reading the whole tenant.
        """
        if not workspace_id or not user_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("member_key").begins_with(PROJECT_MEMBER_PREFIX),
            filter_expression=Attr("user_id").eq(user_id),
            max_items=limit,
        )
        return [_as_membership(item) for item in items]

    def list_workspaces_for_user(self, user_id: str, *, limit: int = 200) -> list[Membership]:
        """Every workspace this user belongs to, through `user_id-workspace_id-index`.

        Project memberships carry the same `user_id`, so they are filtered out here
        rather than indexed separately: a user's project rows are bounded by their
        workspace count and the index stays one entry per membership.
        """
        if not user_id:
            return []
        items = self._repository.iter_query(
            Key("user_id").eq(user_id),
            index_name=USER_INDEX,
            max_items=limit,
        )
        return [row for item in items if not (row := _as_membership(item)).is_project_membership]

    def count_owners(self, workspace_id: str) -> int:
        """How many workspace owners this tenant has.

        Read before a role change or a removal, because the last owner must not be
        able to leave a workspace nobody can then administer.
        """
        return sum(1 for member in self.list_members(workspace_id) if member.role == "owner")


def _as_membership(item: Mapping[str, Any]) -> Membership:
    """One stored item as a `Membership`."""
    return Membership.model_validate(dict(item))
