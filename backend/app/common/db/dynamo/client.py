"""The shared boto3 DynamoDB resource, and environment prefixed table lookup."""

from typing import TYPE_CHECKING, Any

import boto3

from app.common.core.config import settings
from app.common.db.dynamo.tables import WORKSPACES, TableSpec

if TYPE_CHECKING:  # pragma: no cover
    from mypy_boto3_dynamodb.client import DynamoDBClient
    from mypy_boto3_dynamodb.service_resource import DynamoDBServiceResource, Table

_resource: "DynamoDBServiceResource | None" = None


def _region_name() -> str | None:
    """The configured region, or None when unset or "auto" so boto3 resolves it."""
    region = settings.AWS_REGION
    if not region or region == "auto":
        return None
    return region


def resource_kwargs() -> dict[str, Any]:
    """Region and endpoint overrides for the boto3 resource, omitting unset ones."""
    kwargs: dict[str, Any] = {}
    region = _region_name()
    if region:
        kwargs["region_name"] = region
    if settings.DYNAMODB_ENDPOINT_URL:
        kwargs["endpoint_url"] = settings.DYNAMODB_ENDPOINT_URL
    return kwargs


def get_resource() -> "DynamoDBServiceResource":
    """The process-wide DynamoDB resource, built on first use."""
    global _resource
    if _resource is None:
        _resource = boto3.resource("dynamodb", **resource_kwargs())
    return _resource


def get_client() -> "DynamoDBClient":
    """The low-level DynamoDB client behind the shared resource."""
    return get_resource().meta.client


def reset_clients() -> None:
    """Drop every memoised resource, this module's and the package's, so the next call rebuilds it."""
    from webbpulse.dynamodb import reset_resource_cache

    global _resource
    _resource = None
    reset_resource_cache()


def table_name(spec: TableSpec) -> str:
    """The deployed table name for `spec`, prefixed for this environment."""
    return f"{settings.dynamodb_table_prefix}-{spec.suffix}"


def get_table(spec: TableSpec) -> "Table":
    """The boto3 Table for `spec` in this environment."""
    return get_resource().Table(table_name(spec))


def check_db_ready() -> bool:
    """Return True if DynamoDB is reachable, which is what `/ready` reports."""
    try:
        get_client().describe_table(TableName=table_name(WORKSPACES))
        return True
    except Exception:
        return False
