"""Finding issue keys in free text, matched against each team's own prefixes.

Held in `common` because the GitHub source in the integrations image and the
release routes in the teams image both read keys out of commit messages, and
neither image may import the other's code. A key means an issue only in the team
whose prefix it carries, so matching is per team rather than one global pattern.
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
