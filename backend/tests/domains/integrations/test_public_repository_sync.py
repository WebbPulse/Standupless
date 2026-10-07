"""A public repository never syncs both ways, however it became public.

Two way sync writes a team's issues back to the repository, which would publish
them, so the settings route refuses the pair and every path that learns a
repository is public drops an existing two way link to one way and records it on
the team's activity.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from app.common.db.dynamo.github import TeamSync, team_sync_key
from app.domains.integrations import installs
from app.domains.integrations.consumers import events
from app.domains.integrations.endpoints.sync import PUBLIC_TWO_WAY
from tests.domains.helpers import ADMIN, sign_in
from tests.domains.integrations.conftest import (
    INSTALLATION_ID,
    REPOSITORY_FULL_NAME,
    REPOSITORY_ID,
    TEAM,
    WORKSPACE,
    sqs_record,
)

SYNC_PATH = f"/api/workspaces/{WORKSPACE}/teams/{TEAM}/github-sync"


def make_public(repositories: Any) -> None:
    """Mark the installed repository public, as GitHub would report it."""
    repositories.github.set_repository_private(WORKSPACE, REPOSITORY_ID, False)


def link_two_way(repositories: Any) -> None:
    """Link `TEAM` to the installed repository both ways."""
    repositories.github.put_team_sync(
        TeamSync(
            workspace_id=WORKSPACE,
            github_key=team_sync_key(TEAM),
            team_id=TEAM,
            repository_id=REPOSITORY_ID,
            full_name=REPOSITORY_FULL_NAME,
            direction="two_way",
            enabled=True,
            created_by=ADMIN,
        )
    )


def repository_delivery(action: str, *, private: bool) -> dict[str, Any]:
    """One `repository` delivery for the installed repository."""
    return {
        "event": "repository",
        "delivery": f"r-{action}",
        "body": {
            "action": action,
            "installation": {"id": int(INSTALLATION_ID)},
            "repository": {
                "id": int(REPOSITORY_ID),
                "full_name": REPOSITORY_FULL_NAME,
                "name": "standupless",
                "private": private,
                "visibility": "private" if private else "public",
            },
        },
    }


def assert_demoted(repositories: Any) -> None:
    """The link is one way, stamped, and the team feed carries one change."""
    config = repositories.github.get_team_sync(WORKSPACE, TEAM)
    assert config.direction == "github_to_standupless"
    assert config.public_demoted_at is not None
    changes = repositories.activity.list_team_events(WORKSPACE, TEAM)
    assert [(row.field, row.from_value, row.to_value) for row in changes] == [
        ("github_sync_direction", "two_way", "github_to_standupless")
    ]
    assert changes[0].actor_kind == "github"


def test_two_way_sync_with_a_public_repository_is_refused(
    client: TestClient, repositories: Any, installed: str
) -> None:
    """The route answers 422 with the reason, and stores nothing."""
    make_public(repositories)
    sign_in(client, ADMIN)

    response = client.put(SYNC_PATH, json={"repository_id": REPOSITORY_ID, "direction": "two_way"})

    assert response.status_code == 422
    assert PUBLIC_TWO_WAY in response.text
    assert repositories.github.get_team_sync(WORKSPACE, TEAM) is None


def test_one_way_sync_with_a_public_repository_is_allowed(
    client: TestClient, repositories: Any, installed: str
) -> None:
    """GitHub to Standupless writes nothing back, so a public repository may mirror in."""
    make_public(repositories)
    sign_in(client, ADMIN)

    response = client.put(SYNC_PATH, json={"repository_id": REPOSITORY_ID, "direction": "github_to_standupless"})

    assert response.status_code == 200
    assert response.json()["repository_private"] is False
    assert client.get(SYNC_PATH).json()["repository_private"] is False


def test_a_private_repository_reads_as_private(client: TestClient, repositories: Any, installed: str) -> None:
    """The settings read says private, so the UI offers both directions."""
    sign_in(client, ADMIN)

    response = client.put(SYNC_PATH, json={"repository_id": REPOSITORY_ID, "direction": "two_way"})

    assert response.status_code == 200
    assert response.json()["repository_private"] is True
    assert response.json()["public_demoted_at"] is None


def test_a_publicized_delivery_drops_two_way_sync_and_records_it(
    repositories: Any, installed: str, github_env: None
) -> None:
    """The repository turning public demotes the link once, however often GitHub redelivers."""
    link_two_way(repositories)

    events.handle_record(repositories, sqs_record(repository_delivery("publicized", private=False)))
    events.handle_record(repositories, sqs_record(repository_delivery("publicized", private=False)))

    assert repositories.github.get_repository(WORKSPACE, REPOSITORY_ID).private is False
    assert_demoted(repositories)


def test_a_privatized_delivery_keeps_the_link_and_records_visibility(
    repositories: Any, installed: str, github_env: None
) -> None:
    """Turning private changes nothing about the link, but the row follows."""
    make_public(repositories)
    repositories.github.put_team_sync(
        TeamSync(
            workspace_id=WORKSPACE,
            github_key=team_sync_key(TEAM),
            team_id=TEAM,
            repository_id=REPOSITORY_ID,
            full_name=REPOSITORY_FULL_NAME,
            direction="github_to_standupless",
            enabled=True,
            created_by=ADMIN,
        )
    )

    events.handle_record(repositories, sqs_record(repository_delivery("privatized", private=True)))

    assert repositories.github.get_repository(WORKSPACE, REPOSITORY_ID).private is True
    assert repositories.github.get_team_sync(WORKSPACE, TEAM).direction == "github_to_standupless"
    assert repositories.activity.list_team_events(WORKSPACE, TEAM) == []


def test_a_repository_refresh_that_finds_it_public_drops_two_way_sync(repositories: Any, installed: str) -> None:
    """The installation's repository list is the other way a visibility change arrives."""
    link_two_way(repositories)

    installs.apply_repository_changes(
        repositories,
        WORKSPACE,
        INSTALLATION_ID,
        added=[{"id": int(REPOSITORY_ID), "full_name": REPOSITORY_FULL_NAME, "name": "standupless", "private": False}],
        removed=[],
    )

    assert_demoted(repositories)


def test_saving_the_link_again_keeps_the_demotion_stamp(
    client: TestClient, repositories: Any, installed: str, github_env: None
) -> None:
    """The settings page keeps showing why the link is one way after another save."""
    link_two_way(repositories)
    events.handle_record(repositories, sqs_record(repository_delivery("publicized", private=False)))
    sign_in(client, ADMIN)

    response = client.put(SYNC_PATH, json={"repository_id": REPOSITORY_ID, "direction": "github_to_standupless"})

    assert response.status_code == 200
    assert response.json()["public_demoted_at"] is not None
