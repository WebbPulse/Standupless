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

import fnmatch
import re
from datetime import datetime
from typing import Any, Mapping, Sequence

from app.common.issue_key_search import FoundKey, Prefixes, find_keys, key_matches

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
        for hit, key in key_matches(window, prefixes):
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


def trigger_for_new_link(action: str, *, state: str, merged: bool, draft: bool) -> str | None:
    """Which trigger a key that only just started naming an issue fires.

    An `edited` event is how a key typed into the title or body of an open pull
    request arrives, and Linear treats that link the same as one present at open:
    the issue starts. A draft stays put, as it does at open, and a pull request that
    is already closed or merged moves nothing, because the event that closed it has
    already been and gone.
    """
    if action != "edited" or merged or state != "open":
        return None
    return None if draft else "pr_opened"


BRANCH_PATTERN_MAX = 255
"""The longest branch pattern a rule may carry, which no real ref name approaches."""

_BRANCH_PATTERN_REFUSED = re.compile(r"[\s~^:\\\x00-\x1f\x7f]")
"""Characters git refuses in a ref name, which a pattern for one can never need."""

_GLOB_CHARACTERS = frozenset("*?[")


def normalize_branch_pattern(value: str | None) -> str:
    """A branch pattern as stored, empty for any branch, raising `ValueError` on a bad one.

    Leading `refs/heads/` is dropped, because GitHub reports the base branch by its
    short name and a pattern copied from a ref would otherwise never match.
    """
    pattern = (value or "").strip()
    if pattern.startswith("refs/heads/"):
        pattern = pattern[len("refs/heads/") :]
    if len(pattern) > BRANCH_PATTERN_MAX:
        raise ValueError(f"A branch pattern is at most {BRANCH_PATTERN_MAX} characters.")
    if _BRANCH_PATTERN_REFUSED.search(pattern):
        raise ValueError("A branch pattern may not contain spaces or any of ~ ^ : \\.")
    return pattern


def branch_matches(pattern: str, branch: str) -> bool:
    """Whether a rule's glob matches the branch a pull request targets, case sensitively as git is."""
    return bool(pattern) and bool(branch) and fnmatch.fnmatchcase(branch, pattern)


def _specificity(pattern: str) -> tuple[int, int]:
    """Sort key putting an exact branch name before a glob, and a longer glob before a shorter one."""
    return (1 if _GLOB_CHARACTERS & set(pattern) else 0, -len(pattern))


def select_rule(rules: Sequence[Any], trigger: str, base_branch: str) -> Any | None:
    """The one rule a trigger fires for a pull request into `base_branch`, or `None`.

    A rule whose branch pattern matches wins over a rule for any branch, and among
    matching patterns an exact name beats a glob and a longer glob beats a shorter
    one, so `main` beats `ma*`, which beats `*`. A rule whose pattern does not match
    is ignored rather than falling back to nothing, so a team with only branch rules
    moves nothing on a pull request into a branch it did not name.
    """
    candidates = [rule for rule in rules if rule.trigger == trigger]
    specific = [rule for rule in candidates if rule.branch_pattern and branch_matches(rule.branch_pattern, base_branch)]
    if specific:
        return sorted(specific, key=lambda rule: _specificity(rule.branch_pattern))[0]
    return next((rule for rule in candidates if not rule.branch_pattern), None)


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


CATEGORY_RANK: Mapping[str, int] = {
    "backlog": 0,
    "unstarted": 1,
    "started": 2,
    "completed": 3,
    "cancelled": 3,
}
"""How far along the workflow each status category sits; the two finished categories share a rank."""

FORWARD_ONLY_TRIGGERS: frozenset[str] = frozenset({"pr_opened", "pr_ready_for_review", "pr_merged"})
"""Triggers that may only move an issue further along, never back.

A promotion pull request names issues that already shipped to staging, and its
opening must not drag them back to review. `pr_closed` is left out because a team
may deliberately send an abandoned pull request's issues back to the queue.
"""


def moves_forward(current: Any | None, target: Any | None) -> bool:
    """Whether moving from `current` to `target` status goes further along the workflow.

    A later category is forward, and within one category a higher `position` is.
    An unknown status on either side allows the move, since there is nothing to
    compare against. Moving between the two finished categories is not forward.
    """
    if current is None or target is None:
        return True
    current_rank = CATEGORY_RANK.get(current.category)
    target_rank = CATEGORY_RANK.get(target.category)
    if current_rank is None or target_rank is None:
        return True
    if target_rank != current_rank:
        return target_rank > current_rank
    if target.category != current.category:
        return False
    return (target.position, target.status_id) > (current.position, current.status_id)
