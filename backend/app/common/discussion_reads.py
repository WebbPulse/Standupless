"""Reads and checks a comment thread and its reactions share across domains.

Issue comments and project update threads render the same author block and the
same reaction groups, and hold a reaction to the same one-emoji rule, so the
shapes live here where both the discussion and planning domains and the MCP
tools can import them without reaching into another domain.
"""

from __future__ import annotations

import unicodedata
from typing import TYPE_CHECKING, Iterable, Optional, Protocol, Sequence

import emoji as emoji_data
from pydantic import BaseModel, Field

from app.common.account_deletion import DELETED_USER_NAME
from app.common.db.dynamo.reactions import USER_IDS_CAP
from app.common.icons import icon_url

if TYPE_CHECKING:
    from app.common.api.dependencies.repositories import Repositories


VARIATION_SELECTOR = "\N{VARIATION SELECTOR-16}"
"""U+FE0F, the emoji presentation selector.

Stripped before the emoji is stored because a client may send either presentation
of the same character, and comparing raw strings would hold them as two reactions.
"""


def normalize_emoji(value: str) -> str:
    """One emoji in the form the sort key is held in.

    NFC first, so a decomposed sequence compares equal, then the variation selector
    is dropped, so both presentations of the same character are one reaction rather
    than two rows a reader sees side by side.
    """
    return unicodedata.normalize("NFC", value).replace(VARIATION_SELECTOR, "")


EMOJI_MAX_CODE_POINTS = 16
"""The bound on an emoji, in code points after normalisation.

The longest emoji in Unicode, a couple with two skin tones joined by zero-width
joiners, is ten, so sixteen admits every one with room for the next release while
refusing a long string before the emoji table is consulted.
"""


def is_single_emoji(value: str) -> bool:
    """Whether a value is exactly one emoji, in either presentation form.

    The `emoji` package holds Unicode's emoji list, with every skin tone, flag,
    keycap and zero-width-joiner sequence as one entry, so a string that is two
    emoji or an emoji with text beside it is not in it.
    """
    return emoji_data.is_emoji(value) or emoji_data.is_emoji(normalize_emoji(value))


def check_emoji(value: str) -> str:
    """Hold a reaction to exactly one emoji, in either presentation form.

    Any single emoji rather than an allow list, because a reader reaches for the
    one that says what they mean. Text and runs of emoji are refused, which keeps
    the sort keys a partition can hold to Unicode's emoji list. The normalised form
    is what is returned, so the stored sort key is the same whether or not the
    caller sent the variation selector.
    """
    raw = value.strip()
    candidate = normalize_emoji(raw)
    if not candidate:
        raise ValueError("emoji must not be empty")
    if len(candidate) > EMOJI_MAX_CODE_POINTS:
        raise ValueError(f"emoji must be at most {EMOJI_MAX_CODE_POINTS} code points")
    if not is_single_emoji(raw):
        raise ValueError("emoji must be a single emoji")
    return candidate


class AuthorRead(BaseModel):
    """Who wrote a comment, denormalised onto the response.

    Rendered from one batched user read per page rather than stored on the row, so
    a display name change is reflected without rewriting every comment.
    """

    user_id: str
    display_name: str = ""
    email: str = ""
    avatar_url: Optional[str] = None


class ReactionGroupRead(BaseModel):
    """One emoji's reactions on one target.

    `reacted` is resolved against the calling user, which is what lets the frontend
    render the caller's own reaction as pressed without a second read.
    """

    emoji: str
    count: int
    user_ids: list[str] = Field(default_factory=list)
    reacted: bool = False


class ReactionLike(Protocol):
    """Any stored reaction: one user and one emoji."""

    @property
    def emoji(self) -> str: ...

    @property
    def user_id(self) -> str: ...


GITHUB_AUTHOR_PREFIX = "github:"
"""The author id prefix of a comment synced from an unlinked GitHub account."""

LINEAR_AUTHOR_PREFIX = "linear:"
"""The author id prefix of a comment imported from Linear whose author matched no member."""

SHORTCUT_AUTHOR_PREFIX = "shortcut:"
"""The author id prefix of a comment imported from Shortcut whose author matched no member."""

ASANA_AUTHOR_PREFIX = "asana:"
"""The author id prefix of a comment imported from Asana whose author matched no member."""

JIRA_AUTHOR_PREFIX = "jira:"
"""The author id prefix of a comment imported from Jira whose author matched no member."""

PLACEHOLDER_AUTHORS: tuple[tuple[str, str], ...] = (
    (GITHUB_AUTHOR_PREFIX, "GitHub"),
    (LINEAR_AUTHOR_PREFIX, "Linear"),
    (SHORTCUT_AUTHOR_PREFIX, "Shortcut"),
    (ASANA_AUTHOR_PREFIX, "Asana"),
    (JIRA_AUTHOR_PREFIX, "Jira"),
)
"""Each placeholder author prefix and the source named after the placeholder's name."""


def authors_for(repositories: Repositories, user_ids: Iterable[str]) -> dict[str, AuthorRead]:
    """The author block for each named user, in one batched read.

    Joined per page rather than denormalised onto every comment row, so a display
    name change shows up without rewriting a thread. A user who is gone still
    renders, carrying their id and the deleted user name, rather than 404ing the
    list they appear in.

    A comment synced from GitHub by someone with no linked account is authored as
    `github:<login>` and renders under that login, without a user lookup. A
    comment imported from Linear, Shortcut, Asana or Jira by someone who is not
    a member is authored as `linear:<name>`, `shortcut:<name>`, `asana:<name>`
    or `jira:<name>` and renders the same way.
    """
    wanted = [user_id for user_id in dict.fromkeys(user_ids) if user_id]
    if not wanted:
        return {}
    resolved: dict[str, AuthorRead] = {}
    for user_id in wanted:
        for prefix, origin in PLACEHOLDER_AUTHORS:
            if user_id.startswith(prefix):
                resolved[user_id] = AuthorRead(
                    user_id=user_id, display_name=f"{user_id.removeprefix(prefix)} ({origin})"
                )
                break
    wanted = [user_id for user_id in wanted if user_id not in resolved]
    users = repositories.users.get_many(wanted) if wanted else {}
    for user_id in wanted:
        user = users.get(user_id)
        if user is None:
            resolved[user_id] = AuthorRead(user_id=user_id, display_name=DELETED_USER_NAME)
            continue
        resolved[user_id] = AuthorRead(
            user_id=user_id,
            display_name=user.display_name,
            email=str(user.email),
            avatar_url=icon_url(user.icon_key),
        )
    return resolved


def group_reactions(rows: Sequence[ReactionLike], caller_id: str) -> list[ReactionGroupRead]:
    """One target's reactions as groups, in the key order they were read in.

    A group with a count of zero is never produced, because a group exists only
    where a row does. `reacted` is resolved here rather than by the frontend so the
    caller's own reaction renders as pressed without a second read.
    """
    order: list[str] = []
    grouped: dict[str, list[str]] = {}
    for row in rows:
        if row.emoji not in grouped:
            grouped[row.emoji] = []
            order.append(row.emoji)
        grouped[row.emoji].append(row.user_id)

    groups: list[ReactionGroupRead] = []
    for emoji in order:
        user_ids = grouped[emoji]
        groups.append(
            ReactionGroupRead(
                emoji=emoji,
                count=len(user_ids),
                user_ids=user_ids[:USER_IDS_CAP],
                reacted=caller_id in user_ids,
            )
        )
    return groups
