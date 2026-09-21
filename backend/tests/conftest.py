"""Shared fixtures: a moto backed DynamoDB and the clients the route tests drive.

Every table the product declares is created in moto, alongside the two identity
module tables it stores credentials in, so a repository under test runs its real
query against a real index rather than a stub that cannot fail the way DynamoDB
does. The `api-keys` and `share-tokens` specs come from the package itself, which
is the same source the deployed identity module provisions from, so both are
exercised against the indexes they actually query.

Only those two, and not the rest of `webbpulse.identity.storage.TABLES`: the
product reaches no other identity table, and a suite that needs the authorization
server's own creates them in its own fixture rather than finding them already
there.

The moto lifecycle and the fake AWS credentials come from `webbpulse.testing`
rather than being hand rolled here. What stays local is the part the package has
no equivalent for: the product's own `TABLES` loop, because `create_table`
upstream shapes only a hash key, a range key and a TTL while most of these tables
carry secondary indexes and two carry streams, and the reset of this product's
own memoised resource in `app.common.db.dynamo.client`.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from typing import Any

import pytest

pytest_plugins = ["webbpulse.testing"]

os.environ["TESTING"] = "true"
os.environ["ENABLE_RATE_LIMITING"] = "false"
os.environ.setdefault("SECRET_KEY", "test-secret-key-not-a-real-one")
os.environ.setdefault("APP_ENVIRONMENT", "development")


@pytest.fixture
def dynamo_tables(dynamodb_resource: Any) -> Iterator[None]:
    """Every declared table, plus the two identity ones, live in moto for one test.

    `dynamodb_resource` opens the mock and resets the package's resource cache on
    both sides. This product memoises a resource of its own, so it is dropped here
    too, on the way in and out, or a repository built in one test would hold a
    resource pointing at another test's mock.
    """
    from webbpulse.identity.api_keys import API_KEY_TABLE
    from webbpulse.identity.share_tokens import SHARE_TOKEN_TABLE

    from app.common.core.config import settings
    from app.common.db.dynamo.client import get_client, reset_clients, table_name
    from app.common.db.dynamo.tables import TABLES

    reset_clients()
    client = get_client()
    for spec in TABLES:
        client.create_table(**spec.create_table_request(table_name(spec)))
    for identity_spec in (API_KEY_TABLE, SHARE_TOKEN_TABLE):
        client.create_table(**identity_spec.create_table_request(settings.dynamodb_table_prefix))
    yield
    reset_clients()


@pytest.fixture
def repositories(dynamo_tables: None) -> Any:
    """A bundle carrying every repository, against the mocked tables."""
    from app.common.api.dependencies.repositories import ALL_REPOSITORY_NAMES, build_bundle

    return build_bundle(ALL_REPOSITORY_NAMES, name="tests")
