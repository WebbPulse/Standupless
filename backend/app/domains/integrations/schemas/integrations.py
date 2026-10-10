"""Request and response bodies for the integrations routes.

The secret on a webhook endpoint is the one field that behaves differently from
everything else in the product: it is returned in full exactly once, by the call
that mints it, and never again. `WebhookEndpointRead` therefore carries an optional
`secret`, left unset on every read, rather than there being a second model whose
only difference is that field and which could drift from this one.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.common.db.dynamo.team_config import TRIGGERS

RESOURCE_TYPE = Literal["issues", "comments", "projects", "project_updates", "cycles", "labels"]
"""The kinds of change a webhook may subscribe to, named as the settings page shows them."""


def _require_https(value: str) -> str:
    """Refuse anything but https for a delivery endpoint.

    A signed payload sent in clear text is still readable by anyone on the path, and
    the signature only proves who sent it, so plain http is refused rather than
    warned about. Where the URL points is checked separately by the SSRF guard,
    because that needs DNS and a validator should not.
    """
    if not value.strip().lower().startswith("https://"):
        raise ValueError("The endpoint url must be https.")
    return value.strip()


def _require_resource_types(value: list[RESOURCE_TYPE]) -> list[RESOURCE_TYPE]:
    """Refuse an empty subscription, which would look configured and never deliver."""
    if not value:
        raise ValueError("At least one resource type is required.")
    return sorted(set(value))


def _clean_label(value: str) -> str:
    """A label trimmed of surrounding space and required to say something."""
    cleaned = value.strip()
    if not cleaned:
        raise ValueError("A label is required.")
    return cleaned


class InstallUrlRead(BaseModel):
    """Where to send a workspace admin to install the GitHub App."""

    url: str
    expires_at: datetime


class RepositoryRead(BaseModel):
    """One repository the installation can see."""

    repository_id: str
    full_name: str
    name: str
    private: bool
    default_branch: str
    team_id: str | None = None
    linked_at: datetime


class InstallationRead(BaseModel):
    """The GitHub App installation a workspace has, if any."""

    installation_id: str
    account_login: str
    account_type: str
    repository_selection: str
    html_url: str
    manage_url: str = ""
    avatar_url: str = ""
    suspended: bool = False
    installed_by: str
    installed_at: datetime
    repository_count: int


class RepositoryLinkWrite(BaseModel):
    """Point one repository at one team, or clear it."""

    team_id: str | None = None


ReviewState = Literal["none", "pending", "approved", "changes_requested"]

CiState = Literal["none", "pending", "success", "failure"]


class StackRead(BaseModel):
    """Where one pull request sits in a stack of the issue's pull requests.

    `position` counts from the bottom of the stack, the pull request based on the
    trunk, and `size` is how many of the issue's pull requests the stack holds. The
    `pr_state`, `review_state` and `ci_state` fields describe the whole stack, so a
    list that shows a stack as one row reads them from any entry. Review and checks
    count only the entries still open.
    """

    stack_id: str
    position: int
    size: int
    pr_state: Literal["open", "draft", "merged", "closed"]
    review_state: ReviewState
    ci_state: CiState


class IssueLinkRead(BaseModel):
    """One pull request linked to one issue.

    `review_state` is the review decision and `ci_state` the combined result of the
    head commit's checks, both `none` until GitHub reports one. `stack` is set when
    the pull request is stacked with another of the issue's pull requests.
    """

    link_id: str
    issue_id: str
    issue_key: str
    repository_full_name: str
    pr_number: int
    pr_title: str
    pr_url: str
    pr_state: Literal["open", "draft", "merged", "closed"]
    author_login: str
    closes_issue: bool
    applied_status_id: str | None = None
    head_ref: str = ""
    base_ref: str = ""
    review_state: ReviewState = "none"
    ci_state: CiState = "none"
    stack: StackRead | None = None
    linked_at: datetime
    updated_at: datetime


class WebhookEndpointRead(BaseModel):
    """One outbound webhook.

    `secret` is populated only by the create and rotate calls. `secret_hint` is the
    last four characters, which is enough for a person to tell two webhooks apart
    without the value being recoverable from it. `team_id` is null for a webhook
    that covers every team in the workspace. `disabled_reason` is set when repeated
    failures turned the webhook off, which is the notice the settings page shows.
    """

    webhook_id: str
    url: str
    label: str
    team_id: str | None = None
    resource_types: list[str]
    enabled: bool
    secret_hint: str
    created_by: str
    created_at: datetime
    updated_at: datetime
    last_status: int | None = None
    last_delivery_at: datetime | None = None
    consecutive_failures: int = 0
    disabled_reason: str | None = None
    disabled_at: datetime | None = None
    secret: str | None = None


class WebhookEndpointCreate(BaseModel):
    """Register a webhook to deliver to.

    `team_id` scopes it to one team; left out on the workspace route it covers every
    team, and on a team route the path decides it.
    """

    model_config = ConfigDict(extra="forbid")

    url: str = Field(min_length=1, max_length=2048)
    label: str = Field(min_length=1, max_length=80)
    resource_types: list[RESOURCE_TYPE] = Field(min_length=1)
    enabled: bool = True
    team_id: str | None = None

    @field_validator("url")
    @classmethod
    def _check_url(cls, value: str) -> str:
        """Hold the https rule on create."""
        return _require_https(value)

    @field_validator("label")
    @classmethod
    def _check_label(cls, value: str) -> str:
        """Hold the non-blank label rule on create."""
        return _clean_label(value)

    @field_validator("resource_types")
    @classmethod
    def _check_resource_types(cls, value: list[RESOURCE_TYPE]) -> list[RESOURCE_TYPE]:
        """Deduplicate and order the subscription."""
        return _require_resource_types(value)


class WebhookEndpointUpdate(BaseModel):
    """Change a webhook, leaving unset fields alone.

    Turning `enabled` back on also clears a failure run and any auto-disable notice,
    since re-enabling is the admin saying the receiver is fixed.
    """

    model_config = ConfigDict(extra="forbid")

    url: str | None = Field(default=None, min_length=1, max_length=2048)
    label: str | None = Field(default=None, min_length=1, max_length=80)
    resource_types: list[RESOURCE_TYPE] | None = Field(default=None, min_length=1)
    enabled: bool | None = None
    team_id: str | None = None

    @field_validator("url")
    @classmethod
    def _check_url(cls, value: str | None) -> str | None:
        """Hold the https rule on the fields an update actually sets."""
        return None if value is None else _require_https(value)

    @field_validator("label")
    @classmethod
    def _check_label(cls, value: str | None) -> str | None:
        """Hold the non-blank label rule on the fields an update actually sets."""
        return None if value is None else _clean_label(value)

    @field_validator("resource_types")
    @classmethod
    def _check_resource_types(cls, value: list[RESOURCE_TYPE] | None) -> list[RESOURCE_TYPE] | None:
        """Hold the subscription rule on the fields an update actually sets."""
        return None if value is None else _require_resource_types(value)


class DeliveryAttemptRead(BaseModel):
    """One try at posting a delivery: what came back and how long it took.

    `status_code` is 0 when no HTTP response arrived, in which case `error` says why.
    """

    attempt: int
    at: datetime
    status_code: int
    latency_ms: int
    error: str | None = None
    response_body: str = ""


class WebhookDeliveryRead(BaseModel):
    """One entry in a webhook's delivery log.

    `request_body` is the JSON that was sent, cut to a preview when long, with
    `request_truncated` saying so. `next_attempt_at` is set while a retry is queued.
    """

    delivery_id: str
    webhook_id: str
    event_type: str
    action: str
    state: Literal["pending", "retrying", "delivered", "failed"]
    is_test: bool
    redelivery_of: str | None = None
    created_at: datetime
    updated_at: datetime
    next_attempt_at: datetime | None = None
    attempts: list[DeliveryAttemptRead]
    request_body: str
    request_truncated: bool


class TransitionRead(BaseModel):
    """One rule moving an issue when a pull request event happens.

    `is_default` says the rule is not stored but computed from the design defaults,
    so the frontend can show it as inherited rather than as something a person set.
    `branch_pattern` is the glob the pull request's target branch must match, or
    `None` for a rule that holds on any branch.
    """

    transition_id: str
    team_id: str
    trigger: str
    status_id: str | None
    branch_pattern: str | None = None
    is_default: bool = False


def _branch_pattern(value: str | None) -> str | None:
    """A submitted branch pattern normalized, `None` meaning any branch."""
    from app.domains.integrations.linking import normalize_branch_pattern

    return normalize_branch_pattern(value) or None


class TransitionCreate(BaseModel):
    """Add a rule for a trigger and target branch pattern that has none."""

    model_config = ConfigDict(extra="forbid")

    trigger: str
    status_id: str | None = None
    branch_pattern: str | None = None

    @field_validator("trigger")
    @classmethod
    def _known_trigger(cls, value: str) -> str:
        """Refuse a trigger no pull request event can fire."""
        if value not in TRIGGERS:
            raise ValueError(f"Unknown trigger. Expected one of: {', '.join(TRIGGERS)}.")
        return value

    @field_validator("branch_pattern")
    @classmethod
    def _valid_pattern(cls, value: str | None) -> str | None:
        """Normalize the pattern, refusing one no git branch could match."""
        return _branch_pattern(value)


class TransitionUpdate(BaseModel):
    """Repoint a rule at another status or none, or change the branch it holds on."""

    model_config = ConfigDict(extra="forbid")

    status_id: str | None = None
    branch_pattern: str | None = None

    @field_validator("branch_pattern")
    @classmethod
    def _valid_pattern(cls, value: str | None) -> str | None:
        """Normalize the pattern, refusing one no git branch could match."""
        return _branch_pattern(value)


class TransitionSet(BaseModel):
    """A team's whole rule set, replacing whatever it had; empty restores the defaults."""

    model_config = ConfigDict(extra="forbid")

    rules: list[TransitionCreate] = Field(default_factory=list, max_length=50)


class TeamSyncRead(BaseModel):
    """How one team's issues sync with one GitHub repository.

    `two_way` carries changes both ways, `github_to_standupless` only imports and
    follows GitHub, and `enabled` pauses both without forgetting the link. A
    public repository syncs one way unless `allow_public_two_way` is on, which
    publishes the team's issues on GitHub; `repository_private` says which applies,
    and `public_demoted_at` is when a two way link was dropped to one way because
    its repository turned public.
    """

    team_id: str
    repository_id: str
    full_name: str
    direction: Literal["two_way", "github_to_standupless"]
    enabled: bool
    sync_labels: bool
    allow_public_two_way: bool = False
    repository_private: bool = True
    public_demoted_at: datetime | None = None
    created_by: str
    created_at: datetime
    updated_at: datetime


class TeamSyncWrite(BaseModel):
    """Link a team to one repository, or change how it syncs.

    `allow_public_two_way` lets `two_way` hold on a public repository, writing the
    team's issues to it in public, and keeps a repository that turns public from
    dropping the link to one way. It is off by default.
    """

    model_config = ConfigDict(extra="forbid")

    repository_id: str = Field(min_length=1)
    direction: Literal["two_way", "github_to_standupless"] = "two_way"
    enabled: bool = True
    sync_labels: bool = True
    allow_public_two_way: bool = False


class IssueSyncRead(BaseModel):
    """The GitHub issue one issue is synced with."""

    issue_id: str
    repository_full_name: str
    number: int
    url: str
    origin: Literal["github", "standupless"]
    synced_at: datetime
