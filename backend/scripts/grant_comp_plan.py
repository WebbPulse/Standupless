"""Grant or revoke an internal comp plan on one workspace, with no Stripe subscription behind it.

A comp grant holds the workspace on a paid plan at every gate, as an active
subscription of that plan would, until it is revoked or its expiry passes. It
lives in its own fields, so no Stripe webhook can overwrite or cancel it, and a
real subscription beside it still counts when its plan is the higher one.

Idempotent: granting the plan, reason and expiry already held, or revoking a
workspace that holds no grant, writes nothing. Each write records `plan.changed`
in the workspace's audit log.

Usage, from backend/:
    python scripts/grant_comp_plan.py --stage staging --workspace webbpulse \\
        --plan business --reason "Internal dogfooding" --dry-run
    python scripts/grant_comp_plan.py --stage staging --workspace webbpulse --revoke

It prints the slug, the plan and the outcome only, never ids or people.
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, time, timezone
from pathlib import Path
from typing import Any, Optional, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

ACTOR_ID = "comp-grant"

GRANTED = "granted"
UNCHANGED = "unchanged"
REVOKED = "revoked"
NOT_FOUND = "workspace_not_found"


def _same_grant(workspace: Any, plan: str, reason: str, expires_at: Optional[datetime]) -> bool:
    """Whether the workspace already holds exactly this grant."""
    held = workspace.comp_expires_at
    if held is not None and held.tzinfo is None:
        held = held.replace(tzinfo=timezone.utc)
    return workspace.comp_plan == plan and workspace.comp_reason == reason and held == expires_at


def _audit(repositories: Any, workspace: Any, before: str, after: str, comp: bool) -> None:
    """Record the plan change the grant or revoke made."""
    from app.common import audit

    audit.record_system(
        repositories,
        workspace.id,
        "plan.changed",
        actor_id=ACTOR_ID,
        target_type="workspace",
        target_id=workspace.id,
        target_label=workspace.name,
        before={"plan": before},
        after={"plan": after, "comp": comp},
    )


def grant(
    repositories: Any,
    slug: str,
    *,
    plan: str,
    reason: str,
    expires_at: Optional[datetime] = None,
    dry_run: bool,
) -> str:
    """Hold the workspace on `plan` through a comp grant, answering the outcome."""
    workspace = repositories.workspaces.get_by_slug(slug)
    if workspace is None:
        return NOT_FOUND
    if _same_grant(workspace, plan, reason, expires_at):
        return UNCHANGED
    if dry_run:
        return GRANTED
    before = workspace.effective_plan()
    updated = repositories.workspaces.set_comp_grant(workspace.id, plan=plan, reason=reason, expires_at=expires_at)
    if updated is None:
        return NOT_FOUND
    _audit(repositories, workspace, before, updated.effective_plan(), True)
    return GRANTED


def revoke(repositories: Any, slug: str, *, dry_run: bool) -> str:
    """Remove the workspace's comp grant, answering the outcome."""
    workspace = repositories.workspaces.get_by_slug(slug)
    if workspace is None:
        return NOT_FOUND
    if workspace.comp_plan is None:
        return UNCHANGED
    if dry_run:
        return REVOKED
    before = workspace.effective_plan()
    updated = repositories.workspaces.clear_comp_grant(workspace.id)
    if updated is None:
        return NOT_FOUND
    _audit(repositories, workspace, before, updated.effective_plan(), False)
    return REVOKED


def _expiry(value: str) -> datetime:
    """A `YYYY-MM-DD` date as the start of that day in UTC."""
    return datetime.combine(datetime.strptime(value, "%Y-%m-%d").date(), time.min, tzinfo=timezone.utc)


def main(argv: Optional[Sequence[str]] = None) -> int:
    """Parse the flags, bind the stage's tables and grant or revoke."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    parser.add_argument("--stage", required=True, help="The environment whose tables to write, such as staging")
    parser.add_argument("--workspace", required=True, help="The workspace slug, such as webbpulse")
    parser.add_argument("--plan", choices=["standard", "business"], default="business", help="The plan to grant")
    parser.add_argument("--reason", help="Why the workspace is comped; required to grant")
    parser.add_argument("--expires", type=_expiry, help="The UTC date the grant ends, YYYY-MM-DD; omit for none")
    parser.add_argument("--revoke", action="store_true", help="Remove the grant instead")
    parser.add_argument("--dry-run", action="store_true", help="Say what would change and write nothing")
    arguments = parser.parse_args(argv)
    if not arguments.revoke and not arguments.reason:
        parser.error("--reason is required to grant")
    os.environ["DYNAMODB_TABLE_PREFIX"] = f"standupless-{arguments.stage}"
    from app.common.api.dependencies.repositories import ALL_REPOSITORY_NAMES, build_bundle

    repositories = build_bundle(ALL_REPOSITORY_NAMES, name="grant-comp-plan")
    if arguments.revoke:
        outcome = revoke(repositories, arguments.workspace, dry_run=arguments.dry_run)
        action = "revoke"
    else:
        outcome = grant(
            repositories,
            arguments.workspace,
            plan=arguments.plan,
            reason=arguments.reason,
            expires_at=arguments.expires,
            dry_run=arguments.dry_run,
        )
        action = f"grant plan={arguments.plan}"
    print(("dry-run " if arguments.dry_run else "") + f"{action} workspace={arguments.workspace} outcome={outcome}")
    return 1 if outcome == NOT_FOUND else 0


if __name__ == "__main__":
    raise SystemExit(main())
