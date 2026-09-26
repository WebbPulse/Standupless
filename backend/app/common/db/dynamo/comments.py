"""The `comments` table: one issue's thread, in one partition, in written order.

Partitioned per issue so a thread is one query and a page boundary is DynamoDB's
own cursor rather than an offset. The sort key is a ULID, so the table's order is
already chronological and an oldest-first read needs no sort after it.

`team_id` is denormalised onto every row because a reader decides visibility
against the issue's team, and carrying it here is what keeps that decision from
costing a second read per comment.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Mapping

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import Page, Repository, new_ulid

from app.common.db.dynamo.base import as_item, build_repository, utc_now
from app.common.db.dynamo.tables import COMMENTS

AUTHOR_CREATED_INDEX = "ws_author-created_at-index"


def new_comment_id() -> str:
    """A fresh comment id, a ULID so the partition reads in creation order."""
    return new_ulid()


def ws_issue(workspace_id: str, issue_id: str) -> str:
    """The partition key of one issue's thread."""
    return f"{workspace_id}#{issue_id}"


def ws_author(workspace_id: str, author_id: str) -> str:
    """The author index's hash key, scoped to one workspace."""
    return f"{workspace_id}#{author_id}"


class Comment(BaseModel):
    """One comment on an issue.

    `parent_comment_id` is one level deep by contract: a reply cannot itself be
    replied to, which is what keeps `reply_count` a count of direct replies rather
    than a tree walk.
    """

    ws_issue: str
    comment_id: str = Field(default_factory=new_comment_id)
    workspace_id: str
    issue_id: str
    team_id: str
    body: str
    parent_comment_id: str | None = None
    author_id: str
    mentions: list[str] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=utc_now)
    edited_at: datetime | None = None


def build_comment(
    workspace_id: str,
    issue_id: str,
    team_id: str,
    author_id: str,
    body: str,
    *,
    parent_comment_id: str | None = None,
    mentions: list[str] | None = None,
) -> Comment:
    """One comment with its partition key already composed.

    A helper rather than a bare constructor because a row written under a
    hand-built `ws_issue` that is wrong would be invisible rather than rejected.
    """
    return Comment(
        ws_issue=ws_issue(workspace_id, issue_id),
        workspace_id=workspace_id,
        issue_id=issue_id,
        team_id=team_id,
        author_id=author_id,
        body=body,
        parent_comment_id=parent_comment_id,
        mentions=list(mentions or []),
    )


def as_comment(item: Mapping[str, Any]) -> Comment:
    """One stored item as a `Comment`, ignoring the author index's attribute."""
    fields = {key: value for key, value in item.items() if key != "ws_author"}
    return Comment.model_validate(fields)


def as_comment_item(comment: Comment) -> dict[str, Any]:
    """One comment as the stored item, carrying its author index composite."""
    return as_item(comment, ws_author=ws_author(comment.workspace_id, comment.author_id))


class CommentRepository:
    """Reads and writes `comments` rows, every method workspace first."""

    def __init__(self, repository: Repository | None = None) -> None:
        """Take an injected package repository, or build this table's own."""
        self._repository = build_repository(COMMENTS, repository)

    def get(self, workspace_id: str, issue_id: str, comment_id: str) -> Comment | None:
        """One comment of one issue, or `None`.

        The issue is a parameter rather than derived because it is the partition:
        without it this read would be a scan, which the design forbids.
        """
        if not workspace_id or not issue_id or not comment_id:
            return None
        item = self._repository.get({"ws_issue": ws_issue(workspace_id, issue_id), "comment_id": comment_id})
        return as_comment(item) if item is not None else None

    def create(self, comment: Comment) -> Comment:
        """Store a new comment, raising `ConditionFailed` when the id is taken.

        Conditional on absence rather than unconditional because a redelivered
        write must never overwrite a comment somebody has since edited.
        """
        self._repository.put(as_comment_item(comment), condition=Attr("comment_id").not_exists())
        return comment

    def edit(
        self,
        workspace_id: str,
        issue_id: str,
        comment_id: str,
        body: str,
        mentions: list[str],
    ) -> Comment | None:
        """Rewrite one comment's body and mentions, stamping `edited_at`.

        A targeted update rather than a whole-item put, so an edit landing beside a
        concurrent write cannot revert a field it never read.

        The mentions go in the same update as the body because they are derived
        from it: two writes would leave a window in which the stored mentions name
        a body that is no longer there, and the stream consumer reads both.
        """
        item = self._repository.set_attributes(
            {"ws_issue": ws_issue(workspace_id, issue_id), "comment_id": comment_id},
            {"body": body, "mentions": mentions, "edited_at": utc_now().isoformat()},
            condition=Attr("comment_id").exists(),
            return_values="ALL_NEW",
        )
        return as_comment(item) if item is not None else None

    def delete(self, workspace_id: str, issue_id: str, comment_id: str) -> bool:
        """Hard-delete one comment row, reporting whether one was there.

        A delete removes the row rather than setting a flag: the contract has no
        `deleted` field, so a tombstone would be a shape nothing renders.
        """
        if self.get(workspace_id, issue_id, comment_id) is None:
            return False
        self._repository.delete({"ws_issue": ws_issue(workspace_id, issue_id), "comment_id": comment_id})
        return True

    def list_for_issue(
        self,
        workspace_id: str,
        issue_id: str,
        *,
        limit: int = 50,
        start_key: Mapping[str, Any] | None = None,
    ) -> Page:
        """One page of an issue's thread, oldest first as the contract says."""
        return self._repository.query(
            Key("ws_issue").eq(ws_issue(workspace_id, issue_id)),
            limit=limit,
            start_key=dict(start_key) if start_key else None,
            ascending=True,
        )

    def iter_for_issue(self, workspace_id: str, issue_id: str, *, max_items: int = 1000) -> list[Comment]:
        """Every comment of one issue, which a reparent and a delete sweep both need."""
        if not workspace_id or not issue_id:
            return []
        items = self._repository.iter_query(
            Key("ws_issue").eq(ws_issue(workspace_id, issue_id)),
            max_items=max_items,
        )
        return [as_comment(item) for item in items]

    def delete_for_issue(self, workspace_id: str, issue_id: str, *, batch: int = 100) -> int:
        """Remove every comment of one issue, a page at a time, returning how many went."""
        partition = ws_issue(workspace_id, issue_id)
        removed = 0
        while True:
            page = self._repository.query(Key("ws_issue").eq(partition), limit=batch)
            if not page.items:
                return removed
            removed += self._repository.delete_many(
                [{"ws_issue": partition, "comment_id": item["comment_id"]} for item in page.items]
            )

    def clear_parent(self, workspace_id: str, issue_id: str, comment_id: str) -> None:
        """Reparent one reply to the thread root, which a parent's delete leaves behind.

        `remove_attributes` rather than a write of null, so the attribute is absent
        and the model's own default is what a read sees.
        """
        self._repository.remove_attributes(
            {"ws_issue": ws_issue(workspace_id, issue_id), "comment_id": comment_id},
            ["parent_comment_id"],
        )

    def count_replies(self, comments: list[Comment]) -> dict[str, int]:
        """How many direct replies each comment in one thread has.

        Counted from a page already read rather than by a query per comment, which
        is what keeps rendering a thread one round trip.
        """
        counts: dict[str, int] = {}
        for comment in comments:
            parent = comment.parent_comment_id
            if parent:
                counts[parent] = counts.get(parent, 0) + 1
        return counts

    def ancestors(self, workspace_id: str, issue_id: str, comment_id: str, *, depth: int = 16) -> list[Comment]:
        """The chain of comments a reply hangs under, nearest parent first.

        Walked one read at a time up to a depth bound rather than in one query,
        because a thread is a tree and the parents of a deep reply are a handful of
        rows while the thread itself can be thousands. Read by the `views` notify
        consumer to find who was already talking in a subthread.
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
