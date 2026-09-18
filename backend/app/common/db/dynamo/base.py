"""What every Standupless repository shares: the package repository and the clock.

Each table's module builds one `webbpulse.dynamodb.Repository` bound to its own
`TableSpec`, so a repository reaches exactly one table and the domain's Terraform
grant covers exactly what its bundle can touch.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Mapping

from webbpulse.dynamodb import Repository

from app.common.core.config import settings
from app.common.db.dynamo.tables import TableSpec


def utc_now() -> datetime:
    """The current UTC time, as a timezone-aware datetime."""
    return datetime.now(timezone.utc)


def build_repository(spec: TableSpec, repository: Repository | None = None) -> Repository:
    """An injected repository, or one bound to `spec` in this environment.

    Constructing it makes no AWS call: the package repository builds its client on
    first use, which is what keeps a cold start proportional to the request.
    """
    if repository is not None:
        return repository
    return Repository(
        spec.suffix,
        prefix=settings.dynamodb_table_prefix,
        endpoint_url=settings.DYNAMODB_ENDPOINT_URL or None,
    )


def as_item(model: Any, **extra: Any) -> dict[str, Any]:
    """A pydantic model as a stored item, with the index attributes it carries."""
    item = model.model_dump(mode="json")
    item.update(extra)
    return item


def first(page_items: list[Mapping[str, Any]]) -> Mapping[str, Any] | None:
    """The first item of a query page, or `None` when it is empty."""
    return page_items[0] if page_items else None
