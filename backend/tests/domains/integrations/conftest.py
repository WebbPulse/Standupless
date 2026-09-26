"""Fixtures the integrations tests share: a configured App, a tenant, and queues.

The GitHub credentials are set as environment variables rather than through a
mocked Secrets Manager because `_resolve_secret` reads the environment first, so
this exercises the same resolution path a deployed function takes without any
secret leaving the test.

No test here reaches GitHub. `github_api` is patched at the boundary, which is the
only place an outbound call is made, so a test that starts making one fails rather
than silently talking to the internet.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient
from webbpulse.integrations.github import AppInstallation

from app.common.composition.domains import DOMAINS
from app.common.composition.wiring import build_domain_app
from app.common.db.dynamo.github import Installation, Repository_, install_key, repo_key
from app.common.db.dynamo.issues import Issue
from tests.domains.helpers import (
    ADMIN,
    GUEST,
    MEMBER,
    OUTSIDER,
    OWNER,
    add_member,
    add_team_member,
    make_team,
    make_user,
    make_workspace,
)

WORKSPACE = "01JB00000000000000000000WS"

OTHER_WORKSPACE = "01JB00000000000000000WS2"

TEAM = "01JB000000000000000000PRJ1"

OTHER_TEAM = "01JB000000000000000000PRJ2"

INSTALLATION_ID = "44551122"

REPOSITORY_ID = "9001"

REPOSITORY_FULL_NAME = "WebbPulse/standupless"

WEBHOOK_SECRET = "a-test-webhook-secret"

APP_SLUG = "standupless-test"


@dataclass(frozen=True)
class DatedInstallation(AppInstallation):
    """An `AppInstallation` that also carries the two timestamps GitHub reports.

    The shared model does not carry `created_at` or `updated_at` yet, and the bind's
    freshness check reads them by name, so the fake answers with them the way a
    newer shared client would.
    """

    created_at: str | None = None
    updated_at: str | None = None


class FakeInstallationClient:
    """Stands in for `GitHubAppClient` on the installation reads the bind makes.

    `installation` is the raw record GitHub would answer, so a test edits a field
    the way GitHub would report it. `clients` counts clients opened, one per unit of
    work, and `listed` records which installation each repository list was for.
    """

    def __init__(self, installation: dict[str, Any], repositories: list[dict[str, Any]]) -> None:
        """Answer for one installation and its repositories."""
        self.installation = installation
        self.repositories = repositories
        self.status: int | None = None
        self.missing: set[str] = set()
        self.clients = 0
        self.listed: list[str] = []

    def open(self) -> FakeInstallationClient:
        """Count one client opened for a unit of work."""
        self.clients += 1
        return self

    def __enter__(self) -> FakeInstallationClient:
        """Enter the unit of work."""
        return self

    def __exit__(self, *exc: object) -> None:
        """Leave the unit of work; there is nothing to close."""

    def get_app_installation(self, installation_id: int | str) -> DatedInstallation:
        """Answer the installation, or the error the test set."""
        from app.domains.integrations import github_api

        if str(installation_id) in self.missing or self.status == 404:
            raise github_api.GitHubNotFound("gone", status_code=404)
        if self.status is not None:
            raise github_api.GitHubError("refused", status_code=self.status)
        raw = self.installation
        account = raw.get("account") or {}
        return DatedInstallation(
            id=int(raw.get("id", installation_id)),
            app_id=int(raw.get("app_id", 0)),
            account_login=str(account.get("login", "")),
            account_type=str(account.get("type", "")),
            account_avatar_url=str(account.get("avatar_url", "")),
            repository_selection=str(raw.get("repository_selection", "")),
            html_url=str(raw.get("html_url", "")),
            permissions={},
            suspended_at=raw.get("suspended_at"),
            created_at=raw.get("created_at"),
            updated_at=raw.get("updated_at"),
        )

    def list_installation_repositories(self, installation_id: int | str) -> list[dict[str, Any]]:
        """Answer the repositories the installation can see."""
        from app.domains.integrations import github_api

        self.listed.append(str(installation_id))
        if self.status is not None:
            raise github_api.GitHubError("refused", status_code=self.status)
        return self.repositories


@pytest.fixture
def github_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """A fully configured GitHub App, and the two queue urls, for one test.

    The private key is a syntactically valid placeholder rather than a usable one:
    nothing in these tests signs with it, because every call that would is patched
    at `github_api`.
    """
    monkeypatch.setenv("GITHUB_APP_ID", "123456")
    monkeypatch.setenv("GITHUB_CLIENT_ID", "Iv1.testclientid")
    monkeypatch.setenv("GITHUB_CLIENT_SECRET", "a-test-client-secret")
    monkeypatch.setenv(
        "GITHUB_PRIVATE_KEY", "-----BEGIN RSA PRIVATE KEY-----\nnot-a-real-key\n-----END RSA PRIVATE KEY-----"
    )
    monkeypatch.setenv("GITHUB_WEBHOOK_SECRET", WEBHOOK_SECRET)
    monkeypatch.setenv("WEBHOOK_SIGNING_KEY", "dGVzdC1zaWduaW5nLWtleS1ub3QtYS1yZWFsLW9uZQ==")

    from app.common.core.config import settings

    monkeypatch.setattr(settings, "GITHUB_APP_SLUG", APP_SLUG, raising=False)
    monkeypatch.setattr(settings, "GITHUB_EVENTS_QUEUE_URL", "https://sqs.test/github-events", raising=False)
    monkeypatch.setattr(settings, "WEBHOOK_DISPATCH_QUEUE_URL", "https://sqs.test/webhook-dispatch", raising=False)
    yield


@pytest.fixture
def enqueued(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, Any]]:
    """Every message the code under test enqueues, instead of an SQS call.

    Patched in both modules that enqueue, because each imports `enqueue` into its
    own namespace and patching one would leave the other reaching for a queue.
    """
    sent: list[tuple[str, Any]] = []

    def record(queue_url: str, envelope: Any, **kwargs: Any) -> str:
        """Capture one enqueue and hand back a delivery id."""
        sent.append((queue_url, envelope))
        return "test-message-id"

    import app.domains.integrations.endpoints.github as github_endpoint

    monkeypatch.setattr(github_endpoint, "enqueue", record)
    monkeypatch.setattr("webbpulse.events.enqueue", record)
    return sent


@pytest.fixture
def client(repositories: Any, github_env: None) -> Iterator[TestClient]:
    """A client for the integrations application, bound to the mocked tables."""
    from app.common.api.dependencies.repositories import bind_repositories

    app = build_domain_app(DOMAINS["integrations"])
    bind_repositories(app, repositories)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def workspace(repositories: Any) -> str:
    """A workspace with two teams and one member of each workspace role.

    The guest holds a membership in `TEAM` alone, so `OTHER_TEAM` is what a
    fail-closed read has to miss.
    """
    make_workspace(repositories, WORKSPACE, "acme", OWNER)
    add_member(repositories, WORKSPACE, ADMIN, "admin")
    add_member(repositories, WORKSPACE, MEMBER, "member")
    add_member(repositories, WORKSPACE, GUEST, "guest")
    make_user(repositories, OWNER, "owner@example.com", "Olive Owner")
    make_user(repositories, ADMIN, "admin@example.com", "Adam Admin")
    make_user(repositories, MEMBER, "member@example.com", "Mel Member")
    make_user(repositories, GUEST, "guest@example.com", "Gus Guest")
    make_user(repositories, OUTSIDER, "outsider@example.com", "Ozzy Outsider")
    make_team(repositories, WORKSPACE, TEAM, "ABC")
    make_team(repositories, WORKSPACE, OTHER_TEAM, "XYZ")
    add_team_member(repositories, WORKSPACE, TEAM, GUEST, "member")
    return WORKSPACE


@pytest.fixture
def installed(repositories: Any, workspace: str) -> str:
    """One recorded installation with one repository, pinned to no team."""
    from app.common.db.dynamo.base import utc_now

    repositories.github.create_installation(
        Installation(
            workspace_id=workspace,
            github_key=install_key(INSTALLATION_ID),
            installation_id=INSTALLATION_ID,
            account_login="WebbPulse",
            installed_by=OWNER,
            installed_at=utc_now(),
        )
    )
    repositories.github.put_repository(
        Repository_(
            workspace_id=workspace,
            github_key=repo_key(REPOSITORY_ID),
            repository_id=REPOSITORY_ID,
            installation_id=INSTALLATION_ID,
            full_name=REPOSITORY_FULL_NAME,
            name="standupless",
            linked_at=utc_now(),
        )
    )
    return INSTALLATION_ID


def seed_issue(
    repositories: Any,
    workspace_id: str,
    team_id: str,
    issue_id: str,
    prefix: str,
    number: int = 1,
) -> Issue:
    """Put one issue row in, so a key found in a branch has something to resolve to."""
    statuses = repositories.team_config.list_statuses(workspace_id, team_id)
    return repositories.issues.create(
        Issue(
            workspace_id=workspace_id,
            issue_id=issue_id,
            team_id=team_id,
            key=f"{prefix}-{number}",
            number=number,
            title="An issue",
            status_id=statuses[0].status_id,
            created_by=OWNER,
        )
    )


@pytest.fixture
def issue(repositories: Any, workspace: str) -> Issue:
    """One issue in the team every role can see, keyed `ABC-1`."""
    return seed_issue(repositories, workspace, TEAM, "01JB0000000000000000000IS1", "ABC", 1)


@pytest.fixture
def hidden_issue(repositories: Any, workspace: str) -> Issue:
    """One issue in the team the guest is outside of, keyed `XYZ-1`."""
    return seed_issue(repositories, workspace, OTHER_TEAM, "01JB0000000000000000000IS2", "XYZ", 1)


def sqs_record(payload: Any, *, occurred_at: str | None = None) -> dict[str, Any]:
    """One SQS record carrying an event envelope, as the consumers read it."""
    envelope: dict[str, Any] = {"name": "test", "payload": payload}
    if occurred_at is not None:
        envelope["occurred_at"] = occurred_at
    return {"messageId": "m1", "body": json.dumps(envelope)}
