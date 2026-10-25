"""Turning a team's create by email addresses on, off and over, with the audit trail each leaves.

The token is the address's only secret, so it never reaches the audit log: an
event names the team and which address changed, and the address itself is shown
only on the team's settings. Regenerating writes a fresh token and revokes the
old one in the same step, so mail to the old address is dropped from then on.
"""

from __future__ import annotations

import base64
import secrets
from typing import Any, Optional

from app.common import audit
from app.common.api.dependencies.authz import AuthzContext
from app.common.core.config import settings
from app.common.db.dynamo.base import utc_now
from app.common.db.dynamo.email_intake import EmailIntake, intake_key, scope_for
from app.common.issue_templates import find_template
from app.domains.integrations.schemas.integrations import EmailIntakeList, EmailIntakeRead
from app.domains.integrations.service import conflict, not_found, unprocessable

TOKEN_BYTES = 15
"""120 bits of randomness, far past guessing, in a 24 character token."""


def intake_domain() -> str:
    """The mail domain intake addresses live under, or `""` when this deployment has none."""
    return settings.EMAIL_INTAKE_DOMAIN.strip().lower()


def new_token() -> str:
    """A fresh unguessable token, lowercase letters and digits only so it survives any mail client."""
    return base64.b32encode(secrets.token_bytes(TOKEN_BYTES)).decode("ascii").rstrip("=").lower()


def address_of(key_prefix: str, token: str, domain: Optional[str] = None) -> str:
    """The address mail is sent to: `<team key>-<token>@<intake domain>`."""
    return f"{key_prefix.lower()}-{token}@{domain if domain is not None else intake_domain()}"


def intake_read(intake: EmailIntake, key_prefix: str) -> EmailIntakeRead:
    """The public shape of one live address."""
    return EmailIntakeRead(
        team_id=intake.team_id,
        template_id=intake.template_id,
        address=address_of(key_prefix, intake.token),
        enabled_by=intake.enabled_by,
        created_at=intake.created_at,
        updated_at=intake.updated_at,
    )


def read_team_intake(repositories: Any, workspace_id: str, team: Any) -> EmailIntakeList:
    """Every live address of one team, its own first and then its templates'."""
    rows = repositories.github.email_intake.list_team(workspace_id, team.team_id)
    rows.sort(key=lambda row: (row.template_id is not None, row.template_id or ""))
    return EmailIntakeList(
        team_id=team.team_id,
        available=bool(intake_domain()),
        addresses=[intake_read(row, team.key_prefix) for row in rows],
    )


def _require_template(repositories: Any, context: AuthzContext, team_id: str, template_id: Optional[str]) -> None:
    """Hold that a template address names an issue template this team offers, or 404, and not a form, or 422.

    A form template needs answers a mail cannot give, so every mail to its
    address would be refused.
    """
    if template_id is None:
        return
    template = find_template(repositories, context, team_id, template_id)
    if template is None:
        raise not_found()
    if template.form_fields:
        raise unprocessable("Form templates cannot take issues by email.")


def _require_available() -> None:
    """Refuse to turn an address on where no intake mail domain is deployed."""
    if not intake_domain():
        raise conflict("Create by email is not available in this environment.")


def _record(repositories: Any, context: AuthzContext, event: str, team: Any, template_id: Optional[str]) -> None:
    """Record one change to an address, naming which address but never its token."""
    audit.record(
        repositories,
        context,
        event,
        target_type="team",
        target_id=team.team_id,
        target_label=team.name,
        after={"scope": scope_for(template_id), "template_id": template_id},
    )


def enable_intake(
    repositories: Any, context: AuthzContext, team: Any, template_id: Optional[str] = None
) -> EmailIntakeRead:
    """Turn one address on, answering the live address unchanged when it is already on."""
    _require_available()
    _require_template(repositories, context, team.team_id, template_id)
    store = repositories.github.email_intake
    current = store.get(context.workspace_id, team.team_id, template_id)
    if current is not None:
        return intake_read(current, team.key_prefix)
    intake = store.put(_new_row(context, team.team_id, template_id))
    _record(repositories, context, "email_intake.enabled", team, template_id)
    return intake_read(intake, team.key_prefix)


def regenerate_intake(
    repositories: Any, context: AuthzContext, team: Any, template_id: Optional[str] = None
) -> EmailIntakeRead:
    """Give a live address a fresh token, so mail to the old one is dropped from now on."""
    _require_available()
    store = repositories.github.email_intake
    current = store.get(context.workspace_id, team.team_id, template_id)
    if current is None:
        raise unprocessable("Turn create by email on before regenerating its address.")
    intake = store.put(_new_row(context, team.team_id, template_id, created_at=current.created_at))
    _record(repositories, context, "email_intake.regenerated", team, template_id)
    return intake_read(intake, team.key_prefix)


def disable_intake(repositories: Any, context: AuthzContext, team: Any, template_id: Optional[str] = None) -> None:
    """Turn one address off, revoking its token, or 404 when it was not on."""
    removed = repositories.github.email_intake.delete(context.workspace_id, team.team_id, template_id)
    if removed is None:
        raise not_found()
    _record(repositories, context, "email_intake.disabled", team, template_id)


def _new_row(context: AuthzContext, team_id: str, template_id: Optional[str], created_at: Any = None) -> EmailIntake:
    """A fresh address row under the caller, who the mail it files is attributed to."""
    now = utc_now()
    return EmailIntake(
        workspace_id=context.workspace_id,
        github_key=intake_key(team_id, template_id),
        team_id=team_id,
        template_id=template_id,
        token=new_token(),
        enabled_by=context.user_id,
        created_at=created_at or now,
        updated_at=now,
    )
