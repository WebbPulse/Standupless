"""What deleting one account would do to the workspaces it belongs to.

Read by the identity route that deletes an account, to refuse it while the person
is the only owner of a workspace other people still use, and again by the purge
that follows, because the answer can change in between. One module so the rule the
route shows and the rule the purge applies can never disagree.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover
    from app.common.api.dependencies.repositories import Repositories

DELETED_USER_NAME = "Deleted user"
"""The name authored content shows once its author's account is purged.

The content stays, keyed by the old user id, and every read that joins the users
table renders this in place of the row that is no longer there.
"""


@dataclass(frozen=True)
class WorkspaceSummary:
    """One workspace as the account deletion plan names it."""

    id: str
    name: str
    slug: str
    deletion_scheduled: bool = False


@dataclass(frozen=True)
class AccountDeletionPlan:
    """The account's workspaces sorted by what deleting the account does to each.

    `blocking` are workspaces where the person is the only owner and other people
    remain, which stop the deletion until ownership moves or the workspace is
    deleted. `sole_member` are workspaces nobody else is in, which are deleted with
    the account. `leaving` are the rest, where only the membership goes.
    """

    blocking: list[WorkspaceSummary] = field(default_factory=list)
    sole_member: list[WorkspaceSummary] = field(default_factory=list)
    leaving: list[WorkspaceSummary] = field(default_factory=list)

    @property
    def workspace_ids(self) -> list[str]:
        """Every workspace the account belongs to."""
        return [row.id for row in (*self.blocking, *self.sole_member, *self.leaving)]


def plan_account_deletion(repositories: "Repositories", user_id: str) -> AccountDeletionPlan:
    """Sort the account's workspaces into blocking, deleted with it and left.

    A workspace already being purged is left out. One only scheduled for deletion
    still blocks while the person is its only owner, because its deletion can be
    cancelled and would then leave a workspace with nobody to own it; its summary
    says so, so the person can be told to transfer ownership or wait for its purge.
    Needs only reads of the memberships and workspaces tables.
    """
    memberships = repositories.memberships.list_workspaces_for_user(user_id)
    workspaces = repositories.workspaces.get_many([membership.workspace_id for membership in memberships])
    plan = AccountDeletionPlan()
    for membership in sorted(memberships, key=lambda row: row.workspace_id):
        workspace = workspaces.get(membership.workspace_id)
        if workspace is None or workspace.is_purging:
            continue
        summary = WorkspaceSummary(
            id=workspace.id,
            name=workspace.name,
            slug=workspace.slug,
            deletion_scheduled=workspace.purge_after is not None,
        )
        members = repositories.memberships.list_members(workspace.id, limit=5000)
        others = [member for member in members if member.user_id != user_id]
        if not others:
            plan.sole_member.append(summary)
            continue
        other_owners = [member for member in others if member.role == "owner"]
        if membership.role == "owner" and not other_owners:
            plan.blocking.append(summary)
            continue
        plan.leaving.append(summary)
    return plan
