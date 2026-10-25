"""Create by email: the intake addresses a team, or one of its templates, files mail through.

An address is `<team key>-<token>@<intake domain>`. The token is the only secret
in it, so each address is one row in the workspace's own partition of the
`github` table, keyed `emailintake#<team id>#<scope>`, where the scope is `team`
or `template#<template id>`. Inbound mail names nothing but the token, so a
pointer row in the `_platform` partition, keyed `emailintake-token#<token>`,
maps it back to the workspace. The pointer is trusted only while the workspace
row still holds the same token, so a regenerated, disabled or purged address
resolves to nothing even if its pointer outlived it.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Mapping, Optional

from boto3.dynamodb.conditions import Attr, Key
from pydantic import BaseModel, Field
from webbpulse.dynamodb import ConditionFailed, Repository

from app.common.db.dynamo.base import as_item, utc_now
from app.common.db.dynamo.chat_installs import PLATFORM_PARTITION

INTAKE_PREFIX = "emailintake#"
POINTER_PREFIX = "emailintake-token#"
TEAM_SCOPE = "team"
TEMPLATE_SCOPE_PREFIX = "template#"


def scope_for(template_id: Optional[str]) -> str:
    """The scope of an address: the team's own, or one template's."""
    return f"{TEMPLATE_SCOPE_PREFIX}{template_id}" if template_id else TEAM_SCOPE


def intake_key(team_id: str, template_id: Optional[str]) -> str:
    """The sort key of one address row."""
    return f"{INTAKE_PREFIX}{team_id}#{scope_for(template_id)}"


class EmailIntake(BaseModel):
    """One live intake address of a team, or of one of its templates."""

    workspace_id: str
    github_key: str
    team_id: str
    template_id: Optional[str] = None
    token: str
    enabled_by: str
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class EmailIntakeStore:
    """Reads and writes intake address rows, every method workspace first except `resolve`.

    `resolve` takes only a token because finding the workspace is what it does,
    and its only caller is the intake mail consumer.
    """

    def __init__(self, repository: Repository) -> None:
        """Share the `github` table's package repository."""
        self._repository = repository

    def _key(self, workspace_id: str, github_key: str) -> dict[str, str]:
        """The primary key of one row."""
        return {"workspace_id": workspace_id, "github_key": github_key}

    def _pointer_key(self, token: str) -> str:
        """The sort key of the pointer from a token to its workspace."""
        return f"{POINTER_PREFIX}{token}"

    def get(self, workspace_id: str, team_id: str, template_id: Optional[str] = None) -> EmailIntake | None:
        """The live address of a team or template, or `None` when it is off."""
        if not workspace_id or not team_id:
            return None
        item = self._repository.get(self._key(workspace_id, intake_key(team_id, template_id)), consistent=True)
        return EmailIntake.model_validate(dict(item)) if item is not None else None

    def list_team(self, workspace_id: str, team_id: str) -> list[EmailIntake]:
        """Every live address of one team, its own and its templates'."""
        if not workspace_id or not team_id:
            return []
        items = self._repository.iter_query(
            Key("workspace_id").eq(workspace_id) & Key("github_key").begins_with(f"{INTAKE_PREFIX}{team_id}#"),
            max_items=500,
            consistent=True,
        )
        return [EmailIntake.model_validate(dict(item)) for item in items]

    def put(self, intake: EmailIntake) -> EmailIntake:
        """Store an address under its token, revoking the token it replaces."""
        current = self.get(intake.workspace_id, intake.team_id, intake.template_id)
        self._repository.put(
            {
                "workspace_id": PLATFORM_PARTITION,
                "github_key": self._pointer_key(intake.token),
                "bound_workspace_id": intake.workspace_id,
                "team_id": intake.team_id,
                "updated_at": utc_now().isoformat(),
            }
        )
        self._repository.put(as_item(intake))
        if current is not None and current.token != intake.token:
            self._drop_pointer(intake.workspace_id, current.token)
        return intake

    def delete(self, workspace_id: str, team_id: str, template_id: Optional[str] = None) -> EmailIntake | None:
        """Turn one address off, answering the row that was removed."""
        current = self.get(workspace_id, team_id, template_id)
        if current is None:
            return None
        self._repository.delete(self._key(workspace_id, current.github_key))
        self._drop_pointer(workspace_id, current.token)
        return current

    def delete_team(self, workspace_id: str, team_id: str) -> int:
        """Turn every address of a team off, for the team purge."""
        removed = 0
        for intake in self.list_team(workspace_id, team_id):
            self._repository.delete(self._key(workspace_id, intake.github_key))
            self._drop_pointer(workspace_id, intake.token)
            removed += 1
        return removed

    def resolve(self, token: str) -> EmailIntake | None:
        """The live address a token names, across every workspace, or `None`."""
        if not token:
            return None
        pointer: Mapping[str, Any] | None = self._repository.get(
            self._key(PLATFORM_PARTITION, self._pointer_key(token)), consistent=True
        )
        if pointer is None:
            return None
        workspace_id = str(pointer.get("bound_workspace_id", ""))
        team_id = str(pointer.get("team_id", ""))
        for intake in self.list_team(workspace_id, team_id):
            if intake.token == token:
                return intake
        return None

    def _drop_pointer(self, workspace_id: str, token: str) -> None:
        """Remove a token's pointer while it still names this workspace."""
        try:
            self._repository.delete(
                self._key(PLATFORM_PARTITION, self._pointer_key(token)),
                condition=Attr("bound_workspace_id").eq(workspace_id),
            )
        except ConditionFailed:
            return
