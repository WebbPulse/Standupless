"""Finding issue keys in what a pull request says, and deciding what that moves.

Two rules from design section 4 shape all of this. Keys are matched against each
team's own prefix rather than one global pattern, because `ABC-1` means an issue
only in a team whose prefix is `ABC` and means nothing anywhere else; matching
globally would let a branch name in one customer's repository name a row in another
team. And magic words count only in the pull request title and body, never in a
commit message, so that a rebase which rewrites history cannot reclose an issue
somebody deliberately reopened.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Mapping, Sequence

MAGIC_WORDS: tuple[str, ...] = (
    "close",
    "closes",
    "closed",
    "fix",
    "fixes",
    "fixed",
    "resolve",
    "resolves",
    "resolved",
)
"""The words that close an issue on merge, in the forms GitHub itself accepts."""

_MAGIC_PATTERN = re.compile(
    r"\b(" + "|".join(MAGIC_WORDS) + r")\b[\s:]+(?=[A-Za-z])",
    re.IGNORECASE,
)


Prefixes = Mapping[str, str | Sequence[str]]
"""Each team id mapped to its key prefix, or to its current prefix then its retired ones."""


@dataclass(frozen=True)
class FoundKey:
    """One issue key found in a pull request, and whether it closes on merge.

    `key` is always written under the team's current prefix, even when the text
    named a retired one, so a link row and a write-back comment show the key the
    issue carries today.
    """

    team_id: str
    key: str
    number: int
    magic_word: str | None


def key_pattern(prefix: str) -> re.Pattern[str]:
    """The pattern matching one team's keys, case insensitively.

    Bounded on both sides so `ABC-12` in `XABC-123` is not a match, and the prefix
    is escaped because it comes from stored data rather than from this module.
    """
    return re.compile(rf"(?<![A-Za-z0-9]){re.escape(prefix)}-(\d+)(?![0-9])", re.IGNORECASE)


def _team_prefixes(prefixes: Prefixes) -> list[tuple[str, str, str]]:
    """Every `(team_id, searched prefix, current prefix)` triple, current prefixes first.

    A prefix is held by one team at a time, so a current prefix wins over another
    team's alias of the same text should the two ever meet.
    """
    current: list[tuple[str, str, str]] = []
    retired: list[tuple[str, str, str]] = []
    for team_id, value in prefixes.items():
        names = [value] if isinstance(value, str) else list(value)
        names = [name.upper() for name in names if name]
        if not names:
            continue
        current.append((team_id, names[0], names[0]))
        retired.extend((team_id, name, names[0]) for name in names[1:])
    claimed = {prefix for _team, prefix, _current in current}
    return current + [row for row in retired if row[1] not in claimed]


def _matches(text: str, prefixes: Prefixes) -> list[tuple[re.Match[str], FoundKey]]:
    """Each key match in `text` with the key it names, one per team and number."""
    found: list[tuple[re.Match[str], FoundKey]] = []
    seen: set[tuple[str, int]] = set()
    for team_id, prefix, current in _team_prefixes(prefixes):
        for match in key_pattern(prefix).finditer(text):
            number = int(match.group(1))
            if (team_id, number) in seen:
                continue
            seen.add((team_id, number))
            found.append((match, FoundKey(team_id=team_id, key=f"{current}-{number}", number=number, magic_word=None)))
    return found


def find_keys(text: str, prefixes: Prefixes) -> list[FoundKey]:
    """Every issue key in one piece of text, matched against each team's prefixes.

    `prefixes` maps a team id to its key prefix, or to its current prefix followed
    by the ones it retired, and only those teams are searched, which is what drops
    a key naming a team the installation is not linked to rather than silently
    moving it. A retired prefix still names the team, so a branch cut before a
    key change keeps linking.

    A key found here carries no magic word: closing is decided in `find_closing`
    over the title and body alone, so this can be used on a commit message too.
    """
    if not text:
        return []
    found = [key for _match, key in _matches(text, prefixes)]
    return sorted(found, key=lambda row: (row.team_id, row.number))


def find_closing(text: str, prefixes: Prefixes) -> dict[tuple[str, int], str]:
    """Which issues this text closes, as `(team_id, number)` mapped to the magic word.

    A word counts only when the key follows it directly, so "fixes ABC-1" closes and
    "ABC-1 is not fixed" does not. The window is deliberately short: anything longer
    starts matching a key mentioned in a later sentence. Keyed by team and number
    rather than by the written key, so a retired prefix closes the same issue.
    """
    if not text:
        return {}
    closing: dict[tuple[str, int], str] = {}
    for match in _MAGIC_PATTERN.finditer(text):
        word = match.group(1).lower()
        window = text[match.end() : match.end() + 32]
        for hit, key in _matches(window, prefixes):
            if hit.start() == 0:
                closing[(key.team_id, key.number)] = word
    return closing


def extract(
    prefixes: Prefixes,
    *,
    branch: str = "",
    title: str = "",
    body: str = "",
    commit_messages: Sequence[str] = (),
) -> list[FoundKey]:
    """Every key this pull request or push mentions, with its closing word if any.

    The four sources are searched in the order design section 4 lists them and a key
    found twice is kept once. The magic word is read from the title and body only,
    which is what a commit message cannot contribute.
    """
    closing = {**find_closing(title, prefixes), **find_closing(body, prefixes)}

    keys: dict[tuple[str, int], FoundKey] = {}
    for text in (branch, title, body, *commit_messages):
        for found in find_keys(text, prefixes):
            keys.setdefault((found.team_id, found.number), found)

    return [
        FoundKey(
            team_id=found.team_id,
            key=found.key,
            number=found.number,
            magic_word=closing.get((found.team_id, found.number)),
        )
        for found in sorted(keys.values(), key=lambda row: (row.team_id, row.number))
    ]


def trigger_for(action: str, *, merged: bool, draft: bool) -> str | None:
    """Which transition trigger a pull request event fires, or `None` for neither.

    A closed pull request is either merged or abandoned and the two mean opposite
    things, so `closed` splits on `merged` rather than being one trigger. A draft
    opening fires nothing: work that is not ready for review has not started in any
    sense a status should claim.
    """
    if action in ("opened", "reopened"):
        return None if draft else "pr_opened"
    if action == "ready_for_review":
        return "pr_ready_for_review"
    if action == "closed":
        return "pr_merged" if merged else "pr_closed"
    return None


def pr_state(*, state: str, merged: bool, draft: bool) -> str:
    """How a pull request's state is recorded on the link row."""
    if merged:
        return "merged"
    if state == "closed":
        return "closed"
    return "draft" if draft else "open"


def resolve_status(
    trigger: str,
    stored: Sequence[Any],
    statuses: Sequence[Any],
) -> str | None:
    """Which status a trigger moves an issue to, or `None` for no move.

    A team with stored rules uses them alone. A team with none falls back to
    the design section 4 defaults, which name a status category rather than an id so
    the rule still means something in a team whose statuses were renamed. The
    lowest `position` status of the category wins, which is the one a person reading
    the board would call the first "in progress" or "done" column.
    """
    for rule in stored:
        if rule.trigger == trigger:
            return rule.status_id or None
    if stored:
        return None

    from app.common.db.dynamo.team_config import DEFAULT_TRANSITIONS

    for default_trigger, category, _position in DEFAULT_TRANSITIONS:
        if default_trigger != trigger:
            continue
        candidates = [status for status in statuses if status.category == category]
        if not candidates:
            return None
        return sorted(candidates, key=lambda row: (row.position, row.status_id))[0].status_id
    return None


def may_apply(issue_updated_at: datetime | None, event_at: datetime | None) -> bool:
    """Whether a transition may still move an issue a person has since touched.

    The guard design section 4 requires: an issue whose `updated_at` is later than
    the pull request event was raised has been changed by hand after the event, and
    a queued transition must not undo that. Missing either timestamp allows the move,
    because a delivery that carries no time is a first delivery rather than a replay.
    """
    if issue_updated_at is None or event_at is None:
        return True
    return issue_updated_at <= event_at
