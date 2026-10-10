"""Typed shapes generated from backend/openapi.json by datamodel-codegen. Do not edit."""

from __future__ import annotations

from typing import Any, Literal, NotRequired
from typing_extensions import TypedDict


class AccountDeletionRequest(TypedDict):
    confirm_email: str


ActivityRead = TypedDict(
    "ActivityRead",
    {
        "activity_id": str,
        "actor_id": str,
        "actor_kind": Literal["user", "system", "github"],
        "created_at": str,
        "field": NotRequired[str | None],
        "from": NotRequired[Any],
        "issue_id": str,
        "kind": Literal[
            "created",
            "field_changed",
            "link_added",
            "link_removed",
            "child_added",
            "child_removed",
            "archived",
            "unarchived",
        ],
        "release_id": NotRequired[str | None],
        "source": NotRequired[Literal["web", "mcp", "cli", "api", "github", "system"] | None],
        "to": NotRequired[Any],
    },
)


class ApiKeyCreate(TypedDict):
    expires_in_days: NotRequired[int | None]
    kind: NotRequired[Literal["user", "workspace"]]
    name: str
    scopes: list[str]


class ApiKeyCreated(TypedDict):
    created_at: str
    created_by: str
    expires_at: NotRequired[str | None]
    key_id: str
    kind: Literal["user", "workspace"]
    last_used_at: NotRequired[str | None]
    name: str
    prefix: str
    revoked_at: NotRequired[str | None]
    scopes: list[str]
    secret: str


class ApiKeyRead(TypedDict):
    created_at: str
    created_by: str
    expires_at: NotRequired[str | None]
    key_id: str
    kind: Literal["user", "workspace"]
    last_used_at: NotRequired[str | None]
    name: str
    prefix: str
    revoked_at: NotRequired[str | None]
    scopes: list[str]


class ApprovedDomainCreate(TypedDict):
    domain: str


class ApprovedDomainRead(TypedDict):
    added_at: str
    added_by: str
    domain: str


class ArchiveSettingsRead(TypedDict):
    period_months: int
    team_id: str
    updated_at: NotRequired[str | None]


class ArchiveSettingsUpdate(TypedDict):
    period_months: NotRequired[Literal[1, 3, 6, 9, 12] | None]


class AttachmentRead(TypedDict):
    attachment_id: str
    content_type: NotRequired[str | None]
    created_at: str
    favicon_url: NotRequired[str | None]
    issue_id: str
    kind: Literal["url", "file"]
    s3_key: NotRequired[str | None]
    size_bytes: NotRequired[int | None]
    team_id: str
    title: str
    uploaded_by: str
    url: NotRequired[str | None]
    workspace_id: str


class AuditEventRead(TypedDict):
    actor_id: str
    actor_kind: str
    actor_name: NotRequired[str]
    after: NotRequired[dict[str, Any] | None]
    amr: NotRequired[list[str]]
    audit_id: str
    before: NotRequired[dict[str, Any] | None]
    created_at: str
    event: str
    event_label: str
    ip: NotRequired[str]
    source: str
    target_id: NotRequired[str]
    target_label: NotRequired[str]
    target_type: NotRequired[str]


class AuditEventType(TypedDict):
    key: str
    label: str


class AuditLogRead(TypedDict):
    available: bool
    event_types: list[AuditEventType]
    events: list[AuditEventRead]
    next_cursor: NotRequired[str | None]


class AuthPolicyRead(TypedDict):
    allowed_methods: list[Literal["password", "google", "github", "passkey"]]
    available: bool
    current_method: NotRequired[Literal["password", "google", "github", "passkey"] | None]
    require_two_factor: bool
    updated_at: NotRequired[str | None]
    updated_by: NotRequired[str | None]


class AuthPolicyUpdate(TypedDict):
    allowed_methods: NotRequired[list[Literal["password", "google", "github", "passkey"]] | None]
    require_two_factor: NotRequired[bool | None]


class AuthorRead(TypedDict):
    avatar_url: NotRequired[str | None]
    display_name: NotRequired[str]
    email: NotRequired[str]
    user_id: str


class AutoCloseSettingsRead(TypedDict):
    enabled: bool
    period_months: NotRequired[int | None]
    status_id: NotRequired[str | None]
    team_id: str
    updated_at: NotRequired[str | None]


class AutoCloseSettingsUpdate(TypedDict):
    period_months: NotRequired[Literal[1, 3, 6, 9, 12] | None]
    status_id: NotRequired[str | None]


class BillingRead(TypedDict):
    billed_seats: NotRequired[int | None]
    billing_enabled: bool
    billing_interval: NotRequired[str | None]
    business_available: bool
    cancel_at_period_end: NotRequired[bool]
    comp_expires_at: NotRequired[str | None]
    comp_plan: NotRequired[str | None]
    current_period_end: NotRequired[str | None]
    features: NotRequired[list[str]]
    guests_per_seat: int
    has_billing_account: NotRequired[bool]
    limits: NotRequired[dict[str, int]]
    plan: str
    seats_in_use: int
    storage_bytes: int
    subscription_status: NotRequired[str | None]


class BillingSessionRead(TypedDict):
    url: str


class CarryOverRead(TypedDict):
    carried_in: NotRequired[int]
    carried_in_issue_ids: NotRequired[list[str]]
    carried_in_points: NotRequired[int]
    carried_in_unestimated: NotRequired[int]
    carried_out: NotRequired[int]
    carried_out_issue_ids: NotRequired[list[str]]
    carried_out_points: NotRequired[int]
    carried_out_unestimated: NotRequired[int]


class ChannelCreate(TypedDict, closed=True):
    enabled: NotRequired[bool]
    events: list[
        Literal[
            "issue_created",
            "issue_status_changed",
            "issue_completed",
            "issue_assigned",
            "comment_created",
            "project_update_posted",
            "project_update_due",
        ]
    ]
    label: NotRequired[str]
    slack_channel_id: NotRequired[str | None]
    slack_channel_name: NotRequired[str]
    url: NotRequired[str | None]


class ChannelRead(TypedDict):
    channel_id: str
    created_at: str
    created_by: str
    disabled_at: NotRequired[str | None]
    disabled_reason: NotRequired[str | None]
    enabled: bool
    events: list[
        Literal[
            "issue_created",
            "issue_status_changed",
            "issue_completed",
            "issue_assigned",
            "comment_created",
            "project_update_posted",
            "project_update_due",
        ]
    ]
    label: str
    last_delivery_at: NotRequired[str | None]
    last_status: NotRequired[int | None]
    provider: Literal["slack", "discord"]
    slack_channel_id: NotRequired[str]
    team_id: str
    transport: NotRequired[Literal["webhook", "slack_app"]]
    updated_at: str
    url_hint: str


class ChannelTestRead(TypedDict):
    delivered: bool
    error: NotRequired[str | None]
    status_code: int


class ChannelUpdate(TypedDict, closed=True):
    enabled: NotRequired[bool | None]
    events: NotRequired[
        list[
            Literal[
                "issue_created",
                "issue_status_changed",
                "issue_completed",
                "issue_assigned",
                "comment_created",
                "project_update_posted",
                "project_update_due",
            ]
        ]
        | None
    ]
    label: NotRequired[str | None]
    url: NotRequired[str | None]


class CheckoutCreate(TypedDict):
    interval: NotRequired[Literal["month", "year"]]
    plan: NotRequired[Literal["standard", "business"]]


class CommentCreate(TypedDict):
    attachment_ids: NotRequired[list[str]]
    body: NotRequired[str]
    parent_comment_id: NotRequired[str | None]


class CommentUpdate(TypedDict):
    body: str
    issue_id: str


class ConnectedAppMemberRead(TypedDict):
    display_name: str
    email: str
    id: str


class ConnectedAppWorkspaceRead(TypedDict):
    authorized_at: NotRequired[str | None]
    id: str
    last_used_at: NotRequired[str | None]
    name: str
    scopes: list[str]


class ConversionRequest(TypedDict):
    code: str
    state: str


class CountsRead(TypedDict):
    cancelled: NotRequired[int]
    done: NotRequired[int]
    in_progress: NotRequired[int]
    todo: NotRequired[int]
    total: NotRequired[int]


class CreatedApp(TypedDict):
    badge_color: str
    id: int
    logo_path: str
    settings_url: str
    slug: str


class CycleCapacityRead(TypedDict):
    carried_in: int
    carried_in_points: int
    cycle_id: str
    end_date: str
    name: str
    scope_issues: int
    scope_points: int
    start_date: str
    status: Literal["upcoming", "active", "completed", "cancelled"]


class CycleCreate(TypedDict):
    end_date: str
    goal: NotRequired[str | None]
    name: str
    start_date: str
    team_id: str


class CycleHistoryPoint(TypedDict):
    completed: int
    completed_points: int
    date: str
    scope: int
    scope_points: int
    started: int
    started_points: int


class CycleHistoryRead(TypedDict):
    cycle_id: str
    days: list[CycleHistoryPoint]
    end_date: str
    start_date: str
    status: Literal["upcoming", "active", "completed", "cancelled"]
    team_id: str
    today: str


class CycleRead(TypedDict):
    cancelled: bool
    carry: NotRequired[CarryOverRead]
    counts: CountsRead
    created_at: str
    created_by: str
    cycle_id: str
    end_date: str
    goal: NotRequired[str | None]
    name: str
    number: NotRequired[int | None]
    points: NotRequired[CountsRead]
    start_date: str
    status: Literal["upcoming", "active", "completed", "cancelled"]
    team_id: str
    unestimated: NotRequired[CountsRead]
    updated_at: str
    workspace_id: str


class CycleSettingsRead(TypedDict):
    auto_add_started: bool
    cooldown_weeks: int
    duration_weeks: int
    enabled: bool
    move_unfinished: bool
    start_weekday: int
    team_id: str
    upcoming_count: int
    updated_at: NotRequired[str | None]


class CycleSettingsUpdate(TypedDict):
    auto_add_started: NotRequired[bool | None]
    cooldown_weeks: NotRequired[int | None]
    duration_weeks: NotRequired[int | None]
    enabled: NotRequired[bool | None]
    move_unfinished: NotRequired[bool | None]
    start_weekday: NotRequired[int | None]
    upcoming_count: NotRequired[int | None]


class CycleUpdate(TypedDict):
    cancelled: NotRequired[bool | None]
    end_date: NotRequired[str | None]
    goal: NotRequired[str | None]
    name: NotRequired[str | None]
    start_date: NotRequired[str | None]
    team_id: str


class DeliveryAttemptRead(TypedDict):
    at: str
    attempt: int
    error: NotRequired[str | None]
    latency_ms: int
    response_body: NotRequired[str]
    status_code: int


class DownloadRead(TypedDict):
    expires_at: str
    url: str


class GitHubAppStatus(TypedDict):
    app_name: str
    configured: bool
    organization: str
    secret_available: bool


class HealthBreakdownRead(TypedDict):
    at_risk: NotRequired[int]
    none: NotRequired[int]
    off_track: NotRequired[int]
    on_track: NotRequired[int]


class IconCommit(TypedDict):
    upload_id: str


class IconUploadCreate(TypedDict):
    content_type: str
    size_bytes: int


class IconUploadRead(TypedDict):
    expires_at: str
    headers: dict[str, str]
    max_bytes: int
    upload_id: str
    url: str


class ImportRowRead(TypedDict):
    assignee_id: NotRequired[str | None]
    created_at: NotRequired[str | None]
    due_date: NotRequired[str | None]
    estimate: NotRequired[str | None]
    importable: bool
    labels: list[str]
    priority: str
    row: int
    source_key: NotRequired[str | None]
    status_name: str
    title: str


class InboxCountRead(TypedDict):
    unread: NotRequired[int]


class InboxReadRequest(TypedDict):
    all: NotRequired[bool]
    notification_ids: NotRequired[list[str] | None]


class InboxReadResult(TypedDict):
    updated: NotRequired[int]


class InboxSnoozeRequest(TypedDict):
    notification_ids: list[str]
    until: str


class InboxUnreadRequest(TypedDict):
    notification_ids: list[str]


class InitiativeCreate(TypedDict):
    description: NotRequired[str | None]
    health: NotRequired[Literal["on_track", "at_risk", "off_track"] | None]
    name: str
    owner_id: NotRequired[str | None]
    status: NotRequired[Literal["planned", "active", "completed"]]
    target_date: NotRequired[str | None]
    update_interval_days: NotRequired[int | None]


class InitiativeRead(TypedDict):
    counts: NotRequired[CountsRead]
    created_at: str
    created_by: str
    description: NotRequired[str | None]
    health: NotRequired[Literal["on_track", "at_risk", "off_track"] | None]
    initiative_id: str
    last_update_at: NotRequired[str | None]
    name: str
    next_update_due_at: NotRequired[str | None]
    owner_id: NotRequired[str | None]
    points: NotRequired[CountsRead]
    project_count: NotRequired[int]
    project_health: NotRequired[HealthBreakdownRead]
    project_ids: NotRequired[list[str]]
    status: Literal["planned", "active", "completed"]
    status_counts: NotRequired[dict[str, int]]
    target_date: NotRequired[str | None]
    update_due_state: NotRequired[Literal["upcoming", "due", "overdue"] | None]
    update_interval_days: NotRequired[int]
    update_interval_inherited: NotRequired[bool]
    updated_at: str
    workspace_id: str


class InitiativeUpdate(TypedDict):
    description: NotRequired[str | None]
    health: NotRequired[Literal["on_track", "at_risk", "off_track"] | None]
    name: NotRequired[str | None]
    owner_id: NotRequired[str | None]
    status: NotRequired[Literal["planned", "active", "completed"] | None]
    target_date: NotRequired[str | None]
    update_interval_days: NotRequired[int | None]


class InitiativeUpdateCreate(TypedDict):
    body: str
    health: Literal["on_track", "at_risk", "off_track"]


class InitiativeUpdatePatch(TypedDict):
    body: NotRequired[str | None]
    health: NotRequired[Literal["on_track", "at_risk", "off_track"] | None]


class InitiativeUpdateRead(TypedDict):
    author_id: str
    body: str
    can_edit: NotRequired[bool]
    created_at: str
    edited_at: NotRequired[str | None]
    health: Literal["on_track", "at_risk", "off_track"]
    initiative_id: str
    source: NotRequired[Literal["web", "mcp", "cli", "api", "github", "system"] | None]
    update_id: str
    updated_at: str
    workspace_id: str


class InsightBucket(TypedDict):
    color: NotRequired[str | None]
    issue_count: NotRequired[int]
    key: NotRequired[str | None]
    label: str
    value: NotRequired[int]


class InsightGroup(TypedDict):
    color: NotRequired[str | None]
    issue_count: NotRequired[int]
    key: NotRequired[str | None]
    label: str
    segments: NotRequired[list[InsightBucket]]
    value: NotRequired[int]


class InsightsRead(TypedDict):
    group_by: Literal[
        "status", "status_category", "assignee", "creator", "priority", "label", "project", "cycle", "estimate", "team"
    ]
    groups: list[InsightGroup]
    issue_count: int
    measure: Literal["count", "points"]
    row_cap: NotRequired[int]
    segment_by: NotRequired[
        Literal[
            "status",
            "status_category",
            "assignee",
            "creator",
            "priority",
            "label",
            "project",
            "cycle",
            "estimate",
            "team",
        ]
        | None
    ]
    team_ids: list[str]
    total: int
    truncated: NotRequired[bool]
    view_id: NotRequired[str | None]


class InstallUrlRead(TypedDict):
    expires_at: str
    url: str


class InstallationRead(TypedDict):
    account_login: str
    account_type: str
    avatar_url: NotRequired[str]
    html_url: str
    installation_id: str
    installed_at: str
    installed_by: str
    manage_url: NotRequired[str]
    repository_count: int
    repository_selection: str
    suspended: NotRequired[bool]


class InviteAccept(TypedDict):
    token: str


class InviteCreate(TypedDict):
    email: str
    role: Literal["admin", "member", "guest"]


class InviteCreated(TypedDict):
    created_at: str
    email: str
    expires_at: str
    invite_id: str
    invited_by: str
    role: str
    token: str


class InviteRead(TypedDict):
    created_at: str
    email: str
    expires_at: str
    invite_id: str
    invited_by: str
    role: str


class IssueBulkPatch(TypedDict):
    add_label_ids: NotRequired[list[str]]
    archived: NotRequired[bool | None]
    assignee_id: NotRequired[str | None]
    cycle_id: NotRequired[str | None]
    estimate: NotRequired[str | None]
    priority: NotRequired[Literal["none", "urgent", "high", "medium", "low"] | None]
    project_id: NotRequired[str | None]
    project_milestone_id: NotRequired[str | None]
    remove_label_ids: NotRequired[list[str]]
    status_id: NotRequired[str | None]


class IssueBulkUpdate(TypedDict):
    issue_ids: list[str]
    only_if_estimate: NotRequired[str | None]
    patch: IssueBulkPatch


class IssueCreate(TypedDict):
    assignee_id: NotRequired[str | None]
    body: NotRequired[str | None]
    cycle_id: NotRequired[str | None]
    due_date: NotRequired[str | None]
    estimate: NotRequired[str | None]
    label_ids: NotRequired[list[str]]
    parent_id: NotRequired[str | None]
    priority: NotRequired[Literal["none", "urgent", "high", "medium", "low"]]
    project_id: NotRequired[str | None]
    project_milestone_id: NotRequired[str | None]
    sort_order: NotRequired[str | None]
    start_date: NotRequired[str | None]
    status_id: NotRequired[str | None]
    team_id: str
    title: str
    triage: NotRequired[bool]


class IssueExportRead(TypedDict):
    csv: str
    next_cursor: NotRequired[str | None]
    rows: int


class IssueImportRequest(TypedDict):
    csv: str
    file_name: NotRequired[str]
    mapping: NotRequired[dict[str, str | None] | None]
    preset: NotRequired[Literal["generic", "jira", "linear"]]
    team_id: str


class IssueMove(TypedDict):
    team_id: str


class IssueSyncRead(TypedDict):
    issue_id: str
    number: int
    origin: Literal["github", "standupless"]
    repository_full_name: str
    synced_at: str
    url: str


class IssueUpdate(TypedDict):
    assignee_id: NotRequired[str | None]
    body: NotRequired[str | None]
    cycle_id: NotRequired[str | None]
    due_date: NotRequired[str | None]
    estimate: NotRequired[str | None]
    label_ids: NotRequired[list[str] | None]
    parent_id: NotRequired[str | None]
    priority: NotRequired[Literal["none", "urgent", "high", "medium", "low"] | None]
    project_id: NotRequired[str | None]
    project_milestone_id: NotRequired[str | None]
    sort_order: NotRequired[str | None]
    start_date: NotRequired[str | None]
    status_id: NotRequired[str | None]
    title: NotRequired[str | None]


class JoinableWorkspaceRead(TypedDict):
    accent_color: NotRequired[str | None]
    domain: str
    icon_url: NotRequired[str | None]
    id: str
    name: str
    slug: str


class LabelCreate(TypedDict):
    color: str
    is_group: NotRequired[bool]
    name: str
    parent_id: NotRequired[str | None]


class LabelRead(TypedDict):
    color: str
    hidden: NotRequired[bool]
    id: str
    inherited_name: NotRequired[str | None]
    is_group: NotRequired[bool]
    name: str
    parent_id: NotRequired[str | None]
    scope: NotRequired[Literal["team", "workspace"]]


class LabelUpdate(TypedDict):
    color: NotRequired[str | None]
    name: NotRequired[str | None]
    parent_id: NotRequired[str | None]


class LinkCreate(TypedDict):
    target_issue_id: str
    type: Literal["blocks", "blocked_by", "relates_to", "duplicate_of"]


class LinkStatusRead(TypedDict):
    category: str
    color: NotRequired[str | None]
    icon: NotRequired[str | None]
    id: str
    name: str


class ManifestStart(TypedDict):
    expires_at: str
    manifest: dict[str, Any]
    post_url: str


class MediaTokensRead(TypedDict):
    expires_at: str
    tokens: dict[str, str]


class MemberRead(TypedDict):
    avatar_url: NotRequired[str | None]
    display_name: str
    email: str
    joined_at: str
    role: Literal["owner", "admin", "member", "guest"]
    user_id: str


class MemberUpdate(TypedDict):
    role: Literal["owner", "admin", "member", "guest"]


class MilestoneCreate(TypedDict):
    description: NotRequired[str | None]
    name: str
    sort_order: NotRequired[str | None]
    target_date: NotRequired[str | None]


class MilestoneRead(TypedDict):
    counts: CountsRead
    created_at: str
    created_by: str
    description: NotRequired[str | None]
    milestone_id: str
    name: str
    points: NotRequired[CountsRead]
    project_id: str
    sort_order: str
    status_counts: NotRequired[dict[str, int]]
    target_date: NotRequired[str | None]
    updated_at: str
    workspace_id: str


class MilestoneUpdate(TypedDict):
    description: NotRequired[str | None]
    name: NotRequired[str | None]
    sort_order: NotRequired[str | None]
    target_date: NotRequired[str | None]


class NotificationChannels(TypedDict):
    email: bool
    in_app: bool


class NotificationChannelsUpdate(TypedDict):
    email: NotRequired[bool | None]
    in_app: NotRequired[bool | None]


class NotificationRead(TypedDict):
    actor_id: str
    actor_name: str
    comment_id: NotRequired[str | None]
    created_at: str
    expires_at: int
    issue_id: str
    issue_key: str
    issue_title: str
    kind: str
    notification_id: str
    project_id: NotRequired[str | None]
    project_name: NotRequired[str | None]
    project_update_id: NotRequired[str | None]
    snoozed_until: NotRequired[str | None]
    source: NotRequired[Literal["web", "mcp", "cli", "api", "github", "system"] | None]
    standup_date: NotRequired[str | None]
    team_id: str
    unread: bool
    workspace_id: str


class OverrideUpdate(TypedDict):
    hidden: NotRequired[bool | None]
    name: NotRequired[str | None]


class PipelineStageRead(TypedDict):
    github_environments: list[str]
    name: str
    publish_github_release: NotRequired[bool]
    stage_id: str
    status_id: NotRequired[str | None]


class PipelineStageWrite(TypedDict):
    github_environments: NotRequired[list[str]]
    name: str
    publish_github_release: NotRequired[bool]
    stage_id: NotRequired[str | None]
    status_id: NotRequired[str | None]


class ProgressRead(TypedDict):
    completed: NotRequired[int]
    total: NotRequired[int]


class ProjectCreate(TypedDict):
    color: NotRequired[str | None]
    description: NotRequired[str | None]
    health: NotRequired[Literal["on_track", "at_risk", "off_track"] | None]
    icon: NotRequired[
        Literal[
            "box",
            "rocket",
            "target",
            "flag",
            "zap",
            "star",
            "bug",
            "book",
            "code",
            "globe",
            "heart",
            "layers",
            "shield",
            "sparkles",
            "users",
            "wrench",
        ]
        | None
    ]
    initiative_id: NotRequired[str | None]
    lead_id: NotRequired[str | None]
    member_ids: NotRequired[list[str]]
    name: str
    priority: NotRequired[Literal["none", "urgent", "high", "medium", "low"]]
    start_date: NotRequired[str | None]
    status: NotRequired[Literal["backlog", "planned", "in_progress", "paused", "completed", "canceled"]]
    target_date: NotRequired[str | None]
    team_id: NotRequired[str | None]
    team_ids: NotRequired[list[str] | None]
    update_interval_days: NotRequired[int | None]


class ProjectRead(TypedDict):
    color: NotRequired[str | None]
    counts: CountsRead
    created_at: str
    created_by: str
    description: NotRequired[str | None]
    health: NotRequired[Literal["on_track", "at_risk", "off_track"] | None]
    icon: NotRequired[str | None]
    initiative_id: NotRequired[str | None]
    last_update_at: NotRequired[str | None]
    lead_id: NotRequired[str | None]
    member_ids: NotRequired[list[str]]
    name: str
    next_update_due_at: NotRequired[str | None]
    points: NotRequired[CountsRead]
    priority: NotRequired[Literal["none", "urgent", "high", "medium", "low"]]
    project_id: str
    start_date: NotRequired[str | None]
    status: Literal["backlog", "planned", "in_progress", "paused", "completed", "canceled"]
    status_counts: NotRequired[dict[str, int]]
    target_date: NotRequired[str | None]
    team_id: str
    team_ids: list[str]
    update_due_state: NotRequired[Literal["upcoming", "due", "overdue"] | None]
    update_interval_days: NotRequired[int]
    update_interval_inherited: NotRequired[bool]
    updated_at: str
    workspace_id: str


class ProjectUpdate(TypedDict):
    color: NotRequired[str | None]
    description: NotRequired[str | None]
    health: NotRequired[Literal["on_track", "at_risk", "off_track"] | None]
    icon: NotRequired[
        Literal[
            "box",
            "rocket",
            "target",
            "flag",
            "zap",
            "star",
            "bug",
            "book",
            "code",
            "globe",
            "heart",
            "layers",
            "shield",
            "sparkles",
            "users",
            "wrench",
        ]
        | None
    ]
    initiative_id: NotRequired[str | None]
    lead_id: NotRequired[str | None]
    member_ids: NotRequired[list[str] | None]
    name: NotRequired[str | None]
    priority: NotRequired[Literal["none", "urgent", "high", "medium", "low"] | None]
    start_date: NotRequired[str | None]
    status: NotRequired[Literal["backlog", "planned", "in_progress", "paused", "completed", "canceled"] | None]
    target_date: NotRequired[str | None]
    team_id: NotRequired[str | None]
    team_ids: NotRequired[list[str] | None]
    update_interval_days: NotRequired[int | None]


class ProjectUpdateCreate(TypedDict):
    body: str
    health: Literal["on_track", "at_risk", "off_track"]


class ProjectUpdatePatch(TypedDict):
    body: NotRequired[str | None]
    health: NotRequired[Literal["on_track", "at_risk", "off_track"] | None]


class ProjectUpdateRead(TypedDict):
    author_id: str
    body: str
    can_edit: NotRequired[bool]
    created_at: str
    edited_at: NotRequired[str | None]
    health: Literal["on_track", "at_risk", "off_track"]
    project_id: str
    source: NotRequired[Literal["web", "mcp", "cli", "api", "github", "system"] | None]
    update_id: str
    updated_at: str
    workspace_id: str


class PullRequestSummaryEntryRead(TypedDict):
    ci_state: Literal["none", "pending", "success", "failure"]
    number: int
    repository_full_name: str
    review_state: Literal["none", "pending", "approved", "changes_requested"]
    state: Literal["open", "closed", "merged", "draft"]
    title: str
    url: str


class PullRequestSummaryRead(TypedDict):
    count: int
    pull_requests: list[PullRequestSummaryEntryRead]


class ReactionGroupRead(TypedDict):
    count: int
    emoji: str
    reacted: NotRequired[bool]
    user_ids: NotRequired[list[str]]


class ReactionListRead(TypedDict):
    reactions: list[ReactionGroupRead]


class ReactionWrite(TypedDict):
    emoji: str
    issue_id: NotRequired[str | None]
    target_id: str
    target_kind: Literal["issue", "comment"]


class ReleaseBackfill(TypedDict):
    cursor: NotRequired[str | None]
    environment: NotRequired[str]
    limit: NotRequired[int]
    repository: NotRequired[str | None]


class ReleaseBackfillRead(TypedDict):
    deployments_scanned: int
    environment: str
    next_cursor: NotRequired[str | None]
    release_ids: list[str]
    releases_created: int
    releases_updated: int
    team_id: str


class ReleaseCreate(TypedDict):
    commit_messages: NotRequired[list[str]]
    description: NotRequired[str | None]
    environment: NotRequired[str | None]
    issues: NotRequired[list[str]]
    name: NotRequired[str | None]
    previous_sha: NotRequired[str | None]
    repository: NotRequired[str | None]
    sha: NotRequired[str | None]
    stage: NotRequired[str | None]
    url: NotRequired[str | None]
    version: NotRequired[str | None]


class ReleaseIssueRead(TypedDict):
    issue_id: str
    key: str
    status_category: NotRequired[str | None]
    status_id: str
    title: str


class ReleaseIssuesAdd(TypedDict):
    issues: list[str]


class ReleasePipelineRead(TypedDict):
    configured: bool
    stages: list[PipelineStageRead]
    team_id: str


class ReleasePipelineUpdate(TypedDict):
    stages: list[PipelineStageWrite]


class ReleaseStageAdvance(TypedDict):
    environment: NotRequired[str | None]
    stage: str
    url: NotRequired[str | None]


class ReleaseStageRead(TypedDict):
    actor_id: NotRequired[str | None]
    environment: NotRequired[str | None]
    name: str
    reached_at: str
    source: str
    stage_id: str
    url: NotRequired[str | None]


class ReleaseUpdate(TypedDict):
    description: NotRequired[str | None]
    name: NotRequired[str | None]
    url: NotRequired[str | None]
    version: NotRequired[str | None]


class RepositoryLinkWrite(TypedDict):
    team_id: NotRequired[str | None]


class RepositoryRead(TypedDict):
    default_branch: str
    full_name: str
    linked_at: str
    name: str
    private: bool
    repository_id: str
    team_id: NotRequired[str | None]


class RoadmapEntryRead(TypedDict):
    color: NotRequired[str | None]
    counts: CountsRead
    health: NotRequired[str | None]
    icon: NotRequired[str | None]
    id: str
    kind: Literal["cycle", "project"]
    name: str
    priority: NotRequired[str | None]
    start_date: NotRequired[str | None]
    status: str
    target_date: NotRequired[str | None]
    team_id: str
    team_ids: list[str]


class RoadmapListRead(TypedDict):
    entries: list[RoadmapEntryRead]
    next_cursor: NotRequired[str | None]


class RowProblemRead(TypedDict):
    field: NotRequired[str | None]
    message: str
    row: int
    severity: Literal["error", "warning"]


class SearchResultRead(TypedDict):
    assignee_id: NotRequired[str | None]
    issue_id: str
    key: str
    score: int
    status_id: str
    team_id: str
    title: str
    updated_at: str


class ShareLinkCreate(TypedDict):
    expires_in_days: NotRequired[int | None]
    filter: NotRequired[dict[str, Any] | None]
    sort: NotRequired[Literal["updated_desc", "created_desc", "key_asc", "priority_desc", "due_asc", "manual"] | None]
    target_id: str
    target_type: Literal["issue", "view", "filter"]
    title: NotRequired[str | None]


class ShareLinkCreated(TypedDict):
    created_at: str
    created_by: str
    expires_at: NotRequired[str | None]
    revoked_at: NotRequired[str | None]
    target_id: str
    target_type: Literal["issue", "view", "filter"]
    team_id: str
    title: str
    token: str
    token_hash: str
    url: str


class ShareLinkRead(TypedDict):
    created_at: str
    created_by: str
    expires_at: NotRequired[str | None]
    revoked_at: NotRequired[str | None]
    target_id: str
    target_type: Literal["issue", "view", "filter"]
    team_id: str
    title: str
    token_hash: str
    url: str


class SharedComment(TypedDict):
    author_name: str
    body: str
    created_at: str


class SharedLabel(TypedDict):
    color: str
    name: str


class SharedStatus(TypedDict):
    category: str
    color: NotRequired[str | None]
    icon: NotRequired[str | None]
    name: str


class SharedTarget(TypedDict):
    shared_at: str
    target_type: Literal["issue", "view"]
    team_name: str
    title: str
    workspace_name: str


class SimilarIssueRead(TypedDict):
    issue_id: str
    key: str
    score: int
    status_category: NotRequired[str | None]
    status_color: NotRequired[str | None]
    status_icon: NotRequired[str | None]
    status_id: str
    status_name: NotRequired[str | None]
    team_id: str
    title: str


class SimilarListRead(TypedDict):
    results: NotRequired[list[SimilarIssueRead]]


class SlaSettingsRead(TypedDict):
    enabled: bool
    high_hours: NotRequired[int | None]
    low_hours: NotRequired[int | None]
    medium_hours: NotRequired[int | None]
    team_id: str
    updated_at: NotRequired[str | None]
    urgent_hours: NotRequired[int | None]


class SlaSettingsUpdate(TypedDict):
    enabled: NotRequired[bool | None]
    high_hours: NotRequired[int | None]
    low_hours: NotRequired[int | None]
    medium_hours: NotRequired[int | None]
    urgent_hours: NotRequired[int | None]


class SlackChannelRead(TypedDict):
    id: str
    is_private: NotRequired[bool]
    name: str


class SlackConnectionRead(TypedDict):
    configured: bool
    installed: bool
    installed_at: NotRequired[str | None]
    installed_by: NotRequired[str | None]
    slack_team_id: NotRequired[str | None]
    slack_team_name: NotRequired[str | None]


class SlackInstallUrlRead(TypedDict):
    expires_at: str
    url: str


class StackRead(TypedDict):
    ci_state: Literal["none", "pending", "success", "failure"]
    position: int
    pr_state: Literal["open", "draft", "merged", "closed"]
    review_state: Literal["none", "pending", "approved", "changes_requested"]
    size: int
    stack_id: str


class StandupItem(TypedDict):
    at: NotRequired[str | None]
    count: NotRequired[int]
    due_date: NotRequired[str | None]
    issue_id: str
    key: str
    project_id: NotRequired[str | None]
    project_name: NotRequired[str | None]
    status_id: str
    title: str


class StandupNoteRead(TypedDict):
    body: NotRequired[str | None]
    date: str
    team_id: str
    updated_at: NotRequired[str | None]
    user_id: str


class StandupNoteWrite(TypedDict, closed=True):
    body: str
    date: NotRequired[str | None]


class StandupProjectUpdate(TypedDict):
    body: str
    created_at: str
    health: str
    project_id: str
    project_name: str
    update_id: str


class StandupSettingsRead(TypedDict):
    cadence: Literal["off", "daily", "weekly"]
    next_digest_date: str
    send_time: str
    team_id: str
    timezone: str
    updated_at: NotRequired[str | None]
    weekday: int


class StandupSettingsUpdate(TypedDict, closed=True):
    cadence: NotRequired[Literal["off", "daily", "weekly"] | None]
    send_time: NotRequired[str | None]
    timezone: NotRequired[str | None]
    weekday: NotRequired[int | None]


class StatusCreate(TypedDict):
    category: Literal["backlog", "unstarted", "started", "completed", "cancelled"]
    color: NotRequired[
        Literal[
            "gray",
            "red",
            "orange",
            "amber",
            "yellow",
            "lime",
            "green",
            "teal",
            "cyan",
            "blue",
            "indigo",
            "violet",
            "purple",
            "pink",
        ]
        | None
    ]
    icon: NotRequired[
        Literal[
            "dashed",
            "dotted",
            "question",
            "circle",
            "circle_dot",
            "progress",
            "quarter",
            "half",
            "three_quarters",
            "paused",
            "blocked",
            "check",
            "check_outline",
            "cross",
            "cross_outline",
            "duplicate",
        ]
        | None
    ]
    name: str
    position: NotRequired[int | None]


class StatusMappingRead(TypedDict):
    count: int
    source: str
    status_name: str


class StatusRead(TypedDict):
    category: Literal["backlog", "unstarted", "started", "completed", "cancelled"]
    color: NotRequired[
        Literal[
            "gray",
            "red",
            "orange",
            "amber",
            "yellow",
            "lime",
            "green",
            "teal",
            "cyan",
            "blue",
            "indigo",
            "violet",
            "purple",
            "pink",
        ]
        | None
    ]
    hidden: NotRequired[bool]
    icon: NotRequired[
        Literal[
            "dashed",
            "dotted",
            "question",
            "circle",
            "circle_dot",
            "progress",
            "quarter",
            "half",
            "three_quarters",
            "paused",
            "blocked",
            "check",
            "check_outline",
            "cross",
            "cross_outline",
            "duplicate",
        ]
        | None
    ]
    id: str
    inherited_name: NotRequired[str | None]
    name: str
    position: int
    scope: NotRequired[Literal["team", "workspace"]]


class StatusUpdate(TypedDict):
    category: NotRequired[Literal["backlog", "unstarted", "started", "completed", "cancelled"] | None]
    color: NotRequired[
        Literal[
            "gray",
            "red",
            "orange",
            "amber",
            "yellow",
            "lime",
            "green",
            "teal",
            "cyan",
            "blue",
            "indigo",
            "violet",
            "purple",
            "pink",
        ]
        | None
    ]
    icon: NotRequired[
        Literal[
            "dashed",
            "dotted",
            "question",
            "circle",
            "circle_dot",
            "progress",
            "quarter",
            "half",
            "three_quarters",
            "paused",
            "blocked",
            "check",
            "check_outline",
            "cross",
            "cross_outline",
            "duplicate",
        ]
        | None
    ]
    name: NotRequired[str | None]
    position: NotRequired[int | None]


class StorageUsageRead(TypedDict):
    limit_bytes: int
    plan: str
    used_bytes: int


class StripeWebhookAck(TypedDict):
    duplicate: NotRequired[bool]
    handled: bool
    received: NotRequired[bool]


class SubscriberRead(TypedDict):
    avatar_url: NotRequired[str | None]
    created_at: str
    display_name: str
    reason: str
    user_id: str


class SubscribersRead(TypedDict):
    subscribed: bool
    subscribers: list[SubscriberRead]


class TeamCreate(TypedDict):
    description: NotRequired[str | None]
    estimate_allow_zero: NotRequired[bool]
    estimate_count_unestimated: NotRequired[bool]
    estimate_extended: NotRequired[bool]
    estimate_scale: NotRequired[Literal["off", "exponential", "fibonacci", "linear", "tshirt"]]
    key_prefix: str
    name: str
    private: NotRequired[bool]


class TeamMemberRead(TypedDict):
    added_at: str
    avatar_url: NotRequired[str | None]
    display_name: str
    email: str
    role: Literal["admin", "member"]
    user_id: str


class TeamMemberUpdate(TypedDict):
    role: Literal["admin", "member"]


class TeamOrderUpdate(TypedDict):
    team_ids: list[str]


class TeamRead(TypedDict):
    created_at: str
    description: NotRequired[str | None]
    estimate_allow_zero: NotRequired[bool]
    estimate_count_unestimated: NotRequired[bool]
    estimate_extended: NotRequired[bool]
    estimate_scale: str
    icon_url: NotRequired[str | None]
    id: str
    is_member: NotRequired[bool]
    key_prefix: str
    member_count: NotRequired[int]
    name: str
    private: NotRequired[bool]
    retired_key_prefixes: NotRequired[list[str]]
    role: NotRequired[Literal["admin", "member"] | None]
    sync_pr_labels: NotRequired[bool]
    updated_at: str
    workspace_id: str


class TeamSyncRead(TypedDict):
    allow_public_two_way: NotRequired[bool]
    created_at: str
    created_by: str
    direction: Literal["two_way", "github_to_standupless"]
    enabled: bool
    full_name: str
    public_demoted_at: NotRequired[str | None]
    repository_id: str
    repository_private: NotRequired[bool]
    sync_labels: bool
    team_id: str
    updated_at: str


class TeamSyncWrite(TypedDict, closed=True):
    allow_public_two_way: NotRequired[bool]
    direction: NotRequired[Literal["two_way", "github_to_standupless"]]
    enabled: NotRequired[bool]
    repository_id: str
    sync_labels: NotRequired[bool]


class TeamUpdate(TypedDict):
    description: NotRequired[str | None]
    estimate_allow_zero: NotRequired[bool | None]
    estimate_count_unestimated: NotRequired[bool | None]
    estimate_extended: NotRequired[bool | None]
    estimate_scale: NotRequired[Literal["off", "exponential", "fibonacci", "linear", "tshirt"] | None]
    key_prefix: NotRequired[str | None]
    name: NotRequired[str | None]
    private: NotRequired[bool | None]
    sync_pr_labels: NotRequired[bool | None]


class TransitionCreate(TypedDict, closed=True):
    branch_pattern: NotRequired[str | None]
    status_id: NotRequired[str | None]
    trigger: str


class TransitionRead(TypedDict):
    branch_pattern: NotRequired[str | None]
    is_default: NotRequired[bool]
    status_id: str | None
    team_id: str
    transition_id: str
    trigger: str


class TransitionSet(TypedDict, closed=True):
    rules: NotRequired[list[TransitionCreate]]


class TransitionUpdate(TypedDict, closed=True):
    branch_pattern: NotRequired[str | None]
    status_id: NotRequired[str | None]


class TriageAccept(TypedDict):
    status_id: NotRequired[str | None]


class TriageDecline(TypedDict):
    reason: NotRequired[str | None]


class TriageDuplicate(TypedDict):
    duplicate_of_id: str


class TriageSettingsRead(TypedDict):
    enabled: bool
    team_id: str
    updated_at: NotRequired[str | None]


class TriageSettingsUpdate(TypedDict):
    enabled: NotRequired[bool | None]


class TriageSnooze(TypedDict):
    until: NotRequired[str | None]


class TriageTeamCount(TypedDict):
    count: int
    team_id: str


class UploadCommit(TypedDict):
    issue_id: str
    ticket: str
    title: NotRequired[str | None]
    upload_id: str


class UploadTicketCreate(TypedDict):
    content_type: str
    filename: str
    issue_id: str
    size_bytes: int


class UploadTicketRead(TypedDict):
    expires_at: str
    headers: dict[str, str]
    max_bytes: int
    s3_key: str
    ticket: str
    upload_id: str
    url: str


class UrlAttachmentCreate(TypedDict):
    issue_id: str
    title: NotRequired[str | None]
    url: str


class UserPreferencesUpdate(TypedDict):
    email_notifications: NotRequired[bool | None]
    notification_preferences: NotRequired[
        dict[
            Literal[
                "assigned",
                "mentioned",
                "commented",
                "status_changed",
                "project_update",
                "project_update_due",
                "due_soon",
                "overdue",
                "standup_digest",
                "sla_at_risk",
                "sla_breached",
            ],
            NotificationChannelsUpdate,
        ]
        | None
    ]


class UserRead(TypedDict):
    avatar_url: NotRequired[str | None]
    display_name: str
    email: str
    email_notifications: bool
    email_verified: bool
    id: str
    notification_preferences: dict[str, NotificationChannels]
    two_factor: NotRequired[bool]


class ValidationErrorDetail(TypedDict):
    field: str
    message: str
    type: str


class VelocityCycleRead(TypedDict):
    carried_out: int
    carried_out_points: int
    completed_issues: int
    completed_points: int
    cycle_id: str
    end_date: str
    name: str
    scope_issues: int
    scope_points: int
    start_date: str


class VelocityRead(TypedDict):
    average_issues: float
    average_points: float
    cycles: list[VelocityCycleRead]
    estimate_scale: str
    team_id: str
    upcoming: NotRequired[CycleCapacityRead | None]


class ViewCreate(TypedDict):
    filter: NotRequired[dict[str, Any]]
    group_by: NotRequired[Literal["status", "assignee", "priority", "label", "milestone"] | None]
    kind: NotRequired[Literal["list", "board"]]
    layout: NotRequired[Literal["list", "board"] | None]
    name: str
    ordering: NotRequired[
        Literal["updated_desc", "created_desc", "key_asc", "priority_desc", "due_asc", "manual"] | None
    ]
    show_archived: NotRequired[bool]
    show_completed: NotRequired[bool]
    show_sub_issues: NotRequired[bool]
    sort: NotRequired[Literal["updated_desc", "created_desc", "key_asc", "priority_desc", "due_asc", "manual"]]
    sub_group_by: NotRequired[Literal["status", "assignee", "priority", "label", "milestone"] | None]
    team_id: NotRequired[str | None]
    visible_properties: NotRequired[
        list[
            Literal[
                "id",
                "status",
                "priority",
                "assignee",
                "labels",
                "estimate",
                "start_date",
                "due_date",
                "project",
                "cycle",
                "parent",
                "sub_issues",
                "pull_requests",
                "created_at",
                "updated_at",
            ]
        ]
        | None
    ]


class ViewRead(TypedDict):
    created_at: str
    filter: NotRequired[dict[str, Any]]
    group_by: NotRequired[str | None]
    kind: str
    layout: str
    name: str
    ordering: NotRequired[str | None]
    owner_id: str
    scope: str
    show_archived: NotRequired[bool]
    show_completed: NotRequired[bool]
    show_sub_issues: NotRequired[bool]
    sort: str
    sub_group_by: NotRequired[str | None]
    team_id: NotRequired[str | None]
    updated_at: str
    view_id: str
    visible_properties: NotRequired[list[str] | None]
    workspace_id: str


class ViewUpdate(TypedDict):
    filter: NotRequired[dict[str, Any] | None]
    group_by: NotRequired[Literal["status", "assignee", "priority", "label", "milestone"] | None]
    layout: NotRequired[Literal["list", "board"] | None]
    name: NotRequired[str | None]
    ordering: NotRequired[
        Literal["updated_desc", "created_desc", "key_asc", "priority_desc", "due_asc", "manual"] | None
    ]
    show_archived: NotRequired[bool | None]
    show_completed: NotRequired[bool | None]
    show_sub_issues: NotRequired[bool | None]
    sort: NotRequired[Literal["updated_desc", "created_desc", "key_asc", "priority_desc", "due_asc", "manual"] | None]
    sub_group_by: NotRequired[Literal["status", "assignee", "priority", "label", "milestone"] | None]
    visible_properties: NotRequired[
        list[
            Literal[
                "id",
                "status",
                "priority",
                "assignee",
                "labels",
                "estimate",
                "start_date",
                "due_date",
                "project",
                "cycle",
                "parent",
                "sub_issues",
                "pull_requests",
                "created_at",
                "updated_at",
            ]
        ]
        | None
    ]


class WebhookDeliveryRead(TypedDict):
    action: str
    attempts: list[DeliveryAttemptRead]
    created_at: str
    delivery_id: str
    event_type: str
    is_test: bool
    next_attempt_at: NotRequired[str | None]
    redelivery_of: NotRequired[str | None]
    request_body: str
    request_truncated: bool
    state: Literal["pending", "retrying", "delivered", "failed"]
    updated_at: str
    webhook_id: str


class WebhookEndpointCreate(TypedDict, closed=True):
    enabled: NotRequired[bool]
    label: str
    resource_types: list[Literal["issues", "comments", "projects", "project_updates", "cycles", "labels"]]
    team_id: NotRequired[str | None]
    url: str


class WebhookEndpointRead(TypedDict):
    consecutive_failures: NotRequired[int]
    created_at: str
    created_by: str
    disabled_at: NotRequired[str | None]
    disabled_reason: NotRequired[str | None]
    enabled: bool
    label: str
    last_delivery_at: NotRequired[str | None]
    last_status: NotRequired[int | None]
    resource_types: list[str]
    secret: NotRequired[str | None]
    secret_hint: str
    team_id: NotRequired[str | None]
    updated_at: str
    url: str
    webhook_id: str


class WebhookEndpointUpdate(TypedDict, closed=True):
    enabled: NotRequired[bool | None]
    label: NotRequired[str | None]
    resource_types: NotRequired[
        list[Literal["issues", "comments", "projects", "project_updates", "cycles", "labels"]] | None
    ]
    team_id: NotRequired[str | None]
    url: NotRequired[str | None]


class WorkspaceConnectedAppRead(TypedDict):
    authorized_at: NotRequired[str | None]
    client_id: str
    client_name: str
    last_used_at: NotRequired[str | None]
    scopes: list[str]
    user: ConnectedAppMemberRead


class WorkspaceCreate(TypedDict):
    name: str
    slug: str


class WorkspaceDeletionRequest(TypedDict):
    confirm_name: str


class WorkspaceExportCreate(TypedDict):
    include_emails: NotRequired[bool]


class WorkspaceExportRead(TypedDict):
    counts: NotRequired[dict[str, int]]
    created_at: str
    download_expires_at: NotRequired[str | None]
    download_url: NotRequired[str | None]
    emails_masked: bool
    error: NotRequired[str | None]
    expires_at: NotRequired[str | None]
    export_id: str
    finished_at: NotRequired[str | None]
    format_version: int
    requested_by: str
    size_bytes: NotRequired[int]
    started_at: NotRequired[str | None]
    status: Literal["queued", "running", "ready", "failed"]
    workspace_id: str


class WorkspaceRead(TypedDict):
    accent_color: NotRequired[str | None]
    auth_policy_allowed_methods: NotRequired[list[str] | None]
    auth_policy_blocked: NotRequired[bool]
    auth_policy_reason: NotRequired[Literal["two_factor", "sign_in_method"] | None]
    created_at: str
    deletion_scheduled_at: NotRequired[str | None]
    deletion_scheduled_by: NotRequired[str | None]
    icon_url: NotRequired[str | None]
    id: str
    name: str
    plan: str
    project_update_interval_days: NotRequired[int]
    purge_after: NotRequired[str | None]
    role: NotRequired[Literal["owner", "admin", "member", "guest"] | None]
    slug: str


class WorkspaceSummaryRead(TypedDict):
    deletion_scheduled: NotRequired[bool]
    id: str
    name: str
    slug: str


class WorkspaceUpdate(TypedDict):
    accent_color: NotRequired[str | None]
    name: NotRequired[str | None]
    project_update_interval_days: NotRequired[int | None]


class AppCommonApiSchemasIssuesIssueRead(TypedDict):
    archived_at: NotRequired[str | None]
    assignee_id: NotRequired[str | None]
    blocked_by_open_count: NotRequired[int]
    body: NotRequired[str | None]
    created_at: str
    created_by: str
    cycle_id: NotRequired[str | None]
    due_date: NotRequired[str | None]
    estimate: NotRequired[str | None]
    id: str
    in_triage: NotRequired[bool]
    key: str
    label_ids: NotRequired[list[str]]
    number: int
    parent_id: NotRequired[str | None]
    priority: Literal["none", "urgent", "high", "medium", "low"]
    progress: ProgressRead
    project_id: NotRequired[str | None]
    project_milestone_id: NotRequired[str | None]
    pull_request_summary: NotRequired[PullRequestSummaryRead | None]
    sla_breaches_at: NotRequired[str | None]
    sla_started_at: NotRequired[str | None]
    sla_status: NotRequired[Literal["none", "on_track", "at_risk", "breached"]]
    snoozed_until: NotRequired[str | None]
    sort_order: NotRequired[str | None]
    start_date: NotRequired[str | None]
    status_id: str
    team_id: str
    title: str
    updated_at: str
    workspace_id: str


class AppDomainsViewsSchemasViewIssueRead(TypedDict):
    assignee_id: NotRequired[str | None]
    body: NotRequired[str | None]
    created_at: str
    created_by: str
    due_date: NotRequired[str | None]
    estimate: NotRequired[str | None]
    id: str
    key: str
    label_ids: NotRequired[list[str]]
    number: int
    parent_id: NotRequired[str | None]
    priority: Literal["none", "urgent", "high", "medium", "low"]
    progress: ProgressRead
    sort_order: NotRequired[str | None]
    start_date: NotRequired[str | None]
    status_id: str
    team_id: str
    title: str
    updated_at: str
    workspace_id: str


class AccountDeletionPlanRead(TypedDict):
    blocking: list[WorkspaceSummaryRead]
    deleted_with_account: list[WorkspaceSummaryRead]
    leaving: list[WorkspaceSummaryRead]


class ActivityListRead(TypedDict):
    activity: list[ActivityRead]
    next_cursor: NotRequired[str | None]


class ApiKeyListRead(TypedDict):
    api_keys: list[ApiKeyRead]


class ApprovedDomainListRead(TypedDict):
    domains: list[ApprovedDomainRead]


class AttachmentListRead(TypedDict):
    attachments: list[AttachmentRead]
    next_cursor: NotRequired[str | None]


class BoardColumn(TypedDict):
    category: str
    color: NotRequired[str | None]
    icon: NotRequired[str | None]
    issues: NotRequired[list[AppDomainsViewsSchemasViewIssueRead]]
    name: str
    next_cursor: NotRequired[str | None]
    position: int
    status_id: str
    total: NotRequired[int]


class BoardColumnRead(TypedDict):
    issues: list[AppDomainsViewsSchemasViewIssueRead]
    next_cursor: NotRequired[str | None]


class BoardRead(TypedDict):
    columns: NotRequired[list[BoardColumn]]
    team_id: str


class CommentRead(TypedDict):
    attachments: NotRequired[list[AttachmentRead]]
    author: AuthorRead
    author_id: str
    body: str
    comment_id: str
    created_at: str
    edited_at: NotRequired[str | None]
    issue_id: str
    mentions: NotRequired[list[str]]
    parent_comment_id: NotRequired[str | None]
    reactions: NotRequired[list[ReactionGroupRead]]
    reply_count: NotRequired[int]
    source: NotRequired[Literal["web", "mcp", "cli", "api", "github", "system"] | None]
    team_id: str
    workspace_id: str


class ConnectedAppRead(TypedDict):
    client_id: str
    client_name: str
    first_authorized_at: NotRequired[str | None]
    last_used_at: NotRequired[str | None]
    scopes: list[str]
    workspaces: list[ConnectedAppWorkspaceRead]


class CycleListRead(TypedDict):
    cycles: list[CycleRead]
    next_cursor: NotRequired[str | None]


class ErrorResponse(TypedDict):
    details: NotRequired[list[ValidationErrorDetail] | None]
    error_code: str
    message: str
    request_id: str
    status: int
    success: NotRequired[bool]


class HomeAttentionItem(TypedDict):
    issue: AppCommonApiSchemasIssuesIssueRead
    reasons: list[Literal["overdue", "due_soon", "sla_breached", "sla_at_risk", "blocked"]]


class HomeFocusRead(TypedDict):
    attention: NotRequired[list[HomeAttentionItem]]
    attention_count: int
    in_progress: NotRequired[list[AppCommonApiSchemasIssuesIssueRead]]
    in_progress_count: int
    open_count: int
    truncated: NotRequired[bool]
    up_next: NotRequired[list[AppCommonApiSchemasIssuesIssueRead]]
    up_next_count: int


class HomeInboxRead(TypedDict):
    items: NotRequired[list[NotificationRead]]
    unread_count: int


class HomePulseItem(TypedDict):
    project_id: str
    project_name: str
    update: ProjectUpdateRead


class HomeShippedItem(TypedDict):
    completed_at: str
    completed_by: NotRequired[str | None]
    issue: AppCommonApiSchemasIssuesIssueRead


class HomeShippedRead(TypedDict):
    count: int
    items: NotRequired[list[HomeShippedItem]]
    mine: int
    since: str


class InboxListRead(TypedDict):
    next_cursor: NotRequired[str | None]
    notifications: list[NotificationRead]


class InitiativeListRead(TypedDict):
    initiatives: list[InitiativeRead]
    next_cursor: NotRequired[str | None]


class InitiativeUpdateListRead(TypedDict):
    next_cursor: NotRequired[str | None]
    updates: list[InitiativeUpdateRead]


class InviteListRead(TypedDict):
    invites: list[InviteRead]


class IssueBulkRead(TypedDict):
    issues: NotRequired[list[AppCommonApiSchemasIssuesIssueRead]]
    skipped: NotRequired[list[str]]


class IssueImportPreviewRead(TypedDict):
    headers: list[str]
    importable_rows: int
    mapping: dict[str, str | None]
    new_labels: list[str]
    problems: list[RowProblemRead]
    problems_truncated: bool
    rows: list[ImportRowRead]
    statuses: list[StatusMappingRead]
    total_rows: int


class IssueImportRead(TypedDict):
    created_at: str
    created_count: int
    error: NotRequired[str | None]
    file_name: str
    finished_at: NotRequired[str | None]
    import_id: str
    labels_created: int
    preset: str
    problem_count: int
    problems: list[RowProblemRead]
    problems_truncated: bool
    processed_rows: int
    requested_by: str
    skipped_count: int
    started_at: NotRequired[str | None]
    status: Literal["queued", "running", "completed", "failed"]
    team_id: str
    total_rows: int
    updated_at: str
    workspace_id: str


class IssueLinkRead(TypedDict):
    applied_status_id: NotRequired[str | None]
    author_login: str
    base_ref: NotRequired[str]
    ci_state: NotRequired[Literal["none", "pending", "success", "failure"]]
    closes_issue: bool
    head_ref: NotRequired[str]
    issue_id: str
    issue_key: str
    link_id: str
    linked_at: str
    pr_number: int
    pr_state: Literal["open", "draft", "merged", "closed"]
    pr_title: str
    pr_url: str
    repository_full_name: str
    review_state: NotRequired[Literal["none", "pending", "approved", "changes_requested"]]
    stack: NotRequired[StackRead | None]
    updated_at: str


class IssueListRead(TypedDict):
    issues: list[AppCommonApiSchemasIssuesIssueRead]
    next_cursor: NotRequired[str | None]


class IssueReleaseRead(TypedDict):
    created_at: str
    current_stage: NotRequired[ReleaseStageRead | None]
    name: str
    release_id: str
    team_id: str


class IssueSyncListRead(TypedDict):
    issues: list[AppCommonApiSchemasIssuesIssueRead]
    next_cursor: NotRequired[str | None]
    removed_ids: NotRequired[list[str]]
    resync_required: NotRequired[bool]
    synced_at: NotRequired[str | None]


class JoinableWorkspaceListRead(TypedDict):
    workspaces: list[JoinableWorkspaceRead]


class LabelListRead(TypedDict):
    labels: list[LabelRead]


class LinkRead(TypedDict):
    created_at: str
    created_by: str
    issue_id: str
    link_id: str
    target_issue_id: str
    target_key: str
    target_status: NotRequired[LinkStatusRead | None]
    target_title: str
    type: str


class MemberListRead(TypedDict):
    members: list[MemberRead]


class MilestoneListRead(TypedDict):
    milestones: list[MilestoneRead]
    next_cursor: NotRequired[str | None]


class ProjectListRead(TypedDict):
    next_cursor: NotRequired[str | None]
    projects: list[ProjectRead]


class ProjectUpdateListRead(TypedDict):
    next_cursor: NotRequired[str | None]
    updates: list[ProjectUpdateRead]


class ReleaseDetailRead(TypedDict):
    created_at: str
    created_by: NotRequired[str | None]
    current_stage: NotRequired[ReleaseStageRead | None]
    description: NotRequired[str | None]
    github_release_url: NotRequired[str | None]
    issue_count: int
    issues: list[ReleaseIssueRead]
    name: str
    notes: str
    pr_number: NotRequired[int | None]
    pr_url: NotRequired[str | None]
    previous_sha: NotRequired[str | None]
    release_id: str
    repository: NotRequired[str | None]
    repository_id: NotRequired[str | None]
    sha: NotRequired[str | None]
    skipped_issues: NotRequired[list[str]]
    source: str
    stages: list[ReleaseStageRead]
    status_counts: NotRequired[dict[str, int]]
    team_id: str
    updated_at: str
    url: NotRequired[str | None]
    version: NotRequired[str | None]
    workspace_id: str


class ReleaseRead(TypedDict):
    created_at: str
    created_by: NotRequired[str | None]
    current_stage: NotRequired[ReleaseStageRead | None]
    description: NotRequired[str | None]
    github_release_url: NotRequired[str | None]
    issue_count: int
    name: str
    pr_number: NotRequired[int | None]
    pr_url: NotRequired[str | None]
    previous_sha: NotRequired[str | None]
    release_id: str
    repository: NotRequired[str | None]
    repository_id: NotRequired[str | None]
    sha: NotRequired[str | None]
    source: str
    stages: list[ReleaseStageRead]
    status_counts: NotRequired[dict[str, int]]
    team_id: str
    updated_at: str
    url: NotRequired[str | None]
    version: NotRequired[str | None]
    workspace_id: str


class SearchRead(TypedDict):
    results: NotRequired[list[SearchResultRead]]


class ShareLinkListRead(TypedDict):
    share_links: list[ShareLinkRead]


class SharedIssue(TypedDict):
    assignee_name: NotRequired[str | None]
    body: str
    comments: NotRequired[list[SharedComment]]
    created_at: str
    due_date: NotRequired[str | None]
    estimate: NotRequired[float | None]
    issue_key: str
    labels: NotRequired[list[SharedLabel]]
    media: NotRequired[dict[str, str]]
    priority: Literal["none", "urgent", "high", "medium", "low"]
    start_date: NotRequired[str | None]
    status: NotRequired[SharedStatus | None]
    title: str
    updated_at: str


class SharedIssueSummary(TypedDict):
    assignee_name: NotRequired[str | None]
    issue_key: str
    priority: Literal["none", "urgent", "high", "medium", "low"]
    status: NotRequired[SharedStatus | None]
    title: str
    updated_at: str


class SharedViewPage(TypedDict):
    issues: list[SharedIssueSummary]
    next_cursor: NotRequired[str | None]


class StandupPerson(TypedDict):
    blocked: NotRequired[list[StandupItem]]
    commented: NotRequired[list[StandupItem]]
    completed: NotRequired[list[StandupItem]]
    display_name: str
    due_soon: NotRequired[list[StandupItem]]
    note: NotRequired[str | None]
    overdue: NotRequired[list[StandupItem]]
    project_updates: NotRequired[list[StandupProjectUpdate]]
    started: NotRequired[list[StandupItem]]
    user_id: str


class StatusListRead(TypedDict):
    statuses: list[StatusRead]


class TeamListRead(TypedDict):
    teams: list[TeamRead]


class TeamMemberListRead(TypedDict):
    members: list[TeamMemberRead]


class TriageSummaryRead(TypedDict):
    teams: NotRequired[list[TriageTeamCount]]


class ViewListRead(TypedDict):
    views: NotRequired[list[ViewRead]]


class WorkspaceConnectedAppListRead(TypedDict):
    apps: list[WorkspaceConnectedAppRead]


class WorkspaceExportListRead(TypedDict):
    items: list[WorkspaceExportRead]


class WorkspaceListRead(TypedDict):
    workspaces: list[WorkspaceRead]


class CommentListRead(TypedDict):
    comments: list[CommentRead]
    next_cursor: NotRequired[str | None]


class ConnectedAppListRead(TypedDict):
    apps: list[ConnectedAppRead]


class CursorPageIssueLinkRead(TypedDict):
    items: list[IssueLinkRead]
    next_cursor: NotRequired[str | None]


class HomeRead(TypedDict):
    cycles: NotRequired[list[CycleRead]]
    focus: HomeFocusRead
    generated_at: str
    inbox: HomeInboxRead
    projects: NotRequired[list[ProjectRead]]
    projects_total: NotRequired[int]
    pulse: NotRequired[list[HomePulseItem]]
    shipped: HomeShippedRead
    team_ids: list[str]
    today: str


class IssueImportListRead(TypedDict):
    items: list[IssueImportRead]


class IssueReleaseListRead(TypedDict):
    releases: list[IssueReleaseRead]


class LinkListRead(TypedDict):
    links: list[LinkRead]


class ReleaseListRead(TypedDict):
    next_cursor: NotRequired[str | None]
    releases: list[ReleaseRead]


class StandupDigest(TypedDict):
    cadence: str
    date: str
    generated_at: str
    people: NotRequired[list[StandupPerson]]
    send_time: str
    team_id: str
    team_key: str
    team_name: str
    timezone: str
    window_end: str
    window_start: str
