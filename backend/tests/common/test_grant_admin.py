"""The operator command that grants and revokes the platform admin flag."""

from __future__ import annotations

from typing import Any

import pytest
from webbpulse.audit import AuditQuery

from app.common.core.config import settings
from scripts.grant_admin import (
    GRANTED,
    INACTIVE,
    LAST_ADMIN,
    NOT_FOUND,
    REVOKED,
    UNCHANGED,
    find_user,
    grant,
    main,
    revoke,
)
from tests.domains.helpers import OWNER, make_user, make_workspace

WORKSPACE = "01JB00000000000000000000WS"

OTHER = "01JB00000000000000000OTHER"

EMAIL = "owner@example.com"


def _stage() -> str:
    """The stage name the test tables answer to."""
    return settings.dynamodb_table_prefix.removeprefix("standupless-")


def _events(repositories: Any) -> list[Any]:
    """The workspace's audit rows, newest first."""
    return repositories.audit.list_events(WORKSPACE, AuditQuery(), limit=50).events


@pytest.fixture
def person(repositories: Any) -> Any:
    """A person in one workspace who is not yet an admin."""
    user = make_user(repositories, OWNER, EMAIL, "Owner")
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    return user


def test_a_grant_sets_the_flag_and_records_it(repositories: Any, person: Any) -> None:
    """The grant writes `is_admin` and an audit row in the person's workspace, once."""
    assert grant(repositories, person, apply=True) == GRANTED
    assert repositories.users.get(OWNER).is_admin is True

    events = _events(repositories)
    assert [row.action for row in events] == ["platform_admin.granted"]
    assert (events[0].target.type, events[0].target.id) == ("user", OWNER)
    assert (events[0].before, events[0].after) == ({"is_admin": False}, {"is_admin": True})
    assert events[0].actor.id == "grant-admin"

    assert grant(repositories, repositories.users.get(OWNER), apply=True) == UNCHANGED
    assert len(_events(repositories)) == 1


def test_a_dry_run_writes_nothing(repositories: Any, person: Any) -> None:
    """Without `apply` the outcome is reported and neither the row nor the log changes."""
    assert grant(repositories, person, apply=False) == GRANTED
    assert repositories.users.get(OWNER).is_admin is False
    assert _events(repositories) == []


def test_the_last_admin_cannot_be_revoked(repositories: Any, person: Any) -> None:
    """Revoking the only admin who can sign in is refused, and allowed once another exists."""
    repositories.users.update(OWNER, is_admin=True)
    assert revoke(repositories, repositories.users.get(OWNER), apply=True) == LAST_ADMIN
    assert repositories.users.get(OWNER).is_admin is True

    make_user(repositories, OTHER, "other@example.com")
    repositories.users.update(OTHER, is_admin=True, disabled=True)
    assert revoke(repositories, repositories.users.get(OWNER), apply=True) == LAST_ADMIN

    repositories.users.update(OTHER, disabled=False)
    assert revoke(repositories, repositories.users.get(OWNER), apply=True) == REVOKED
    assert repositories.users.get(OWNER).is_admin is False
    assert [row.action for row in _events(repositories)] == ["platform_admin.revoked"]
    assert revoke(repositories, repositories.users.get(OWNER), apply=True) == UNCHANGED


def test_unknown_and_inactive_people_are_refused(repositories: Any, person: Any) -> None:
    """No row means no change, and a disabled account is never made an admin."""
    assert grant(repositories, None, apply=True) == NOT_FOUND
    assert revoke(repositories, None, apply=True) == NOT_FOUND
    disabled = repositories.users.update(OWNER, disabled=True)
    assert grant(repositories, disabled, apply=True) == INACTIVE
    assert repositories.users.get(OWNER).is_admin is False


def test_a_person_is_found_by_id_or_email(repositories: Any, person: Any) -> None:
    """The email lookup ignores case, and an unknown id finds no one."""
    assert find_user(repositories, user_id=OWNER).id == OWNER
    assert find_user(repositories, email=EMAIL.upper()).id == OWNER
    assert find_user(repositories, user_id="missing") is None


def test_the_command_line_is_a_dry_run_unless_applied(
    repositories: Any, person: Any, capsys: pytest.CaptureFixture[str]
) -> None:
    """The command prints the id and outcome, never the email, and writes only with `--apply`."""
    assert main(["--stage", _stage(), "--email", EMAIL]) == 0
    printed = capsys.readouterr().out.strip()
    assert printed == f"dry-run grant user={OWNER} outcome=granted"
    assert EMAIL not in printed
    assert repositories.users.get(OWNER).is_admin is False

    assert main(["--stage", _stage(), "--user-id", OWNER, "--apply"]) == 0
    assert repositories.users.get(OWNER).is_admin is True

    assert main(["--stage", _stage(), "--user-id", OWNER, "--revoke", "--apply"]) == 1
    assert capsys.readouterr().out.strip().splitlines()[-1] == f"revoke user={OWNER} outcome=last_admin"

    assert main(["--stage", _stage(), "--user-id", "missing", "--apply"]) == 1
    assert capsys.readouterr().out.strip() == "grant user=missing outcome=user_not_found"
