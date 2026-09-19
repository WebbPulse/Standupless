"""Outbound webhook endpoint CRUD, and what happens to the secret.

The property worth pinning here is that the secret an admin is shown is the key
deliveries are actually signed with, and that it is shown once and never stored.
A refactor that split those two apart would leave every receiver unable to verify
anything, and no other test would notice.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from tests.domains.helpers import ADMIN, sign_in
from tests.domains.integrations.conftest import WORKSPACE

PATH = f"/api/workspaces/{WORKSPACE}/webhooks"


def create(client: TestClient, url: str = "https://example.test/hook", **extra: Any) -> dict[str, Any]:
    """Register one endpoint and hand back the create response body."""
    response = client.post(PATH, json={"url": url, **extra})
    assert response.status_code == 201, response.text
    return response.json()


def test_creating_an_endpoint_shows_the_secret_once(client: TestClient, workspace: str) -> None:
    """The create response carries the secret, because nothing can show it later."""
    sign_in(client, ADMIN)

    created = create(client)

    assert created["secret"].startswith("whsec_")
    assert created["secret_hint"] == created["secret"][-4:]


def test_the_secret_is_never_shown_again(client: TestClient, workspace: str) -> None:
    """A later read carries the hint and never the secret."""
    sign_in(client, ADMIN)
    create(client)

    listed = client.get(PATH).json()

    assert len(listed) == 1
    assert listed[0].get("secret") is None
    assert listed[0]["secret_hint"]


def test_the_secret_is_not_stored_in_the_table(client: TestClient, workspace: str, repositories: Any) -> None:
    """The row holds a salt, a digest and a hint, and no usable secret.

    Reading the table is what an attacker with a stolen read grant gets, so what is
    on the row is exactly what such a read must not be enough to sign with.
    """
    sign_in(client, ADMIN)
    created = create(client)

    stored = repositories.github.get_endpoint(WORKSPACE, created["webhook_id"])

    assert stored is not None
    assert created["secret"] not in stored.model_dump_json()


def test_the_shown_secret_is_the_key_deliveries_are_signed_with(
    client: TestClient,
    workspace: str,
    repositories: Any,
) -> None:
    """What the admin copies into their receiver is what the dispatcher signs with.

    If these two ever diverge every outbound signature becomes unverifiable, which
    is a failure nobody would see until a customer reported it.
    """
    from app.domains.integrations.service import signing_key

    sign_in(client, ADMIN)
    created = create(client)
    stored = repositories.github.get_endpoint(WORKSPACE, created["webhook_id"])

    assert stored is not None
    assert created["secret"] == "whsec_" + signing_key(stored.webhook_id, stored.secret_salt).hex()


def test_rotating_changes_the_signing_key(client: TestClient, workspace: str, repositories: Any) -> None:
    """A rotate really invalidates the old secret rather than only rewriting a digest."""
    from app.domains.integrations.service import signing_key

    sign_in(client, ADMIN)
    created = create(client)
    before = repositories.github.get_endpoint(WORKSPACE, created["webhook_id"])
    assert before is not None
    old_key = signing_key(before.webhook_id, before.secret_salt)

    rotated = client.post(f"{PATH}/{created['webhook_id']}/rotate")
    assert rotated.status_code == 200

    after = repositories.github.get_endpoint(WORKSPACE, created["webhook_id"])
    assert after is not None
    assert signing_key(after.webhook_id, after.secret_salt) != old_key
    assert rotated.json()["secret"] != created["secret"]


def test_an_endpoint_must_use_https(client: TestClient, workspace: str) -> None:
    """A plaintext endpoint would put a signed payload on the wire in the clear."""
    sign_in(client, ADMIN)

    response = client.post(PATH, json={"url": "http://example.test/hook"})

    assert response.status_code == 422


def test_an_unknown_event_name_is_refused(client: TestClient, workspace: str) -> None:
    """Subscribing to an event that will never fire is a mistake worth reporting."""
    sign_in(client, ADMIN)

    response = client.post(PATH, json={"url": "https://example.test/hook", "events": ["issue.exploded"]})

    assert response.status_code == 422


def test_an_endpoint_can_be_deactivated_and_deleted(client: TestClient, workspace: str) -> None:
    """Deactivating stops deliveries, and deleting forgets the endpoint."""
    sign_in(client, ADMIN)
    created = create(client)
    webhook_id = created["webhook_id"]

    patched = client.patch(f"{PATH}/{webhook_id}", json={"active": False})
    assert patched.status_code == 200
    assert patched.json()["active"] is False

    assert client.delete(f"{PATH}/{webhook_id}").status_code == 204
    assert client.get(PATH).json() == []


def test_deleting_an_unknown_endpoint_is_404(client: TestClient, workspace: str) -> None:
    """An id that names nothing answers the same way one in another workspace would."""
    sign_in(client, ADMIN)

    assert client.delete(f"{PATH}/01JB00000000000000000NONE").status_code == 404


def test_an_endpoint_of_another_workspace_is_not_reachable_by_id(
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
            events=["issue.created"],
            created_by=ADMIN,
            created_at=utc_now(),
            updated_at=utc_now(),
        )
    )
    sign_in(client, ADMIN)

    assert client.delete(f"{PATH}/{other_id}").status_code == 404
    assert client.get(PATH).json() == []
