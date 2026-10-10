"""The `workspaces` table: the tenant every Standupless key is scoped to.

Slug uniqueness is enforced by a conditional create plus a read of `slug-index`.
DynamoDB has no unique constraint on a non-key attribute, so the index read
rejects a slug already taken and the condition on `id` rejects the id collision;
a simultaneous pair of creates on one slug is the residual race, and the loser is
reported as a conflict rather than silently overwriting.

This is the one repository whose reads are keyed by workspace id rather than
taking `workspace_id` first, because the id is the partition key.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from enum import StrEnum
from typing import Any, Mapping, Optional

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import ConditionFailed, Repository, new_ulid

from app.common.db.dynamo.base import as_item, build_repository, utc_now
from app.common.db.dynamo.tables import WORKSPACES


class Plan(StrEnum):
    """Every plan a workspace can be on."""

    FREE = "free"
    STANDARD = "standard"
    BUSINESS = "business"


class BillingInterval(StrEnum):
    """How often a paid plan is billed."""

    MONTH = "month"
    YEAR = "year"


DEFAULT_PLAN = Plan.FREE.value

BILLING_FIELDS = (
    "plan",
    "billing_interval",
    "stripe_customer_id",
    "stripe_subscription_id",
    "subscription_status",
    "billed_seats",
    "current_period_end",
    "cancel_at_period_end",
)
"""The attributes `set_billing` may write, and nothing else."""

COMP_FIELDS = ("comp_plan", "comp_reason", "comp_expires_at", "comp_granted_at")
"""The comp grant's attributes, written only by `set_comp_grant` and `clear_comp_grant`.

None is a billing field, so a Stripe webhook can never overwrite or clear a grant.
"""

PLAN_RANK = {plan.value: rank for rank, plan in enumerate(Plan)}
"""Each plan's tier, so the higher of a comp grant and a subscription wins."""

SLUG_INDEX = "slug-index"

SLUG_PATTERN = re.compile(r"^[a-z0-9-]{3,40}$")

ACCENT_COLOR_PATTERN = re.compile(r"^#[0-9a-f]{6}$")

DELETION_GRACE_DAYS = 14
"""How long a scheduled deletion waits before the purge, during which it can be cancelled."""

STALE_PURGE = timedelta(hours=12)
"""How long a started purge may go quiet before the sweep starts its chain again.

The chain is idempotent, so a restart only repeats finished deletes; this only
decides how soon a chain lost to a failed send is picked back up.
"""

DELETION_ATTRIBUTES = ("deletion_scheduled_at", "deletion_scheduled_by", "purge_after")


def new_workspace_id() -> str:
    """A fresh workspace id, time sortable so creation order survives the key."""
    return new_ulid()


def is_valid_slug(slug: str) -> bool:
    """Whether this slug is the lowercase, hyphenated form the contract requires."""
    return bool(SLUG_PATTERN.match(slug))


def normalize_accent_color(value: str) -> Optional[str]:
    """The accent as lowercase `#rrggbb`, or `None` when it is not one.

    A leading `#` may be left off, so a value pasted from a design tool is
    accepted, but shorthand and alpha forms are refused because the client
    derives its whole token scale from exactly six digits.
    """
    candidate = value.strip().lower()
    if not candidate.startswith("#"):
        candidate = f"#{candidate}"
    return candidate if ACCENT_COLOR_PATTERN.match(candidate) else None


class Workspace(BaseModel):
    """One tenant: its id, slug, display name, plan and billing state.

    The slug is the workspace's stable URL segment, unique across the product and
    indexed by `slug-index`, so a link survives a rename of the display name.
    `plan` is written only by the Stripe webhook; the billing fields mirror the
    subscription it last saw. The `comp_` fields are an internal grant of a plan
    with no subscription behind it, written only by the admin script, and
    `effective_plan` is the higher of the two. `project_update_interval_days` is
    the update cadence a project without its own follows, 0 for no reminders.
    """

    id: str = Field(default_factory=new_workspace_id)
    name: str
    slug: str
    plan: str = DEFAULT_PLAN
    billing_interval: Optional[str] = None
    stripe_customer_id: Optional[str] = None
    stripe_subscription_id: Optional[str] = None
    subscription_status: Optional[str] = None
    billed_seats: Optional[int] = None
    current_period_end: Optional[datetime] = None
    cancel_at_period_end: bool = False
    comp_plan: Optional[str] = None
    comp_reason: Optional[str] = None
    comp_expires_at: Optional[datetime] = None
    comp_granted_at: Optional[datetime] = None
    icon_key: Optional[str] = None
    accent_color: Optional[str] = None
    project_update_interval_days: int = 7
    created_at: datetime = Field(default_factory=utc_now)
    deletion_scheduled_at: Optional[datetime] = None
    deletion_scheduled_by: Optional[str] = None
    purge_after: Optional[datetime] = None
    purging_at: Optional[datetime] = None
    purge_member_ids: list[str] = Field(default_factory=list)

    def comp_active(self, now: datetime | None = None) -> bool:
        """Whether a comp grant naming a known plan holds right now, its expiry not yet reached."""
        if self.comp_plan not in PLAN_RANK:
            return False
        if self.comp_expires_at is None:
            return True
        expires = self.comp_expires_at
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        return expires > (now or utc_now())

    def effective_plan(self, now: datetime | None = None) -> str:
        """The plan every gate reads: the higher of the subscription's plan and a live comp grant."""
        plan = self.plan if self.plan in PLAN_RANK else DEFAULT_PLAN
        if self.comp_active(now) and PLAN_RANK[str(self.comp_plan)] > PLAN_RANK[plan]:
            return str(self.comp_plan)
        return plan

    @property
    def is_purging(self) -> bool:
        """Whether the purge has started, after which nothing can bring it back."""
        return self.purging_at is not None

    def is_due(self, now: datetime) -> bool:
        """Whether a scheduled deletion's grace period has run out."""
        return self.purge_after is not None and self.purge_after <= now


class WorkspaceRepository:
    """Reads and writes `workspaces` rows through the shared package repository."""

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = build_repository(WORKSPACES, repository)

    def get(self, workspace_id: str) -> Workspace | None:
        """The workspace with this id, or `None`."""
        if not workspace_id:
            return None
        item = self._repository.get({"id": workspace_id})
        return _as_workspace(item) if item is not None else None

    def get_by_slug(self, slug: str) -> Workspace | None:
        """The workspace holding this slug, or `None`, through `slug-index`."""
        normalized = slug.strip().lower()
        if not normalized:
            return None
        page = self._repository.query(Key("slug").eq(normalized), index_name=SLUG_INDEX, limit=1)
        if not page.items:
            return None
        return _as_workspace(page.items[0])

    def create(self, workspace: Workspace) -> Workspace:
        """Store a new workspace, raising `ConditionFailed` when the slug is taken.

        The index read rejects a slug already in use and the conditional put rejects
        an id collision, which together are the uniqueness the contract promises.
        """
        if self.get_by_slug(workspace.slug) is not None:
            raise ConditionFailed(WORKSPACES.suffix, "slug is already taken", {"slug": workspace.slug})
        self._repository.put(_without_unset_lifecycle(as_item(workspace)), condition=Attr("id").not_exists())
        return workspace

    def rename(self, workspace_id: str, name: str) -> Workspace | None:
        """Change a workspace's display name, or `None` when it does not exist."""
        key = {"id": workspace_id}
        try:
            item = self._repository.update(
                key,
                update_expression="SET #name = :name",
                expression_names={"#name": "name"},
                expression_values={":name": name},
                condition=Attr("id").exists(),
                return_values="ALL_NEW",
            )
        except ConditionFailed:
            return None
        return _as_workspace(item) if item is not None else None

    def set_icon(self, workspace_id: str, icon_key: Optional[str]) -> Workspace | None:
        """Point a workspace at a new icon object, or clear it with `None`.

        Returns `None` when the workspace does not exist, so a route can 404 and
        the caller can delete the object it was about to point at.
        """
        try:
            item = self._repository.set_attributes(
                {"id": workspace_id}, {"icon_key": icon_key}, condition=Attr("id").exists()
            )
        except ConditionFailed:
            return None
        return _as_workspace(item) if item is not None else None

    def set_accent_color(self, workspace_id: str, accent_color: Optional[str]) -> Workspace | None:
        """Set the workspace accent, or clear it back to the default with `None`.

        Returns `None` when the workspace does not exist, so the route can 404.
        """
        try:
            item = self._repository.set_attributes(
                {"id": workspace_id}, {"accent_color": accent_color}, condition=Attr("id").exists()
            )
        except ConditionFailed:
            return None
        return _as_workspace(item) if item is not None else None

    def set_project_update_interval(self, workspace_id: str, days: int) -> Workspace | None:
        """Set the workspace's default project update cadence, or `None` when it does not exist."""
        try:
            item = self._repository.set_attributes(
                {"id": workspace_id}, {"project_update_interval_days": days}, condition=Attr("id").exists()
            )
        except ConditionFailed:
            return None
        return _as_workspace(item) if item is not None else None

    def set_billing(self, workspace_id: str, **fields: Any) -> Workspace | None:
        """Write plan and billing fields onto a workspace, or `None` when it does not exist.

        Only `BILLING_FIELDS` are accepted, so a webhook cannot write anything else.
        """
        unknown = sorted(set(fields) - set(BILLING_FIELDS))
        if unknown:
            raise ValueError(f"not billing fields: {', '.join(unknown)}")
        if not fields:
            return self.get(workspace_id)
        values = {key: value.isoformat() if isinstance(value, datetime) else value for key, value in fields.items()}
        try:
            item = self._repository.set_attributes({"id": workspace_id}, values, condition=Attr("id").exists())
        except ConditionFailed:
            return None
        return _as_workspace(item) if item is not None else None

    def set_comp_grant(
        self,
        workspace_id: str,
        *,
        plan: str,
        reason: str,
        expires_at: Optional[datetime] = None,
        now: datetime | None = None,
    ) -> Workspace | None:
        """Grant a workspace `plan` with no subscription, or `None` when it does not exist.

        A grant with no expiry holds until `clear_comp_grant`. Raises `ValueError`
        for a plan that is not a paid one.
        """
        if plan not in PLAN_RANK or plan == DEFAULT_PLAN:
            raise ValueError(f"not a paid plan: {plan}")
        values: dict[str, Any] = {
            "comp_plan": plan,
            "comp_reason": reason,
            "comp_expires_at": expires_at.isoformat() if expires_at else None,
            "comp_granted_at": (now or utc_now()).isoformat(),
        }
        try:
            item = self._repository.set_attributes({"id": workspace_id}, values, condition=Attr("id").exists())
        except ConditionFailed:
            return None
        return _as_workspace(item) if item is not None else None

    def clear_comp_grant(self, workspace_id: str) -> Workspace | None:
        """Remove a workspace's comp grant, or `None` when it does not exist."""
        try:
            item = self._repository.update(
                {"id": workspace_id},
                update_expression="REMOVE " + ", ".join(f"#f{index}" for index in range(len(COMP_FIELDS))),
                expression_names={f"#f{index}": field for index, field in enumerate(COMP_FIELDS)},
                condition=Attr("id").exists(),
                return_values="ALL_NEW",
            )
        except ConditionFailed:
            return None
        return _as_workspace(item) if item is not None else None

    def delete(self, workspace_id: str) -> bool:
        """Hard-delete one workspace row, reporting whether one was there."""
        if self.get(workspace_id) is None:
            return False
        self._repository.delete({"id": workspace_id})
        return True

    def schedule_deletion(self, workspace_id: str, by: str, *, now: datetime | None = None) -> Workspace | None:
        """Schedule the workspace for purge after the grace period, keeping an earlier schedule.

        Idempotent: a second request leaves the first date in place, so repeating it
        never pushes the purge further out. `None` when the workspace is gone or its
        purge has already started.
        """
        moment = now or utc_now()
        try:
            item = self._repository.update(
                {"id": workspace_id},
                update_expression=(
                    "SET #at = if_not_exists(#at, :at), #by = if_not_exists(#by, :by), "
                    "#after = if_not_exists(#after, :after)"
                ),
                expression_names={
                    "#at": "deletion_scheduled_at",
                    "#by": "deletion_scheduled_by",
                    "#after": "purge_after",
                },
                expression_values={
                    ":at": moment.isoformat(),
                    ":by": by,
                    ":after": (moment + timedelta(days=DELETION_GRACE_DAYS)).isoformat(),
                },
                condition=Attr("id").exists() & Attr("purging_at").not_exists(),
                return_values="ALL_NEW",
            )
        except ConditionFailed:
            return None
        return _as_workspace(item) if item is not None else None

    def expedite_deletion(self, workspace_id: str, by: str, *, now: datetime | None = None) -> bool:
        """Make a workspace due for purge now, for one deleted along with its only member's account.

        Overwrites any later date, keeps an earlier schedule's author, and refuses a
        workspace whose purge has already started or that is gone.
        """
        moment = now or utc_now()
        try:
            self._repository.update(
                {"id": workspace_id},
                update_expression=("SET #at = if_not_exists(#at, :at), #by = if_not_exists(#by, :by), #after = :at"),
                expression_names={
                    "#at": "deletion_scheduled_at",
                    "#by": "deletion_scheduled_by",
                    "#after": "purge_after",
                },
                expression_values={":at": moment.isoformat(), ":by": by},
                condition=Attr("id").exists() & Attr("purging_at").not_exists(),
            )
        except ConditionFailed:
            return False
        return True

    def cancel_deletion(self, workspace_id: str) -> Workspace | None:
        """Clear a scheduled deletion, or `None` when the workspace is gone or already purging."""
        try:
            item = self._repository.update(
                {"id": workspace_id},
                update_expression="REMOVE #at, #by, #after",
                expression_names={
                    "#at": "deletion_scheduled_at",
                    "#by": "deletion_scheduled_by",
                    "#after": "purge_after",
                },
                condition=Attr("id").exists() & Attr("purging_at").not_exists(),
                return_values="ALL_NEW",
            )
        except ConditionFailed:
            return None
        return _as_workspace(item) if item is not None else None

    def list_scheduled(self) -> list[Workspace]:
        """Every workspace with a scheduled deletion or a purge under way.

        A scan, run by the hourly sweep alone; only rows carrying `purge_after`
        come back, and the table holds one row per tenant.
        """
        items = self._repository.iter_scan(filter_expression=Attr("purge_after").exists())
        return [_as_workspace(item) for item in items]

    def list_active(self) -> list[Workspace]:
        """Every workspace with no deletion scheduled and no purge under way.

        A scan, run by the project update reminder sweep alone; the table holds
        one row per tenant.
        """
        items = self._repository.iter_scan(filter_expression=Attr("purge_after").not_exists())
        return [_as_workspace(item) for item in items]

    def begin_purge(self, workspace_id: str, member_ids: list[str], *, now: datetime | None = None) -> bool:
        """Mark the purge as started, reporting whether this caller started it.

        Conditional on the grace period having run out and on no purge being under
        way, or one having gone quiet for longer than `STALE_PURGE`, so two sweeps
        never both start a chain and a cancelled deletion is never purged. The member
        ids are kept from the first start only, because the memberships are deleted
        straight after it and a restart would read none.
        """
        moment = now or utc_now()
        try:
            self._repository.update(
                {"id": workspace_id},
                update_expression="SET #purging = :now, #members = if_not_exists(#members, :members)",
                expression_names={"#purging": "purging_at", "#members": "purge_member_ids"},
                expression_values={":now": moment.isoformat(), ":members": member_ids},
                condition=Attr("purge_after").lte(moment.isoformat())
                & (Attr("purging_at").not_exists() | Attr("purging_at").lt((moment - STALE_PURGE).isoformat())),
            )
        except ConditionFailed:
            return False
        return True

    def delete_purged(self, workspace_id: str) -> bool:
        """Remove the row once its purge is finished, only while the purge mark is on it."""
        try:
            self._repository.delete({"id": workspace_id}, condition=Attr("purging_at").exists())
        except ConditionFailed:
            return False
        return True

    def get_many(self, workspace_ids: list[str]) -> dict[str, Workspace]:
        """The named workspaces keyed by id, skipping any that are gone.

        One `BatchGetItem` behind the workspace list, so showing a caller their
        memberships costs one call rather than one per membership.
        """
        wanted = [workspace_id for workspace_id in dict.fromkeys(workspace_ids) if workspace_id]
        if not wanted:
            return {}
        items = self._repository.batch_get([{"id": workspace_id} for workspace_id in wanted])
        return {str(item["id"]): _as_workspace(item) for item in items}


_LIFECYCLE_FIELDS = ("deletion_scheduled_at", "deletion_scheduled_by", "purge_after", "purging_at", "purge_member_ids")


def _without_unset_lifecycle(item: dict[str, Any]) -> dict[str, Any]:
    """Drop the deletion fields a new row has no value for.

    The schedule and the purge mark are written with `if_not_exists` and tested
    with `attribute_exists`, and a stored null counts as existing, so a row must
    leave them out entirely until they mean something.
    """
    return {key: value for key, value in item.items() if key not in _LIFECYCLE_FIELDS or value not in (None, [])}


def _as_workspace(item: Mapping[str, Any]) -> Workspace:
    """One stored item as a `Workspace`."""
    return Workspace.model_validate(dict(item))
