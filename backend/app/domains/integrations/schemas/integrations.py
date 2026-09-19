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

from app.common.db.dynamo.project_config import TRIGGERS

OUTBOUND_EVENTS: tuple[str, ...] = (
    "issue.created",
    "issue.updated",
    "issue.status_changed",
    "comment.created",
)
"""The events a workspace endpoint may subscribe to."""


def _require_https(value: str) -> str:
    """Refuse anything but https for a delivery endpoint.

    A signed payload sent in clear text is still readable by anyone on the path, and
    the signature only proves who sent it, so plain http is refused rather than
    warned about.
    """
    if not value.startswith("https://"):
        raise ValueError("The endpoint url must be https.")
    return value


def _require_known_events(value: list[str]) -> list[str]:
    """Refuse an unknown event name.

    Silently accepting one would look subscribed and never deliver.
    """
    if not value:
        raise ValueError("At least one event is required.")
    unknown = sorted(set(value) - set(OUTBOUND_EVENTS))
    if unknown:
        raise ValueError(f"Unknown events: {', '.join(unknown)}.")
    return sorted(set(value))


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
    project_id: str | None = None
    linked_at: datetime


class InstallationRead(BaseModel):
    """The GitHub App installation a workspace has, if any."""

    installation_id: str
    account_login: str
    account_type: str
    repository_selection: str
    html_url: str
    installed_by: str
    installed_at: datetime
    repository_count: int


class RepositoryLinkWrite(BaseModel):
    """Point one repository at one project, or clear it."""

    project_id: str | None = None


class IssueLinkRead(BaseModel):
    """One pull request linked to one issue."""

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
    linked_at: datetime
    updated_at: datetime


class WebhookEndpointRead(BaseModel):
    """One outbound webhook endpoint.

    `secret` is populated only by the create and rotate calls. `secret_hint` is the
    last four characters, which is enough for a person to tell two endpoints apart
    without the value being recoverable from it.
    """

    webhook_id: str
    url: str
    events: list[str]
    description: str | None = None
    active: bool
    secret_hint: str
    created_by: str
    created_at: datetime
    updated_at: datetime
    last_status: int | None = None
    last_delivery_at: datetime | None = None
    secret: str | None = None


class WebhookEndpointCreate(BaseModel):
    """Register an endpoint to deliver to."""

    model_config = ConfigDict(extra="forbid")

    url: str = Field(min_length=1, max_length=2048)
    events: list[str] = Field(default_factory=lambda: list(OUTBOUND_EVENTS), min_length=1)
    description: str | None = Field(default=None, max_length=200)
    active: bool = True

    @field_validator("url")
    @classmethod
    def _check_url(cls, value: str) -> str:
        """Hold the https rule on create."""
        return _require_https(value)

    @field_validator("events")
    @classmethod
    def _check_events(cls, value: list[str]) -> list[str]:
        """Hold the known-event rule on create."""
        return _require_known_events(value)


class WebhookEndpointUpdate(BaseModel):
    """Change an endpoint, leaving unset fields alone."""

    model_config = ConfigDict(extra="forbid")

    url: str | None = Field(default=None, min_length=1, max_length=2048)
    events: list[str] | None = Field(default=None, min_length=1)
    description: str | None = Field(default=None, max_length=200)
    active: bool | None = None

    @field_validator("url")
    @classmethod
    def _check_url(cls, value: str | None) -> str | None:
        """Hold the https rule on the fields an update actually sets."""
        return None if value is None else _require_https(value)

    @field_validator("events")
    @classmethod
    def _check_events(cls, value: list[str] | None) -> list[str] | None:
        """Hold the known-event rule on the fields an update actually sets."""
        return None if value is None else _require_known_events(value)


class TransitionRead(BaseModel):
    """One rule moving an issue when a pull request event happens.

    `is_default` says the rule is not stored but computed from the design defaults,
    so the frontend can show it as inherited rather than as something a person set.
    """

    transition_id: str
    project_id: str
    trigger: str
    status_id: str | None
    is_default: bool = False


class TransitionCreate(BaseModel):
    """Add a rule for a trigger that has none."""

    model_config = ConfigDict(extra="forbid")

    trigger: str
    status_id: str | None = None

    @field_validator("trigger")
    @classmethod
    def _known_trigger(cls, value: str) -> str:
        """Refuse a trigger no pull request event can fire."""
        if value not in TRIGGERS:
            raise ValueError(f"Unknown trigger. Expected one of: {', '.join(TRIGGERS)}.")
        return value


class TransitionUpdate(BaseModel):
    """Repoint a rule at another status, or at none."""

    model_config = ConfigDict(extra="forbid")

    status_id: str | None = None
