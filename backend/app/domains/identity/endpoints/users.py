"""The signed in user's own profile, which the frontend's auth shell loads on boot.

The shared identity package issues tokens but never renders this product's
`users` row, so the one route that does lives here, in the domain whose hooks
own that table.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field, field_validator
from webbpulse.identity.claims import identity_claims

from app.common import agent_profiles, team_purge
from app.common.account_deletion import AccountDeletionPlan, WorkspaceSummary, plan_account_deletion
from app.common.api.dependencies.authz import (
    auth_strength_of,
    caller_person,
    caller_subject,
    has_two_factor,
    require_person,
)
from app.common.api.dependencies.repositories import Repositories, get_repositories
from app.common.api.schemas.initiatives_display import InitiativesDisplay, stored_initiatives_display
from app.common.api.schemas.projects_display import ProjectsDisplay, stored_projects_display
from app.common.db.dynamo.inbox import NOTIFICATION_KINDS, NotificationKind
from app.common.db.dynamo.users import (
    ACTIVITY_FILTERS,
    CODE_THEMES,
    DEFAULT_PRIORITY_KINDS,
    EMAIL_FORMATS,
    FONT_SIZES,
    HOME_VIEWS,
    NAME_DISPLAYS,
    PULSE_DIGESTS,
    SIDEBAR_BADGE_STYLES,
    SIDEBAR_ITEMS,
    SIDEBAR_VISIBILITIES,
    THEMES,
    WEEK_STARTS,
    ActivityFilterField,
    CodeThemeField,
    EmailFormatField,
    FontSizeField,
    HomeViewField,
    NameDisplayField,
    PulseDigestField,
    SidebarBadgeStyleField,
    SidebarItemField,
    SidebarVisibilityField,
    ThemeField,
    User,
    WeekStartField,
    channel_default,
)
from app.common.email import deliver
from app.common.handles import HANDLE_PATTERN, handle_conflicts, normalise_handle, previous_after_rename
from app.common.icons import (
    IconCommit,
    IconUploadCreate,
    IconUploadRead,
    delete_icon_objects,
    icon_url,
    presign_icon,
    user_owner,
    verify_upload,
)
from app.common.inbox import INBOX_KINDS
from app.common.notification_pause import PAUSE_MAX, WorkingHours
from app.domains.identity.account_revocation import revoke_account_access
from app.domains.identity.email import render_account_deletion

_log = logging.getLogger(__name__)

router = APIRouter()

NO_SUCH_USER = {"error_code": "NOT_FOUND", "message": "Resource not found"}

EMAIL_MISMATCH = {"error_code": "CONFIRMATION_MISMATCH", "message": "Type your email address exactly to confirm"}

ACCOUNT_DELETED = {"error_code": "ACCOUNT_DELETED", "message": "This account has been deleted"}

HANDLE_RULE = "Use 1 to 39 letters, digits, hyphens or underscores, starting with a letter or digit"


class NotificationChannels(BaseModel):
    """Where one kind of notification is delivered: the inbox, email and chat direct messages.

    `chat` covers every chat account the person linked, Slack or Discord, and only
    reaches them once one is linked.
    """

    in_app: bool
    email: bool
    chat: bool = True


class UserRead(BaseModel):
    """The caller's own account, in the shape the frontend's `UserRead` expects.

    `projects_display` is the person's projects arrangement, the built-in one
    when they never arranged the page, and `projects_display_saved` says whether
    they did. A person who has not opens the page with their team's or the
    workspace's default instead. `initiatives_display` and
    `initiatives_display_saved` are the same for the initiatives list. `theme`
    is null until the person first saves one. `sidebar_items` names every
    sidebar item with where it sits, `show` unless the person moved it.
    `priority_inbox` says whether the inbox splits into Priority and Other, and
    `priority_kinds` names every kind the Priority tab holds.
    `notifications_paused_until` is the end of a pause still running, null when
    none is, `working_hours` the schedule notifications reach the person in, and
    `urgent_bypasses_pause` whether direct mentions and urgent assignments come
    through either.
    """

    id: str
    email: str
    display_name: str
    full_name: str = ""
    email_verified: bool
    email_notifications: bool
    notification_preferences: dict[str, NotificationChannels]
    priority_inbox: bool = True
    priority_kinds: list[str] = Field(default_factory=list)
    email_format: EmailFormatField = "digest"
    notifications_paused_until: Optional[datetime] = None
    working_hours: Optional[WorkingHours] = None
    urgent_bypasses_pause: bool = False
    avatar_url: Optional[str] = None
    two_factor: bool = False
    timezone: Optional[str] = None
    pulse_digest: PulseDigestField = "off"
    home_view: HomeViewField = "home"
    week_start: WeekStartField = "monday"
    name_display: NameDisplayField = "username"
    font_size: FontSizeField = "default"
    theme: Optional[ThemeField] = None
    pointer_cursors: bool = False
    underline_links: bool = False
    code_theme: CodeThemeField = "app"
    convert_emoticons: bool = True
    activity_filter: ActivityFilterField = "all"
    sidebar_items: dict[SidebarItemField, SidebarVisibilityField] = Field(default_factory=dict)
    sidebar_badge_style: SidebarBadgeStyleField = "count"
    projects_display: ProjectsDisplay = Field(default_factory=ProjectsDisplay)
    projects_display_saved: bool = False
    initiatives_display: InitiativesDisplay = Field(default_factory=InitiativesDisplay)
    initiatives_display_saved: bool = False
    auto_assign_to_self: bool = False
    branch_copy_starts: bool = True
    branch_copy_assigns: bool = True
    auto_grant_new_scopes: bool = False


class WorkspaceSummaryRead(BaseModel):
    """One workspace as the account deletion plan names it."""

    id: str
    name: str
    slug: str
    deletion_scheduled: bool = False


class AccountDeletionPlanRead(BaseModel):
    """What deleting the caller's account would do to each workspace they are in.

    `blocking` workspaces stop the deletion: the caller is their only owner and
    other people are in them, so ownership has to move or the workspace has to be
    deleted first. One already scheduled for deletion carries `deletion_scheduled`
    and stops blocking once its own purge starts. `deleted_with_account` have no other members. `leaving` keep
    going without the caller.
    """

    blocking: list[WorkspaceSummaryRead]
    deleted_with_account: list[WorkspaceSummaryRead]
    leaving: list[WorkspaceSummaryRead]


class AccountDeletionRequest(BaseModel):
    """The body `POST /api/users/me/deletion` takes: the account's address typed out again."""

    confirm_email: str = Field(min_length=3, max_length=320)


class NotificationChannelsUpdate(BaseModel):
    """A partial change to one kind's channels; an omitted channel keeps its value."""

    in_app: Optional[bool] = None
    email: Optional[bool] = None
    chat: Optional[bool] = None


class UserPreferencesUpdate(BaseModel):
    """The preferences a person may change on their own account.

    Every field is optional, so the global email switch, one kind's channels and
    the timezone can each be changed without restating the others. `email_format`
    picks a digest or one email per notification. `timezone` is
    the IANA zone due date reminders are judged in, which the browser captures on
    sign in and the person can change. `pulse_digest` is how often the Pulse
    digest email comes, `off` by default. `home_view`, `week_start`,
    `name_display` and `font_size` are the interface preferences the account
    Preferences page sets, kept on the row so they follow the person to every
    device. `theme` is the interface theme and `pointer_cursors` whether
    interactive elements show the pointer cursor. `underline_links` underlines
    links in rich text at rest. `code_theme` is the syntax highlighting theme
    of code blocks. `convert_emoticons` is
    whether the editor turns typed emoticons into emoji. `activity_filter` is
    whether issue activity shows every change or only comments.
    `sidebar_items` moves the named sidebar items, leaving the others where
    they are, and `sidebar_badge_style` picks a count or a dot for the unread
    badges. `projects_display` replaces how the projects list is arranged as a
    whole, and null forgets the arrangement, so the page opens with the team's or
    the workspace's default again, and `initiatives_display` does the same for
    the initiatives list. `auto_assign_to_self`, `branch_copy_starts`
    and `branch_copy_assigns` are the Workflow group: assigning issues the person
    creates to them, and starting and assigning an issue when its git branch name
    is copied. `auto_grant_new_scopes` lets scopes the product adds later reach the
    connected apps that were given every scope. `priority_inbox` turns the
    split inbox on or off, and `priority_kinds` replaces the whole set of kinds
    its Priority tab holds. `notifications_paused_until` pauses email and
    desktop notifications until that moment, and null or a moment already past
    resumes them; it may be at most thirty days ahead. `working_hours` sets the
    weekly schedule they arrive in, and null clears it. `urgent_bypasses_pause`
    lets direct mentions and urgent assignments through both. Deliberately not a settings
    domain of its own: a few values on the row the product already owns are cheaper
    than a table and a second read on every notification.
    """

    email_notifications: Optional[bool] = None
    notification_preferences: Optional[dict[NotificationKind, NotificationChannelsUpdate]] = None
    priority_inbox: Optional[bool] = None
    priority_kinds: Optional[list[str]] = Field(default=None, max_length=len(INBOX_KINDS))
    email_format: Optional[EmailFormatField] = None
    notifications_paused_until: Optional[datetime] = None
    working_hours: Optional[WorkingHours] = None
    urgent_bypasses_pause: Optional[bool] = None
    timezone: Optional[str] = Field(default=None, min_length=1, max_length=64)
    pulse_digest: Optional[PulseDigestField] = None
    home_view: Optional[HomeViewField] = None
    week_start: Optional[WeekStartField] = None
    name_display: Optional[NameDisplayField] = None
    font_size: Optional[FontSizeField] = None
    theme: Optional[ThemeField] = None
    pointer_cursors: Optional[bool] = None
    underline_links: Optional[bool] = None
    code_theme: Optional[CodeThemeField] = None
    convert_emoticons: Optional[bool] = None
    activity_filter: Optional[ActivityFilterField] = None
    sidebar_items: Optional[dict[SidebarItemField, SidebarVisibilityField]] = None
    sidebar_badge_style: Optional[SidebarBadgeStyleField] = None
    projects_display: Optional[ProjectsDisplay] = None
    initiatives_display: Optional[InitiativesDisplay] = None
    auto_assign_to_self: Optional[bool] = None
    branch_copy_starts: Optional[bool] = None
    branch_copy_assigns: Optional[bool] = None
    auto_grant_new_scopes: Optional[bool] = None

    @field_validator("timezone")
    @classmethod
    def _known_zone(cls, value: Optional[str]) -> Optional[str]:
        """Refuse a name the zone database does not know."""
        if value is None:
            return None
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError(f"{value!r} is not a known IANA timezone") from exc
        return value

    @field_validator("notifications_paused_until")
    @classmethod
    def _bounded_pause(cls, value: Optional[datetime]) -> Optional[datetime]:
        """Read a moment without a zone as UTC, and refuse a pause longer than `PAUSE_MAX`."""
        if value is None:
            return None
        moment = value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
        if moment - datetime.now(timezone.utc) > PAUSE_MAX:
            raise ValueError("A pause may last at most 30 days")
        return moment

    @field_validator("priority_kinds")
    @classmethod
    def _known_kinds(cls, value: Optional[list[str]]) -> Optional[list[str]]:
        """Refuse a kind no inbox row can carry."""
        if value is None:
            return None
        unknown = sorted(set(value) - set(INBOX_KINDS))
        if unknown:
            raise ValueError(f"Unknown notification kind: {', '.join(unknown)}")
        return value


class UserProfileUpdate(BaseModel):
    """A change to the caller's name or handle; an omitted field keeps its value.

    `display_name` is the handle an `@mention` names the person by, so it takes the
    handle's shape. `full_name` is free text and may be cleared with an empty string.
    """

    full_name: Optional[str] = Field(default=None, max_length=120)
    display_name: Optional[str] = Field(default=None, min_length=1, max_length=39)

    @field_validator("full_name")
    @classmethod
    def _tidy_name(cls, value: Optional[str]) -> Optional[str]:
        """Collapse runs of whitespace, so a pasted name stores the way it reads."""
        return None if value is None else " ".join(value.split())

    @field_validator("display_name")
    @classmethod
    def _handle_shape(cls, value: Optional[str]) -> Optional[str]:
        """Refuse a handle the mention parser could not read back."""
        if value is None:
            return None
        candidate = value.strip()
        if not HANDLE_PATTERN.fullmatch(candidate):
            raise ValueError(HANDLE_RULE)
        return candidate


def _as_read(user: "Any") -> UserRead:
    """One stored user row in the response shape."""
    return UserRead(
        id=user.id,
        email=str(user.email),
        display_name=user.display_name,
        full_name=user.full_name,
        email_verified=user.email_verified,
        email_notifications=user.email_notifications,
        notification_preferences={
            kind: NotificationChannels(
                in_app=bool(user.notification_preferences.get(kind, {}).get("in_app", channel_default(kind, "in_app"))),
                email=bool(user.notification_preferences.get(kind, {}).get("email", channel_default(kind, "email"))),
                chat=bool(user.notification_preferences.get(kind, {}).get("chat", channel_default(kind, "chat"))),
            )
            for kind in NOTIFICATION_KINDS
        },
        priority_inbox=bool(user.priority_inbox),
        priority_kinds=[kind for kind in INBOX_KINDS if user.is_priority(kind)],
        email_format=_known(user.email_format, EMAIL_FORMATS, "digest"),
        notifications_paused_until=_running_pause(user.notifications_paused_until),
        working_hours=user.working_hours,
        urgent_bypasses_pause=bool(user.urgent_bypasses_pause),
        avatar_url=icon_url(user.icon_key),
        timezone=user.timezone,
        pulse_digest=user.pulse_digest if user.pulse_digest in PULSE_DIGESTS else "off",
        home_view=_known(user.home_view, HOME_VIEWS, "home"),
        week_start=_known(user.week_start, WEEK_STARTS, "monday"),
        name_display=_known(user.name_display, NAME_DISPLAYS, "username"),
        font_size=_known(user.font_size, FONT_SIZES, "default"),
        theme=user.theme if user.theme in THEMES else None,
        pointer_cursors=bool(user.pointer_cursors),
        underline_links=bool(user.underline_links),
        code_theme=_known(user.code_theme, CODE_THEMES, "app"),
        convert_emoticons=bool(user.convert_emoticons),
        activity_filter=_known(user.activity_filter, ACTIVITY_FILTERS, "all"),
        sidebar_items=_sidebar_read(user.sidebar_items),
        sidebar_badge_style=_known(user.sidebar_badge_style, SIDEBAR_BADGE_STYLES, "count"),
        projects_display=stored_projects_display(user.projects_display),
        projects_display_saved=bool(user.projects_display),
        initiatives_display=stored_initiatives_display(user.initiatives_display),
        initiatives_display_saved=bool(user.initiatives_display),
        auto_assign_to_self=bool(user.auto_assign_to_self),
        branch_copy_starts=bool(user.branch_copy_starts),
        branch_copy_assigns=bool(user.branch_copy_assigns),
        auto_grant_new_scopes=bool(user.auto_grant_new_scopes),
    )


def _running_pause(until: Optional[datetime]) -> Optional[datetime]:
    """The end of a pause that is still running, or `None` once it has passed."""
    if until is None:
        return None
    moment = until if until.tzinfo is not None else until.replace(tzinfo=timezone.utc)
    return moment if moment > datetime.now(timezone.utc) else None


def _known(value: str, allowed: tuple[str, ...], fallback: str) -> Any:
    """A stored choice when it is still one of `allowed`, else the default, so a retired value never fails a read."""
    return value if value in allowed else fallback


def _sidebar_read(stored: dict[str, str]) -> Any:
    """Every sidebar item with where it sits, `show` for one never moved or stored with a retired place."""
    return {item: _known(stored.get(item, "show"), SIDEBAR_VISIBILITIES, "show") for item in SIDEBAR_ITEMS}


def _summaries(rows: list[WorkspaceSummary]) -> list[WorkspaceSummaryRead]:
    """The plan's workspaces in the response shape."""
    return [
        WorkspaceSummaryRead(id=row.id, name=row.name, slug=row.slug, deletion_scheduled=row.deletion_scheduled)
        for row in rows
    ]


def _live_user(repos: Repositories, subject: str) -> User:
    """The caller's row, a 404 when it is gone, or a 401 once the account has been deleted.

    A deleted account is refused as unauthenticated, so a token issued before the
    deletion stops working at once rather than when it expires.
    """
    user = repos.users.get(subject)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NO_SUCH_USER)
    if user.is_deleted:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=ACCOUNT_DELETED)
    return user


def _plan_read(plan: AccountDeletionPlan) -> AccountDeletionPlanRead:
    """The plan in the response shape."""
    return AccountDeletionPlanRead(
        blocking=_summaries(plan.blocking),
        deleted_with_account=_summaries(plan.sole_member),
        leaving=_summaries(plan.leaving),
    )


def _merged_preferences(stored: dict[str, dict[str, bool]], changes: dict[Any, NotificationChannelsUpdate]) -> dict:
    """The stored per kind switches with a partial change applied, kept sparse.

    Only a switch that differs from its kind's default is kept, so the row stays
    small and a channel added later takes its default for everyone who never
    touched it.
    """
    merged = {kind: dict(channels) for kind, channels in stored.items()}
    for kind, update in changes.items():
        channels = merged.setdefault(str(kind), {})
        for channel, value in update.model_dump(exclude_none=True).items():
            if value == channel_default(str(kind), channel):
                channels.pop(channel, None)
            else:
                channels[channel] = value
    return {kind: channels for kind, channels in merged.items() if channels}


def _priority_overrides(kinds: list[str]) -> dict[str, bool]:
    """The sparse overrides that make the Priority tab hold exactly `kinds`.

    Only a kind that differs from `DEFAULT_PRIORITY_KINDS` is kept, so a kind added
    later still takes its default for everyone.
    """
    chosen = set(kinds)
    return {kind: kind in chosen for kind in INBOX_KINDS if (kind in chosen) != (kind in DEFAULT_PRIORITY_KINDS)}


def _merged_sidebar(stored: dict[str, str], changes: dict[Any, str]) -> dict[str, str]:
    """The stored sidebar placements with a partial change applied, kept sparse.

    Only an item moved off the sidebar is kept, and a stored item the sidebar no
    longer has is dropped, so the row holds just what differs from the default.
    """
    merged = {item: place for item, place in stored.items() if item in SIDEBAR_ITEMS}
    for item, place in changes.items():
        if place == "show":
            merged.pop(str(item), None)
        else:
            merged[str(item)] = place
    return merged


@router.get("/me", response_model=UserRead)
def read_current_user(
    request: Request,
    subject: str = Depends(caller_person),
    repos: Repositories = Depends(get_repositories),
) -> UserRead:
    """The account behind the presented token or personal API key.

    A personal key answers the person who minted it, which is how a command line
    client learns who `me` is. A workspace key has no person and is a 403. A
    verified token whose row is gone reads as 404 rather than 401, so the
    frontend keeps the session and shows its unavailable state instead of
    bouncing to login. A deleted account whose row the purge has not removed yet
    is a 401.

    `two_factor` repeats the session's own claim, so the account page and a
    workspace's authentication policy agree on whether this session has a second
    factor. A personal key carries no session claims and reads false.
    """
    read = _as_read(_live_user(repos, subject))
    read.two_factor = has_two_factor(identity_claims(request))
    return read


@router.patch("/me/preferences", response_model=UserRead, dependencies=[Depends(require_person)])
def update_current_user_preferences(
    payload: UserPreferencesUpdate,
    subject: str = Depends(caller_subject),
    repos: Repositories = Depends(get_repositories),
) -> UserRead:
    """Change the caller's own preferences.

    Separate from the identity package's own profile routes, which own the address
    and the credentials; this owns the product fields on the same row, which is the
    only part of it Standupless gets to define.
    """
    user = _live_user(repos, subject)
    changes: dict[str, Any] = {}
    if payload.email_notifications is not None:
        changes["email_notifications"] = payload.email_notifications
    if payload.notification_preferences:
        changes["notification_preferences"] = _merged_preferences(
            user.notification_preferences, dict(payload.notification_preferences)
        )
    if payload.priority_kinds is not None:
        overrides = _priority_overrides(payload.priority_kinds)
        if overrides != user.priority_kinds:
            changes["priority_kinds"] = overrides
    if payload.timezone is not None and payload.timezone != user.timezone:
        changes["timezone"] = payload.timezone
    if payload.pulse_digest is not None and payload.pulse_digest != user.pulse_digest:
        changes["pulse_digest"] = payload.pulse_digest
    if "notifications_paused_until" in payload.model_fields_set:
        pause = _running_pause(payload.notifications_paused_until)
        if pause != _running_pause(user.notifications_paused_until):
            changes["notifications_paused_until"] = pause.isoformat() if pause is not None else None
    if "working_hours" in payload.model_fields_set:
        hours = payload.working_hours.model_dump() if payload.working_hours is not None else None
        if hours != (user.working_hours.model_dump() if user.working_hours is not None else None):
            changes["working_hours"] = hours
    for field in (
        "email_format",
        "priority_inbox",
        "home_view",
        "week_start",
        "name_display",
        "font_size",
        "theme",
        "pointer_cursors",
        "underline_links",
        "code_theme",
        "convert_emoticons",
        "activity_filter",
        "sidebar_badge_style",
        "auto_assign_to_self",
        "branch_copy_starts",
        "branch_copy_assigns",
        "auto_grant_new_scopes",
        "urgent_bypasses_pause",
    ):
        value = getattr(payload, field)
        if value is not None and value != getattr(user, field):
            changes[field] = value
    if payload.sidebar_items:
        placed = _merged_sidebar(user.sidebar_items, dict(payload.sidebar_items))
        if placed != user.sidebar_items:
            changes["sidebar_items"] = placed
    if payload.projects_display is not None:
        display = payload.projects_display.model_dump()
        if display != user.projects_display:
            changes["projects_display"] = display
    elif "projects_display" in payload.model_fields_set and user.projects_display:
        changes["projects_display"] = {}
    if payload.initiatives_display is not None:
        arranged = payload.initiatives_display.model_dump()
        if arranged != user.initiatives_display:
            changes["initiatives_display"] = arranged
    elif "initiatives_display" in payload.model_fields_set and user.initiatives_display:
        changes["initiatives_display"] = {}
    if not changes:
        return _as_read(user)
    return _as_read(repos.users.update(subject, **changes))


@router.patch("/me/profile", response_model=UserRead, dependencies=[Depends(require_person)])
def update_current_user_profile(
    payload: UserProfileUpdate,
    subject: str = Depends(caller_subject),
    repos: Repositories = Depends(get_repositories),
) -> UserRead:
    """Change the caller's full name or handle.

    A new handle must be free in every workspace the caller belongs to, which is a
    409 `HANDLE_TAKEN` naming those workspaces otherwise. The handle given up is
    kept on the account, so mentions written under it keep resolving to the caller.
    Names are read from the row on every request, so the change shows everywhere
    without a new sign in.
    """
    user = _live_user(repos, subject)
    changes: dict[str, Any] = {}
    if payload.full_name is not None and payload.full_name != user.full_name:
        changes["full_name"] = payload.full_name
    if payload.display_name is not None and payload.display_name != user.display_name:
        renamed = normalise_handle(payload.display_name) != normalise_handle(user.display_name)
        if renamed:
            conflicts = handle_conflicts(repos, subject, payload.display_name)
            if conflicts:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail={
                        "error_code": "HANDLE_TAKEN",
                        "message": "Someone in your workspace already uses that name",
                        "details": {
                            "workspaces": [{"id": row.workspace_id, "name": row.workspace_name} for row in conflicts]
                        },
                    },
                )
            changes["previous_handles"] = previous_after_rename(user, payload.display_name)
        changes["display_name"] = payload.display_name
    if not changes:
        return _as_read(user)
    return _as_read(repos.users.update(subject, **changes))


@router.post(
    "/me/avatar/uploads",
    response_model=IconUploadRead,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_person)],
)
def create_avatar_upload(
    payload: IconUploadCreate,
    subject: str = Depends(caller_subject),
    repos: Repositories = Depends(get_repositories),
) -> IconUploadRead:
    """Sign a PUT for a new avatar image, which the commit call then makes current."""
    _live_user(repos, subject)
    return presign_icon(user_owner(subject), payload)


@router.put("/me/avatar", response_model=UserRead, dependencies=[Depends(require_person)])
def set_avatar(
    payload: IconCommit,
    subject: str = Depends(caller_subject),
    repos: Repositories = Depends(get_repositories),
) -> UserRead:
    """Make an uploaded image the caller's avatar and delete the one it replaces."""
    _live_user(repos, subject)
    owner = user_owner(subject)
    key = verify_upload(owner, payload.upload_id)
    user = repos.users.update(subject, icon_key=key)
    delete_icon_objects(owner.prefix, keep=key)
    return _as_read(user)


@router.delete("/me/avatar", response_model=UserRead, dependencies=[Depends(require_person)])
def clear_avatar(
    subject: str = Depends(caller_subject),
    repos: Repositories = Depends(get_repositories),
) -> UserRead:
    """Remove the caller's avatar, falling back to their initials, and delete the image."""
    user = _live_user(repos, subject)
    if user.icon_key is not None:
        user = repos.users.update(subject, icon_key=None)
    delete_icon_objects(user_owner(subject).prefix)
    return _as_read(user)


@router.get("/me/deletion-plan", response_model=AccountDeletionPlanRead, dependencies=[Depends(require_person)])
def read_account_deletion_plan(
    subject: str = Depends(caller_subject),
    repos: Repositories = Depends(get_repositories),
) -> AccountDeletionPlanRead:
    """What deleting the caller's account would do, shown before they confirm it."""
    _live_user(repos, subject)
    return _plan_read(plan_account_deletion(repos, subject))


@router.post("/me/deletion", status_code=status.HTTP_204_NO_CONTENT, dependencies=[Depends(require_person)])
def delete_account(
    payload: AccountDeletionRequest,
    request: Request,
    subject: str = Depends(caller_subject),
    repos: Repositories = Depends(get_repositories),
) -> Response:
    """Delete the caller's account now.

    A signed in person only, with their address typed out again, and refused with a
    409 naming each workspace where they are the only owner and other people remain.
    Once it passes, the account is marked deleted, so no sign in method or refresh
    works for it any more, then every session, OAuth grant and personal API key is
    revoked, the person's private agent profiles are removed, and the purge of
    its data is started at once. The hourly sweep and the
    queue's retries start any purge this request could not. The account's own
    address is mailed, and the request is logged with how the caller last
    authenticated. Repeating it for an account already deleted starts the purge again.
    """
    user = repos.users.get(subject)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NO_SUCH_USER)
    if user.is_deleted:
        agent_profiles.delete_for_user(repos, subject)
        _request_purge(subject)
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    if payload.confirm_email.strip().lower() != str(user.email).strip().lower():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=EMAIL_MISMATCH)
    plan = plan_account_deletion(repos, subject)
    if plan.blocking:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error_code": "SOLE_OWNER",
                "message": "Transfer ownership of these workspaces or delete them first",
                "details": {"workspaces": [row.model_dump() for row in _summaries(plan.blocking)]},
            },
        )
    deleted = repos.users.mark_deleted(subject)
    if deleted is None:
        agent_profiles.delete_for_user(repos, subject)
        _request_purge(subject)
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    revocation = revoke_account_access(repos, subject)
    agent_profiles.delete_for_user(repos, subject)
    purge_requested = _request_purge(subject)
    _log.info(
        "An account was deleted.",
        extra={
            "event": "account.deleted",
            "user_id": subject,
            "workspaces_deleted": len(plan.sole_member),
            "workspaces_left": len(plan.leaving),
            "refresh_records_revoked": revocation.refresh_records,
            "connected_apps_revoked": revocation.connected_apps,
            "api_keys_deleted": revocation.api_keys,
            "revoke_failed": list(revocation.failed),
            "purge_requested": purge_requested,
            **auth_strength_of(request).as_log(),
        },
    )
    deliver(
        render_account_deletion(to=str(deleted.email), workspaces_deleted=[row.name for row in plan.sole_member]),
        event="identity.account_deletion.email",
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _request_purge(user_id: str) -> bool:
    """Ask for the account's purge now, reporting whether the request went out.

    A failed send is logged rather than raised: the account is already deleted and
    signed out everywhere, and the hourly sweep starts the purge it missed.
    """
    try:
        return team_purge.request_account_purge(user_id)
    except Exception:
        _log.exception(
            "An account purge could not be requested, so the hourly sweep will start it.",
            extra={"event": "account.purge.request_failed", "user_id": user_id},
        )
        return False
