"""Outbound webhook management routes, and what happens to the secret.

The property worth pinning here is that the secret an admin is shown is the key
deliveries are actually signed with, and that it is shown once and never stored.
A refactor that split those two apart would leave every receiver unable to verify
anything, and no other test would notice.

No request leaves the test: hostnames resolve through the `public_dns` fixture, and
the sender behind ping and redeliver is replaced with one that records the request.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from typing import Any

import pytest
from fastapi.testclient import TestClient
from webbpulse.events.webhooks import WebhookResponse

from tests.domains.helpers import ADMIN, GUEST, MEMBER, add_team_member, sign_in
from tests.domains.integrations.conftest import OTHER_TEAM, TEAM, WORKSPACE

PATH = f"/api/workspaces/{WORKSPACE}/webhooks"
TEAM_PATH = f"/api/workspaces/{WORKSPACE}/teams/{TEAM}/webhooks"
OTHER_TEAM_PATH = f"/api/workspaces/{WORKSPACE}/teams/{OTHER_TEAM}/webhooks"


class RecordingSender:
    """A sender that records each request and answers with a fixed status."""

    def __init__(self, status_code: int = 200, body: str = "ok") -> None:
        """Start with nothing sent."""
        self.sent: list[tuple[str, bytes, dict[str, str]]] = []
        self.status_code = status_code
        self.body = body

    def post(self, url: str, *, body: bytes, headers: Any, timeout: float) -> WebhookResponse:
        """Record one request and answer with the configured response."""
        self.sent.append((url, body, dict(headers)))
        return WebhookResponse(status_code=self.status_code, body=self.body)


@pytest.fixture
def sender(monkeypatch: pytest.MonkeyPatch) -> RecordingSender:
    """Replace the pinned HTTPS sender the ping and redeliver routes use."""
    fake = RecordingSender()
    monkeypatch.setattr("app.domains.integrations.outbound.delivery.PinnedHttpsSender", lambda *a, **k: fake)
    return fake


def create(
    client: TestClient,
    url: str = "https://example.test/hook",
    *,
    path: str = PATH,
    **extra: Any,
) -> dict[str, Any]:
    """Register one webhook and hand back the create response body."""
    body = {"url": url, "label": "Receiver", "resource_types": ["issues"], **extra}
    response = client.post(path, json=body)
    assert response.status_code == 201, response.text
    return response.json()


def test_creating_a_webhook_shows_the_secret_once(client: TestClient, workspace: str) -> None:
    """The create response carries the secret, because nothing can show it later."""
    sign_in(client, ADMIN)

    created = create(client)

    assert created["secret"].startswith("whsec_")
    assert created["secret_hint"] == created["secret"][-4:]
    assert created["label"] == "Receiver"
    assert created["resource_types"] == ["issues"]
    assert created["enabled"] is True
    assert created["team_id"] is None


def test_the_secret_is_never_shown_again(client: TestClient, workspace: str) -> None:
    """A later read carries the hint and never the secret."""
    sign_in(client, ADMIN)
    create(client)

    listed = client.get(PATH).json()

    assert len(listed) == 1
    assert listed[0].get("secret") is None
    assert listed[0]["secret_hint"]


def test_the_secret_is_not_stored_in_the_table(client: TestClient, workspace: str, repositories: Any) -> None:
    """The row holds a salt, a digest and a hint, and no usable secret."""
    sign_in(client, ADMIN)
    created = create(client)

    stored = repositories.github.get_endpoint(WORKSPACE, created["webhook_id"])

    assert stored is not None
    assert created["secret"] not in stored.model_dump_json()


def test_the_shown_secret_signs_deliveries(client: TestClient, workspace: str, sender: RecordingSender) -> None:
    """A receiver holding the secret exactly as shown verifies what it is sent.

    Recomputed the way `webbpulse.events.webhooks` documents it, over the timestamp
    header and the body, so a change on either side fails this.
    """
    sign_in(client, ADMIN)
    created = create(client)

    assert client.post(f"{PATH}/{created['webhook_id']}/ping", json={}).status_code == 200

    _url, body, headers = sender.sent[0]
    message = f"{headers['X-Webhook-Timestamp']}.".encode() + body
    expected = hmac.new(created["secret"].encode(), message, hashlib.sha256).hexdigest()
    assert headers["X-Webhook-Signature"] == f"sha256={expected}"
    assert headers["X-Webhook-Delivery"]
    assert headers["User-Agent"].startswith("Standupless-Webhooks")


def test_rotating_changes_the_signing_secret(client: TestClient, workspace: str, sender: RecordingSender) -> None:
    """A rotate invalidates the old secret: the next delivery no longer verifies with it."""
    sign_in(client, ADMIN)
    created = create(client)
    webhook_id = created["webhook_id"]

    rotated = client.post(f"{PATH}/{webhook_id}/rotate", json={})
    assert rotated.status_code == 200
    assert rotated.json()["secret"] != created["secret"]

    client.post(f"{PATH}/{webhook_id}/ping", json={})
    _url, body, headers = sender.sent[0]
    message = f"{headers['X-Webhook-Timestamp']}.".encode() + body
    new = hmac.new(rotated.json()["secret"].encode(), message, hashlib.sha256).hexdigest()
    old = hmac.new(created["secret"].encode(), message, hashlib.sha256).hexdigest()
    assert headers["X-Webhook-Signature"] == f"sha256={new}"
    assert headers["X-Webhook-Signature"] != f"sha256={old}"


def test_a_webhook_must_use_https(client: TestClient, workspace: str) -> None:
    """A plaintext webhook would put a signed payload on the wire in the clear."""
    sign_in(client, ADMIN)

    response = client.post(PATH, json={"url": "http://example.test/hook", "label": "x", "resource_types": ["issues"]})

    assert response.status_code == 422


@pytest.mark.parametrize(
    "url",
    [
        "https://10.0.0.1/hook",
        "https://127.0.0.1/hook",
        "https://169.254.169.254/latest/meta-data",
        "https://[::1]/hook",
        "https://localhost/hook",
        "https://user:pass@example.test/hook",
    ],
)
def test_a_private_or_loopback_url_is_refused_on_save(client: TestClient, workspace: str, url: str) -> None:
    """The SSRF guard runs when a URL is saved, answering with a code the form can show."""
    sign_in(client, ADMIN)

    response = client.post(PATH, json={"url": url, "label": "x", "resource_types": ["issues"]})

    assert response.status_code == 422
    assert "UNSAFE_URL" in response.text


def test_a_hostname_resolving_to_a_private_address_is_refused(
    client: TestClient, workspace: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The check is on what the name resolves to, not only on how the URL is spelled."""
    monkeypatch.setattr("app.domains.integrations.outbound.ssrf.resolve_host", lambda host, port: ["10.1.2.3"])
    sign_in(client, ADMIN)

    response = client.post(PATH, json={"url": "https://internal.test/hook", "label": "x", "resource_types": ["issues"]})

    assert response.status_code == 422
    assert "UNSAFE_URL" in response.text


def test_an_unsafe_url_is_refused_on_update(client: TestClient, workspace: str) -> None:
    """An edit is held to the same rule as a create."""
    sign_in(client, ADMIN)
    created = create(client)

    response = client.patch(f"{PATH}/{created['webhook_id']}", json={"url": "https://192.168.0.10/hook"})

    assert response.status_code == 422


def test_an_unknown_resource_type_is_refused(client: TestClient, workspace: str) -> None:
    """Subscribing to a resource type that will never fire is a mistake worth reporting."""
    sign_in(client, ADMIN)

    response = client.post(PATH, json={"url": "https://example.test/hook", "label": "x", "resource_types": ["users"]})

    assert response.status_code == 422


def test_at_least_one_resource_type_is_required(client: TestClient, workspace: str) -> None:
    """A webhook that hears nothing is refused rather than saved silent."""
    sign_in(client, ADMIN)

    response = client.post(PATH, json={"url": "https://example.test/hook", "label": "x", "resource_types": []})

    assert response.status_code == 422


def test_a_webhook_can_be_disabled_and_deleted(client: TestClient, workspace: str) -> None:
    """Disabling stops deliveries, and deleting forgets the webhook."""
    sign_in(client, ADMIN)
    webhook_id = create(client)["webhook_id"]

    patched = client.patch(f"{PATH}/{webhook_id}", json={"enabled": False})
    assert patched.status_code == 200
    assert patched.json()["enabled"] is False

    assert client.delete(f"{PATH}/{webhook_id}").status_code == 204
    assert client.get(PATH).json() == []


def test_re_enabling_clears_the_auto_disable_notice(client: TestClient, workspace: str, repositories: Any) -> None:
    """Turning an auto-disabled webhook back on resets its failure run and its notice."""
    sign_in(client, ADMIN)
    webhook_id = create(client)["webhook_id"]
    repositories.github.update_endpoint(
        WORKSPACE,
        webhook_id,
        active=False,
        consecutive_failures=5,
        disabled_reason="Disabled after 5 failed deliveries in a row.",
        disabled_at="2026-09-26T00:00:00+00:00",
    )
    before = client.get(PATH).json()[0]
    assert before["disabled_reason"]

    after = client.patch(f"{PATH}/{webhook_id}", json={"enabled": True}).json()

    assert after["enabled"] is True
    assert after["consecutive_failures"] == 0
    assert after["disabled_reason"] is None
    assert after["disabled_at"] is None


def test_deleting_an_unknown_webhook_is_404(client: TestClient, workspace: str) -> None:
    """An id that names nothing answers the same way one in another workspace would."""
    sign_in(client, ADMIN)

    assert client.delete(f"{PATH}/01JB00000000000000000NONE").status_code == 404


def test_a_webhook_of_another_workspace_is_not_reachable_by_id(
    client: TestClient,
    workspace: str,
    repositories: Any,
) -> None:
    """Every read is workspace first, so another tenant's id resolves to nothing."""
    from app.common.db.dynamo.base import utc_now
    from app.common.db.dynamo.github import WebhookEndpoint, new_webhook_id, webhook_key

    other_id = new_webhook_id()
    repositories.github.create_endpoint(
        WebhookEndpoint(
            workspace_id="01JB0000000000000000OTHERW",
            github_key=webhook_key(other_id),
            webhook_id=other_id,
            url="https://elsewhere.test/hook",
            resource_types=["issues"],
            created_by=ADMIN,
            created_at=utc_now(),
            updated_at=utc_now(),
        )
    )
    sign_in(client, ADMIN)

    assert client.delete(f"{PATH}/{other_id}").status_code == 404
    assert client.get(PATH).json() == []


def test_a_workspace_webhook_can_be_scoped_to_one_team(client: TestClient, workspace: str) -> None:
    """A workspace admin may pin a webhook to a team, and unpin it with an explicit null."""
    sign_in(client, ADMIN)
    created = create(client, team_id=TEAM)
    assert created["team_id"] == TEAM

    cleared = client.patch(f"{PATH}/{created['webhook_id']}", json={"team_id": None})

    assert cleared.status_code == 200
    assert cleared.json()["team_id"] is None


def test_an_unknown_team_is_refused(client: TestClient, workspace: str) -> None:
    """A webhook cannot be pinned to a team that does not exist."""
    sign_in(client, ADMIN)

    response = client.post(
        PATH,
        json={"url": "https://example.test/hook", "label": "x", "resource_types": ["issues"], "team_id": "nope"},
    )

    assert response.status_code == 422
    assert "UNKNOWN_TEAM" in response.text


def test_a_team_route_creates_a_webhook_for_that_team(client: TestClient, workspace: str) -> None:
    """The path decides the team, and the workspace list shows the result too."""
    sign_in(client, ADMIN)

    created = create(client, path=TEAM_PATH)

    assert created["team_id"] == TEAM
    assert [row["webhook_id"] for row in client.get(PATH).json()] == [created["webhook_id"]]
    assert [row["webhook_id"] for row in client.get(TEAM_PATH).json()] == [created["webhook_id"]]
    assert client.get(OTHER_TEAM_PATH).json() == []


def test_a_team_route_refuses_another_team_in_the_body(client: TestClient, workspace: str) -> None:
    """A team admin cannot widen a webhook past the team in the path."""
    sign_in(client, ADMIN)

    response = client.post(
        TEAM_PATH,
        json={"url": "https://example.test/hook", "label": "x", "resource_types": ["issues"], "team_id": OTHER_TEAM},
    )

    assert response.status_code == 422


def test_a_team_route_cannot_reach_a_workspace_wide_webhook(client: TestClient, workspace: str) -> None:
    """A webhook covering every team is absent from a team route, not forbidden."""
    sign_in(client, ADMIN)
    wide = create(client)
    other = create(client, path=OTHER_TEAM_PATH)

    assert client.patch(f"{TEAM_PATH}/{wide['webhook_id']}", json={"label": "y"}).status_code == 404
    assert client.delete(f"{TEAM_PATH}/{other['webhook_id']}").status_code == 404
    assert client.get(f"{TEAM_PATH}/{wide['webhook_id']}/deliveries").status_code == 404


def test_a_team_admin_manages_their_team_webhooks(
    client: TestClient, workspace: str, repositories: Any, sender: RecordingSender
) -> None:
    """A member who administers a team gets the team routes and nothing wider."""
    add_team_member(repositories, WORKSPACE, TEAM, MEMBER, "admin")
    sign_in(client, MEMBER)

    created = create(client, path=TEAM_PATH)
    assert client.post(f"{TEAM_PATH}/{created['webhook_id']}/ping", json={}).status_code == 200
    assert client.get(f"{TEAM_PATH}/{created['webhook_id']}/deliveries").status_code == 200

    assert client.get(PATH).status_code == 403
    assert client.get(OTHER_TEAM_PATH).status_code == 403


def test_a_team_member_without_admin_is_refused(client: TestClient, workspace: str) -> None:
    """Holding the secret lets a receiver believe anything, so a plain member gets no route."""
    sign_in(client, GUEST)

    assert client.get(TEAM_PATH).status_code == 403
    assert (
        client.post(TEAM_PATH, json={"url": "https://e.test/", "label": "x", "resource_types": ["issues"]}).status_code
        == 403
    )


def test_a_ping_is_logged_with_status_latency_and_bodies(
    client: TestClient, workspace: str, sender: RecordingSender
) -> None:
    """A test ping is one synchronous attempt, logged like any delivery."""
    sign_in(client, ADMIN)
    webhook_id = create(client)["webhook_id"]

    pinged = client.post(f"{PATH}/{webhook_id}/ping", json={})

    assert pinged.status_code == 200
    delivery = pinged.json()
    assert delivery["is_test"] is True
    assert delivery["state"] == "delivered"
    assert delivery["attempts"][0]["status_code"] == 200
    assert delivery["attempts"][0]["latency_ms"] >= 0
    assert delivery["attempts"][0]["response_body"] == "ok"
    assert json.loads(delivery["request_body"])["action"] == "ping"
    log = client.get(f"{PATH}/{webhook_id}/deliveries").json()
    assert [row["delivery_id"] for row in log] == [delivery["delivery_id"]]


def test_a_failed_ping_does_not_count_towards_auto_disable(
    client: TestClient, workspace: str, sender: RecordingSender, repositories: Any
) -> None:
    """An admin probing a broken receiver must not be what disables it."""
    sender.status_code = 500
    sign_in(client, ADMIN)
    webhook_id = create(client)["webhook_id"]

    for _ in range(6):
        assert client.post(f"{PATH}/{webhook_id}/ping", json={}).json()["state"] == "failed"

    stored = repositories.github.get_endpoint(WORKSPACE, webhook_id)
    assert stored is not None
    assert stored.active is True
    assert stored.consecutive_failures == 0
    assert stored.last_status == 500


def test_a_redelivery_is_a_new_entry_pointing_at_the_original(
    client: TestClient, workspace: str, sender: RecordingSender
) -> None:
    """Redeliver sends the same event again under a fresh id and timestamp."""
    sign_in(client, ADMIN)
    webhook_id = create(client)["webhook_id"]
    original = client.post(f"{PATH}/{webhook_id}/ping", json={}).json()

    again = client.post(f"{PATH}/{webhook_id}/deliveries/{original['delivery_id']}/redeliver", json={})

    assert again.status_code == 200
    body = again.json()
    assert body["redelivery_of"] == original["delivery_id"]
    assert body["delivery_id"] != original["delivery_id"]
    assert json.loads(body["request_body"])["webhookDeliveryId"] == body["delivery_id"]
    assert len(sender.sent) == 2
    assert len(client.get(f"{PATH}/{webhook_id}/deliveries").json()) == 2


def test_redelivering_an_unknown_delivery_is_404(client: TestClient, workspace: str) -> None:
    """A delivery id that names nothing is a 404, not an empty send."""
    sign_in(client, ADMIN)
    webhook_id = create(client)["webhook_id"]

    assert client.post(f"{PATH}/{webhook_id}/deliveries/nope/redeliver", json={}).status_code == 404


def test_deleting_a_webhook_drops_its_delivery_log(
    client: TestClient, workspace: str, sender: RecordingSender, repositories: Any
) -> None:
    """A deleted webhook leaves no delivery rows behind."""
    sign_in(client, ADMIN)
    webhook_id = create(client)["webhook_id"]
    client.post(f"{PATH}/{webhook_id}/ping", json={})

    client.delete(f"{PATH}/{webhook_id}")

    assert repositories.github.list_deliveries(WORKSPACE, webhook_id) == []


def test_the_derived_signing_key_is_pinned_to_a_known_value(monkeypatch: Any) -> None:
    """One fixed master, id and salt derive one fixed key, forever.

    Every live webhook's secret is derived rather than stored, so any change to the
    derivation silently invalidates every receiver's configured secret at once.
    """
    from app.common.core import config
    from app.domains.integrations.service import signing_key

    monkeypatch.setattr(
        type(config.settings),
        "WEBHOOK_SIGNING_KEY",
        property(lambda self: "standupless-regression-master-key"),
    )

    derived = signing_key("wh_regression", "salt_regression")

    assert derived.hex() == "12fd55f5c8a60ab935aabbe6833cfccd82a8e4bd96b2720d986d9c71de87de1b"


def test_creating_a_webhook_past_the_plan_limit_is_refused(
    client: TestClient, workspace: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Workspace and team webhooks share the plan's limit, so either path stops there."""
    from app.common.plan_limits import PLAN_LIMIT_REACHED, PLAN_LIMITS, LimitedResource

    monkeypatch.setitem(PLAN_LIMITS["free"], LimitedResource.WEBHOOKS, 1)
    sign_in(client, ADMIN)
    create(client)

    for path in (PATH, TEAM_PATH):
        response = client.post(
            path, json={"url": "https://example.test/two", "label": "x", "resource_types": ["issues"]}
        )
        assert response.status_code == 403
        assert response.json()["error_code"] == PLAN_LIMIT_REACHED
