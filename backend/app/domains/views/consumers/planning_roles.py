"""Who a project or initiative write newly hands a role to, for the notify consumer.

Linear tells a person when they become a project's lead, join its members or
become an initiative's owner, so being handed a project is never learned by
accident. This module only compares the row before and after one write and
names who gained which role; the consumer decides who may hear it and writes
the inbox rows.

A role is news only when it is gained. A lead or owner cleared, or a member
removed, sends nothing, and a write that leaves the roles as they were, such as
a rollup of the project's issue counts, names nobody without any read. Each
person is named once per write: someone made lead and added as a member in the
same edit hears only that they lead it. An archived project names nobody, since
handing someone a project nobody works on is not worth a badge.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Optional

from app.common.db.dynamo.inbox import INITIATIVE_OWNER_ASSIGNED, PROJECT_LEAD_ASSIGNED, PROJECT_MEMBER_ADDED
from app.common.db.dynamo.planning import INITIATIVE, Initiative, Project, as_initiative


@dataclass(frozen=True)
class RoleGrant:
    """One person a write handed a role to, and the notification kind that tells them."""

    kind: str
    user_id: str


def image_initiative(image: Mapping[str, Any]) -> Optional[Initiative]:
    """One stream image as an `Initiative`, or `None` when it is not a whole initiative row."""
    if not image or str(image.get("kind", "")) != INITIATIVE:
        return None
    try:
        return as_initiative(image)
    except ValueError:
        return None


def project_role_grants(before: Optional[Project], after: Project) -> list[RoleGrant]:
    """The people a project write newly made its lead or added to its members, lead first.

    `before` is `None` for a created project, whose lead and members are all new.
    """
    if after.archived_at is not None:
        return []
    grants: list[RoleGrant] = []
    named: set[str] = set()
    lead = after.lead_id or ""
    if lead and (before is None or before.lead_id != lead):
        grants.append(RoleGrant(PROJECT_LEAD_ASSIGNED, lead))
        named.add(lead)
    previous = set(before.member_ids) if before is not None else set()
    for member_id in dict.fromkeys(after.member_ids):
        if member_id and member_id not in previous and member_id not in named:
            grants.append(RoleGrant(PROJECT_MEMBER_ADDED, member_id))
            named.add(member_id)
    return grants


def initiative_role_grants(before: Optional[Initiative], after: Initiative) -> list[RoleGrant]:
    """The person an initiative write newly made its owner, if any.

    `before` is `None` for a created initiative, whose owner is new.
    """
    owner = after.owner_id or ""
    if not owner or (before is not None and before.owner_id == owner):
        return []
    return [RoleGrant(INITIATIVE_OWNER_ASSIGNED, owner)]
