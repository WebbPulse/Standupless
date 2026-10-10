"""Plan caps enforced by conditional counters, and every write that takes or frees a capped slot.

Each workspace keeps one usage row per capped resource in the `counters` table.
A create adds to it in the same `TransactWriteItems` as its own row, conditional
on the total staying within the plan, so two racing creates at the last slot
cannot both land: the loser's transaction is cancelled, it reads the row again and
is refused. Every path that frees a slot subtracts in the same transaction as the
row it removes, conditional on that row still holding the slot, so a retried
delete frees it once.

A usage row is seeded from a strongly consistent row count the first time any
write needs it, conditional on no row existing, which makes the backfill lazy and
idempotent. A row can drift high when a slot is freed by a path that does not
count, such as an invite expiring or the identity domain deleting a person's keys.
A refusal therefore recounts once before it stands, pinned to the version it
read, so a drifted row heals the moment it would wrongly refuse. A recount never
lowers a row past a write it did not see.

Guests are counted on the members row, with pending guest invites on the invites
row. A write adding a guest pins both rows it judged the allowance against, so a
racing change to either reruns the check.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from fastapi import HTTPException, status
from webbpulse.dynamodb import TransactionCanceled, now_iso

from app.common.api.dependencies.repositories import Repositories
from app.common.db.dynamo.counters import PlanUsage
from app.common.db.dynamo.invites import Invite
from app.common.db.dynamo.memberships import Membership
from app.common.db.dynamo.workspaces import Workspace
from app.common.plan_limits import LimitedResource, check_guests, check_limit, guest_allowance, limit_for

GUEST = "guest"

ATTEMPTS = 4
"""How many times a write is retried after losing a race on a usage row."""

SETTLE_SECONDS = 5
"""How long a usage row counted from an index must sit unchanged before a recount may replace it."""

INDEX_COUNTED: frozenset[LimitedResource] = frozenset({LimitedResource.API_KEYS})
"""Resources whose recount reads a global secondary index, which can lag a write just made."""

RETRYABLE_CODES = frozenset({"ConditionalCheckFailed", "TransactionConflict"})

BUSY = {"error_code": "CONFLICT", "message": "The workspace is busy with another change. Try again."}


@dataclass(frozen=True)
class Delta:
    """How far one write moves one resource's usage, and its guest share."""

    resource: LimitedResource
    used: int
    guests: int = 0


@dataclass(frozen=True)
class GuestRule:
    """One more guest is joining: `pending` counts guest invites too, `freeing_seat` drops the seat being given up."""

    pending: bool = False
    freeing_seat: bool = False


def busy() -> HTTPException:
    """The 409 a write answers after losing every retry to concurrent changes."""
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=BUSY)


def count(repositories: Repositories, workspace_id: str, resource: LimitedResource) -> tuple[int, int]:
    """The live rows of one resource and their guest share, counted from the rows themselves."""
    if resource is LimitedResource.TEAMS:
        return repositories.teams.count_live(workspace_id), 0
    if resource is LimitedResource.MEMBERS:
        return repositories.memberships.count_members(workspace_id)
    if resource is LimitedResource.INVITES:
        return repositories.invites.count_pending(workspace_id)
    if resource is LimitedResource.WEBHOOKS:
        return repositories.github.count_endpoints(workspace_id), 0
    return repositories.api_keys.count_live_for_tenant(workspace_id), 0


def usage(repositories: Repositories, workspace_id: str, resource: LimitedResource) -> PlanUsage:
    """One resource's usage row, seeding it from a row count when this workspace has none yet."""
    counters = repositories.counters
    current = counters.plan_usage(workspace_id, resource.value)
    if current is not None:
        return current
    used, guests = count(repositories, workspace_id, resource)
    counters.seed_plan_usage(workspace_id, resource.value, used, guests)
    seeded = counters.plan_usage(workspace_id, resource.value)
    if seeded is None:
        raise busy()
    return seeded


def reconcile(
    repositories: Repositories, workspace_id: str, resource: LimitedResource, seen: PlanUsage
) -> PlanUsage | None:
    """Recount one resource and replace its row if nothing moved it since `seen`, answering the row after.

    `None` when the recount is skipped because an index it reads may not have
    caught up with the last change yet.
    """
    if resource in INDEX_COUNTED and time.time() - seen.changed_at < SETTLE_SECONDS:
        return None
    used, guests = count(repositories, workspace_id, resource)
    counters = repositories.counters
    if counters.reconcile_plan_usage(workspace_id, resource.value, seen, used, guests):
        return PlanUsage(
            used=max(0, used), guests=max(0, guests), version=seen.version + 1, changed_at=int(time.time())
        )
    return counters.plan_usage(workspace_id, resource.value)


def _room(
    repositories: Repositories,
    workspace: Workspace | None,
    workspace_id: str,
    resource: LimitedResource,
    current: PlanUsage,
    adding: int,
) -> PlanUsage:
    """The usage row once `adding` more is known to fit, recounting once before refusing with the plan's 403."""
    limit = limit_for(workspace, resource)
    if current.used + adding <= limit:
        return current
    fresh = reconcile(repositories, workspace_id, resource, current)
    if fresh is not None and fresh.used + adding <= limit:
        return fresh
    check_limit(workspace, resource, limit)
    raise busy()


def ensure_room(repositories: Repositories, workspace_id: str, resource: LimitedResource) -> None:
    """Refuse up front when the workspace holds its plan's limit of `resource`, without taking a slot.

    For a write that only leads to a create later, such as an invite, whose
    acceptance is what takes the member slot under the conditional counter.
    """
    workspace = repositories.workspaces.get(workspace_id)
    _room(repositories, workspace, workspace_id, resource, usage(repositories, workspace_id, resource), 1)


def _guest_room(
    repositories: Repositories,
    workspace: Workspace | None,
    workspace_id: str,
    rule: GuestRule,
    rows: dict[LimitedResource, PlanUsage],
) -> None:
    """Refuse one more guest past the allowance the seats earn, recounting once before refusing."""

    def judged() -> tuple[int, int]:
        members = rows[LimitedResource.MEMBERS]
        guests = members.guests + (rows[LimitedResource.INVITES].guests if rule.pending else 0)
        seats = members.used - members.guests - (1 if rule.freeing_seat else 0)
        return guests, seats

    guests, seats = judged()
    if guests < guest_allowance(workspace, seats):
        return
    for resource in list(rows):
        fresh = reconcile(repositories, workspace_id, resource, rows[resource])
        if fresh is not None:
            rows[resource] = fresh
    guests, seats = judged()
    check_guests(workspace, guests, seats)


def _counter_writes(
    repositories: Repositories,
    workspace: Workspace | None,
    workspace_id: str,
    deltas: Sequence[Delta],
    rule: GuestRule | None,
) -> list[dict[str, Any]]:
    """The usage row actions one attempt adds to the transaction, after every cap check passes."""
    pinned: set[LimitedResource] = set()
    if rule is not None:
        pinned.add(LimitedResource.MEMBERS)
        if rule.pending:
            pinned.add(LimitedResource.INVITES)
    wanted = {delta.resource for delta in deltas} | pinned
    rows = {resource: usage(repositories, workspace_id, resource) for resource in wanted}
    for delta in deltas:
        if delta.used > 0:
            rows[delta.resource] = _room(
                repositories, workspace, workspace_id, delta.resource, rows[delta.resource], delta.used
            )
    if rule is not None:
        guest_rows = {resource: rows[resource] for resource in pinned}
        _guest_room(repositories, workspace, workspace_id, rule, guest_rows)
        rows.update(guest_rows)
    counters = repositories.counters
    writes: list[dict[str, Any]] = []
    for delta in deltas:
        current = rows[delta.resource]
        used = max(delta.used, -current.used)
        guests = max(delta.guests, -current.guests)
        writes.append(
            counters.plan_usage_action(
                workspace_id,
                delta.resource.value,
                used=used,
                guests=guests,
                ceiling=limit_for(workspace, delta.resource) if used > 0 else None,
                version=current.version if delta.resource in pinned else None,
            )
        )
    moved = {delta.resource for delta in deltas}
    for resource in sorted(pinned - moved):
        writes.append(counters.plan_usage_check(workspace_id, resource.value, rows[resource].version))
    return writes


def _row_failed(exc: TransactionCanceled, rows: int) -> bool:
    """Whether a condition on one of the caller's own row actions cancelled the transaction."""
    return any(reason.get("Code") == "ConditionalCheckFailed" for reason in exc.reasons[:rows])


def _retryable(exc: TransactionCanceled) -> bool:
    """Whether the cancellation was a lost race on a usage row, which a fresh read can win."""
    return any(reason.get("Code") in RETRYABLE_CODES for reason in exc.reasons)


def commit(
    repositories: Repositories,
    workspace_id: str,
    actions: Sequence[Mapping[str, Any]],
    deltas: Sequence[Delta],
    *,
    guests: GuestRule | None = None,
) -> None:
    """Write `actions` and move the usage rows by `deltas` in one transaction, within the plan.

    Raises the plan's 403 when a delta would pass a cap. Re-raises
    `TransactionCanceled` when one of `actions` failed its own condition, so a
    caller keeps its own conflict handling, and answers a 409 after losing every
    retry to concurrent changes.
    """
    workspace = repositories.workspaces.get(workspace_id)
    for _ in range(ATTEMPTS):
        writes = _counter_writes(repositories, workspace, workspace_id, deltas, guests)
        try:
            repositories.counters.transact_write([*actions, *writes])
        except TransactionCanceled as exc:
            if _row_failed(exc, len(actions)) or not _retryable(exc):
                raise
            continue
        return
    raise busy()


def guest_share(role: str) -> int:
    """One when the role is a guest's, the guest share a membership or invite carries."""
    return 1 if role == GUEST else 0


def remove_membership(repositories: Repositories, workspace_id: str, user_id: str) -> Membership | None:
    """Delete a workspace membership and free its slot, then every team membership the person holds there.

    Answers the membership removed, `None` when there was none.
    """
    memberships = repositories.memberships
    removed: Membership | None = None
    for _ in range(ATTEMPTS):
        current = memberships.get_consistent(workspace_id, user_id)
        if current is None:
            break
        try:
            commit(
                repositories,
                workspace_id,
                [memberships.delete_action(workspace_id, user_id, current=current.role)],
                [Delta(LimitedResource.MEMBERS, -1, -guest_share(current.role))],
            )
        except TransactionCanceled:
            continue
        removed = current
        break
    else:
        raise busy()
    memberships.remove_user(workspace_id, user_id)
    return removed


def change_role(repositories: Repositories, workspace_id: str, user_id: str, role: str) -> Membership | None:
    """Change a workspace member's role, moving the guest count when it crosses to or from guest.

    Becoming a guest is judged against the allowance without the seat being
    given up. Answers the updated membership, `None` when there is no such member.
    """
    memberships = repositories.memberships
    for _ in range(ATTEMPTS):
        current = memberships.get_consistent(workspace_id, user_id)
        if current is None:
            return None
        shift = guest_share(role) - guest_share(current.role)
        if not shift:
            return memberships.set_role(workspace_id, user_id, role)
        try:
            commit(
                repositories,
                workspace_id,
                [memberships.set_role_action(workspace_id, user_id, role, current=current.role)],
                [Delta(LimitedResource.MEMBERS, 0, shift)],
                guests=GuestRule(freeing_seat=True) if shift > 0 else None,
            )
        except TransactionCanceled:
            continue
        return memberships.get_consistent(workspace_id, user_id)
    raise busy()


def delete_invite(repositories: Repositories, workspace_id: str, invite_id: str) -> Invite | None:
    """Delete an invite, freeing its pending slot when it had not expired. Answers the invite, or `None`."""
    invites = repositories.invites
    existing = invites.get_consistent(workspace_id, invite_id)
    if existing is None:
        return None
    if not existing.is_expired():
        try:
            commit(
                repositories,
                workspace_id,
                [invites.delete_live_action(workspace_id, invite_id)],
                [Delta(LimitedResource.INVITES, -1, -guest_share(existing.role))],
            )
            return existing
        except TransactionCanceled:
            pass
    invites.delete(workspace_id, invite_id)
    return existing


def delete_webhook(repositories: Repositories, workspace_id: str, webhook_id: str) -> bool:
    """Delete an outbound endpoint and its delivery log, freeing its slot. Answers whether it was there."""
    github = repositories.github
    github.delete_deliveries(workspace_id, webhook_id)
    try:
        commit(
            repositories,
            workspace_id,
            [github.delete_endpoint_action(workspace_id, webhook_id)],
            [Delta(LimitedResource.WEBHOOKS, -1)],
        )
    except TransactionCanceled:
        return False
    return True


def delete_team_webhooks(repositories: Repositories, workspace_id: str, team_id: str) -> int:
    """Delete every endpoint scoped to one team, with its log, for the team purge. Answers how many went."""
    if not team_id:
        return 0
    removed = 0
    for endpoint in repositories.github.list_endpoints(workspace_id):
        if endpoint.team_id == team_id and delete_webhook(repositories, workspace_id, endpoint.webhook_id):
            removed += 1
    return removed


def revoke_api_key(repositories: Repositories, workspace_id: str, key_hash: str) -> bool:
    """Revoke one live key and free its slot. Answers whether this call revoked it."""
    try:
        commit(
            repositories,
            workspace_id,
            [repositories.api_keys.revoke_action(key_hash, revoked_at=now_iso())],
            [Delta(LimitedResource.API_KEYS, -1)],
        )
    except TransactionCanceled:
        return False
    return True


def release_user_api_keys(repositories: Repositories, user_id: str) -> int:
    """Delete a person's live keys one at a time, each freeing its workspace's slot, then every key left.

    Answers how many keys were deleted in all.
    """
    api_keys = repositories.api_keys
    released = 0
    for record in api_keys.list_for_user(user_id):
        if record.is_revoked or not record.tenant_id:
            continue
        try:
            commit(
                repositories,
                record.tenant_id,
                [api_keys.delete_live_action(record.key_hash)],
                [Delta(LimitedResource.API_KEYS, -1)],
            )
        except TransactionCanceled:
            continue
        released += 1
    return released + api_keys.delete_all_for_user(user_id)
