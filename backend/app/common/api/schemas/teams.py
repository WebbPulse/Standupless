"""Request and response schemas for the teams domain.

Every list body is an object with one plural key, matching the workspaces domain
and the contract. `next_issue_number` is never a field on any of these models: it
is an allocation detail and exposing it would leak how many issues exist.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Literal, Optional, Union

from pydantic import BaseModel, Field, StrictBool, field_validator, model_validator

from app.common.api.schemas.projects_display import ProjectsDisplay, stored_projects_display
from app.common.api.schemas.views import (
    VISIBLE_PROPERTIES,
    CompletedWindowField,
    GroupByField,
    LayoutField,
    SortField,
    VisiblePropertyField,
)
from app.common.db.dynamo.memberships import Membership
from app.common.db.dynamo.team_config import (
    MAX_SLA_HOURS,
    MAX_SLA_PAUSED_STATUSES,
    MAX_TRIAGE_RESPONSIBLE,
    MAX_TRIAGE_RULES,
    MAX_UPCOMING_CYCLES,
    ArchiveSettings,
    AutoCloseSettings,
    CycleSettings,
    DisplayOptions,
    Label,
    ParentAutoCloseSettings,
    SlaSettings,
    Status,
    TeamDisplayDefaults,
    TriageRule,
    TriageSettings,
    WorkspaceDisplayDefaults,
)
from app.common.db.dynamo.teams import Team, is_valid_key_prefix
from app.common.db.dynamo.users import User
from app.common.icons import icon_url
from app.common.status_appearance import StatusColor, StatusIcon, check_icon

EstimateScaleField = Literal["off", "exponential", "fibonacci", "linear", "tshirt"]

StatusCategoryField = Literal["backlog", "unstarted", "started", "completed", "cancelled"]

TeamRoleField = Literal["admin", "member"]

COLOR_PATTERN = re.compile(r"^#[0-9a-fA-F]{6}$")

LABEL_DESCRIPTION_MAX = 100
"""The longest label description, which is what GitHub accepts on a repository label."""


def _check_key_prefix(value: str) -> str:
    """Hold a key prefix to the contract's alphabet, uppercase only."""
    candidate = value.strip()
    if candidate != candidate.upper():
        raise ValueError("key_prefix must be uppercase")
    if not is_valid_key_prefix(candidate):
        raise ValueError("key_prefix must be 2 to 6 characters, starting with a letter, A to Z and 0 to 9")
    return candidate


class TeamCreate(BaseModel):
    """The body `POST /api/workspaces/{workspace_id}/teams` takes.

    `parent_team_id` creates the team as a sub-team of a top-level team, whose
    statuses and labels it inherits. `copy_settings_from_team_id` starts the team
    with a copy of another team's workflow, labels, templates and settings
    instead; a sub-team already inherits, so the two are exclusive.
    """

    name: str = Field(min_length=1, max_length=80)
    key_prefix: str = Field(min_length=2, max_length=6)
    description: Optional[str] = Field(default=None, max_length=2000)
    estimate_scale: EstimateScaleField = "off"
    estimate_extended: bool = False
    estimate_allow_zero: bool = False
    estimate_count_unestimated: bool = False
    private: bool = False
    parent_team_id: Optional[str] = Field(default=None, min_length=1)
    copy_settings_from_team_id: Optional[str] = Field(default=None, min_length=1)

    @field_validator("key_prefix")
    @classmethod
    def check_key_prefix(cls, value: str) -> str:
        """Hold the key prefix to the contract's alphabet.

        Validating here makes a bad prefix a 422 naming the field, so the only
        conflict the create route has to handle is a prefix already in use.
        """
        return _check_key_prefix(value)

    @field_validator("name")
    @classmethod
    def check_name(cls, value: str) -> str:
        """Reject a name that is only whitespace."""
        candidate = value.strip()
        if not candidate:
            raise ValueError("name must not be blank")
        return candidate

    @model_validator(mode="after")
    def check_copy_source(self) -> "TeamCreate":
        """Refuse copying settings onto a sub-team, which takes its parent's instead."""
        if self.copy_settings_from_team_id is not None and self.parent_team_id is not None:
            raise ValueError("copy_settings_from_team_id cannot be combined with parent_team_id")
        return self


class TeamUpdate(BaseModel):
    """The body a team patch takes.

    A new `key_prefix` retires the old one as an alias, so issue keys under the
    old prefix keep resolving and no other team can take it. `sync_pr_labels`
    turns off copying this team's issue labels onto linked pull requests.
    `private` hides the team and its issues from everyone who is not a member.
    `estimate_extended` adds the larger values to the scale, `estimate_allow_zero`
    adds 0, and `estimate_count_unestimated` counts an unestimated issue as one
    point in cycle and project progress instead of skipping it.
    `parent_team_id` puts the team under a top-level parent team, and an explicit
    null makes it a top-level team again.
    """

    name: Optional[str] = Field(default=None, min_length=1, max_length=80)
    key_prefix: Optional[str] = Field(default=None, min_length=2, max_length=6)
    estimate_scale: Optional[EstimateScaleField] = None
    estimate_extended: Optional[bool] = None
    estimate_allow_zero: Optional[bool] = None
    estimate_count_unestimated: Optional[bool] = None
    description: Optional[str] = Field(default=None, max_length=2000)
    sync_pr_labels: Optional[bool] = None
    private: Optional[bool] = None
    parent_team_id: Optional[str] = Field(default=None, min_length=1)

    @field_validator("key_prefix")
    @classmethod
    def check_key_prefix(cls, value: Optional[str]) -> Optional[str]:
        """Hold a new key prefix to the same alphabet create does."""
        if value is None:
            return None
        return _check_key_prefix(value)

    @field_validator("name")
    @classmethod
    def check_name(cls, value: Optional[str]) -> Optional[str]:
        """Reject a name that is only whitespace."""
        if value is None:
            return None
        candidate = value.strip()
        if not candidate:
            raise ValueError("name must not be blank")
        return candidate


class TeamRead(BaseModel):
    """One team as the API returns it, carrying the caller's team role.

    `parent_team_id` names the team this one sits under, `null` for a top-level team.
    """

    id: str
    workspace_id: str
    name: str
    key_prefix: str
    description: Optional[str] = None
    estimate_scale: str
    estimate_extended: bool = False
    estimate_allow_zero: bool = False
    estimate_count_unestimated: bool = False
    sync_pr_labels: bool = True
    private: bool = False
    icon_url: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    role: Optional[TeamRoleField] = None
    member_count: int = 0
    is_member: bool = False
    retired_key_prefixes: list[str] = Field(default_factory=list)
    parent_team_id: Optional[str] = None

    @classmethod
    def from_row(
        cls,
        team: Team,
        role: Optional[str] = None,
        *,
        member_count: int = 0,
        is_member: bool = False,
        retired_key_prefixes: Optional[list[str]] = None,
        private: bool = False,
    ) -> "TeamRead":
        """Build the response from a team row, the caller's role and membership counts.

        `member_count` and `is_member` count explicit team memberships, the rows
        join, leave and the members routes write. `private` comes from the
        authorization context, which already read the workspace's private set.
        """
        return cls(
            id=team.team_id,
            workspace_id=team.workspace_id,
            name=team.name,
            key_prefix=team.key_prefix,
            description=team.description,
            estimate_scale=team.estimate_scale,
            estimate_extended=team.estimate_extended,
            estimate_allow_zero=team.estimate_allow_zero,
            estimate_count_unestimated=team.estimate_count_unestimated,
            sync_pr_labels=team.sync_pr_labels,
            private=private,
            icon_url=icon_url(team.icon_key),
            created_at=team.created_at,
            updated_at=team.updated_at,
            role=role,  # pyright: ignore[reportArgumentType]
            member_count=member_count,
            is_member=is_member,
            retired_key_prefixes=retired_key_prefixes or [],
            parent_team_id=team.parent_team_id,
        )


class TeamListRead(BaseModel):
    """The body the teams list route answers with."""

    teams: list[TeamRead]


MAX_TEAM_ORDER = 500
"""The most team ids one saved sidebar order may name."""


class TeamOrderUpdate(BaseModel):
    """The body the team order put takes: the caller's teams, first to last.

    Teams left out keep their default place after the named ones, so a client
    that has not seen a new team yet cannot hide it.
    """

    team_ids: list[str] = Field(max_length=MAX_TEAM_ORDER)


class TeamMemberUpdate(BaseModel):
    """The body a team membership put takes."""

    role: TeamRoleField


class TeamMemberRead(BaseModel):
    """One team member, joined with their user row for display.

    `full_name` rides along with the handle so a reader who prefers full names
    sees them in the team's pickers too, the way the workspace member list does.
    """

    user_id: str
    email: str
    display_name: str
    full_name: str = ""
    avatar_url: Optional[str] = None
    role: TeamRoleField
    added_at: datetime

    @classmethod
    def from_rows(cls, membership: Membership, user: Optional[User]) -> "TeamMemberRead":
        """Build the response from a team membership and its user row."""
        return cls(
            user_id=membership.user_id,
            email=user.email if user is not None else "",
            display_name=display_name(user),
            full_name=user.full_name if user is not None else "",
            avatar_url=icon_url(user.icon_key) if user is not None else None,
            role=membership.role,  # pyright: ignore[reportArgumentType]
            added_at=membership.joined_at,
        )


class TeamMemberListRead(BaseModel):
    """The body the team members list route answers with."""

    members: list[TeamMemberRead]


class StatusCreate(BaseModel):
    """The body a status create takes.

    `color` and `icon` are optional, and a status without them renders from its
    category. The icon must be one of its category's variants.
    """

    name: str = Field(min_length=1, max_length=60)
    category: StatusCategoryField
    position: Optional[int] = Field(default=None, ge=0)
    color: Optional[StatusColor] = None
    icon: Optional[StatusIcon] = None

    @model_validator(mode="after")
    def check_icon_category(self) -> "StatusCreate":
        """Refuse an icon drawn for another category."""
        check_icon(self.category, self.icon)
        return self


class StatusUpdate(BaseModel):
    """The body a status patch takes.

    An explicit null `color` or `icon` clears it back to the category default. The
    icon is checked against the category in `team_workflow.update_status`, where
    the stored category is known when the patch does not name one.
    """

    name: Optional[str] = Field(default=None, min_length=1, max_length=60)
    category: Optional[StatusCategoryField] = None
    position: Optional[int] = Field(default=None, ge=0)
    color: Optional[StatusColor] = None
    icon: Optional[StatusIcon] = None


ConfigScope = Literal["team", "parent", "workspace"]


class StatusRead(BaseModel):
    """One workflow status as the API returns it, `null` color and icon meaning the default.

    `scope` says whether the team owns it or inherits it from its parent team or
    the workspace. An inherited status the team hid carries `hidden`, and one it
    renamed locally carries the inherited name in `inherited_name`.
    """

    id: str
    name: str
    category: StatusCategoryField
    position: int
    color: Optional[StatusColor] = None
    icon: Optional[StatusIcon] = None
    scope: ConfigScope = "team"
    hidden: bool = False
    inherited_name: Optional[str] = None

    @classmethod
    def from_row(cls, status: Status) -> "StatusRead":
        """Build the response shape from a stored status row."""
        return cls(
            id=status.status_id,
            name=status.name,
            category=status.category,  # pyright: ignore[reportArgumentType]
            position=status.position,
            color=status.color,  # pyright: ignore[reportArgumentType]
            icon=status.icon,  # pyright: ignore[reportArgumentType]
            scope=status.scope,  # pyright: ignore[reportArgumentType]
            hidden=status.hidden,
            inherited_name=status.inherited_name,
        )


class StatusListRead(BaseModel):
    """The body the statuses list route answers with, ordered by position."""

    statuses: list[StatusRead]


class LabelCreate(BaseModel):
    """The body a label create takes.

    `is_group` makes a label group, which holds child labels and is never put on
    an issue itself. `parent_id` puts the new label in an existing group of the
    same scope. A group cannot sit in another group. `description` is what a
    repository the team syncs with shows beside the label.
    """

    name: str = Field(min_length=1, max_length=60)
    color: str
    description: Optional[str] = Field(default=None, max_length=LABEL_DESCRIPTION_MAX)
    is_group: bool = False
    parent_id: Optional[str] = Field(default=None, min_length=1)

    @field_validator("color")
    @classmethod
    def check_color(cls, value: str) -> str:
        """Hold the colour to `#rrggbb`, lowercased so two spellings never differ."""
        candidate = value.strip().lower()
        if not COLOR_PATTERN.match(candidate):
            raise ValueError("color must be #rrggbb")
        return candidate


class LabelUpdate(BaseModel):
    """The body a label patch takes.

    `parent_id` moves a label into a group of the same scope, and an explicit
    null takes it out of its group, and an explicit null or empty `description`
    clears it. A field left out keeps its current value.
    """

    name: Optional[str] = Field(default=None, min_length=1, max_length=60)
    color: Optional[str] = None
    description: Optional[str] = Field(default=None, max_length=LABEL_DESCRIPTION_MAX)
    parent_id: Optional[str] = Field(default=None, min_length=1)

    @field_validator("color")
    @classmethod
    def check_color(cls, value: Optional[str]) -> Optional[str]:
        """Hold the colour to `#rrggbb` when one is being set."""
        if value is None:
            return None
        candidate = value.strip().lower()
        if not COLOR_PATTERN.match(candidate):
            raise ValueError("color must be #rrggbb")
        return candidate


class LabelRead(BaseModel):
    """One label as the API returns it, with the same `scope`, `hidden` and `inherited_name` a status carries.

    `is_group` marks a label group and `parent_id` names the group a label is in.
    """

    id: str
    name: str
    color: str
    description: Optional[str] = None
    scope: ConfigScope = "team"
    hidden: bool = False
    inherited_name: Optional[str] = None
    is_group: bool = False
    parent_id: Optional[str] = None

    @classmethod
    def from_row(cls, label: Label) -> "LabelRead":
        """Build the response shape from a stored label row."""
        return cls(
            id=label.label_id,
            name=label.name,
            color=label.color,
            description=label.description,
            scope=label.scope,  # pyright: ignore[reportArgumentType]
            hidden=label.hidden,
            inherited_name=label.inherited_name,
            is_group=label.is_group,
            parent_id=label.parent_id,
        )


class LabelListRead(BaseModel):
    """The body the labels list route answers with."""

    labels: list[LabelRead]


class LabelMerge(BaseModel):
    """The body a label merge takes: the label of the same scope the merged label folds into."""

    target_label_id: str = Field(min_length=1)


class LabelMergeRead(BaseModel):
    """What a label merge did, so far or in full.

    `complete` is false when a large merge ran out of time for one request: the
    issues moved so far keep the target label, and calling the merge again with
    the same target picks up where it stopped. A merge already finished answers
    its result again, so a retry is safe.
    """

    source_label_id: str
    source_name: str
    target: LabelRead
    issues_updated: int = 0
    views_updated: int = 0
    templates_updated: int = 0
    complete: bool = True


class OverrideUpdate(BaseModel):
    """The body a team's override of a workspace status or label takes.

    `hidden` hides or shows it in the team. `name` renames it in the team only,
    and an explicit null clears the rename back to the workspace name. A field
    left out keeps its current value.
    """

    hidden: Optional[bool] = None
    name: Optional[str] = Field(default=None, min_length=1, max_length=60)


class CycleSettingsUpdate(BaseModel):
    """The body a team's cycle settings patch takes, every field optional.

    `start_weekday` counts from Monday as 0 to Sunday as 6.
    """

    enabled: Optional[bool] = None
    duration_weeks: Optional[int] = Field(default=None, ge=1, le=8)
    cooldown_weeks: Optional[int] = Field(default=None, ge=0, le=2)
    start_weekday: Optional[int] = Field(default=None, ge=0, le=6)
    upcoming_count: Optional[int] = Field(default=None, ge=1, le=MAX_UPCOMING_CYCLES)
    auto_add_started: Optional[bool] = None
    auto_add_completed: Optional[bool] = None
    move_unfinished: Optional[bool] = None


class CycleSettingsRead(BaseModel):
    """A team's automatic cycle settings as the API returns them."""

    team_id: str
    enabled: bool
    duration_weeks: int
    cooldown_weeks: int
    start_weekday: int
    upcoming_count: int
    auto_add_started: bool
    auto_add_completed: bool
    move_unfinished: bool
    updated_at: Optional[datetime] = None

    @classmethod
    def from_row(cls, settings: CycleSettings) -> "CycleSettingsRead":
        """Build the response from a stored or default settings row."""
        return cls(
            team_id=settings.team_id,
            enabled=settings.enabled,
            duration_weeks=settings.duration_weeks,
            cooldown_weeks=settings.cooldown_weeks,
            start_weekday=settings.start_weekday,
            upcoming_count=settings.upcoming_count,
            auto_add_started=settings.auto_add_started,
            auto_add_completed=settings.auto_add_completed,
            move_unfinished=settings.move_unfinished,
            updated_at=settings.updated_at,
        )


AutoClosePeriodField = Literal[1, 3, 6, 9, 12]


class AutoCloseSettingsUpdate(BaseModel):
    """The body a team's auto-close settings patch takes.

    `period_months` is how long a backlog or triage issue may go without an
    update before it is closed, null turning auto-close off. `status_id` is the
    cancelled status it moves to, null meaning the team's first one.
    """

    period_months: Optional[AutoClosePeriodField] = None
    status_id: Optional[str] = Field(default=None, min_length=1, max_length=64)


class AutoCloseSettingsRead(BaseModel):
    """A team's auto-close setting as the API returns it."""

    team_id: str
    enabled: bool
    period_months: Optional[int] = None
    status_id: Optional[str] = None
    updated_at: Optional[datetime] = None

    @classmethod
    def from_row(cls, settings: AutoCloseSettings) -> "AutoCloseSettingsRead":
        """Build the response from a stored or default settings row."""
        return cls(
            team_id=settings.team_id,
            enabled=settings.period_months is not None,
            period_months=settings.period_months,
            status_id=settings.status_id,
            updated_at=settings.updated_at,
        )


class ParentAutoCloseSettingsUpdate(BaseModel):
    """The body a team's parent and sub-issue auto-close settings patch takes, each field optional.

    `close_parent` closes a parent once every sub-issue is completed or
    cancelled, and `close_sub_issues` closes a parent's open sub-issues once the
    parent is completed or cancelled.
    """

    close_parent: Optional[bool] = None
    close_sub_issues: Optional[bool] = None


class ParentAutoCloseSettingsRead(BaseModel):
    """A team's parent and sub-issue auto-close settings as the API returns them."""

    team_id: str
    close_parent: bool
    close_sub_issues: bool
    updated_at: Optional[datetime] = None

    @classmethod
    def from_row(cls, settings: ParentAutoCloseSettings) -> "ParentAutoCloseSettingsRead":
        """Build the response from a stored or default settings row."""
        return cls(
            team_id=settings.team_id,
            close_parent=settings.close_parent,
            close_sub_issues=settings.close_sub_issues,
            updated_at=settings.updated_at,
        )


ArchivePeriodField = Literal[1, 3, 6, 9, 12]


class ArchiveSettingsUpdate(BaseModel):
    """The body a team's auto-archive settings patch takes.

    `period_months` is how long after an issue was completed or cancelled it is
    archived, one of Linear's own choices.
    """

    period_months: Optional[ArchivePeriodField] = None


class ArchiveSettingsRead(BaseModel):
    """A team's auto-archive setting as the API returns it."""

    team_id: str
    period_months: int
    updated_at: Optional[datetime] = None

    @classmethod
    def from_row(cls, settings: ArchiveSettings) -> "ArchiveSettingsRead":
        """Build the response from a stored or default settings row."""
        return cls(team_id=settings.team_id, period_months=settings.period_months, updated_at=settings.updated_at)


SlaHoursField = Optional[int]


class SlaSettingsUpdate(BaseModel):
    """The body a team's SLA settings patch takes.

    Each `*_hours` is how long an issue of that priority may stay open before it
    breaches, from one hour to ninety days; `null` removes that priority's rule.
    `paused_status_ids` replaces the set of open statuses whose time does not
    count toward a breach; `null` or an empty list pauses in none.
    """

    enabled: Optional[StrictBool] = None
    urgent_hours: SlaHoursField = Field(default=None, ge=1, le=MAX_SLA_HOURS)
    high_hours: SlaHoursField = Field(default=None, ge=1, le=MAX_SLA_HOURS)
    medium_hours: SlaHoursField = Field(default=None, ge=1, le=MAX_SLA_HOURS)
    low_hours: SlaHoursField = Field(default=None, ge=1, le=MAX_SLA_HOURS)
    paused_status_ids: Optional[list[str]] = Field(default=None, max_length=MAX_SLA_PAUSED_STATUSES)


class SlaSettingsRead(BaseModel):
    """A team's SLA rules as the API returns them."""

    team_id: str
    enabled: bool
    urgent_hours: Optional[int] = None
    high_hours: Optional[int] = None
    medium_hours: Optional[int] = None
    low_hours: Optional[int] = None
    paused_status_ids: list[str] = Field(default_factory=list)
    updated_at: Optional[datetime] = None

    @classmethod
    def from_row(cls, settings: SlaSettings) -> "SlaSettingsRead":
        """Build the response from a stored or default settings row."""
        return cls(
            team_id=settings.team_id,
            enabled=settings.enabled,
            urgent_hours=settings.urgent_hours,
            high_hours=settings.high_hours,
            medium_hours=settings.medium_hours,
            low_hours=settings.low_hours,
            paused_status_ids=list(settings.paused_status_ids),
            updated_at=settings.updated_at,
        )


TriageActionField = Literal["notify", "assign"]

TriageRuleSourceField = Literal["web", "form", "mcp", "cli", "api", "github", "system"]
"""Where an issue came from, as a triage rule filters on it."""

TriagePriorityField = Literal["none", "urgent", "high", "medium", "low"]
"""A priority a triage rule filters on."""

TriageSetPriorityField = Literal["urgent", "high", "medium", "low"]
"""A priority a triage rule sets."""

MAX_TRIAGE_RULE_VALUES = 50
"""The most values one triage rule filter or action list may hold."""


def _distinct(value: list[str]) -> list[str]:
    """Drop blank and repeated ids, keeping the first place each one held."""
    return list(dict.fromkeys(item.strip() for item in value if item.strip()))


class TriageRuleFilterBody(BaseModel):
    """What an issue entering triage must match; every field given must hold, an empty filter matches all."""

    label_ids: list[str] = Field(default_factory=list, max_length=MAX_TRIAGE_RULE_VALUES)
    priorities: list[TriagePriorityField] = Field(default_factory=list)
    creator_ids: list[str] = Field(default_factory=list, max_length=MAX_TRIAGE_RULE_VALUES)
    sources: list[TriageRuleSourceField] = Field(default_factory=list)
    text: Optional[str] = Field(default=None, max_length=200)

    @field_validator("label_ids", "creator_ids")
    @classmethod
    def dedupe_ids(cls, value: list[str]) -> list[str]:
        """Drop blank and repeated ids."""
        return _distinct(value)

    @field_validator("priorities", "sources")
    @classmethod
    def dedupe_values(cls, value: list[str]) -> list[str]:
        """Drop repeated values."""
        return list(dict.fromkeys(value))

    @field_validator("text")
    @classmethod
    def blank_text(cls, value: Optional[str]) -> Optional[str]:
        """Read blank text as no text filter."""
        return value.strip() or None if value is not None else None


class TriageRuleActionsRead(BaseModel):
    """What a matching rule does; `team_id` moves the issue to that team."""

    add_label_ids: list[str] = Field(default_factory=list)
    priority: Optional[TriageSetPriorityField] = None
    assignee_id: Optional[str] = None
    project_id: Optional[str] = None
    team_id: Optional[str] = None


class TriageRuleActionsBody(BaseModel):
    """What a matching rule does; at least one action must be set, and `team_id` moves the issue."""

    add_label_ids: list[str] = Field(default_factory=list, max_length=MAX_TRIAGE_RULE_VALUES)
    priority: Optional[TriageSetPriorityField] = None
    assignee_id: Optional[str] = None
    project_id: Optional[str] = None
    team_id: Optional[str] = None

    @field_validator("add_label_ids")
    @classmethod
    def dedupe_labels(cls, value: list[str]) -> list[str]:
        """Drop blank and repeated ids."""
        return _distinct(value)

    @field_validator("assignee_id", "project_id", "team_id")
    @classmethod
    def blank_id(cls, value: Optional[str]) -> Optional[str]:
        """Read a blank id as unset."""
        return value.strip() or None if value is not None else None

    @model_validator(mode="after")
    def one_action(self) -> "TriageRuleActionsBody":
        """A rule must do something."""
        if not (self.add_label_ids or self.priority or self.assignee_id or self.project_id or self.team_id):
            raise ValueError("a triage rule needs at least one action")
        return self


class TriageRuleBody(BaseModel):
    """One triage rule as a settings patch sends it; a rule without `rule_id` is new."""

    rule_id: Optional[str] = None
    name: str = Field(min_length=1, max_length=80)
    enabled: StrictBool = True
    continue_after: StrictBool = False
    filter: TriageRuleFilterBody = Field(default_factory=TriageRuleFilterBody)
    actions: TriageRuleActionsBody

    @field_validator("name")
    @classmethod
    def trim_name(cls, value: str) -> str:
        """Trim the name and refuse one that is only whitespace."""
        trimmed = value.strip()
        if not trimmed:
            raise ValueError("a triage rule needs a name")
        return trimmed


class TriageRuleRead(BaseModel):
    """One triage rule as the API returns it; `warning` says why a broken rule is off."""

    rule_id: str
    name: str
    enabled: bool
    continue_after: bool
    filter: TriageRuleFilterBody
    actions: TriageRuleActionsRead
    warning: Optional[str] = None

    @classmethod
    def from_rule(cls, rule: TriageRule, warning: Optional[str] = None) -> "TriageRuleRead":
        """Build the response from a stored rule and the warning its targets raise, if any."""
        return cls(
            rule_id=rule.rule_id,
            name=rule.name,
            enabled=rule.enabled and warning is None,
            continue_after=rule.continue_after,
            filter=TriageRuleFilterBody.model_validate(rule.filter.model_dump()),
            actions=TriageRuleActionsRead.model_validate(rule.actions.model_dump()),
            warning=warning,
        )


class TriageSettingsUpdate(BaseModel):
    """The body a team's triage settings patch takes; only the fields sent change.

    `responsible_user_ids` names the team members on triage duty, deduplicated in
    the order given, and an empty list takes everyone off it.
    """

    enabled: Optional[StrictBool] = None
    responsible_user_ids: Optional[list[str]] = Field(default=None, max_length=MAX_TRIAGE_RESPONSIBLE)
    responsibility_action: Optional[TriageActionField] = None
    require_priority: Optional[StrictBool] = None
    rules: Optional[list[TriageRuleBody]] = Field(default=None, max_length=MAX_TRIAGE_RULES)

    @field_validator("responsible_user_ids")
    @classmethod
    def dedupe_responsible(cls, value: Optional[list[str]]) -> Optional[list[str]]:
        """Drop blank and repeated ids, keeping the first place each one held."""
        if value is None:
            return None
        return list(dict.fromkeys(item.strip() for item in value if item.strip()))


class TriageSettingsRead(BaseModel):
    """A team's triage settings as the API returns them."""

    team_id: str
    enabled: bool
    responsible_user_ids: list[str] = Field(default_factory=list)
    responsibility_action: TriageActionField = "notify"
    require_priority: bool = False
    rules: list[TriageRuleRead] = Field(default_factory=list)
    updated_at: Optional[datetime] = None

    @classmethod
    def from_row(cls, settings: TriageSettings, warnings: Optional[dict[str, str]] = None) -> "TriageSettingsRead":
        """Build the response from a stored or default settings row and its rules' warnings."""
        found = warnings or {}
        return cls(
            team_id=settings.team_id,
            enabled=settings.enabled,
            responsible_user_ids=list(settings.responsible_user_ids),
            responsibility_action=settings.responsibility_action,
            require_priority=settings.require_priority,
            rules=[TriageRuleRead.from_rule(rule, found.get(rule.rule_id)) for rule in settings.rules],
            updated_at=settings.updated_at,
        )


DisplayGroupField = Union[GroupByField, Literal["none"]]
"""A grouping a team default may hold: any a view groups by, or `none` for no grouping."""


class DisplayOptionsBody(BaseModel):
    """The display options one team page opens with, each null where the page keeps its built-in default.

    Held to the saved view's own choices, so a team default is always one a view
    could save: a sub grouping needs a grouping and must differ from it. Either
    grouping may be `none`, which a page reads as no grouping rather than as its
    built-in one.
    """

    layout: Optional[LayoutField] = None
    group_by: Optional[DisplayGroupField] = None
    sub_group_by: Optional[DisplayGroupField] = None
    ordering: Optional[SortField] = None
    ordering_reversed: Optional[StrictBool] = None
    visible_properties: Optional[list[VisiblePropertyField]] = Field(default=None, max_length=len(VISIBLE_PROPERTIES))
    show_sub_issues: Optional[StrictBool] = None
    completed_window: Optional[CompletedWindowField] = None
    show_empty_groups: Optional[StrictBool] = None
    show_archived: Optional[StrictBool] = None

    @field_validator("visible_properties")
    @classmethod
    def _unique_properties(cls, value: Optional[list[str]]) -> Optional[list[str]]:
        """Drop repeats, keeping the order the admin chose to show them in."""
        return list(dict.fromkeys(value)) if value is not None else None

    @model_validator(mode="after")
    def _sub_group_needs_group(self) -> "DisplayOptionsBody":
        """Refuse a sub grouping with no grouping, or one repeating the grouping."""
        if self.sub_group_by is not None and self.sub_group_by != "none":
            if self.group_by is None or self.group_by == "none":
                raise ValueError("sub_group_by needs group_by")
            if self.sub_group_by == self.group_by:
                raise ValueError("sub_group_by must differ from group_by")
        return self

    def as_row(self) -> DisplayOptions:
        """The stored shape of these options."""
        return DisplayOptions.model_validate(self.model_dump())

    @classmethod
    def from_row(cls, options: Optional[DisplayOptions]) -> Optional["DisplayOptionsBody"]:
        """The response shape of stored options, or `None` when the page keeps its built-in default."""
        if options is None:
            return None
        return cls.model_validate(options.model_dump())


class TeamDisplayDefaultsUpdate(BaseModel):
    """The body a team's display defaults patch takes.

    `list_display` sets what the team's issue list opens with, `board_display`
    what its board opens with and `projects_display` how the team's projects
    page is arranged. A page left out keeps its saved default, and null clears
    it back to the built-in one, or for projects to the workspace default. Each
    page's options are replaced whole.
    """

    list_display: Optional[DisplayOptionsBody] = None
    board_display: Optional[DisplayOptionsBody] = None
    projects_display: Optional[ProjectsDisplay] = None


def _stored_or_none(stored: Optional[dict[str, str]]) -> Optional[ProjectsDisplay]:
    """A stored projects default read the way a person's arrangement is, or `None` when none was saved."""
    return None if stored is None else stored_projects_display(stored)


class TeamDisplayDefaultsRead(BaseModel):
    """A team's display defaults as the API returns them, null for a page on its built-in default.

    `projects_display` is the team's own projects default, null when it set none.
    `effective_projects_display` is what a member who never arranged the projects
    page opens it with on this team: the team default, else the workspace
    default, else the built-in arrangement.
    """

    team_id: str
    list_display: Optional[DisplayOptionsBody] = None
    board_display: Optional[DisplayOptionsBody] = None
    projects_display: Optional[ProjectsDisplay] = None
    effective_projects_display: ProjectsDisplay = Field(default_factory=ProjectsDisplay)
    updated_by: Optional[str] = None
    updated_at: Optional[datetime] = None

    @classmethod
    def from_row(
        cls, defaults: TeamDisplayDefaults, workspace: Optional[WorkspaceDisplayDefaults] = None
    ) -> "TeamDisplayDefaultsRead":
        """Build the response from a stored or default row and the workspace default it falls back to."""
        own = _stored_or_none(defaults.projects_display)
        inherited = _stored_or_none(workspace.projects_display if workspace is not None else None)
        return cls(
            team_id=defaults.team_id,
            list_display=DisplayOptionsBody.from_row(defaults.list_display),
            board_display=DisplayOptionsBody.from_row(defaults.board_display),
            projects_display=own,
            effective_projects_display=own or inherited or ProjectsDisplay(),
            updated_by=defaults.updated_by,
            updated_at=defaults.updated_at,
        )


class WorkspaceDisplayDefaultsUpdate(BaseModel):
    """The body the workspace display defaults patch takes.

    `projects_display` replaces how the projects page is arranged for every
    member who never arranged it and whose team set no default, and null clears
    it back to the built-in arrangement. Left out, it keeps its saved default.
    """

    projects_display: Optional[ProjectsDisplay] = None


class WorkspaceDisplayDefaultsRead(BaseModel):
    """The workspace display defaults as the API returns them.

    `projects_display` is null when no admin saved one, and
    `effective_projects_display` is what the workspace projects page opens with
    for a member who never arranged it.
    """

    projects_display: Optional[ProjectsDisplay] = None
    effective_projects_display: ProjectsDisplay = Field(default_factory=ProjectsDisplay)
    updated_by: Optional[str] = None
    updated_at: Optional[datetime] = None

    @classmethod
    def from_row(cls, defaults: WorkspaceDisplayDefaults) -> "WorkspaceDisplayDefaultsRead":
        """Build the response from a stored or default row."""
        own = _stored_or_none(defaults.projects_display)
        return cls(
            projects_display=own,
            effective_projects_display=own or ProjectsDisplay(),
            updated_by=defaults.updated_by,
            updated_at=defaults.updated_at,
        )


def display_name(user: Optional[User]) -> str:
    """A renderable name for a user row, falling back to the email local part."""
    if user is None:
        return ""
    name = user.display_name.strip()
    if name:
        return name
    return user.email.partition("@")[0]
