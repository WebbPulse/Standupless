"""Grant or revoke the platform admin flag on one person's `users` row.

A platform admin reaches the deployment's admin surface, such as the GitHub App
setup routes behind `require_platform_admin`. The flag is never set from a
request, so this command is the supported way to change it rather than a hand
edit of the table.

Dry run by default: it says what would change and writes nothing until
`--apply` is passed. Idempotent: granting an admin or revoking someone who is
not one writes nothing. It refuses an unknown person, a grant to a disabled or
deleted account, and revoking the last platform admin who can still sign in.
Each write records `platform_admin.granted` or `platform_admin.revoked` in the
audit log of every workspace the person belongs to.

Usage, from backend/:
    python scripts/grant_admin.py --stage staging --user-id <id>
    python scripts/grant_admin.py --stage production --email person@example.com --apply
    python scripts/grant_admin.py --stage production --user-id <id> --revoke --apply

It prints the user id, the action and the outcome only, never an email.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Any, Optional, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

ACTOR_ID = "grant-admin"

GRANTED = "granted"
REVOKED = "revoked"
UNCHANGED = "unchanged"
NOT_FOUND = "user_not_found"
INACTIVE = "user_inactive"
LAST_ADMIN = "last_admin"

REFUSALS = frozenset({NOT_FOUND, INACTIVE, LAST_ADMIN})
"""The outcomes that changed nothing because the request was refused, which exit non-zero."""


def find_user(repositories: Any, *, user_id: Optional[str] = None, email: Optional[str] = None) -> Any:
    """The person named by id or by email, or `None` when there is no such row."""
    if user_id:
        return repositories.users.get(user_id)
    if email:
        return repositories.users.get_by_email(email)
    return None


def _audit(repositories: Any, user: Any, event: str, before: bool, after: bool) -> int:
    """Record the change in every workspace the person belongs to, answering how many."""
    from app.common import audit
    from app.common.api.schemas.workspaces import display_name_for

    memberships = repositories.memberships.list_workspaces_for_user(user.id)
    for membership in memberships:
        audit.record_system(
            repositories,
            membership.workspace_id,
            event,
            actor_id=ACTOR_ID,
            target_type="user",
            target_id=user.id,
            target_label=display_name_for(user),
            before={"is_admin": before},
            after={"is_admin": after},
        )
    return len(memberships)


def grant(repositories: Any, user: Any, *, apply: bool) -> str:
    """Set the flag on an active account, answering the outcome."""
    if user is None:
        return NOT_FOUND
    if user.is_admin:
        return UNCHANGED
    if user.disabled or user.is_deleted:
        return INACTIVE
    if not apply:
        return GRANTED
    repositories.users.update(user.id, is_admin=True)
    _audit(repositories, user, "platform_admin.granted", False, True)
    return GRANTED


def revoke(repositories: Any, user: Any, *, apply: bool) -> str:
    """Clear the flag unless it would leave no platform admin who can sign in, answering the outcome."""
    if user is None:
        return NOT_FOUND
    if not user.is_admin:
        return UNCHANGED
    others = [admin for admin in repositories.users.list_admins() if admin.id != user.id]
    if not others:
        return LAST_ADMIN
    if not apply:
        return REVOKED
    repositories.users.update(user.id, is_admin=False)
    _audit(repositories, user, "platform_admin.revoked", True, False)
    return REVOKED


def main(argv: Optional[Sequence[str]] = None) -> int:
    """Parse the flags, bind the stage's tables and grant or revoke."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    parser.add_argument("--stage", required=True, help="The environment whose tables to write, such as staging")
    who = parser.add_mutually_exclusive_group(required=True)
    who.add_argument("--user-id", help="The person's user id")
    who.add_argument("--email", help="The person's sign-in address, matched without regard to case")
    parser.add_argument("--revoke", action="store_true", help="Clear the flag instead of setting it")
    parser.add_argument("--apply", action="store_true", help="Write the change; without it nothing is written")
    arguments = parser.parse_args(argv)
    os.environ["DYNAMODB_TABLE_PREFIX"] = f"standupless-{arguments.stage}"
    from app.common.api.dependencies.repositories import ALL_REPOSITORY_NAMES, build_bundle

    repositories = build_bundle(ALL_REPOSITORY_NAMES, name="grant-admin")
    user = find_user(repositories, user_id=arguments.user_id, email=arguments.email)
    if arguments.revoke:
        outcome = revoke(repositories, user, apply=arguments.apply)
    else:
        outcome = grant(repositories, user, apply=arguments.apply)
    label = user.id if user is not None else (arguments.user_id or "unknown")
    action = "revoke" if arguments.revoke else "grant"
    print(("" if arguments.apply else "dry-run ") + f"{action} user={label} outcome={outcome}")
    return 1 if outcome in REFUSALS else 0


if __name__ == "__main__":
    raise SystemExit(main())
