"""Customer rows in the `planning` table: the companies a workspace builds for and what they asked for.

A customer lives in the workspace partition in three row shapes:

- `customer#<customer>` is the customer: name, domains, status, tier, owner,
  revenue and size. The workspace's customers are one query under `customer#`.
- `customer_request#<customer>#<request>` is one request, a customer asking for
  an issue or a project, with an optional quote and an important flag. A customer's requests are one
  query, and the workspace's are one query under `customer_request#`.
- `customer_target#<target_kind>#<target>#<request>` is a copy of the request
  under the issue or project it names, so a target's requests are one query.
- `customer_status#<status>` and `customer_tier#<tier>` are the statuses and
  tiers a workspace admin sets up for its customers, each one query under its
  prefix, and `customer_fields#seeded` marks that the seeded defaults were stored.

The `customer#` prefix never matches the others, whose next character after
`customer` is an underscore. The customer and the target copy pass the planning
stream filters, which the integrations stream consumer reads to send customer and
customer request webhooks; the status and tier rows do not.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import Repository, new_ulid

from app.common.db.dynamo.base import build_repository, utc_now
from app.common.db.dynamo.tables import PLANNING

CUSTOMER = "customer"

CUSTOMER_REQUEST = "customer_request"

CUSTOMER_TARGET = "customer_target"

CUSTOMER_KEY_PREFIX = "customer#"

CUSTOMER_REQUEST_KEY_PREFIX = "customer_request#"

CUSTOMER_REQUESTS_KEY_END = "customer_request$"
"""The first sort key past every request row, `$` sorting just after `#`, closing the customers and requests range."""

TargetKind = Literal["issue", "project"]

TARGET_KINDS: tuple[str, ...] = ("issue", "project")

CUSTOMER_STATUS = "customer_status"

CUSTOMER_TIER = "customer_tier"

CUSTOMER_FIELDS_SEEDED = "customer_fields_seeded"

CUSTOMER_FIELDS_SEEDED_KEY = "customer_fields#seeded"

CustomerFieldKind = Literal["customer_status", "customer_tier"]

CUSTOMER_STATUSES: tuple[str, ...] = ("lead", "trial", "active", "paused", "churned")
"""The lifecycle every workspace starts with, whose ids are these legacy values, in the order a list groups them."""

LIST_MAX = 2000
"""The most customers, or requests, one workspace listing reads."""


def customer_key(customer_id: str) -> str:
    """The sort key of one customer row."""
    return f"{CUSTOMER_KEY_PREFIX}{customer_id}"


def customer_request_prefix(customer_id: str) -> str:
    """The sort key prefix every request of one customer shares."""
    return f"{CUSTOMER_REQUEST_KEY_PREFIX}{customer_id}#"


def customer_request_key(customer_id: str, request_id: str) -> str:
    """The sort key of one request row under its customer."""
    return f"{customer_request_prefix(customer_id)}{request_id}"


def customer_target_prefix(target_kind: str, target_id: str) -> str:
    """The sort key prefix every request copy under one issue or project shares."""
    return f"{CUSTOMER_TARGET}#{target_kind}#{target_id}#"


def customer_target_key(target_kind: str, target_id: str, request_id: str) -> str:
    """The sort key of one request copy under its target."""
    return f"{customer_target_prefix(target_kind, target_id)}{request_id}"


def customer_field_prefix(kind: str) -> str:
    """The sort key prefix every customer status, or every customer tier, shares."""
    return f"{kind}#"


def customer_field_key(kind: str, field_id: str) -> str:
    """The sort key of one customer status or tier row."""
    return f"{customer_field_prefix(kind)}{field_id}"


def new_customer_id() -> str:
    """A fresh, time ordered customer or request id."""
    return new_ulid()


class Customer(BaseModel):
    """One customer of the workspace."""

    workspace_id: str
    planning_key: str = ""
    customer_id: str = Field(default_factory=new_customer_id)
    kind: str = CUSTOMER
    name: str
    domains: list[str] = Field(default_factory=list)
    status_id: str | None = None
    tier_id: str | None = None
    status: str | None = None
    tier: str | None = None
    owner_id: str | None = None
    revenue: int | None = None
    size: int | None = None
    created_by: str
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)

    def model_post_init(self, _context: Any) -> None:
        """Derive the sort key from the id when none was given."""
        if not self.planning_key:
            self.planning_key = customer_key(self.customer_id)


class CustomerFieldRow(BaseModel):
    """One customer status or tier a workspace set up, told apart by `kind`.

    A customer written before statuses and tiers were configurable keeps its
    legacy `status` and `tier` strings, which `app.common.customer_fields` maps
    onto these rows at read time.
    """

    workspace_id: str
    planning_key: str = ""
    kind: CustomerFieldKind
    field_id: str = Field(default_factory=new_ulid)
    name: str
    color: str | None = None
    position: int = 0
    created_by: str
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)

    def model_post_init(self, _context: Any) -> None:
        """Derive the sort key from the kind and id when none was given."""
        if not self.planning_key:
            self.planning_key = customer_field_key(self.kind, self.field_id)


class CustomerRequest(BaseModel):
    """One request: a customer asking for an issue or a project, with an optional quote.

    The same fields are written twice, once under the customer and once under the
    target; `kind` and `planning_key` tell the two copies apart.
    """

    workspace_id: str
    planning_key: str = ""
    request_id: str = Field(default_factory=new_customer_id)
    kind: str = CUSTOMER_REQUEST
    customer_id: str
    target_kind: TargetKind
    target_id: str
    team_ids: list[str] = Field(default_factory=list)
    body: str = ""
    important: bool = False
    author_id: str
    source: str | None = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime | None = None

    def model_post_init(self, _context: Any) -> None:
        """Derive the sort key from the kind, customer, target and id when none was given."""
        if not self.planning_key:
            if self.kind == CUSTOMER_TARGET:
                self.planning_key = customer_target_key(self.target_kind, self.target_id, self.request_id)
            else:
                self.planning_key = customer_request_key(self.customer_id, self.request_id)

    def as_target_copy(self) -> "CustomerRequest":
        """The copy of this request kept under its target."""
        return self.model_copy(
            update={
                "kind": CUSTOMER_TARGET,
                "planning_key": customer_target_key(self.target_kind, self.target_id, self.request_id),
            }
        )

    def as_customer_row(self) -> "CustomerRequest":
        """The row of this request kept under its customer."""
        return self.model_copy(
            update={
                "kind": CUSTOMER_REQUEST,
                "planning_key": customer_request_key(self.customer_id, self.request_id),
            }
        )


def _key(workspace_id: str, planning_key: str) -> dict[str, str]:
    """The primary key of one planning row."""
    return {"workspace_id": workspace_id, "planning_key": planning_key}


class CustomerRepository:
    """Reads and writes customer and customer request rows, every method workspace first."""

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build the planning table's own."""
        self._repository = build_repository(PLANNING, repository)

    def get(self, workspace_id: str, customer_id: str) -> Customer | None:
        """One customer, or `None`."""
        if not workspace_id or not customer_id:
            return None
        item = self._repository.get(_key(workspace_id, customer_key(customer_id)))
        if item is None or item.get("kind") != CUSTOMER:
            return None
        return Customer.model_validate(dict(item))

    def list_customers(self, workspace_id: str, *, max_items: int = LIST_MAX) -> list[Customer]:
        """Every customer of the workspace, oldest first."""
        if not workspace_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("planning_key").begins_with(CUSTOMER_KEY_PREFIX),
            max_items=max_items,
        )
        return [Customer.model_validate(dict(item)) for item in items if item.get("kind") == CUSTOMER]

    def create(self, customer: Customer) -> Customer:
        """Store a new customer, raising `ConditionFailed` when the id is taken."""
        self._repository.put(customer.model_dump(mode="json"), condition=Attr("planning_key").not_exists())
        return customer

    def replace(self, customer: Customer) -> Customer:
        """Write an edited customer over its row, raising `ConditionFailed` when it went away."""
        self._repository.put(customer.model_dump(mode="json"), condition=Attr("planning_key").exists())
        return customer

    def delete(self, workspace_id: str, customer_id: str) -> int:
        """Remove one customer with its requests and their copies, returning how many requests went."""
        requests = self.list_for_customer(workspace_id, customer_id)
        keys = [_key(workspace_id, request.planning_key) for request in requests]
        keys.extend(
            _key(workspace_id, customer_target_key(request.target_kind, request.target_id, request.request_id))
            for request in requests
        )
        keys.append(_key(workspace_id, customer_key(customer_id)))
        self._repository.delete_many(keys)
        return len(requests)

    def list_fields(self, workspace_id: str, kind: str) -> list[CustomerFieldRow]:
        """Every stored customer status, or every stored tier, of the workspace by position."""
        if not workspace_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("planning_key").begins_with(customer_field_prefix(kind)),
            max_items=LIST_MAX,
        )
        rows = [CustomerFieldRow.model_validate(dict(item)) for item in items if item.get("kind") == kind]
        rows.sort(key=lambda row: (row.position, row.name.casefold(), row.field_id))
        return rows

    def put_field(self, row: CustomerFieldRow, *, create: bool) -> CustomerFieldRow:
        """Store a customer status or tier, raising `ConditionFailed` on a taken id or, for an edit, a gone row."""
        condition = Attr("planning_key").not_exists() if create else Attr("planning_key").exists()
        self._repository.put(row.model_dump(mode="json"), condition=condition)
        return row

    def delete_field(self, workspace_id: str, kind: str, field_id: str) -> None:
        """Remove one customer status or tier row."""
        self._repository.delete(_key(workspace_id, customer_field_key(kind, field_id)))

    def fields_seeded(self, workspace_id: str) -> bool:
        """Whether the workspace stored its seeded statuses and tiers, so an emptied list stays empty."""
        if not workspace_id:
            return False
        item = self._repository.get(_key(workspace_id, CUSTOMER_FIELDS_SEEDED_KEY))
        return item is not None and item.get("kind") == CUSTOMER_FIELDS_SEEDED

    def mark_fields_seeded(self, workspace_id: str) -> None:
        """Record that the seeded statuses and tiers are stored."""
        self._repository.put(
            {
                "workspace_id": workspace_id,
                "planning_key": CUSTOMER_FIELDS_SEEDED_KEY,
                "kind": CUSTOMER_FIELDS_SEEDED,
                "created_at": utc_now().isoformat(),
            }
        )

    def add_request(self, request: CustomerRequest) -> CustomerRequest:
        """Store a new request under its customer and its target."""
        row = request.as_customer_row()
        self._repository.put(row.model_dump(mode="json"), condition=Attr("planning_key").not_exists())
        self._repository.put(row.as_target_copy().model_dump(mode="json"))
        return row

    def get_request(self, workspace_id: str, customer_id: str, request_id: str) -> CustomerRequest | None:
        """One request under its customer, or `None`."""
        if not workspace_id or not customer_id or not request_id:
            return None
        item = self._repository.get(_key(workspace_id, customer_request_key(customer_id, request_id)))
        if item is None or item.get("kind") != CUSTOMER_REQUEST:
            return None
        return CustomerRequest.model_validate(dict(item))

    def delete_request(self, request: CustomerRequest) -> None:
        """Remove one request and its copy under the target."""
        self._repository.delete_many(
            [
                _key(request.workspace_id, customer_request_key(request.customer_id, request.request_id)),
                _key(
                    request.workspace_id,
                    customer_target_key(request.target_kind, request.target_id, request.request_id),
                ),
            ]
        )

    def replace_request(self, previous: CustomerRequest, edited: CustomerRequest) -> CustomerRequest:
        """Write an edited request under its customer and target, dropping the old rows a move left behind."""
        row = edited.as_customer_row()
        self._repository.put(row.model_dump(mode="json"))
        self._repository.put(row.as_target_copy().model_dump(mode="json"))
        stale = []
        if previous.customer_id != row.customer_id:
            stale.append(_key(previous.workspace_id, customer_request_key(previous.customer_id, previous.request_id)))
        if (previous.target_kind, previous.target_id) != (row.target_kind, row.target_id):
            stale.append(
                _key(
                    previous.workspace_id,
                    customer_target_key(previous.target_kind, previous.target_id, previous.request_id),
                )
            )
        if stale:
            self._repository.delete_many(stale)
        return row

    def list_for_customer(
        self, workspace_id: str, customer_id: str, *, max_items: int = LIST_MAX
    ) -> list[CustomerRequest]:
        """Every request of one customer, oldest first."""
        if not workspace_id or not customer_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id)
            & Key("planning_key").begins_with(customer_request_prefix(customer_id)),
            max_items=max_items,
        )
        return [CustomerRequest.model_validate(dict(item)) for item in items if item.get("kind") == CUSTOMER_REQUEST]

    def list_for_target(
        self, workspace_id: str, target_kind: str, target_id: str, *, max_items: int = LIST_MAX
    ) -> list[CustomerRequest]:
        """Every request naming one issue or project, oldest first."""
        if not workspace_id or not target_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id)
            & Key("planning_key").begins_with(customer_target_prefix(target_kind, target_id)),
            max_items=max_items,
        )
        return [
            CustomerRequest.model_validate(dict(item)).as_customer_row()
            for item in items
            if item.get("kind") == CUSTOMER_TARGET
        ]

    def list_requests(self, workspace_id: str, *, max_items: int = LIST_MAX) -> list[CustomerRequest]:
        """Every request of the workspace, grouped by customer."""
        if not workspace_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("planning_key").begins_with(CUSTOMER_REQUEST_KEY_PREFIX),
            max_items=max_items,
        )
        return [CustomerRequest.model_validate(dict(item)) for item in items if item.get("kind") == CUSTOMER_REQUEST]

    def list_customers_and_requests(
        self, workspace_id: str, *, max_items: int = 2 * LIST_MAX
    ) -> tuple[list[Customer], list[CustomerRequest]]:
        """Every customer and every request of the workspace from one query.

        The customer rows sort under `customer#` and the requests under
        `customer_request#`, adjacent in the partition with only the
        `customer_fields#` marker between them, so one key range reads both and a
        list filtering by customer fields pays one query rather than two.
        """
        if not workspace_id:
            return [], []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id)
            & Key("planning_key").between(CUSTOMER_KEY_PREFIX, CUSTOMER_REQUESTS_KEY_END),
            max_items=max_items,
        )
        customers: list[Customer] = []
        requests: list[CustomerRequest] = []
        for item in items:
            if item.get("kind") == CUSTOMER:
                customers.append(Customer.model_validate(dict(item)))
            elif item.get("kind") == CUSTOMER_REQUEST:
                requests.append(CustomerRequest.model_validate(dict(item)))
        return customers, requests

    def move_requests(self, workspace_id: str, source_id: str, target_id: str) -> int:
        """Move every request of one customer onto another, returning how many moved."""
        requests = self.list_for_customer(workspace_id, source_id)
        for request in requests:
            moved = request.model_copy(
                update={
                    "customer_id": target_id,
                    "planning_key": customer_request_key(target_id, request.request_id),
                }
            )
            self._repository.put(moved.model_dump(mode="json"))
            self._repository.put(moved.as_target_copy().model_dump(mode="json"))
        if requests:
            self._repository.delete_many(
                [_key(workspace_id, customer_request_key(source_id, request.request_id)) for request in requests]
            )
        return len(requests)
