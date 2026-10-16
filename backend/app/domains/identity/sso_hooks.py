"""Standupless's `SsoHooks`: where a workspace's connection lives and what a sign-in through it means.

A workspace has at most one connection, and its id is the workspace id, so the
identity package's routes for a connection are the routes for a workspace. The
rows are in `memberships`, which this function reads but never writes: the
workspaces function owns setting a connection up, and joining the workspace
after a first sign-in, because both change who is in a workspace.

A connection signs nobody in once the workspace's plan stops including single
sign-on, and the sign-in page finds a connection by email only after an admin has
completed a test sign-in through it, so a half configured provider is never
offered to the people of a domain.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any

from webbpulse.identity import SsoHooks, domain_of_email

if TYPE_CHECKING:  # pragma: no cover
    from webbpulse.identity import SsoConnection, SsoIdentity, SsoLoginOutcome

    from app.common.db.dynamo.memberships import MembershipRepository
    from app.common.db.dynamo.users import UserRepository
    from app.common.db.dynamo.workspaces import WorkspaceRepository

_log = logging.getLogger(__name__)


class StanduplessSsoHooks(SsoHooks):
    """Loads a workspace's connection from its rows and names a JIT person after their provider profile."""

    def __init__(
        self,
        memberships: "MembershipRepository | None" = None,
        workspaces: "WorkspaceRepository | None" = None,
        users: "UserRepository | None" = None,
    ) -> None:
        """Take injected repositories, or build this product's own on first use."""
        self._memberships = memberships
        self._workspaces = workspaces
        self._users = users

    def _membership_repository(self) -> "MembershipRepository":
        """The memberships repository, built once."""
        if self._memberships is None:
            from app.common.db.dynamo.memberships import MembershipRepository

            self._memberships = MembershipRepository()
        return self._memberships

    def _workspace_repository(self) -> "WorkspaceRepository":
        """The workspaces repository, built once."""
        if self._workspaces is None:
            from app.common.db.dynamo.workspaces import WorkspaceRepository

            self._workspaces = WorkspaceRepository()
        return self._workspaces

    def _user_repository(self) -> "UserRepository":
        """The users repository, built once."""
        if self._users is None:
            from app.common.db.dynamo.users import UserRepository

            self._users = UserRepository()
        return self._users

    def load_connection(self, connection_id: str) -> "SsoConnection | None":
        """The workspace's connection, disabled when its plan no longer includes single sign-on.

        Loaded whether or not it has been tested, because the test sign-in is itself
        a sign-in through this id.
        """
        return self._connection(connection_id, tested_only=False)

    def find_connection(self, *, email: str = "", tenant_hint: str = "") -> "SsoConnection | None":
        """The connection of the one workspace that verified this address's domain, once tested."""
        del tenant_hint
        try:
            domain = domain_of_email(email)
        except ValueError:
            return None
        for workspace_id in self._membership_repository().workspaces_verifying_sso_domain(domain):
            found = self._connection(workspace_id, tested_only=True)
            if found is not None:
                return found
        return None

    def on_sso_login(
        self,
        user: Mapping[str, Any],
        connection: "SsoConnection",
        identity: "SsoIdentity",
        *,
        outcome: "SsoLoginOutcome",
    ) -> None:
        """Give a person provisioned just now the name their provider holds for them.

        Joining the workspace is not done here: the sign-in page calls the
        workspaces function's join route next, which owns the membership row and
        the member cap. Renaming is best effort and never fails the sign-in.
        """
        name = identity.name.strip()
        user_id = str(user.get("id", "") or "")
        if outcome != "provisioned" or not name or not user_id:
            return
        try:
            self._user_repository().update(user_id, display_name=name[:120])
        except Exception:
            _log.warning(
                "Could not name a person provisioned through single sign-on.",
                extra={"event": "sso.jit_name_failed", "workspace_id": connection.tenant_id},
            )

    def _connection(self, workspace_id: str, *, tested_only: bool) -> "SsoConnection | None":
        """Build the package's connection from the workspace's rows, or `None` when there is none."""
        from app.common.plan_features import Feature, has_feature
        from app.common.sso import build_connection

        memberships = self._membership_repository()
        row = memberships.get_sso_connection(workspace_id)
        if row is None or (tested_only and not row.tested):
            return None
        workspace = self._workspace_repository().get(workspace_id)
        if workspace is None or workspace.is_purging:
            return None
        return build_connection(
            row,
            memberships.list_sso_domains(workspace_id),
            enabled=has_feature(workspace, Feature.SSO),
        )
