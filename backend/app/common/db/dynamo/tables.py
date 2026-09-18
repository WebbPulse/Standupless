"""The declarative shape of every Standupless table: keys, indexes and TTL.

The identity tables are not described here. They come from
`webbpulse.identity.storage.TABLES`, which carries the specs
`platform-modules/aws//modules/identity` provisions, so the two cannot disagree.
"""

from dataclasses import dataclass, field
from typing import Any, Literal

KeyType = Literal["S", "N"]
Projection = Literal["ALL", "KEYS_ONLY"]


@dataclass(frozen=True)
class KeyAttribute:
    """One key attribute: its name and its DynamoDB scalar type."""

    name: str
    type: KeyType = "S"


@dataclass(frozen=True)
class IndexSpec:
    """A global secondary index: its name, its keys and its projection."""

    name: str
    hash_key: KeyAttribute
    range_key: KeyAttribute | None = None
    projection: Projection = "ALL"


@dataclass(frozen=True)
class TableSpec:
    """One table's keys, indexes and TTL."""

    suffix: str
    partition_key: KeyAttribute = field(default_factory=lambda: KeyAttribute("id"))
    sort_key: KeyAttribute | None = None
    indexes: tuple[IndexSpec, ...] = ()
    ttl_attribute: str | None = None

    @property
    def key_attribute_names(self) -> tuple[str, ...]:
        """The table's own key attribute names, partition first."""
        names = [self.partition_key.name]
        if self.sort_key is not None:
            names.append(self.sort_key.name)
        return tuple(names)

    def _all_key_attributes(self) -> list[KeyAttribute]:
        """Every key attribute of the table and of its indexes, with duplicates."""
        attributes = [self.partition_key]
        if self.sort_key is not None:
            attributes.append(self.sort_key)
        for index in self.indexes:
            attributes.append(index.hash_key)
            if index.range_key is not None:
                attributes.append(index.range_key)
        return attributes

    def attribute_definitions(self) -> list[dict[str, str]]:
        """Every key attribute across the table and its indexes, deduplicated.

        Raises ValueError when one name is declared with two different types, which
        DynamoDB would reject at create time.
        """
        seen: dict[str, str] = {}
        for attribute in self._all_key_attributes():
            existing = seen.get(attribute.name)
            if existing is not None and existing != attribute.type:
                raise ValueError(
                    f"{self.suffix}: attribute {attribute.name!r} declared as both {existing} and {attribute.type}"
                )
            seen[attribute.name] = attribute.type
        return [{"AttributeName": name, "AttributeType": type_} for name, type_ in seen.items()]

    def key_schema(self) -> list[dict[str, str]]:
        """The table's own KeySchema, in the CreateTable shape."""
        schema = [{"AttributeName": self.partition_key.name, "KeyType": "HASH"}]
        if self.sort_key is not None:
            schema.append({"AttributeName": self.sort_key.name, "KeyType": "RANGE"})
        return schema

    def global_secondary_indexes(self) -> list[dict[str, Any]]:
        """Every GSI, in the CreateTable shape."""
        indexes: list[dict[str, Any]] = []
        for index in self.indexes:
            key_schema = [{"AttributeName": index.hash_key.name, "KeyType": "HASH"}]
            if index.range_key is not None:
                key_schema.append({"AttributeName": index.range_key.name, "KeyType": "RANGE"})
            indexes.append(
                {
                    "IndexName": index.name,
                    "KeySchema": key_schema,
                    "Projection": {"ProjectionType": index.projection},
                }
            )
        return indexes

    def create_table_request(self, name: str) -> dict[str, Any]:
        """The full `CreateTable` request for this spec under the deployed `name`."""
        request: dict[str, Any] = {
            "TableName": name,
            "KeySchema": self.key_schema(),
            "AttributeDefinitions": self.attribute_definitions(),
            "BillingMode": "PAY_PER_REQUEST",
        }
        indexes = self.global_secondary_indexes()
        if indexes:
            request["GlobalSecondaryIndexes"] = indexes
        return request


USERS = TableSpec(
    suffix="users",
    indexes=(IndexSpec(name="email_lower-index", hash_key=KeyAttribute("email_lower")),),
)

WORKSPACES = TableSpec(
    suffix="workspaces",
    indexes=(IndexSpec(name="slug-index", hash_key=KeyAttribute("slug")),),
)

MEMBERSHIPS = TableSpec(
    suffix="memberships",
    partition_key=KeyAttribute("workspace_id"),
    sort_key=KeyAttribute("member_key"),
    indexes=(
        IndexSpec(
            name="user_id-workspace_id-index",
            hash_key=KeyAttribute("user_id"),
            range_key=KeyAttribute("workspace_id"),
        ),
    ),
)

INVITES = TableSpec(
    suffix="invites",
    partition_key=KeyAttribute("workspace_id"),
    sort_key=KeyAttribute("invite_id"),
    indexes=(IndexSpec(name="token_hash-index", hash_key=KeyAttribute("token_hash")),),
    ttl_attribute="expires_at_ttl",
)

PROJECTS = TableSpec(
    suffix="projects",
    partition_key=KeyAttribute("workspace_id"),
    sort_key=KeyAttribute("project_id"),
    indexes=(
        IndexSpec(
            name="workspace_key_prefix-index",
            hash_key=KeyAttribute("workspace_key_prefix"),
        ),
    ),
)

PROJECT_CONFIG = TableSpec(
    suffix="project_config",
    partition_key=KeyAttribute("workspace_id"),
    sort_key=KeyAttribute("config_key"),
)

COUNTERS = TableSpec(
    suffix="counters",
    partition_key=KeyAttribute("workspace_id"),
    sort_key=KeyAttribute("counter_key"),
)

IDEMPOTENCY = TableSpec(
    suffix="idempotency",
    partition_key=KeyAttribute("scope_key"),
    ttl_attribute="expires_at",
)

RATE_LIMITS = TableSpec(
    suffix="rate-limits",
    partition_key=KeyAttribute("pk"),
    ttl_attribute="expires_at",
)
"""Owned by `webbpulse.ratelimit`, so no repository declares it. Exported so Terraform
provisions the table the rate limiting middleware writes to."""

TABLES: tuple[TableSpec, ...] = (
    USERS,
    WORKSPACES,
    MEMBERSHIPS,
    INVITES,
    PROJECTS,
    PROJECT_CONFIG,
    COUNTERS,
    IDEMPOTENCY,
)

EXPORTED_TABLES: tuple[TableSpec, ...] = (*TABLES, RATE_LIMITS)
"""Every table Terraform provisions: the product's own plus the rate limiter's."""

TABLES_BY_SUFFIX: dict[str, TableSpec] = {spec.suffix: spec for spec in TABLES}


def export_table_definitions() -> dict[str, dict[str, Any]]:
    """Every exported table's shape keyed by suffix, for Terraform to consume."""
    return {spec.suffix: _table_definition(spec) for spec in EXPORTED_TABLES}


def _table_definition(spec: TableSpec) -> dict[str, Any]:
    """One table's keys, indexes and TTL in the shape Terraform reads."""
    return {
        "hash_key": spec.partition_key.name,
        "range_key": spec.sort_key.name if spec.sort_key is not None else None,
        "attributes": [
            {"name": definition["AttributeName"], "type": definition["AttributeType"]}
            for definition in spec.attribute_definitions()
        ],
        "global_secondary_indexes": [
            {
                "name": index.name,
                "hash_key": index.hash_key.name,
                "range_key": index.range_key.name if index.range_key is not None else None,
                "projection_type": index.projection,
            }
            for index in spec.indexes
        ],
        "ttl_attribute": spec.ttl_attribute,
    }
