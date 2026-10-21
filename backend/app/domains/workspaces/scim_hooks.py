"""SCIM provisioning for a workspace: the identity package's hooks over Standupless rows.

The package owns the protocol, the bearer token check and the PATCH and filter
rules. This module owns what a directory user and group mean here. A user is a
`scim_user#` row in the memberships table that stands for one account on one of
the workspace's verified single sign-on domains, and a group is a link to a team
that already exists, so the directory decides who is on a team but never creates,
renames or deletes one. `app.common.scim` holds the rules that turn those rows into
memberships and that take access away again.

The package calls the hooks off the event loop without the request, so the
request's repository bundle travels to them in a context variable that a router
dependency sets. That keeps the hooks inside the same narrowed bundle every other
workspaces route runs in, and the same IAM grants.
"""

from __future__ import annotations

import contextlib
import json
from collections.abc import Iterator, Sequence
from contextvars import ContextVar
from typing import Annotated, Any, Final

from fastapi import Depends, HTTPException
from webbpulse.dynamodb import new_ulid
from webbpulse.identity import domain_of_email
from webbpulse.identity.api_keys import ApiKeyRecord, ApiKeyStore
from webbpulse.identity.scim import (
    MEMBER_TYPE_GROUP,
    ScimEmail,
    ScimError,
    ScimGroup,
    ScimHooks,
    ScimMember,
    ScimName,
    ScimPage,
    ScimQuery,
    ScimUser,
)

from app.common import scim
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.db.dynamo.memberships import (
    ScimGroupRow,
    ScimMemberRow,
    ScimNameTaken,
    ScimUserRow,
)
from app.common.db.dynamo.teams import Team
from app.common.plan_features import Feature, has_feature

USER_NAME_LIMIT: Final = 256

TEAM_SCAN_LIMIT: Final = 1000

_current: ContextVar[Repositories | None] = ContextVar("scim_repositories", default=None)


async def bind_request_repositories(repositories: Annotated[Repositories, Depends(get_repositories)]) -> None:
    """Hand the request's repository bundle to the hooks for the rest of this request.

    Asynchronous on purpose: a synchronous dependency runs in a worker thread, and
    a context variable it set would never reach the handler.
    """
    _current.set(repositories)


def current_repositories() -> Repositories:
    """The bundle of the SCIM request being served."""
    repositories = _current.get()
    if repositories is None:
        raise RuntimeError("No repository bundle is bound to this SCIM request.")
    return repositories


class RequestKeyStore(ApiKeyStore):
    """The API key store of the request being served, so a SCIM token verifies like any key."""

    def _store(self) -> ApiKeyStore:
        """The bundle's key store."""
        return current_repositories().api_keys

    def get(self, key_hash: str) -> ApiKeyRecord | None:
        """One key by hash."""
        return self._store().get(key_hash)

    def put(self, record: ApiKeyRecord) -> None:
        """Store one key."""
        self._store().put(record)

    def list_for_user(self, user_id: str) -> list[ApiKeyRecord]:
        """One subject's keys."""
        return self._store().list_for_user(user_id)

    def revoke(self, key_hash: str, *, revoked_at: str | None = None) -> ApiKeyRecord | None:
        """Revoke one key by hash."""
        return self._store().revoke(key_hash, revoked_at=revoked_at)

    def touch(self, key_hash: str, *, used_at: str | None = None) -> None:
        """Stamp a key's last use."""
        self._store().touch(key_hash, used_at=used_at)

    def delete_all_for_user(self, user_id: str) -> int:
        """Delete one subject's keys."""
        return self._store().delete_all_for_user(user_id)

    def list_for_tenant(self, tenant_id: str) -> list[ApiKeyRecord]:
        """One workspace's keys."""
        return self._store().list_for_tenant(tenant_id)

    def get_by_id(self, tenant_id: str, key_id: str) -> ApiKeyRecord | None:
        """One workspace's key by id."""
        return self._store().get_by_id(tenant_id, key_id)


@contextlib.contextmanager
def _as_scim() -> Iterator[None]:
    """Answer a product refusal, such as the member cap or the last owner, as a SCIM error."""
    try:
        yield
    except HTTPException as exc:
        detail = exc.detail
        message = str(detail.get("message", "")) if isinstance(detail, dict) else str(detail)
        raise ScimError(exc.status_code, message or "The request could not be completed.") from exc


def _email_domain(email: str) -> str | None:
    """The domain of an address as the identity package normalises it, or `None`."""
    try:
        return str(domain_of_email(email))
    except ValueError:
        return None


def _profile(user: ScimUser) -> str:
    """The attributes a row keeps as JSON: name parts, every email, and everything unmodelled."""
    return json.dumps(
        {
            "name": user.name.as_dict(),
            "emails": [item.as_dict() for item in user.emails],
            "attributes": dict(user.attributes),
        },
        sort_keys=True,
        default=str,
    )


def _user_from_row(row: ScimUserRow, groups: Sequence[ScimMember] = ()) -> ScimUser:
    """The package's user for a stored row and the groups it belongs to."""
    try:
        stored = json.loads(row.resource or "{}")
    except ValueError:
        stored = {}
    profile: dict[str, Any] = stored if isinstance(stored, dict) else {}
    raw_name = profile.get("name")
    raw_emails = profile.get("emails")
    raw_attributes = profile.get("attributes")
    emails = tuple(
        ScimEmail(
            value=str(item.get("value", "")),
            type=str(item.get("type", "")),
            primary=bool(item.get("primary", False)),
            display=str(item.get("display", "")),
        )
        for item in (raw_emails if isinstance(raw_emails, list) else [])
        if isinstance(item, dict) and item.get("value")
    )
    return ScimUser(
        user_name=row.user_name,
        id=row.scim_id,
        external_id=row.external_id,
        active=row.active,
        display_name=row.display_name,
        name=ScimName.from_dict(raw_name) if isinstance(raw_name, dict) else ScimName(),
        emails=emails,
        attributes=raw_attributes if isinstance(raw_attributes, dict) else {},
        groups=tuple(groups),
        created=row.created,
        last_modified=row.last_modified,
    )


def _group_from_row(row: ScimGroupRow, members: Sequence[ScimMember] = ()) -> ScimGroup:
    """The package's group for a stored link and its members."""
    try:
        stored = json.loads(row.attributes or "{}")
    except ValueError:
        stored = {}
    return ScimGroup(
        display_name=row.display_name,
        id=row.team_id,
        external_id=row.external_id,
        members=tuple(members),
        attributes=stored if isinstance(stored, dict) else {},
        created=row.created,
        last_modified=row.last_modified,
    )


class StanduplessScimHooks(ScimHooks):
    """Directory users and groups for one workspace, stored beside its memberships."""

    def scim_enabled(self, tenant_id: str) -> bool:
        """Whether the workspace exists, is not being purged, and its plan includes single sign-on."""
        workspace = current_repositories().workspaces.get(tenant_id)
        return workspace is not None and not workspace.is_purging and has_feature(workspace, Feature.SSO)

    def _groups_of(self, repositories: Repositories, workspace_id: str, scim_id: str) -> list[ScimMember]:
        """The linked groups one directory user is in, as their `groups` attribute renders them."""
        names = {row.team_id: row.display_name for row in repositories.memberships.list_scim_groups(workspace_id)}
        return [
            ScimMember(value=member.team_id, display=names[member.team_id])
            for member in repositories.memberships.list_scim_memberships_for_user(workspace_id, scim_id)
            if member.team_id in names
        ]

    def get_user(self, tenant_id: str, user_id: str) -> ScimUser | None:
        """One directory user with their groups."""
        repositories = current_repositories()
        row = repositories.memberships.get_scim_user(tenant_id, user_id)
        if row is None:
            return None
        return _user_from_row(row, self._groups_of(repositories, tenant_id, row.scim_id))

    def list_users(self, tenant_id: str, query: ScimQuery) -> ScimPage[ScimUser]:
        """Directory users, answering `userName`, `externalId` and `id` equality by point lookup."""
        repositories = current_repositories()
        memberships = repositories.memberships
        user_name = query.equality("userName")
        external_id = query.equality("externalId")
        scim_id = query.equality("id")
        if user_name is not None:
            found = memberships.get_scim_user_by_name(tenant_id, user_name)
            rows = [found] if found is not None else []
        elif external_id is not None:
            rows = memberships.list_scim_users(tenant_id, external_id=external_id)
        elif scim_id is not None:
            found = memberships.get_scim_user(tenant_id, scim_id)
            rows = [found] if found is not None else []
        else:
            rows = memberships.list_scim_users(tenant_id)
        names = {row.team_id: row.display_name for row in memberships.list_scim_groups(tenant_id)}
        groups: dict[str, list[ScimMember]] = {}
        if names and rows:
            for member in memberships.list_all_scim_members(tenant_id):
                if member.team_id in names:
                    groups.setdefault(member.scim_id, []).append(
                        ScimMember(value=member.team_id, display=names[member.team_id])
                    )
        return query.apply_users(_user_from_row(row, groups.get(row.scim_id, ())) for row in rows)

    def _check_email(self, repositories: Repositories, workspace_id: str, user: ScimUser, *, own_id: str = "") -> str:
        """The user's address, lowercased, once it is on a verified domain and no other directory user has it."""
        email = user.email.strip().lower()
        domain = _email_domain(email) if email else None
        if domain is None:
            raise ScimError.invalid_value(
                "Each user needs an email address on one of the workspace's verified domains."
            )
        sso_domain = repositories.memberships.get_sso_domain(workspace_id, domain)
        if sso_domain is None or not sso_domain.verified:
            raise ScimError.invalid_value(
                f"{domain} is not a verified single sign-on domain of this workspace. Verify it first."
            )
        for other in repositories.memberships.list_scim_users(workspace_id, email_lower=email, limit=10):
            if other.scim_id != own_id:
                raise ScimError.uniqueness("Another directory user already has that email address.")
        return email

    def create_user(self, tenant_id: str, user: ScimUser) -> ScimUser:
        """Store a new directory user and, when active, give their account its membership and teams."""
        repositories = current_repositories()
        if len(user.user_name) > USER_NAME_LIMIT:
            raise ScimError.invalid_value(f"'userName' must be at most {USER_NAME_LIMIT} characters.")
        email = self._check_email(repositories, tenant_id, user)
        row = ScimUserRow(
            workspace_id=tenant_id,
            scim_id=new_ulid(),
            user_name=user.user_name,
            external_id=user.external_id,
            active=user.active,
            display_name=user.display_name,
            email_lower=email,
            resource=_profile(user),
            created=user.created,
            last_modified=user.last_modified,
        )
        try:
            repositories.memberships.create_scim_user(row)
        except ScimNameTaken as exc:
            raise ScimError.uniqueness("A user with that userName already exists in this directory.") from exc
        if row.active:
            try:
                with _as_scim():
                    row = scim.grant(repositories, tenant_id, row)
            except Exception:
                repositories.memberships.delete_scim_user(row)
                raise
        scim.record(
            repositories,
            tenant_id,
            "scim.user_provisioned",
            target_type="scim_user",
            target_id=row.scim_id,
            target_label=row.user_name,
            after={"active": row.active, "linked": bool(row.linked_user_id)},
        )
        return _user_from_row(row)

    def update_user(self, tenant_id: str, user: ScimUser) -> ScimUser:
        """Store a replaced or patched directory user, granting access when they are active."""
        repositories = current_repositories()
        before = repositories.memberships.get_scim_user(tenant_id, user.id)
        if before is None:
            raise ScimError.not_found(f"User {user.id} not found.")
        if len(user.user_name) > USER_NAME_LIMIT:
            raise ScimError.invalid_value(f"'userName' must be at most {USER_NAME_LIMIT} characters.")
        email = before.email_lower
        if user.email.strip().lower() != before.email_lower:
            email = self._check_email(repositories, tenant_id, user, own_id=before.scim_id)
        if before.active and not user.active:
            with _as_scim():
                scim.guard_last_owner(repositories, tenant_id, before)
        row = before.model_copy(
            update={
                "user_name": user.user_name,
                "external_id": user.external_id,
                "active": user.active,
                "display_name": user.display_name,
                "email_lower": email,
                "resource": _profile(user),
                "last_modified": user.last_modified,
            }
        )
        try:
            repositories.memberships.put_scim_user(row, previous_name=before.user_name)
        except ScimNameTaken as exc:
            raise ScimError.uniqueness("A user with that userName already exists in this directory.") from exc
        if row.active:
            with _as_scim():
                row = scim.grant(repositories, tenant_id, row)
        scim.record(
            repositories,
            tenant_id,
            "scim.user_updated",
            target_type="scim_user",
            target_id=row.scim_id,
            target_label=row.user_name,
            before={"active": before.active},
            after={"active": row.active},
        )
        return _user_from_row(row, self._groups_of(repositories, tenant_id, row.scim_id))

    def deactivate_user(self, tenant_id: str, user: ScimUser) -> None:
        """Take the person's membership, teams, keys and sessions away."""
        repositories = current_repositories()
        row = repositories.memberships.get_scim_user(tenant_id, user.id)
        if row is None:
            return
        with _as_scim():
            scim.remove_access(repositories, tenant_id, row)
        scim.record(
            repositories,
            tenant_id,
            "scim.user_deactivated",
            target_type="scim_user",
            target_id=row.scim_id,
            target_label=row.user_name,
        )

    def reactivate_user(self, tenant_id: str, user: ScimUser) -> None:
        """Record the reactivation. Access came back when the update stored the user active."""
        scim.record(
            current_repositories(),
            tenant_id,
            "scim.user_reactivated",
            target_type="scim_user",
            target_id=user.id,
            target_label=user.user_name,
        )

    def delete_user(self, tenant_id: str, user_id: str) -> bool:
        """Deprovision the person as a deactivation does, then forget the directory row.

        The account itself stays, with every issue and comment it wrote, because the
        person may belong to other workspaces and their work belongs to this one.
        """
        repositories = current_repositories()
        row = repositories.memberships.get_scim_user(tenant_id, user_id)
        if row is None:
            return False
        with _as_scim():
            scim.guard_last_owner(repositories, tenant_id, row)
            scim.remove_access(repositories, tenant_id, row)
        repositories.memberships.delete_scim_user(row)
        scim.record(
            repositories,
            tenant_id,
            "scim.user_deleted",
            target_type="scim_user",
            target_id=row.scim_id,
            target_label=row.user_name,
        )
        return True

    def _members_of(self, repositories: Repositories, workspace_id: str, team_id: str) -> list[ScimMember]:
        """The directory users in one linked group."""
        users = {row.scim_id: row for row in repositories.memberships.list_scim_users(workspace_id)}
        return [
            ScimMember(value=member.scim_id, display=users[member.scim_id].user_name)
            for member in repositories.memberships.list_scim_members(workspace_id, team_id)
            if member.scim_id in users
        ]

    def get_group(self, tenant_id: str, group_id: str, *, include_members: bool = True) -> ScimGroup | None:
        """One linked group, while its team still exists."""
        repositories = current_repositories()
        row = repositories.memberships.get_scim_group(tenant_id, group_id)
        if row is None or repositories.teams.get(tenant_id, row.team_id) is None:
            return None
        members = self._members_of(repositories, tenant_id, row.team_id) if include_members else []
        return _group_from_row(row, members)

    def list_groups(self, tenant_id: str, query: ScimQuery) -> ScimPage[ScimGroup]:
        """Linked groups whose teams still exist, with members when the query wants them."""
        repositories = current_repositories()
        memberships = repositories.memberships
        live = {team.team_id for team in repositories.teams.list_for_workspace(tenant_id, limit=TEAM_SCAN_LIMIT)}
        rows = [row for row in memberships.list_scim_groups(tenant_id) if row.team_id in live]
        display_name = query.equality("displayName")
        external_id = query.equality("externalId")
        group_id = query.equality("id")
        if display_name is not None:
            rows = [row for row in rows if row.display_name.lower() == display_name.lower()]
        elif external_id is not None:
            rows = [row for row in rows if row.external_id == external_id]
        elif group_id is not None:
            rows = [row for row in rows if row.team_id == group_id]
        members: dict[str, list[ScimMember]] = {}
        if query.include_members and rows:
            users = {row.scim_id: row for row in memberships.list_scim_users(tenant_id)}
            for member in memberships.list_all_scim_members(tenant_id):
                if member.scim_id in users:
                    members.setdefault(member.team_id, []).append(
                        ScimMember(value=member.scim_id, display=users[member.scim_id].user_name)
                    )
        return query.apply_groups(_group_from_row(row, members.get(row.team_id, ())) for row in rows)

    def _team_named(self, repositories: Repositories, workspace_id: str, name: str) -> Team | None:
        """The live team a group's name points at, by name or by key, ignoring case."""
        wanted = name.strip().lower()
        for team in repositories.teams.list_for_workspace(workspace_id, limit=TEAM_SCAN_LIMIT):
            if team.name.strip().lower() == wanted or team.key_prefix.lower() == wanted:
                return team
        return None

    def create_group(self, tenant_id: str, group: ScimGroup) -> ScimGroup:
        """Link a directory group to the existing team of the same name or key."""
        repositories = current_repositories()
        team = self._team_named(repositories, tenant_id, group.display_name)
        if team is None:
            raise ScimError.invalid_value(
                f"No team is called {group.display_name}. Create the team in Standupless first, "
                "then push the group again, or rename the group to the team's name or key."
            )
        row = ScimGroupRow(
            workspace_id=tenant_id,
            team_id=team.team_id,
            display_name=group.display_name,
            external_id=group.external_id,
            attributes=json.dumps(dict(group.attributes), sort_keys=True, default=str),
            created=group.created,
            last_modified=group.last_modified,
        )
        if not repositories.memberships.link_scim_group(row):
            raise ScimError.uniqueness(f"The team {team.name} is already linked to a directory group.")
        scim.record(
            repositories,
            tenant_id,
            "scim.group_linked",
            target_type="team",
            target_id=team.team_id,
            target_label=team.name,
            after={"group": group.display_name},
        )
        return _group_from_row(row)

    def update_group(self, tenant_id: str, group: ScimGroup) -> ScimGroup:
        """Store the directory's name and attributes for a group. The team keeps its own name."""
        repositories = current_repositories()
        before = repositories.memberships.get_scim_group(tenant_id, group.id)
        if before is None:
            raise ScimError.not_found(f"Group {group.id} not found.")
        row = before.model_copy(
            update={
                "display_name": group.display_name,
                "external_id": group.external_id,
                "attributes": json.dumps(dict(group.attributes), sort_keys=True, default=str),
                "last_modified": group.last_modified,
            }
        )
        repositories.memberships.put_scim_group(row)
        scim.record(
            repositories,
            tenant_id,
            "scim.group_updated",
            target_type="team",
            target_id=row.team_id,
            target_label=row.display_name,
            before={"group": before.display_name},
            after={"group": row.display_name},
        )
        return _group_from_row(row)

    def delete_group(self, tenant_id: str, group_id: str) -> bool:
        """Unlink a group, taking back the team memberships SCIM gave. The team stays."""
        repositories = current_repositories()
        memberships = repositories.memberships
        row = memberships.get_scim_group(tenant_id, group_id)
        if row is None:
            return False
        for member in memberships.list_scim_members(tenant_id, row.team_id):
            user = memberships.get_scim_user(tenant_id, member.scim_id)
            if user is not None:
                scim.withdraw_member(repositories, tenant_id, user, member)
        memberships.delete_scim_group(tenant_id, row.team_id)
        scim.record(
            repositories,
            tenant_id,
            "scim.group_unlinked",
            target_type="team",
            target_id=row.team_id,
            target_label=row.display_name,
            before={"group": row.display_name},
        )
        return True

    def add_group_members(self, tenant_id: str, group_id: str, members: Sequence[ScimMember]) -> None:
        """Put directory users in a linked group and on its team."""
        repositories = current_repositories()
        memberships = repositories.memberships
        if memberships.get_scim_group(tenant_id, group_id) is None:
            raise ScimError.not_found(f"Group {group_id} not found.")
        users: list[ScimUserRow] = []
        for member in members:
            if member.type == MEMBER_TYPE_GROUP:
                raise ScimError.invalid_value("Nested groups are not supported. Add the users themselves.")
            user = memberships.get_scim_user(tenant_id, member.value)
            if user is None:
                raise ScimError.invalid_value(f"No directory user has the id {member.value}.")
            users.append(user)
        for user in users:
            existing = memberships.get_scim_member(tenant_id, group_id, user.scim_id)
            row = existing or memberships.put_scim_member(
                ScimMemberRow(workspace_id=tenant_id, team_id=group_id, scim_id=user.scim_id)
            )
            scim.apply_member(repositories, tenant_id, user, row)

    def remove_group_members(self, tenant_id: str, group_id: str, member_ids: Sequence[str]) -> None:
        """Take directory users out of a linked group, and off its team where SCIM put them."""
        repositories = current_repositories()
        memberships = repositories.memberships
        if memberships.get_scim_group(tenant_id, group_id) is None:
            raise ScimError.not_found(f"Group {group_id} not found.")
        for scim_id in member_ids:
            member = memberships.get_scim_member(tenant_id, group_id, scim_id)
            if member is None:
                continue
            user = memberships.get_scim_user(tenant_id, scim_id)
            if user is not None:
                scim.withdraw_member(repositories, tenant_id, user, member)
            memberships.delete_scim_member(tenant_id, group_id, scim_id)


def build_scim_service() -> Any:
    """The SCIM service for this deployment, rooted at the public `/api/scim/v2` URL."""
    from webbpulse.identity.scim import ScimService

    from app.common.sso import identity_issuer

    root = identity_issuer().removesuffix("/api/auth")
    return ScimService(StanduplessScimHooks(), RequestKeyStore(), base_url=f"{root}/api/scim/v2")


def build_router() -> Any:
    """The SCIM 2.0 router, every route bound to the request's repository bundle."""
    from webbpulse.identity.scim import build_scim_router

    return build_scim_router(
        build_scim_service(),
        prefix="/scim/v2",
        dependencies=[Depends(bind_request_repositories)],
    )


__all__ = [
    "RequestKeyStore",
    "StanduplessScimHooks",
    "bind_request_repositories",
    "build_router",
    "build_scim_service",
    "current_repositories",
]
