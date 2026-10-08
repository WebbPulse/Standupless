"""The one-off cleanup of team memberships a workspace removal left behind, against moto."""

from __future__ import annotations

from typing import Any

import pytest

from app.common.db.dynamo.memberships import Membership, team_member_key
from scripts.purge_orphaned_team_memberships import main, run
from tests.domains.helpers import MEMBER, OUTSIDER, OWNER, add_member, make_workspace

WORKSPACE = "01JB00000000000000000000WS"

TEAM = "01JB000000000000000000PRJ1"


def _team_row(repositories: Any, user_id: str, role: str = "member") -> None:
    """Write one team membership directly, the way an old removal left it."""
    repositories.memberships.put(
        Membership(
            workspace_id=WORKSPACE,
            member_key=team_member_key(TEAM, user_id),
            user_id=user_id,
            role=role,
            team_id=TEAM,
        )
    )


@pytest.fixture
def seeded(repositories: Any) -> None:
    """A member with a team row, and a removed person whose team admin row survived."""
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    add_member(repositories, WORKSPACE, MEMBER, "member")
    _team_row(repositories, MEMBER)
    _team_row(repositories, OUTSIDER, "admin")


def test_orphaned_team_rows_go_and_members_keep_theirs(repositories: Any, seeded: None) -> None:
    """Only rows whose holder has no workspace membership are deleted, and a rerun deletes nothing."""
    assert run(repositories, [WORKSPACE], dry_run=False) == (1, 1)

    assert repositories.memberships.get_team_membership(WORKSPACE, TEAM, OUTSIDER) is None
    assert repositories.memberships.get_team_membership(WORKSPACE, TEAM, MEMBER) is not None
    assert run(repositories, [WORKSPACE], dry_run=False) == (1, 0)


def test_a_dry_run_counts_and_writes_nothing(
    repositories: Any, seeded: None, capsys: pytest.CaptureFixture[str]
) -> None:
    """The command line prints counts only and leaves the rows under `--dry-run`."""
    from app.common.core.config import settings

    stage = settings.dynamodb_table_prefix.removeprefix("standupless-")
    assert main(["--stage", stage, "--workspace", WORKSPACE, "--dry-run"]) == 0

    printed = capsys.readouterr().out.strip()
    assert printed == "dry-run workspaces=1 orphaned_team_memberships=1"
    assert repositories.memberships.get_team_membership(WORKSPACE, TEAM, OUTSIDER) is not None
