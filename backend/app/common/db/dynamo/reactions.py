"""The `reactions` table: who reacted to what, with which emoji.

The row's own sort key is `<emoji>#<user_id>`, so the caller already knows the key
before it writes. That is what makes a reaction a `PUT` and a `DELETE` on the pair
rather than a create returning an id: there is nothing to hand back, a second `PUT`
by the same user is the same row, and removing one that is not there is a no-op.

The partition is the target rather than the issue, so a comment's reactions and an
issue's reactions are read the same way and neither needs the other's id.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Mapping

from boto3.dynamodb.conditions import Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import Repository

from app.common.db.dynamo.base import as_item, build_repository, utc_now
from app.common.db.dynamo.tables import REACTIONS

TargetKind = Literal["issue", "comment"]

TARGET_KINDS: tuple[str, ...] = ("issue", "comment")

USER_IDS_CAP = 20
"""How many reacting users one group names, in key order.

The contract caps the list rather than the count: a thread with a hundred reactions
on one emoji renders a number and the first twenty names, which is what a tooltip
shows anyway.
"""


def ws_target(workspace_id: str, target_id: str) -> str:
    """The partition key of one target's reactions."""
    return f"{workspace_id}#{target_id}"


def reaction_key(emoji: str, user_id: str) -> str:
    """The sort key of one user's reaction with one emoji.

    The key is the pair, which is what makes the write idempotent: the same user
    reacting twice with the same emoji addresses the same row.
    """
    return f"{emoji}#{user_id}"


class Reaction(BaseModel):
    """One user's reaction to one issue or comment."""

    ws_target: str
    reaction_key: str
    workspace_id: str
    target_id: str
    target_kind: str
    project_id: str
    emoji: str
    user_id: str
    created_at: datetime = Field(default_factory=utc_now)


def build_reaction(
    workspace_id: str,
    target_id: str,
    target_kind: str,
    project_id: str,
    emoji: str,
    user_id: str,
) -> Reaction:
    """One reaction with both of its keys already composed."""
    return Reaction(
        ws_target=ws_target(workspace_id, target_id),
        reaction_key=reaction_key(emoji, user_id),
        workspace_id=workspace_id,
        target_id=target_id,
        target_kind=target_kind,
        project_id=project_id,
        emoji=emoji,
        user_id=user_id,
    )


def as_reaction(item: Mapping[str, Any]) -> Reaction:
    """One stored item as a `Reaction`."""
    return Reaction.model_validate(item)


class ReactionRepository:
    """Reads and writes `reactions` rows, every method workspace first."""

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = build_repository(REACTIONS, repository)

    def put(self, reaction: Reaction) -> Reaction:
        """Store one reaction, overwriting an identical one.

        Unconditional on purpose: the key is the `(emoji, user)` pair, so a second
        `PUT` by the same user is the same row and the contract calls that the same
        answer rather than a conflict.
        """
        self._repository.put(as_item(reaction))
        return reaction

    def delete(self, workspace_id: str, target_id: str, emoji: str, user_id: str) -> None:
        """Remove one user's reaction, tolerating one that was never there.

        The contract answers 204 either way, so an absence is not an error and a
        conditional delete would only add a failure mode to an idempotent call.
        """
        self._repository.delete(
            {
                "ws_target": ws_target(workspace_id, target_id),
                "reaction_key": reaction_key(emoji, user_id),
            }
        )

    def list_for_target(self, workspace_id: str, target_id: str, *, max_items: int = 1000) -> list[Reaction]:
        """Every reaction on one target, in key order.

        Read whole rather than paged: a group is a count over the partition, so a
        page boundary would produce a count of part of it.
        """
        if not workspace_id or not target_id:
            return []
        items = self._repository.iter_query(
            Key("ws_target").eq(ws_target(workspace_id, target_id)),
            max_items=max_items,
        )
        return [as_reaction(item) for item in items]

    def list_for_targets(self, workspace_id: str, target_ids: list[str]) -> dict[str, list[Reaction]]:
        """Every reaction on each of several targets, keyed by target id.

        One query per target because the partition is the target, which is what
        lets a thread render its reactions inline rather than one call per comment.
        """
        grouped: dict[str, list[Reaction]] = {}
        for target_id in dict.fromkeys(target_ids):
            if target_id:
                grouped[target_id] = self.list_for_target(workspace_id, target_id)
        return grouped

    def delete_for_target(self, workspace_id: str, target_id: str) -> int:
        """Remove every reaction on one target, returning how many went.

        Called when a comment is deleted, because the partition would otherwise be
        unreachable: nothing but the comment's own id names it.
        """
        rows = self.list_for_target(workspace_id, target_id)
        if not rows:
            return 0
        return self._repository.delete_many(
            [{"ws_target": row.ws_target, "reaction_key": row.reaction_key} for row in rows]
        )
