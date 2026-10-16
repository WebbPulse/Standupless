"""SCIM provisioning on the local stack, driven with the request shapes Okta sends.

The unit tests prove the provisioning rules with the hooks in process. This
module proves the deployed shape: the gateway route with no authorizer, the
bearer token check in the handler, `application/scim+json` answers, and the
exact bodies Okta's SCIM 2.0 integration sends for user lookup, create, replace,
deactivate and group push.

It runs only on the local stack, where a domain verifies without a DNS record and
the Business plan comes from the comp grant script. Every deployed stage skips it.
"""

from __future__ import annotations

import secrets
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest

WRITES = pytest.mark.e2e_writes

BACKEND_DIRECTORY = Path(__file__).resolve().parents[1]

USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User"

GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group"

PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp"

LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse"


@pytest.fixture(scope="module")
def local_stack(e2e_env: Any) -> None:
    """Skip every case outside the writable local stack."""
    if e2e_env.environment != "local" or e2e_env.read_only:
        pytest.skip("SCIM provisioning runs on the local stack only")


def _grant_business(slug: str) -> None:
    """Hold the workspace on the Business plan through the comp grant script, with no Stripe behind it."""
    result = subprocess.run(
        [
            sys.executable,
            "scripts/grant_comp_plan.py",
            "--stage",
            "e2e-local",
            "--workspace",
            slug,
            "--plan",
            "business",
            "--reason",
            "SCIM e2e",
        ],
        cwd=BACKEND_DIRECTORY,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert result.returncode == 0, f"the comp grant failed: {result.stdout[-400:]} {result.stderr[-400:]}"


@pytest.fixture
def scim_workspace(
    api: Any, e2e_env: Any, local_stack: None, schedule_workspace_deletion: Any
) -> Iterator[dict[str, Any]]:
    """A Business workspace this run owns, scheduled for deletion afterwards."""
    del local_stack
    suffix = secrets.token_hex(4)
    slug = f"{e2e_env.resource_prefix}scim-{suffix}".replace("_", "-")[-40:].strip("-")
    created = api.post("/api/workspaces", json={"name": f"{e2e_env.resource_prefix}scim", "slug": slug})
    assert created.status_code in (200, 201), f"creating the workspace answered {created.status_code}"
    workspace = dict(created.json())
    _grant_business(workspace["slug"])
    yield workspace
    schedule_workspace_deletion(workspace["id"])


def _okta_user(email: str, external_id: str, *, active: bool = True) -> dict[str, Any]:
    """The body Okta posts to create a user, attributes and all."""
    return {
        "schemas": [USER_SCHEMA],
        "userName": email,
        "name": {"givenName": "Pat", "familyName": "Okta"},
        "emails": [{"primary": True, "value": email, "type": "work"}],
        "displayName": "Pat Okta",
        "locale": "en-US",
        "externalId": external_id,
        "groups": [],
        "password": secrets.token_urlsafe(12),
        "active": active,
    }


@WRITES
def test_okta_provisions_users_and_pushes_groups(api: Any, e2e_env: Any, scim_workspace: dict[str, Any]) -> None:
    """Okta's lookup, create, replace, group push and deactivate requests all land as Okta expects."""
    api_base = e2e_env.api_base_url.rstrip("/")
    workspace_id = scim_workspace["id"]
    base = f"/api/workspaces/{workspace_id}"
    domain = f"{secrets.token_hex(5)}.scim-e2e.test"

    assert api.post(f"{base}/sso/domains", json={"domain": domain}).status_code == 201
    verified = api.post(f"{base}/sso/domains/{domain}/verify")
    assert verified.status_code == 200 and verified.json()["verified"] is True, verified.text[:300]

    team = api.post(f"{base}/teams", json={"name": "Directory", "key_prefix": "DIR"})
    assert team.status_code in (200, 201), team.text[:300]
    team_body = team.json()
    team_id = str(team_body.get("team_id") or team_body.get("id"))

    minted = api.post(f"{base}/sso/scim/tokens", json={"name": "Okta"})
    assert minted.status_code == 201, minted.text[:300]
    token = str(minted.json()["secret"])
    key_id = str(minted.json()["key_id"])
    settings = api.get(f"{base}/sso/scim")
    assert settings.status_code == 200
    scim_base = str(settings.json()["base_url"])
    assert scim_base == f"{api_base}/api/scim/v2"

    okta = httpx.Client(
        base_url=scim_base,
        headers={"Authorization": f"Bearer {token}", "Accept": "application/scim+json"},
        timeout=30,
    )
    try:
        with okta:
            config = httpx.get(f"{scim_base}/ServiceProviderConfig", timeout=30)
            assert config.status_code == 200
            assert config.json()["patch"]["supported"] is True
            assert httpx.get(f"{scim_base}/Users", timeout=30).status_code == 401

            refused = httpx.get(f"{api_base}{base}/api-keys", headers={"Authorization": f"Bearer {token}"}, timeout=30)
            assert refused.status_code in (401, 403)

            email = f"pat@{domain}"
            lookup = okta.get("/Users", params={"filter": f'userName eq "{email}"', "startIndex": 1, "count": 100})
            assert lookup.status_code == 200, lookup.text[:300]
            assert lookup.headers["content-type"].startswith("application/scim+json")
            assert lookup.json()["schemas"] == [LIST_SCHEMA]
            assert lookup.json()["totalResults"] == 0

            outside = okta.post("/Users", json=_okta_user(f"pat@unverified-{domain}", "00u-outside"))
            assert outside.status_code == 400

            created = okta.post("/Users", json=_okta_user(email, "00u-pat"))
            assert created.status_code == 201, created.text[:300]
            user = created.json()
            scim_id = str(user["id"])
            assert user["userName"] == email
            assert user["active"] is True
            assert "password" not in user
            duplicate = okta.post("/Users", json=_okta_user(email, "00u-pat"))
            assert duplicate.status_code == 409

            found = okta.get("/Users", params={"filter": f'userName eq "{email}"'})
            assert [item["id"] for item in found.json()["Resources"]] == [scim_id]

            replaced = okta.put(f"/Users/{scim_id}", json={**_okta_user(email, "00u-pat"), "id": scim_id})
            assert replaced.status_code == 200, replaced.text[:300]
            assert replaced.json()["name"]["givenName"] == "Pat"

            missing = okta.post("/Groups", json={"schemas": [GROUP_SCHEMA], "displayName": "Nobody", "members": []})
            assert missing.status_code == 400
            group = okta.post("/Groups", json={"schemas": [GROUP_SCHEMA], "displayName": "Directory", "members": []})
            assert group.status_code == 201, group.text[:300]
            group_id = str(group.json()["id"])
            assert group_id == team_id

            pushed = okta.patch(
                f"/Groups/{group_id}",
                json={
                    "schemas": [PATCH_SCHEMA],
                    "Operations": [{"op": "add", "path": "members", "value": [{"value": scim_id, "display": email}]}],
                },
            )
            assert pushed.status_code in (200, 204), pushed.text[:300]
            renamed = okta.patch(
                f"/Groups/{group_id}",
                json={
                    "schemas": [PATCH_SCHEMA],
                    "Operations": [{"op": "replace", "value": {"id": group_id, "displayName": "Directory Team"}}],
                },
            )
            assert renamed.status_code in (200, 204), renamed.text[:300]
            members = okta.get(f"/Groups/{group_id}")
            assert members.status_code == 200
            assert [item["value"] for item in members.json()["members"]] == [scim_id]
            listed_team = api.get(f"{base}/teams/{team_id}")
            assert listed_team.status_code == 200
            assert listed_team.json()["name"] == "Directory"

            removed = okta.patch(
                f"/Groups/{group_id}",
                json={
                    "schemas": [PATCH_SCHEMA],
                    "Operations": [{"op": "remove", "path": f'members[value eq "{scim_id}"]'}],
                },
            )
            assert removed.status_code in (200, 204), removed.text[:300]

            deactivated = okta.patch(
                f"/Users/{scim_id}",
                json={"schemas": [PATCH_SCHEMA], "Operations": [{"op": "replace", "value": {"active": False}}]},
            )
            assert deactivated.status_code in (200, 204), deactivated.text[:300]
            assert okta.get(f"/Users/{scim_id}").json()["active"] is False
            reactivated = okta.patch(
                f"/Users/{scim_id}",
                json={"schemas": [PATCH_SCHEMA], "Operations": [{"op": "replace", "value": {"active": True}}]},
            )
            assert reactivated.status_code in (200, 204), reactivated.text[:300]
            assert okta.get(f"/Users/{scim_id}").json()["active"] is True

            assert okta.delete(f"/Groups/{group_id}").status_code == 204
            assert api.get(f"{base}/teams/{team_id}").status_code == 200
            assert okta.delete(f"/Users/{scim_id}").status_code == 204
            assert okta.get(f"/Users/{scim_id}").status_code == 404

            audit = api.get(f"{base}/audit-log", params={"actor_id": "scim", "limit": 100})
            assert audit.status_code == 200, audit.text[:300]
            for event in ("scim.user_provisioned", "scim.user_deactivated", "scim.group_linked", "scim.user_deleted"):
                assert event in audit.text, f"the audit log is missing {event}"
    finally:
        assert api.delete(f"{base}/sso/scim/tokens/{key_id}").status_code == 204
        revoked = httpx.get(f"{scim_base}/Users", headers={"Authorization": f"Bearer {token}"}, timeout=30)
        assert revoked.status_code == 401
        api.delete(f"{base}/sso/domains/{domain}")
