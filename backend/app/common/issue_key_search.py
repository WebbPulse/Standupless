"""Finding issue keys in free text, matched against each team's own prefixes.

Held in `common` because the GitHub source in the integrations image and the
release routes in the teams image both read keys out of commit messages, and
neither image may import the other's code. A key means an issue only in the team
whose prefix it carries, so matching is per team rather than one global pattern.

Which keys move an issue is decided here too, in `extract`, so that a pull request
merge and release stage automation apply the same rule: a key in a commit's subject
line or after a closing or `Refs` style word moves, a key a commit's body only
mentions in prose moves nothing, and a key named after `Relates to` only links.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Mapping, Sequence

Prefixes = Mapping[str, str | Sequence[str]]
"""Each team id mapped to its key prefix, or to its current prefix then its retired ones."""


@dataclass(frozen=True)
class FoundKey:
    """One issue key found in a pull request, and whether it closes on merge.

    `key` is always written under the team's current prefix, even when the text
    named a retired one, so a link row and a write-back comment show the key the
    issue carries today. `moves_status` is false for a key the pull request only
    mentions in passing or names after a related word such as `Relates to`, which
    links the issue without moving its status.
    `holds_on_merge` is true for a key named only after a non-closing word such as
    `Refs`, which moves as the pull request opens but stays put when it merges.
    """

    team_id: str
    key: str
    number: int
    magic_word: str | None
    moves_status: bool = True
    holds_on_merge: bool = False


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


def key_matches(text: str, prefixes: Prefixes) -> list[tuple[re.Match[str], FoundKey]]:
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
    found = [key for _match, key in key_matches(text, prefixes)]
    return sorted(found, key=lambda row: (row.team_id, row.number))


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

REFERENCE_WORDS: tuple[str, ...] = (
    "ref",
    "refs",
    "references",
    "part of",
    "contributes to",
    "toward",
    "towards",
    "update",
    "updates",
)
"""The words that mark a pull request as contributing to an issue: it moves as the pull request opens, never closes."""

RELATED_WORDS: tuple[str, ...] = (
    "related to",
    "relates to",
)
"""The words that mark a pull request as only related to an issue, which links it and never moves its status."""


def _word_pattern(words: Sequence[str]) -> re.Pattern[str]:
    """The pattern matching any of `words` right before a key, spaces matching any whitespace."""
    return re.compile(
        r"\b(" + "|".join(word.replace(" ", r"\s+") for word in words) + r")\b[\s:]+(?=[A-Za-z])",
        re.IGNORECASE,
    )


_MAGIC_PATTERN = _word_pattern(MAGIC_WORDS)

_REFERENCE_PATTERN = _word_pattern(REFERENCE_WORDS)

_RELATED_PATTERN = _word_pattern(RELATED_WORDS)


_LIST_SEPARATOR = re.compile(r"\s*(?:,\s*(?:and\s+|&\s*)?|\s+and\s+|\s*&\s*)")
"""What joins one key to the next in a list a single word governs, as in `Fixes A-1, A-2 and A-3`."""


def _key_at(text: str, position: int, prefixes: Prefixes) -> tuple[tuple[str, int], int] | None:
    """The key that starts exactly at `position`, with the offset just past it, or `None`."""
    window = text[position : position + 32]
    for hit, key in key_matches(window, prefixes):
        if hit.start() == 0:
            return (key.team_id, key.number), position + hit.end()
    return None


def _keys_after(pattern: re.Pattern[str], text: str, prefixes: Prefixes) -> dict[tuple[str, int], str]:
    """Each key a match of `pattern` governs, mapped to the matched word.

    The word governs the key right after it and any further keys joined to it by a
    comma, `and` or `&`. Anything else ends the list, so a full stop, a newline or
    another word such as `refs` hands the keys after it to whatever governs them.
    """
    if not text:
        return {}
    named: dict[tuple[str, int], str] = {}
    for match in pattern.finditer(text):
        word = " ".join(match.group(1).lower().split())
        position = match.end()
        while True:
            found = _key_at(text, position, prefixes)
            if found is None:
                break
            ident, position = found
            named[ident] = word
            separator = _LIST_SEPARATOR.match(text, position)
            if separator is None:
                break
            position = separator.end()
    return named


def find_closing(text: str, prefixes: Prefixes) -> dict[tuple[str, int], str]:
    """Which issues this text closes, as `(team_id, number)` mapped to the magic word.

    A word counts only when the key follows it directly, so "fixes ABC-1" closes and
    "ABC-1 is not fixed" does not. A list joined by commas or `and` closes every key
    in it, and a sentence break or another word ends it, so "Fixes ABC-1. Refs
    ABC-2" and "Fixes ABC-1, refs ABC-2" close ABC-1 alone. Keyed by team and number
    rather than by the written key, so a retired prefix closes the same issue.
    """
    return _keys_after(_MAGIC_PATTERN, text, prefixes)


def find_referencing(text: str, prefixes: Prefixes) -> dict[tuple[str, int], str]:
    """Which issues this text names after a non-closing word such as `Refs` or `Part of`.

    Such a key moves the issue as the pull request opens and becomes ready, the
    same as a key in the title, but a merge leaves it where it is.
    """
    return _keys_after(_REFERENCE_PATTERN, text, prefixes)


def find_related(text: str, prefixes: Prefixes) -> dict[tuple[str, int], str]:
    """Which issues this text names after a related word such as `Relates to`.

    Such a key links the issue and moves nothing on any pull request event, unless
    a closing or contributing word names it too, since the strongest word wins.
    """
    return _keys_after(_RELATED_PATTERN, text, prefixes)


_MERGE_COMMIT_SUBJECT = re.compile(r"^Merge pull request #\d+\b")
"""The first line GitHub writes for a merge commit, whose next line is the pull request's title."""


def commit_subject(message: str) -> tuple[str, str]:
    """A commit message split into the subject that may move an issue and the body that only mentions.

    The subject is the first line, as a squash merge writes the pull request's title
    there. A merge commit's first line only names the branch and puts the title on
    the next non-empty line, so that line belongs to the subject too.
    """
    lines = message.strip().splitlines()
    if not lines:
        return "", ""
    subject = [lines[0]]
    rest = lines[1:]
    if _MERGE_COMMIT_SUBJECT.match(lines[0].strip()):
        while rest and not rest[0].strip():
            rest = rest[1:]
        if rest:
            subject.append(rest[0])
            rest = rest[1:]
    return "\n".join(subject), "\n".join(rest)


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
    which is what a commit message cannot contribute. A key moves its issue's status
    when the branch, the title, a commit's subject line, or a closing or `Refs` style
    word in the body or a commit names it; a bare mention in the body or in a
    commit's body only links. A key that a `Refs` style word names and no closing
    word does holds on merge, even when the title or branch also carries it, because
    `Refs` is how a pull request says it is only part of the work.

    A key a related word such as `Relates to` names only links, even when the
    branch, the title or a commit's subject carries it, unless a closing or
    contributing word names it too. A related word in the title or body governs the
    whole pull request, and one in a commit governs that commit alone.
    """
    closing = {**find_closing(title, prefixes), **find_closing(body, prefixes)}
    referencing = {**find_referencing(title, prefixes), **find_referencing(body, prefixes)}
    closed_anywhere = set(closing)
    for message in commit_messages:
        closed_anywhere |= set(find_closing(message, prefixes))
        referencing.update(find_referencing(message, prefixes))
    held = set(referencing) - closed_anywhere
    related = {*find_related(title, prefixes), *find_related(body, prefixes)}

    keys: dict[tuple[str, int], FoundKey] = {}
    moving: set[tuple[str, int]] = closed_anywhere | set(referencing)
    sources: list[tuple[str, bool, set[tuple[str, int]]]] = [
        (branch, True, related),
        (title, True, related),
        (body, False, related),
    ]
    for message in commit_messages:
        subject, rest = commit_subject(message)
        quiet = related | set(find_related(message, prefixes))
        sources.extend([(subject, True, quiet), (rest, False, quiet)])
    for text, moves, quiet in sources:
        for found in find_keys(text, prefixes):
            ident = (found.team_id, found.number)
            keys.setdefault(ident, found)
            if moves and ident not in quiet:
                moving.add(ident)

    return [
        FoundKey(
            team_id=found.team_id,
            key=found.key,
            number=found.number,
            magic_word=closing.get((found.team_id, found.number)),
            moves_status=(found.team_id, found.number) in moving,
            holds_on_merge=(found.team_id, found.number) in held,
        )
        for found in sorted(keys.values(), key=lambda row: (row.team_id, row.number))
    ]


def moving_commit_keys(messages: Sequence[str], prefixes: Prefixes) -> list[FoundKey]:
    """The keys these commit messages name in a way that may move an issue, first named first.

    A key moves when `extract` says it does: in a commit's subject line, a merge
    commit's title, or after a closing or `Refs` style word. A key only a commit's
    body mentions in prose, or one a related word such as `Relates to` names, is
    left out.
    """
    moving = {(row.team_id, row.number) for row in extract(prefixes, commit_messages=messages) if row.moves_status}
    ordered: dict[tuple[str, int], FoundKey] = {}
    for message in messages:
        for found in find_keys(message, prefixes):
            ident = (found.team_id, found.number)
            if ident in moving:
                ordered.setdefault(ident, found)
    return list(ordered.values())
