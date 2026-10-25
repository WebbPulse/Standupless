"""The statuses and tiers a workspace sets up for its customers, shared by the routes, MCP tools, export and importers.

Each workspace keeps two ordered lists, customer statuses and customer tiers,
each entry a name, an optional colour and a position. A workspace admin adds,
renames, recolours, reorders and deletes them in settings; deleting one that
customers hold moves those customers onto a replacement.

A workspace that never edited its lists reads seeded defaults: the five
statuses customers had before the lists were configurable, whose ids are the
old status values, and one tier per distinct tier string its customers carry,
whose id is derived from the string. A customer written before then keeps its
legacy `status` and `tier` strings, and `CustomerFields.status_of` and
`tier_of` map them onto the entries at read time, so no row is migrated. The
first write that needs the lists stores the seeded entries with a marker, after
which an emptied list stays empty.

`load_customer_fields` never writes, so the read-only images that carry the
customers repository, such as issue filtering, call it as freely as the
planning image does.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Iterable, Optional, cast

from fastapi import HTTPException, status
from webbpulse.dynamodb import ConditionFailed

from app.common import audit
from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.customer_fields import (
    CUSTOMER_FIELD_NAME_MAX,
    CustomerFieldCreate,
    CustomerFieldRead,
    CustomerFieldUpdate,
)
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.customers import (
    CUSTOMER_STATUS,
    CUSTOMER_TIER,
    Customer,
    CustomerFieldKind,
    CustomerFieldRow,
    customer_field_key,
    new_customer_id,
)
from app.common.labels import name_key
from app.common.planning_rules import forbidden, not_found, unprocessable

STATUS = CUSTOMER_STATUS

TIER = CUSTOMER_TIER

KINDS: tuple[str, ...] = (STATUS, TIER)

LABELS: dict[str, str] = {STATUS: "customer status", TIER: "customer tier"}
"""How an error message names each kind."""

DEFAULT_STATUSES: tuple[tuple[str, str, str], ...] = (
    ("lead", "Lead", "#8a8f98"),
    ("trial", "Trial", "#5e6ad2"),
    ("active", "Active", "#4cb782"),
    ("paused", "Paused", "#f2c94c"),
    ("churned", "Churned", "#eb5757"),
)
"""The seeded statuses as id, name and colour, the ids being the values a customer's `status` held before."""

SEEDED_BY = "system"


def legacy_tier_id(tier: str) -> str:
    """The seeded tier id a legacy tier string maps to, the same in every process and across renames."""
    digest = hashlib.sha256(name_key(tier).encode("utf-8")).hexdigest()
    return f"tier_{digest[:20]}"


@dataclass
class CustomerFields:
    """A workspace's customer statuses and tiers by position, with the lookups every reader needs."""

    statuses: list[CustomerFieldRow] = field(default_factory=list)
    tiers: list[CustomerFieldRow] = field(default_factory=list)
    stored: bool = False

    def rows(self, kind: str) -> list[CustomerFieldRow]:
        """The entries of one kind."""
        return self.statuses if kind == STATUS else self.tiers

    def find(self, kind: str, field_id: Optional[str]) -> Optional[CustomerFieldRow]:
        """The entry of one kind with this id, or None."""
        if not field_id:
            return None
        for row in self.rows(kind):
            if row.field_id == field_id:
                return row
        return None

    def resolve(self, kind: str, value: Optional[str]) -> Optional[CustomerFieldRow]:
        """The entry a value names, by id first and then by name ignoring case, or None."""
        if value is None:
            return None
        candidate = value.strip()
        if not candidate:
            return None
        exact = self.find(kind, candidate)
        if exact is not None:
            return exact
        wanted = name_key(candidate)
        for row in self.rows(kind):
            if name_key(row.name) == wanted:
                return row
        return None

    def status_of(self, customer: Customer) -> Optional[CustomerFieldRow]:
        """The status a customer holds: its `status_id`, else its legacy `status` value, by id then name."""
        if customer.status_id:
            return self.find(STATUS, customer.status_id)
        return self.resolve(STATUS, customer.status)

    def tier_of(self, customer: Customer) -> Optional[CustomerFieldRow]:
        """The tier a customer holds: its `tier_id`, else its legacy `tier` string's seeded id, then its name."""
        if customer.tier_id:
            return self.find(TIER, customer.tier_id)
        if not customer.tier:
            return None
        return self.find(TIER, legacy_tier_id(customer.tier)) or self.resolve(TIER, customer.tier)

    def holder_of(self, kind: str, customer: Customer) -> Optional[CustomerFieldRow]:
        """The entry of one kind a customer holds."""
        return self.status_of(customer) if kind == STATUS else self.tier_of(customer)


def _seed_row(
    workspace_id: str, kind: str, field_id: str, name: str, color: Optional[str], position: int
) -> CustomerFieldRow:
    """One seeded entry, dated now."""
    now = utc_now()
    return CustomerFieldRow(
        workspace_id=workspace_id,
        planning_key=customer_field_key(kind, field_id),
        kind=cast(CustomerFieldKind, kind),
        field_id=field_id,
        name=name,
        color=color,
        position=position,
        created_by=SEEDED_BY,
        created_at=now,
        updated_at=now,
    )


def default_statuses(workspace_id: str) -> list[CustomerFieldRow]:
    """The five seeded customer statuses."""
    return [
        _seed_row(workspace_id, STATUS, field_id, name, color, position)
        for position, (field_id, name, color) in enumerate(DEFAULT_STATUSES)
    ]


def default_tiers(workspace_id: str, customers: Iterable[Customer]) -> list[CustomerFieldRow]:
    """One seeded tier per distinct legacy tier string the customers carry, by name."""
    names: dict[str, str] = {}
    for customer in customers:
        if customer.tier_id or not customer.tier or not customer.tier.strip():
            continue
        names.setdefault(legacy_tier_id(customer.tier), customer.tier.strip())
    ordered = sorted(names.items(), key=lambda item: (item[1].casefold(), item[0]))
    return [
        _seed_row(workspace_id, TIER, field_id, name, None, position)
        for position, (field_id, name) in enumerate(ordered)
    ]


def _merged(seeded: list[CustomerFieldRow], stored: list[CustomerFieldRow]) -> list[CustomerFieldRow]:
    """The seeded entries with any stored row of the same id in their place, by position."""
    by_id = {row.field_id: row for row in seeded}
    by_id.update({row.field_id: row for row in stored})
    return sorted(by_id.values(), key=lambda row: (row.position, row.name.casefold(), row.field_id))


def load_customer_fields(
    repositories: Repositories, workspace_id: str, customers: Optional[list[Customer]] = None
) -> CustomerFields:
    """A workspace's customer statuses and tiers, the seeded entries standing in before any edit. Never writes.

    `customers` saves the listing a caller already read; it is only consulted to
    seed tiers, before the workspace stored its own.
    """
    store = repositories.customers
    statuses = store.list_fields(workspace_id, STATUS)
    tiers = store.list_fields(workspace_id, TIER)
    if store.fields_seeded(workspace_id):
        return CustomerFields(statuses=statuses, tiers=tiers, stored=True)
    rows = customers if customers is not None else store.list_customers(workspace_id)
    return CustomerFields(
        statuses=_merged(default_statuses(workspace_id), statuses),
        tiers=_merged(default_tiers(workspace_id, rows), tiers),
    )


def materialise_customer_fields(repositories: Repositories, workspace_id: str) -> CustomerFields:
    """The workspace's customer statuses and tiers, storing the seeded entries first when it has not yet.

    Seeded ids are fixed, so two first writes racing store the same rows and
    each keeps whichever landed.
    """
    loaded = load_customer_fields(repositories, workspace_id)
    if loaded.stored:
        return loaded
    for row in [*loaded.statuses, *loaded.tiers]:
        try:
            repositories.customers.put_field(row, create=True)
        except ConditionFailed:
            continue
    repositories.customers.mark_fields_seeded(workspace_id)
    return load_customer_fields(repositories, workspace_id)


def _counts(fields: CustomerFields, kind: str, customers: Iterable[Customer]) -> dict[str, int]:
    """How many customers hold each entry of one kind."""
    counts: dict[str, int] = {}
    for customer in customers:
        row = fields.holder_of(kind, customer)
        if row is not None:
            counts[row.field_id] = counts.get(row.field_id, 0) + 1
    return counts


def list_customer_fields(repositories: Repositories, context: AuthzContext, kind: str) -> list[CustomerFieldRead]:
    """The workspace's customer statuses or tiers by position, each with how many customers hold it.

    Customers are no guest's to read, so neither are their statuses and tiers.
    """
    if context.is_guest:
        raise forbidden()
    customers = repositories.customers.list_customers(context.workspace_id)
    fields = load_customer_fields(repositories, context.workspace_id, customers)
    counts = _counts(fields, kind, customers)
    return [CustomerFieldRead.from_row(row, customer_count=counts.get(row.field_id, 0)) for row in fields.rows(kind)]


def _require_admin(context: AuthzContext) -> None:
    """Hold that the caller administers the workspace, a credential carrying `admin` included, or 403."""
    if not context.acts_as_workspace_admin:
        raise forbidden()


def _conflict(kind: str, name: str) -> HTTPException:
    """The 409 a name another entry of the same kind holds gets."""
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={
            "error_code": "CONFLICT",
            "message": f"A {LABELS[kind]} named {name} already exists",
            "details": {"name": name},
        },
    )


def _check_unique(rows: Iterable[CustomerFieldRow], kind: str, name: str, exclude: Optional[str] = None) -> None:
    """Refuse with a 409 a name another entry of the kind already holds."""
    wanted = name_key(name)
    for row in rows:
        if row.field_id != exclude and name_key(row.name) == wanted:
            raise _conflict(kind, name.strip())


def _place(
    repositories: Repositories, rows: list[CustomerFieldRow], moved: CustomerFieldRow, position: Optional[int]
) -> CustomerFieldRow:
    """Put an entry at a position, renumbering the others of its kind so they stay in order."""
    others = [row for row in rows if row.field_id != moved.field_id]
    index = len(others) if position is None else max(0, min(position, len(others)))
    ordered = [*others[:index], moved, *others[index:]]
    now = utc_now()
    placed = moved
    for number, row in enumerate(ordered):
        if row.field_id == moved.field_id:
            placed = row.model_copy(update={"position": number})
            continue
        if row.position != number:
            repositories.customers.put_field(
                row.model_copy(update={"position": number, "updated_at": now}), create=False
            )
    return placed


def _snapshot(row: CustomerFieldRow) -> dict[str, object]:
    """The audited shape of one entry."""
    return {"name": row.name, "color": row.color, "position": row.position}


def create_customer_field(
    repositories: Repositories, context: AuthzContext, kind: str, payload: CustomerFieldCreate
) -> CustomerFieldRead:
    """Add a customer status or tier, as a workspace admin, or 409 when its name is taken."""
    _require_admin(context)
    fields = materialise_customer_fields(repositories, context.workspace_id)
    rows = fields.rows(kind)
    _check_unique(rows, kind, payload.name)
    field_id = new_customer_id()
    row = CustomerFieldRow(
        workspace_id=context.workspace_id,
        planning_key=customer_field_key(kind, field_id),
        kind=cast(CustomerFieldKind, kind),
        field_id=field_id,
        name=payload.name,
        color=payload.color,
        created_by=context.user_id,
    )
    row = _place(repositories, rows, row, payload.position)
    try:
        repositories.customers.put_field(row, create=True)
    except ConditionFailed as exc:
        raise _conflict(kind, payload.name) from exc
    audit.record(
        repositories,
        context,
        f"{kind}.created",
        target_type=kind,
        target_id=row.field_id,
        target_label=row.name,
        after=_snapshot(row),
    )
    return CustomerFieldRead.from_row(row)


def _editable(
    repositories: Repositories, context: AuthzContext, kind: str, field_id: str
) -> tuple[CustomerFields, CustomerFieldRow]:
    """The stored lists with the entry about to change, once the caller is held to admin, or a 404."""
    _require_admin(context)
    fields = materialise_customer_fields(repositories, context.workspace_id)
    existing = fields.find(kind, field_id)
    if existing is None:
        raise not_found()
    return fields, existing


def update_customer_field(
    repositories: Repositories, context: AuthzContext, kind: str, field_id: str, payload: CustomerFieldUpdate
) -> CustomerFieldRead:
    """Rename, recolour or reorder a customer status or tier, as a workspace admin; a null colour clears it."""
    fields, existing = _editable(repositories, context, kind, field_id)
    rows = fields.rows(kind)
    given = payload.model_dump(exclude_unset=True)
    changes: dict[str, object] = {}
    if given.get("name") is not None and given["name"] != existing.name:
        if name_key(given["name"]) != name_key(existing.name):
            _check_unique(rows, kind, given["name"], field_id)
        changes["name"] = given["name"]
    if "color" in given and given["color"] != existing.color:
        changes["color"] = given["color"]
    updated = existing.model_copy(update=changes)
    if given.get("position") is not None and given["position"] != existing.position:
        updated = _place(repositories, rows, updated, given["position"])
    customers = repositories.customers.list_customers(context.workspace_id)
    if updated == existing:
        return CustomerFieldRead.from_row(existing, customer_count=_counts(fields, kind, customers).get(field_id, 0))
    updated = updated.model_copy(update={"updated_at": utc_now()})
    try:
        repositories.customers.put_field(updated, create=False)
    except ConditionFailed as exc:
        raise not_found() from exc
    audit.record(
        repositories,
        context,
        f"{kind}.updated",
        target_type=kind,
        target_id=field_id,
        target_label=updated.name,
        before=_snapshot(existing),
        after=_snapshot(updated),
    )
    return CustomerFieldRead.from_row(updated, customer_count=_counts(fields, kind, customers).get(field_id, 0))


def _holds(fields: CustomerFields, kind: str, customer: Customer, field_id: str) -> bool:
    """Whether a customer holds the entry of one kind with this id."""
    row = fields.holder_of(kind, customer)
    return row is not None and row.field_id == field_id


def delete_customer_field(
    repositories: Repositories,
    context: AuthzContext,
    kind: str,
    field_id: str,
    replacement_id: Optional[str] = None,
) -> int:
    """Delete a customer status or tier, as a workspace admin, moving its customers onto a replacement.

    An entry no customer holds goes without one. An entry customers hold needs
    `replacement_id`, another entry of the same kind, or answers 422, so a
    customer never silently loses its status or tier. Answers how many moved.
    """
    fields, existing = _editable(repositories, context, kind, field_id)
    replacement: Optional[CustomerFieldRow] = None
    if replacement_id is not None:
        replacement = fields.find(kind, replacement_id)
        if replacement is None or replacement.field_id == field_id:
            raise unprocessable(f"replacement_id must name another {LABELS[kind]}")
    customers = repositories.customers.list_customers(context.workspace_id)
    holders = [customer for customer in customers if _holds(fields, kind, customer, field_id)]
    if holders and replacement is None:
        raise unprocessable(
            f"{len(holders)} customers hold this {LABELS[kind]}; give replacement_id to move them first"
        )
    moved = 0
    now = utc_now()
    for customer in holders if replacement is not None else []:
        if kind == STATUS:
            update: dict[str, object] = {"status_id": replacement.field_id, "status": None}
        else:
            update = {"tier_id": replacement.field_id, "tier": None}
        try:
            repositories.customers.replace(customer.model_copy(update={**update, "updated_at": now}))
        except ConditionFailed:
            continue
        moved += 1
    repositories.customers.delete_field(context.workspace_id, kind, field_id)
    remaining = [row for row in fields.rows(kind) if row.field_id != field_id]
    for number, row in enumerate(remaining):
        if row.position != number:
            repositories.customers.put_field(row.model_copy(update={"position": number}), create=False)
    audit.record(
        repositories,
        context,
        f"{kind}.deleted",
        target_type=kind,
        target_id=field_id,
        target_label=existing.name,
        before=_snapshot(existing),
        after={"replacement_id": replacement.field_id if replacement else None, "moved": moved},
    )
    return moved


def find_or_create_customer_field(
    repositories: Repositories,
    workspace_id: str,
    kind: str,
    name: str,
    *,
    created_by: str,
    color: Optional[str] = None,
    fields: Optional[CustomerFields] = None,
) -> CustomerFieldRow:
    """The entry of one kind with this name, created when the workspace has none, for importers.

    An importer maps another tool's tiers and statuses onto the workspace's
    lists this way: a name already set up is reused, ignoring case, and a new
    one lands last. It runs with the importer's own rights rather than an
    admin's, because the import as a whole was already authorised. `fields`
    lets a caller mapping many customers reuse one materialised read, which
    this keeps current.
    """
    loaded = fields if fields is not None else materialise_customer_fields(repositories, workspace_id)
    found = loaded.resolve(kind, name)
    if found is not None:
        return found
    rows = loaded.rows(kind)
    field_id = new_customer_id()
    row = CustomerFieldRow(
        workspace_id=workspace_id,
        planning_key=customer_field_key(kind, field_id),
        kind=cast(CustomerFieldKind, kind),
        field_id=field_id,
        name=name.strip()[:CUSTOMER_FIELD_NAME_MAX],
        color=color,
        position=len(rows),
        created_by=created_by,
    )
    repositories.customers.put_field(row, create=True)
    rows.append(row)
    return row
