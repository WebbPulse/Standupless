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
            "subscriber_added",
            "subscriber_removed",
            "mentioned",
            "thread_resolved",
            "thread_unresolved",
        ],
        "release_id": NotRequired[str | None],
        "source": NotRequired[Literal["web", "mcp", "cli", "api", "github", "system"] | None],
        "to": NotRequired[Any],
    },
)


class AgentProfileEventRead(TypedDict):
    audit_id: str
    created_at: str
    event: str
    event_label: str
    ip: NotRequired[str]
    profile: str
    source: str
    version: NotRequired[int | None]


class AgentProfileFile(TypedDict):
    content: str
    path: str
    root: Literal["home", "project", "memory"]


class AgentProfileRead(TypedDict):
    created_at: str
    file_count: int
    latest_version: int
    name: str
    note: NotRequired[str]
    total_bytes: int
    updated_at: str


class AgentProfileSnapshotRead(TypedDict):
    created_at: str
    files: list[AgentProfileFile]
    latest_version: int
    name: str
    note: NotRequired[str]
    roots: dict[str, str]
    sha256: str
    version: int


class AgentProfileVersionRead(TypedDict):
    created_at: str
    file_count: int
    latest: bool
    note: NotRequired[str]
    sha256: str
    source: str
    total_bytes: int
    version: int


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


class AsanaProjectChoice(TypedDict):
    create_project: NotRequired[bool]
    project_gid: str
    status_field_gid: NotRequired[str | None]
    statuses: NotRequired[dict[str, str]]
    team_id: str


class AsanaProjectMappingRead(TypedDict):
    create_project: bool
    name: str
    project_gid: str
    status_field_gid: NotRequired[str | None]
    status_field_name: NotRequired[str | None]
    statuses: NotRequired[dict[str, str]]
    team_id: str


class AsanaProjectRead(TypedDict):
    archived: bool
    completed: bool
    gid: str
    name: str
    team_name: NotRequired[str | None]
    url: NotRequired[str | None]
    workspace_gid: str
    workspace_name: str


class AsanaStatusFieldRead(TypedDict):
    gid: str
    name: str
    options: list[str]


class AsanaStatusPlanRead(TypedDict):
    source: str
    status_id: str
    status_name: str


class AsanaTokenRequest(TypedDict):
    token: str


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
    discord_channel_id: NotRequired[str | None]
    discord_channel_name: NotRequired[str]
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
            "standup_digest",
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
    discord_channel_id: NotRequired[str]
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
            "standup_digest",
        ]
    ]
    label: str
    last_delivery_at: NotRequired[str | None]
    last_status: NotRequired[int | None]
    provider: Literal["slack", "discord"]
    scope: NotRequired[Literal["team", "workspace"]]
    slack_channel_id: NotRequired[str]
    team_id: str
    team_ids: NotRequired[list[str]]
    transport: NotRequired[Literal["webhook", "slack_app", "discord_app"]]
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
                "standup_digest",
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


class ConnectedAppScopesGrant(TypedDict):
    scopes: list[str]
    workspace_id: NotRequired[str | None]


class ConnectedAppWorkspaceRead(TypedDict):
    authorized_at: NotRequired[str | None]
    id: str
    last_used_at: NotRequired[str | None]
    name: str
    new_scopes: NotRequired[list[str]]
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


class CustomerCreate(TypedDict):
    domains: NotRequired[list[str]]
    name: str
    owner_id: NotRequired[str | None]
    revenue: NotRequired[int | None]
    size: NotRequired[int | None]
    tier: NotRequired[str | None]


class CustomerMerge(TypedDict):
    into_customer_id: str


class CustomerPatch(TypedDict):
    domains: NotRequired[list[str] | None]
    name: NotRequired[str | None]
    owner_id: NotRequired[str | None]
    revenue: NotRequired[int | None]
    size: NotRequired[int | None]
    tier: NotRequired[str | None]


class CustomerRead(TypedDict):
    can_delete: NotRequired[bool]
    can_edit: NotRequired[bool]
    created_at: str
    created_by: str
    customer_id: str
    domains: NotRequired[list[str]]
    name: str
    owner_id: NotRequired[str | None]
    request_count: NotRequired[int]
    revenue: NotRequired[int | None]
    size: NotRequired[int | None]
    tier: NotRequired[str | None]
    updated_at: str
    workspace_id: str


class CustomerRequestCreate(TypedDict):
    body: NotRequired[str]
    customer_id: str


class CustomerRequestRead(TypedDict):
    author_id: str
    body: NotRequired[str]
    can_delete: NotRequired[bool]
    created_at: str
    customer_id: str
    customer_name: NotRequired[str]
    request_id: str
    source: NotRequired[Literal["web", "mcp", "cli", "api", "github", "system"] | None]
    target_id: str
    target_key: NotRequired[str]
    target_kind: Literal["issue", "project"]
    target_title: NotRequired[str]
    workspace_id: str


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


class DiscordChannelRead(TypedDict):
    id: str
    name: str


class DiscordConnectionRead(TypedDict):
    configured: bool
    guild_id: NotRequired[str | None]
    guild_name: NotRequired[str | None]
    installed: bool
    installed_at: NotRequired[str | None]
    installed_by: NotRequired[str | None]


class DiscordInstallUrlRead(TypedDict):
    expires_at: str
    url: str


class DiscordLinkRead(TypedDict):
    available: bool
    configured: bool
    discord_user_id: NotRequired[str | None]
    guild_name: NotRequired[str | None]
    linked: NotRequired[bool]
    linked_at: NotRequired[str | None]
    problem: NotRequired[str | None]


class DiscordLinkUrlRead(TypedDict):
    expires_at: str
    url: str


class DisplayOptionsBody(TypedDict):
    completed_window: NotRequired[Literal["all", "past_week", "past_month", "none"] | None]
    group_by: NotRequired[
        Literal["status", "assignee", "priority", "label", "milestone", "project", "cycle", "parent", "team", "sla"]
        | Literal["none"]
        | None
    ]
    layout: NotRequired[Literal["list", "board"] | None]
    ordering: NotRequired[
        Literal[
            "updated_desc",
            "created_desc",
            "key_asc",
            "priority_desc",
            "due_asc",
            "sla_asc",
            "manual",
            "status_asc",
            "start_asc",
            "estimate_desc",
            "customer_requests_desc",
            "customer_revenue_desc",
        ]
        | None
    ]
    ordering_reversed: NotRequired[bool | None]
    show_archived: NotRequired[bool | None]
    show_empty_groups: NotRequired[bool | None]
    show_sub_issues: NotRequired[bool | None]
    sub_group_by: NotRequired[
        Literal["status", "assignee", "priority", "label", "milestone", "project", "cycle", "parent", "team", "sla"]
        | Literal["none"]
        | None
    ]
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
                "milestone",
                "links",
                "created_at",
                "updated_at",
            ]
        ]
        | None
    ]


class DocumentCreate(TypedDict):
    body: NotRequired[str | None]
    template_id: NotRequired[str | None]
    title: NotRequired[str | None]


class DocumentMentionRead(TypedDict):
    issue_id: str
    key: str
    team_id: str


class DocumentPatch(TypedDict):
    base_updated_at: NotRequired[str | None]
    body: NotRequired[str | None]
    title: NotRequired[str | None]


class DocumentRead(TypedDict):
    author_id: str
    body: str
    can_delete: NotRequired[bool]
    can_edit: NotRequired[bool]
    created_at: str
    document_id: str
    mentions: NotRequired[list[DocumentMentionRead]]
    parent_id: str
    parent_kind: Literal["project", "initiative"]
    parent_name: NotRequired[str]
    source: NotRequired[Literal["web", "mcp", "cli", "api", "github", "system"] | None]
    title: str
    updated_at: str
    updated_by: str
    workspace_id: str


class DocumentSummaryRead(TypedDict):
    author_id: str
    can_delete: NotRequired[bool]
    can_edit: NotRequired[bool]
    created_at: str
    document_id: str
    parent_id: str
    parent_kind: Literal["project", "initiative"]
    parent_name: NotRequired[str]
    source: NotRequired[Literal["web", "mcp", "cli", "api", "github", "system"] | None]
    title: str
    updated_at: str
    updated_by: str
    workspace_id: str


class DocumentVersionRead(TypedDict):
    body: str
    document_id: str
    edited_at: str
    edited_by: str
    title: str
    version_id: str


class DownloadRead(TypedDict):
    expires_at: str
    url: str


class DraftRead(TypedDict):
    body: str
    created_at: str
    issue_id: str
    issue_key: NotRequired[str | None]
    issue_title: NotRequired[str | None]
    parent_comment_id: NotRequired[str | None]
    team_id: str
    updated_at: str


class DraftWrite(TypedDict):
    body: str


class FavoriteRef(TypedDict):
    kind: Literal["issue", "project", "cycle", "view", "team", "document", "initiative"]
    target_id: str
    team_id: NotRequired[str | None]


class FormOption(TypedDict):
    label_id: NotRequired[str | None]
    priority: NotRequired[Literal["none", "urgent", "high", "medium", "low"] | None]
    value: str


class FormOptionBlueprint(TypedDict):
    label_id: NotRequired[str | None]
    priority: NotRequired[str | None]
    value: str


class GitHubAppStatus(TypedDict):
    app_name: str
    configured: bool
    organization: str
    secret_available: bool


class GitHubImportRepositoryRead(TypedDict):
    full_name: str
    private: bool
    repository_id: str
    team_id: NotRequired[str | None]


class GitHubImportRequest(TypedDict):
    repository_id: str
    team_id: str


class GithubThread(TypedDict):
    comment_url: NotRequired[str]
    full_name: str
    kind: NotRequired[str]
    number: int
    private: NotRequired[bool]
    repository_id: str
    synced_at: NotRequired[str]
    synced_by: str
    target_url: NotRequired[str]


class GithubThreadRead(TypedDict):
    comment_id: str
    github_thread: NotRequired[GithubThread | None]
    issue_id: str


class GithubThreadTargetRead(TypedDict):
    full_name: str
    kind: Literal["pull_request", "issue"]
    number: int
    private: bool
    ref: str
    repository_id: str
    title: str
    url: str


class GithubThreadWrite(TypedDict, closed=True):
    number: int
    repository_id: str


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
    parent_row: NotRequired[int | None]
    priority: str
    row: int
    source_key: NotRequired[str | None]
    status_name: str
    title: str


class InboxClearRequest(TypedDict):
    include_snoozed: NotRequired[bool]
    kinds: NotRequired[list[str]]
    read_only: NotRequired[bool]


class InboxClearResult(TypedDict):
    deleted: NotRequired[int]


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
    parent_initiative_id: NotRequired[str | None]
    status: NotRequired[Literal["planned", "active", "completed"]]
    target_date: NotRequired[str | None]
    update_interval_days: NotRequired[int | None]


class InitiativeProgressPointRead(TypedDict):
    completed: float
    date: str
    scope: float
    started: float


class InitiativeProgressRead(TypedDict):
    days: NotRequired[list[InitiativeProgressPointRead]]
    end_date: str
    initiative_id: str
    measure: NotRequired[Literal["points", "issues"]]
    start_date: str


class InitiativeRefRead(TypedDict):
    initiative_id: str
    name: str


class InitiativeUpdate(TypedDict):
    description: NotRequired[str | None]
    health: NotRequired[Literal["on_track", "at_risk", "off_track"] | None]
    name: NotRequired[str | None]
    owner_id: NotRequired[str | None]
    parent_initiative_id: NotRequired[str | None]
    status: NotRequired[Literal["planned", "active", "completed"] | None]
    target_date: NotRequired[str | None]
    update_interval_days: NotRequired[int | None]


class InitiativeUpdateCreate(TypedDict):
    body: NotRequired[str | None]
    health: Literal["on_track", "at_risk", "off_track"]
    template_id: NotRequired[str | None]


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


class IssueBlueprint(TypedDict):
    assignee_id: NotRequired[str | None]
    body: NotRequired[str | None]
    estimate: NotRequired[str | None]
    key: str
    label_ids: NotRequired[list[str]]
    milestone_key: NotRequired[str | None]
    parent_key: NotRequired[str | None]
    priority: NotRequired[str | None]
    status_id: NotRequired[str | None]
    title: str


class IssueBulkPatch(TypedDict):
    add_label_ids: NotRequired[list[str]]
    archived: NotRequired[bool | None]
    assignee_id: NotRequired[str | None]
    cycle_id: NotRequired[str | None]
    estimate: NotRequired[str | None]
    parent_id: NotRequired[str | None]
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
    form_answers: NotRequired[dict[str, str | bool] | None]
    label_ids: NotRequired[list[str]]
    parent_id: NotRequired[str | None]
    priority: NotRequired[Literal["none", "urgent", "high", "medium", "low"]]
    project_id: NotRequired[str | None]
    project_milestone_id: NotRequired[str | None]
    sort_order: NotRequired[str | None]
    start_date: NotRequired[str | None]
    status_id: NotRequired[str | None]
    team_id: str
    template_id: NotRequired[str | None]
    title: NotRequired[str]
    triage: NotRequired[bool]


class IssueExportRead(TypedDict):
    csv: str
    next_cursor: NotRequired[str | None]
    rows: int


class IssueImportRequest(TypedDict):
    csv: str
    file_name: NotRequired[str]
    mapping: NotRequired[dict[str, str | None] | None]
    preset: NotRequired[Literal["generic", "jira", "linear", "asana", "shortcut", "pivotal", "trello"]]
    team_id: str


class IssueMove(TypedDict):
    team_id: str


class IssueReminderRead(TypedDict):
    created_at: str
    issue_id: str
    issue_key: str
    issue_title: str
    remind_at: str
    team_id: str


class IssueReminderWrite(TypedDict):
    remind_at: str


class IssueSyncRead(TypedDict):
    issue_id: str
    number: int
    origin: Literal["github", "standupless"]
    repository_full_name: str
    synced_at: str
    url: str


class IssueTemplateItem(TypedDict):
    assignee_id: NotRequired[str | None]
    body: NotRequired[str | None]
    estimate: NotRequired[str | None]
    key: NotRequired[str | None]
    label_ids: NotRequired[list[str]]
    milestone_key: NotRequired[str | None]
    parent_key: NotRequired[str | None]
    priority: NotRequired[Literal["none", "urgent", "high", "medium", "low"] | None]
    status_id: NotRequired[str | None]
    title: str


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


class JiraCredentialsRequest(TypedDict):
    email: str
    site_url: str
    token: str


class JiraProjectChoice(TypedDict):
    epics_as: NotRequired[Literal["projects", "parents"]]
    jql: NotRequired[str | None]
    project_key: NotRequired[str | None]
    statuses: NotRequired[dict[str, str]]
    team_id: str


class JiraProjectMappingRead(TypedDict):
    epics_as: str
    jql: NotRequired[str | None]
    name: str
    project_key: NotRequired[str | None]
    site_url: str
    statuses: NotRequired[dict[str, str]]
    team_id: str


class JiraProjectRead(TypedDict):
    archived: bool
    id: str
    key: str
    name: str
    project_type: NotRequired[str | None]
    team_managed: bool
    url: NotRequired[str | None]


class JiraStatusPlanRead(TypedDict):
    category: NotRequired[str | None]
    source: str
    status_id: str
    status_name: str


class JoinableWorkspaceRead(TypedDict):
    accent_color: NotRequired[str | None]
    domain: str
    icon_url: NotRequired[str | None]
    id: str
    name: str
    slug: str


class LabelCreate(TypedDict):
    color: str
    description: NotRequired[str | None]
    is_group: NotRequired[bool]
    name: str
    parent_id: NotRequired[str | None]


class LabelMerge(TypedDict):
    target_label_id: str


class LabelRead(TypedDict):
    color: str
    description: NotRequired[str | None]
    hidden: NotRequired[bool]
    id: str
    inherited_name: NotRequired[str | None]
    is_group: NotRequired[bool]
    name: str
    parent_id: NotRequired[str | None]
    scope: NotRequired[Literal["team", "parent", "workspace"]]


class LabelSetRead(TypedDict):
    enabled: NotRequired[bool]
    include_public: NotRequired[bool]
    queued: NotRequired[bool]


class LabelSetWrite(TypedDict):
    enabled: bool
    include_public: NotRequired[bool]


class LabelUpdate(TypedDict):
    color: NotRequired[str | None]
    description: NotRequired[str | None]
    name: NotRequired[str | None]
    parent_id: NotRequired[str | None]


class LinearKeyRequest(TypedDict):
    api_key: str


class LinearTeamChoice(TypedDict):
    linear_team_id: str
    team_id: str


class LinearTeamMappingRead(TypedDict):
    linear_key: str
    linear_team_id: str
    name: str
    team_id: str


class LinearTeamRead(TypedDict):
    id: str
    key: str
    name: str


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
    full_name: NotRequired[str]
    joined_at: str
    previous_handles: NotRequired[list[str]]
    role: Literal["owner", "admin", "member", "guest"]
    user_id: str


class MemberUpdate(TypedDict):
    role: Literal["owner", "admin", "member", "guest"]


class MilestoneBlueprint(TypedDict):
    description: NotRequired[str | None]
    key: str
    name: str
    target_offset_days: NotRequired[int | None]


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
    measure: NotRequired[Literal["points", "issues"]]
    milestone_id: str
    name: str
    points: NotRequired[CountsRead]
    progress: NotRequired[CountsRead]
    project_id: str
    sort_order: str
    status_counts: NotRequired[dict[str, int]]
    target_date: NotRequired[str | None]
    updated_at: str
    workspace_id: str


class MilestoneTemplate(TypedDict):
    description: NotRequired[str | None]
    key: NotRequired[str | None]
    name: str
    target_offset_days: NotRequired[int | None]


class MilestoneUpdate(TypedDict):
    description: NotRequired[str | None]
    name: NotRequired[str | None]
    sort_order: NotRequired[str | None]
    target_date: NotRequired[str | None]


class NotificationChannels(TypedDict):
    chat: NotRequired[bool]
    email: bool
    in_app: bool


class NotificationChannelsUpdate(TypedDict):
    chat: NotRequired[bool | None]
    email: NotRequired[bool | None]
    in_app: NotRequired[bool | None]


class NotificationRead(TypedDict):
    actor_id: str
    actor_name: str
    comment_id: NotRequired[str | None]
    created_at: str
    due_state: NotRequired[Literal["due", "overdue"] | None]
    expires_at: int
    initiative_id: NotRequired[str | None]
    initiative_name: NotRequired[str | None]
    issue_id: str
    issue_key: str
    issue_title: str
    kind: str
    new_value: NotRequired[str | None]
    notification_id: str
    project_id: NotRequired[str | None]
    project_name: NotRequired[str | None]
    project_update_id: NotRequired[str | None]
    snoozed_until: NotRequired[str | None]
    source: NotRequired[Literal["web", "mcp", "cli", "api", "github", "system"] | None]
    standup_date: NotRequired[str | None]
    summary: NotRequired[str]
    team_id: str
    unread: bool
    url: NotRequired[str | None]
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


ProjectActivityRead = TypedDict(
    "ProjectActivityRead",
    {
        "activity_id": str,
        "actor_id": str,
        "created_at": str,
        "field": NotRequired[str | None],
        "from": NotRequired[Any],
        "kind": Literal["created", "field_changed", "milestone_added", "milestone_removed", "milestone_changed"],
        "milestone_id": NotRequired[str | None],
        "project_id": str,
        "source": NotRequired[Literal["web", "mcp", "cli", "api", "github", "system"] | None],
        "to": NotRequired[Any],
    },
)


class ProjectBlueprint(TypedDict):
    color: NotRequired[str | None]
    description: NotRequired[str | None]
    icon: NotRequired[str | None]
    issues: NotRequired[list[IssueBlueprint]]
    lead_id: NotRequired[str | None]
    member_ids: NotRequired[list[str]]
    milestones: NotRequired[list[MilestoneBlueprint]]
    priority: NotRequired[str | None]
    start_offset_days: NotRequired[int | None]
    status: NotRequired[str | None]
    target_offset_days: NotRequired[int | None]


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
    template_id: NotRequired[str | None]
    update_interval_days: NotRequired[int | None]


class ProjectMilestoneMarkerRead(TypedDict):
    completed: bool
    milestone_id: str
    name: str
    target_date: str


class ProjectOpenIssues(TypedDict):
    action: Literal["keep", "move", "cancel"]
    project_id: NotRequired[str | None]


class ProjectProjectionRead(TypedDict):
    days_past_target: NotRequired[int | None]
    expected_date: NotRequired[str | None]
    rate_per_day: float


class ProjectRelationCreate(TypedDict):
    target_project_id: str
    type: Literal["blocks", "blocked_by"]


class ProjectRelationRead(TypedDict):
    created_at: str
    created_by: str
    project_id: str
    relation_id: str
    target_project_id: str
    type: Literal["blocks", "blocked_by"]


class ProjectTemplateFields(TypedDict):
    color: NotRequired[str | None]
    description: NotRequired[str | None]
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
    issues: NotRequired[list[IssueTemplateItem]]
    lead_id: NotRequired[str | None]
    member_ids: NotRequired[list[str]]
    milestones: NotRequired[list[MilestoneTemplate]]
    priority: NotRequired[Literal["none", "urgent", "high", "medium", "low"] | None]
    start_offset_days: NotRequired[int | None]
    status: NotRequired[Literal["backlog", "planned", "in_progress", "paused", "completed", "canceled"] | None]
    target_offset_days: NotRequired[int | None]


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
    open_issues: NotRequired[ProjectOpenIssues | None]
    priority: NotRequired[Literal["none", "urgent", "high", "medium", "low"] | None]
    start_date: NotRequired[str | None]
    status: NotRequired[Literal["backlog", "planned", "in_progress", "paused", "completed", "canceled"] | None]
    target_date: NotRequired[str | None]
    team_id: NotRequired[str | None]
    team_ids: NotRequired[list[str] | None]
    update_interval_days: NotRequired[int | None]


class ProjectUpdateCreate(TypedDict):
    body: NotRequired[str | None]
    health: Literal["on_track", "at_risk", "off_track"]
    template_id: NotRequired[str | None]


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


class ProjectsDisplay(TypedDict):
    closed: NotRequired[Literal["all", "fortnight", "month", "none"]]
    columns: NotRequired[str]
    direction: NotRequired[Literal["asc", "desc"]]
    empty: NotRequired[Literal["show", "hide"]]
    group: NotRequired[Literal["status", "health", "priority", "initiative", "lead", "team", "none"]]
    layout: NotRequired[Literal["list", "board", "timeline"]]
    lead_team: NotRequired[Literal["all", "lead"]]
    order: NotRequired[Literal["target", "start", "name", "priority", "progress", "created", "updated", "customers"]]
    rows: NotRequired[Literal["status", "health", "priority", "initiative", "lead", "team", "none"]]
    zoom: NotRequired[Literal["week", "month", "quarter", "year"]]


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


class PulseCountRead(TypedDict):
    unread: int


class PulseFollowRead(TypedDict):
    explicit: bool
    following: bool


class PulseItemRead(TypedDict):
    actor_id: NotRequired[str | None]
    actor_name: NotRequired[str]
    body: NotRequired[str | None]
    created_at: str
    edited_at: NotRequired[str | None]
    event_id: str
    event_type: Literal[
        "project_update", "initiative_update", "project_health", "initiative_health", "milestone_completed"
    ]
    health: NotRequired[Literal["on_track", "at_risk", "off_track"] | None]
    initiative_id: NotRequired[str | None]
    initiative_name: NotRequired[str | None]
    milestone_id: NotRequired[str | None]
    milestone_name: NotRequired[str | None]
    previous_health: NotRequired[Literal["on_track", "at_risk", "off_track"] | None]
    project_color: NotRequired[str | None]
    project_icon: NotRequired[str | None]
    project_id: NotRequired[str | None]
    project_name: NotRequired[str | None]
    source: NotRequired[Literal["web", "mcp", "cli", "api", "github", "system"] | None]
    subject_type: Literal["project", "initiative"]
    unread: NotRequired[bool]
    update_id: NotRequired[str | None]
    workspace_id: str


class PulseListRead(TypedDict):
    items: list[PulseItemRead]
    next_cursor: NotRequired[str | None]


class PulseReadMarker(TypedDict):
    read_at: str


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


class RecurringCreate(TypedDict):
    day_of_month: NotRequired[int | None]
    frequency: Literal["daily", "weekly", "monthly"]
    interval: NotRequired[int | None]
    paused: NotRequired[bool]
    starts_on: NotRequired[str | None]
    template_id: str
    time: NotRequired[str | None]
    timezone: NotRequired[str | None]
    weekdays: NotRequired[list[int] | None]


class RecurringRead(TypedDict):
    created_at: str
    created_by: str
    day_of_month: NotRequired[int | None]
    frequency: Literal["daily", "weekly", "monthly"]
    id: str
    interval: int
    last_issue_id: NotRequired[str | None]
    last_issue_key: NotRequired[str | None]
    last_run_at: NotRequired[str | None]
    next_run_at: NotRequired[str | None]
    paused: bool
    paused_reason: NotRequired[str | None]
    starts_on: str
    team_id: str
    template_id: str
    template_name: NotRequired[str | None]
    time: str
    timezone: str
    upcoming_runs: NotRequired[list[str]]
    updated_at: str
    weekdays: NotRequired[list[int]]


class RecurringUpdate(TypedDict):
    day_of_month: NotRequired[int | None]
    frequency: NotRequired[Literal["daily", "weekly", "monthly"] | None]
    interval: NotRequired[int | None]
    paused: NotRequired[bool | None]
    starts_on: NotRequired[str | None]
    template_id: NotRequired[str | None]
    time: NotRequired[str | None]
    timezone: NotRequired[str | None]
    weekdays: NotRequired[list[int] | None]


class ReleaseBackfill(TypedDict):
    cursor: NotRequired[str | None]
    deployment_ids: NotRequired[list[int] | None]
    environment: NotRequired[str]
    limit: NotRequired[int]
    repository: NotRequired[str | None]


class ReleaseBackfillRead(TypedDict):
    deployments_not_found: NotRequired[list[int]]
    deployments_scanned: int
    deployments_skipped: NotRequired[int]
    environment: str
    github_calls: NotRequired[int]
    message: NotRequired[str | None]
    next_cursor: NotRequired[str | None]
    pull_reads_skipped: NotRequired[int]
    rate_limit: NotRequired[int | None]
    rate_limit_remaining: NotRequired[int | None]
    release_ids: list[str]
    releases_created: int
    releases_updated: int
    resume_after: NotRequired[str | None]
    source: NotRequired[str]
    stalled: NotRequired[bool]
    stopped_early: NotRequired[bool]
    team_id: str
    unreadable_deployment_ids: NotRequired[list[int]]
    unreadable_tags: NotRequired[list[str]]


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


class RepositoryReleaseSourceRead(TypedDict):
    kind: NotRequired[Literal["deployments", "tags", "github_releases"]]
    move_issues: NotRequired[bool]
    status_id: NotRequired[str | None]
    tag_pattern: NotRequired[str | None]


class RepositoryReleaseSourceWrite(TypedDict):
    kind: NotRequired[Literal["deployments", "tags", "github_releases"]]
    move_issues: NotRequired[bool]
    status: NotRequired[str | None]
    tag_pattern: NotRequired[str | None]


class ReviewCountsRead(TypedDict):
    approved: NotRequired[int]
    changes_requested: NotRequired[int]
    needs_review: NotRequired[int]


class ReviewIssueRead(TypedDict):
    issue_id: str
    key: str
    team_id: str
    title: str


class ReviewItemRead(TypedDict):
    author_login: str
    ci_state: str
    created_at: NotRequired[str | None]
    group: Literal["needs_review", "changes_requested", "approved"]
    issues: NotRequired[list[ReviewIssueRead]]
    number: int
    repository_full_name: str
    repository_id: str
    review_state: str
    state: Literal["open", "draft"]
    title: str
    updated_at: NotRequired[str | None]
    url: str


class ReviewsRead(TypedDict):
    counts: ReviewCountsRead
    github_linked: bool
    items: list[ReviewItemRead]


class RoadmapEntryRead(TypedDict):
    color: NotRequired[str | None]
    counts: CountsRead
    health: NotRequired[str | None]
    icon: NotRequired[str | None]
    id: str
    kind: Literal["cycle", "project"]
    measure: NotRequired[Literal["points", "issues"]]
    name: str
    priority: NotRequired[str | None]
    progress: NotRequired[CountsRead]
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


class ScimTokenCreate(TypedDict):
    name: NotRequired[str]


class ScimTokenCreated(TypedDict):
    created_at: str
    created_by: str
    key_id: str
    last_used_at: NotRequired[str | None]
    name: str
    prefix: str
    secret: str


class ScimTokenRead(TypedDict):
    created_at: str
    created_by: str
    key_id: str
    last_used_at: NotRequired[str | None]
    name: str
    prefix: str


class SearchCommentRead(TypedDict):
    author_id: str
    comment_id: str
    created_at: str
    issue_id: str
    issue_key: str
    issue_title: str
    snippet: str
    team_id: str


class SearchInitiativeRead(TypedDict):
    health: NotRequired[str | None]
    initiative_id: str
    name: str
    owner_id: NotRequired[str | None]
    status: str
    target_date: NotRequired[str | None]
    updated_at: str


class SearchProjectRead(TypedDict):
    color: NotRequired[str | None]
    health: NotRequired[str | None]
    icon: NotRequired[str | None]
    lead_id: NotRequired[str | None]
    name: str
    project_id: str
    status: str
    target_date: NotRequired[str | None]
    team_ids: NotRequired[list[str]]
    updated_at: str


class SearchResultRead(TypedDict):
    assignee_id: NotRequired[str | None]
    issue_id: str
    key: str
    priority: NotRequired[str | None]
    score: int
    status_category: NotRequired[str | None]
    status_color: NotRequired[str | None]
    status_icon: NotRequired[str | None]
    status_id: str
    status_name: NotRequired[str | None]
    team_id: str
    title: str
    updated_at: str


class ServiceProviderRead(TypedDict):
    oidc_redirect_uri: str
    saml_acs_url: str
    saml_entity_id: str
    saml_metadata_url: str


class ShareLinkCreate(TypedDict):
    expires_in_days: NotRequired[int | None]
    filter: NotRequired[dict[str, Any] | None]
    sort: NotRequired[
        Literal[
            "updated_desc",
            "created_desc",
            "key_asc",
            "priority_desc",
            "due_asc",
            "sla_asc",
            "manual",
            "status_asc",
            "start_asc",
            "estimate_desc",
            "customer_requests_desc",
            "customer_revenue_desc",
        ]
        | None
    ]
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


class ShortcutTeamChoice(TypedDict):
    shortcut_team_id: str
    team_id: str


class ShortcutTeamRead(TypedDict):
    id: str
    key: str
    name: str


class ShortcutTokenRequest(TypedDict):
    api_token: str


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


class SkippedTemplateIssueRead(TypedDict):
    key: str
    reason: str
    title: str


class SlaSettingsRead(TypedDict):
    enabled: bool
    high_hours: NotRequired[int | None]
    low_hours: NotRequired[int | None]
    medium_hours: NotRequired[int | None]
    paused_status_ids: NotRequired[list[str]]
    team_id: str
    updated_at: NotRequired[str | None]
    urgent_hours: NotRequired[int | None]


class SlaSettingsUpdate(TypedDict):
    enabled: NotRequired[bool | None]
    high_hours: NotRequired[int | None]
    low_hours: NotRequired[int | None]
    medium_hours: NotRequired[int | None]
    paused_status_ids: NotRequired[list[str] | None]
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


class SlackLinkRead(TypedDict):
    available: bool
    configured: bool
    linked: NotRequired[bool]
    linked_at: NotRequired[str | None]
    problem: NotRequired[str | None]
    slack_team_name: NotRequired[str | None]
    slack_user_id: NotRequired[str | None]


class SourceTeamMappingRead(TypedDict):
    key: str
    name: str
    source_id: str
    team_id: str


class SsoConnectionRead(TypedDict):
    display_name: str
    has_client_secret: bool
    oidc_client_id: str
    oidc_issuer: str
    oidc_scopes: list[str]
    protocol: Literal["oidc", "saml"]
    saml_certificate_count: int
    saml_idp_entity_id: str
    saml_idp_sso_url: str
    tested: bool
    tested_at: NotRequired[str | None]
    updated_at: str


class SsoConnectionUpdate(TypedDict):
    display_name: NotRequired[str]
    oidc_client_id: NotRequired[str]
    oidc_client_secret: NotRequired[str]
    oidc_issuer: NotRequired[str]
    oidc_scopes: NotRequired[list[str] | None]
    protocol: Literal["oidc", "saml"]
    saml_idp_certificate: NotRequired[str]
    saml_idp_entity_id: NotRequired[str]
    saml_idp_sso_url: NotRequired[str]
    saml_metadata_xml: NotRequired[str]


class SsoDomainCreate(TypedDict):
    domain: str


class SsoDomainRead(TypedDict):
    added_at: str
    domain: str
    lapsed: NotRequired[bool]
    lapsed_at: NotRequired[str | None]
    record_name: str
    record_type: str
    record_value: str
    verified: bool
    verified_at: NotRequired[str | None]


class SsoJoinRead(TypedDict):
    created: bool
    name: str
    slug: str
    workspace_id: str


class SsoPolicyUpdate(TypedDict):
    require_sso: bool


class SsoSettingsRead(TypedDict):
    available: bool
    can_require: bool
    connection: NotRequired[SsoConnectionRead | None]
    current_session_sso: bool
    domains: list[SsoDomainRead]
    require_sso: bool
    service_provider: ServiceProviderRead


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
    scope: NotRequired[Literal["team", "parent", "workspace"]]


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
    parent_team_id: NotRequired[str | None]
    private: NotRequired[bool]


class TeamDisplayDefaultsRead(TypedDict):
    board_display: NotRequired[DisplayOptionsBody | None]
    effective_projects_display: NotRequired[ProjectsDisplay]
    list_display: NotRequired[DisplayOptionsBody | None]
    projects_display: NotRequired[ProjectsDisplay | None]
    team_id: str
    updated_at: NotRequired[str | None]
    updated_by: NotRequired[str | None]


class TeamDisplayDefaultsUpdate(TypedDict):
    board_display: NotRequired[DisplayOptionsBody | None]
    list_display: NotRequired[DisplayOptionsBody | None]
    projects_display: NotRequired[ProjectsDisplay | None]


class TeamMemberRead(TypedDict):
    added_at: str
    avatar_url: NotRequired[str | None]
    display_name: str
    email: str
    full_name: NotRequired[str]
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
    parent_team_id: NotRequired[str | None]
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
    parent_team_id: NotRequired[str | None]
    private: NotRequired[bool | None]
    sync_pr_labels: NotRequired[bool | None]


class TemplateSettingsRead(TypedDict):
    default_document_template_id: NotRequired[str | None]
    default_project_template_id: NotRequired[str | None]
    default_template_id: NotRequired[str | None]
    default_update_template_id: NotRequired[str | None]
    effective_default_document_template_id: NotRequired[str | None]
    effective_default_project_template_id: NotRequired[str | None]
    effective_default_template_id: NotRequired[str | None]
    effective_default_update_template_id: NotRequired[str | None]
    team_id: str


class TemplateSettingsUpdate(TypedDict):
    default_document_template_id: NotRequired[str | None]
    default_project_template_id: NotRequired[str | None]
    default_template_id: NotRequired[str | None]
    default_update_template_id: NotRequired[str | None]


class ThreadResolution(TypedDict):
    resolved_at: NotRequired[str]
    resolved_by: str


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
    auto_grant_new_scopes: NotRequired[bool | None]
    email_notifications: NotRequired[bool | None]
    font_size: NotRequired[Literal["small", "default", "large"] | None]
    home_view: NotRequired[Literal["home", "inbox", "my_issues", "projects", "pulse", "views"] | None]
    name_display: NotRequired[Literal["username", "full_name"] | None]
    notification_preferences: NotRequired[
        dict[
            Literal[
                "assigned",
                "mentioned",
                "commented",
                "status_changed",
                "subscribed",
                "project_update",
                "project_update_due",
                "initiative_update_due",
                "due_soon",
                "overdue",
                "standup_digest",
                "sla_at_risk",
                "sla_breached",
                "review_requested",
                "reminder",
            ],
            NotificationChannelsUpdate,
        ]
        | None
    ]
    projects_display: NotRequired[ProjectsDisplay | None]
    pulse_digest: NotRequired[Literal["off", "daily", "weekly"] | None]
    timezone: NotRequired[str | None]
    week_start: NotRequired[Literal["monday", "sunday", "saturday"] | None]


class UserProfileUpdate(TypedDict):
    display_name: NotRequired[str | None]
    full_name: NotRequired[str | None]


class UserRead(TypedDict):
    auto_grant_new_scopes: NotRequired[bool]
    avatar_url: NotRequired[str | None]
    display_name: str
    email: str
    email_notifications: bool
    email_verified: bool
    font_size: NotRequired[Literal["small", "default", "large"]]
    full_name: NotRequired[str]
    home_view: NotRequired[Literal["home", "inbox", "my_issues", "projects", "pulse", "views"]]
    id: str
    name_display: NotRequired[Literal["username", "full_name"]]
    notification_preferences: dict[str, NotificationChannels]
    projects_display: NotRequired[ProjectsDisplay]
    projects_display_saved: NotRequired[bool]
    pulse_digest: NotRequired[Literal["off", "daily", "weekly"]]
    timezone: NotRequired[str | None]
    two_factor: NotRequired[bool]
    week_start: NotRequired[Literal["monday", "sunday", "saturday"]]


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
    color: NotRequired[
        Literal["gray", "red", "orange", "yellow", "green", "teal", "blue", "indigo", "purple", "pink"] | None
    ]
    completed_window: NotRequired[Literal["all", "past_week", "past_month", "none"] | None]
    description: NotRequired[str | None]
    entity: NotRequired[Literal["issues", "projects"]]
    filter: NotRequired[dict[str, Any]]
    group_by: NotRequired[
        Literal["status", "assignee", "priority", "label", "milestone", "project", "cycle", "parent", "team", "sla"]
        | None
    ]
    icon: NotRequired[str | None]
    kind: NotRequired[Literal["list", "board"]]
    layout: NotRequired[Literal["list", "board"] | None]
    name: str
    ordering: NotRequired[
        Literal[
            "updated_desc",
            "created_desc",
            "key_asc",
            "priority_desc",
            "due_asc",
            "sla_asc",
            "manual",
            "status_asc",
            "start_asc",
            "estimate_desc",
            "customer_requests_desc",
            "customer_revenue_desc",
        ]
        | None
    ]
    ordering_reversed: NotRequired[bool]
    projects_display: NotRequired[ProjectsDisplay | None]
    shared: NotRequired[bool]
    show_archived: NotRequired[bool]
    show_completed: NotRequired[bool]
    show_sub_issues: NotRequired[bool]
    sort: NotRequired[
        Literal[
            "updated_desc",
            "created_desc",
            "key_asc",
            "priority_desc",
            "due_asc",
            "sla_asc",
            "manual",
            "status_asc",
            "start_asc",
            "estimate_desc",
            "customer_requests_desc",
            "customer_revenue_desc",
        ]
    ]
    sub_group_by: NotRequired[
        Literal["status", "assignee", "priority", "label", "milestone", "project", "cycle", "parent", "team", "sla"]
        | None
    ]
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
                "milestone",
                "links",
                "created_at",
                "updated_at",
            ]
        ]
        | None
    ]


class ViewRead(TypedDict):
    color: NotRequired[str | None]
    completed_window: NotRequired[Literal["all", "past_week", "past_month", "none"]]
    created_at: str
    description: NotRequired[str | None]
    entity: NotRequired[Literal["issues", "projects"]]
    favorite: NotRequired[bool]
    filter: NotRequired[dict[str, Any]]
    group_by: NotRequired[str | None]
    icon: NotRequired[str | None]
    kind: str
    layout: str
    name: str
    ordering: NotRequired[str | None]
    ordering_reversed: NotRequired[bool]
    owner_id: str
    projects_display: NotRequired[ProjectsDisplay | None]
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
    color: NotRequired[
        Literal["gray", "red", "orange", "yellow", "green", "teal", "blue", "indigo", "purple", "pink"] | None
    ]
    completed_window: NotRequired[Literal["all", "past_week", "past_month", "none"] | None]
    description: NotRequired[str | None]
    filter: NotRequired[dict[str, Any] | None]
    group_by: NotRequired[
        Literal["status", "assignee", "priority", "label", "milestone", "project", "cycle", "parent", "team", "sla"]
        | None
    ]
    icon: NotRequired[str | None]
    layout: NotRequired[Literal["list", "board"] | None]
    name: NotRequired[str | None]
    ordering: NotRequired[
        Literal[
            "updated_desc",
            "created_desc",
            "key_asc",
            "priority_desc",
            "due_asc",
            "sla_asc",
            "manual",
            "status_asc",
            "start_asc",
            "estimate_desc",
            "customer_requests_desc",
            "customer_revenue_desc",
        ]
        | None
    ]
    ordering_reversed: NotRequired[bool | None]
    projects_display: NotRequired[ProjectsDisplay | None]
    shared: NotRequired[bool | None]
    show_archived: NotRequired[bool | None]
    show_completed: NotRequired[bool | None]
    show_sub_issues: NotRequired[bool | None]
    sort: NotRequired[
        Literal[
            "updated_desc",
            "created_desc",
            "key_asc",
            "priority_desc",
            "due_asc",
            "sla_asc",
            "manual",
            "status_asc",
            "start_asc",
            "estimate_desc",
            "customer_requests_desc",
            "customer_revenue_desc",
        ]
        | None
    ]
    sub_group_by: NotRequired[
        Literal["status", "assignee", "priority", "label", "milestone", "project", "cycle", "parent", "team", "sla"]
        | None
    ]
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
                "milestone",
                "links",
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


class WorkspaceChannelCreate(TypedDict, closed=True):
    discord_channel_id: NotRequired[str | None]
    discord_channel_name: NotRequired[str]
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
            "standup_digest",
        ]
    ]
    label: NotRequired[str]
    slack_channel_id: NotRequired[str | None]
    slack_channel_name: NotRequired[str]
    team_ids: NotRequired[list[str]]
    url: NotRequired[str | None]


class WorkspaceChannelUpdate(TypedDict, closed=True):
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
                "standup_digest",
            ]
        ]
        | None
    ]
    label: NotRequired[str | None]
    team_ids: NotRequired[list[str] | None]


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


class WorkspaceDisplayDefaultsRead(TypedDict):
    effective_projects_display: NotRequired[ProjectsDisplay]
    projects_display: NotRequired[ProjectsDisplay | None]
    updated_at: NotRequired[str | None]
    updated_by: NotRequired[str | None]


class WorkspaceDisplayDefaultsUpdate(TypedDict):
    projects_display: NotRequired[ProjectsDisplay | None]


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
    auth_policy_reason: NotRequired[Literal["two_factor", "sign_in_method", "sso"] | None]
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
    blocking_count: NotRequired[int]
    body: NotRequired[str | None]
    completed_at: NotRequired[str | None]
    created_at: str
    created_by: str
    cycle_id: NotRequired[str | None]
    due_date: NotRequired[str | None]
    estimate: NotRequired[str | None]
    external_ref: NotRequired[str | None]
    id: str
    in_triage: NotRequired[bool]
    key: str
    label_ids: NotRequired[list[str]]
    number: int
    parent_id: NotRequired[str | None]
    parent_key: NotRequired[str | None]
    parent_title: NotRequired[str | None]
    priority: Literal["none", "urgent", "high", "medium", "low"]
    progress: ProgressRead
    project_id: NotRequired[str | None]
    project_milestone_id: NotRequired[str | None]
    pull_request_summary: NotRequired[PullRequestSummaryRead | None]
    relation_count: NotRequired[int]
    sla_breaches_at: NotRequired[str | None]
    sla_paused_at: NotRequired[str | None]
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


class AgentProfileActivityRead(TypedDict):
    events: list[AgentProfileEventRead]
    next_cursor: NotRequired[str | None]


class AgentProfileListRead(TypedDict):
    max_profiles: int
    profiles: list[AgentProfileRead]
    versions_kept: int


class AgentProfileVersionListRead(TypedDict):
    latest_version: int
    name: str
    versions: list[AgentProfileVersionRead]
    versions_kept: int


class ApiKeyListRead(TypedDict):
    api_keys: list[ApiKeyRead]


class ApprovedDomainListRead(TypedDict):
    domains: list[ApprovedDomainRead]


class AsanaImportRequest(TypedDict):
    projects: list[AsanaProjectChoice]
    token: str


class AsanaProjectListRead(TypedDict):
    items: list[AsanaProjectRead]


class AsanaProjectPreviewRead(TypedDict):
    completed_count: int
    create_project: bool
    name: str
    project_gid: str
    sections: list[str]
    status_field_gid: NotRequired[str | None]
    status_field_name: NotRequired[str | None]
    status_fields: list[AsanaStatusFieldRead]
    statuses: list[AsanaStatusPlanRead]
    task_count: int
    team_id: str


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
    github_thread: NotRequired[GithubThread | None]
    issue_id: str
    mentions: NotRequired[list[str]]
    parent_comment_id: NotRequired[str | None]
    reactions: NotRequired[list[ReactionGroupRead]]
    reply_count: NotRequired[int]
    resolution: NotRequired[ThreadResolution | None]
    source: NotRequired[Literal["web", "mcp", "cli", "api", "github", "system"] | None]
    team_id: str
    workspace_id: str


class ConnectedAppRead(TypedDict):
    client_id: str
    client_name: str
    first_authorized_at: NotRequired[str | None]
    last_used_at: NotRequired[str | None]
    new_scopes: NotRequired[list[str]]
    scopes: list[str]
    workspaces: list[ConnectedAppWorkspaceRead]


class CustomerListRead(TypedDict):
    customers: list[CustomerRead]
    next_cursor: NotRequired[str | None]


class CustomerRequestListRead(TypedDict):
    next_cursor: NotRequired[str | None]
    requests: list[CustomerRequestRead]


class CycleListRead(TypedDict):
    cycles: list[CycleRead]
    next_cursor: NotRequired[str | None]


class DocumentListRead(TypedDict):
    documents: list[DocumentSummaryRead]
    next_cursor: NotRequired[str | None]


class DocumentVersionListRead(TypedDict):
    next_cursor: NotRequired[str | None]
    versions: list[DocumentVersionRead]


class DraftListRead(TypedDict):
    drafts: list[DraftRead]


class ErrorResponse(TypedDict):
    details: NotRequired[list[ValidationErrorDetail] | None]
    error_code: str
    message: str
    request_id: str
    status: int
    success: NotRequired[bool]


class FavoriteOrder(TypedDict):
    items: list[FavoriteRef]


class FavoriteRead(TypedDict):
    color: NotRequired[str | None]
    icon: NotRequired[str | None]
    issue_key: NotRequired[str | None]
    kind: Literal["issue", "project", "cycle", "view", "team", "document", "initiative"]
    parent_id: NotRequired[str | None]
    parent_kind: NotRequired[str | None]
    status: NotRequired[StatusRead | None]
    target_id: str
    team_id: NotRequired[str | None]
    team_key_prefix: NotRequired[str | None]
    title: str


class FormField(TypedDict):
    description: NotRequired[str | None]
    key: NotRequired[str | None]
    label: str
    options: NotRequired[list[FormOption]]
    required: NotRequired[bool]
    type: NotRequired[Literal["short_text", "long_text", "select", "checkbox"]]


class FormFieldBlueprint(TypedDict):
    description: NotRequired[str | None]
    key: str
    label: str
    options: NotRequired[list[FormOptionBlueprint]]
    required: NotRequired[bool]
    type: str


class GitHubImportRepositoryListRead(TypedDict):
    items: list[GitHubImportRepositoryRead]


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


class HomePullRequestItem(TypedDict):
    issue: AppCommonApiSchemasIssuesIssueRead
    pull_request: PullRequestSummaryEntryRead


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


class IncludedReleaseRead(TypedDict):
    created_at: str
    current_stage: NotRequired[ReleaseStageRead | None]
    issue_count: int
    name: str
    pr_number: NotRequired[int | None]
    pr_url: NotRequired[str | None]
    release_id: str
    sha: NotRequired[str | None]


class InitiativeRead(TypedDict):
    ancestors: NotRequired[list[InitiativeRefRead]]
    counts: NotRequired[CountsRead]
    created_at: str
    created_by: str
    description: NotRequired[str | None]
    health: NotRequired[Literal["on_track", "at_risk", "off_track"] | None]
    initiative_id: str
    last_update_at: NotRequired[str | None]
    measure: NotRequired[Literal["points", "issues"]]
    name: str
    next_update_due_at: NotRequired[str | None]
    owner_id: NotRequired[str | None]
    parent_initiative_id: NotRequired[str | None]
    points: NotRequired[CountsRead]
    progress: NotRequired[CountsRead]
    project_count: NotRequired[int]
    project_health: NotRequired[HealthBreakdownRead]
    project_ids: NotRequired[list[str]]
    rollup_project_ids: NotRequired[list[str]]
    status: Literal["planned", "active", "completed"]
    status_counts: NotRequired[dict[str, int]]
    sub_initiative_ids: NotRequired[list[str]]
    target_date: NotRequired[str | None]
    update_due_state: NotRequired[Literal["upcoming", "due", "overdue"] | None]
    update_interval_days: NotRequired[int]
    update_interval_inherited: NotRequired[bool]
    updated_at: str
    workspace_id: str


class InitiativeUpdateListRead(TypedDict):
    next_cursor: NotRequired[str | None]
    updates: list[InitiativeUpdateRead]


class InstallationRead(TypedDict):
    account_login: str
    account_type: str
    avatar_url: NotRequired[str]
    html_url: str
    installation_id: str
    installed_at: str
    installed_by: str
    label_set: NotRequired[LabelSetRead]
    manage_url: NotRequired[str]
    repository_count: int
    repository_selection: str
    suspended: NotRequired[bool]


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
    parent_links: NotRequired[int]
    problems: list[RowProblemRead]
    problems_truncated: bool
    rows: list[ImportRowRead]
    statuses: list[StatusMappingRead]
    total_rows: int


class IssueImportRead(TypedDict):
    asana_projects: NotRequired[list[AsanaProjectMappingRead]]
    counts: NotRequired[dict[str, int]]
    created_at: str
    created_count: int
    error: NotRequired[str | None]
    file_name: str
    finished_at: NotRequired[str | None]
    github_repository_id: NotRequired[str | None]
    import_id: str
    jira_projects: NotRequired[list[JiraProjectMappingRead]]
    kind: NotRequired[Literal["csv", "linear", "github", "shortcut", "asana", "jira"]]
    labels_created: int
    linear_teams: NotRequired[list[LinearTeamMappingRead]]
    linked_count: NotRequired[int]
    phase: NotRequired[str | None]
    phase_count: NotRequired[int]
    phase_index: NotRequired[int]
    preset: str
    problem_count: int
    problems: list[RowProblemRead]
    problems_truncated: bool
    processed_rows: int
    requested_by: str
    skipped_count: int
    source_teams: NotRequired[list[SourceTeamMappingRead]]
    started_at: NotRequired[str | None]
    status: Literal["queued", "running", "completed", "failed", "cancelled"]
    team_id: str
    total_rows: int
    updated_at: str
    updated_count: NotRequired[int]
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
    included_in: NotRequired[str | None]
    included_in_name: NotRequired[str | None]
    name: str
    release_id: str
    team_id: str


class IssueReminderListRead(TypedDict):
    reminders: NotRequired[list[IssueReminderRead]]


class IssueSyncListRead(TypedDict):
    issues: list[AppCommonApiSchemasIssuesIssueRead]
    next_cursor: NotRequired[str | None]
    removed_ids: NotRequired[list[str]]
    resync_required: NotRequired[bool]
    synced_at: NotRequired[str | None]


class JiraImportRequest(TypedDict):
    email: str
    projects: list[JiraProjectChoice]
    site_url: str
    token: str


class JiraProjectListRead(TypedDict):
    items: list[JiraProjectRead]
    site_url: str


class JiraProjectPreviewRead(TypedDict):
    done_count: int
    epics_as: str
    estimate_field: NotRequired[str | None]
    issue_count: int
    jql: NotRequired[str | None]
    name: str
    project_key: NotRequired[str | None]
    sprint_field: NotRequired[str | None]
    statuses: list[JiraStatusPlanRead]
    team_id: str


class JoinableWorkspaceListRead(TypedDict):
    workspaces: list[JoinableWorkspaceRead]


class LabelListRead(TypedDict):
    labels: list[LabelRead]


class LabelMergeRead(TypedDict):
    complete: NotRequired[bool]
    issues_updated: NotRequired[int]
    source_label_id: str
    source_name: str
    target: LabelRead
    templates_updated: NotRequired[int]
    views_updated: NotRequired[int]


class LinearImportRequest(TypedDict):
    api_key: str
    teams: list[LinearTeamChoice]


class LinearTeamListRead(TypedDict):
    items: list[LinearTeamRead]


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


class ProjectActivityListRead(TypedDict):
    activity: list[ProjectActivityRead]
    next_cursor: NotRequired[str | None]


class ProjectHistoryRead(TypedDict):
    days: list[CycleHistoryPoint]
    measure: Literal["points", "issues"]
    project_id: str
    projection: NotRequired[ProjectProjectionRead | None]
    recorded_since: NotRequired[str | None]
    start_date: NotRequired[str | None]
    target_date: NotRequired[str | None]
    today: str


class ProjectRead(TypedDict):
    blocked_by_project_ids: NotRequired[list[str]]
    blocking_project_ids: NotRequired[list[str]]
    color: NotRequired[str | None]
    completed_at: NotRequired[str | None]
    counts: CountsRead
    created_at: str
    created_by: str
    customer_request_count: NotRequired[int | None]
    customer_revenue: NotRequired[int | None]
    description: NotRequired[str | None]
    health: NotRequired[Literal["on_track", "at_risk", "off_track"] | None]
    icon: NotRequired[str | None]
    initiative_id: NotRequired[str | None]
    last_update_at: NotRequired[str | None]
    lead_id: NotRequired[str | None]
    measure: NotRequired[Literal["points", "issues"]]
    member_ids: NotRequired[list[str]]
    milestone_markers: NotRequired[list[ProjectMilestoneMarkerRead]]
    name: str
    next_update_due_at: NotRequired[str | None]
    open_issue_count: NotRequired[int | None]
    points: NotRequired[CountsRead]
    priority: NotRequired[Literal["none", "urgent", "high", "medium", "low"]]
    progress: NotRequired[CountsRead]
    project_id: str
    skipped_template_issues: NotRequired[list[SkippedTemplateIssueRead] | None]
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


class ProjectRelationListRead(TypedDict):
    next_cursor: NotRequired[str | None]
    relations: list[ProjectRelationRead]


class ProjectUpdateListRead(TypedDict):
    next_cursor: NotRequired[str | None]
    updates: list[ProjectUpdateRead]


class RecurringListRead(TypedDict):
    default_timezone: str
    recurring_issues: list[RecurringRead]


class ReleaseDetailRead(TypedDict):
    created_at: str
    created_by: NotRequired[str | None]
    current_stage: NotRequired[ReleaseStageRead | None]
    description: NotRequired[str | None]
    github_release_url: NotRequired[str | None]
    included_count: NotRequired[int]
    included_in: NotRequired[str | None]
    included_in_release: NotRequired[IncludedReleaseRead | None]
    included_releases: NotRequired[list[IncludedReleaseRead]]
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
    included_count: NotRequired[int]
    included_in: NotRequired[str | None]
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


class RepositoryLinkWrite(TypedDict):
    release_source: NotRequired[RepositoryReleaseSourceWrite | None]
    team_id: NotRequired[str | None]


class RepositoryRead(TypedDict):
    default_branch: str
    full_name: str
    linked_at: str
    name: str
    private: bool
    release_source: NotRequired[RepositoryReleaseSourceRead]
    repository_id: str
    team_id: NotRequired[str | None]


class ScimSettingsRead(TypedDict):
    base_url: str
    tokens: list[ScimTokenRead]


class SearchRead(TypedDict):
    comments: NotRequired[list[SearchCommentRead]]
    documents: NotRequired[list[DocumentSummaryRead]]
    initiatives: NotRequired[list[SearchInitiativeRead]]
    projects: NotRequired[list[SearchProjectRead]]
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


class ShortcutImportRequest(TypedDict):
    api_token: str
    teams: list[ShortcutTeamChoice]


class ShortcutPreviewTeamRead(TypedDict):
    epics: int
    iterations: int
    matched_owners: int
    name: str
    new_labels: list[str]
    shortcut_team_id: str
    statuses: list[StatusMappingRead]
    stories: int
    stories_capped: bool
    team_id: str
    unmatched_owners: int


class ShortcutTeamListRead(TypedDict):
    items: list[ShortcutTeamRead]


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


class TemplateCreate(TypedDict):
    assignee_id: NotRequired[str | None]
    body: NotRequired[str | None]
    cycle_id: NotRequired[str | None]
    estimate: NotRequired[str | None]
    form_fields: NotRequired[list[FormField]]
    kind: NotRequired[Literal["issue", "project", "document"]]
    label_ids: NotRequired[list[str]]
    name: str
    position: NotRequired[int | None]
    priority: NotRequired[Literal["none", "urgent", "high", "medium", "low"] | None]
    project: NotRequired[ProjectTemplateFields | None]
    project_id: NotRequired[str | None]
    project_milestone_id: NotRequired[str | None]
    status_id: NotRequired[str | None]
    title: NotRequired[str | None]


class TemplateRead(TypedDict):
    assignee_id: NotRequired[str | None]
    body: NotRequired[str | None]
    created_at: str
    created_by: NotRequired[str | None]
    cycle_id: NotRequired[str | None]
    estimate: NotRequired[str | None]
    form_fields: NotRequired[list[FormFieldBlueprint]]
    id: str
    kind: NotRequired[Literal["issue", "project", "document"]]
    label_ids: NotRequired[list[str]]
    name: str
    position: NotRequired[int]
    priority: NotRequired[Literal["none", "urgent", "high", "medium", "low"] | None]
    project: NotRequired[ProjectBlueprint | None]
    project_id: NotRequired[str | None]
    project_milestone_id: NotRequired[str | None]
    scope: NotRequired[Literal["team", "parent", "workspace"]]
    status_id: NotRequired[str | None]
    team_id: NotRequired[str | None]
    title: NotRequired[str | None]
    updated_at: str


class TemplateUpdate(TypedDict):
    assignee_id: NotRequired[str | None]
    body: NotRequired[str | None]
    cycle_id: NotRequired[str | None]
    estimate: NotRequired[str | None]
    form_fields: NotRequired[list[FormField] | None]
    label_ids: NotRequired[list[str] | None]
    name: NotRequired[str | None]
    position: NotRequired[int | None]
    priority: NotRequired[Literal["none", "urgent", "high", "medium", "low"] | None]
    project: NotRequired[ProjectTemplateFields | None]
    project_id: NotRequired[str | None]
    project_milestone_id: NotRequired[str | None]
    status_id: NotRequired[str | None]
    title: NotRequired[str | None]


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


class AsanaImportPreviewRead(TypedDict):
    projects: list[AsanaProjectPreviewRead]


class CommentListRead(TypedDict):
    comments: list[CommentRead]
    next_cursor: NotRequired[str | None]


class ConnectedAppListRead(TypedDict):
    apps: list[ConnectedAppRead]


class CursorPageIssueLinkRead(TypedDict):
    items: list[IssueLinkRead]
    next_cursor: NotRequired[str | None]


class DocumentTemplateListRead(TypedDict):
    default_document_template_id: NotRequired[str | None]
    default_update_template_id: NotRequired[str | None]
    templates: list[TemplateRead]


class FavoriteListRead(TypedDict):
    favorites: list[FavoriteRead]


class HomeRead(TypedDict):
    cycles: NotRequired[list[CycleRead]]
    focus: HomeFocusRead
    generated_at: str
    inbox: HomeInboxRead
    projects: NotRequired[list[ProjectRead]]
    projects_total: NotRequired[int]
    pull_requests: NotRequired[list[HomePullRequestItem]]
    pulse: NotRequired[list[HomePulseItem]]
    releases: NotRequired[list[ReleaseRead]]
    shipped: HomeShippedRead
    team_ids: list[str]
    today: str


class InitiativeListRead(TypedDict):
    initiatives: list[InitiativeRead]
    next_cursor: NotRequired[str | None]


class IssueConversionRead(TypedDict):
    issue: AppCommonApiSchemasIssuesIssueRead
    moved_issue_ids: NotRequired[list[str]]
    project: ProjectRead


class IssueImportListRead(TypedDict):
    items: list[IssueImportRead]


class IssueReleaseListRead(TypedDict):
    releases: list[IssueReleaseRead]


class JiraImportPreviewRead(TypedDict):
    projects: list[JiraProjectPreviewRead]
    site_url: str


class LinkListRead(TypedDict):
    links: list[LinkRead]


class ProjectListRead(TypedDict):
    next_cursor: NotRequired[str | None]
    projects: list[ProjectRead]


class ReleaseListRead(TypedDict):
    next_cursor: NotRequired[str | None]
    releases: list[ReleaseRead]


class ShortcutImportPreviewRead(TypedDict):
    teams: list[ShortcutPreviewTeamRead]


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


class TemplateListRead(TypedDict):
    default_template_id: NotRequired[str | None]
    templates: list[TemplateRead]
