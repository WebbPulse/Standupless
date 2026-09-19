"""The declarative shape of every Standupless table: keys, indexes, TTL and stream.

The identity tables are not described here. They come from
`webbpulse.identity.storage.TABLES`, which carries the specs
`platform-modules/aws//modules/identity` provisions, so the two cannot disagree.
"""

from dataclasses import dataclass, field
from typing import Any, Literal

KeyType = Literal["S", "N"]
Projection = Literal["ALL", "KEYS_ONLY"]
StreamViewType = Literal["KEYS_ONLY", "NEW_IMAGE", "OLD_IMAGE", "NEW_AND_OLD_IMAGES"]


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
    """One table's keys, indexes, TTL and stream."""

    suffix: str
    partition_key: KeyAttribute = field(default_factory=lambda: KeyAttribute("id"))
    sort_key: KeyAttribute | None = None
    indexes: tuple[IndexSpec, ...] = ()
    ttl_attribute: str | None = None
    stream_view_type: StreamViewType | None = None
    """What a stream record carries, or None for a table with no stream.

    Declared here rather than only in Terraform so the exporter carries it across
    and a consumer's tests can create the same stream moto reads from.
    """

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
        if self.stream_view_type is not None:
            request["StreamSpecification"] = {
                "StreamEnabled": True,
                "StreamViewType": self.stream_view_type,
            }
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

ISSUES = TableSpec(
    suffix="issues",
    partition_key=KeyAttribute("workspace_id"),
    sort_key=KeyAttribute("issue_id"),
    indexes=(
        IndexSpec(
            name="ws_project-status_updated-index",
            hash_key=KeyAttribute("ws_project_status"),
            range_key=KeyAttribute("updated_at"),
        ),
        IndexSpec(
            name="ws_project-key_number-index",
            hash_key=KeyAttribute("ws_project"),
            range_key=KeyAttribute("number", "N"),
        ),
        IndexSpec(
            name="ws_assignee-updated_at-index",
            hash_key=KeyAttribute("ws_assignee"),
            range_key=KeyAttribute("updated_at"),
        ),
        IndexSpec(
            name="ws_project-cycle_id-index",
            hash_key=KeyAttribute("ws_project"),
            range_key=KeyAttribute("cycle_id"),
        ),
        IndexSpec(
            name="ws_project-milestone_id-index",
            hash_key=KeyAttribute("ws_project"),
            range_key=KeyAttribute("milestone_id"),
        ),
        IndexSpec(
            name="ws_parent-created_at-index",
            hash_key=KeyAttribute("ws_parent"),
            range_key=KeyAttribute("created_at"),
        ),
    ),
    stream_view_type="NEW_AND_OLD_IMAGES",
)
"""The six indexes design section 3 fixes, and the stream the rollup consumer reads.

`ws_project_status` is the board column's composite `<ws>#<project>#<status>`,
which is what spreads a busy project across partitions instead of concentrating it
on one. `number` is numeric so `ws_project-key_number-index` sorts `ABC-9` before
`ABC-10`. The cycle and milestone index ranges stay unwritten until M4, which
leaves those two indexes sparse rather than wrong.
"""

RELATIONS = TableSpec(
    suffix="relations",
    partition_key=KeyAttribute("workspace_id"),
    sort_key=KeyAttribute("relation_key"),
    indexes=(
        IndexSpec(
            name="ws_target-relation_type-index",
            hash_key=KeyAttribute("ws_target"),
            range_key=KeyAttribute("relation_type"),
        ),
    ),
)
"""One row per direction, so both issues list a pair without a second write path."""

ACTIVITY = TableSpec(
    suffix="activity",
    partition_key=KeyAttribute("ws_issue"),
    sort_key=KeyAttribute("activity_id"),
    indexes=(
        IndexSpec(
            name="ws_project-created_at-index",
            hash_key=KeyAttribute("ws_project"),
            range_key=KeyAttribute("created_at"),
        ),
    ),
)
"""Partitioned per issue rather than per project, because an issue's history is what
grows without bound and only the newest page is ever read."""

COMMENTS = TableSpec(
    suffix="comments",
    partition_key=KeyAttribute("ws_issue"),
    sort_key=KeyAttribute("comment_id"),
    indexes=(
        IndexSpec(
            name="ws_author-created_at-index",
            hash_key=KeyAttribute("ws_author"),
            range_key=KeyAttribute("created_at"),
        ),
    ),
    stream_view_type="NEW_AND_OLD_IMAGES",
)
"""One thread per issue, so reading a thread is one partition in sort-key order.

The stream feeds the notify consumer, which is why a comment write needs no second
call to fan a mention out: the record it leaves is what the notification is built
from. Owned by the `discussion` domain and only read by `views`.
"""

VIEWS = TableSpec(
    suffix="views",
    partition_key=KeyAttribute("workspace_id"),
    sort_key=KeyAttribute("view_key"),
)
"""Saved views, personal and project, told apart by their sort key prefix.

`user#<uid>#view#<vid>` and `project#<pid>#view#<vid>` share the partition because
the two are the same entity with different visibility, and the prefix is what lets
"my views" and "this project's views" each be one query rather than a filter.
"""

INBOX = TableSpec(
    suffix="inbox",
    partition_key=KeyAttribute("ws_user"),
    sort_key=KeyAttribute("notification_id"),
    indexes=(
        IndexSpec(
            name="ws_user-unread-index",
            hash_key=KeyAttribute("ws_user"),
            range_key=KeyAttribute("unread_at"),
        ),
    ),
    ttl_attribute="expires_at",
)
"""One partition per recipient, and a sparse index holding only what is unread.

`unread_at` is written when a notification lands and removed when it is read, so
the badge counts a short index rather than filtering the whole partition. The
partition is built from the authorization context rather than from a parameter,
which is what leaves no route by which one member reads another's inbox.
"""

SEARCH_INDEX = TableSpec(
    suffix="search_index",
    partition_key=KeyAttribute("ws_project"),
    sort_key=KeyAttribute("term_doc"),
)
"""The term projection the search consumer maintains, one row per term per issue.

A row's whole content is its key, which is what makes the consumer idempotent: a
replayed record puts the same row and deletes the same absent one.
"""

REACTIONS = TableSpec(
    suffix="reactions",
    partition_key=KeyAttribute("ws_target"),
    sort_key=KeyAttribute("reaction_key"),
)
"""Keyed by `<emoji>#<user_id>`, so the caller already knows the key.

That is what makes a reaction a `PUT` and a `DELETE` on the pair rather than a
create returning an id: there is no id to hand back, and a second `PUT` by the
same user is the same row rather than a duplicate.
"""

ATTACHMENTS = TableSpec(
    suffix="attachments",
    partition_key=KeyAttribute("ws_issue"),
    sort_key=KeyAttribute("attachment_id"),
)
"""One issue's attachments, both the URL kind and the uploaded kind.

A file attachment stores its S3 key and never a URL: the only way to a byte is the
download route, which mints a presigned GET per request.
"""

PLANNING = TableSpec(
    suffix="planning",
    partition_key=KeyAttribute("workspace_id"),
    sort_key=KeyAttribute("planning_key"),
    indexes=(
        IndexSpec(
            name="ws_project-target_date-index",
            hash_key=KeyAttribute("ws_project"),
            range_key=KeyAttribute("target_date"),
        ),
    ),
)
"""Cycles and milestones in one partition, told apart by their sort key prefix.

`project#<pid>#cycle#<cid>` and `project#<pid>#milestone#<mid>` share the workspace
partition because both are a project's planning objects with the same visibility,
and the prefix is what makes "this project's cycles" one query rather than a filter.

`target_date` is denormalised rather than being either entity's own field: a cycle
writes its `end_date` into it and a milestone its `target_date`, so one index orders
both kinds on the one date a roadmap draws them at. A milestone with no target date
writes no attribute at all, leaving it out of the index rather than sorting it
under an empty string.
"""

GITHUB = TableSpec(
    suffix="github",
    partition_key=KeyAttribute("workspace_id"),
    sort_key=KeyAttribute("github_key"),
    indexes=(
        IndexSpec(
            name="installation_id-index",
            hash_key=KeyAttribute("installation_id"),
        ),
        IndexSpec(
            name="ws_issue-link-index",
            hash_key=KeyAttribute("ws_issue"),
            range_key=KeyAttribute("linked_at"),
        ),
    ),
)
"""The installation, its repositories, the pull request links and the outbound
webhook endpoints, told apart by their sort key prefix.

`installation_id-index` is the one index whose hash key is not workspace scoped,
and it cannot be: a delivery arrives carrying an installation id and nothing else,
so resolving the workspace is exactly what it is for. Every other read of this
table is a query inside one workspace partition, and `ws_issue-link-index` is what
makes an issue's linked pull requests one query rather than a scan.
"""

API_KEYS = TableSpec(
    suffix="api_keys",
    partition_key=KeyAttribute("workspace_id"),
    sort_key=KeyAttribute("key_id"),
    indexes=(
        IndexSpec(
            name="key_hash-index",
            hash_key=KeyAttribute("key_hash"),
        ),
    ),
    ttl_attribute="expires_at",
)
"""API keys, partitioned by workspace so a settings page is one query.

The platform's own `api-keys` spec partitions by `key_hash`, which makes
verification a point read and "every key in this workspace" a scan. This product
inverts that: the listing is the common human read and verification is the common
machine one, so verification pays one index query through `key_hash-index` and the
listing pays nothing. The hash is still the only form of the key at rest.

The TTL is on `expires_at`, so an expired key eventually leaves the table. Expiry
is checked on the read path regardless, because a TTL deletion runs on DynamoDB's
own schedule and a key must stop working at its expiry rather than at its sweep.
"""

SHARE_LINKS = TableSpec(
    suffix="share_links",
    partition_key=KeyAttribute("token_hash"),
    indexes=(
        IndexSpec(
            name="ws_target-index",
            hash_key=KeyAttribute("ws_target"),
            range_key=KeyAttribute("created_at"),
        ),
    ),
    ttl_attribute="expires_at",
)
"""Public read-only share links, partitioned by token hash.

Partitioning by the hash is what makes the anonymous read a point lookup with no
index behind it, and it is uniform by construction because a hash is. The listing
and the revoke-by-target both go through `ws_target-index`, whose hash key is
`<workspace_id>#<target_type>#<target_id>`, so neither can reach outside one
workspace.
"""

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
    ISSUES,
    RELATIONS,
    ACTIVITY,
    COMMENTS,
    VIEWS,
    INBOX,
    SEARCH_INDEX,
    REACTIONS,
    ATTACHMENTS,
    PLANNING,
    GITHUB,
    API_KEYS,
    SHARE_LINKS,
    IDEMPOTENCY,
)

EXPORTED_TABLES: tuple[TableSpec, ...] = (*TABLES, RATE_LIMITS)
"""Every table Terraform provisions: the product's own plus the rate limiter's."""

TABLES_BY_SUFFIX: dict[str, TableSpec] = {spec.suffix: spec for spec in TABLES}


def export_table_definitions() -> dict[str, dict[str, Any]]:
    """Every exported table's shape keyed by suffix, for Terraform to consume."""
    return {spec.suffix: _table_definition(spec) for spec in EXPORTED_TABLES}


def _table_definition(spec: TableSpec) -> dict[str, Any]:
    """One table's keys, indexes, TTL and stream in the shape Terraform reads."""
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
        "stream_view_type": spec.stream_view_type,
    }
