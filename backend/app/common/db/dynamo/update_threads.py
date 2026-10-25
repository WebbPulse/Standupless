"""Replies and reactions on project updates, filed in the `planning` table.

Every row of one update's thread shares the sort key prefix
`update_thread#<project_id>#<update_id>#`, so the whole thread is one query, an
update's delete is one prefix delete, and a project's delete clears
`update_thread#<project_id>#`. `begins_with("project_update#")` never matches it,
so the update feed never reads a thread row.

Comments sort under `comment#<ulid>`, oldest first. A reaction sorts under
`reaction#<target_id>#<emoji>#<user_id>`, where the target is the update itself or
one of its comments, so a reaction is an idempotent put and delete on that key.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Iterable

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import Repository, new_ulid

from app.common.db.dynamo.base import utc_now

UPDATE_THREAD_KEY_PREFIX = "update_thread#"

PROJECT_UPDATE_COMMENT = "project_update_comment"

PROJECT_UPDATE_REACTION = "project_update_reaction"

THREAD_MAX_ITEMS = 5000
"""The most rows one thread read walks, bounding a runaway partition."""


def project_threads_prefix(project_id: str) -> str:
    """The sort key prefix every update thread of one project shares."""
    return f"{UPDATE_THREAD_KEY_PREFIX}{project_id}#"


def update_thread_prefix(project_id: str, update_id: str) -> str:
    """The sort key prefix every row of one update's thread shares."""
    return f"{project_threads_prefix(project_id)}{update_id}#"


def update_comment_key(project_id: str, update_id: str, comment_id: str) -> str:
    """The sort key of one reply on an update."""
    return f"{update_thread_prefix(project_id, update_id)}comment#{comment_id}"


def update_reactions_prefix(project_id: str, update_id: str, target_id: str) -> str:
    """The sort key prefix of every reaction on one target in an update's thread."""
    return f"{update_thread_prefix(project_id, update_id)}reaction#{target_id}#"


def update_reaction_key(project_id: str, update_id: str, target_id: str, emoji: str, user_id: str) -> str:
    """The sort key of one user's reaction with one emoji on one target."""
    return f"{update_reactions_prefix(project_id, update_id, target_id)}{emoji}#{user_id}"


class UpdateComment(BaseModel):
    """One reply on a project update."""

    workspace_id: str
    planning_key: str
    comment_id: str
    update_id: str
    project_id: str
    kind: str = PROJECT_UPDATE_COMMENT
    body: str
    author_id: str
    mentions: list[str] = Field(default_factory=list)
    source: str | None = None
    created_at: datetime = Field(default_factory=utc_now)
    edited_at: datetime | None = None


class UpdateReaction(BaseModel):
    """One user's reaction to a project update or to one of its replies."""

    workspace_id: str
    planning_key: str
    update_id: str
    project_id: str
    kind: str = PROJECT_UPDATE_REACTION
    target_id: str
    emoji: str
    user_id: str
    created_at: datetime = Field(default_factory=utc_now)


def build_update_comment(
    workspace_id: str,
    project_id: str,
    update_id: str,
    *,
    body: str,
    author_id: str,
    mentions: list[str],
    source: str | None,
) -> UpdateComment:
    """A new reply with a fresh ULID and its sort key composed."""
    comment_id = new_ulid()
    return UpdateComment(
        workspace_id=workspace_id,
        planning_key=update_comment_key(project_id, update_id, comment_id),
        comment_id=comment_id,
        update_id=update_id,
        project_id=project_id,
        body=body,
        author_id=author_id,
        mentions=mentions,
        source=source,
    )


def build_update_reaction(
    workspace_id: str, project_id: str, update_id: str, *, target_id: str, emoji: str, user_id: str
) -> UpdateReaction:
    """One reaction with its sort key composed."""
    return UpdateReaction(
        workspace_id=workspace_id,
        planning_key=update_reaction_key(project_id, update_id, target_id, emoji, user_id),
        update_id=update_id,
        project_id=project_id,
        target_id=target_id,
        emoji=emoji,
        user_id=user_id,
    )


def _comment_item(comment: UpdateComment) -> dict[str, Any]:
    """One reply as the stored item, an unedited one carrying no `edited_at`."""
    item = comment.model_dump(mode="json")
    if item.get("edited_at") is None:
        item.pop("edited_at", None)
    if item.get("source") is None:
        item.pop("source", None)
    return item


@dataclass
class UpdateThread:
    """Every reply and reaction of one update, read in one query."""

    comments: list[UpdateComment] = field(default_factory=list)
    reactions: list[UpdateReaction] = field(default_factory=list)

    def reactions_on(self, target_id: str) -> list[UpdateReaction]:
        """The reactions on one target, in key order."""
        return [reaction for reaction in self.reactions if reaction.target_id == target_id]


class UpdateThreadStore:
    """Reads and writes update threads over the `planning` table's package repository."""

    def __init__(self, repository: Repository) -> None:
        """Share the planning table's repository."""
        self._repository = repository

    def read(self, workspace_id: str, project_id: str, update_id: str) -> UpdateThread:
        """One update's whole thread, replies oldest first."""
        thread = UpdateThread()
        if not workspace_id or not project_id or not update_id:
            return thread
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id)
            & Key("planning_key").begins_with(update_thread_prefix(project_id, update_id)),
            max_items=THREAD_MAX_ITEMS,
        )
        for item in items:
            kind = str(item.get("kind", ""))
            if kind == PROJECT_UPDATE_COMMENT:
                thread.comments.append(UpdateComment.model_validate(dict(item)))
            elif kind == PROJECT_UPDATE_REACTION:
                thread.reactions.append(UpdateReaction.model_validate(dict(item)))
        return thread

    def read_many(self, workspace_id: str, project_id: str, update_ids: Iterable[str]) -> dict[str, UpdateThread]:
        """The threads of several updates of one project, keyed by update id."""
        return {update_id: self.read(workspace_id, project_id, update_id) for update_id in dict.fromkeys(update_ids)}

    def get_comment(self, workspace_id: str, project_id: str, update_id: str, comment_id: str) -> UpdateComment | None:
        """One reply, or `None`; the project and update are part of the key."""
        if not workspace_id or not project_id or not update_id or not comment_id:
            return None
        item = self._repository.get(
            {"workspace_id": workspace_id, "planning_key": update_comment_key(project_id, update_id, comment_id)}
        )
        if item is None or str(item.get("kind", "")) != PROJECT_UPDATE_COMMENT:
            return None
        return UpdateComment.model_validate(dict(item))

    def create_comment(self, comment: UpdateComment) -> UpdateComment:
        """Store a new reply, raising `ConditionFailed` when the key is taken."""
        self._repository.put(_comment_item(comment), condition=Attr("planning_key").not_exists())
        return comment

    def replace_comment(self, comment: UpdateComment) -> UpdateComment:
        """Write an edited reply over its row, raising `ConditionFailed` when it is gone."""
        self._repository.put(_comment_item(comment), condition=Attr("planning_key").exists())
        return comment

    def delete_comment(self, workspace_id: str, project_id: str, update_id: str, comment_id: str) -> None:
        """Remove one reply and every reaction on it."""
        self._delete_prefix(workspace_id, update_reactions_prefix(project_id, update_id, comment_id))
        self._repository.delete(
            {"workspace_id": workspace_id, "planning_key": update_comment_key(project_id, update_id, comment_id)}
        )

    def add_reaction(self, reaction: UpdateReaction) -> UpdateReaction:
        """Store one reaction; the same user and emoji on the same target is the same row."""
        self._repository.put(reaction.model_dump(mode="json"))
        return reaction

    def remove_reaction(
        self, workspace_id: str, project_id: str, update_id: str, target_id: str, emoji: str, user_id: str
    ) -> None:
        """Remove one reaction; removing one that is not there is a no-op."""
        self._repository.delete(
            {
                "workspace_id": workspace_id,
                "planning_key": update_reaction_key(project_id, update_id, target_id, emoji, user_id),
            }
        )

    def delete_thread(self, workspace_id: str, project_id: str, update_id: str) -> int:
        """Remove every reply and reaction of one update, returning how many rows went."""
        if not project_id or not update_id:
            return 0
        return self._delete_prefix(workspace_id, update_thread_prefix(project_id, update_id))

    def delete_project_threads(self, workspace_id: str, project_id: str) -> int:
        """Remove every update thread of one project, returning how many rows went."""
        if not project_id:
            return 0
        return self._delete_prefix(workspace_id, project_threads_prefix(project_id))

    def _delete_prefix(self, workspace_id: str, prefix: str, *, page: int = 100) -> int:
        """Delete every row under one sort key prefix a page at a time."""
        if not workspace_id:
            return 0
        removed = 0
        while True:
            result = self._repository.query(
                Key("workspace_id").eq(workspace_id) & Key("planning_key").begins_with(prefix),
                limit=page,
            )
            if not result.items:
                return removed
            removed += self._repository.delete_many(
                [{"workspace_id": workspace_id, "planning_key": item["planning_key"]} for item in result.items]
            )
