"""Read-only access to the `comments` table, owned by the `discussion` domain.

`views` reads a thread to find who should hear about a new comment, and nothing
here writes: the write path belongs to the domain that owns the table, and the
`views` Terraform grant is read only, so a write attempted from here would fail at
IAM rather than quietly succeeding.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Mapping

from boto3.dynamodb.conditions import Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import Repository

from app.common.db.dynamo.base import build_repository, utc_now
from app.common.db.dynamo.tables import COMMENTS


def comment_partition(workspace_id: str, issue_id: str) -> str:
    """The partition one issue's thread lives in, workspace first."""
    return f"{workspace_id}#{issue_id}"


class Comment(BaseModel):
    """One comment, as much of it as a reader of the thread needs."""

    ws_issue: str
    comment_id: str
    workspace_id: str
    issue_id: str
    project_id: str = ""
    parent_comment_id: str | None = None
    body: str = ""
    mentions: list[str] = Field(default_factory=list)
    author_id: str = ""
    created_at: datetime = Field(default_factory=utc_now)
    edited_at: datetime | None = None


class CommentReadRepository:
    """Reads `comments` rows, one issue thread at a time."""

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = build_repository(COMMENTS, repository)

    def get(self, workspace_id: str, issue_id: str, comment_id: str) -> Comment | None:
        """One comment of one thread, or `None`."""
        if not workspace_id or not issue_id or not comment_id:
            return None
        item = self._repository.get({"ws_issue": comment_partition(workspace_id, issue_id), "comment_id": comment_id})
        return Comment.model_validate(dict(item)) if item is not None else None

    def get_many(self, workspace_id: str, issue_id: str, comment_ids: list[str]) -> dict[str, Comment]:
        """Several comments of one thread, keyed by id, missing ones absent.

        `batch_get` rather than `get_many` because the table's key is composite, and
        `get_many` keys its result by one attribute it does not have here.
        """
        if not comment_ids:
            return {}
        partition = comment_partition(workspace_id, issue_id)
        keys = [{"ws_issue": partition, "comment_id": comment_id} for comment_id in dict.fromkeys(comment_ids)]
        items: list[Mapping[str, Any]] = list(self._repository.batch_get(keys))
        comments = [Comment.model_validate(dict(item)) for item in items]
        return {comment.comment_id: comment for comment in comments}

    def ancestors(self, workspace_id: str, issue_id: str, comment_id: str, *, depth: int = 16) -> list[Comment]:
        """The chain of comments a reply hangs under, nearest parent first.

        Walked one read at a time up to a depth bound rather than in one query,
        because a thread is a tree and the parents of a deep reply are a handful of
        rows while the thread itself can be thousands.
        """
        chain: list[Comment] = []
        seen: set[str] = {comment_id}
        current = self.get(workspace_id, issue_id, comment_id)
        while current is not None and current.parent_comment_id and len(chain) < depth:
            if current.parent_comment_id in seen:
                break
            seen.add(current.parent_comment_id)
            parent = self.get(workspace_id, issue_id, current.parent_comment_id)
            if parent is None:
                break
            chain.append(parent)
            current = parent
        return chain

    def thread(self, workspace_id: str, issue_id: str, *, limit: int = 500) -> list[Comment]:
        """One issue's thread in sort key order, oldest first."""
        if not workspace_id or not issue_id:
            return []
        items = self._repository.iter_query(
            Key("ws_issue").eq(comment_partition(workspace_id, issue_id)),
            max_items=limit,
        )
        return [Comment.model_validate(dict(item)) for item in items]
