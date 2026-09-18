"""Shared fixtures: a moto backed DynamoDB and the clients the route tests drive.

Every table the product declares is created in moto, so a repository under test
runs its real query against a real index rather than a stub that cannot fail the
way DynamoDB does.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from typing import Any

import pytest

os.environ["TESTING"] = "true"
os.environ["ENABLE_RATE_LIMITING"] = "false"
os.environ.setdefault("SECRET_KEY", "test-secret-key-not-a-real-one")
os.environ.setdefault("APP_ENVIRONMENT", "development")
os.environ.setdefault("AWS_REGION", "us-west-2")
os.environ.setdefault("AWS_ACCESS_KEY_ID", "testing")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "testing")
os.environ.setdefault("AWS_SESSION_TOKEN", "testing")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-west-2")


@pytest.fixture
def dynamo_tables() -> Iterator[None]:
    """Every declared table, live in moto for one test.

    The client caches are dropped on the way in and out so a repository built in
    one test never holds a resource pointing at another test's mock.
    """
    from moto import mock_aws

    from app.common.db.dynamo.client import get_client, reset_clients, table_name
    from app.common.db.dynamo.tables import TABLES

    reset_clients()
    with mock_aws():
        client = get_client()
        for spec in TABLES:
            client.create_table(**spec.create_table_request(table_name(spec)))
        yield
    reset_clients()


@pytest.fixture
def repositories(dynamo_tables: None) -> Any:
    """A bundle carrying every repository, against the mocked tables."""
    from app.common.api.dependencies.repositories import ALL_REPOSITORY_NAMES, build_bundle

    return build_bundle(ALL_REPOSITORY_NAMES, name="tests")
