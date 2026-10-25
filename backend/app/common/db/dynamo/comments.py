"""The `comments` table: one issue's thread, in one partition, in written order.

Partitioned per issue so a thread is one query and a page boundary is DynamoDB's
own cursor rather than an offset. The sort key is a ULID, so the table's order is
already chronological and an oldest-first read needs no sort after it.

`team_id` is denormalised onto every row because a reader decides visibility
against the issue's team, and carrying it here is what keeps that decision from
costing a second read per comment.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any, Mapping

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import ConditionFailed, Page, Repository, new_ulid

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


class GithubThread(BaseModel):
    """Where a root comment's thread is mirrored on GitHub.

    `kind` says whether the target is a pull request or a GitHub issue, and
    `private` is the repository's visibility when the thread was synced, which is
    what the composer warns on. `comment_url` is the App's opening comment on
    GitHub, empty until that post lands.
    """

    kind: str = "pull_request"
    repository_id: str
    full_name: str
    number: int
    target_url: str = ""
    private: bool = True
    synced_by: str
    synced_at: datetime = Field(default_factory=utc_now)
    comment_url: str = ""


class SlackThread(BaseModel):
    """The Slack thread a root comment's thread is synced with.

    Set on the root that pairing writes when an issue is created from a Slack
    message: replies in the Slack thread land under this root, and replies under
    this root are posted to the Slack thread. `permalink` is what the comment
    area links to.
    """

    slack_team_id: str
    channel_id: str
    thread_ts: str
    permalink: str = ""
    synced_by: str
    synced_at: datetime = Field(default_factory=utc_now)


class ThreadResolution(BaseModel):
    """Who marked a root comment's thread resolved, and when.

    Held on the root because the root is the thread: a reader collapses the
    thread from the row it already has, and a reply that reopens it clears one
    attribute on one row.
    """

    resolved_by: str
    resolved_at: datetime = Field(default_factory=utc_now)


class CommentAnchor(BaseModel):
    """The passage of the issue description a root comment is pinned to.

    The quoted text plus a little of the text either side, which is what finds the
    passage again among repeats of it. Never written into the description, so an
    edit that removes the passage leaves the quote here and the reader shows it as
    changed.
    """

    quote: str
    prefix: str = ""
    suffix: str = ""


class Comment(BaseModel):
    """One comment on an issue.

    `parent_comment_id` is one level deep by contract: a reply cannot itself be
    replied to, which is what keeps `reply_count` a count of direct replies rather
    than a tree walk. `github_thread` is set on a root comment whose thread is
    mirrored to a GitHub pull request or issue, and `resolution` on a root
    whose thread was marked resolved. `slack_thread` is set on the root that
    pairs the issue with the Slack thread it was created from. `anchor` is set on a root comment started
    from a selected passage of the description.

    `document_id` is set on a comment on a document rather than an issue. Such a
    row is partitioned under the document, carries the document id as its
    `issue_id` so every per-thread read works unchanged, and has no team.
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
    attachment_ids: list[str] = Field(default_factory=list)
    source: str | None = None
    created_at: datetime = Field(default_factory=utc_now)
    edited_at: datetime | None = None
    import_batch_id: str | None = None
    github_thread: GithubThread | None = None
    slack_thread: SlackThread | None = None
    resolution: ThreadResolution | None = None
    anchor: CommentAnchor | None = None
    document_id: str | None = None


def build_comment(
    workspace_id: str,
    issue_id: str,
    team_id: str,
    author_id: str,
    body: str,
    *,
    parent_comment_id: str | None = None,
    mentions: list[str] | None = None,
    attachment_ids: list[str] | None = None,
    source: str | None = None,
    anchor: CommentAnchor | None = None,
    document_id: str | None = None,
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
        attachment_ids=list(attachment_ids or []),
        source=source,
        anchor=anchor,
        document_id=document_id,
    )


def as_comment(item: Mapping[str, Any]) -> Comment:
    """One stored item as a `Comment`, ignoring the author index's attribute."""
    fields = {key: value for key, value in item.items() if key != "ws_author"}
    return Comment.model_validate(fields)


def as_comment_item(comment: Comment) -> dict[str, Any]:
    """One comment as the stored item, carrying its author index composite and no empty bulk marker."""
    item = as_item(comment, ws_author=ws_author(comment.workspace_id, comment.author_id))
    if not item.get("import_batch_id"):
        item.pop("import_batch_id", None)
    if item.get("github_thread") is None:
        item.pop("github_thread", None)
    if item.get("slack_thread") is None:
        item.pop("slack_thread", None)
    if item.get("resolution") is None:
        item.pop("resolution", None)
    if item.get("anchor") is None:
        item.pop("anchor", None)
    if not item.get("document_id"):
        item.pop("document_id", None)
    return item


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

        An edit is a person's change, so it clears the bulk import marker an
        imported comment carries and is announced like any other.
        """
        item = self._repository.update(
            {"ws_issue": ws_issue(workspace_id, issue_id), "comment_id": comment_id},
            update_expression="SET #body = :body, #mentions = :mentions, #edited = :edited REMOVE #batch",
            expression_names={
                "#body": "body",
                "#mentions": "mentions",
                "#edited": "edited_at",
                "#batch": "import_batch_id",
            },
            expression_values={":body": body, ":mentions": mentions, ":edited": utc_now().isoformat()},
            condition=Attr("comment_id").exists(),
            return_values="ALL_NEW",
        )
        return as_comment(item) if item is not None else None

    def set_github_thread(
        self, workspace_id: str, issue_id: str, comment_id: str, thread: GithubThread | None
    ) -> Comment | None:
        """Mark a root comment's thread as mirrored to GitHub, or clear the mark, answering the stored comment.

        Conditioned on the comment being a root, so a reply that was never a thread
        cannot carry one. Not an edit, so `edited_at` is left alone. Answers `None`
        when the comment is gone or is a reply.
        """
        key = {"ws_issue": ws_issue(workspace_id, issue_id), "comment_id": comment_id}
        condition = Attr("comment_id").exists() & (
            Attr("parent_comment_id").not_exists() | Attr("parent_comment_id").attribute_type("NULL")
        )
        try:
            if thread is None:
                item = self._repository.update(
                    key,
                    update_expression="REMOVE #thread",
                    expression_names={"#thread": "github_thread"},
                    condition=condition,
                    return_values="ALL_NEW",
                )
            else:
                item = self._repository.update(
                    key,
                    update_expression="SET #thread = :thread",
                    expression_names={"#thread": "github_thread"},
                    expression_values={":thread": thread.model_dump(mode="json")},
                    condition=condition,
                    return_values="ALL_NEW",
                )
        except ConditionFailed:
            return None
        return as_comment(item) if item is not None else None

    def clear_slack_thread(self, workspace_id: str, issue_id: str, comment_id: str) -> Comment | None:
        """Remove a root comment's Slack thread mark, answering the stored comment.

        What uninstalling Slack does to every synced root, so the comment area stops
        saying the thread is synced. Answers `None` when the comment is gone.
        """
        key = {"ws_issue": ws_issue(workspace_id, issue_id), "comment_id": comment_id}
        try:
            item = self._repository.update(
                key,
                update_expression="REMOVE #thread",
                expression_names={"#thread": "slack_thread"},
                condition=Attr("comment_id").exists(),
                return_values="ALL_NEW",
            )
        except ConditionFailed:
            return None
        return as_comment(item) if item is not None else None

    def set_resolution(
        self, workspace_id: str, issue_id: str, comment_id: str, resolution: ThreadResolution | None
    ) -> Comment | None:
        """Mark a root comment's thread resolved, or clear the mark, answering the stored comment.

        Conditioned on the comment being a root, the same way the GitHub thread
        mark is, so a reply cannot carry a resolution. Not an edit, so `edited_at`
        is left alone. Answers `None` when the comment is gone or is a reply.
        """
        key = {"ws_issue": ws_issue(workspace_id, issue_id), "comment_id": comment_id}
        condition = Attr("comment_id").exists() & (
            Attr("parent_comment_id").not_exists() | Attr("parent_comment_id").attribute_type("NULL")
        )
        try:
            if resolution is None:
                item = self._repository.update(
                    key,
                    update_expression="REMOVE #resolution",
                    expression_names={"#resolution": "resolution"},
                    condition=condition,
                    return_values="ALL_NEW",
                )
            else:
                item = self._repository.update(
                    key,
                    update_expression="SET #resolution = :resolution",
                    expression_names={"#resolution": "resolution"},
                    expression_values={":resolution": resolution.model_dump(mode="json")},
                    condition=condition,
                    return_values="ALL_NEW",
                )
        except ConditionFailed:
            return None
        return as_comment(item) if item is not None else None

    def set_github_thread_url(
        self, workspace_id: str, issue_id: str, comment_id: str, repository_id: str, number: int, url: str
    ) -> bool:
        """Record the App's opening comment on a synced thread, while it still targets that pull request or issue."""
        try:
            self._repository.update(
                {"ws_issue": ws_issue(workspace_id, issue_id), "comment_id": comment_id},
                update_expression="SET #thread.#url = :url",
                expression_names={
                    "#thread": "github_thread",
                    "#url": "comment_url",
                    "#repo": "repository_id",
                    "#number": "number",
                },
                expression_values={":url": url, ":repo": repository_id, ":number": number},
                condition="attribute_exists(#thread) AND #thread.#repo = :repo AND #thread.#number = :number",
                return_values="NONE",
            )
        except ConditionFailed:
            return False
        return True

    def replace_imported(self, comment: Comment) -> Comment:
        """Write a re-imported comment over the row an earlier import wrote, raising `ConditionFailed` when it is gone.

        Only the importer calls this, and the comment carries the new batch id, so
        the rewrite stays off the announcing paths as the first write did.
        """
        self._repository.put(as_comment_item(comment), condition=Attr("comment_id").exists())
        return comment

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

    def iter_by_author(
        self, workspace_id: str, author_id: str, since: datetime, until: datetime, *, max_items: int = 1000
    ) -> list[Comment]:
        """One author's comments written in `[since, until)`, oldest first, across every team.

        Read through the author index with a second of padding each side, since
        stored stamps drop a zero fraction, then cut to the exact window.
        """
        if not workspace_id or not author_id or since >= until:
            return []
        lower = (since - timedelta(seconds=1)).astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S")
        upper = (until + timedelta(seconds=1)).astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S")
        items = self._repository.iter_query(
            Key("ws_author").eq(ws_author(workspace_id, author_id)) & Key("created_at").between(lower, upper),
            index_name=AUTHOR_CREATED_INDEX,
            ascending=True,
            max_items=max_items,
        )
        comments = [as_comment(item) for item in items]
        return [comment for comment in comments if since <= comment.created_at < until]

    def list_by_author(
        self, workspace_id: str, author_id: str, *, before: datetime | None = None, max_items: int = 50
    ) -> list[Comment]:
        """One author's comments in one workspace, newest first, from `before` back.

        `before` is padded by a second because stored stamps drop a zero fraction,
        so the caller cuts the exact boundary from the parsed rows.
        """
        if not workspace_id or not author_id:
            return []
        condition = Key("ws_author").eq(ws_author(workspace_id, author_id))
        if before is not None:
            upper = (before + timedelta(seconds=1)).astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S")
            condition = condition & Key("created_at").lte(upper)
        items = self._repository.iter_query(
            condition,
            index_name=AUTHOR_CREATED_INDEX,
            ascending=False,
            max_items=max_items,
            page_size=max_items,
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
