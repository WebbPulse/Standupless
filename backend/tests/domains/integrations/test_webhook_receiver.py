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

from fastapi.testclient import TestClient

from tests.domains.integrations.conftest import (
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
            "X-GitHub-Event": "issue_comment",
            "X-GitHub-Delivery": "delivery-ignored",
            "Content-Type": "application/json",
        },
    )

    assert response.status_code == 200
    assert response.json()["reason"] == "ignored"
    assert enqueued == []


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
