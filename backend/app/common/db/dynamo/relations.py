"""The `relations` table: issue links, one row per direction.

A link is stored twice, once under each issue, so both list the pair from their own
partition with no second index on the source. The two rows share a `link_id`, which
is what lets a delete on either side remove both, and the inverse row is what
`ws_target-relation_type-index` answers "what blocks this" from.

Direction is asymmetric on purpose. Only the canonical direction is accepted on a
write, so `duplicate_of` is never stored in both senses and a client cannot create
two links that disagree about which issue is the duplicate.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Mapping

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import Repository, new_ulid

from app.common.db.dynamo.base import as_item, build_repository, utc_now
from app.common.db.dynamo.tables import RELATIONS

TARGET_INDEX = "ws_target-relation_type-index"

LinkType = Literal["blocks", "blocked_by", "relates_to", "duplicate_of"]

LINK_TYPES: tuple[str, ...] = ("blocks", "blocked_by", "relates_to", "duplicate_of")
"""Every type a caller may write, which the contract fixes."""

INVERSE_TYPES: dict[str, str] = {
    "blocks": "blocked_by",
    "blocked_by": "blocks",
    "relates_to": "relates_to",
    "duplicate_of": "duplicated_by",
    "duplicated_by": "duplicate_of",
}
"""What the other side of a link reads as.

`duplicated_by` appears only here and on a stored inverse row: the contract admits
`duplicate_of` alone on a write, so the reverse sense exists to be read, never to
be asked for.
"""


def new_link_id() -> str:
    """A fresh link id, shared by both rows of one link."""
    return new_ulid()


def relation_key(issue_id: str, relation_type: str, target_issue_id: str) -> str:
    """The sort key of one direction of one link.

    Carrying the type inside the key is what makes the same pair linkable under two
    different types while a repeat of the same type collides, which is the
    idempotency the contract asks for.
    """
    return f"issue#{issue_id}#{relation_type}#{target_issue_id}"


def issue_prefix(issue_id: str) -> str:
    """The sort key prefix every link row of one issue shares."""
    return f"issue#{issue_id}#"


def ws_target(workspace_id: str, target_issue_id: str) -> str:
    """The inverse index's hash key, scoped to one workspace."""
    return f"{workspace_id}#{target_issue_id}"


class Relation(BaseModel):
    """One direction of one link between two issues."""

    workspace_id: str
    relation_key: str
    link_id: str
    issue_id: str
    relation_type: str
    target_issue_id: str
    created_by: str
    created_at: datetime = Field(default_factory=utc_now)


def as_relation_item(relation: Relation) -> dict[str, Any]:
    """One relation as the stored item, carrying the inverse index's hash key."""
    return as_item(relation, ws_target=ws_target(relation.workspace_id, relation.target_issue_id))


def _as_relation(item: Mapping[str, Any]) -> Relation:
    """One stored item as a `Relation`, ignoring the index attribute."""
    fields = {key: value for key, value in item.items() if key != "ws_target"}
    return Relation.model_validate(fields)


class RelationRepository:
    """Reads and writes `relations` rows, every method workspace first."""

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = build_repository(RELATIONS, repository)

    def get(self, workspace_id: str, issue_id: str, relation_type: str, target_issue_id: str) -> Relation | None:
        """One direction of one link, or `None`."""
        if not workspace_id or not issue_id or not target_issue_id:
            return None
        item = self._repository.get(
            {
                "workspace_id": workspace_id,
                "relation_key": relation_key(issue_id, relation_type, target_issue_id),
            }
        )
        return _as_relation(item) if item is not None else None

    def link(
        self,
        workspace_id: str,
        issue_id: str,
        relation_type: str,
        target_issue_id: str,
        created_by: str,
    ) -> Relation:
        """Write both directions of one link, answering the forward row.

        Idempotent on the pair and type: an existing forward row is returned as it
        stands rather than rewritten, so a repeated call keeps the original
        `link_id` and `created_at` and the client sees the same link.
        """
        existing = self.get(workspace_id, issue_id, relation_type, target_issue_id)
        if existing is not None:
            return existing

        link_id = new_link_id()
        created_at = utc_now()
        forward = Relation(
            workspace_id=workspace_id,
            relation_key=relation_key(issue_id, relation_type, target_issue_id),
            link_id=link_id,
            issue_id=issue_id,
            relation_type=relation_type,
            target_issue_id=target_issue_id,
            created_by=created_by,
            created_at=created_at,
        )
        inverse_type = INVERSE_TYPES[relation_type]
        inverse = Relation(
            workspace_id=workspace_id,
            relation_key=relation_key(target_issue_id, inverse_type, issue_id),
            link_id=link_id,
            issue_id=target_issue_id,
            relation_type=inverse_type,
            target_issue_id=issue_id,
            created_by=created_by,
            created_at=created_at,
        )

        self._put(forward)
        self._put(inverse)
        return forward

    def _put(self, relation: Relation) -> None:
        """Write one direction, tolerating a row that is already there.

        The two rows are written separately rather than transactionally, so a
        retried call finds one side present; overwriting it with the same content
        is what makes the pair converge instead of raising.
        """
        self._repository.put(as_relation_item(relation))

    def list_for_issue(self, workspace_id: str, issue_id: str, *, limit: int = 200) -> list[Relation]:
        """Every link row stored under one issue, both senses, oldest first.

        Both directions live under the issue's own partition, so this is one query
        and the inverse index is not read on the common path.
        """
        if not workspace_id or not issue_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("relation_key").begins_with(issue_prefix(issue_id)),
            max_items=limit,
        )
        relations = [_as_relation(item) for item in items]
        return sorted(relations, key=lambda row: (row.created_at, row.relation_key))

    def list_targeting(self, workspace_id: str, target_issue_id: str, *, limit: int = 200) -> list[Relation]:
        """Every link row pointing at one issue, through `ws_target-relation_type-index`.

        The index exists so a reader can answer "what blocks this" without the
        writer having kept a second list, and a cleanup can find the far side of
        every link into an issue being deleted.
        """
        if not workspace_id or not target_issue_id:
            return []
        items = self._repository.iter_query(
            Key("ws_target").eq(ws_target(workspace_id, target_issue_id)),
            index_name=TARGET_INDEX,
            max_items=limit,
        )
        return [_as_relation(item) for item in items]

    def delete_link(self, workspace_id: str, issue_id: str, link_id: str) -> Relation | None:
        """Remove both rows of one link, answering this issue's row or `None` when absent.

        Found by `link_id` under the issue's own partition, because the caller names
        the link rather than the pair, and the inverse is then keyed off the row
        that was found rather than reconstructed from the request. The removed row
        is answered so the caller can name what the link pointed at.
        """
        for relation in self.list_for_issue(workspace_id, issue_id):
            if relation.link_id != link_id:
                continue
            self._delete(workspace_id, relation.relation_key)
            inverse_type = INVERSE_TYPES[relation.relation_type]
            self._delete(
                workspace_id,
                relation_key(relation.target_issue_id, inverse_type, relation.issue_id),
            )
            return relation
        return None

    def delete_for_issue(self, workspace_id: str, issue_id: str) -> int:
        """Remove every link touching one issue, returning how many rows went.

        Both senses go: the rows under this issue, and the matching row under each
        far side, which the stored pair names directly.
        """
        removed = 0
        for relation in self.list_for_issue(workspace_id, issue_id, limit=1000):
            self._delete(workspace_id, relation.relation_key)
            removed += 1
            inverse_type = INVERSE_TYPES[relation.relation_type]
            if self._delete(
                workspace_id,
                relation_key(relation.target_issue_id, inverse_type, relation.issue_id),
            ):
                removed += 1
        return removed

    def _delete(self, workspace_id: str, key: str) -> bool:
        """Remove one relation row, reporting whether one was there."""
        item = self._repository.get({"workspace_id": workspace_id, "relation_key": key})
        if item is None:
            return False
        self._repository.delete(
            {"workspace_id": workspace_id, "relation_key": key},
            condition=Attr("relation_key").exists(),
        )
        return True
