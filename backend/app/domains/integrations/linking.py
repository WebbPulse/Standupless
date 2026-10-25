"""Finding issue keys in what a pull request says, and deciding what that moves.

Two rules from design section 4 shape all of this. Keys are matched against each
team's own prefix rather than one global pattern, because `ABC-1` means an issue
only in a team whose prefix is `ABC` and means nothing anywhere else; matching
globally would let a branch name in one customer's repository name a row in another
team. And magic words count only in the pull request title and body, never in a
commit message, so that a rebase which rewrites history cannot reclose an issue
somebody deliberately reopened.

As in Linear, only a key in the branch name, in the title, in a commit's subject
line, or right after a magic word moves an issue's status. A key the body or a
commit's body mentions in passing still links the pull request to the issue, and
moves nothing. A key named after a contributing word such as `Refs` or `Updates`
moves as the pull request opens but never on its merge, which only a closing word
may trigger. A key named after `Relates to` or `Related to` only links.
"""

from __future__ import annotations

import fnmatch
import re
from datetime import datetime
from typing import Any, Mapping, Sequence

from app.common.issue_key_search import FoundKey as FoundKey
from app.common.issue_key_search import commit_subject as commit_subject
from app.common.issue_key_search import extract as extract
from app.common.issue_key_search import find_keys as find_keys

_PULL_CITATION = re.compile(r"^Merge pull request #(\d+)\b|\(#(\d+)\)\s*$")
"""How a commit's first line names the pull request it came from, as a squash or a merge commit writes it."""


def cited_pull_number(message: str) -> int | None:
    """The pull request a commit message says it came from, or `None` when it names none.

    A squash merge ends its title with `(#123)` and a merge commit opens with
    `Merge pull request #123`, which is how a promotion's commits lead back to the
    pull requests that shipped them to staging.
    """
    lines = message.strip().splitlines()
    if not lines:
        return None
    match = _PULL_CITATION.search(lines[0].strip())
    if match is None:
        return None
    return int(match.group(1) or match.group(2))


def link_closes(link: Any) -> bool | None:
    """Whether a merged pull request's link closed its issue, or `None` when the row cannot say.

    A closing word closes. Otherwise a key that moved the issue closes through the
    team's merge rules unless the pull request named it after `Refs`, which is how
    partial work says it does not finish the issue. A row written before the hold
    was stored carries no answer, so the caller falls back to the commit text.
    """
    if getattr(link, "magic_word", None):
        return True
    holds = getattr(link, "holds_on_merge", None)
    if holds is None:
        return None
    return bool(getattr(link, "moves_status", True)) and not holds


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

FINISHED_CATEGORIES: frozenset[str] = frozenset({"completed", "cancelled"})
"""The status categories that finish an issue, which a merge that only references it never moves it into."""

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
