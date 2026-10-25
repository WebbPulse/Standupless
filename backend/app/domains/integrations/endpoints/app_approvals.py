"""Third-party app approvals: a member's request, and an admin's approve, deny and revoke.

With `third_party_app_approvals` on, the identity function's consent gate sends a
member who tries to authorize an unapproved third-party app to the request page,
carrying a signed ticket that names the app. These routes serve that page and the
admin's Applications list, and keep one approval record per app in the memberships
table, which the gate reads on the next consent.

Every request and decision is audited and tells the other side: a request reaches
each admin's inbox and email, and a decision reaches the requester's. Revoking an
app marks it denied here, which stops its grants refreshing, and the admin page then
removes the grants themselves through the identity function, which owns them.

No delegated credential reaches any of these routes, so a token cannot approve the
app it belongs to.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Annotated, Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from pydantic import BaseModel, Field

from app.common import audit
from app.common.api.dependencies.authz import AuthzContext, Capability, refuse_api_key_actor, require
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.workspaces import display_name_for
from app.common.app_approvals import TicketError, read_request_ticket, settings_url
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.inbox import Notification, expires_at, inbox_partition, instant, notification_id
from app.common.db.dynamo.memberships import AppApproval
from app.common.email import deliver
from app.common.email.app_approval import render_app_approval_decided, render_app_approval_requested

_log = logging.getLogger(__name__)

router = APIRouter()

REQUESTED_KIND = "app_approval_requested"
"""The inbox kind that tells each admin a member asked to connect an app."""

DECIDED_KIND = "app_approval_decided"
"""The inbox kind that tells the requester whether their app was approved."""

ADMIN_ROLES = frozenset({"owner", "admin"})

REASON_LIMIT = 1000

NOT_FOUND = {"error_code": "NOT_FOUND", "message": "Resource not found"}


class AppApprovalPersonRead(BaseModel):
    """Who requested or decided, by display name."""

    id: str
    display_name: str


class AppApprovalRead(BaseModel):
    """One third-party app's approval record in this workspace."""

    client_id: str
    client_name: str
    status: Literal["pending", "approved", "denied"]
    requested_by: Optional[AppApprovalPersonRead] = None
    request_reason: str = ""
    requested_at: Optional[datetime] = None
    decided_by: Optional[AppApprovalPersonRead] = None
    decision_reason: str = ""
    decided_at: Optional[datetime] = None
    updated_at: datetime


class AppApprovalListRead(BaseModel):
    """Every approval record in this workspace, and whether approvals are required."""

    enabled: bool
    approvals: list[AppApprovalRead]


class AppAccessRequestRead(BaseModel):
    """What the request page shows: the app, where to resume, and any earlier decision."""

    workspace_id: str
    workspace_name: str
    client_id: str
    client_name: str
    return_to: str
    enabled: bool
    approval: Optional[AppApprovalRead] = None


class AppAccessRequestCreate(BaseModel):
    """A member's request to connect the app their ticket names, with an optional reason."""

    ticket: str = Field(..., min_length=1, max_length=8192)
    reason: str = Field("", max_length=REASON_LIMIT)


class AppApprovalDecision(BaseModel):
    """An admin's decision, with an optional reason, and the app's name when it has no record yet."""

    reason: str = Field("", max_length=REASON_LIMIT)
    client_name: str = Field("", max_length=200)


@router.get("/{workspace_id}/app-approvals", response_model=AppApprovalListRead)
def list_app_approvals(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    status_filter: Annotated[Optional[Literal["pending", "approved", "denied"]], Query(alias="status")] = None,
) -> AppApprovalListRead:
    """Every app's approval record for an admin, newest first, optionally one status only."""
    refuse_api_key_actor(context)
    workspace = repositories.workspaces.get(context.workspace_id)
    rows = repositories.memberships.list_app_approvals(context.workspace_id)
    if status_filter is not None:
        rows = [row for row in rows if row.status == status_filter]
    users = _people(repositories, rows)
    return AppApprovalListRead(
        enabled=bool(workspace is not None and workspace.third_party_app_approvals),
        approvals=[_read(row, users) for row in rows],
    )


@router.get("/{workspace_id}/app-approvals/request", response_model=AppAccessRequestRead)
def get_app_access_request(
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    ticket: Annotated[str, Query(min_length=1, max_length=8192)],
) -> AppAccessRequestRead:
    """The app a request ticket names, for the member it stopped, with the app's current record.

    An expired or foreign ticket is a 404, because the page can only offer to start the
    authorization again.
    """
    refuse_api_key_actor(context)
    claims = _claims(ticket, context.workspace_id)
    client_id = str(claims["client_id"])
    workspace = repositories.workspaces.get(context.workspace_id)
    row = repositories.memberships.get_app_approval(context.workspace_id, client_id)
    return AppAccessRequestRead(
        workspace_id=context.workspace_id,
        workspace_name=workspace.name if workspace is not None else "",
        client_id=client_id,
        client_name=str(claims.get("client_name") or client_id),
        return_to=str(claims.get("return_to") or ""),
        enabled=bool(workspace is not None and workspace.third_party_app_approvals),
        approval=None if row is None else _read(row, _people(repositories, [row])),
    )


@router.post("/{workspace_id}/app-approvals/requests", response_model=AppApprovalRead)
def request_app_access(
    payload: AppAccessRequestCreate,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_READ))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
) -> AppApprovalRead:
    """Ask the workspace's admins to approve the app the ticket names.

    An app already approved is returned as it stands. Otherwise the record moves to
    pending under this member, keeping any earlier decision readable, and every admin
    but the requester hears about it unless the same member already has it pending.
    """
    refuse_api_key_actor(context)
    claims = _claims(payload.ticket, context.workspace_id)
    client_id = str(claims["client_id"])
    existing = repositories.memberships.get_app_approval(context.workspace_id, client_id)
    if existing is not None and existing.status == "approved":
        return _read(existing, _people(repositories, [existing]))
    now = utc_now()
    reason = payload.reason.strip()
    row = AppApproval(
        workspace_id=context.workspace_id,
        client_id=client_id,
        client_name=str(claims.get("client_name") or client_id),
        status="pending",
        requested_by=context.user_id,
        request_reason=reason,
        requested_at=now,
        decided_by=existing.decided_by if existing is not None else None,
        decision_reason=existing.decision_reason if existing is not None else "",
        decided_at=existing.decided_at if existing is not None else None,
        updated_at=now,
    )
    repositories.memberships.put_app_approval(row)
    audit.record(
        repositories,
        context,
        "app_approval.requested",
        target_type="connected_app",
        target_id=client_id,
        target_label=row.client_name,
        before=None if existing is None else {"status": existing.status},
        after={"status": "pending", "reason": reason},
    )
    repeat = existing is not None and existing.status == "pending" and existing.requested_by == context.user_id
    if not repeat:
        _notify_admins(repositories, context, row)
    return _read(row, _people(repositories, [row]))


@router.post("/{workspace_id}/app-approvals/{client_id}/approve", response_model=AppApprovalRead)
def approve_app(
    payload: AppApprovalDecision,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    client_id: str = Path(..., min_length=1, max_length=256),
) -> AppApprovalRead:
    """Approve one app, so any member may authorize it, and tell whoever asked."""
    return _decide(repositories, context, client_id, payload, "approved", "app_approval.approved")


@router.post("/{workspace_id}/app-approvals/{client_id}/deny", response_model=AppApprovalRead)
def deny_app(
    payload: AppApprovalDecision,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    client_id: str = Path(..., min_length=1, max_length=256),
) -> AppApprovalRead:
    """Deny one app with an optional reason the requester sees, and tell them."""
    return _decide(repositories, context, client_id, payload, "denied", "app_approval.denied")


@router.post("/{workspace_id}/app-approvals/{client_id}/revoke", response_model=AppApprovalRead)
def revoke_app(
    payload: AppApprovalDecision,
    context: Annotated[AuthzContext, Depends(require(Capability.WORKSPACE_ADMIN))],
    repositories: Annotated[Repositories, Depends(get_repositories)],
    client_id: str = Path(..., min_length=1, max_length=256),
) -> AppApprovalRead:
    """Withdraw an app's approval, including one authorized before approvals were on.

    Marks it denied, which stops its grants refreshing while approvals are on. The
    grants themselves are removed by the identity route the admin page calls next.
    Nobody is notified: the members who held a grant see it gone from their apps.
    """
    return _decide(repositories, context, client_id, payload, "denied", "app_approval.revoked", notify=False)


def _decide(
    repositories: Repositories,
    context: AuthzContext,
    client_id: str,
    payload: AppApprovalDecision,
    decision: Literal["approved", "denied"],
    event: str,
    *,
    notify: bool = True,
) -> AppApprovalRead:
    """Record an admin's decision on one app, audit it and tell the requester."""
    refuse_api_key_actor(context)
    existing = repositories.memberships.get_app_approval(context.workspace_id, client_id)
    if existing is None and not payload.client_name.strip():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
    now = utc_now()
    reason = payload.reason.strip()
    base = existing or AppApproval(
        workspace_id=context.workspace_id, client_id=client_id, client_name=payload.client_name.strip()
    )
    row = base.model_copy(
        update={
            "status": decision,
            "decided_by": context.user_id,
            "decision_reason": reason,
            "decided_at": now,
            "updated_at": now,
        }
    )
    repositories.memberships.put_app_approval(row)
    audit.record(
        repositories,
        context,
        event,
        target_type="connected_app",
        target_id=client_id,
        target_label=row.client_name or client_id,
        before=None if existing is None else {"status": existing.status},
        after={"status": decision, "reason": reason},
    )
    if notify and existing is not None and existing.requested_by and existing.requested_by != context.user_id:
        _notify_requester(repositories, context, row, existing.requested_by)
    return _read(row, _people(repositories, [row]))


def _claims(ticket: str, workspace_id: str) -> Any:
    """The claims of a ticket for this workspace, or the 404 every bad ticket gets alike."""
    try:
        return read_request_ticket(ticket, workspace_id)
    except TicketError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND) from exc


def _people(repositories: Repositories, rows: list[AppApproval]) -> dict[str, Any]:
    """The requesters and deciders of these records, read once."""
    ids = sorted({user_id for row in rows for user_id in (row.requested_by, row.decided_by) if user_id})
    return repositories.users.get_many(ids) if ids else {}


def _person(user_id: Optional[str], users: dict[str, Any]) -> Optional[AppApprovalPersonRead]:
    """One requester or decider by name, or `None` when the record names nobody."""
    if not user_id:
        return None
    return AppApprovalPersonRead(id=user_id, display_name=display_name_for(users.get(user_id)))


def _read(row: AppApproval, users: dict[str, Any]) -> AppApprovalRead:
    """Shape one record for the admin list and the request page."""
    return AppApprovalRead(
        client_id=row.client_id,
        client_name=row.client_name or row.client_id,
        status=row.status,
        requested_by=_person(row.requested_by, users),
        request_reason=row.request_reason,
        requested_at=row.requested_at,
        decided_by=_person(row.decided_by, users),
        decision_reason=row.decision_reason,
        decided_at=row.decided_at,
        updated_at=row.updated_at,
    )


def _notify_admins(repositories: Repositories, context: AuthzContext, row: AppApproval) -> None:
    """Tell every admin but the requester that an app is waiting, in the inbox and by email."""
    admins = [
        membership.user_id
        for membership in repositories.memberships.list_members(context.workspace_id)
        if membership.role in ADMIN_ROLES and membership.user_id != context.user_id and not membership.is_suspended
    ]
    if not admins:
        return
    workspace = repositories.workspaces.get(context.workspace_id)
    requester = display_name_for(repositories.users.get(context.user_id))
    url = settings_url(workspace.slug) if workspace is not None else ""
    users = repositories.users.get_many(admins)
    for admin_id in admins:
        user = users.get(admin_id)
        if user is None:
            continue
        _deliver(
            repositories,
            context,
            user,
            REQUESTED_KIND,
            row,
            new_value=row.request_reason or None,
            actor_name=requester,
            email=lambda to: render_app_approval_requested(
                to=to,
                workspace_name=workspace.name if workspace is not None else "",
                app_name=row.client_name,
                requester_name=requester,
                reason=row.request_reason,
                url=url,
                accent=workspace.accent_color if workspace is not None else None,
            ),
        )


def _notify_requester(repositories: Repositories, context: AuthzContext, row: AppApproval, requester_id: str) -> None:
    """Tell the member who asked whether their app was approved, in the inbox and by email."""
    user = repositories.users.get(requester_id)
    membership = repositories.memberships.get(context.workspace_id, requester_id)
    if user is None or membership is None:
        return
    workspace = repositories.workspaces.get(context.workspace_id)
    decider = display_name_for(repositories.users.get(context.user_id))
    url = settings_url(workspace.slug) if workspace is not None else ""
    _deliver(
        repositories,
        context,
        user,
        DECIDED_KIND,
        row,
        new_value=row.status,
        actor_name=decider,
        email=lambda to: render_app_approval_decided(
            to=to,
            workspace_name=workspace.name if workspace is not None else "",
            app_name=row.client_name,
            decider_name=decider,
            approved=row.status == "approved",
            reason=row.decision_reason,
            url=url,
            accent=workspace.accent_color if workspace is not None else None,
        ),
    )


def _deliver(
    repositories: Repositories,
    context: AuthzContext,
    user: Any,
    kind: str,
    row: AppApproval,
    *,
    new_value: Optional[str],
    actor_name: str,
    email: Any,
) -> None:
    """Write one inbox row and send one email, each as the recipient's switches allow, never raising."""
    moment = utc_now()
    try:
        if user.wants_notification(kind, "in_app"):
            repositories.inbox.create(
                Notification(
                    ws_user=inbox_partition(context.workspace_id, user.id),
                    notification_id=notification_id(moment, kind, user.id, f"{row.client_id}#{instant(moment)}"),
                    workspace_id=context.workspace_id,
                    kind=kind,
                    team_id="",
                    issue_key="",
                    issue_title=row.client_name or row.client_id,
                    new_value=new_value,
                    actor_id=context.user_id,
                    actor_name=actor_name,
                    recipient_id=user.id,
                    created_at=moment,
                    unread_at=instant(moment),
                    expires_at=expires_at(moment),
                )
            )
    except Exception:
        _log.exception("app_approval_inbox_failed kind=%s client_id=%s", kind, row.client_id)
    if user.email and user.wants_notification(kind, "email"):
        deliver(email(str(user.email)), event=f"integrations.{kind}.email")
