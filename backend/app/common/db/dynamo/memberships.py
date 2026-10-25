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

`domain#<domain>` approves one email domain for joining without an invite. Unlike
the other markers it sets `user_id` to its own sort key, so the user index doubles
as the domain index: "which workspaces approve acme.com" is one query on
`user_id = domain#acme.com`. No user id can take that form, because user ids are
ULIDs, so a person's own index reads never meet a domain row.

`sso#connection` holds the workspace's single sign-on connection, and
`sso_domain#<domain>` one domain the workspace is proving it owns for it. A domain
row takes `user_id = sso_domain#<domain>` only once its TXT record is verified, so
"which workspace signs in acme.com" is one query on the user index that never
meets a domain still pending, and no user id can take that form either.

The partition `sso_domain_claims` holds one `sso_domain#<domain>` row per verified
domain, naming the one workspace that holds it. Verifying writes the claim and the
domain row in one transaction, conditional on the claim being free, so two
workspaces verifying one domain at once cannot both win. The claim also carries
when its TXT record is next rechecked, so the daily recheck is one query on that
partition. No workspace id can take that form, because workspace ids are ULIDs.

`scim_user#<scim_id>` is one person a workspace's directory provisioned over SCIM,
and `scim_name#<user_name>` reserves that person's lowercased `userName`, so two
provisioning calls racing on one name cannot both land. `scim_group#<team_id>`
links a directory group to an existing team, and `scim_member#<team_id>#<scim_id>`
records one directory member of that group, with whether SCIM created the team
membership it stands for. None of these rows carries a `user_id`, so the user
index never meets them, and none starts with `user#` or `team#`, so no member or
team membership read does either.

`app_approval#<client_id>` records whether the workspace lets its members authorize
one third-party OAuth app, read by the identity function's consent gate under the
grant it already holds here. It carries no `user_id`, so the user index never meets it.

The workspace membership also carries the person's own sidebar team order,
because it is the one row that is already per person and per workspace.

`user_id-workspace_id-index` answers "my workspaces" without a scan, which is what
replaced the workspaces table's `owner_user_id-index`.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Literal, Mapping

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import ConditionFailed, Repository, TransactionCanceled

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

APPROVED_DOMAIN_PREFIX = "domain#"

APPROVED_DOMAIN_LIMIT = 50
"""The abuse ceiling on approved domains per workspace, far above any real company's."""


def approved_domain_key(domain: str) -> str:
    """The sort key, and the user index key, of one approved email domain."""
    return f"{APPROVED_DOMAIN_PREFIX}{domain}"


class ApprovedDomain(BaseModel):
    """One email domain whose verified addresses may join the workspace without an invite."""

    workspace_id: str
    domain: str
    added_by: str
    added_at: datetime = Field(default_factory=utc_now)


SignInMethod = Literal["password", "google", "github", "passkey"]

SIGN_IN_METHODS: tuple[SignInMethod, ...] = ("password", "google", "github", "passkey")
"""Every way a person can sign in, in the order the settings page lists them."""


class AuthPolicy(BaseModel):
    """A workspace's authentication policy. The default requires nothing and allows every method."""

    require_two_factor: bool = False
    allowed_methods: list[SignInMethod] = Field(default_factory=lambda: list(SIGN_IN_METHODS))
    require_sso: bool = False
    updated_at: datetime | None = None
    updated_by: str | None = None
    enforced_since: datetime | None = None

    def tightened_from(self, previous: "AuthPolicy") -> bool:
        """Whether this policy asks more of a sign-in than `previous` did."""
        return (
            (self.require_two_factor and not previous.require_two_factor)
            or (self.require_sso and not previous.require_sso)
            or not set(previous.allowed_methods).issubset(self.allowed_methods)
        )

    def delegated_cutoff(self) -> datetime | None:
        """When this policy last tightened, before which delegated credentials are held to it.

        A row written before the field existed falls back to its last update, the
        earliest moment the stored requirements are known to have held.
        """
        return self.enforced_since or self.updated_at


SSO_CONNECTION_KEY = "sso#connection"

SSO_DOMAIN_PREFIX = "sso_domain#"

SSO_DOMAIN_LIMIT = 20
"""The abuse ceiling on single sign-on domains per workspace, far above any real company's."""

SsoProtocolName = Literal["oidc", "saml"]

SSO_CLAIMS_PARTITION = "sso_domain_claims"
"""The partition holding every verified domain's claim, one row per domain."""

SSO_RECHECK_INTERVAL = timedelta(days=1)
"""How long a verified domain goes between TXT rechecks."""

SSO_RECHECK_RETRY = timedelta(hours=1)
"""How soon a domain whose record went missing is checked again before it lapses."""


def sso_domain_key(domain: str) -> str:
    """The sort key, and once verified the user index key, of one single sign-on domain."""
    return f"{SSO_DOMAIN_PREFIX}{domain}"


class SsoDomain(BaseModel):
    """One email domain a workspace is proving it owns, for single sign-on.

    `token` is the value of the TXT record the domain must publish. It is not a
    secret: it only proves who could publish it.
    """

    workspace_id: str
    domain: str
    token: str
    added_by: str
    added_at: datetime = Field(default_factory=utc_now)
    verified_at: datetime | None = None
    verified_by: str | None = None
    lapsed_at: datetime | None = None

    @property
    def verified(self) -> bool:
        """Whether the domain's TXT record was found."""
        return self.verified_at is not None

    @property
    def lapsed(self) -> bool:
        """Whether the domain was verified once and lost it when its record went missing."""
        return self.verified_at is None and self.lapsed_at is not None


class SsoDomainClaim(BaseModel):
    """The one workspace holding a verified domain, and when its record is next rechecked.

    `missed_at` is when a recheck last found the record missing; a second miss on
    the next check lapses the domain, so one bad DNS answer never does.
    """

    domain: str
    holder_workspace_id: str
    claimed_at: datetime = Field(default_factory=utc_now)
    next_check_at: datetime
    missed_at: datetime | None = None


class SsoDomainTaken(Exception):
    """Another workspace holds this domain's claim."""


class SsoConnectionRow(BaseModel):
    """A workspace's single sign-on connection, as stored.

    The OIDC client secret is held only sealed, in `oidc_sealed_secret`, bound to the
    workspace id, so the stored row is safe to read anywhere the table is granted.
    `tested_at` is cleared by any change to the provider settings, because a test
    proves only the settings it ran against.
    """

    workspace_id: str
    protocol: SsoProtocolName
    display_name: str = ""
    oidc_issuer: str = ""
    oidc_client_id: str = ""
    oidc_sealed_secret: dict[str, str] = Field(default_factory=dict)
    oidc_scopes: list[str] = Field(default_factory=lambda: ["openid", "email", "profile"])
    saml_idp_entity_id: str = ""
    saml_idp_sso_url: str = ""
    saml_idp_certificates: list[str] = Field(default_factory=list)
    created_by: str
    created_at: datetime = Field(default_factory=utc_now)
    updated_by: str
    updated_at: datetime = Field(default_factory=utc_now)
    tested_at: datetime | None = None
    tested_by: str | None = None

    @property
    def tested(self) -> bool:
        """Whether a sign-in has completed through these settings."""
        return self.tested_at is not None


SCIM_USER_PREFIX = "scim_user#"

SCIM_NAME_PREFIX = "scim_name#"

SCIM_GROUP_PREFIX = "scim_group#"

SCIM_MEMBER_PREFIX = "scim_member#"

SCIM_SCAN_LIMIT = 20_000
"""The safety ceiling on one read of a workspace's directory rows, far above any plan's seats."""


class ScimNameTaken(Exception):
    """Another directory user in the workspace already holds this `userName`."""


def scim_user_key(scim_id: str) -> str:
    """The sort key of one provisioned directory user."""
    return f"{SCIM_USER_PREFIX}{scim_id}"


def scim_name_key(user_name: str) -> str:
    """The sort key reserving one lowercased `userName` in a workspace."""
    return f"{SCIM_NAME_PREFIX}{user_name.strip().lower()}"


def scim_group_key(team_id: str) -> str:
    """The sort key of the link between a directory group and a team."""
    return f"{SCIM_GROUP_PREFIX}{team_id}"


def scim_member_key(team_id: str, scim_id: str) -> str:
    """The sort key of one directory member of a linked group."""
    return f"{SCIM_MEMBER_PREFIX}{team_id}#{scim_id}"


class ScimUserRow(BaseModel):
    """One directory user, as the workspace's identity provider last described them.

    `resource` holds the SCIM attributes this product does not model, such as the
    name parts and the enterprise extension, as JSON, so a provider reads back what
    it wrote. `linked_user_id` is the Standupless account the directory user stands
    for, empty until that person has an account on a verified domain.
    """

    workspace_id: str
    scim_id: str
    user_name: str
    external_id: str = ""
    active: bool = True
    display_name: str = ""
    email_lower: str = ""
    linked_user_id: str = ""
    resource: str = "{}"
    created: str = ""
    last_modified: str = ""


class ScimGroupRow(BaseModel):
    """A directory group linked to one existing team, whose id is the group's id."""

    workspace_id: str
    team_id: str
    display_name: str
    external_id: str = ""
    attributes: str = "{}"
    created: str = ""
    last_modified: str = ""


class ScimMemberRow(BaseModel):
    """One directory user in one linked group.

    `applied` is whether SCIM created the team membership, so removing the person
    from the group never removes a membership someone granted by hand.
    """

    workspace_id: str
    team_id: str
    scim_id: str
    applied: bool = False


MEMBERSHIP_SCAN_LIMIT = 100_000
"""The safety ceiling on one membership read, far above any plan's seats."""


def private_team_key(team_id: str) -> str:
    """The sort key of the marker that makes one team private."""
    return f"{PRIVATE_TEAM_PREFIX}{team_id}"


APP_APPROVAL_PREFIX = "app_approval#"

APP_APPROVAL_LIMIT = 1000
"""The abuse ceiling on approval records one workspace lists, far above the apps any team connects."""

AppApprovalStatus = Literal["pending", "approved", "denied"]

APP_APPROVAL_STATUSES: tuple[str, ...] = ("pending", "approved", "denied")


def app_approval_key(client_id: str) -> str:
    """The sort key of one third-party app's approval record."""
    return f"{APP_APPROVAL_PREFIX}{client_id}"


class AppApproval(BaseModel):
    """Whether a workspace lets its members authorize one third-party OAuth app.

    One row per app, under `app_approval#<client_id>`. A request writes it pending
    with who asked and why, a decision moves it to approved or denied with who
    decided and why, and a fresh request after a denial moves it back to pending
    while keeping the earlier decision readable until the next one replaces it.
    """

    workspace_id: str
    client_id: str
    client_name: str = ""
    status: AppApprovalStatus = "pending"
    requested_by: str | None = None
    request_reason: str = ""
    requested_at: datetime | None = None
    decided_by: str | None = None
    decision_reason: str = ""
    decided_at: datetime | None = None
    updated_at: datetime = Field(default_factory=utc_now)


class Membership(BaseModel):
    """One person's membership of a workspace, or of a team inside it."""

    workspace_id: str
    member_key: str
    user_id: str
    role: str
    team_id: str | None = None
    joined_at: datetime = Field(default_factory=utc_now)
    team_order: list[str] = Field(default_factory=list)
    suspended_at: datetime | None = None
    suspended_by: str | None = None

    @property
    def is_team_membership(self) -> bool:
        """Whether this row grants a team rather than the workspace."""
        return self.team_id is not None

    @property
    def is_suspended(self) -> bool:
        """Whether this workspace membership is suspended, keeping its role and teams but granting nothing."""
        return self.suspended_at is not None


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

    def create_action(self, membership: Membership) -> dict[str, Any]:
        """A transaction Put for a new membership row, failing its condition when one exists."""
        return self._repository.put_action(as_item(membership), condition=Attr("member_key").not_exists())

    def set_role_action(self, workspace_id: str, user_id: str, role: str, *, current: str) -> dict[str, Any]:
        """A transaction Update changing a workspace member's role, only while it is still `current`.

        Pinned to the role read, so a guest count moved alongside it cannot drift
        when two role changes race.
        """
        return self._repository.update_action(
            {"workspace_id": workspace_id, "member_key": workspace_member_key(user_id)},
            update_expression="SET #role = :role",
            expression_names={"#role": "role"},
            expression_values={":role": role},
            condition=Attr("member_key").exists() & Attr("role").eq(current),
        )

    def delete_action(self, workspace_id: str, user_id: str, *, current: str) -> dict[str, Any]:
        """A transaction Delete of a workspace membership, only while it exists with the role `current`."""
        return self._repository.delete_action(
            {"workspace_id": workspace_id, "member_key": workspace_member_key(user_id)},
            condition=Attr("member_key").exists() & Attr("role").eq(current),
        )

    def count_members(self, workspace_id: str, *, limit: int = 10_000) -> tuple[int, int]:
        """How many workspace members, and how many of them guests, read strongly consistently for plan usage."""
        if not workspace_id:
            return 0, 0
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("member_key").begins_with("user#"),
            max_items=limit,
            consistent=True,
        )
        members = guests = 0
        for item in items:
            members += 1
            if item.get("role") == "guest":
                guests += 1
        return members, guests

    def get_consistent(self, workspace_id: str, user_id: str) -> Membership | None:
        """This user's workspace membership read strongly consistently, for a write that pins its role."""
        if not workspace_id or not user_id:
            return None
        item = self._repository.get(
            {"workspace_id": workspace_id, "member_key": workspace_member_key(user_id)}, consistent=True
        )
        return _as_membership(item) if item is not None else None

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

    def set_suspended(self, workspace_id: str, user_id: str, *, suspended_by: str) -> Membership | None:
        """Suspend a workspace member, or `None` when there is no such member or they are already suspended.

        Conditional on the row existing unsuspended, so two racing suspensions
        record one actor and suspending cannot create a membership.
        """
        key = {"workspace_id": workspace_id, "member_key": workspace_member_key(user_id)}
        try:
            item = self._repository.update(
                key,
                update_expression="SET #at = :at, #by = :by",
                expression_names={"#at": "suspended_at", "#by": "suspended_by"},
                expression_values={":at": utc_now().isoformat(), ":by": suspended_by},
                condition=Attr("member_key").exists()
                & (Attr("suspended_at").not_exists() | Attr("suspended_at").attribute_type("NULL")),
                return_values="ALL_NEW",
            )
        except ConditionFailed:
            return None
        return _as_membership(item) if item is not None else None

    def clear_suspended(self, workspace_id: str, user_id: str) -> Membership | None:
        """Reactivate a suspended workspace member, or `None` when there is no such member.

        Leaves the role, team rows and team order alone, so access returns exactly
        as it was.
        """
        key = {"workspace_id": workspace_id, "member_key": workspace_member_key(user_id)}
        try:
            item = self._repository.update(
                key,
                update_expression="REMOVE #at, #by",
                expression_names={"#at": "suspended_at", "#by": "suspended_by"},
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

    def suspended_user_ids(self, workspace_id: str) -> frozenset[str]:
        """Everyone whose workspace membership is suspended, for a fan-out over team rows that carry no suspension."""
        return frozenset(row.user_id for row in self.list_members(workspace_id) if row.is_suspended)

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

    def set_auth_policy(
        self,
        workspace_id: str,
        *,
        require_two_factor: bool,
        updated_by: str,
        allowed_methods: list[SignInMethod] | None = None,
        require_sso: bool | None = None,
    ) -> AuthPolicy:
        """Store the workspace's authentication policy and return it.

        `allowed_methods` of `None` allows every sign-in method. `require_sso` of
        `None` keeps the stored value, so the two-factor and methods route never
        turns single sign-on off by saving its own fields.

        `enforced_since` moves to now whenever the policy asks more than it did, so
        API keys and MCP grants issued before that moment are held to it; loosening
        or resaving keeps the earlier moment.
        """
        previous = self.get_auth_policy(workspace_id)
        if require_sso is None:
            require_sso = previous.require_sso
        methods: list[SignInMethod] = (
            list(SIGN_IN_METHODS)
            if allowed_methods is None
            else [method for method in SIGN_IN_METHODS if method in allowed_methods]
        )
        moment = utc_now()
        policy = AuthPolicy(
            require_two_factor=require_two_factor,
            allowed_methods=methods,
            require_sso=require_sso,
            updated_at=moment,
            updated_by=updated_by,
        )
        policy.enforced_since = moment if policy.tightened_from(previous) else previous.delegated_cutoff()
        self._repository.put(as_item(policy, workspace_id=workspace_id, member_key=AUTH_POLICY_KEY))
        return policy

    def list_approved_domains(self, workspace_id: str) -> list[ApprovedDomain]:
        """Every approved email domain of this workspace, in domain order."""
        if not workspace_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("member_key").begins_with(APPROVED_DOMAIN_PREFIX),
            max_items=APPROVED_DOMAIN_LIMIT * 2,
            consistent=True,
        )
        return sorted((ApprovedDomain.model_validate(dict(item)) for item in items), key=lambda row: row.domain)

    def get_approved_domain(self, workspace_id: str, domain: str) -> ApprovedDomain | None:
        """One approved domain of this workspace, or `None` when it is not approved."""
        if not workspace_id or not domain:
            return None
        item = self._repository.get({"workspace_id": workspace_id, "member_key": approved_domain_key(domain)})
        return None if item is None else ApprovedDomain.model_validate(dict(item))

    def add_approved_domain(self, workspace_id: str, domain: str, *, added_by: str) -> ApprovedDomain:
        """Approve one domain, keeping the original row when it is already approved."""
        existing = self.get_approved_domain(workspace_id, domain)
        if existing is not None:
            return existing
        row = ApprovedDomain(workspace_id=workspace_id, domain=domain, added_by=added_by)
        key = approved_domain_key(domain)
        try:
            self._repository.put(as_item(row, member_key=key, user_id=key), condition=Attr("member_key").not_exists())
        except ConditionFailed:
            return self.get_approved_domain(workspace_id, domain) or row
        return row

    def remove_approved_domain(self, workspace_id: str, domain: str) -> None:
        """Stop approving one domain. Idempotent."""
        if not workspace_id or not domain:
            return
        self._repository.delete({"workspace_id": workspace_id, "member_key": approved_domain_key(domain)})

    def workspaces_approving_domain(self, domain: str, *, limit: int = 200) -> list[str]:
        """The ids of every workspace approving this email domain, through the user index.

        The one read here that spans tenants, on purpose: it is how a person finds
        the workspaces their verified address may join, and it answers ids alone.
        """
        if not domain:
            return []
        items = self._repository.iter_query(
            Key("user_id").eq(approved_domain_key(domain)),
            index_name=USER_INDEX,
            max_items=limit,
        )
        return sorted({str(item["workspace_id"]) for item in items})

    def get_sso_connection(self, workspace_id: str) -> SsoConnectionRow | None:
        """The workspace's single sign-on connection, or `None` when none is set up."""
        if not workspace_id:
            return None
        item = self._repository.get({"workspace_id": workspace_id, "member_key": SSO_CONNECTION_KEY})
        return None if item is None else SsoConnectionRow.model_validate(dict(item))

    def put_sso_connection(self, row: SsoConnectionRow) -> SsoConnectionRow:
        """Store the workspace's single sign-on connection, replacing any earlier one."""
        self._repository.put(as_item(row, member_key=SSO_CONNECTION_KEY))
        return row

    def delete_sso_connection(self, workspace_id: str) -> None:
        """Remove the workspace's single sign-on connection. Idempotent."""
        if not workspace_id:
            return
        self._repository.delete({"workspace_id": workspace_id, "member_key": SSO_CONNECTION_KEY})

    def list_sso_domains(self, workspace_id: str) -> list[SsoDomain]:
        """Every single sign-on domain of this workspace, verified or not, in domain order."""
        if not workspace_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("member_key").begins_with(SSO_DOMAIN_PREFIX),
            max_items=SSO_DOMAIN_LIMIT * 2,
            consistent=True,
        )
        return sorted((SsoDomain.model_validate(dict(item)) for item in items), key=lambda row: row.domain)

    def get_sso_domain(self, workspace_id: str, domain: str) -> SsoDomain | None:
        """One single sign-on domain of this workspace, or `None`."""
        if not workspace_id or not domain:
            return None
        item = self._repository.get({"workspace_id": workspace_id, "member_key": sso_domain_key(domain)})
        return None if item is None else SsoDomain.model_validate(dict(item))

    def add_sso_domain(self, workspace_id: str, domain: str, *, token: str, added_by: str) -> SsoDomain:
        """Start proving one domain, keeping the original row and token when it is already listed."""
        existing = self.get_sso_domain(workspace_id, domain)
        if existing is not None:
            return existing
        row = SsoDomain(workspace_id=workspace_id, domain=domain, token=token, added_by=added_by)
        try:
            self._repository.put(
                as_item(row, member_key=sso_domain_key(domain)),
                condition=Attr("member_key").not_exists(),
            )
        except ConditionFailed:
            return self.get_sso_domain(workspace_id, domain) or row
        return row

    def _claim_key(self, domain: str) -> dict[str, str]:
        """The key of one domain's claim."""
        return {"workspace_id": SSO_CLAIMS_PARTITION, "member_key": sso_domain_key(domain)}

    def get_sso_domain_claim(self, domain: str) -> SsoDomainClaim | None:
        """The claim on one domain, read strongly consistently, or `None` when it is free."""
        if not domain:
            return None
        item = self._repository.get(self._claim_key(domain), consistent=True)
        return None if item is None else SsoDomainClaim.model_validate(dict(item))

    def list_sso_domain_claims(self, *, limit: int = 10000) -> list[SsoDomainClaim]:
        """Every verified domain's claim, for the recheck."""
        items = self._repository.iter_query(
            Key("workspace_id").eq(SSO_CLAIMS_PARTITION) & Key("member_key").begins_with(SSO_DOMAIN_PREFIX),
            max_items=limit,
        )
        return [SsoDomainClaim.model_validate(dict(item)) for item in items]

    def sso_domain_claim_is_stale(self, claim: SsoDomainClaim) -> bool:
        """Whether a claim's holder no longer has the domain verified, so it may be taken over."""
        item = self._repository.get(
            {"workspace_id": claim.holder_workspace_id, "member_key": sso_domain_key(claim.domain)},
            consistent=True,
        )
        return item is None or SsoDomain.model_validate(dict(item)).verified_at is None

    def mark_sso_domain_verified(self, row: SsoDomain, *, verified_by: str) -> SsoDomain:
        """Claim the domain and record its found TXT record, in one transaction.

        The claim is written only when it is free, already this workspace's, or held
        by a workspace that no longer has the domain verified, such as one that
        removed it or was purged. The domain row is written only while it still
        exists with the same token. Raises `SsoDomainTaken` when another workspace
        holds the claim, which is how the loser of two simultaneous verifications
        finds out.
        """
        key = sso_domain_key(row.domain)
        now = utc_now()
        verified = row.model_copy(update={"verified_at": now, "verified_by": verified_by, "lapsed_at": None})
        claim = SsoDomainClaim(
            domain=row.domain,
            holder_workspace_id=row.workspace_id,
            claimed_at=now,
            next_check_at=now + SSO_RECHECK_INTERVAL,
        )
        current = self.get_sso_domain_claim(row.domain)
        allowed = Attr("member_key").not_exists() | Attr("holder_workspace_id").eq(row.workspace_id)
        if current is not None and current.holder_workspace_id != row.workspace_id:
            if not self.sso_domain_claim_is_stale(current):
                raise SsoDomainTaken(row.domain)
            allowed = Attr("holder_workspace_id").eq(current.holder_workspace_id)
        try:
            self._repository.transact_write(
                [
                    self._repository.put_action(
                        as_item(claim, workspace_id=SSO_CLAIMS_PARTITION, member_key=key),
                        condition=allowed,
                    ),
                    self._repository.put_action(
                        as_item(verified, member_key=key, user_id=key),
                        condition=Attr("member_key").exists() & Attr("token").eq(row.token),
                    ),
                ]
            )
        except TransactionCanceled as exc:
            holder = self.get_sso_domain_claim(row.domain)
            if holder is not None and holder.holder_workspace_id != row.workspace_id:
                raise SsoDomainTaken(row.domain) from exc
            raise
        return verified

    def record_sso_domain_check(self, claim: SsoDomainClaim, *, found: bool) -> SsoDomainClaim:
        """Record a recheck that found the record, or a first miss, on a claim still held.

        Raises `ConditionFailed` when the claim moved or went since it was read.
        """
        now = utc_now()
        update = (
            {"next_check_at": now + SSO_RECHECK_INTERVAL, "missed_at": None}
            if found
            else {"next_check_at": now + SSO_RECHECK_RETRY, "missed_at": now}
        )
        checked = claim.model_copy(update=update)
        self._repository.put(
            as_item(checked, workspace_id=SSO_CLAIMS_PARTITION, member_key=sso_domain_key(claim.domain)),
            condition=Attr("holder_workspace_id").eq(claim.holder_workspace_id),
        )
        return checked

    def lapse_sso_domain(self, claim: SsoDomainClaim) -> bool:
        """Mark the holder's domain unverified and free its claim, in one transaction.

        Takes the domain out of the user index, so no sign-in finds the workspace by
        it, and records `lapsed_at` so the settings page can say why. Answers whether
        it lapsed; `False` means the claim or the domain row changed since it was read.
        """
        key = sso_domain_key(claim.domain)
        try:
            self._repository.transact_write(
                [
                    self._repository.delete_action(
                        self._claim_key(claim.domain),
                        condition=Attr("holder_workspace_id").eq(claim.holder_workspace_id),
                    ),
                    self._repository.update_action(
                        {"workspace_id": claim.holder_workspace_id, "member_key": key},
                        update_expression="SET lapsed_at = :now REMOVE verified_at, verified_by, user_id",
                        expression_values={":now": utc_now().isoformat()},
                        condition=Attr("member_key").exists() & Attr("verified_at").exists(),
                    ),
                ]
            )
        except TransactionCanceled:
            return False
        return True

    def release_sso_domain_claim(self, workspace_id: str, domain: str) -> None:
        """Free a domain's claim when this workspace holds it. Idempotent."""
        if not workspace_id or not domain:
            return
        try:
            self._repository.delete(
                self._claim_key(domain),
                condition=Attr("holder_workspace_id").eq(workspace_id),
            )
        except ConditionFailed:
            return

    def remove_sso_domain(self, workspace_id: str, domain: str) -> None:
        """Stop using one domain for single sign-on, freeing its claim when this workspace holds it. Idempotent."""
        if not workspace_id or not domain:
            return
        self._repository.delete({"workspace_id": workspace_id, "member_key": sso_domain_key(domain)})
        self.release_sso_domain_claim(workspace_id, domain)

    def workspaces_verifying_sso_domain(self, domain: str, *, limit: int = 10) -> list[str]:
        """The ids of every workspace that verified this domain for single sign-on.

        Spans tenants on purpose, as `workspaces_approving_domain` does: it is how a
        sign-in page finds the connection for an address, and it answers ids alone.
        Verification claims the domain atomically, so this is one id or none.
        """
        if not domain:
            return []
        items = self._repository.iter_query(
            Key("user_id").eq(sso_domain_key(domain)),
            index_name=USER_INDEX,
            max_items=limit,
        )
        return sorted({str(item["workspace_id"]) for item in items})

    def count_owners(self, workspace_id: str) -> int:
        """How many active workspace owners this tenant has.

        Read before a role change, a removal or a suspension, because the last
        owner must not be able to leave a workspace nobody can then administer.
        A suspended owner administers nothing, so is not counted. Exact rather
        than capped: every page is read, filtered to owners server side.
        """
        if not workspace_id:
            return 0
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("member_key").begins_with("user#"),
            filter_expression=Attr("role").eq("owner"),
            consistent=True,
        )
        return sum(1 for item in items if not item.get("suspended_at"))

    def get_scim_user(self, workspace_id: str, scim_id: str) -> ScimUserRow | None:
        """One provisioned directory user, or `None`."""
        if not workspace_id or not scim_id:
            return None
        item = self._repository.get(
            {"workspace_id": workspace_id, "member_key": scim_user_key(scim_id)}, consistent=True
        )
        return None if item is None else ScimUserRow.model_validate(dict(item))

    def get_scim_user_by_name(self, workspace_id: str, user_name: str) -> ScimUserRow | None:
        """The directory user holding this `userName`, compared without case, or `None`."""
        if not workspace_id or not user_name.strip():
            return None
        item = self._repository.get(
            {"workspace_id": workspace_id, "member_key": scim_name_key(user_name)}, consistent=True
        )
        if item is None:
            return None
        return self.get_scim_user(workspace_id, str(item.get("scim_id", "")))

    def list_scim_users(
        self,
        workspace_id: str,
        *,
        external_id: str | None = None,
        email_lower: str | None = None,
        linked_user_id: str | None = None,
        limit: int = SCIM_SCAN_LIMIT,
    ) -> list[ScimUserRow]:
        """The workspace's directory users, oldest first, narrowed by any attribute given."""
        if not workspace_id:
            return []
        condition = None
        for name, value in (
            ("external_id", external_id),
            ("email_lower", email_lower),
            ("linked_user_id", linked_user_id),
        ):
            if value is None:
                continue
            clause = Attr(name).eq(value)
            condition = clause if condition is None else condition & clause
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("member_key").begins_with(SCIM_USER_PREFIX),
            filter_expression=condition,
            max_items=limit,
            consistent=True,
        )
        rows = [ScimUserRow.model_validate(dict(item)) for item in items]
        return sorted(rows, key=lambda row: (row.created, row.scim_id))

    def _scim_name_item(self, row: ScimUserRow) -> dict[str, Any]:
        """The row reserving a directory user's `userName`."""
        return {
            "workspace_id": row.workspace_id,
            "member_key": scim_name_key(row.user_name),
            "scim_id": row.scim_id,
        }

    def create_scim_user(self, row: ScimUserRow) -> ScimUserRow:
        """Store a new directory user with its `userName` reserved, raising `ScimNameTaken` on a duplicate."""
        try:
            self._repository.transact_write(
                [
                    self._repository.put_action(
                        as_item(row, member_key=scim_user_key(row.scim_id)),
                        condition=Attr("member_key").not_exists(),
                    ),
                    self._repository.put_action(self._scim_name_item(row), condition=Attr("member_key").not_exists()),
                ]
            )
        except TransactionCanceled as exc:
            raise ScimNameTaken(row.user_name) from exc
        return row

    def put_scim_user(self, row: ScimUserRow, *, previous_name: str | None = None) -> ScimUserRow:
        """Replace a directory user, moving its `userName` reservation when the name changed.

        Raises `ScimNameTaken` when the new name is already reserved by someone else.
        """
        item = as_item(row, member_key=scim_user_key(row.scim_id))
        if previous_name is None or scim_name_key(previous_name) == scim_name_key(row.user_name):
            self._repository.put(item)
            return row
        try:
            self._repository.transact_write(
                [
                    self._repository.put_action(item),
                    self._repository.delete_action(
                        {"workspace_id": row.workspace_id, "member_key": scim_name_key(previous_name)}
                    ),
                    self._repository.put_action(self._scim_name_item(row), condition=Attr("member_key").not_exists()),
                ]
            )
        except TransactionCanceled as exc:
            raise ScimNameTaken(row.user_name) from exc
        return row

    def delete_scim_user(self, row: ScimUserRow) -> None:
        """Remove a directory user, its `userName` reservation and its group memberships."""
        keys = [
            {"workspace_id": row.workspace_id, "member_key": scim_user_key(row.scim_id)},
            {"workspace_id": row.workspace_id, "member_key": scim_name_key(row.user_name)},
        ]
        keys.extend(
            {"workspace_id": row.workspace_id, "member_key": scim_member_key(member.team_id, member.scim_id)}
            for member in self.list_scim_memberships_for_user(row.workspace_id, row.scim_id)
        )
        self._repository.delete_many(keys)

    def get_scim_group(self, workspace_id: str, team_id: str) -> ScimGroupRow | None:
        """The directory group linked to this team, or `None`."""
        if not workspace_id or not team_id:
            return None
        item = self._repository.get(
            {"workspace_id": workspace_id, "member_key": scim_group_key(team_id)}, consistent=True
        )
        return None if item is None else ScimGroupRow.model_validate(dict(item))

    def list_scim_groups(self, workspace_id: str, *, limit: int = SCIM_SCAN_LIMIT) -> list[ScimGroupRow]:
        """Every directory group linked to a team in this workspace, oldest first."""
        if not workspace_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("member_key").begins_with(SCIM_GROUP_PREFIX),
            max_items=limit,
            consistent=True,
        )
        rows = [ScimGroupRow.model_validate(dict(item)) for item in items]
        return sorted(rows, key=lambda row: (row.created, row.team_id))

    def link_scim_group(self, row: ScimGroupRow) -> bool:
        """Link a directory group to its team, answering false when the team is already linked."""
        try:
            self._repository.put(
                as_item(row, member_key=scim_group_key(row.team_id)), condition=Attr("member_key").not_exists()
            )
        except ConditionFailed:
            return False
        return True

    def put_scim_group(self, row: ScimGroupRow) -> ScimGroupRow:
        """Replace a linked group's directory attributes."""
        self._repository.put(as_item(row, member_key=scim_group_key(row.team_id)))
        return row

    def delete_scim_group(self, workspace_id: str, team_id: str) -> None:
        """Unlink a directory group from its team, with every member row it held."""
        keys = [{"workspace_id": workspace_id, "member_key": scim_group_key(team_id)}]
        keys.extend(
            {"workspace_id": workspace_id, "member_key": scim_member_key(team_id, member.scim_id)}
            for member in self.list_scim_members(workspace_id, team_id)
        )
        self._repository.delete_many(keys)

    def list_scim_members(
        self, workspace_id: str, team_id: str, *, limit: int = SCIM_SCAN_LIMIT
    ) -> list[ScimMemberRow]:
        """Every directory member of the group linked to this team."""
        if not workspace_id or not team_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("member_key").begins_with(f"{SCIM_MEMBER_PREFIX}{team_id}#"),
            max_items=limit,
            consistent=True,
        )
        return [ScimMemberRow.model_validate(dict(item)) for item in items]

    def list_all_scim_members(self, workspace_id: str, *, limit: int = SCIM_SCAN_LIMIT) -> list[ScimMemberRow]:
        """Every directory member of every linked group, read once for a page of users."""
        if not workspace_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("member_key").begins_with(SCIM_MEMBER_PREFIX),
            max_items=limit,
            consistent=True,
        )
        return [ScimMemberRow.model_validate(dict(item)) for item in items]

    def list_scim_memberships_for_user(self, workspace_id: str, scim_id: str) -> list[ScimMemberRow]:
        """Every linked group this directory user is a member of."""
        if not workspace_id or not scim_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("member_key").begins_with(SCIM_MEMBER_PREFIX),
            filter_expression=Attr("scim_id").eq(scim_id),
            max_items=SCIM_SCAN_LIMIT,
            consistent=True,
        )
        return [ScimMemberRow.model_validate(dict(item)) for item in items]

    def get_scim_member(self, workspace_id: str, team_id: str, scim_id: str) -> ScimMemberRow | None:
        """One directory user's row in one linked group, or `None`."""
        item = self._repository.get(
            {"workspace_id": workspace_id, "member_key": scim_member_key(team_id, scim_id)}, consistent=True
        )
        return None if item is None else ScimMemberRow.model_validate(dict(item))

    def put_scim_member(self, row: ScimMemberRow) -> ScimMemberRow:
        """Record one directory user in one linked group."""
        self._repository.put(as_item(row, member_key=scim_member_key(row.team_id, row.scim_id)))
        return row

    def delete_scim_member(self, workspace_id: str, team_id: str, scim_id: str) -> None:
        """Forget one directory user in one linked group. Idempotent."""
        self._repository.delete({"workspace_id": workspace_id, "member_key": scim_member_key(team_id, scim_id)})

    def get_app_approval(self, workspace_id: str, client_id: str) -> AppApproval | None:
        """One third-party app's approval record in this workspace, or `None` when it has none."""
        if not workspace_id or not client_id:
            return None
        item = self._repository.get(
            {"workspace_id": workspace_id, "member_key": app_approval_key(client_id)}, consistent=True
        )
        return None if item is None else AppApproval.model_validate(dict(item))

    def put_app_approval(self, row: AppApproval) -> AppApproval:
        """Store one third-party app's approval record, replacing the earlier one."""
        self._repository.put(as_item(row, member_key=app_approval_key(row.client_id)))
        return row

    def list_app_approvals(self, workspace_id: str) -> list[AppApproval]:
        """Every third-party app approval record of this workspace, most recently updated first."""
        if not workspace_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("member_key").begins_with(APP_APPROVAL_PREFIX),
            max_items=APP_APPROVAL_LIMIT,
            consistent=True,
        )
        rows = [AppApproval.model_validate(dict(item)) for item in items]
        return sorted(rows, key=lambda row: row.updated_at, reverse=True)


def _as_membership(item: Mapping[str, Any]) -> Membership:
    """One stored item as a `Membership`."""
    return Membership.model_validate(dict(item))
