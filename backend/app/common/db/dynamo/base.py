"""What every Standupless repository shares: the package repository and the clock.

Each table's module builds one `webbpulse.dynamodb.Repository` bound to its own
`TableSpec`, so a repository reaches exactly one table and the domain's Terraform
grant covers exactly what its bundle can touch.
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Iterator, Mapping

from botocore.exceptions import ClientError
from webbpulse.dynamodb import ConditionFailed, Repository

from app.common.core.config import settings
from app.common.db.dynamo.tables import TableSpec

CONDITIONAL_CHECK_FAILED = "ConditionalCheckFailedException"


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


@contextmanager
def conditional_write(table: str, *, condition: str = "", key: Mapping[str, Any] | None = None) -> Iterator[None]:
    """Turn a failed DynamoDB condition into `ConditionFailed`.

    The shared package's `Repository` passes a `ConditionExpression` straight to
    boto3 and lets the `ClientError` out, so a conditional create surfaces as an
    opaque 500. Translating it here is what makes a lost uniqueness race a 409
    through `install_dynamodb_error_handlers`. `docs/design.md` section 6 records
    this as an upstream gap.
    """
    try:
        yield
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") != CONDITIONAL_CHECK_FAILED:
            raise
        raise ConditionFailed(table, condition, key) from exc
