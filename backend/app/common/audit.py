"""Record workspace audit events from any domain, best effort.

Every write path that changes who is in a workspace, how they sign in, which
credentials reach it, what leaves it, or how it is configured calls `record` after
the change has landed. Recording never fails the change it describes: a bundle
with no audit grant skips it and a failed write is logged, because refusing a
member removal over a log row would be the worse outcome.

The event names are a fixed catalogue so the settings page and the MCP tool can
offer them as a filter.
"""

from __future__ import annotations

import csv
import io
import json
import logging
from datetime import datetime
from typing import Any, Iterator, Mapping

from webbpulse.audit import (
    SYSTEM_ACTOR,
    AuditActor,
    AuditCatalogue,
    AuditEvent,
    AuditPage,
    AuditQuery,
    AuditRecorder,
    AuditTarget,
    csv_safe,
)
from webbpulse.dynamodb import InvalidStartKey

from app.common.api.dependencies.authz import AuthzContext
from app.common.api.dependencies.repositories import Repositories
from app.common.api.schemas.audit import AuditEventRead, AuditEventType, AuditLogRead
from app.common.db.dynamo.audit import RETENTION
from app.common.db.dynamo.teams import Team
from app.common.plan_features import Feature, enforce_feature, has_feature

_log = logging.getLogger(__name__)

MAX_PAGE = 100

MAX_CSV_ROWS = 5000
"""The most rows one CSV download carries; a narrower date range reaches older ones."""

EVENTS: dict[str, str] = {
    "member.joined": "Member joined",
    "member.removed": "Member removed",
    "member.left": "Member left",
    "member.role_changed": "Member role changed",
    "member.suspended": "Member suspended",
    "member.reactivated": "Member reactivated",
    "invite.created": "Invite sent",
    "invite.revoked": "Invite revoked",
    "invite_link.enabled": "Invite link enabled",
    "invite_link.reset": "Invite link reset",
    "invite_link.disabled": "Invite link disabled",
    "auth_policy.updated": "Authentication policy changed",
    "session.created": "Signed in",
    "session.revoked": "Session revoked",
    "auth.sign_in_failed": "Sign-in failed",
    "sso.domain_added": "Single sign-on domain added",
    "sso.domain_verified": "Single sign-on domain verified",
    "sso.domain_removed": "Single sign-on domain removed",
    "sso.domain_lapsed": "Single sign-on domain lapsed",
    "sso.connection_saved": "Single sign-on connection saved",
    "sso.connection_tested": "Single sign-on connection tested",
    "sso.connection_removed": "Single sign-on connection removed",
    "scim.token_created": "Directory sync token created",
    "scim.token_revoked": "Directory sync token revoked",
    "scim.user_provisioned": "Directory user provisioned",
    "scim.user_updated": "Directory user updated",
    "scim.user_deactivated": "Directory user deactivated",
    "scim.user_reactivated": "Directory user reactivated",
    "scim.user_deleted": "Directory user deleted",
    "scim.group_linked": "Directory group linked to a team",
    "scim.group_updated": "Directory group updated",
    "scim.group_unlinked": "Directory group unlinked from a team",
    "api_key.created": "API key created",
    "api_key.revoked": "API key revoked",
    "connected_app.authorized": "Connected app authorized",
    "connected_app.revoked": "Connected app revoked",
    "connected_app.scopes_granted": "Connected app permissions granted",
    "connected_app.scopes_auto_granted": "Connected app given new permissions automatically",
    "app_approval.requested": "Third-party app access requested",
    "app_approval.approved": "Third-party app approved",
    "app_approval.denied": "Third-party app denied",
    "app_approval.revoked": "Third-party app revoked",
    "export.started": "Workspace export started",
    "import.started": "Issue import started",
    "import.cancelled": "Issue import cancelled",
    "workspace.updated": "Workspace settings changed",
    "workspace.deletion_scheduled": "Workspace deletion scheduled",
    "workspace.deletion_cancelled": "Workspace deletion cancelled",
    "plan.changed": "Plan changed",
    "team.created": "Team created",
    "team.deleted": "Team deleted",
    "team.retired": "Team retired",
    "team.unretired": "Team un-retired",
    "team.parent_changed": "Team parent changed",
    "team.privacy_changed": "Team privacy changed",
    "team.triage_changed": "Team triage settings changed",
    "team_member.added": "Team member added",
    "team_member.removed": "Team member removed",
    "team_member.role_changed": "Team member role changed",
    "team_member.joined": "Team member joined",
    "team_member.left": "Team member left",
    "workspace.created": "Workspace created",
    "share_link.created": "Share link created",
    "share_link.revoked": "Share link revoked",
    "webhook.created": "Webhook created",
    "webhook.updated": "Webhook changed",
    "webhook.secret_rotated": "Webhook secret rotated",
    "webhook.deleted": "Webhook deleted",
    "channel.created": "Notification channel added",
    "channel.updated": "Notification channel changed",
    "channel.deleted": "Notification channel removed",
    "slack.connected": "Slack connected",
    "slack.disconnected": "Slack disconnected",
    "discord.connected": "Discord connected",
    "discord.disconnected": "Discord disconnected",
    "gitlab.connected": "GitLab connected",
    "gitlab.secret_rotated": "GitLab webhook secret rotated",
    "gitlab.disconnected": "GitLab disconnected",
    "github.sync_updated": "GitHub sync settings changed",
    "github.sync_removed": "GitHub sync turned off",
    "github.transitions_changed": "GitHub status transitions changed",
    "github.repository_pinned": "GitHub repository pinned",
    "github.repository_unpinned": "GitHub repository unpinned",
    "github.label_set_updated": "GitHub workspace label set changed",
    "email_intake.enabled": "Create by email turned on",
    "email_intake.disabled": "Create by email turned off",
    "email_intake.regenerated": "Create by email address regenerated",
    "slack_intake.updated": "Slack emoji intake changed",
    "slack_intake.disabled": "Slack emoji intake turned off",
    "label.merged": "Labels merged",
    "customer_status.created": "Customer status added",
    "customer_status.updated": "Customer status changed",
    "customer_status.deleted": "Customer status deleted",
    "customer_tier.created": "Customer tier added",
    "customer_tier.updated": "Customer tier changed",
    "customer_tier.deleted": "Customer tier deleted",
    "initiative.team_changed": "Initiative team changed",
    "dashboard.created": "Dashboard created",
    "dashboard.deleted": "Dashboard deleted",
    "dashboard.moved": "Dashboard moved",
    "dashboard.owner_changed": "Dashboard owner changed",
    "platform_admin.granted": "Platform admin granted",
    "platform_admin.revoked": "Platform admin revoked",
}
"""Every event the log records, with the label the settings page shows."""

EVENT_TYPES: tuple[str, ...] = tuple(EVENTS)

CATALOGUE = AuditCatalogue(EVENTS)
"""The shared catalogue over `EVENTS`, so a typo in an event name fails at the call site."""


def _record(
    repositories: Repositories,
    workspace_id: str,
    event: str,
    actor: AuditActor,
    *,
    target_type: str,
    target_id: str,
    target_label: str,
    before: Mapping[str, Any] | None,
    after: Mapping[str, Any] | None,
) -> AuditEvent | None:
    """Store one event unless this bundle cannot, never raising on a store failure."""
    if event not in CATALOGUE:
        raise ValueError(f"unknown audit event {event!r}")
    if repositories.is_read_only("audit"):
        _log.info("audit_skipped", extra={"event": event, "workspace_id": workspace_id})
        return None
    recorder = AuditRecorder(repositories.audit, CATALOGUE, retention=RETENTION)
    return recorder.record(
        workspace_id,
        event,
        actor=actor,
        target=AuditTarget(target_type, target_id, target_label),
        before=before,
        after=after,
    )


def record(
    repositories: Repositories,
    context: AuthzContext,
    event: str,
    *,
    target_type: str = "",
    target_id: str = "",
    target_label: str = "",
    before: Mapping[str, Any] | None = None,
    after: Mapping[str, Any] | None = None,
    workspace_id: str | None = None,
) -> AuditEvent | None:
    """Record one event done by the caller of a request, with how they signed in and from where."""
    return _record(
        repositories,
        workspace_id or context.workspace_id,
        event,
        AuditActor(
            id=context.user_id,
            kind=context.actor.value,
            source=context.source,
            ip=context.ip,
            amr=tuple(context.amr),
        ),
        target_type=target_type,
        target_id=target_id,
        target_label=target_label,
        before=before,
        after=after,
    )


def record_team_created(
    repositories: Repositories, context: AuthzContext, team: Team, *, private: bool = False
) -> None:
    """Record a new team, and the parent it was created under as a parent change from none."""
    record(
        repositories,
        context,
        "team.created",
        target_type="team",
        target_id=team.team_id,
        target_label=team.name,
        after={
            "key_prefix": team.key_prefix,
            "private": bool(private),
            **({"parent_team_id": team.parent_team_id} if team.parent_team_id else {}),
        },
    )
    record_parent_change(repositories, context, team, None)


def record_parent_change(
    repositories: Repositories, context: AuthzContext, team: Team, before: str | None
) -> AuditEvent | None:
    """Record a team moving under another parent or to the top level, and nothing when its parent stayed."""
    if team.parent_team_id == before:
        return None
    return record(
        repositories,
        context,
        "team.parent_changed",
        target_type="team",
        target_id=team.team_id,
        target_label=team.name,
        before={"parent_team_id": before},
        after={"parent_team_id": team.parent_team_id},
    )


def record_privacy_change(
    repositories: Repositories, context: AuthzContext, team: Team, before: bool, after: bool | None
) -> AuditEvent | None:
    """Record a team made private or opened again, and nothing when the patch left its privacy alone."""
    if after is None or bool(after) == bool(before):
        return None
    return record(
        repositories,
        context,
        "team.privacy_changed",
        target_type="team",
        target_id=team.team_id,
        target_label=team.name,
        before={"private": bool(before)},
        after={"private": bool(after)},
    )


def record_triage_change(
    repositories: Repositories,
    context: AuthzContext,
    team: Team,
    before: Mapping[str, Any],
    after: Mapping[str, Any],
) -> AuditEvent | None:
    """Record a change to a team's triage settings with only the fields that moved, and nothing when none did."""
    moved = [name for name in after if before.get(name) != after.get(name)]
    if not moved:
        return None
    return record(
        repositories,
        context,
        "team.triage_changed",
        target_type="team",
        target_id=team.team_id,
        target_label=team.name,
        before={name: before.get(name) for name in moved},
        after={name: after.get(name) for name in moved},
    )


def record_team_member(
    repositories: Repositories,
    context: AuthzContext,
    event: str,
    team_id: str,
    user_id: str,
    *,
    before: Mapping[str, Any] | None = None,
    after: Mapping[str, Any] | None = None,
) -> AuditEvent | None:
    """Record one team membership change, with the person as the target and the team on each side."""
    team = repositories.teams.get(context.workspace_id, team_id)
    where = {"team_id": team_id, "team": team.name if team is not None else ""}
    return record(
        repositories,
        context,
        event,
        target_type="team_member",
        target_id=user_id,
        target_label=_person_label(repositories, user_id),
        before={**where, **before} if before is not None else None,
        after={**where, **after} if after is not None else None,
    )


def _person_label(repositories: Repositories, user_id: str) -> str:
    """A person's display name for a target label, or their id where this bundle has no users."""
    if "users" not in repositories.repository_names:
        return user_id
    from app.common.api.schemas.workspaces import display_name_for

    user = repositories.users.get(user_id)
    return display_name_for(user) if user is not None else user_id


def record_system(
    repositories: Repositories,
    workspace_id: str,
    event: str,
    *,
    actor_id: str = SYSTEM_ACTOR.id,
    actor_kind: str = SYSTEM_ACTOR.kind,
    source: str = SYSTEM_ACTOR.source,
    ip: str = "",
    amr: tuple[str, ...] = (),
    target_type: str = "",
    target_id: str = "",
    target_label: str = "",
    before: Mapping[str, Any] | None = None,
    after: Mapping[str, Any] | None = None,
) -> AuditEvent | None:
    """Record one event no signed-in request carried, such as a billing webhook or an OAuth consent."""
    return _record(
        repositories,
        workspace_id,
        event,
        AuditActor(id=actor_id, kind=actor_kind, source=source, ip=ip, amr=amr),
        target_type=target_type,
        target_id=target_id,
        target_label=target_label,
        before=before,
        after=after,
    )


def _query(actor_id: str | None, event: str | None, since: datetime | None, until: datetime | None) -> AuditQuery:
    """The shared listing query for the route and MCP filters, a blank filter meaning none."""
    return AuditQuery(since=since, until=until, actor_id=actor_id or None, action=event or None)


def _page(
    repositories: Repositories, workspace_id: str, query: AuditQuery, *, limit: int, cursor: str | None
) -> AuditPage:
    """One page of the log, starting over from the newest when the cursor will not serve.

    A malformed, stale or foreign cursor answers the first page rather than an error,
    so an old bookmark still opens the log.
    """
    try:
        return repositories.audit.list_events(workspace_id, query, limit=limit, cursor=cursor)
    except InvalidStartKey:
        return repositories.audit.list_events(workspace_id, query, limit=limit)


def _actor_names(repositories: Repositories, rows: list[AuditEvent]) -> dict[str, str]:
    """Display names for the people behind a page of rows, empty where this bundle has no users."""
    if "users" not in repositories.repository_names:
        return {}
    from app.common.api.schemas.workspaces import display_name_for

    ids = sorted({row.actor.id for row in rows if row.actor.kind != "system"})
    users = repositories.users.get_many(ids) if ids else {}
    return {user_id: display_name_for(user) for user_id, user in users.items()}


def list_page(
    repositories: Repositories,
    workspace_id: str,
    *,
    actor_id: str | None = None,
    event: str | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
    limit: int = 50,
    cursor: str | None = None,
) -> AuditLogRead:
    """One page of the audit log for an admin, or an empty page when the plan leaves it out.

    Events are recorded on every plan, so a workspace that upgrades sees the year
    behind it; only reading is gated.
    """
    types = [AuditEventType(key=key, label=label) for key, label in CATALOGUE.event_types()]
    if not has_feature(repositories.workspaces.get(workspace_id), Feature.AUDIT_LOG):
        return AuditLogRead(events=[], next_cursor=None, available=False, event_types=types)
    page = _page(
        repositories,
        workspace_id,
        _query(actor_id, event, since, until),
        limit=max(1, min(limit, MAX_PAGE)),
        cursor=cursor,
    )
    names = _actor_names(repositories, page.events)
    return AuditLogRead(
        events=[
            AuditEventRead.from_event(row, label=CATALOGUE.label(row.action), actor_name=names.get(row.actor.id, ""))
            for row in page.events
        ],
        next_cursor=page.next_cursor,
        available=True,
        event_types=types,
    )


CSV_COLUMNS: tuple[str, ...] = (
    "created_at",
    "event",
    "actor_id",
    "actor_name",
    "actor_kind",
    "source",
    "ip",
    "amr",
    "target_type",
    "target_id",
    "target_label",
    "before",
    "after",
)


def _events(repositories: Repositories, workspace_id: str, query: AuditQuery) -> Iterator[list[AuditEvent]]:
    """The matching events a page at a time, newest first, up to `MAX_CSV_ROWS`."""
    cursor: str | None = None
    written = 0
    while written < MAX_CSV_ROWS:
        page = repositories.audit.list_events(
            workspace_id, query, limit=min(MAX_PAGE, MAX_CSV_ROWS - written), cursor=cursor
        )
        yield page.events
        written += len(page.events)
        if page.next_cursor is None:
            return
        cursor = page.next_cursor


def as_csv(
    repositories: Repositories,
    workspace_id: str,
    *,
    actor_id: str | None = None,
    event: str | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
) -> str:
    """Every matching event up to `MAX_CSV_ROWS` as CSV, newest first, for a plan that includes the log."""
    enforce_feature(repositories, workspace_id, Feature.AUDIT_LOG)
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(CSV_COLUMNS)
    for rows in _events(repositories, workspace_id, _query(actor_id, event, since, until)):
        names = _actor_names(repositories, rows)
        for row in rows:
            writer.writerow(
                [
                    row.occurred_at.isoformat(),
                    row.action,
                    row.actor.id,
                    csv_safe(names.get(row.actor.id, "")),
                    row.actor.kind,
                    row.actor.source,
                    row.actor.ip,
                    " ".join(row.actor.amr),
                    row.target.type,
                    row.target.id,
                    csv_safe(row.target.label),
                    json.dumps(row.before, sort_keys=True) if row.before is not None else "",
                    json.dumps(row.after, sort_keys=True) if row.after is not None else "",
                ]
            )
    return buffer.getvalue()
