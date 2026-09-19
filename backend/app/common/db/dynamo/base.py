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


class ReadOnlyTable(PermissionError):
    """A write reached a table the serving function holds only a read grant on.

    Raised in tests and local runs by `ReadOnlyRepository`, so the mismatch fails
    the suite instead of surfacing as a DynamoDB AccessDenied in staging.
    """

    def __init__(self, table: str, method: str) -> None:
        """Name the table and the write that was attempted on it."""
        super().__init__(
            f"{method}() on the {table!r} table, which this domain only reads. Move the "
            f"repository from `read_repositories` to `repositories` in "
            f"app/common/composition/domains.py and from `read_tables` to `tables` in "
            f"terraform/lambda_domains.tf, or move the route to the owning domain."
        )
        self.table = table
        self.method = method


WRITE_METHODS: tuple[str, ...] = (
    "condition_check",
    "delete",
    "delete_action",
    "delete_many",
    "increment",
    "put",
    "put_action",
    "put_many",
    "remove_attributes",
    "set_attributes",
    "transact_write",
    "update",
    "update_action",
)


class ReadOnlyRepository(Repository):
    """The package repository with every write refused.

    Mirrors the `read_tables` IAM grant: reads go through untouched, and each
    write raises `ReadOnlyTable` before any client is built.
    """


def _refusing(method: str) -> Any:
    """A method body that refuses `method` on a read-only repository."""

    def refuse(self: ReadOnlyRepository, *args: Any, **kwargs: Any) -> Any:
        """Refuse the write; the message names the table and the fix."""
        raise ReadOnlyTable(self.table_name, method)

    refuse.__name__ = method
    refuse.__doc__ = f"Refuse `{method}`; this repository is read only."
    return refuse


for _method in WRITE_METHODS:
    setattr(ReadOnlyRepository, _method, _refusing(_method))


def _package_repository(suffix: str, *, read_only: bool) -> Repository:
    """A package repository for the `suffix` table in this environment."""
    cls = ReadOnlyRepository if read_only else Repository
    return cls(
        suffix,
        prefix=settings.dynamodb_table_prefix,
        endpoint_url=settings.DYNAMODB_ENDPOINT_URL or None,
    )


def build_repository(spec: TableSpec, repository: Repository | None = None) -> Repository:
    """An injected repository, or one bound to `spec` in this environment.

    Constructing it makes no AWS call: the package repository builds its client on
    first use, which is what keeps a cold start proportional to the request.
    """
    if repository is not None:
        return repository
    return _package_repository(spec.suffix, read_only=False)


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
