"""What every Standupless repository shares: the package repository and the clock.

Each table's module builds one `webbpulse.dynamodb.Repository` bound to its own
`TableSpec`, so a repository reaches exactly one table and the domain's Terraform
grant covers exactly what its bundle can touch.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Mapping

from webbpulse.dynamodb import ReadOnlyTable, Repository

from app.common.core.config import settings
from app.common.db.dynamo.tables import TableSpec

__all__ = [
    "ReadOnlyTable",
    "as_item",
    "build_repository",
    "expiry_timestamp",
    "first",
    "read_only_repository",
    "utc_now",
]

READ_ONLY_HINT = (
    "Move the repository from `read_repositories` to `repositories` in "
    "app/common/composition/domains.py and from `read_tables` to `tables` in "
    "terraform/lambda_domains.tf, or move the route to the owning domain."
)
"""What to change when a write reaches a table this domain only reads.

Passed to the package repository as its `read_only_hint`, so the refusal names the
two declarations that have to agree rather than only the table and the method.
"""


def utc_now() -> datetime:
    """The current UTC time, as a timezone-aware datetime."""
    return datetime.now(timezone.utc)


def expiry_timestamp(days: int | None, *, now: datetime | None = None) -> int:
    """The TTL stamp a credential expires at, or 0 for one that does not expire.

    Lives here rather than beside one table's model because both the API keys and
    the share links tables stamp their TTL with it, and neither owns the other.
    """
    if not days:
        return 0
    moment = (now or utc_now()) + timedelta(days=days)
    return int(moment.timestamp())


def _package_repository(suffix: str, *, read_only: bool) -> Repository:
    """A package repository for the `suffix` table in this environment."""
    return Repository(
        suffix,
        prefix=settings.dynamodb_table_prefix,
        endpoint_url=settings.DYNAMODB_ENDPOINT_URL or None,
        read_only=read_only,
        read_only_hint=READ_ONLY_HINT if read_only else None,
    )


def build_repository(spec: TableSpec, repository: Repository | None = None) -> Repository:
    """An injected repository, or one bound to `spec` in this environment.

    Constructing it makes no AWS call: the package repository builds its client on
    first use, which is what keeps a cold start proportional to the request.
    """
    if repository is not None:
        return repository
    return _package_repository(spec.suffix, read_only=False)


def build_identity_repository(suffix: str, repository: Repository | None = None) -> Repository:
    """An injected repository, or one bound to an identity-module table.

    Separate from `build_repository` because these tables are declared by the
    identity Terraform module rather than by this product's `TableSpec` exports,
    so the suffix is the package's own constant and there is no spec to read it
    from. The prefix is the same, which is what lets the package's table names
    resolve with no extra environment variable.
    """
    if repository is not None:
        return repository
    return _package_repository(suffix, read_only=False)


def read_only_repository(suffix: str) -> Repository:
    """A package repository for `suffix` that refuses writes.

    Injected into a product repository when its domain holds only the read grant,
    so the code and the Terraform policy fail the same way.
    """
    return _package_repository(suffix, read_only=True)


def as_item(model: Any, **extra: Any) -> dict[str, Any]:
    """A pydantic model as a stored item, with the index attributes it carries."""
    item = model.model_dump(mode="json")
    item.update(extra)
    return item


def first(page_items: list[Mapping[str, Any]]) -> Mapping[str, Any] | None:
    """The first item of a query page, or `None` when it is empty."""
    return page_items[0] if page_items else None
