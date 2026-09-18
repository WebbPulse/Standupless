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


WORKSPACES = TableSpec(
    suffix="workspaces",
    indexes=(IndexSpec(name="owner_user_id-index", hash_key=KeyAttribute("owner_user_id")),),
)

TABLES: tuple[TableSpec, ...] = (WORKSPACES,)

TABLES_BY_SUFFIX: dict[str, TableSpec] = {spec.suffix: spec for spec in TABLES}
