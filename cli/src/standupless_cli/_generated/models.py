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


class AuthorRead(TypedDict):
    avatar_url: NotRequired[str | None]
    display_name: NotRequired[str]
    email: NotRequired[str]
    user_id: str


class CarryOverRead(TypedDict):
    carried_in: NotRequired[int]
    carried_in_points: NotRequired[int]
    carried_out: NotRequired[int]
    carried_out_points: NotRequired[int]


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
    updated_at: str
    workspace_id: str


class CycleSettingsRead(TypedDict):
    auto_add_started: bool
    cooldown_weeks: int
    duration_weeks: int
    enabled: bool
    start_weekday: int
    team_id: str
    upcoming_count: int
    updated_at: NotRequired[str | None]


class CycleSettingsUpdate(TypedDict):
    auto_add_started: NotRequired[bool | None]
    cooldown_weeks: NotRequired[int | None]
    duration_weeks: NotRequired[int | None]
    enabled: NotRequired[bool | None]
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


class IssueLinkRead(TypedDict):
    applied_status_id: NotRequired[str | None]
    author_login: str
    closes_issue: bool
    issue_id: str
    issue_key: str
    link_id: str
    linked_at: str
    pr_number: int
    pr_state: Literal["open", "draft", "merged", "closed"]
    pr_title: str
    pr_url: str
    repository_full_name: str
    updated_at: str


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


class LabelCreate(TypedDict):
    color: str
    name: str


class LabelRead(TypedDict):
    color: str
    id: str
    name: str


class LabelUpdate(TypedDict):
    color: NotRequired[str | None]
    name: NotRequired[str | None]


class LinkCreate(TypedDict):
    target_issue_id: str
    type: Literal["blocks", "blocked_by", "relates_to", "duplicate_of"]


class LinkStatusRead(TypedDict):
    category: str
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
    project_id: str
    sort_order: str
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
    team_id: str
    unread: bool
    workspace_id: str


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
    lead_id: NotRequired[str | None]
    member_ids: NotRequired[list[str]]
    name: str
    priority: NotRequired[Literal["none", "urgent", "high", "medium", "low"]]
    start_date: NotRequired[str | None]
    status: NotRequired[Literal["backlog", "planned", "in_progress", "paused", "completed", "canceled"]]
    target_date: NotRequired[str | None]
    team_id: NotRequired[str | None]
    team_ids: NotRequired[list[str] | None]


class ProjectRead(TypedDict):
    color: NotRequired[str | None]
    counts: CountsRead
    created_at: str
    created_by: str
    description: NotRequired[str | None]
    health: NotRequired[Literal["on_track", "at_risk", "off_track"] | None]
    icon: NotRequired[str | None]
    last_update_at: NotRequired[str | None]
    lead_id: NotRequired[str | None]
    member_ids: NotRequired[list[str]]
    name: str
    priority: NotRequired[Literal["none", "urgent", "high", "medium", "low"]]
    project_id: str
    start_date: NotRequired[str | None]
    status: Literal["backlog", "planned", "in_progress", "paused", "completed", "canceled"]
    target_date: NotRequired[str | None]
    team_id: str
    team_ids: list[str]
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
    lead_id: NotRequired[str | None]
    member_ids: NotRequired[list[str] | None]
    name: NotRequired[str | None]
    priority: NotRequired[Literal["none", "urgent", "high", "medium", "low"] | None]
    start_date: NotRequired[str | None]
    status: NotRequired[Literal["backlog", "planned", "in_progress", "paused", "completed", "canceled"] | None]
    target_date: NotRequired[str | None]
    team_id: NotRequired[str | None]
    team_ids: NotRequired[list[str] | None]


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
    update_id: str
    updated_at: str
    workspace_id: str


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
    color: str
    name: str


class SharedTarget(TypedDict):
    shared_at: str
    target_type: Literal["issue", "view"]
    team_name: str
    title: str
    workspace_name: str


class StatusCreate(TypedDict):
    category: Literal["backlog", "unstarted", "started", "completed", "cancelled"]
    name: str
    position: NotRequired[int | None]


class StatusRead(TypedDict):
    category: Literal["backlog", "unstarted", "started", "completed", "cancelled"]
    id: str
    name: str
    position: int


class StatusUpdate(TypedDict):
    category: NotRequired[Literal["backlog", "unstarted", "started", "completed", "cancelled"] | None]
    name: NotRequired[str | None]
    position: NotRequired[int | None]


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
    estimate_scale: NotRequired[Literal["off", "fibonacci", "linear", "tshirt"]]
    key_prefix: str
    name: str


class TeamMemberRead(TypedDict):
    added_at: str
    avatar_url: NotRequired[str | None]
    display_name: str
    email: str
    role: Literal["admin", "member"]
    user_id: str


class TeamMemberUpdate(TypedDict):
    role: Literal["admin", "member"]


class TeamRead(TypedDict):
    created_at: str
    description: NotRequired[str | None]
    estimate_scale: str
    icon_url: NotRequired[str | None]
    id: str
    is_member: NotRequired[bool]
    key_prefix: str
    member_count: NotRequired[int]
    name: str
    retired_key_prefixes: NotRequired[list[str]]
    role: NotRequired[Literal["admin", "member"] | None]
    updated_at: str
    workspace_id: str


class TeamSyncRead(TypedDict):
    created_at: str
    created_by: str
    direction: Literal["two_way", "github_to_standupless"]
    enabled: bool
    full_name: str
    repository_id: str
    sync_labels: bool
    team_id: str
    updated_at: str


class TeamSyncWrite(TypedDict, closed=True):
    direction: NotRequired[Literal["two_way", "github_to_standupless"]]
    enabled: NotRequired[bool]
    repository_id: str
    sync_labels: NotRequired[bool]


class TeamUpdate(TypedDict):
    description: NotRequired[str | None]
    estimate_scale: NotRequired[Literal["off", "fibonacci", "linear", "tshirt"] | None]
    key_prefix: NotRequired[str | None]
    name: NotRequired[str | None]


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
            Literal["assigned", "mentioned", "commented", "status_changed", "project_update"],
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


class WorkspaceRead(TypedDict):
    created_at: str
    deletion_scheduled_at: NotRequired[str | None]
    deletion_scheduled_by: NotRequired[str | None]
    icon_url: NotRequired[str | None]
    id: str
    name: str
    plan: str
    purge_after: NotRequired[str | None]
    role: NotRequired[Literal["owner", "admin", "member", "guest"] | None]
    slug: str


class WorkspaceSummaryRead(TypedDict):
    deletion_scheduled: NotRequired[bool]
    id: str
    name: str
    slug: str


class WorkspaceUpdate(TypedDict):
    name: NotRequired[str | None]


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
    key: str
    label_ids: NotRequired[list[str]]
    number: int
    parent_id: NotRequired[str | None]
    priority: Literal["none", "urgent", "high", "medium", "low"]
    progress: ProgressRead
    project_id: NotRequired[str | None]
    project_milestone_id: NotRequired[str | None]
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


class AttachmentListRead(TypedDict):
    attachments: list[AttachmentRead]
    next_cursor: NotRequired[str | None]


class BoardColumn(TypedDict):
    category: str
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
    team_id: str
    workspace_id: str


class ConnectedAppRead(TypedDict):
    client_id: str
    client_name: str
    first_authorized_at: NotRequired[str | None]
    last_used_at: NotRequired[str | None]
    scopes: list[str]
    workspaces: list[ConnectedAppWorkspaceRead]


class CursorPageIssueLinkRead(TypedDict):
    items: list[IssueLinkRead]
    next_cursor: NotRequired[str | None]


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


class InboxListRead(TypedDict):
    next_cursor: NotRequired[str | None]
    notifications: list[NotificationRead]


class InviteListRead(TypedDict):
    invites: list[InviteRead]


class IssueBulkRead(TypedDict):
    issues: NotRequired[list[AppCommonApiSchemasIssuesIssueRead]]
    skipped: NotRequired[list[str]]


class IssueListRead(TypedDict):
    issues: list[AppCommonApiSchemasIssuesIssueRead]
    next_cursor: NotRequired[str | None]


class IssueSyncListRead(TypedDict):
    issues: list[AppCommonApiSchemasIssuesIssueRead]
    next_cursor: NotRequired[str | None]
    removed_ids: NotRequired[list[str]]
    resync_required: NotRequired[bool]
    synced_at: NotRequired[str | None]


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


class StatusListRead(TypedDict):
    statuses: list[StatusRead]


class TeamListRead(TypedDict):
    teams: list[TeamRead]


class TeamMemberListRead(TypedDict):
    members: list[TeamMemberRead]


class ViewListRead(TypedDict):
    views: NotRequired[list[ViewRead]]


class WorkspaceConnectedAppListRead(TypedDict):
    apps: list[WorkspaceConnectedAppRead]


class WorkspaceListRead(TypedDict):
    workspaces: list[WorkspaceRead]


class CommentListRead(TypedDict):
    comments: list[CommentRead]
    next_cursor: NotRequired[str | None]


class ConnectedAppListRead(TypedDict):
    apps: list[ConnectedAppRead]


class LinkListRead(TypedDict):
    links: list[LinkRead]
