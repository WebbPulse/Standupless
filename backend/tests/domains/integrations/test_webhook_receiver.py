"""The webhook receiver: signature, replay and the order the two are checked in.

These are the tests that matter most in this domain, because the route is the one
place the product accepts input from outside with no session behind it. Each one
pins a property that a refactor could quietly drop: that a forged body is never
parsed, that a replay does no work twice, and that neither check can be skipped by
leaving a header off.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from typing import Any

import pytest
from fastapi.testclient import TestClient

from tests.domains.integrations.conftest import (
    APP_SLUG,
    INSTALLATION_ID,
    REPOSITORY_FULL_NAME,
    REPOSITORY_ID,
    WEBHOOK_SECRET,
)

PATH = "/api/github/webhooks"


def signature(body: bytes, secret: str = WEBHOOK_SECRET) -> str:
    """The `X-Hub-Signature-256` value GitHub would send for this body."""
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def delivery(payload: Any) -> bytes:
    """A delivery body, serialised exactly once so the signature covers the bytes sent."""
    return json.dumps(payload).encode()


def pull_request_payload(action: str = "opened") -> dict[str, Any]:
    """A minimal `pull_request` delivery."""
    return {
        "action": action,
        "installation": {"id": int(INSTALLATION_ID)},
        "repository": {"id": int(REPOSITORY_ID), "full_name": REPOSITORY_FULL_NAME},
        "pull_request": {
            "number": 7,
            "node_id": "PR_node",
            "title": "ABC-1 a change",
            "body": "",
            "state": "open",
            "merged": False,
            "draft": False,
            "html_url": "https://github.com/WebbPulse/standupless/pull/7",
            "head": {"ref": "abc-1-a-change", "sha": "deadbeef"},
            "user": {"login": "someone"},
        },
    }


def test_a_valid_delivery_is_accepted_and_enqueued(
    client: TestClient,
    enqueued: list[tuple[str, Any]],
) -> None:
    """A signed delivery is answered 202 and handed to the queue, not handled inline."""
    body = delivery(pull_request_payload())
    response = client.post(
        PATH,
        content=body,
        headers={
            "X-Hub-Signature-256": signature(body),
            "X-GitHub-Event": "pull_request",
            "X-GitHub-Delivery": "delivery-1",
            "Content-Type": "application/json",
        },
    )

    assert response.status_code == 202
    assert response.json() == {"accepted": True}
    assert len(enqueued) == 1


def test_a_forged_signature_is_rejected(client: TestClient, enqueued: list[tuple[str, Any]]) -> None:
    """A body signed with the wrong secret is refused and never reaches the queue."""
    body = delivery(pull_request_payload())
    response = client.post(
        PATH,
        content=body,
        headers={
            "X-Hub-Signature-256": signature(body, "not-the-secret"),
            "X-GitHub-Event": "pull_request",
            "X-GitHub-Delivery": "delivery-forged",
            "Content-Type": "application/json",
        },
    )

    assert response.status_code == 401
    assert response.json()["error_code"] == "INVALID_SIGNATURE"
    assert enqueued == []


def test_a_missing_signature_header_is_rejected(client: TestClient, enqueued: list[tuple[str, Any]]) -> None:
    """A delivery with no signature at all is refused, not treated as unsigned and allowed."""
    body = delivery(pull_request_payload())
    response = client.post(
        PATH,
        content=body,
        headers={
            "X-GitHub-Event": "pull_request",
            "X-GitHub-Delivery": "delivery-unsigned",
            "Content-Type": "application/json",
        },
    )

    assert response.status_code == 401
    assert enqueued == []


def test_a_tampered_body_is_rejected(client: TestClient, enqueued: list[tuple[str, Any]]) -> None:
    """A body changed after signing no longer verifies, which is the whole point."""
    body = delivery(pull_request_payload())
    tampered = body.replace(b'"number": 7', b'"number": 8')
    response = client.post(
        PATH,
        content=tampered,
        headers={
            "X-Hub-Signature-256": signature(body),
            "X-GitHub-Event": "pull_request",
            "X-GitHub-Delivery": "delivery-tampered",
            "Content-Type": "application/json",
        },
    )

    assert response.status_code == 401
    assert enqueued == []


def test_unparseable_json_never_reaches_the_parser_unsigned(
    client: TestClient,
    enqueued: list[tuple[str, Any]],
) -> None:
    """Malformed input is refused on the signature, before anything tries to parse it.

    The signature is checked over raw bytes, so a body that is not JSON at all is a
    401 rather than a 500 from a parser that ran on attacker controlled input.
    """
    response = client.post(
        PATH,
        content=b"{not json at all",
        headers={
            "X-Hub-Signature-256": "sha256=" + "00" * 32,
            "X-GitHub-Event": "pull_request",
            "X-GitHub-Delivery": "delivery-garbage",
            "Content-Type": "application/json",
        },
    )

    assert response.status_code == 401
    assert enqueued == []


def test_a_replayed_delivery_short_circuits(client: TestClient, enqueued: list[tuple[str, Any]]) -> None:
    """The same delivery id twice enqueues once, so a redelivery repeats no work."""
    body = delivery(pull_request_payload())
    headers = {
        "X-Hub-Signature-256": signature(body),
        "X-GitHub-Event": "pull_request",
        "X-GitHub-Delivery": "delivery-replayed",
        "Content-Type": "application/json",
    }

    first = client.post(PATH, content=body, headers=headers)
    second = client.post(PATH, content=body, headers=headers)

    assert first.status_code == 202
    assert second.status_code == 200
    assert second.json() == {"accepted": False, "reason": "duplicate"}
    assert len(enqueued) == 1


def test_an_irrelevant_event_is_acknowledged_but_not_queued(
    client: TestClient,
    enqueued: list[tuple[str, Any]],
) -> None:
    """An event outside the allowlist is answered 200 so GitHub stops resending it."""
    body = delivery({"action": "created", "installation": {"id": int(INSTALLATION_ID)}})
    response = client.post(
        PATH,
        content=body,
        headers={
            "X-Hub-Signature-256": signature(body),
            "X-GitHub-Event": "star",
            "X-GitHub-Delivery": "delivery-ignored",
            "Content-Type": "application/json",
        },
    )

    assert response.status_code == 200
    assert response.json()["reason"] == "ignored"
    assert enqueued == []


def test_a_repository_event_is_queued(client: TestClient, enqueued: list[tuple[str, Any]]) -> None:
    """A `repository` delivery is accepted, so a rename refreshes the stored names if the App subscribes."""
    body = delivery(
        {
            "action": "renamed",
            "installation": {"id": int(INSTALLATION_ID)},
            "repository": {"id": 1, "full_name": "WebbPulse/renamed", "name": "renamed"},
        }
    )
    response = client.post(
        PATH,
        content=body,
        headers={
            "X-Hub-Signature-256": signature(body),
            "X-GitHub-Event": "repository",
            "X-GitHub-Delivery": "delivery-renamed",
            "Content-Type": "application/json",
        },
    )

    assert response.status_code == 202
    assert len(enqueued) == 1


def test_the_receiver_reports_not_configured_without_a_secret(
    repositories: Any,
    monkeypatch: Any,
) -> None:
    """An environment whose secret is unfilled refuses rather than accepting unsigned input."""
    from app.common.api.dependencies.repositories import bind_repositories
    from app.common.composition.domains import DOMAINS
    from app.common.composition.wiring import build_domain_app
    from app.common.core.config import settings

    monkeypatch.setenv("GITHUB_WEBHOOK_SECRET", "")
    monkeypatch.setattr(settings, "APP_SECRETS_ARN", "", raising=False)

    app = build_domain_app(DOMAINS["integrations"])
    bind_repositories(app, repositories)
    with TestClient(app) as unconfigured:
        response = unconfigured.post(PATH, content=b"{}", headers={"Content-Type": "application/json"})

    assert response.status_code == 503


@pytest.mark.parametrize("event", ["issues", "issue_comment"])
def test_a_signed_issue_sync_event_is_queued(
    client: TestClient,
    enqueued: list[tuple[str, Any]],
    event: str,
) -> None:
    """The two issue sync events are accepted and queued like a pull request event."""
    body = delivery({"action": "opened", "installation": {"id": int(INSTALLATION_ID)}, "issue": {"number": 1}})
    response = client.post(
        PATH,
        content=body,
        headers={
            "X-Hub-Signature-256": signature(body),
            "X-GitHub-Event": event,
            "X-GitHub-Delivery": f"delivery-{event}",
            "Content-Type": "application/json",
        },
    )

    assert response.status_code == 202
    assert len(enqueued) == 1


@pytest.mark.parametrize("event", ["issues", "issue_comment"])
def test_an_unsigned_issue_sync_event_is_refused(
    client: TestClient,
    enqueued: list[tuple[str, Any]],
    event: str,
) -> None:
    """A bad signature on an issue event is refused before anything is queued."""
    body = delivery({"action": "opened", "installation": {"id": int(INSTALLATION_ID)}})
    response = client.post(
        PATH,
        content=body,
        headers={
            "X-Hub-Signature-256": "sha256=" + "00" * 32,
            "X-GitHub-Event": event,
            "X-GitHub-Delivery": f"delivery-forged-{event}",
            "Content-Type": "application/json",
        },
    )

    assert response.status_code == 401
    assert enqueued == []


def test_a_failed_enqueue_releases_the_claim_so_a_redelivery_is_queued(
    client: TestClient,
    enqueued: list[tuple[str, Any]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A queue outage answers an error and frees the delivery id for GitHub's redelivery."""
    import app.domains.integrations.endpoints.github as github_endpoint

    recorder = github_endpoint.enqueue

    def refuse(queue_url: str, envelope: Any, **kwargs: Any) -> str:
        """Fail the way an SQS outage does."""
        raise RuntimeError("queue unavailable")

    body = delivery(pull_request_payload())
    headers = {
        "X-Hub-Signature-256": signature(body),
        "X-GitHub-Event": "pull_request",
        "X-GitHub-Delivery": "delivery-enqueue-failed",
        "Content-Type": "application/json",
    }

    monkeypatch.setattr(github_endpoint, "enqueue", refuse)
    with pytest.raises(RuntimeError):
        client.post(PATH, content=body, headers=headers)
    assert enqueued == []

    monkeypatch.setattr(github_endpoint, "enqueue", recorder)
    redelivered = client.post(PATH, content=body, headers=headers)

    assert redelivered.status_code == 202
    assert len(enqueued) == 1


def check_run_payload(
    *, pull_requests: list[dict[str, Any]], app: str = "ci", status: str = "completed"
) -> dict[str, Any]:
    """A minimal `check_run` delivery."""
    return {
        "action": "completed" if status == "completed" else "created",
        "installation": {"id": int(INSTALLATION_ID)},
        "repository": {"id": int(REPOSITORY_ID), "full_name": REPOSITORY_FULL_NAME},
        "check_run": {
            "id": 1,
            "name": "tests",
            "status": status,
            "conclusion": "success" if status == "completed" else None,
            "head_sha": "deadbeef",
            "app": {"slug": app},
            "pull_requests": pull_requests,
        },
    }


def post_check_run(client: TestClient, payload: dict[str, Any], delivery_id: str) -> Any:
    """Post one signed `check_run` delivery."""
    body = delivery(payload)
    return client.post(
        PATH,
        content=body,
        headers={
            "X-Hub-Signature-256": signature(body),
            "X-GitHub-Event": "check_run",
            "X-GitHub-Delivery": delivery_id,
            "Content-Type": "application/json",
        },
    )


def test_a_check_run_on_a_pull_request_is_queued(client: TestClient, enqueued: list[tuple[str, Any]]) -> None:
    """A check run naming a pull request may move a linked pull request's checks, so it is queued."""
    response = post_check_run(client, check_run_payload(pull_requests=[{"number": 7}]), "check-1")

    assert response.status_code == 202
    assert len(enqueued) == 1


def test_a_check_run_on_no_pull_request_or_from_this_app_is_not_queued(
    client: TestClient,
    enqueued: list[tuple[str, Any]],
) -> None:
    """A trunk commit's running checks and the App's own check are answered without touching the queue."""
    trunk = post_check_run(client, check_run_payload(pull_requests=[], status="in_progress"), "check-2")
    own = post_check_run(client, check_run_payload(pull_requests=[{"number": 7}], app=APP_SLUG), "check-3")

    assert (trunk.status_code, own.status_code) == (200, 200)
    assert trunk.json()["reason"] == own.json()["reason"] == "ignored"
    assert enqueued == []


def test_a_finished_check_run_naming_no_pull_request_is_queued(
    client: TestClient,
    enqueued: list[tuple[str, Any]],
) -> None:
    """A check that finishes after its pull request merged names none, and is queued to find it by commit."""
    response = post_check_run(client, check_run_payload(pull_requests=[]), "check-4")

    assert response.status_code == 202
    assert len(enqueued) == 1
