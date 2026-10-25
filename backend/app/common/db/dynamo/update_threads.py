"""Replies and reactions on project and initiative updates, filed in the `planning` table.

Every row of one project update's thread shares the sort key prefix
`update_thread#<project_id>#<update_id>#`, so the whole thread is one query, an
update's delete is one prefix delete, and a project's delete clears
`update_thread#<project_id>#`. `begins_with("project_update#")` never matches it,
so the update feed never reads a thread row.

An initiative update's thread is the same shape under its own root,
`initiative_update_thread#<initiative_id>#<update_id>#`, with its own row kinds
and an `initiative_id` in place of the `project_id`, so the two subjects never
share a key or a stream filter and `begins_with("initiative_update#")` never
matches one either. A `ThreadSubject` names which of the two a store serves.

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

INITIATIVE_UPDATE_THREAD_KEY_PREFIX = "initiative_update_thread#"

PROJECT_UPDATE_COMMENT = "project_update_comment"

PROJECT_UPDATE_REACTION = "project_update_reaction"

INITIATIVE_UPDATE_COMMENT = "initiative_update_comment"

INITIATIVE_UPDATE_REACTION = "initiative_update_reaction"

THREAD_MAX_ITEMS = 5000
"""The most rows one thread read walks, bounding a runaway partition."""


@dataclass(frozen=True)
class ThreadSubject:
    """What a store's threads hang off: a project's updates or an initiative's.

    `root` starts every sort key, the kinds tag the rows so a stream filter tells
    the two apart, and `parent_field` is the attribute that names the parent.
    """

    root: str
    comment_kind: str
    reaction_kind: str
    parent_field: str


PROJECT_THREADS = ThreadSubject(UPDATE_THREAD_KEY_PREFIX, PROJECT_UPDATE_COMMENT, PROJECT_UPDATE_REACTION, "project_id")
"""The threads under project updates."""

INITIATIVE_THREADS = ThreadSubject(
    INITIATIVE_UPDATE_THREAD_KEY_PREFIX, INITIATIVE_UPDATE_COMMENT, INITIATIVE_UPDATE_REACTION, "initiative_id"
)
"""The threads under initiative updates."""


def project_threads_prefix(parent_id: str, subject: ThreadSubject = PROJECT_THREADS) -> str:
    """The sort key prefix every update thread of one project, or initiative, shares."""
    return f"{subject.root}{parent_id}#"


def update_thread_prefix(parent_id: str, update_id: str, subject: ThreadSubject = PROJECT_THREADS) -> str:
    """The sort key prefix every row of one update's thread shares."""
    return f"{project_threads_prefix(parent_id, subject)}{update_id}#"


def update_comment_key(
    parent_id: str, update_id: str, comment_id: str, subject: ThreadSubject = PROJECT_THREADS
) -> str:
    """The sort key of one reply on an update."""
    return f"{update_thread_prefix(parent_id, update_id, subject)}comment#{comment_id}"


def update_reactions_prefix(
    parent_id: str, update_id: str, target_id: str, subject: ThreadSubject = PROJECT_THREADS
) -> str:
    """The sort key prefix of every reaction on one target in an update's thread."""
    return f"{update_thread_prefix(parent_id, update_id, subject)}reaction#{target_id}#"


def update_reaction_key(
    parent_id: str,
    update_id: str,
    target_id: str,
    emoji: str,
    user_id: str,
    subject: ThreadSubject = PROJECT_THREADS,
) -> str:
    """The sort key of one user's reaction with one emoji on one target."""
    return f"{update_reactions_prefix(parent_id, update_id, target_id, subject)}{emoji}#{user_id}"


def _project_of(subject: ThreadSubject, parent_id: str) -> str | None:
    """The `project_id` a row of one subject carries, `None` under an initiative."""
    return parent_id if subject.parent_field == "project_id" else None


def _initiative_of(subject: ThreadSubject, parent_id: str) -> str | None:
    """The `initiative_id` a row of one subject carries, `None` under a project."""
    return parent_id if subject.parent_field == "initiative_id" else None


class UpdateComment(BaseModel):
    """One reply on a project or initiative update; exactly one of the parent ids is set."""

    workspace_id: str
    planning_key: str
    comment_id: str
    update_id: str
    project_id: str | None = None
    initiative_id: str | None = None
    kind: str = PROJECT_UPDATE_COMMENT
    body: str
    author_id: str
    mentions: list[str] = Field(default_factory=list)
    source: str | None = None
    created_at: datetime = Field(default_factory=utc_now)
    edited_at: datetime | None = None

    @property
    def parent_id(self) -> str:
        """The project or initiative the reply's update belongs to."""
        return self.project_id or self.initiative_id or ""


class UpdateReaction(BaseModel):
    """One user's reaction to a project or initiative update or to one of its replies."""

    workspace_id: str
    planning_key: str
    update_id: str
    project_id: str | None = None
    initiative_id: str | None = None
    kind: str = PROJECT_UPDATE_REACTION
    target_id: str
    emoji: str
    user_id: str
    created_at: datetime = Field(default_factory=utc_now)


def build_update_comment(
    workspace_id: str,
    parent_id: str,
    update_id: str,
    *,
    body: str,
    author_id: str,
    mentions: list[str],
    source: str | None,
    subject: ThreadSubject = PROJECT_THREADS,
) -> UpdateComment:
    """A new reply with a fresh ULID and its sort key composed."""
    comment_id = new_ulid()
    return UpdateComment(
        workspace_id=workspace_id,
        planning_key=update_comment_key(parent_id, update_id, comment_id, subject),
        comment_id=comment_id,
        update_id=update_id,
        kind=subject.comment_kind,
        project_id=_project_of(subject, parent_id),
        initiative_id=_initiative_of(subject, parent_id),
        body=body,
        author_id=author_id,
        mentions=mentions,
        source=source,
    )


def build_update_reaction(
    workspace_id: str,
    parent_id: str,
    update_id: str,
    *,
    target_id: str,
    emoji: str,
    user_id: str,
    subject: ThreadSubject = PROJECT_THREADS,
) -> UpdateReaction:
    """One reaction with its sort key composed."""
    return UpdateReaction(
        workspace_id=workspace_id,
        planning_key=update_reaction_key(parent_id, update_id, target_id, emoji, user_id, subject),
        update_id=update_id,
        kind=subject.reaction_kind,
        project_id=_project_of(subject, parent_id),
        initiative_id=_initiative_of(subject, parent_id),
        target_id=target_id,
        emoji=emoji,
        user_id=user_id,
    )


def _stored_item(row: BaseModel) -> dict[str, Any]:
    """One thread row as the stored item, its unset optional fields left off."""
    item = row.model_dump(mode="json")
    for name in ("edited_at", "source", "project_id", "initiative_id"):
        if item.get(name) is None:
            item.pop(name, None)
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
    """Reads and writes one subject's update threads over the `planning` table's package repository."""

    def __init__(self, repository: Repository, subject: ThreadSubject = PROJECT_THREADS) -> None:
        """Share the planning table's repository, serving the threads of one subject."""
        self._repository = repository
        self.subject = subject

    def read(self, workspace_id: str, parent_id: str, update_id: str) -> UpdateThread:
        """One update's whole thread, replies oldest first."""
        thread = UpdateThread()
        if not workspace_id or not parent_id or not update_id:
            return thread
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id)
            & Key("planning_key").begins_with(update_thread_prefix(parent_id, update_id, self.subject)),
            max_items=THREAD_MAX_ITEMS,
        )
        for item in items:
            kind = str(item.get("kind", ""))
            if kind == self.subject.comment_kind:
                thread.comments.append(UpdateComment.model_validate(dict(item)))
            elif kind == self.subject.reaction_kind:
                thread.reactions.append(UpdateReaction.model_validate(dict(item)))
        return thread

    def read_many(self, workspace_id: str, parent_id: str, update_ids: Iterable[str]) -> dict[str, UpdateThread]:
        """The threads of several updates of one project or initiative, keyed by update id."""
        return {update_id: self.read(workspace_id, parent_id, update_id) for update_id in dict.fromkeys(update_ids)}

    def get_comment(self, workspace_id: str, parent_id: str, update_id: str, comment_id: str) -> UpdateComment | None:
        """One reply, or `None`; the parent and update are part of the key."""
        if not workspace_id or not parent_id or not update_id or not comment_id:
            return None
        item = self._repository.get(
            {
                "workspace_id": workspace_id,
                "planning_key": update_comment_key(parent_id, update_id, comment_id, self.subject),
            }
        )
        if item is None or str(item.get("kind", "")) != self.subject.comment_kind:
            return None
        return UpdateComment.model_validate(dict(item))

    def create_comment(self, comment: UpdateComment) -> UpdateComment:
        """Store a new reply, raising `ConditionFailed` when the key is taken."""
        self._repository.put(_stored_item(comment), condition=Attr("planning_key").not_exists())
        return comment

    def replace_comment(self, comment: UpdateComment) -> UpdateComment:
        """Write an edited reply over its row, raising `ConditionFailed` when it is gone."""
        self._repository.put(_stored_item(comment), condition=Attr("planning_key").exists())
        return comment

    def delete_comment(self, workspace_id: str, parent_id: str, update_id: str, comment_id: str) -> None:
        """Remove one reply and every reaction on it."""
        self._delete_prefix(workspace_id, update_reactions_prefix(parent_id, update_id, comment_id, self.subject))
        self._repository.delete(
            {
                "workspace_id": workspace_id,
                "planning_key": update_comment_key(parent_id, update_id, comment_id, self.subject),
            }
        )

    def add_reaction(self, reaction: UpdateReaction) -> UpdateReaction:
        """Store one reaction; the same user and emoji on the same target is the same row."""
        self._repository.put(_stored_item(reaction))
        return reaction

    def remove_reaction(
        self, workspace_id: str, parent_id: str, update_id: str, target_id: str, emoji: str, user_id: str
    ) -> None:
        """Remove one reaction; removing one that is not there is a no-op."""
        self._repository.delete(
            {
                "workspace_id": workspace_id,
                "planning_key": update_reaction_key(parent_id, update_id, target_id, emoji, user_id, self.subject),
            }
        )

    def delete_thread(self, workspace_id: str, parent_id: str, update_id: str) -> int:
        """Remove every reply and reaction of one update, returning how many rows went."""
        if not parent_id or not update_id:
            return 0
        return self._delete_prefix(workspace_id, update_thread_prefix(parent_id, update_id, self.subject))

    def delete_project_threads(self, workspace_id: str, parent_id: str) -> int:
        """Remove every update thread of one project, or initiative, returning how many rows went."""
        if not parent_id:
            return 0
        return self._delete_prefix(workspace_id, project_threads_prefix(parent_id, self.subject))

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
