"""Which customers asked for each issue and project, for the list filters and sorts.

A list filtering by customer, or ordering by how many requests a row carries,
needs every request of the workspace at once. One query under
`customer_request#` reads them all, and the revenue sort adds one query for the
customers themselves, so a list pays for neither unless it asks.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Mapping, Optional

from app.common.planning_rules import forbidden

if TYPE_CHECKING:
    from app.common.api.dependencies.authz import AuthzContext
    from app.common.api.dependencies.repositories import Repositories

CUSTOMER_SORTS: frozenset[str] = frozenset(
    {"customer_requests_desc", "customer_important_desc", "customer_revenue_desc"}
)
"""The issue list sorts that read the customer index."""

IMPORTANT_SORT = "customer_important_desc"
"""The sort by how many requests naming a row are marked important."""

IMPORTANT = "important"
"""The customer filter value that stands for any request marked important."""

REVENUE_SORT = "customer_revenue_desc"
"""The one sort that also needs each customer's revenue."""

Target = tuple[str, str]
"""A request's target: its kind, `issue` or `project`, and its id."""


@dataclass(frozen=True)
class CustomerIndex:
    """Every request of a workspace folded by target, with each customer's revenue when it was read."""

    customers: Mapping[Target, frozenset[str]] = field(default_factory=dict)
    counts: Mapping[Target, int] = field(default_factory=dict)
    important: Mapping[Target, int] = field(default_factory=dict)
    revenue: Mapping[str, int] = field(default_factory=dict)

    def customer_ids(self, kind: str, target_id: str) -> frozenset[str]:
        """The customers that asked for one issue or project."""
        return self.customers.get((kind, target_id), frozenset())

    def request_count(self, kind: str, target_id: str) -> int:
        """How many requests name one issue or project."""
        return self.counts.get((kind, target_id), 0)

    def important_count(self, kind: str, target_id: str) -> int:
        """How many requests naming one issue or project are marked important."""
        return self.important.get((kind, target_id), 0)

    def revenue_of(self, kind: str, target_id: str) -> int:
        """The summed revenue of the distinct customers that asked for one issue or project."""
        return sum(self.revenue.get(customer, 0) for customer in self.customer_ids(kind, target_id))


def load_customer_index(repositories: Repositories, workspace_id: str, *, with_revenue: bool = False) -> CustomerIndex:
    """The workspace's requests folded by target, and each customer's revenue when `with_revenue` is set."""
    customers: dict[Target, set[str]] = {}
    counts: dict[Target, int] = {}
    important: dict[Target, int] = {}
    for request in repositories.customers.list_requests(workspace_id):
        target = (request.target_kind, request.target_id)
        customers.setdefault(target, set()).add(request.customer_id)
        counts[target] = counts.get(target, 0) + 1
        if request.important:
            important[target] = important.get(target, 0) + 1
    revenue: dict[str, int] = {}
    if with_revenue:
        revenue = {row.customer_id: row.revenue or 0 for row in repositories.customers.list_customers(workspace_id)}
    return CustomerIndex(
        customers={target: frozenset(ids) for target, ids in customers.items()},
        counts=counts,
        important=important,
        revenue=revenue,
    )


def customer_match(
    wanted: frozenset[str | None],
    unwanted: frozenset[str | None],
    held: frozenset[str],
    important: int = 0,
) -> bool:
    """Whether a row's customers satisfy an any-of and a none-of set.

    `None` stands for no customer at all, and `important` for a row with at least
    one request marked important, which `important` counts.
    """

    def holds(value: str | None) -> bool:
        if value is None:
            return not held
        if value == IMPORTANT:
            return important > 0
        return value in held

    if wanted and not any(holds(value) for value in wanted):
        return False
    if unwanted and any(holds(value) for value in unwanted):
        return False
    return True


def require_customer_list_reader(context: AuthzContext, filtered: bool, sort: Optional[str]) -> None:
    """Refuse a guest a list filtered or sorted by customer, since guests may not read customers at all."""
    if context.is_guest and (filtered or sort in CUSTOMER_SORTS):
        raise forbidden()
