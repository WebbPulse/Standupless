"""Stacked pull requests: the chains an issue's linked pull requests form by their branches.

A pull request is stacked on another when its base branch is the other's head
branch in the same repository. GitHub retargets the next pull request onto the
trunk when the bottom one merges and deletes its branch, so a pull request whose
current base matches nothing falls back to the bases it had before, newest first,
and a stack keeps its shape after its first merge. A fork's branch names belong to
another repository, so a fork pull request is never anyone's parent.

Stacks are worked out when the links are read, from the branch fields every link
carries, so there is no stack row to keep in step with deliveries that land in any
order. The order is deterministic: a stack is walked depth first from its root,
children by pull request number.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, Sequence

ACTIVE_STATES = frozenset({"open", "draft"})
"""Pull request states that still need review and checks to land."""


class StackableLink(Protocol):
    """The link fields a stack is worked out from."""

    link_id: str
    repository_id: str
    pr_number: int
    pr_state: str
    head_ref: str
    base_ref: str
    previous_base_refs: list[str]
    from_fork: bool
    review_state: str
    ci_state: str


@dataclass(frozen=True)
class StackPosition:
    """Where one link sits in its stack and what the whole stack adds up to."""

    stack_id: str
    position: int
    size: int
    pr_state: str
    review_state: str
    ci_state: str


def _parent(link: StackableLink, by_head: dict[tuple[str, str], list[StackableLink]]) -> StackableLink | None:
    """The link this one is stacked on, trying the current base and then earlier ones."""
    for base in [link.base_ref, *reversed(link.previous_base_refs)]:
        if not base or base == link.head_ref:
            continue
        candidates = [other for other in by_head.get((link.repository_id, base), []) if other is not link]
        if candidates:
            return min(candidates, key=lambda other: (other.pr_state not in ACTIVE_STATES, -other.pr_number))
    return None


def aggregate_pr_state(states: Sequence[str]) -> str:
    """The stack's merge state: open while any entry is, merged once every entry finished and one merged."""
    if any(state == "open" for state in states):
        return "open"
    if any(state == "draft" for state in states):
        return "draft"
    if any(state == "merged" for state in states):
        return "merged"
    return "closed"


def aggregate_review_state(states: Sequence[str]) -> str:
    """The stack's review decision over its unfinished entries: one block blocks the stack."""
    if not states:
        return "none"
    if "changes_requested" in states:
        return "changes_requested"
    if all(state == "approved" for state in states):
        return "approved"
    if any(state in ("pending", "approved") for state in states):
        return "pending"
    return "none"


def aggregate_ci_state(states: Sequence[str]) -> str:
    """The stack's checks over its unfinished entries: one failure fails the stack."""
    if "failure" in states:
        return "failure"
    if "pending" in states:
        return "pending"
    if "success" in states:
        return "success"
    return "none"


def stack_positions(links: Sequence[StackableLink]) -> dict[str, StackPosition]:
    """Each stacked link's position, keyed by link id. A link on its own is not in the answer."""
    by_head: dict[tuple[str, str], list[StackableLink]] = {}
    for link in links:
        if link.head_ref and link.repository_id and not link.from_fork:
            by_head.setdefault((link.repository_id, link.head_ref), []).append(link)

    parent: dict[str, StackableLink] = {}
    for link in links:
        if not link.repository_id:
            continue
        found = _parent(link, by_head)
        if found is not None:
            parent[link.link_id] = found

    for link in sorted(links, key=lambda row: row.pr_number):
        path: list[StackableLink] = []
        current: StackableLink | None = link
        while current is not None and current.link_id in parent:
            if any(row is current for row in path):
                loop = path[next(index for index, row in enumerate(path) if row is current) :]
                parent.pop(min(loop, key=lambda row: row.pr_number).link_id, None)
                break
            path.append(current)
            current = parent.get(current.link_id)

    children: dict[str, list[StackableLink]] = {}
    for link in links:
        above = parent.get(link.link_id)
        if above is not None:
            children.setdefault(above.link_id, []).append(link)

    answer: dict[str, StackPosition] = {}
    roots = sorted((link for link in links if link.link_id not in parent), key=lambda row: row.pr_number)
    for root in roots:
        if root.link_id not in children:
            continue
        ordered: list[StackableLink] = []
        pending = [root]
        while pending:
            link = pending.pop()
            ordered.append(link)
            pending.extend(sorted(children.get(link.link_id, []), key=lambda row: row.pr_number, reverse=True))
        active = [link for link in ordered if link.pr_state in ACTIVE_STATES]
        stack_id = f"{root.repository_id}:{root.pr_number}"
        pr_state = aggregate_pr_state([link.pr_state for link in ordered])
        review = aggregate_review_state([link.review_state for link in active])
        ci = aggregate_ci_state([link.ci_state for link in active])
        for index, link in enumerate(ordered, start=1):
            answer[link.link_id] = StackPosition(
                stack_id=stack_id,
                position=index,
                size=len(ordered),
                pr_state=pr_state,
                review_state=review,
                ci_state=ci,
            )
    return answer
