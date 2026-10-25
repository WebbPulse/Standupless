"""A new sub-issue taking its parent's cycle and assignee, as Linear does.

Each rule is held through the create route against the real tables: the cycle
follows only into an active start and an open cycle, the assignee follows when
the creator holds it or every sibling shares it, a field the create names wins,
and labels never follow.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.common.db.dynamo.planning import Cycle, cycle_key
from app.common.db.dynamo.team_config import Label, label_key, new_config_id
from app.common.sub_issue_inheritance import inherited_cycle_id
from tests.domains.helpers import ADMIN, MEMBER, OWNER, sign_in
from tests.domains.issues.conftest import TEAM, WORKSPACE, create_issue


def _cycle(repositories: Any, cycle_id: str, start: date, end: date) -> str:
    """Store one cycle of the team straight in the planning table, answering its id."""
    repositories.planning.create_cycle(
        Cycle(
            workspace_id=WORKSPACE,
            planning_key=cycle_key(TEAM, cycle_id),
            cycle_id=cycle_id,
            team_id=TEAM,
            name=cycle_id,
            start_date=start.isoformat(),
            end_date=end.isoformat(),
            created_by=OWNER,
        )
    )
    return cycle_id


def _open_cycle(repositories: Any) -> str:
    """A cycle of the team running today."""
    today = date.today()
    return _cycle(repositories, "OPEN", today - timedelta(days=3), today + timedelta(days=3))


@pytest.mark.parametrize("category", ["unstarted", "started"])
def test_an_active_start_joins_the_parents_open_cycle(
    client: TestClient, workspace: str, repositories: Any, statuses: Any, category: str
) -> None:
    """A sub-issue starting unstarted or started lands in the parent's running cycle."""
    cycle_id = _open_cycle(repositories)
    sign_in(client, OWNER)
    parent = create_issue(client, workspace, title="Parent", cycle_id=cycle_id)

    child = create_issue(
        client, workspace, title="Child", parent_id=parent["id"], status_id=statuses[category].status_id
    )

    assert child["cycle_id"] == cycle_id


def test_a_backlog_start_stays_out_of_the_cycle(client: TestClient, workspace: str, repositories: Any) -> None:
    """A sub-issue filed into the team's default backlog status is left out of the cycle."""
    cycle_id = _open_cycle(repositories)
    sign_in(client, OWNER)
    parent = create_issue(client, workspace, title="Parent", cycle_id=cycle_id)

    child = create_issue(client, workspace, title="Child", parent_id=parent["id"])

    assert child["cycle_id"] is None


def test_a_completed_cycle_is_not_inherited(
    client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """A parent whose cycle has ended passes no cycle down."""
    today = date.today()
    cycle_id = _cycle(repositories, "DONE", today - timedelta(days=20), today - timedelta(days=6))
    sign_in(client, OWNER)
    parent = create_issue(client, workspace, title="Parent", cycle_id=cycle_id)

    child = create_issue(
        client, workspace, title="Child", parent_id=parent["id"], status_id=statuses["unstarted"].status_id
    )

    assert child["cycle_id"] is None


def test_a_named_cycle_wins_over_the_parents(
    client: TestClient, workspace: str, repositories: Any, statuses: Any
) -> None:
    """A create that sends cycle_id, null included, keeps what it sent."""
    cycle_id = _open_cycle(repositories)
    sign_in(client, OWNER)
    parent = create_issue(client, workspace, title="Parent", cycle_id=cycle_id)

    child = create_issue(
        client,
        workspace,
        title="Child",
        parent_id=parent["id"],
        status_id=statuses["unstarted"].status_id,
        cycle_id=None,
    )

    assert child["cycle_id"] is None


def test_a_triage_start_stays_out_of_the_cycle(client: TestClient, workspace: str, repositories: Any) -> None:
    """A sub-issue waiting in triage takes no cycle, whatever its stored status."""
    cycle_id = _open_cycle(repositories)
    sign_in(client, OWNER)
    parent = create_issue(client, workspace, title="Parent", cycle_id=cycle_id)
    row = repositories.issues.get(WORKSPACE, parent["id"])

    assert inherited_cycle_id(repositories, row, "unstarted", True) is None
    assert inherited_cycle_id(repositories, row, "unstarted", False) == cycle_id


def test_the_creator_who_holds_the_parent_passes_it_down(client: TestClient, workspace: str) -> None:
    """The parent's assignee filing a sub-issue gets it, even when siblings are someone else's."""
    sign_in(client, OWNER)
    parent = create_issue(client, workspace, title="Parent", assignee_id=OWNER)
    create_issue(client, workspace, title="Theirs", parent_id=parent["id"], assignee_id=ADMIN)

    child = create_issue(client, workspace, title="Child", parent_id=parent["id"])

    assert child["assignee_id"] == OWNER


def test_no_siblings_counts_as_sharing_the_parents_assignee(client: TestClient, workspace: str) -> None:
    """The first sub-issue of an assigned parent takes its assignee."""
    sign_in(client, OWNER)
    parent = create_issue(client, workspace, title="Parent", assignee_id=MEMBER)

    child = create_issue(client, workspace, title="Child", parent_id=parent["id"])

    assert child["assignee_id"] == MEMBER


def test_siblings_sharing_the_assignee_pass_it_down_and_mixed_ones_do_not(client: TestClient, workspace: str) -> None:
    """The assignee follows while every sibling shares it, and stops once one does not."""
    sign_in(client, OWNER)
    parent = create_issue(client, workspace, title="Parent", assignee_id=MEMBER)
    create_issue(client, workspace, title="First", parent_id=parent["id"], assignee_id=MEMBER)

    shared = create_issue(client, workspace, title="Shared", parent_id=parent["id"])
    create_issue(client, workspace, title="Other", parent_id=parent["id"], assignee_id=ADMIN)
    mixed = create_issue(client, workspace, title="Mixed", parent_id=parent["id"])

    assert shared["assignee_id"] == MEMBER
    assert mixed["assignee_id"] is None


def test_an_unassigned_parent_passes_no_assignee(client: TestClient, workspace: str) -> None:
    """A parent with nobody on it leaves the sub-issue unassigned."""
    sign_in(client, OWNER)
    parent = create_issue(client, workspace, title="Parent")

    child = create_issue(client, workspace, title="Child", parent_id=parent["id"])

    assert child["assignee_id"] is None


def test_a_named_assignee_wins_over_the_parents(client: TestClient, workspace: str) -> None:
    """A create that sends assignee_id, null included, keeps what it sent."""
    sign_in(client, OWNER)
    parent = create_issue(client, workspace, title="Parent", assignee_id=OWNER)

    cleared = create_issue(client, workspace, title="Cleared", parent_id=parent["id"], assignee_id=None)
    named = create_issue(client, workspace, title="Named", parent_id=parent["id"], assignee_id=ADMIN)

    assert cleared["assignee_id"] is None
    assert named["assignee_id"] == ADMIN


def test_labels_are_never_inherited(client: TestClient, workspace: str, repositories: Any) -> None:
    """A labelled parent's sub-issue starts with no labels."""
    label_id = new_config_id()
    repositories.team_config.create_label(
        Label(
            workspace_id=WORKSPACE,
            config_key=label_key(TEAM, label_id),
            team_id=TEAM,
            label_id=label_id,
            name="Bug",
            color="#ff0000",
        )
    )
    sign_in(client, OWNER)
    parent = create_issue(client, workspace, title="Parent", label_ids=[label_id])

    child = create_issue(client, workspace, title="Child", parent_id=parent["id"])

    assert child["label_ids"] == []
